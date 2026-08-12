import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import { gitAuthorEnv } from './attribution.ts';
import { openToken } from './crypto.ts';
import {
  finishFixAttempt,
  getFeatureByRepoPr,
  getRepoById,
  getRunnerCredential,
  tryRecordFixAttempt,
} from './db.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';

// Phase 1 spike of the software factory fix loop (docs/software-factory-design.md):
// clone a PR's head branch into a Cloudflare Sandbox, run a coding agent CLI
// against the review findings, run the repo's tests, and push the fix commit.
//
// Runner auth is pluggable so users can spend their existing Claude or Codex
// subscription instead of API credits through the AI Gateway. Per-user
// credentials (runner_credentials, sealed) win when the triggering user has
// one configured; otherwise every mode falls back to the Worker-level
// secrets below, unchanged from before per-user credentials existed.

export type FixAuthMode =
  | 'claude_subscription'
  | 'gateway'
  | 'codex_subscription'
  | 'codex_api_key';
export type FixRunner = 'claude' | 'codex';

export interface RunnerAuth {
  mode: FixAuthMode;
  runner: FixRunner;
  vars: Record<string, string>;
  // Absolute sandbox paths to write before invoking the CLI (e.g. Codex's
  // auth.json for subscription reuse) — written by writeRunnerAuthFiles.
  files?: Record<string, string>;
  // Raw secret values behind `vars`/`files` above (never the non-secret
  // base_url) — scrub every one of these from any surfaced agent output.
  secrets: string[];
}

export interface FixParams {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  // Markdown work order. When omitted, the latest blocking (CHANGES_REQUESTED)
  // bot review on the PR — i.e. turbodiff's own — is used instead.
  findings?: string;
  authMode?: FixAuthMode;
  // e.g. "npm test". When set, a failing run blocks the push.
  testCommand?: string;
  // The instructing user (e.g. a cockpit commenter) — becomes the git author
  // of the fix commit; the bot stays committer. Absent on auto-triggered runs.
  // Also whose stored runner credential (if any) authenticates this run —
  // see resolveRunnerAuth.
  author?: { login: string; id: number };
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

// Sandbox home for a per-user Codex subscription: Codex CLI reuses a
// ChatGPT sign-in via an auth.json file rather than a bearer env var, so the
// stored "secret" for codex_subscription IS that file's content, written
// here before the CLI runs (see writeRunnerAuthFiles).
const CODEX_HOME_DIR = '/workspace/.codex-home';

// Pick the runner credential for a factory run. Resolution order when no
// specific mode is requested: the triggering user's own claude_subscription,
// then their codex_subscription/codex_api_key, then their own claude
// gateway, then the Worker-level secrets below (unauthenticated-user and
// pre-this-feature behavior, unchanged). `requested` always wins when given
// and configured — used by the operator /internal/fix endpoint, which has
// no signed-in user (userId stays undefined there, Worker-level only).
export async function resolveRunnerAuth(
  userId?: number | null,
  requested?: FixAuthMode,
): Promise<RunnerAuth> {
  const candidates = new Map<FixAuthMode, RunnerAuth>();

  if (userId != null) {
    const [claudeCred, codexCred] = await Promise.all([
      getRunnerCredential(userId, 'claude'),
      getRunnerCredential(userId, 'codex'),
    ]);
    if (claudeCred?.auth_mode === 'subscription') {
      const secret = await openToken(claudeCred.secret_ciphertext);
      candidates.set('claude_subscription', {
        mode: 'claude_subscription',
        runner: 'claude',
        vars: { CLAUDE_CODE_OAUTH_TOKEN: secret },
        secrets: [secret],
      });
    } else if (claudeCred?.auth_mode === 'gateway' && claudeCred.base_url) {
      const secret = await openToken(claudeCred.secret_ciphertext);
      candidates.set('gateway', {
        mode: 'gateway',
        runner: 'claude',
        vars: { ANTHROPIC_BASE_URL: claudeCred.base_url, ANTHROPIC_API_KEY: secret },
        secrets: [secret],
      });
    }
    if (codexCred?.auth_mode === 'subscription') {
      const secret = await openToken(codexCred.secret_ciphertext);
      candidates.set('codex_subscription', {
        mode: 'codex_subscription',
        runner: 'codex',
        vars: { CODEX_HOME: CODEX_HOME_DIR },
        files: { [`${CODEX_HOME_DIR}/auth.json`]: secret },
        secrets: [secret],
      });
    } else if (codexCred?.auth_mode === 'api_key') {
      const secret = await openToken(codexCred.secret_ciphertext);
      candidates.set('codex_api_key', {
        mode: 'codex_api_key',
        runner: 'codex',
        vars: {
          OPENAI_API_KEY: secret,
          ...(codexCred.base_url ? { OPENAI_BASE_URL: codexCred.base_url } : {}),
        },
        secrets: [secret],
      });
    }
  }

  // Worker-level fallback: only fills modes the user hasn't configured
  // themselves. No Worker-level fallback exists for Codex — it's opt-in only.
  const subscriptionToken = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  const gatewayKey = (env.FIXER_ANTHROPIC_API_KEY ?? '').trim();
  const gatewayUrl = (env.FIXER_ANTHROPIC_BASE_URL ?? '').trim();
  if (subscriptionToken && !candidates.has('claude_subscription')) {
    candidates.set('claude_subscription', {
      mode: 'claude_subscription',
      runner: 'claude',
      vars: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken },
      secrets: [subscriptionToken],
    });
  }
  if (gatewayKey && gatewayUrl && !candidates.has('gateway')) {
    candidates.set('gateway', {
      mode: 'gateway',
      runner: 'claude',
      vars: { ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_API_KEY: gatewayKey },
      secrets: [gatewayKey],
    });
  }

