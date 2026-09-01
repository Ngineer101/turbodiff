import { persistAgentLog } from '../runtime/agent-runs.ts';
import { gitAuthorEnv } from '../../domain/attribution.ts';
import {
  addCliUsage,
  claudeCliResultText,
  claudeCliSessionId,
  parseClaudeCliUsage,
  type CliUsage,
} from '../runtime/cli-usage.ts';
import {
  addAssistantChatMessage,
  finishFixAttempt,
  getChatMessage,
  getChangeRequestByRepoNumber,
  getFeature,
  getInstallation,
  getRepoById,
  listEnabledSkillsForRepo,
  recentChatHistory,
  setChatMessageStatus,
  setChatSessionId,
  tryRecordFixAttempt,
  type ChatMessageRow,
  type FeatureRow,
} from '../../data/db.ts';
import {
  describePushFailure,
  installationToken,
  sandboxGitToken,
} from '../../integrations/github/app.ts';
import { UNTRUSTED_CONTENT_RULES } from '../../domain/prompt-security.ts';
import { installDependencies, NPM_CACHE_ENV } from '../runtime/sandbox-deps.ts';
import { checkCommandUnrunnable, runCheckCommand } from '../runtime/check-command.ts';
import {
  CHAT_BUSY_DELAY_SECONDS,
  CHAT_BUSY_RETRIES,
  type ChatQueueMessage,
} from '../../shared/factory-messages.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { resolveRunnerAuth, runnerEnvironment } from '../runtime/runner-auth.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';
import { redactSecrets } from '../runtime/redaction.ts';
import {
  prepareFreshClone,
  pushHeadCommand,
  refreshPrCheckout,
} from '../runtime/repository-workspace.ts';
import { githubWorkspaceRemote, resolveWorkspaceRemote } from '../../integrations/git/provider.ts';
import type { WorkspaceRemote } from '../../integrations/git/remotes.ts';
import { refreshChangeRequest } from '../../services/change-requests.ts';
import { mountSkills } from '../runtime/skills.ts';
import { fetchPushablePrHead, prTouchesWorkflowFiles } from '../runtime/pull-requests.ts';

// Cockpit chat turns (docs/software-factory-design.md): a conversational
// channel with a coding agent that has the PR head branch checked out, for
// small iterative changes. Heavily reuses the fixer's plumbing — the SAME
// per-PR sandbox id and clone dir (runs are serialized by the fix_attempts
// single-flight guard; sharing keeps the container warm and Claude CLI
// sessions resumable, since they are keyed by cwd), the same scoped git
// tokens, secret redaction, check-command repair loop, and push mechanics.
// Unlike fixes, chat turns are human-supervised: they record a fix_attempts
// row (trigger 'chat') for single-flight/metering but never consume the
// FIX_MAX_ATTEMPTS automated-fix budget, and they post no PR/CR summary
// comment — the chat panel is the record.

const CLONE_DIR = '/workspace/repo';
const TASK_FILE = '/workspace/chat-turn.md';
const repairFile = (round: number) => `/workspace/chat-repair-${round}.md`;
const AGENT_TIMEOUT_MS = 15 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
const REPAIR_ROUNDS = 2;
const REPAIR_TIMEOUT_MS = 10 * 60_000;
// The stored assistant reply — generous (it IS the deliverable) but bounded
// so one runaway response can't bloat the row.
const REPLY_MAX_CHARS = 16_000;
// Per-message cap when rendering history into a fresh-session prompt.
const HISTORY_BODY_MAX_CHARS = 2_000;

export type ChatOutcome = 'changed' | 'no_changes' | 'tests_failed';

export interface ChatTurnResult {
  reply: string;
  outcome: ChatOutcome;
  // The matching fix_attempts status vocabulary ('fixed' for 'changed').
  fixStatus: 'fixed' | 'no_changes' | 'tests_failed';
  commit?: string;
  usage: CliUsage | null;
}

interface ChatTurnParams {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  repositoryId: number;
  feature: FeatureRow;
  userMessage: ChatMessageRow;
  attemptId: number;
  testCommand?: string;
  runnerModel?: string;
}

