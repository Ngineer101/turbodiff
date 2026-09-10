import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runManagedCommand } from '../src/ai/runtime/managed-command.ts';

// Run on Linux (the production sandbox OS). Only the Sandbox transport is
// replaced with spawn; shell quoting, GNU timeout, signals and output are real.
// No model API, Cloudflare account or production credentials are used.
function localSandbox({ interruptMonitor = false } = {}) {
  return {
    async startProcess(command, options) {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 137 }));
      });
      return {
        async waitForExit(timeout) {
          if (interruptMonitor) {
            interruptMonitor = false;
            // Wait until the child has started so cancellation tests a live process.
            while (!stdout.includes('started'))
              await new Promise((resolve) => setTimeout(resolve, 10));
            throw new Error('simulated transport disconnect');
          }
          let timer;
          try {
            return await Promise.race([
              done,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('waiter expired')), timeout);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        },
        async kill(signal) {
          child.kill(signal);
        },
        async getLogs() {
          return { stdout, stderr };
        },
      };
    },
  };
}

await test('collects delayed successful output and preserves command quoting and model environment', async () => {
  const result = await runManagedCommand(
    localSandbox(),
    `printf '%s\\n' "$MODEL"; sleep 0.2; printf 'plan complete\\n'; printf 'diagnostic\\n' >&2`,
    { timeout: 2_000, env: { MODEL: 'provider/selected-model' } },
  );
  assert.equal(result.success, true);
  assert.equal(result.stdout, 'provider/selected-model\nplan complete\n');
  assert.equal(result.stderr, 'diagnostic\n');
});

await test('deadline stops the child process group and returns partial output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turbodiff-deadline-'));
  try {
    const result = await runManagedCommand(
      localSandbox(),
      `printf 'started\\n'; (sleep 0.8; touch "$MARKER") & wait`,
      { timeout: 150, env: { MARKER: path.join(dir, 'orphan') } },
    );
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 124);
    assert.equal(result.stdout, 'started\n');
    assert.match(result.stderr, /execution limit and was stopped/);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(readFile(path.join(dir, 'orphan')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('monitoring failure stops real descendants before returning the partial log', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turbodiff-disconnect-'));
  try {
    const result = await runManagedCommand(
      localSandbox({ interruptMonitor: true }),
      `printf 'started\\n'; (sleep 0.8; touch "$MARKER") & wait`,
      { timeout: 5_000, env: { MARKER: path.join(dir, 'orphan') } },
    );
    assert.equal(result.success, false);
    assert.equal(result.stdout, 'started\n');
    assert.match(result.stderr, /simulated transport disconnect/);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(readFile(path.join(dir, 'orphan')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
