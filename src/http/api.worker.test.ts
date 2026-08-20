/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { env } from 'cloudflare:workers';
// Transport-level coverage for the signed-in JSON API.
import { applyD1Migrations } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AuthedUser } from '../services/auth.ts';
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
  githubConnected: true,
  name: 'octocat',
};

function apiApp(dependencies: ApiRouteDependencies = {}) {
  const app = new Hono();
  app.route('/api', createApiRoutes(dependencies));
  return app;
}

// orgAdmin defaults to true so callers with no member row elevate-and-allow
// through the lazy org heal (installation 1001 is Organization-type with no
// org row, so every capability gate now runs through it) — with the u1 user
// row seeded in seedTenants the caller is bootstrapped to owner, preserving
// the pre-heal "allowed" outcome for the unrelated suites.
function authenticatedApi(canPush = async () => true, orgAdmin = async () => true) {
  return apiApp({
    authenticate: async () => acmeUser,
    canPushToRepo: canPush,
    orgAdmin,
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
    // A better-auth user row for acmeUser — session.userId (3001) is the
    // GitHub id memberRole and the owner bootstrap look members up by.
    // Seeded globally so the lazy org heal's elevate-to-owner path (orgAdmin
    // defaults to true in authenticatedApi) actually records the member row,
    // keeping capability-gated suites that never seed org rows on their
    // pre-heal "allowed" outcome.
    testEnv.DB.prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", login, "githubId")
		 VALUES ('u1', 'octocat', 'octocat@example.test', 1, '2026-01-01T00:00:00.000Z',
		         '2026-01-01T00:00:00.000Z', 'octocat', 3001)`,
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
    'member',
    'invitation',
    'organization',
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

describe('organization member management', () => {
  // The better-auth user row for acmeUser (u1, githubId 3001) is seeded
  // globally in seedTenants — this seeds only the org row (and optionally an
  // explicit member row) on top of it.
  async function seedOrg(role: 'owner' | 'admin' | 'member' | null): Promise<void> {
    await testEnv.DB.prepare(
      `INSERT INTO "organization" (id, name, slug, "installationId", "createdAt")
				 VALUES ('org1', 'acme', 'acme', 1001, '2026-01-01T00:00:00.000Z')`,
    ).run();
    if (role) {
      await testEnv.DB.prepare(
        `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
				 VALUES ('m1', 'org1', 'u1', ?1, '2026-01-01T00:00:00.000Z')`,
      )
        .bind(role)
        .run();
    }
  }

  it('is readable by any installation member, including one with no explicit member row', async () => {
    await seedOrg(null);
    // orgAdmin false: a plain GitHub member stays an implicit 'member'
    // rather than being bootstrapped to owner.
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      org_id: 'org1',
      my_role: 'member',
      members: [],
      invitations: [],
    });
  });

  it('404s for a personal installation and never provisions an org row for it', async () => {
    await testEnv.DB.prepare(
      `UPDATE installations SET account_type = 'User' WHERE id = 1001`,
    ).run();
    const response = await authenticatedApi().request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(404);
    const orgRow = await testEnv.DB.prepare(
      'SELECT id FROM "organization" WHERE "installationId" = 1001',
    ).first();
    expect(orgRow).toBeNull();
  });

  it('rejects invite, remove, and role-change requests from a member-role caller', async () => {
    await seedOrg('member');
    const app = authenticatedApi();

    const invite = await app.request('https://turbodiff.test/api/organizations/1001/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.test', role: 'member' }),
    });
    expect(invite.status).toBe(403);

    const remove = await app.request('https://turbodiff.test/api/organizations/1001/members/m1', {
      method: 'DELETE',
    });
    expect(remove.status).toBe(403);

    const roleChange = await app.request(
      'https://turbodiff.test/api/organizations/1001/members/m1',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
    );
    expect(roleChange.status).toBe(403);
  });

  it('gates repo/agent configuration mutations on settings capability, independent of GitHub push permission', async () => {
    await seedOrg('member');
    const app = authenticatedApi(async () => true); // push permission granted; org role should still block

    const repoDenied = await app.request('https://turbodiff.test/api/repos/101', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(repoDenied.status).toBe(403);

    const agentDenied = await app.request('https://turbodiff.test/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'blocked', name: 'Blocked', instructions: 'do nothing' }),
    });
    expect(agentDenied.status).toBe(403);
  });

  it('lets an owner mutate repo posture once both settings capability and push permission are present', async () => {
    await seedOrg('owner');
    const response = await authenticatedApi(async () => true).request(
      'https://turbodiff.test/api/repos/101',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(response.status).toBe(200);
  });

  it('never gates a personal installation on org capability', async () => {
    // A personal (User-type) installation has no organization row and the
    // heal must not create one — requireCapability returns null (allowed)
    // rather than 403, leaving push permission as the only gate.
    await testEnv.DB.prepare(
      `UPDATE installations SET account_type = 'User' WHERE id = 1001`,
    ).run();
    const response = await authenticatedApi(
      async () => true,
      async () => false,
    ).request('https://turbodiff.test/api/repos/101', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(response.status).toBe(200);
  });

  it('heals a missing organization row on first visit, idempotently', async () => {
    // No seedOrg() — installation 1001 is Organization-type with no org row,
    // the shape left behind by a missed provisioning webhook.
    const app = authenticatedApi(undefined, async () => false);
    const first = await app.request('https://turbodiff.test/api/organizations/1001/members');
    expect(first.status).toBe(200);
    const healed = await testEnv.DB.prepare(
      'SELECT id FROM "organization" WHERE "installationId" = 1001',
    ).first<{ id: string }>();
    expect(healed).not.toBeNull();
    expect(await first.json()).toMatchObject({ org_id: healed?.id, my_role: 'member' });

    const second = await app.request('https://turbodiff.test/api/organizations/1001/members');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ org_id: healed?.id });
    const count = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM "organization" WHERE "installationId" = 1001',
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('bootstraps a GitHub org admin with no member row as the first owner', async () => {
    const response = await authenticatedApi(undefined, async () => true).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'owner' });
    const member = await testEnv.DB.prepare(
      `SELECT "member".role AS role FROM "member"
			 JOIN "organization" ON "organization".id = "member"."organizationId"
			 WHERE "organization"."installationId" = 1001 AND "member"."userId" = 'u1'`,
    ).first<{ role: string }>();
    expect(member?.role).toBe('owner');
  });

  it('never re-elevates a caller who already has an explicit member row', async () => {
    await seedOrg('member');
    const response = await authenticatedApi(undefined, async () => true).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'member' });
    const row = await testEnv.DB.prepare(`SELECT role FROM "member" WHERE id = 'm1'`).first<{
      role: string;
    }>();
    expect(row?.role).toBe('member');
  });

  it('tightens settings capability after the heal, keeping GitHub org admins in', async () => {
    // The org row is healed by capabilityDenied itself (not the members
    // page): an implicit member without GitHub org-admin status loses the
    // settings capability it incidentally had while the row was missing…
    const denied = await authenticatedApi(
      async () => true,
      async () => false,
    ).request('https://turbodiff.test/api/repos/101', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(denied.status).toBe(403);

    // …while a GitHub org admin is bootstrapped to owner via the same
    // capability path and keeps access.
    const allowed = await authenticatedApi(
      async () => true,
      async () => true,
    ).request('https://turbodiff.test/api/repos/101', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(allowed.status).toBe(200);
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
    const data = parseJson(await response.text());
    expect(isJsonObject(data) && isString(data.error)).toBe(true);
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