  if (requested) {
    const picked = candidates.get(requested);
    if (!picked) {
      throw new Error(`${requested} mode requires a configured ${requested} credential`);
    }
    return picked;
  }
  const order = ['claude_subscription', 'codex_subscription', 'codex_api_key', 'gateway'] as const;
  for (const mode of order) {
    const picked = candidates.get(mode);
    if (picked) return picked;
  }
  throw new Error(
    'no runner credential configured: connect one under "my agents", or set CLAUDE_CODE_OAUTH_TOKEN ' +
      '(subscription) or FIXER_ANTHROPIC_API_KEY + FIXER_ANTHROPIC_BASE_URL (gateway) on the Worker',
  );
}

// Writes any files a resolved credential needs on disk before the CLI runs
// (currently only Codex's auth.json for subscription reuse) — writeFile
// needs the parent directory to already exist, so mkdir it first.
export async function writeRunnerAuthFiles(sandbox: Sandbox, auth: RunnerAuth): Promise<void> {
  if (!auth.files) return;
  for (const [path, content] of Object.entries(auth.files)) {
    await sandbox.exec(`mkdir -p "$(dirname '${path}')"`);
    await sandbox.writeFile(path, content);
  }
}

// The headless invocation for the resolved runner. Centralized so the two
// CLIs' differing flags/stdin conventions don't drift across the four call
// sites (fixer, planner, generation workflow, verifier).
export function runnerCommand(
  auth: RunnerAuth,
  promptFile: string,
  opts: { model?: string } = {},
): string {
  if (auth.runner === 'codex') {
    return `codex exec --full-auto --skip-git-repo-check < ${promptFile}`;
  }
  const model = opts.model ? ` --model ${opts.model}` : '';
  return `claude -p --dangerously-skip-permissions --output-format text${model} < ${promptFile}`;
}

// Every surfaced agent output (stdout/stderr slices, thrown error messages,
// PR/handoff comments) must have any resolved per-user runner secret
// scrubbed, exactly like the installation/git tokens already are.
export function scrubSecrets(s: string, auth: RunnerAuth): string {
  return auth.secrets.reduce((acc, secret) => (secret ? acc.replaceAll(secret, '***') : acc), s);
}

