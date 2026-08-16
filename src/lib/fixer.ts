import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import { persistAgentLog } from './agent-runs.ts';
import { gitAuthorEnv } from './attribution.ts';
import { ciFailureFindings } from './ci-findings.ts';
import { claudeCliResultText, parseClaudeCliUsage, type CliUsage } from './cli-usage.ts';
import {
  finishFixAttempt,
  getFeatureByRepoPr,
  getRepoById,
  hasRunningFixAttempt,
  linkCommentsToFixAttempt,
  listEnabledSkillsForRepo,
  tryRecordFixAttempt,
} from './db.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';
import { skillMarkdown } from './skill-files.ts';

// Phase 1 spike of the software factory fix loop (docs/software-factory-design.md):
// clone a PR's head branch into a Cloudflare Sandbox, run a coding agent CLI
// against the review findings, run the repo's tests, and push the fix commit.
//
// Runner auth is pluggable so users can spend their existing Claude
// subscription (claude setup-token → CLAUDE_CODE_OAUTH_TOKEN) instead of API
// credits through the AI Gateway.

export type FixAuthMode = 'claude_subscription' | 'gateway';

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
}

// Human-readable label for the thing a fix run is addressing, used in the
// commit message and PR comment so a CI-triggered fix doesn't read like a
// review-triggered one.
function fixLabel(trigger?: string): string {
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
// Fix runs execute inside a Workflow step (no wall clock — see
// fix-workflow.ts), so the budgets reflect the work, not a deadline.
const AGENT_TIMEOUT_MS = 15 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

// Fix runs per PR across all triggers. A fix push causes a re-review, which
// can cause another blocking review and another fix — the cap guarantees the
// loop terminates and hands off to a human.
export const FIX_MAX_ATTEMPTS = 3;

// Pick the runner credential: explicit request wins, otherwise prefer the
// user's subscription token over gateway metering. Shared with the generator.
export function resolveRunnerAuth(requested?: FixAuthMode): {
  mode: FixAuthMode;
  vars: Record<string, string>;
} {
  const subscriptionToken = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  const gatewayKey = (env.FIXER_ANTHROPIC_API_KEY ?? '').trim();
  const gatewayUrl = (env.FIXER_ANTHROPIC_BASE_URL ?? '').trim();

  const subscription = subscriptionToken
    ? { mode: 'claude_subscription' as const, vars: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken } }
    : null;
  const gateway =
    gatewayKey && gatewayUrl
      ? {
          mode: 'gateway' as const,
          vars: { ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_API_KEY: gatewayKey },
        }
      : null;

  if (requested === 'claude_subscription' && !subscription) {
    throw new Error('claude_subscription mode requires the CLAUDE_CODE_OAUTH_TOKEN secret');
  }
  if (requested === 'gateway' && !gateway) {
    throw new Error(
      'gateway mode requires the FIXER_ANTHROPIC_API_KEY secret and FIXER_ANTHROPIC_BASE_URL var',
    );
  }
  const picked = requested === 'gateway' ? gateway : (subscription ?? gateway);
  if (!picked) {
    throw new Error(
      'no runner credential configured: set CLAUDE_CODE_OAUTH_TOKEN (subscription) or FIXER_ANTHROPIC_API_KEY + FIXER_ANTHROPIC_BASE_URL (gateway)',
    );
  }
  return picked;
}

