import { githubRequest as gh } from '../../integrations/github/client.ts';
import { persistAgentLog } from '../runtime/agent-runs.ts';
import { gitAuthorEnv } from '../../domain/attribution.ts';
import { ciFailureFindings } from './ci-findings.ts';
import {
  addCliUsage,
  claudeCliResultText,
  claudeCliSessionId,
  parseClaudeCliUsage,
  type CliUsage,
} from '../runtime/cli-usage.ts';
import {
  finishFixAttempt,
  getFeatureByRepoPr,
  getInstallation,
  getRepoById,
  hasRunningFixAttempt,
  linkCommentsToFixAttempt,
  listEnabledSkillsForRepo,
  tryRecordFixAttempt,
} from '../../data/db.ts';
import {
  describePushFailure,
  installationToken,
  sandboxGitToken,
} from '../../integrations/github/app.ts';
import { UNTRUSTED_CONTENT_RULES } from '../../domain/prompt-security.ts';
import { installDependencies, NPM_CACHE_ENV } from '../runtime/sandbox-deps.ts';
import { FIX_MAX_ATTEMPTS, type FixQueueMessage } from '../../shared/factory-messages.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import {
  resolveRunnerAuth,
  runnerEnvironment,
  type RunnerAuthMode,
} from '../runtime/runner-auth.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';
import { redactSecrets } from '../runtime/redaction.ts';
import { mountSkills } from '../runtime/skills.ts';
import {
  fetchPushablePrHead,
  postFixHandoffComment,
  prTouchesWorkflowFiles,
} from '../runtime/pull-requests.ts';

// Phase 1 spike of the software factory fix loop (docs/software-factory-design.md):
// clone a PR's head branch into a Cloudflare Sandbox, run a coding agent CLI
// against the review findings, run the repo's tests, and push the fix commit.
//
// Runner auth is pluggable so users can spend their existing Claude
// subscription (claude setup-token → CLAUDE_CODE_OAUTH_TOKEN) instead of API
// credits through the AI Gateway.

export type FixAuthMode = RunnerAuthMode;

export interface FixParams {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  repositoryId: number;
  // Markdown work order. When omitted, the latest blocking (CHANGES_REQUESTED)
  // bot review on the PR — i.e. turbodiff's own — is used instead.
  findings?: string;
  authMode?: FixAuthMode;
  // e.g. "npm test". When set, a failing run blocks the push.
  testCommand?: string;
  // The instructing user (e.g. a cockpit commenter) — becomes the git author
  // of the fix commit; the bot stays committer. Absent on auto-triggered runs.
  author?: { login: string; id: number };
  // The fix_attempts row this run belongs to, for the full agent log. Absent
  // on the operator-only POST /internal/fix path, which has no such row.
  attemptId?: number;
  // What triggered this run (e.g. 'blocking_review', 'ci_failure',
  // 'verification_failed') — used only to pick trigger-appropriate commit/
  // comment copy (see fixLabel below).
  trigger?: string;
  // Set only for the `ci_failure` trigger; runFix uses it to fetch the failed
  // jobs' logs lazily instead of a supplied `findings` string — mirrors how
  // `latestBlockingFindings` is used when `findings` is absent for the review
  // trigger.
  workflowRunId?: number;
  // The task's requested model (features.runner_model); absent = default.
  runnerModel?: string;
}

// Human-readable label for the thing a fix run is addressing, used in the
// commit message and PR comment so a CI-triggered fix doesn't read like a
// review-triggered one.
export function fixLabel(trigger?: string): string {
  switch (trigger) {
    case 'ci_failure':
      return 'failing CI checks';
    case 'verification_failed':
      return 'unmet acceptance criteria';
    default:
      return 'review findings';
  }
}

export interface FixOutcome {
  status: 'fixed' | 'no_changes' | 'tests_failed';
  authMode: FixAuthMode;
  branch: string;
  commit?: string;
  // Findings the agent declined to fix, with its reasons (from fix-notes.md).
  notes?: string;
  testOutput?: string;
  agentOutput: string;
  usage: CliUsage | null;
}

