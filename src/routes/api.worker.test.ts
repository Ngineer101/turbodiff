/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AuthedUser } from '../lib/auth.ts';
import type { ApiBoard } from '../shared/api-types.ts';
import { isJsonObject, isString, parseJson } from '../shared/json.ts';
import { createApiRoutes, type ApiRouteDependencies } from './api.ts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
type Authenticate = NonNullable<ApiRouteDependencies['authenticate']>;
// SAFETY: vitest.worker.config.ts provisions the TEST_MIGRATIONS binding for
// this pool on top of the generated Cloudflare.Env.
const testEnv = env as TestEnv;

const acmeUser: AuthedUser = {
  session: { userId: 3001, login: 'octocat', ghToken: 'test-user-token' },
  installationIds: [1001],
};

function apiApp(dependencies: ApiRouteDependencies = {}) {
  const app = new Hono();
  app.route('/api', createApiRoutes(dependencies));
  return app;
}

function authenticatedApi(canPush = async () => true) {
  return apiApp({
    authenticate: async () => acmeUser,
    canPushToRepo: canPush,
  });
}

async function seedTenants(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization'),
		        (2002, 'other', 2002, 'Organization')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api'),
		        (202, 2002, 'other', 'private')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO todos (id, installation_id, title, created_by_login, created_by_id)
		 VALUES (401, 1001, 'Acme backlog', 'octocat', 3001),
		        (402, 2002, 'Other backlog', 'someone-else', 4001)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO todo_repositories (todo_id, repository_id, position)
		 VALUES (401, 101, 0), (402, 202, 0)`,
    ),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  const tables = [
    'push_subscriptions',
    'todo_repositories',
    'todos',
    'repo_agents',
    'agents',
    'repositories',
    'installations',
    'session',
    'account',
    'user',
  ];
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM "${table}"`)));
  await seedTenants();
});

