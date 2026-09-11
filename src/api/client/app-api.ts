import { FetchHttpClient, HttpApiClient } from '@effect/platform';
import { Effect } from 'effect';
import { AppApi } from '../contract/api.ts';

/**
 * Contract-derived client for the signed-in API. Cookies are sent by the
 * browser fetch implementation for same-origin requests; callers keep typed
 * successes and typed problem failures in the Effect error channel.
 */
export const makeAppApiClient = (baseUrl?: string | URL) =>
  HttpApiClient.make(AppApi, { baseUrl }).pipe(Effect.provide(FetchHttpClient.layer));

export type AppApiClient = Effect.Effect.Success<ReturnType<typeof makeAppApiClient>>;