const CLONE_DIR = '/workspace/repo';
const TASK_FILE = '/workspace/fix-task.md';
const NOTES_FILE = '/workspace/fix-notes.md';
const repairFile = (round: number) => `/workspace/fix-repair-${round}.md`;
// Fix runs execute inside a Workflow step (no wall clock — see
// fix-workflow.ts), so the budgets reflect the work, not a deadline.
const AGENT_TIMEOUT_MS = 15 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
// Failing tests go back to the agent (session resumed, context intact)
// instead of ending the run — bounded so a hopeless failure can't spend
// forever. Mirrors the generator's repair loop.
const REPAIR_ROUNDS = 2;
const REPAIR_TIMEOUT_MS = 10 * 60_000;

// Fix runs per PR across all triggers. A fix push causes a re-review, which
// can cause another blocking review and another fix — the cap guarantees the
// loop terminates and hands off to a human.
// Latest CHANGES_REQUESTED bot review (turbodiff's blocking review) folded into
// a markdown work order: review body + inline comments with their locations.
async function latestBlockingFindings(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string | null> {
  // SAFETY: GitHub's GET /pulls/:number/reviews REST schema returns review
  // objects with id/state/body always present and a nullable user.
  const reviews = (await (
    await gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`)
  ).json()) as {
    id: number;
    state: string;
    body: string;
    user: { login: string; type: string } | null;
  }[];
  // A blocking verdict on a self-authored (factory) PR is downgraded to a
  // COMMENT review with the intended verdict in the body — match both forms.
  const blocking = reviews
    .filter(
      (r) =>
        r.user?.type === 'Bot' &&
        (r.state === 'CHANGES_REQUESTED' ||
          (r.state === 'COMMENTED' && r.body.startsWith('**Verdict: REQUEST_CHANGES**'))),
    )
    .at(-1);
  if (!blocking) return null;

  // SAFETY: GitHub's GET /pulls/:number/reviews/:id/comments REST schema
  // returns review comment objects with path/body always present and nullable
  // line/original_line.
  const comments = (await (
    await gh(
      token,
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${blocking.id}/comments?per_page=100`,
    )
  ).json()) as { path: string; line: number | null; original_line: number | null; body: string }[];

  const inline = comments.map((c) => {
    const line = c.line ?? c.original_line;
    return `### ${c.path}${line ? `:${line}` : ''}\n${c.body}`;
  });
  return [blocking.body, ...inline].filter(Boolean).join('\n\n');
}

function taskPrompt(pr: string, branch: string, findings: string, testCommand?: string): string {
  return `You are an automated fix agent operating on a checked-out pull request branch.

Address every finding listed below. Rules:
- Fix only what the findings describe — no drive-by refactors or cleanups.
- Match the repository's existing code style and conventions.
- Do NOT run git commit or git push; the harness handles git.
- If a finding is wrong, already fixed, or cannot be fixed safely, leave the
  code unchanged and append one line to ${NOTES_FILE} explaining why.${
    testCommand
      ? `
- Dependencies are already installed. Before finishing, run \`${testCommand}\`
  and fix any failures your changes caused.`
      : ''
  }

${UNTRUSTED_CONTENT_RULES}

## Pull request
${pr} — branch \`${branch}\`

## Findings
${findings}
`;
}

// Work order for a repair round; mirrors the generator's. The resumed
// session carries the findings and the reasoning behind the fix; a
// fresh-session fallback (no resumable id) gets pointed at the task file,
// which is still on disk.
function repairPrompt(testCommand: string, testOutput: string, fresh: boolean): string {
  return `${
    fresh ? `Read ${TASK_FILE} for the findings previously addressed in this checkout.\n\n` : ''
  }The repository test command (\`${testCommand}\`) failed after your changes:

\`\`\`
${testOutput}
\`\`\`

Fix the failures your changes caused, then re-run the tests to confirm. Rules
unchanged: no git commit or push, no scope creep. If a failure clearly
pre-dates this fix and cannot be fixed safely, append one line to ${NOTES_FILE}
explaining why and stop.

${UNTRUSTED_CONTENT_RULES}
`;
}

