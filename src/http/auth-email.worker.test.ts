/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { testDatabase } from '../test/database-fixture.ts';
// Transport-level coverage for email sign-up.
import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import type { JsonObject } from '../shared/json.ts';
import { requireUser } from '../services/auth.ts';
import { handleEmailSignUp } from './auth-email.ts';

async function signUp(body: JsonObject): Promise<Response> {
  const app = new Hono();
  app.post('/api/auth/sign-up/email', handleEmailSignUp);
  return await app.request('https://turbodiff.test/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('email/password sign-up', () => {
  it('creates a password user with a session and no GitHub identity', async () => {
    const response = await signUp({
      name: 'Pat',
      email: 'pat@example.test',
      password: 'a-long-password',
    });
    expect(response.status).toBe(200);
    // autoSignIn: the sign-up response carries the session cookie.
    expect(response.headers.get('set-cookie')).toContain('turbodiff.session_token');

    const user = await testDatabase()
      .prepare('SELECT name, login, "githubId" FROM "user" WHERE email = ?1')
      .bind('pat@example.test')
      .first<{ name: string; login: string | null; githubId: number | null }>();
    expect(user).toEqual({ name: 'Pat', login: null, githubId: null });

    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    const sessionUser = await requireUser(
      new Request('https://turbodiff.test/api/me', {
        headers: { cookie: cookie ?? '' },
      }),
    );
    expect(sessionUser).toMatchObject({
      githubConnected: false,
      githubStatus: 'not_connected',
      installationIds: [],
    });
  });

  it('drops forged GitHub identity fields from the sign-up body', async () => {
    // login/githubId are declared without input:false (the OAuth profile
    // mapping needs them — see better-auth.ts), so better-auth itself would
    // persist these; the allowlist rebuild must be what stops them.
    const response = await signUp({
      name: 'Mallory',
      email: 'mallory@example.test',
      password: 'a-long-password',
      login: 'victim',
      githubId: 9999,
    });
    expect(response.status).toBe(200);

    const user = await testDatabase()
      .prepare('SELECT login, "githubId" FROM "user" WHERE email = ?1')
      .bind('mallory@example.test')
      .first<{ login: string | null; githubId: number | null }>();
    expect(user).toEqual({ login: null, githubId: null });
  });

  it('keeps a migrated session recoverable when its GitHub account row is missing', async () => {
    const response = await signUp({
      name: 'Migrated User',
      email: 'migrated@example.test',
      password: 'a-long-password',
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toContain('turbodiff.session_token');

    // This is the migration failure shape: the durable user/session made it
    // to PostgreSQL, including the GitHub identity fields, but the provider
    // account/token row did not.
    await testDatabase()
      .prepare('UPDATE "user" SET login = ?1, "githubId" = ?2 WHERE email = ?3')
      .bind('migrated-user', 987654, 'migrated@example.test')
      .run();

    const user = await requireUser(
      new Request('https://turbodiff.test/api/me', {
        headers: { cookie: cookie ?? '' },
      }),
    );

    expect(user).toMatchObject({
      githubConnected: true,
      githubStatus: 'reauthorization_required',
      installationIds: [],
      session: { userId: 987654, login: 'migrated-user' },
    });
  });
});