// Shared rules for both prompt shapes. Chat text is a trusted instruction
// channel (a signed-in user with push permission wrote it); repo content is
// not — hence the untrusted-content rules still apply to what the agent
// reads in the checkout.
function chatRules(testCommand?: string): string {
  return `You are a coding agent chatting with a user about their open pull request.
The PR's head branch is checked out in the current directory. Rules:
- Make the changes the user asks for in this checkout — small, iterative,
  scoped to their message. No drive-by refactors.
- Match the repository's existing code style and conventions.
- Do NOT run git commit or git push; the harness handles git.
- Keep your reply concise — your final message is shown to the user in a
  chat panel. If you changed nothing, say why.${
    testCommand
      ? `
- Dependencies are already installed. Before finishing, run \`${testCommand}\`
  and fix any failures your changes caused.`
      : ''
  }

${UNTRUSTED_CONTENT_RULES}`;
}

// Resumed sessions carry the conversation in the CLI's own context — the
// prompt is just the rules and the new message.
function resumeTurnPrompt(userMessage: ChatMessageRow, testCommand?: string): string {
  return `${chatRules(testCommand)}

## User message (from @${userMessage.author ?? 'unknown'})
${userMessage.body}
`;
}

// Fresh sessions (first turn, or a slept sandbox that lost its session
// files) get the recent chat history rendered into the prompt instead.
function freshTurnPrompt(
  pr: string,
  branch: string,
  history: ChatMessageRow[],
  userMessage: ChatMessageRow,
  testCommand?: string,
): string {
  const prior = history
    .filter((m) => m.id !== userMessage.id && (m.role === 'assistant' || m.status === 'done'))
    .map(
      (m) =>
        `**${m.role === 'user' ? `@${m.author ?? 'unknown'}` : 'assistant'}:** ${m.body.slice(0, HISTORY_BODY_MAX_CHARS)}`,
    );
  return `You are joining an ongoing chat about pull request ${pr} (branch \`${branch}\`).
The workspace is a fresh checkout of the branch's current head.
${prior.length ? `\n## Conversation so far\n${prior.join('\n\n')}\n` : ''}
${chatRules(testCommand)}

## User message (from @${userMessage.author ?? 'unknown'})
${userMessage.body}
`;
}

export async function runChatTurn(params: ChatTurnParams): Promise<ChatTurnResult> {
  const { owner, repo, prNumber } = params;
  // Provider dispatch mirrors runFix: Artifacts turns target the change
  // request's source branch on the repo's own remote; GitHub turns target
  // the PR head with an installation-scoped token.
  const repoRow = await getRepoById(params.repositoryId);
  const cr =
    repoRow?.provider === 'artifacts'
      ? await getChangeRequestByRepoNumber(params.repositoryId, prNumber)
      : null;
  if (repoRow?.provider === 'artifacts' && (!cr || cr.status !== 'open')) {
    throw new Error(`change request #${prNumber} is not open`);
  }
  const token = cr ? '' : await installationToken(params.installationId);
  const auth = resolveRunnerAuth(undefined, params.runnerModel);

  let remote: WorkspaceRemote;
  let headRef: string;
  if (cr && repoRow) {
    remote = await resolveWorkspaceRemote(repoRow, 'write');
    headRef = cr.source_branch;
  } else {
    // Same credential rules as the fixer: the sandbox only ever sees a git
    // credential scoped to this one repository (contents write, plus
    // workflows only when the PR already touches .github/workflows/).
    const gitToken = await sandboxGitToken(params.installationId, repo, 'write', {
      workflows: await prTouchesWorkflowFiles(token, owner, repo, prNumber),
    });
    const head = await fetchPushablePrHead(token, owner, repo, prNumber);
    headRef = head.headRef;
    remote = githubWorkspaceRemote(head.headRepo, gitToken);
  }
  const scrub = (s: string) => redactSecrets(s, [token, remote.token]);

  // Same sandbox as the fixer — serialized by the single-flight guard, and
  // sharing the container keeps CLI sessions resumable across turns.
  const sandbox = runnerSandbox(`fix--${owner}--${repo}--${prNumber}`.toLowerCase(), {
    sleepAfter: '20m',
  });

  const gitEnv = { ...remote.env };
  await sandbox.exec(`rm -rf ${TASK_FILE} /workspace/chat-repair-*.md`);
  // Warm fast path: refresh the existing checkout to the remote head
  // instead of paying a full re-clone on every consecutive turn.
  const warm = await refreshPrCheckout(sandbox, CLONE_DIR, remote, headRef, [token]);
  if (!warm) {
    await prepareFreshClone({
      sandbox,
      cloneDir: CLONE_DIR,
      remote,
      branch: headRef,
      secrets: [token],
    });
  }

  if (params.testCommand) {
    const installFailure = await installDependencies(sandbox, CLONE_DIR);
    if (installFailure) {
      console.warn(
        `turbodiff: dependency preinstall failed for ${owner}/${repo}#${prNumber}: ${scrub(installFailure)}`,
      );
    }
  }

  try {
    await mountSkills(sandbox, CLONE_DIR, await listEnabledSkillsForRepo(params.repositoryId));

    const history = await recentChatHistory(params.feature.id);
    const freshPrompt = freshTurnPrompt(
      `${owner}/${repo}#${prNumber}`,
      headRef,
      history,
      params.userMessage,
      params.testCommand,
    );

    const baseEnv = runnerEnvironment(auth, NPM_CACHE_ENV);
    const runAgent = async (resumeId: string | null, promptFile: string) =>
      sandbox.exec(
        `claude -p ${resumeId ? '--resume "$RESUME_SESSION" ' : ''}` +
          `--dangerously-skip-permissions --output-format stream-json --verbose < ${promptFile}`,
        {
          cwd: CLONE_DIR,
          timeout: AGENT_TIMEOUT_MS,
          env: resumeId ? { ...baseEnv, RESUME_SESSION: resumeId } : baseEnv,
        },
      );

    let sessionId = params.feature.chat_session_id;
    await sandbox.writeFile(
      TASK_FILE,
      sessionId ? resumeTurnPrompt(params.userMessage, params.testCommand) : freshPrompt,
    );
    let agent = await runAgent(sessionId, TASK_FILE);
    let totalUsage = parseClaudeCliUsage(agent.stdout);
    if (sessionId && !agent.success) {
      // A slept sandbox lost ~/.claude and the resumable session with it —
      // retry once as a fresh session primed with the chat history.
      await persistAgentLog(
        'chat',
        scrub(`${claudeCliResultText(agent.stdout)}\n${agent.stderr}`.trim()),
        false,
        { fixAttemptId: params.attemptId },
        scrub(agent.stdout),
      );
      sessionId = null;
      await setChatSessionId(params.feature.id, null);
      await sandbox.writeFile(TASK_FILE, freshPrompt);
      agent = await runAgent(null, TASK_FILE);
      totalUsage = addCliUsage(totalUsage, parseClaudeCliUsage(agent.stdout));
    }
    const fullOutput = scrub(`${claudeCliResultText(agent.stdout)}\n${agent.stderr}`.trim());
    await persistAgentLog(
      'chat',
      fullOutput,
      agent.success,
      { fixAttemptId: params.attemptId },
      scrub(agent.stdout),
    );
    if (!agent.success) {
      throw new Error(`chat agent exited ${agent.exitCode}: ${fullOutput.slice(-1_000)}`);
    }

    // Persist the resumable session whenever the CLI printed one, so the
    // NEXT turn continues this conversation.
    sessionId = claudeCliSessionId(agent.stdout) ?? sessionId;
    if (sessionId) await setChatSessionId(params.feature.id, sessionId);

    let reply = scrub(claudeCliResultText(agent.stdout)).trim().slice(0, REPLY_MAX_CHARS);
    if (!reply) reply = '(the agent finished without a reply)';

    const status = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
    if (!status.stdout.trim()) {
      return { reply, outcome: 'no_changes', fixStatus: 'no_changes', usage: totalUsage };
    }

    // Commit BEFORE running checks so check-command working-tree mutations
    // never leak into the pushed commit. The chatting user is the git
    // author; the commit message travels via env to stay shell-safe.
    const author =
      params.userMessage.author && params.userMessage.author_id !== null
        ? { login: params.userMessage.author, id: params.userMessage.author_id }
        : undefined;
    const subject = params.userMessage.body.replace(/\s+/g, ' ').trim().slice(0, 60);
    const committed = await sandbox.exec(
      `git -C ${CLONE_DIR} add -A && git -C ${CLONE_DIR} commit -m "$COMMIT_MSG"`,
      {
        env: { ...gitAuthorEnv(author), COMMIT_MSG: `Chat: ${subject} (turbodiff chat agent)` },
        timeout: 60_000,
      },
    );
    if (!committed.success) {
      throw new Error(`git commit failed: ${scrub(committed.stderr).slice(0, 500)}`);
    }

    if (params.testCommand) {
      const runTests = () =>
        runCheckCommand(sandbox, CLONE_DIR, params.testCommand!, scrub, TEST_TIMEOUT_MS);
      let tests = await runTests();
      // A check command that can't even be executed is a misconfiguration,
      // not a failing test — fail loudly rather than silently discarding the
      // committed work as `tests_failed`.
      if (tests.notExecutable) throw checkCommandUnrunnable(params.testCommand, tests.output);
      for (let round = 1; !tests.ok && round <= REPAIR_ROUNDS; round++) {
        // Drop test-command working-tree mutations before the agent looks.
        await sandbox.exec(`git -C ${CLONE_DIR} checkout -- . && git -C ${CLONE_DIR} clean -fd`);
        await sandbox.writeFile(
          repairFile(round),
          `The repository test command (\`${params.testCommand}\`) failed after your changes:

\`\`\`
${tests.output.slice(-6_000)}
\`\`\`

Fix the failures your changes caused, then re-run the tests to confirm.
Rules unchanged: no git commit or push, no scope creep.

${UNTRUSTED_CONTENT_RULES}
`,
        );
        const repair = await sandbox.exec(
          `claude -p ${sessionId ? '--resume "$RESUME_SESSION" ' : ''}` +
            `--dangerously-skip-permissions --output-format stream-json --verbose < ${repairFile(round)}`,
          {
            cwd: CLONE_DIR,
            timeout: REPAIR_TIMEOUT_MS,
            env: sessionId ? { ...baseEnv, RESUME_SESSION: sessionId } : baseEnv,
          },
        );
        totalUsage = addCliUsage(totalUsage, parseClaudeCliUsage(repair.stdout));
        await persistAgentLog(
          'chat',
          scrub(`${claudeCliResultText(repair.stdout)}\n${repair.stderr}`.trim()),
          repair.success,
          { fixAttemptId: params.attemptId },
          scrub(repair.stdout),
        );
        // A failed repair run ends the loop, not the turn — the last test
        // verdict is the recorded outcome either way.
        if (!repair.success) break;
        // Carry the session forward so the next turn resumes post-repair.
        const repairSession = claudeCliSessionId(repair.stdout);
        if (repairSession) {
          sessionId = repairSession;
          await setChatSessionId(params.feature.id, repairSession);
        }
        const repaired = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
        if (!repaired.stdout.trim()) break;
        // Fold into the existing commit — one commit per turn keeps the PR
        // readable; --amend preserves the chatting user as author.
        const amended = await sandbox.exec(
          `git -C ${CLONE_DIR} add -A && git -C ${CLONE_DIR} commit --amend --no-edit`,
          { timeout: 60_000 },
        );
        if (!amended.success) {
          throw new Error(`repair commit failed: ${scrub(amended.stderr).slice(0, 500)}`);
        }
        tests = await runTests();
      }
      if (!tests.ok) {
        // No push — the branch stays green. The reply says so explicitly,
        // and warns that the uncommitted work is ephemeral.
        return {
          reply:
            `${reply}\n\n---\nThe repo check command failed after my changes, so nothing was pushed:\n\n` +
            `\`\`\`\n${tests.output.slice(-3_000)}\n\`\`\`\n` +
            'The uncommitted work may be lost when the sandbox sleeps — rephrase or ask me to try again.',
          outcome: 'tests_failed',
          fixStatus: 'tests_failed',
          usage: totalUsage,
        };
      }
    }

    const push = await sandbox.exec(pushHeadCommand(remote, CLONE_DIR), {
      env: { ...gitEnv, PUSH_BRANCH: headRef },
      timeout: 2 * 60_000,
    });
    if (!push.success) {
      throw new Error(describePushFailure(scrub(push.stderr).slice(0, 500)));
    }
    const commit = (await sandbox.exec(`git -C ${CLONE_DIR} rev-parse HEAD`)).stdout.trim();

    // A pushed native CR has a stale diff and verdict: recompute and
    // re-review immediately rather than waiting on a push event.
    if (cr && repoRow) {
      await refreshChangeRequest(repoRow, cr).catch((err) =>
        console.error(`turbodiff: post-chat refresh of CR ${cr.id} failed:`, err),
      );
      await enqueueFactoryMessage({ kind: 'cr_review', changeRequestId: cr.id });
    }
    return { reply, outcome: 'changed', fixStatus: 'fixed', commit, usage: totalUsage };
  } finally {
    // Belt and braces: an idle sandbox (sleepAfter keeps it warm) must
    // never hold a usable credential, so re-assert on every exit path.
    await sandbox.exec(`git -C ${CLONE_DIR} remote set-url origin "${remote.cleanUrl}"`);
  }
}