// Boots the fixer container and reports the runner toolchain versions —
// verifies the image, the DO binding, and exec plumbing without touching
// GitHub or spending any model tokens.
export async function sandboxSmoke(checkAuth = false): Promise<Record<string, string>> {
  const sandbox = runnerSandbox('smoke', { sleepAfter: '2m' });
  const out: Record<string, string> = {};
  for (const cmd of ['git --version', 'node --version', 'claude --version']) {
    const res = await sandbox.exec(cmd, { timeout: 60_000 });
    out[cmd] = res.success ? res.stdout.trim() : `exit ${res.exitCode}: ${res.stderr.trim()}`;
  }
  if (checkAuth) {
    const auth = resolveRunnerAuth();
    const ping = await sandbox.exec(`claude -p "Reply with exactly: ok" --output-format text`, {
      timeout: 2 * 60_000,
      env: runnerEnvironment(auth),
    });
    out[`agent auth (${auth.mode})`] = ping.success
      ? ping.stdout.trim()
      : `exit ${ping.exitCode}: ${`${ping.stdout}\n${ping.stderr}`.trim().slice(-500)}`;
  }
  return out;
}

export async function runFix(params: FixParams): Promise<FixOutcome> {
  const { owner, repo, prNumber } = params;
  const token = await installationToken(params.installationId);
  const auth = resolveRunnerAuth(params.authMode, params.runnerModel);
  // Any surfaced output must never leak a token. The sandbox only ever sees
  // gitToken — scoped to this one repository with contents access only (plus
  // workflows when the PR already touches .github/workflows/) — so a
  // prompt-injected agent run cannot touch other repos or App permissions.
  const gitToken = await sandboxGitToken(params.installationId, repo, 'write', {
    workflows: await prTouchesWorkflowFiles(token, owner, repo, prNumber),
  });
  const scrub = (s: string) => redactSecrets(s, [token, gitToken]);

  const findings =
    params.findings?.trim() ||
    (params.workflowRunId !== undefined
      ? await ciFailureFindings(token, owner, repo, params.workflowRunId)
      : await latestBlockingFindings(token, owner, repo, prNumber));
  if (!findings) {
    throw new Error(
      params.workflowRunId !== undefined
        ? `workflow run ${params.workflowRunId} has no failed jobs with retrievable logs`
        : 'no findings supplied and no blocking bot review found on the PR',
    );
  }
  const { headRef, headRepo } = await fetchPushablePrHead(token, owner, repo, prNumber);

  const sandbox = runnerSandbox(`fix--${owner}--${repo}--${prNumber}`.toLowerCase(), {
    sleepAfter: '20m',
  });

  // Fresh checkout per run; the branch name and token travel via env so the
  // command string stays free of secrets and shell-hostile ref names.
  const gitEnv = { GIT_TOKEN: gitToken, FIX_BRANCH: headRef };
  await sandbox.exec(`rm -rf ${CLONE_DIR} ${NOTES_FILE} /workspace/fix-repair-*.md`);
  const clone = await sandbox.exec(
    `git clone --depth 50 --single-branch --branch "$FIX_BRANCH" ` +
      `"https://x-access-token:$GIT_TOKEN@github.com/${headRepo}.git" ${CLONE_DIR}`,
    { env: gitEnv, timeout: 5 * 60_000 },
  );
  if (!clone.success) {
    throw new Error(`git clone failed: ${scrub(clone.stderr).slice(0, 500)}`);
  }
  // The clone URL (token included) lands in .git/config — strip it before
  // anything else runs in the checkout. Both the agent and the repo's own
  // check command execute untrusted repo content with network egress, so the
  // token must not be readable from disk during either; the push below
  // supplies it via env to an explicit-URL command instead.
  await sandbox.exec(
    `git -C ${CLONE_DIR} remote set-url origin "https://github.com/${headRepo}.git" && ` +
      `git -C ${CLONE_DIR} config user.name "turbodiff[bot]" && ` +
      `git -C ${CLONE_DIR} config user.email "turbodiff[bot]@users.noreply.github.com"`,
  );

  // Install dependencies up front so the agent can run the repo's tests
  // while it works instead of flying blind until the post-run check (and so
  // the repair loop's re-runs don't each pay an install). Non-fatal: some
  // repos' test commands do their own install.
  if (params.testCommand) {
    const installFailure = await installDependencies(sandbox, CLONE_DIR);
    if (installFailure) {
      console.warn(
        `turbodiff: dependency preinstall failed for ${owner}/${repo}#${prNumber}: ${scrub(installFailure)}`,
      );
    }
  }

  try {
    await sandbox.writeFile(
      TASK_FILE,
      taskPrompt(`${owner}/${repo}#${prNumber}`, headRef, findings, params.testCommand),
    );

    await mountSkills(sandbox, CLONE_DIR, await listEnabledSkillsForRepo(params.repositoryId));

    // Headless Claude Code run. --dangerously-skip-permissions is safe here —
    // the container is the isolation boundary (IS_SANDBOX acknowledges that).
    // stream-json (requires --verbose headless) captures every turn, not just
    // the final result — persisted below so a sandbox run can be compared
    // against a local session turn by turn.
    const agent = await sandbox.exec(
      `claude -p --dangerously-skip-permissions --output-format stream-json --verbose < ${TASK_FILE}`,
      {
        cwd: CLONE_DIR,
        timeout: AGENT_TIMEOUT_MS,
        env: runnerEnvironment(auth, NPM_CACHE_ENV),
      },
    );
    let totalUsage = parseClaudeCliUsage(agent.stdout);
    const fullOutput = scrub(`${claudeCliResultText(agent.stdout)}\n${agent.stderr}`.trim());
    const agentOutput = fullOutput.slice(-8_000);
    if (params.attemptId !== undefined) {
      await persistAgentLog(
        'fix',
        fullOutput,
        agent.success,
        { fixAttemptId: params.attemptId },
        scrub(agent.stdout),
      );
    }
    if (!agent.success) {
      throw new Error(`fix agent exited ${agent.exitCode}: ${agentOutput.slice(-1_000)}`);
    }

    const readNotes = () =>
      sandbox
        .readFile(NOTES_FILE)
        .then((f) => f.content.trim() || undefined)
        .catch(() => undefined);
    let notes = await readNotes();

    const status = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
    if (!status.stdout.trim()) {
      await postFixComment(token, params, { changed: false, notes });
      return {
        status: 'no_changes',
        authMode: auth.mode,
        branch: headRef,
        notes,
        agentOutput,
        usage: totalUsage,
      };
    }

    // Commit the fix BEFORE running checks so check-command working-tree
    // mutations (dep installs, config edits) never leak into the pushed
    // commit. Local until checks pass and we push.
    const committed = await sandbox.exec(
      `git -C ${CLONE_DIR} add -A && ` +
        `git -C ${CLONE_DIR} commit -m "Address ${fixLabel(params.trigger)} on #${prNumber} (turbodiff fix agent)"`,
      { env: gitAuthorEnv(params.author), timeout: 60_000 },
    );
    if (!committed.success) {
      throw new Error(`git commit failed: ${scrub(committed.stderr).slice(0, 500)}`);
    }

    let testOutput: string | undefined;
    if (params.testCommand) {
      const runTests = async () => {
        const tests = await sandbox.exec(params.testCommand!, {
          cwd: CLONE_DIR,
          timeout: TEST_TIMEOUT_MS,
          env: NPM_CACHE_ENV,
        });
        return { ok: tests.success, output: scrub(`${tests.stdout}\n${tests.stderr}`.trim()) };
      };
      let tests = await runTests();
      let sessionId = claudeCliSessionId(agent.stdout);
      for (let round = 1; !tests.ok && round <= REPAIR_ROUNDS; round++) {
        // Drop test-command working-tree mutations before the agent looks:
        // tracked files reset to the fix commit, and untracked test
        // artifacts (non-ignored only) go with them.
        await sandbox.exec(`git -C ${CLONE_DIR} checkout -- . && git -C ${CLONE_DIR} clean -fd`);
        await sandbox.writeFile(
          repairFile(round),
          repairPrompt(params.testCommand, tests.output.slice(-6_000), sessionId === null),
        );
        // --resume continues the run that made the changes with its full
        // context intact (each resume prints a fresh session id, carried
        // forward). No id — a killed run that never printed its result —
        // falls back to a fresh session pointed at the task file.
        const baseEnv = runnerEnvironment(auth, NPM_CACHE_ENV);
        const repairEnv = sessionId ? { ...baseEnv, RESUME_SESSION: sessionId } : baseEnv;
        const repair = await sandbox.exec(
          `claude -p ${sessionId ? '--resume "$RESUME_SESSION" ' : ''}` +
            `--dangerously-skip-permissions --output-format stream-json --verbose < ${repairFile(round)}`,
          { cwd: CLONE_DIR, timeout: REPAIR_TIMEOUT_MS, env: repairEnv },
        );
        totalUsage = addCliUsage(totalUsage, parseClaudeCliUsage(repair.stdout));
        if (params.attemptId !== undefined) {
          await persistAgentLog(
            'fix',
            scrub(`${claudeCliResultText(repair.stdout)}\n${repair.stderr}`.trim()),
            repair.success,
            { fixAttemptId: params.attemptId },
            scrub(repair.stdout),
          );
        }
        // A failed repair run ends the loop, not the fix — the last test
        // verdict is the recorded outcome either way.
        if (!repair.success) break;
        sessionId = claudeCliSessionId(repair.stdout) ?? sessionId;
        const repaired = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
        if (!repaired.stdout.trim()) break;
        // Fold into the existing fix commit: nothing is pushed yet, and one
        // commit per attempt keeps the PR readable. --amend preserves the
        // instructing user as author.
        const amended = await sandbox.exec(
          `git -C ${CLONE_DIR} add -A && git -C ${CLONE_DIR} commit --amend --no-edit`,
          { timeout: 60_000 },
        );
        if (!amended.success) {
          throw new Error(`repair commit failed: ${scrub(amended.stderr).slice(0, 500)}`);
        }
        tests = await runTests();
      }
      // Repair rounds may have appended to the notes file.
      notes = await readNotes();
      testOutput = tests.output.slice(-4_000);
      if (!tests.ok) {
        return {
          status: 'tests_failed',
          authMode: auth.mode,
          branch: headRef,
          notes,
          testOutput,
          agentOutput,
          usage: totalUsage,
        };
      }
    }

    const push = await sandbox.exec(
      `git -C ${CLONE_DIR} push ` +
        `"https://x-access-token:$GIT_TOKEN@github.com/${headRepo}.git" HEAD:"$FIX_BRANCH"`,
      { env: gitEnv, timeout: 2 * 60_000 },
    );
    if (!push.success) {
      throw new Error(describePushFailure(scrub(push.stderr).slice(0, 500)));
    }
    const commit = (await sandbox.exec(`git -C ${CLONE_DIR} rev-parse HEAD`)).stdout.trim();

    await postFixComment(token, params, {
      changed: true,
      commit,
      notes,
      tested: !!params.testCommand,
    });
    return {
      status: 'fixed',
      authMode: auth.mode,
      branch: headRef,
      commit,
      notes,
      testOutput,
      agentOutput,
      usage: totalUsage,
    };
  } finally {
    // Belt and braces: the remote was already scrubbed right after clone,
    // but an idle sandbox (sleepAfter keeps it warm) must never hold a
    // usable credential, so re-assert it on every exit path.
    await sandbox.exec(
      `git -C ${CLONE_DIR} remote set-url origin "https://github.com/${headRepo}.git"`,
    );
  }
}