async function fetchPrHead(
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
  for (const cmd of ['git --version', 'node --version', 'claude --version', 'codex --version']) {
    const res = await sandbox.exec(cmd, { timeout: 60_000 });
    out[cmd] = res.success ? res.stdout.trim() : `exit ${res.exitCode}: ${res.stderr.trim()}`;
  }
  if (checkAuth) {
    // No signed-in user probes this endpoint — always the Worker-level
    // credential, unaffected by any per-user runner_credentials rows.
    const auth = await resolveRunnerAuth(null);
    await writeRunnerAuthFiles(sandbox, auth);
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
  const auth = await resolveRunnerAuth(params.author?.id, params.authMode);
  // Any surfaced output must never leak a token. The sandbox only ever sees
  // gitToken — scoped to this one repository with contents access only — so a
  // prompt-injected agent run cannot touch other repos or App permissions.
  // scrubSecrets additionally strips the resolved runner credential, per-user
  // or Worker-level, before anything is returned or posted to GitHub.
  const gitToken = await sandboxGitToken(params.installationId, repo, 'write');
  const scrub = (s: string) =>
    scrubSecrets(s.replaceAll(token, '***').replaceAll(gitToken, '***'), auth);

  const findings =
    params.findings?.trim() || (await latestBlockingFindings(token, owner, repo, prNumber));
  if (!findings) {
    throw new Error('no findings supplied and no blocking bot review found on the PR');
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
  await sandbox.exec(
    `git -C ${CLONE_DIR} config user.name "turbodiff[bot]" && ` +
      `git -C ${CLONE_DIR} config user.email "turbodiff[bot]@users.noreply.github.com"`,
  );

  try {
    await sandbox.writeFile(
      TASK_FILE,
      taskPrompt(`${owner}/${repo}#${prNumber}`, headRef, findings),
    );
    await writeRunnerAuthFiles(sandbox, auth);

    // Headless coding-agent run. --dangerously-skip-permissions (Claude) /
    // --full-auto (Codex) are safe here — the container is the isolation
    // boundary (IS_SANDBOX acknowledges that).
    const agent = await sandbox.exec(runnerCommand(auth, TASK_FILE), {
      cwd: CLONE_DIR,
      timeout: AGENT_TIMEOUT_MS,
      env: {
        ...auth.vars,
        IS_SANDBOX: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    });
    const agentOutput = scrub(`${agent.stdout}\n${agent.stderr}`.trim()).slice(-8_000);
    if (!agent.success) {
      throw new Error(`fix agent exited ${agent.exitCode}: ${agentOutput.slice(-1_000)}`);
    }

    const notes = await sandbox
      .readFile(NOTES_FILE)
      .then((f) => (f.content.trim() ? scrub(f.content.trim()) : undefined))
      .catch(() => undefined);

    const status = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
    if (!status.stdout.trim()) {
      await postFixComment(token, params, { changed: false, notes });
      return { status: 'no_changes', authMode: auth.mode, branch: headRef, notes, agentOutput };
    }

    // Commit the fix BEFORE running checks so check-command working-tree
    // mutations (dep installs, config edits) never leak into the pushed
    // commit. Local until checks pass and we push.
    const committed = await sandbox.exec(
      `git -C ${CLONE_DIR} add -A && ` +
        `git -C ${CLONE_DIR} commit -m "Address review findings on #${prNumber} (turbodiff fix agent)"`,
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
        };
      }
    }

    const push = await sandbox.exec(`git -C ${CLONE_DIR} push origin HEAD:"$FIX_BRANCH"`, {
      env: gitEnv,
      timeout: 2 * 60_000,
    });
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
    };
  } finally {
    // Scrub the token-embedded remote URL so an idle sandbox (sleepAfter
    // keeps it warm) never holds a usable credential after this run ends.
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

  // The cap check and the attempt insert are one atomic statement — two
  // concurrent deliveries for the same PR can't both start a run past the cap.
  const attemptId = await tryRecordFixAttempt(repo.id, msg.prNumber, msg.trigger, FIX_MAX_ATTEMPTS);
  if (attemptId === null) {
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
  try {
    const outcome = await runFix({
      owner: repo.owner,
      repo: repo.name,
      prNumber: msg.prNumber,
      installationId: repo.installation_id,
      findings: msg.findings,
      testCommand: repo.check_command ?? undefined,
      author: msg.author,
    });
    await finishFixAttempt(attemptId, outcome.status, outcome.commit);
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
async function postHandoffComment(
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
        `🔧 Turbodiff fix agent pushed ${result.commit} addressing the blocking review findings.`,
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
