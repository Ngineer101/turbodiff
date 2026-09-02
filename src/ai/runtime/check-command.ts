import type { ExecOptions, ExecResult } from '@cloudflare/sandbox';
import { NPM_CACHE_ENV } from './sandbox-deps.ts';

// The sliver of the sandbox this module drives. Narrowing to it (a real
// Sandbox is assignable) keeps the dependency surface honest and lets tests
// supply a lightweight fake without casting.
export interface CheckSandbox {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

// Running a repository's check command (the sandbox verification gate before
// factory pushes) has two hazards this helper handles for every runner:
//
//  1. PATH. The agent runs the check through pnpm/npm scripts, which put the
//     checkout's `node_modules/.bin` on PATH — so a check like `vp check` or
//     `eslint .` resolves. The harness's own post-run check ran the command
//     bare, without that bin dir, so those same commands died with
//     "command not found" and legitimate work was discarded as a test
//     failure. Prepend `node_modules/.bin` so the harness resolves binaries
//     the same way the package scripts do.
//
//  2. Executable vs. failing. A command that cannot be executed at all
//     (missing binary, not executable) is an environment/config error, not a
//     failing test — treating it as `tests_failed` silently throws away the
//     agent's changes and tells the user their code failed checks when it did
//     not. Surface it distinctly so the caller can fail loudly instead.

export interface CheckResult {
  ok: boolean;
  output: string;
  // The check command itself could not be run (binary missing from PATH, or
  // not executable) — distinct from the command running and reporting
  // failures. Callers should treat this as a hard error, not `tests_failed`.
  notExecutable: boolean;
}

// Shell exit codes for "could not execute the command": 127 = not found,
// 126 = found but not executable.
const NOT_FOUND = 127;
const NOT_EXECUTABLE = 126;

export async function runCheckCommand(
  sandbox: CheckSandbox,
  dir: string,
  command: string,
  scrub: (s: string) => string,
  timeoutMs: number,
): Promise<CheckResult> {
  // Prepend the checkout's bin dir via the shell so `$PATH` still expands to
  // the container's PATH (setting env.PATH directly would clobber it, since
  // exec merges env over the container and PATH is a single value).
  const res = await sandbox.exec(`export PATH="${dir}/node_modules/.bin:$PATH"; ${command}`, {
    cwd: dir,
    env: NPM_CACHE_ENV,
    timeout: timeoutMs,
  });
  const output = scrub(`${res.stdout}\n${res.stderr}`.trim());
  // Only treat as "could not run" when the shell's not-found/not-executable
  // exit code is corroborated by the matching message — a test that happens
  // to exit 127 on its own still counts as a real failure.
  const notExecutable =
    !res.success &&
    (res.exitCode === NOT_FOUND || res.exitCode === NOT_EXECUTABLE) &&
    /command not found|not found|no such file|not executable|permission denied/i.test(output);
  return { ok: res.success, output, notExecutable };
}

// The error thrown when the check command cannot be executed. Kept as one
// message so both runners report the misconfiguration identically.
export function checkCommandUnrunnable(command: string, output: string): Error {
  return new Error(
    `the repository check command (\`${command}\`) could not be run — ` +
      `check that it is installed and correctly configured: ${output.slice(-300)}`,
  );
}

// The note a run attaches to its pull request (or native change request)
// when the check command already failed on the base branch and therefore did
// not gate the change: what was skipped, why, and the tail of the baseline
// run so the repo owner can fix the command (or the base) for future runs.
export interface CheckBaselineNote {
  markdown: string; // GitHub PR body (collapsible)
  plain: string; // native change-request summary
}

export function checkBaselineNote(
  command: string,
  base: string,
  output: string,
): CheckBaselineNote {
  const tail = output.trim().slice(-1_200);
  const why =
    `\`${command}\` already fails in a clean checkout of \`${base}\`, so this change ` +
    'could not be gated on it — CI is the arbiter here. Fix the check command ' +
    '(or the base branch) so future runs are checked.';
  return {
    markdown:
      `<details><summary>Check command not applied: <code>${command}</code> fails on ` +
      `<code>${base}</code></summary>\n\n${why}\n\nLast lines of that run:\n\n` +
      `\`\`\`\n${tail}\n\`\`\`\n\n</details>`,
    plain: `**Check command not applied.** ${why}\n\n\`\`\`\n${tail}\n\`\`\``,
  };
}
