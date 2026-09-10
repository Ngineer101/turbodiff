import type { ExecOptions, ExecResult, Process, ProcessOptions } from '@cloudflare/sandbox';

// One external boundary: the sandbox process API. Keeping command supervision
// independent of Workers lets us exercise it with actual Linux subprocesses.
export interface ManagedCommandSandbox {
  startProcess(
    command: string,
    options: ProcessOptions,
  ): Promise<Pick<Process, 'waitForExit' | 'kill' | 'getLogs'>>;
}

export async function runManagedCommand(
  sandbox: ManagedCommandSandbox,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeout;
  if (!timeoutMs || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('managed commands require a positive timeout');
  }
  const started = Date.now();
  // exec makes the tracked PID the supervisor, not an intermediate shell.
  // GNU timeout supervises the whole process group inside the Linux container,
  // even if the Worker disappears. SDK exec/wait timeouts alone do not kill it.
  // The command is trusted harness code; shell quoting also preserves embedded
  // quotes and leaves environment-variable expansion to the inner shell.
  const quoted = `'${command.replace(/'/g, `'"'"'`)}'`;
  const process = await sandbox.startProcess(
    `exec timeout --signal=TERM --kill-after=10s ${timeoutMs / 1000}s sh -c ${quoted}`,
    { cwd: options.cwd, env: options.env, autoCleanup: false },
  );
  let exitCode: number;
  let failure = '';
  try {
    // Let the container enforce the deadline, then collect the actual exit and
    // buffered output. The extra allowance covers TERM/KILL and transport lag.
    ({ exitCode } = await process.waitForExit(timeoutMs + 30_000));
  } catch (error) {
    failure = `Agent process monitoring failed: ${error instanceof Error ? error.message : String(error)}`;
    // Never return a failed run while knowingly leaving its agent running.
    // TERM is forwarded by GNU timeout to its child process group.
    await process.kill('SIGTERM');
    try {
      await process.waitForExit(15_000);
    } catch {
      await process.kill('SIGKILL');
      await process.waitForExit(5_000);
    }
    exitCode = 1;
  }
  const logs = await process.getLogs();
  if ((exitCode === 124 || exitCode === 137) && Date.now() - started >= timeoutMs) {
    failure = `Agent exceeded the ${timeoutMs / 60_000}-minute execution limit and was stopped.`;
  }
  return {
    ...logs,
    stderr: [failure, logs.stderr].filter(Boolean).join('\n'),
    success: exitCode === 0,
    exitCode,
    command,
    duration: Date.now() - started,
    timestamp: new Date(started).toISOString(),
  };
}