describe('API authentication and CSRF', () => {
  it('rejects a request without a durable session', async () => {
    const response = await apiApp().request('https://turbodiff.test/api/me');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a cross-origin mutation before invoking authentication', async () => {
    const authenticate = vi.fn<Authenticate>(async () => acmeUser);
    const response = await apiApp({ authenticate }).request('https://turbodiff.test/api/todos', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({ title: 'Forged request' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'cross-origin request rejected' });
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe('authenticated tenant isolation', () => {
  it('returns only installations, repositories, and todos owned by the caller', async () => {
    const response = await authenticatedApi().request('https://turbodiff.test/api/board');
    expect(response.status).toBe(200);
    // SAFETY: /api/board's 200 response body is the ApiBoard contract this test
    // exercises; the assertions below fail on any drift in that shape.
    const board = (await response.json()) as ApiBoard;

    expect(board.installations).toEqual([{ id: 1001, account_login: 'acme' }]);
    expect(board.repos.map((repo) => repo.id)).toEqual([101]);
    expect(board.todos.map((todo) => todo.id)).toEqual([401]);
  });

  it('rejects foreign todo inputs and attributes an accepted todo to the session user', async () => {
    const app = authenticatedApi();
    const foreignInstallation = await app.request('https://turbodiff.test/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installation_id: 2002, title: 'Cross-tenant todo' }),
    });
    expect(foreignInstallation.status).toBe(404);

    const foreignRepo = await app.request('https://turbodiff.test/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installation_id: 1001,
        title: 'Cross-tenant repo',
        repository_ids: [202],
      }),
    });
    expect(foreignRepo.status).toBe(400);

    const accepted = await app.request('https://turbodiff.test/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installation_id: 1001,
        title: 'Owned todo',
        repository_ids: [101],
      }),
    });
    expect(accepted.status).toBe(200);
    const created = await testEnv.DB.prepare(
      `SELECT installation_id, created_by_login, created_by_id
		 FROM todos WHERE title = 'Owned todo'`,
    ).first<{ installation_id: number; created_by_login: string; created_by_id: number }>();
    expect(created).toEqual({
      installation_id: 1001,
      created_by_login: 'octocat',
      created_by_id: 3001,
    });
  });

  it('conceals and preserves a foreign todo during deletion', async () => {
    const app = authenticatedApi();
    const foreign = await app.request('https://turbodiff.test/api/todos/402', {
      method: 'DELETE',
    });
    expect(foreign.status).toBe(404);
    expect(
      await testEnv.DB.prepare('SELECT id FROM todos WHERE id = 402').first<{ id: number }>(),
    ).toEqual({ id: 402 });

    const owned = await app.request('https://turbodiff.test/api/todos/401', {
      method: 'DELETE',
    });
    expect(owned.status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT id FROM todos WHERE id = 401').first()).toBeNull();
  });

  it('checks ownership before push permission and requires both to mutate repo posture', async () => {
    const canPush = vi.fn(async () => false);
    const denied = await authenticatedApi(canPush).request('https://turbodiff.test/api/repos/101', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(denied.status).toBe(403);
    expect(canPush).toHaveBeenCalledWith(acmeUser, 'acme', 'api');

    canPush.mockClear();
    const foreign = await authenticatedApi(canPush).request(
      'https://turbodiff.test/api/repos/202',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(foreign.status).toBe(404);
    expect(canPush).not.toHaveBeenCalled();

    const allowed = await authenticatedApi(async () => true).request(
      'https://turbodiff.test/api/repos/101',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(allowed.status).toBe(200);
    const repo = await testEnv.DB.prepare('SELECT enabled FROM repositories WHERE id = 101').first<{
      enabled: number;
    }>();
    expect(repo?.enabled).toBe(0);
  });
});

describe('push subscriptions', () => {
  it('includes a VAPID public key string on /me', async () => {
    const response = await authenticatedApi().request('https://turbodiff.test/api/me');
    expect(response.status).toBe(200);
    const me = parseJson(await response.text());
    expect(isJsonObject(me) && isString(me.vapid_public_key)).toBe(true);
  });

  it('upserts a subscription row for the signed-in user', async () => {
    const response = await authenticatedApi().request('https://turbodiff.test/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const row = await testEnv.DB.prepare(
      'SELECT user_github_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?1',
    )
      .bind('https://push.example/abc')
      .first<{ user_github_id: number; p256dh: string; auth: string }>();
    expect(row).toEqual({ user_github_id: 3001, p256dh: 'p256dh-key', auth: 'auth-key' });
  });

  it('rejects an incomplete subscription body', async () => {
    const response = await authenticatedApi().request('https://turbodiff.test/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/abc', keys: { p256dh: '' } }),
    });
    expect(response.status).toBe(400);
  });

  it('deletes only the calling user’s subscription by endpoint', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO push_subscriptions (user_github_id, endpoint, p256dh, auth)
			 VALUES (3001, 'https://push.example/mine', 'p', 'a'),
			        (4001, 'https://push.example/theirs', 'p', 'a')`,
    ).run();

    const foreign = await authenticatedApi().request(
      'https://turbodiff.test/api/push/unsubscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://push.example/theirs' }),
      },
    );
    expect(foreign.status).toBe(200);
    expect(
      await testEnv.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?1')
        .bind('https://push.example/theirs')
        .first(),
    ).not.toBeNull();

    const owned = await authenticatedApi().request('https://turbodiff.test/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/mine' }),
    });
    expect(owned.status).toBe(200);
    expect(
      await testEnv.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?1')
        .bind('https://push.example/mine')
        .first(),
    ).toBeNull();
  });
});

// The success path (a real audio file transcribed by the AI binding) isn't
// covered here: wrangler.test.jsonc has no "ai" binding, matching every
// other worker test's D1-only fixture — exercising real Workers AI needs
// account credentials this offline suite doesn't have.
describe('dictation transcription', () => {
  it('rejects a request without a durable session', async () => {
    const response = await apiApp().request('https://turbodiff.test/api/transcribe', {
      method: 'POST',
      body: new FormData(),
    });
    expect(response.status).toBe(401);
  });

  it('blocks a signed-in user with zero installations', async () => {
    const app = apiApp({
      authenticate: async () => ({ ...acmeUser, installationIds: [] }),
    });
    const response = await app.request('https://turbodiff.test/api/transcribe', {
      method: 'POST',
      body: new FormData(),
    });
    expect(response.status).toBe(403);
    const data = (await response.json()) as { error?: string };
    expect(typeof data.error).toBe('string');
  });

  it('requires a multipart "audio" file field', async () => {
    const fd = new FormData();
    fd.append('audio', 'not-a-file');
    const response = await authenticatedApi().request('https://turbodiff.test/api/transcribe', {
      method: 'POST',
      body: fd,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a recording larger than the configured size cap', async () => {
    const oversized = new File([new Uint8Array(15 * 1024 * 1024 + 1)], 'clip.webm', {
      type: 'audio/webm',
    });
    const fd = new FormData();
    fd.append('audio', oversized);
    const response = await authenticatedApi().request('https://turbodiff.test/api/transcribe', {
      method: 'POST',
      body: fd,
    });
    expect(response.status).toBe(400);
  });
});
