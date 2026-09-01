import { describe, expect, it } from 'vite-plus/test';
import type { ExecOptions, ExecResult } from '@cloudflare/sandbox';
import { type CheckSandbox, checkCommandUnrunnable, runCheckCommand } from './check-command.ts';

// Minimal fake sandbox: records the exec invocation and returns a canned
// result, enough to exercise runCheckCommand without a real container. Only
// the fields runCheckCommand reads need real values.
function fakeSandbox(result: Pick<ExecResult, 'success' | 'exitCode' | 'stdout' | 'stderr'>) {
  const calls: { command: string; options?: ExecOptions }[] = [];
  const sandbox: CheckSandbox = {
    exec: async (command, options) => {
      calls.push({ command, options });
      return { ...result, command, duration: 0, timestamp: '1970-01-01T00:00:00Z' };
    },
  };
  return { sandbox, calls };
}

const scrub = (s: string) => s;
const TIMEOUT = 60_000;

describe('runCheckCommand', () => {
  it('prepends the checkout bin dir to PATH so bare binaries resolve', async () => {
    const { sandbox, calls } = fakeSandbox({
      success: true,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });

    const res = await runCheckCommand(sandbox, '/workspace/repo', 'vp check', scrub, TIMEOUT);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(
      'export PATH="/workspace/repo/node_modules/.bin:$PATH"; vp check',
    );
    expect(res).toMatchObject({ ok: true, notExecutable: false });
  });

  it('treats a running check that reports failures as a real test failure', async () => {
    const { sandbox } = fakeSandbox({
      success: false,
      exitCode: 1,
      stdout: '2 tests failed',
      stderr: '',
    });

    const res = await runCheckCommand(sandbox, '/workspace/repo', 'vp test', scrub, TIMEOUT);

    expect(res).toMatchObject({ ok: false, notExecutable: false });
  });

  it('flags a missing binary (exit 127 + "command not found") as not executable', async () => {
    const { sandbox } = fakeSandbox({
      success: false,
      exitCode: 127,
      stdout: '',
      stderr: 'bash: line 1: vp: command not found',
    });

    const res = await runCheckCommand(sandbox, '/workspace/repo', 'vp check', scrub, TIMEOUT);

    expect(res.notExecutable).toBe(true);
  });

  it('does not mistake a test that merely exits 127 for a missing binary', async () => {
    const { sandbox } = fakeSandbox({
      success: false,
      exitCode: 127,
      stdout: '127 assertions failed',
      stderr: '',
    });

    const res = await runCheckCommand(sandbox, '/workspace/repo', 'vp test', scrub, TIMEOUT);

    expect(res.notExecutable).toBe(false);
  });
});

describe('checkCommandUnrunnable', () => {
  it('names the command and includes the tail of the output', () => {
    const err = checkCommandUnrunnable('vp check', 'vp: command not found');
    expect(err.message).toContain('`vp check`');
    expect(err.message).toContain('command not found');
  });
});
