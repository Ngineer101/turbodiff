import { env } from 'cloudflare:workers';
import { redactSecrets } from '../runtime/redaction.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';

// Phase-0 Cloudflare Artifacts spike (docs/artifacts-spike.md): one operator
// call proves the whole provider loop the factory needs — create repo, mint
// scoped tokens, git init/commit/push from the sandbox container, clone-verify
// with a read token, revoke and confirm rejection. Throwaway by design; the
// real provider interface lands in Phase 1.

// Artifacts repo-name rule (letters/digits/._- after a letter or digit),
// tightened to a length cap. Also the shell-safety gate: `name` is
// interpolated into sandbox commands, so nothing outside this set may pass.
export const SPIKE_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface SpikeStep {
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface SpikeReport {
  ok: boolean;
  repo: { name: string; id: string; remote: string; defaultBranch: string } | null;
  steps: SpikeStep[];
  note: string;
}

export async function runArtifactsSpike(requestedName?: string): Promise<SpikeReport> {
  const name = requestedName ?? `spike-${crypto.randomUUID().slice(0, 8)}`;
  if (!SPIKE_REPO_NAME.test(name)) {
    throw new Error(`repo name must match ${SPIKE_REPO_NAME}`);
  }

  const steps: SpikeStep[] = [];
  const secrets: string[] = [];
  const scrub = (text: string) => redactSecrets(text, secrets).slice(0, 500);
  let repo: SpikeReport['repo'] = null;
  const report = (): SpikeReport => ({
    ok: steps.every((s) => s.ok),
    repo,
    steps,
    note:
      'Repo is kept for inspection — delete via DELETE /internal/artifacts-spike/repos/:name. ' +
      'If event subscriptions are configured (docs/artifacts-spike.md), pushed/created events ' +
      'appear at GET /internal/artifacts-spike/events within a minute.',
  });

  async function step<T>(label: string, run: () => Promise<[T, string]>): Promise<T | null> {
    const started = Date.now();
    try {
      const [value, detail] = await run();
      steps.push({ step: label, ok: true, ms: Date.now() - started, detail });
      return value;
    } catch (err) {
      steps.push({
        step: label,
        ok: false,
        ms: Date.now() - started,
        detail: scrub(err instanceof Error ? err.message : String(err)),
      });
      return null;
    }
  }

  const created = await step('create repo (binding)', async () => {
    const result = await env.GIT_ARTIFACTS.create(name, {
      description: 'turbodiff phase-0 provider spike',
    });
    secrets.push(result.token);
    return [result, `id=${result.id} defaultBranch=${result.defaultBranch}`];
  });
  if (!created) return report();
  repo = {
    name: created.name,
    id: created.id,
    remote: created.remote,
    defaultBranch: created.defaultBranch,
  };

  const writeToken = await step('mint write token (ttl 900s)', async () => {
    const handle = await env.GIT_ARTIFACTS.get(name);
    const token = await handle.createToken('write', 900);
    secrets.push(token.plaintext);
    return [token, `id=${token.id} expires=${token.expiresAt}`];
  });
  if (!writeToken) return report();

  // Same credential rules as repository-workspace.ts: tokens only travel via
  // env into explicit-URL/extraHeader git commands, never into .git/config.
  const sandbox = runnerSandbox('artifacts-spike');
  const dir = `/tmp/artifacts-spike/${name}`;
  const gitEnv = { GIT_TOKEN: writeToken.plaintext, REMOTE: created.remote };

  const head = await step('git init + commit + push (sandbox)', async () => {
    const result = await sandbox.exec(
      `rm -rf ${dir} && mkdir -p ${dir} && cd ${dir} && ` +
        `git init -q -b main && ` +
        `git config user.name "turbodiff[bot]" && git config user.email "bot@turbodiff.dev" && ` +
        `printf 'turbodiff artifacts spike\\n' > README.md && ` +
        `git add . && git commit -q -m "phase-0 spike: initial commit" && ` +
        `git -c http.extraHeader="Authorization: Bearer $GIT_TOKEN" push -q "$REMOTE" main && ` +
        `git rev-parse HEAD`,
      // First exec pays the container boot, hence the generous timeout.
      { env: gitEnv, timeout: 5 * 60_000 },
    );
    if (!result.success) throw new Error(`init/push failed: ${result.stderr}`);
    const sha = result.stdout.trim().split('\n').pop() ?? '';
    return [sha, `head=${sha}`];
  });
  if (!head) return report();

  const readToken = await step('mint read token (ttl 900s)', async () => {
    const handle = await env.GIT_ARTIFACTS.get(name);
    const token = await handle.createToken('read', 900);
    secrets.push(token.plaintext);
    return [token, `id=${token.id} expires=${token.expiresAt}`];
  });
  if (!readToken) return report();

  await step('clone with read token + verify head (sandbox)', async () => {
    const result = await sandbox.exec(
      `rm -rf ${dir}-verify && ` +
        `git -c http.extraHeader="Authorization: Bearer $GIT_TOKEN" clone -q "$REMOTE" ${dir}-verify && ` +
        `git -C ${dir}-verify rev-parse HEAD`,
      { env: { GIT_TOKEN: readToken.plaintext, REMOTE: created.remote }, timeout: 2 * 60_000 },
    );
    if (!result.success) throw new Error(`clone failed: ${result.stderr}`);
    const clonedHead = result.stdout.trim().split('\n').pop() ?? '';
    if (clonedHead !== head) throw new Error(`cloned head ${clonedHead} != pushed head ${head}`);
    return [true, `head matches (${clonedHead})`];
  });

  await step('second commit + push (sandbox)', async () => {
    const result = await sandbox.exec(
      `cd ${dir} && printf 'second commit\\n' >> README.md && ` +
        `git commit -q -am "phase-0 spike: second commit" && ` +
        `git -c http.extraHeader="Authorization: Bearer $GIT_TOKEN" push -q "$REMOTE" main`,
      { env: gitEnv, timeout: 2 * 60_000 },
    );
    if (!result.success) throw new Error(`second push failed: ${result.stderr}`);
    return [true, 'non-initial push accepted'];
  });

  await step('list tokens (binding)', async () => {
    const handle = await env.GIT_ARTIFACTS.get(name);
    const listing = await handle.listTokens();
    return [true, `total=${listing.total}`];
  });

  const revoked = await step('revoke read token (binding)', async () => {
    const handle = await env.GIT_ARTIFACTS.get(name);
    const ok = await handle.revokeToken(readToken.id);
    if (!ok) throw new Error('revokeToken returned false');
    return [true, `revoked id=${readToken.id}`];
  });

  if (revoked) {
    await step('clone with revoked token is rejected (sandbox)', async () => {
      const result = await sandbox.exec(
        `rm -rf ${dir}-revoked && ` +
          `git -c http.extraHeader="Authorization: Bearer $GIT_TOKEN" clone -q "$REMOTE" ${dir}-revoked`,
        { env: { GIT_TOKEN: readToken.plaintext, REMOTE: created.remote }, timeout: 60_000 },
      );
      if (result.success) throw new Error('clone with revoked token unexpectedly succeeded');
      return [true, 'revoked token rejected as expected'];
    });
  }

  await step('re-read repo metadata (binding)', async () => {
    const handle = await env.GIT_ARTIFACTS.get(name);
    return [true, `lastPushAt=${handle.lastPushAt} updatedAt=${handle.updatedAt}`];
  });

  // Best-effort workspace cleanup; the sandbox is shared across spike runs.
  await sandbox.exec(`rm -rf ${dir} ${dir}-verify ${dir}-revoked`).catch(() => {});

  return report();
}
