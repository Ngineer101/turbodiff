/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { env } from 'cloudflare:workers';
// Transport-level coverage for email sign-up.
import { applyD1Migrations } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import type { JsonObject } from '../shared/json.ts';
import { handleEmailSignUp } from './auth-email.ts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
// SAFETY: vitest.worker.config.ts provisions the TEST_MIGRATIONS binding for
// this pool on top of the generated Cloudflare.Env.
const testEnv = env as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

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

    const user = await testEnv.DB.prepare('SELECT name, login, githubId FROM user WHERE email = ?')
      .bind('pat@example.test')
      .first<{ name: string; login: string | null; githubId: number | null }>();
    expect(user).toEqual({ name: 'Pat', login: null, githubId: null });
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

    const user = await testEnv.DB.prepare('SELECT login, githubId FROM user WHERE email = ?')
      .bind('mallory@example.test')
      .first<{ login: string | null; githubId: number | null }>();
    expect(user).toEqual({ login: null, githubId: null });
  });
});