// Queue message enqueued by the pull_request_review webhook when a blocking
// turbodiff review lands on an auto-fix-enabled repo.
export interface FixProcessorDependencies {
  runFix?: typeof runFix;
}

// Queue consumer body: re-validate against current state (the toggle may have
// flipped since enqueue), enforce the iteration cap, run the fix, and record
// the attempt. Never throws — a fix failure is recorded, not retried, so a
// broken run can't spend tokens again on redelivery.
export async function processFixMessage(
  msg: FixQueueMessage,
  dependencies: FixProcessorDependencies = {},
): Promise<void> {
  const executeFix = dependencies.runFix ?? runFix;
  const repo = await getRepoById(msg.repoId);
  if (!repo || !repo.enabled || !repo.auto_fix) {
    console.log(`turbodiff: fix skipped for repo ${msg.repoId}#${msg.prNumber} (auto-fix off)`);
    return;
  }
  const label = `${repo.owner}/${repo.name}#${msg.prNumber}`;
  const installation = await getInstallation(repo.installation_id);
  if (!installation || installation.suspended) {
    console.log(`turbodiff: fix skipped for ${label} (installation missing or suspended)`);
    return;
  }
  const feature = await getFeatureByRepoPr(repo.id, msg.prNumber);
  if (!feature || feature.status !== 'pr_opened') {
    console.log(`turbodiff: fix skipped for ${label} (not an open factory PR)`);
    return;
  }

  // The cap check, the running-attempt check, and the attempt insert are one
  // atomic statement — two concurrent deliveries for the same PR can't both
  // start a run past the cap or clobber an in-flight sandbox.
  const attemptId = await tryRecordFixAttempt(repo.id, msg.prNumber, msg.trigger, FIX_MAX_ATTEMPTS);
  if (attemptId === null) {
    // A run already in flight for this PR is the single-flight guard doing
    // its job, not the cap — the "N attempts have run" handoff text would be
    // misleading here, so only post it when the cap is actually the reason.
    if (await hasRunningFixAttempt(repo.id, msg.prNumber)) {
      console.log(`turbodiff: fix already running for ${label}, skipping`);
      return;
    }
    console.warn(`turbodiff: fix cap reached for ${label}`);
    await postFixHandoffComment(
      repo.installation_id,
      repo.owner,
      repo.name,
      msg.prNumber,
      FIX_MAX_ATTEMPTS,
    );
    return;
  }
  if (msg.commentIds?.length) {
    // Link before the (multi-minute) run so the cockpit shows "fixing…"
    // immediately rather than only after it finishes.
    await linkCommentsToFixAttempt(msg.commentIds, attemptId);
  }
  try {
    const outcome = await executeFix({
      owner: repo.owner,
      repo: repo.name,
      prNumber: msg.prNumber,
      installationId: repo.installation_id,
      repositoryId: repo.id,
      findings: msg.findings,
      testCommand: repo.check_command ?? undefined,
      author: msg.author,
      attemptId,
      trigger: msg.trigger,
      workflowRunId: msg.workflowRunId,
      runnerModel: feature.runner_model ?? undefined,
    });
    await finishFixAttempt(
      attemptId,
      outcome.status,
      outcome.commit,
      undefined,
      outcome.usage ?? undefined,
    );
    console.log(`turbodiff: fix ${outcome.status} for ${label} (attempt ${attemptId})`);
    // A fix push invalidates prior verification evidence: re-verify factory
    // PRs so the report (and the auto-merge gate) reflects the fixed code.
    if (outcome.status === 'fixed') {
      const feature = await getFeatureByRepoPr(repo.id, msg.prNumber);
      if (feature?.acceptance) {
        await enqueueFactoryMessage({ kind: 'verify', featureId: feature.id });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishFixAttempt(attemptId, 'failed', undefined, message.slice(0, 500));
    console.error(`turbodiff: fix attempt failed for ${label}:`, err);
  }
}

async function postFixComment(
  token: string,
  params: FixParams,
  result: { changed: boolean; commit?: string; notes?: string; tested?: boolean },
): Promise<void> {
  const lines = result.changed
    ? [
        `🔧 Turbodiff fix agent pushed ${result.commit} addressing the ${fixLabel(params.trigger)}.`,
        result.tested ? 'Tests passed before pushing.' : undefined,
      ]
    : ['🔧 Turbodiff fix agent ran but made no code changes.'];
  if (result.notes) lines.push('', '**Findings left unaddressed:**', result.notes);
  try {
    await gh(token, `/repos/${params.owner}/${params.repo}/issues/${params.prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: lines.filter((l) => l !== undefined).join('\n') }),
    });
  } catch (err) {
    // The fix itself succeeded; a failed comment shouldn't fail the run.
    console.error('turbodiff: fix summary comment failed:', err);
  }
}
