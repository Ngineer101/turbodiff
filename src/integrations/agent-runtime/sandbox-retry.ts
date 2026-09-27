import { Effect, Either, Schedule } from 'effect';
import { isBoolean, isJsonObject, isString } from '../../shared/json.ts';

export type SandboxRetryDisposition = 'local' | 'workflow' | 'none';

// Sandbox SDK failures may be structured values rather than Error instances.
// Keep the original value intact so both retry boundaries can inspect code/context.
class SandboxOperationFailure<Failure> {
  readonly _tag = 'SandboxOperationFailure';

  constructor(readonly failure: Failure) {}
}

const localSandboxRetrySchedule = Schedule.exponential('1 second').pipe(Schedule.jittered);

function sandboxErrorCode<Failure>(failure: Failure): string | null {
  if (!isJsonObject(failure)) return null;
  return isString(failure.code) ? failure.code : null;
}

function operationInterruptedRetryable<Failure>(failure: Failure): boolean {
  if (!isJsonObject(failure) || !isJsonObject(failure.context)) return false;
  const { reason, retryable } = failure.context;
  return reason === 'runtime_replaced' || (isBoolean(retryable) && retryable);
}

/**
 * Classify retryable sandbox failures by the boundary that can make progress.
 * A superseded Durable Object isolate must return to Workflows; retrying it in
 * the same invocation keeps talking to the obsolete runtime.
 */
export function sandboxRetryDisposition<Failure>(failure: Failure): SandboxRetryDisposition {
  const message = failure instanceof Error ? failure.message : '';
  if (
    /interrupted while the platform was updating the sandbox runtime/i.test(message) ||
    /reset because its code was updated|this script has been upgraded/i.test(message)
  ) {
    return 'workflow';
  }

  const code = sandboxErrorCode(failure);
  if (code === 'OPERATION_INTERRUPTED') {
    return operationInterruptedRetryable(failure) ? 'workflow' : 'none';
  }
  if (code === 'CONTAINER_UNAVAILABLE' || code === 'RPC_TRANSPORT_ERROR') return 'local';
  if (/Container is starting\. Please retry in a moment\./i.test(message)) return 'local';
  if (/HTTP error! status: 5\d\d/i.test(message)) return 'local';
  if (/network connection lost/i.test(message)) return 'local';
  if (
    /internal error while starting up durable object storage caused object to be reset/i.test(
      message,
    )
  ) {
    return 'local';
  }
  return 'none';
}

export function retrySandboxOperationEffect<Value>(
  operation: () => Promise<Value>,
): Effect.Effect<Value, SandboxOperationFailure<unknown>> {
  return Effect.tryPromise({
    try: operation,
    catch: (failure) => new SandboxOperationFailure(failure),
  }).pipe(
    Effect.retry({
      times: 3,
      schedule: localSandboxRetrySchedule,
      while: (failure) => sandboxRetryDisposition(failure.failure) === 'local',
    }),
  );
}

/** Retry only operations that are safe to repeat in the current sandbox. */
export async function retrySandboxOperation<Value>(
  operation: () => Promise<Value>,
): Promise<Value> {
  const outcome = await Effect.runPromise(Effect.either(retrySandboxOperationEffect(operation)));
  if (Either.isLeft(outcome)) throw outcome.left.failure;
  return outcome.right;
}
