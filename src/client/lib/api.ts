import { Cause, Effect, Exit, Option } from 'effect';
import { makeAppApiClient, type AppApiClient } from '../../api/client/app-api.ts';
import { isJsonObject, isNumber, isString } from '../../shared/json.ts';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let redirectingToLogin = false;
const client = Effect.runPromise(makeAppApiClient());

function restartAuthentication(): void {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  // Never hydrate a new/renewed session with another user's account-scoped
  // payloads. Sidebar preferences use separate keys and remain intact.
  window.localStorage.removeItem('turbodiff.queryCache');
  window.location.replace('/auth/login?expired=1');
}

function apiFailure(cause: unknown): ApiError {
  const value = isJsonObject(cause) ? cause : {};
  const status = isNumber(value.status) ? value.status : 500;
  const message = isString(value.detail)
    ? value.detail
    : isString(value.message)
      ? value.message
      : `request failed (${status})`;
  if (status === 401) restartAuthentication();
  return new ApiError(message, status);
}

export async function runApi<Value, Failure>(
  operation: (client: AppApiClient) => Effect.Effect<Value, Failure>,
): Promise<Value> {
  const exit = await Effect.runPromiseExit(operation(await client));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  throw apiFailure(Option.isSome(failure) ? failure.value : Cause.squash(exit.cause));
}

export async function protocolJson<Value>(path: string, init?: RequestInit): Promise<Value> {
  const response = await fetch(path, init);
  if (response.status === 401) restartAuthentication();
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw apiFailure(isJsonObject(body) ? body : { status: response.status });
  // SAFETY: non-JSON protocols validate their own boundaries; this helper is only used by
  // same-origin JSON protocol routes whose response type is declared at the call site.
  return body as Value;
}
