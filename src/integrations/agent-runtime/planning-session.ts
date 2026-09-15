import type { Sandbox } from '@cloudflare/sandbox';
import { isJsonObject, isString, parseJson } from '../../shared/json.ts';
import { runnerEnvironment, type RunnerAuth } from './runner-config.ts';

// Planning is one research conversation. Delegating here multiplied provider
// retries, then discarded failed subagents' research and repeated it in the
// parent. Explicit deny remains effective with OpenCode's --auto flag.
export const PLANNING_CONFIG = JSON.stringify({ permission: { task: 'deny' } });

type SessionSandbox = Pick<Sandbox, 'exec' | 'writeFile' | 'readFile'>;
const sessionFile = (cwd: string) => `${cwd}/../planning-session.json`;

function sessionId(snapshot: string): string {
  const data = parseJson(snapshot);
  const id = isJsonObject(data) && isJsonObject(data.info) ? data.info.id : undefined;
  if (!isString(id) || !/^ses_[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw new Error('Invalid saved planning session');
  }
  return id;
}

// Export/import preserves tool results across sandbox replacement, not only a
// short summary. These commands make no model calls. The snapshot is private
// task data in R2, scrubbed by the caller before storage.
export async function exportPlanningSession(
  sandbox: SessionSandbox,
  auth: RunnerAuth,
  cwd: string,
  id: string,
): Promise<string> {
  const result = await sandbox.exec(
    'opencode export "$TURBODIFF_AGENT_SESSION" > "$TURBODIFF_SESSION_FILE"',
    {
      cwd,
      env: runnerEnvironment(
        auth,
        { TURBODIFF_AGENT_SESSION: id, TURBODIFF_SESSION_FILE: sessionFile(cwd) },
        PLANNING_CONFIG,
      ),
      timeout: 30_000,
    },
  );
  if (!result.success) throw new Error('Could not save planning context');
  const snapshot = (await sandbox.readFile(sessionFile(cwd))).content;
  if (sessionId(snapshot) !== id) throw new Error('Planning session export did not match');
  return snapshot;
}

export async function importPlanningSession(
  sandbox: SessionSandbox,
  auth: RunnerAuth,
  cwd: string,
  snapshot: string,
): Promise<string> {
  const id = sessionId(snapshot);
  await sandbox.writeFile(sessionFile(cwd), snapshot);
  const result = await sandbox.exec('opencode import "$TURBODIFF_SESSION_FILE"', {
    cwd,
    env: runnerEnvironment(auth, { TURBODIFF_SESSION_FILE: sessionFile(cwd) }, PLANNING_CONFIG),
    timeout: 30_000,
  });
  if (!result.success || !result.stdout.includes(`Imported session: ${id}`)) {
    throw new Error('Could not restore planning context');
  }
  return id;
}