export interface ChatProcessorDependencies {
  runChatTurn?: typeof runChatTurn;
}

// Queue consumer body: re-validate against current state, hold the
// single-flight lock via a fix_attempts row (trigger 'chat', cap-exempt),
// run the turn, and record the reply. Never throws — a failed turn lands on
// the chat message as a failed status, not in repeated token spend.
export async function processChatMessage(
  msg: ChatQueueMessage,
  dependencies: ChatProcessorDependencies = {},
): Promise<void> {
  const executeTurn = dependencies.runChatTurn ?? runChatTurn;
  const chatMessage = await getChatMessage(msg.chatMessageId);
  if (!chatMessage) return;
  if (chatMessage.status === 'running') {
    // A workflow retry after a crash mid-run: the stale fix-attempt sweep
    // unblocks the PR, but re-running would double-pay the turn — fail
    // closed instead.
    await setChatMessageStatus(chatMessage.id, 'failed', 'the run was interrupted — try again');
    return;
  }
  if (chatMessage.status !== 'queued') return;

  const fail = (reason: string) => setChatMessageStatus(chatMessage.id, 'failed', reason);

  const feature = await getFeature(msg.featureId);
  if (!feature || feature.id !== chatMessage.feature_id) {
    await fail('feature not found');
    return;
  }
  const repo = await getRepoById(feature.repository_id);
  // No repo.auto_fix requirement — chat is human-driven and human-gated at
  // the HTTP layer (push permission), unlike the automated fix loop.
  if (!repo || !repo.enabled) {
    await fail('the repository is not enabled for turbodiff');
    return;
  }
  const label = `${repo.owner}/${repo.name}#${feature.pr_number}`;
  if (repo.provider !== 'artifacts') {
    const installation = await getInstallation(repo.installation_id);
    if (!installation || installation.suspended) {
      await fail('the GitHub App installation is missing or suspended');
      return;
    }
  }
  if (feature.status !== 'pr_opened' || !feature.pr_number) {
    await fail('the pull request is no longer open');
    return;
  }

  // Cap can never bind (MAX_SAFE_INTEGER); only the global running-attempt
  // guard can return null — another fix/chat run holds the sandbox.
  const attemptId = await tryRecordFixAttempt(
    repo.id,
    feature.pr_number,
    'chat',
    Number.MAX_SAFE_INTEGER,
    'chat',
  );
  if (attemptId === null) {
    if ((msg.attempt ?? 0) < CHAT_BUSY_RETRIES) {
      // Message stays 'queued'; the UI keeps showing the working indicator.
      await enqueueFactoryMessage(
        { ...msg, attempt: (msg.attempt ?? 0) + 1 },
        { delaySeconds: CHAT_BUSY_DELAY_SECONDS },
      );
      console.log(`turbodiff: chat turn for ${label} waiting on an in-flight run`);
      return;
    }
    await fail('another agent run is active on this PR — try again in a few minutes');
    return;
  }

  await setChatMessageStatus(chatMessage.id, 'running');
  try {
    const turn = await executeTurn({
      owner: repo.owner,
      repo: repo.name,
      prNumber: feature.pr_number,
      installationId: repo.installation_id,
      repositoryId: repo.id,
      feature,
      userMessage: chatMessage,
      attemptId,
      testCommand: repo.check_command ?? undefined,
      runnerModel: feature.runner_model ?? undefined,
    });
    await finishFixAttempt(
      attemptId,
      turn.fixStatus,
      turn.commit,
      undefined,
      turn.usage ?? undefined,
    );
    await addAssistantChatMessage(feature.id, turn.reply, turn.outcome, turn.commit);
    await setChatMessageStatus(chatMessage.id, 'done');
    console.log(`turbodiff: chat turn ${turn.outcome} for ${label} (attempt ${attemptId})`);
    // A chat push invalidates prior verification evidence, same as a fix.
    if (turn.outcome === 'changed' && feature.acceptance) {
      await enqueueFactoryMessage({ kind: 'verify', featureId: feature.id });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishFixAttempt(attemptId, 'failed', undefined, message.slice(0, 500));
    await fail(message.slice(0, 300));
    console.error(`turbodiff: chat turn failed for ${label}:`, err);
  }
}
