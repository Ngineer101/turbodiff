import { Effect, Fiber, TestClock, TestContext } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  retrySandboxOperation,
  retrySandboxOperationEffect,
  sandboxRetryDisposition,
} from '../../../../src/integrations/agent-runtime/sandbox-retry.ts';

describe('sandbox retry policy', () => {
  it('classifies structured and legacy readiness failures for local retry', () => {
    const structured = {
      code: 'CONTAINER_UNAVAILABLE',
      message: 'Container is starting. Please retry in a moment.',
      context: { reason: 'container_starting', retryable: true, retryAfterMs: 3_000 },
      httpStatus: 503,
      timestamp: new Date().toISOString(),
    };

    expect(sandboxRetryDisposition(structured)).toBe('local');
    expect(
      sandboxRetryDisposition(new Error('Container is starting. Please retry in a moment.')),
    ).toBe('local');
    expect(sandboxRetryDisposition(new Error('HTTP error! status: 503'))).toBe('local');
  });

  it('returns deployment interruptions to the durable Workflow boundary', () => {
    expect(
      sandboxRetryDisposition(
        new Error(
          'Sandbox operation sandbox.readFile was interrupted while the platform was updating the sandbox runtime',
        ),
      ),
    ).toBe('workflow');
    expect(
      sandboxRetryDisposition({
        code: 'OPERATION_INTERRUPTED',
        context: { reason: 'runtime_replaced', retryable: false },
      }),
    ).toBe('workflow');
    expect(
      sandboxRetryDisposition({
        code: 'OPERATION_INTERRUPTED',
        context: { reason: 'sandbox_lifetime_changed', retryable: false },
      }),
    ).toBe('none');
    expect(sandboxRetryDisposition(new Error('planner output is invalid'))).toBe('none');
  });

  it('uses the Effect schedule to recover from short-lived container startup failures', async () => {
    let attempts = 0;
    const operation = () => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error('Container is starting. Please retry in a moment.'))
        : Promise.resolve('ready');
    };
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(retrySandboxOperationEffect(operation));
      yield* TestClock.adjust('20 seconds');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext));

    await expect(Effect.runPromise(program)).resolves.toBe('ready');
    expect(attempts).toBe(3);
  });

  it('does not retry a deployment interruption in the superseded invocation', async () => {
    let attempts = 0;
    const failure = new Error(
      'Sandbox operation sandbox.readFile was interrupted while the platform was updating the sandbox runtime',
    );

    await expect(
      retrySandboxOperation(() => {
        attempts += 1;
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});