export async function fetchPrHead(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ headRef: string; headRepo: string }> {
  const pr = (await (await gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}`)).json()) as {
    head: { ref: string; repo: { full_name: string } | null };
    base: { repo: { full_name: string } };
  };
  const headRepo = pr.head.repo?.full_name;
  if (!headRepo || headRepo.toLowerCase() !== pr.base.repo.full_name.toLowerCase()) {
    throw new Error('fixer only supports same-repo PR branches (fork PRs are not pushable)');
  }
  return { headRef: pr.head.ref, headRepo };
}

// Latest CHANGES_REQUESTED bot review (turbodiff's blocking review) folded into
// a markdown work order: review body + inline comments with their locations.
async function latestBlockingFindings(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string | null> {
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

function taskPrompt(pr: string, branch: string, findings: string): string {
  return `You are an automated fix agent operating on a checked-out pull request branch.

Address every finding listed below. Rules:
- Fix only what the findings describe — no drive-by refactors or cleanups.
- Match the repository's existing code style and conventions.
- Do NOT run git commit or git push; the harness handles git.
- If a finding is wrong, already fixed, or cannot be fixed safely, leave the
  code unchanged and append one line to ${NOTES_FILE} explaining why.

${UNTRUSTED_CONTENT_RULES}

## Pull request
${pr} — branch \`${branch}\`

## Findings
${findings}
`;
}

// Boots the fixer container and reports the runner toolchain versions —
// verifies the image, the DO binding, and exec plumbing without touching
// GitHub or spending any model tokens.
export async function sandboxSmoke(checkAuth = false): Promise<Record<string, string>> {
  const sandbox = getSandbox(env.Sandbox as unknown as DurableObjectNamespace<Sandbox>, 'smoke', {
    sleepAfter: '2m',
  });
  const out: Record<string, string> = {};
  for (const cmd of ['git --version', 'node --version', 'claude --version']) {
    const res = await sandbox.exec(cmd, { timeout: 60_000 });
    out[cmd] = res.success ? res.stdout.trim() : `exit ${res.exitCode}: ${res.stderr.trim()}`;
  }
  if (checkAuth) {
    const auth = resolveRunnerAuth();
    const ping = await sandbox.exec(`claude -p "Reply with exactly: ok" --output-format text`, {
      timeout: 2 * 60_000,
      env: { ...auth.vars, IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' },
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
  const auth = resolveRunnerAuth(params.authMode);
  // Any surfaced output must never leak a token. The sandbox only ever sees
  // gitToken — scoped to this one repository with contents access only — so a
  // prompt-injected agent run cannot touch other repos or App permissions.
  const gitToken = await sandboxGitToken(params.installationId, repo, 'write');
  const scrub = (s: string) => s.replaceAll(token, '***').replaceAll(gitToken, '***');

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
  const { headRef, headRepo } = await fetchPrHead(token, owner, repo, prNumber);

  const sandbox = getSandbox(
    env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
    `fix--${owner}--${repo}--${prNumber}`.toLowerCase(),
    { sleepAfter: '20m' },
  );

  // Fresh checkout per run; the branch name and token travel via env so the
  // command string stays free of secrets and shell-hostile ref names.
  const gitEnv = { GIT_TOKEN: gitToken, FIX_BRANCH: headRef };
  await sandbox.exec(`rm -rf ${CLONE_DIR} ${NOTES_FILE}`);
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

  try {
    await sandbox.writeFile(
      TASK_FILE,
      taskPrompt(`${owner}/${repo}#${prNumber}`, headRef, findings),
    );

    const skills = await listEnabledSkillsForRepo(params.repositoryId);
    for (const skill of skills) {
      const dir = `${CLONE_DIR}/.claude/skills/${skill.slug}`;
      await sandbox.exec(`mkdir -p ${dir}`);
      await sandbox.writeFile(`${dir}/SKILL.md`, skillMarkdown(skill));
    }

    // Headless Claude Code run. --dangerously-skip-permissions is safe here —
    // the container is the isolation boundary (IS_SANDBOX acknowledges that).
    const agent = await sandbox.exec(
      `claude -p --dangerously-skip-permissions --output-format json < ${TASK_FILE}`,
      {
        cwd: CLONE_DIR,
        timeout: AGENT_TIMEOUT_MS,
        env: {
          ...auth.vars,
          IS_SANDBOX: '1',
          DISABLE_AUTOUPDATER: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      },
    );
    const usage = parseClaudeCliUsage(agent.stdout);
    const fullOutput = scrub(`${claudeCliResultText(agent.stdout)}\n${agent.stderr}`.trim());
    const agentOutput = fullOutput.slice(-8_000);
    if (params.attemptId !== undefined) {
      await persistAgentLog('fix', fullOutput, agent.success, { fixAttemptId: params.attemptId });
    }
    if (!agent.success) {
      throw new Error(`fix agent exited ${agent.exitCode}: ${agentOutput.slice(-1_000)}`);
    }

    const notes = await sandbox
      .readFile(NOTES_FILE)
      .then((f) => f.content.trim() || undefined)
      .catch(() => undefined);

    const status = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
    if (!status.stdout.trim()) {
      await postFixComment(token, params, { changed: false, notes });
      return {
        status: 'no_changes',
        authMode: auth.mode,
        branch: headRef,
        notes,
        agentOutput,
        usage,
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
      const tests = await sandbox.exec(params.testCommand, {
        cwd: CLONE_DIR,
        timeout: TEST_TIMEOUT_MS,
      });
      testOutput = scrub(`${tests.stdout}\n${tests.stderr}`.trim()).slice(-4_000);
      if (!tests.success) {
        return {
          status: 'tests_failed',
          authMode: auth.mode,
          branch: headRef,
          notes,
          testOutput,
          agentOutput,
          usage,
        };
      }
    }

    const push = await sandbox.exec(
      `git -C ${CLONE_DIR} push ` +
        `"https://x-access-token:$GIT_TOKEN@github.com/${headRepo}.git" HEAD:"$FIX_BRANCH"`,
      { env: gitEnv, timeout: 2 * 60_000 },
    );
    if (!push.success) {
      throw new Error(`git push failed: ${scrub(push.stderr).slice(0, 500)}`);
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
      usage,
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
export interface FixQueueMessage {
  kind: 'fix';
  repoId: number;
  prNumber: number;
  trigger: string;
  // Explicit work order (e.g. unmet acceptance criteria from a verification
  // run). When absent, the latest blocking bot review on the PR is used.
  findings?: string;
  // Instructing user for commit attribution (cockpit comments); absent on
  // auto-triggered fixes.
  author?: { login: string; id: number };
  // Cockpit comments this batch addresses, linked to the attempt row once
  // recorded so the cockpit can show per-comment outcome badges. Absent for
  // the blocking_review trigger, which has no comments to link.
  commentIds?: number[];
  // Set only for the `ci_failure` trigger; runFix uses it to fetch the failed
  // jobs' logs lazily instead of a supplied `findings` string — mirrors how
  // `latestBlockingFindings` is used when `findings` is absent for the review
  // trigger.
  workflowRunId?: number;
}

// Queue consumer body: re-validate against current state (the toggle may have
// flipped since enqueue), enforce the iteration cap, run the fix, and record
// the attempt. Never throws — a fix failure is recorded, not retried, so a
// broken run can't spend tokens again on redelivery.
export async function processFixMessage(msg: FixQueueMessage): Promise<void> {
  const repo = await getRepoById(msg.repoId);
  if (!repo || !repo.enabled || !repo.auto_fix) {
    console.log(`turbodiff: fix skipped for repo ${msg.repoId}#${msg.prNumber} (auto-fix off)`);
    return;
  }
  const label = `${repo.owner}/${repo.name}#${msg.prNumber}`;

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
    await postHandoffComment(
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
    const outcome = await runFix({
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
        await env.FACTORY_QUEUE.send({ kind: 'verify', featureId: feature.id });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishFixAttempt(attemptId, 'failed', undefined, message.slice(0, 500));
    console.error(`turbodiff: fix attempt failed for ${label}:`, err);
  }
}

// Cap exhausted: leave a handoff summary instead of another silent iteration.
export async function postHandoffComment(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  attempts: number,
): Promise<void> {
  try {
    const token = await installationToken(installationId);
    await gh(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body:
          `🔧 Turbodiff auto-fix stopped: ${attempts} fix attempts have run on this PR (the cap) ` +
          `and the latest review still requests changes. A human should take over — see the fix ` +
          `commits and review threads above for what was attempted and what remains open.`,
      }),
    });
  } catch (err) {
    console.error('turbodiff: handoff comment failed:', err);
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
