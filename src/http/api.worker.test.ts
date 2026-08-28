/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { database } from '../data/postgres.ts';
// Transport-level coverage for the signed-in JSON API.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AuthedUser } from '../services/auth.ts';
import type { ApiBoard, ApiUsage } from '../shared/api-types.ts';
import { isJsonObject, isString, parseJson } from '../shared/json.ts';
import { createApiRoutes, type ApiRouteDependencies } from './api.ts';

type Authenticate = NonNullable<ApiRouteDependencies['authenticate']>;

const acmeUser: AuthedUser = {
  session: { authUserId: 'user-3001', userId: 3001, login: 'octocat' },
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
  await database().batch([
    database().prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization'),
		        (2002, 'other', 2002, 'Organization')`,
    ),
    database().prepare(
      `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api'),
		        (202, 2002, 'other', 'private')`,
    ),
    database().prepare(
      `INSERT INTO todos (id, installation_id, title, created_by_login, created_by_id)
		 VALUES (401, 1001, 'Acme backlog', 'octocat', 3001),
		        (402, 2002, 'Other backlog', 'someone-else', 4001)`,
    ),
    database().prepare(
      `INSERT INTO todo_repositories (todo_id, repository_id, position)
		 VALUES (401, 101, 0), (402, 202, 0)`,
    ),
    // A better-auth user row for acmeUser — session.userId (3001) is the
    // GitHub id memberRole and the owner bootstrap look members up by.
    // Seeded globally so the lazy org heal's elevate-to-owner path (orgAdmin
    // defaults to true in authenticatedApi) actually records the member row,
    // keeping capability-gated suites that never seed org rows on their
    // pre-heal "allowed" outcome.
    database().prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", login, "githubId")
		 VALUES ('u1', 'octocat', 'octocat@example.test', true, '2026-01-01T00:00:00.000Z',
		         '2026-01-01T00:00:00.000Z', 'octocat', 3001)`,
    ),
  ]);
}

beforeEach(async () => {
  const tables = [
    'repository_refs',
    'push_subscriptions',
    'chat_messages',
    'todo_repositories',
    'todos',
    'repo_agents',
    'agents',
    'member',
    'invitation',
    'organization',
    'verifications',
    'fix_attempts',
    'automation_runs',
    'automations',
    'features',
    'reviews',
    'repositories',
    'installations',
    'session',
    'account',
    'user',
  ];
  await database().batch(tables.map((table) => database().prepare(`DELETE FROM "${table}"`)));
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
    const created = await database()
      .prepare(
        `SELECT installation_id, created_by_login, created_by_id
		 FROM todos WHERE title = 'Owned todo'`,
      )
      .first<{ installation_id: number; created_by_login: string; created_by_id: number }>();
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
      await database().prepare('SELECT id FROM todos WHERE id = 402').first<{ id: number }>(),
    ).toEqual({ id: 402 });

    const owned = await app.request('https://turbodiff.test/api/todos/401', {
      method: 'DELETE',
    });
    expect(owned.status).toBe(200);
    expect(await database().prepare('SELECT id FROM todos WHERE id = 401').first()).toBeNull();
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
    const repo = await database().prepare('SELECT enabled FROM repositories WHERE id = 101').first<{
      enabled: number;
    }>();
    expect(repo?.enabled).toBe(0);
  });
});

describe('pipeline cost reporting', () => {
  // One row per metered stage in the current UTC month (created_at defaults to
  // CURRENT_TIMESTAMP, which is what dashboardStats and the cost union both
  // compare against), plus a foreign installation's row that neither surface
  // may count.
  async function seedPipelineCosts(): Promise<void> {
    await database().batch([
      database().prepare(
        `INSERT INTO reviews (repository_id, installation_id, pr_number, trigger_event, cost_usd)
			 VALUES (101, 1001, 7, 'opened', 0.1),
			        (202, 2002, 9, 'opened', 9.99)`,
      ),
      database().prepare(
        `INSERT INTO features (id, repository_id, title, spec, cost_usd)
			 VALUES (501, 101, 'Ship it', 'spec', 0.02)`,
      ),
      database().prepare(
        `INSERT INTO fix_attempts (repository_id, pr_number, "trigger", cost_usd)
			 VALUES (101, 7, 'blocking_review', 0.003)`,
      ),
      database().prepare(`INSERT INTO verifications (feature_id, cost_usd) VALUES (501, 0.0004)`),
      database().prepare(
        `INSERT INTO automations (id, repository_id, name, prompt, schedule_kind, next_run_at)
			 VALUES (601, 101, 'Nightly', 'do the thing', 'daily', '2026-01-01T00:00:00Z')`,
      ),
      database().prepare(
        `INSERT INTO automation_runs (automation_id, cost_usd) VALUES (601, 0.00005)`,
      ),
    ]);
  }

  it('reports the same pipeline cost on the board and the usage page', async () => {
    await seedPipelineCosts();
    const app = authenticatedApi();

    const boardResponse = await app.request('https://turbodiff.test/api/board');
    const usageResponse = await app.request('https://turbodiff.test/api/usage');
    expect(boardResponse.status).toBe(200);
    expect(usageResponse.status).toBe(200);
    // SAFETY: /api/board's 200 body is the ApiBoard contract this test
    // exercises; the assertions below fail on any drift in that shape.
    const board = (await boardResponse.json()) as ApiBoard;
    // SAFETY: /api/usage's 200 body is the ApiUsage contract this test
    // exercises; the assertions below fail on any drift in that shape.
    const usage = (await usageResponse.json()) as ApiUsage;

    // SQLite sums doubles in its own order, so never compare these exactly.
    expect(board.stats.month_pipeline_cost_usd).toBeCloseTo(0.12345, 6);
    expect(board.stats.month_pipeline_cost_usd).toBeCloseTo(usage.stats.month_pipeline_cost_usd, 6);

    const currentMonthRow = usage.months.find((m) => m.month === usage.month);
    expect(currentMonthRow?.pipeline_cost_usd).toBeCloseTo(usage.stats.month_pipeline_cost_usd, 6);

    // Still a distinct concept — and the foreign installation's 9.99 is in
    // neither figure.
    expect(usage.stats.month_review_cost_usd).toBeCloseTo(0.1, 6);
  });
});

describe('organization member management', () => {
  // The better-auth user row for acmeUser (u1, githubId 3001) is seeded
  // globally in seedTenants — this seeds only the org row (and optionally an
  // explicit member row) on top of it.
  async function seedOrg(role: 'owner' | 'admin' | 'member' | null): Promise<void> {
    await database()
      .prepare(
        `INSERT INTO "organization" (id, name, slug, "installationId", "createdAt")
				 VALUES ('org1', 'acme', 'acme', 1001, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    if (role) {
      await database()
        .prepare(
          `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
				 VALUES ('m1', 'org1', 'u1', ?1, '2026-01-01T00:00:00.000Z')`,
        )
        .bind(role)
        .run();
    }
  }

  // A second human in org1 — the sole-member owner promotion must not fire
  // when the caller is not the organization's only member row.
  async function seedCoOwner(): Promise<void> {
    await database()
      .prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", login, "githubId")
				 VALUES ('u2', 'hubot', 'hubot@example.test', true, '2026-01-01T00:00:00.000Z',
				         '2026-01-01T00:00:00.000Z', 'hubot', 3002)`,
      )
      .run();
    await database()
      .prepare(
        `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
				 VALUES ('m2', 'org1', 'u2', 'owner', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
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
    await database()
      .prepare(`UPDATE installations SET account_type = 'User' WHERE id = 1001`)
      .run();
    const response = await authenticatedApi().request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(404);
    const orgRow = await database()
      .prepare('SELECT id FROM "organization" WHERE "installationId" = 1001')
      .first();
    expect(orgRow).toBeNull();
  });

  it('rejects invite, remove, and role-change requests from a member-role caller', async () => {
    await seedOrg('member');
    await seedCoOwner();
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
    await seedCoOwner();
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
    await database()
      .prepare(`UPDATE installations SET account_type = 'User' WHERE id = 1001`)
      .run();
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
    const healed = await database()
      .prepare('SELECT id FROM "organization" WHERE "installationId" = 1001')
      .first<{ id: string }>();
    expect(healed).not.toBeNull();
    expect(await first.json()).toMatchObject({ org_id: healed?.id, my_role: 'member' });

    const second = await app.request('https://turbodiff.test/api/organizations/1001/members');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ org_id: healed?.id });
    const count = await database()
      .prepare('SELECT COUNT(*) AS n FROM "organization" WHERE "installationId" = 1001')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('bootstraps a GitHub org admin with no member row as the first owner', async () => {
    const response = await authenticatedApi(undefined, async () => true).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'owner' });
    const member = await database()
      .prepare(
        `SELECT "member".role AS role FROM "member"
			 JOIN "organization" ON "organization".id = "member"."organizationId"
			 WHERE "organization"."installationId" = 1001 AND "member"."userId" = 'u1'`,
      )
      .first<{ role: string }>();
    expect(member?.role).toBe('owner');
  });

  it('promotes the recorded installer of a memberless organization without touching GitHub', async () => {
    // The exact production dead end: the installer signed in only after
    // installing (webhook-time ensureOwnerMember was a no-op), and the
    // GitHub admin check fails closed — orgAdmin false stands in for the
    // App lacking the Organization Members permission.
    await seedOrg(null);
    await database()
      .prepare('UPDATE installations SET installer_github_id = 3001 WHERE id = 1001')
      .run();
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'owner' });
    const member = await database()
      .prepare(`SELECT role FROM "member" WHERE "organizationId" = 'org1' AND "userId" = 'u1'`)
      .first<{ role: string }>();
    expect(member?.role).toBe('owner');
  });

  it('never promotes the installer once the organization has any member row', async () => {
    // An explicit row means the org has working governance — a demoted or
    // removed installer must not climb back in through the bootstrap.
    await seedOrg(null);
    await seedCoOwner();
    await database()
      .prepare('UPDATE installations SET installer_github_id = 3001 WHERE id = 1001')
      .run();
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'member' });
  });

  it('never promotes a caller who is not the recorded installer of a memberless organization', async () => {
    await seedOrg(null);
    await database()
      .prepare('UPDATE installations SET installer_github_id = 9999 WHERE id = 1001')
      .run();
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'member' });
    const count = await database()
      .prepare(`SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = 'org1'`)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('opens the settings capability gate for the recorded installer', async () => {
    // Same shape as the promotion test above, but through a capability-gated
    // mutation — proving the heal runs on the capabilityDenied choke point
    // (the route the production lockout actually 403'd on).
    await seedOrg(null);
    await database()
      .prepare('UPDATE installations SET installer_github_id = 3001 WHERE id = 1001')
      .run();
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

  it('never re-elevates a caller who already has an explicit member row', async () => {
    await seedOrg('member');
    await seedCoOwner();
    const response = await authenticatedApi(undefined, async () => true).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'member' });
    const row = await database().prepare(`SELECT role FROM "member" WHERE id = 'm1'`).first<{
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

  it('promotes the sole member of an organization to owner, persistently', async () => {
    await seedOrg('member');
    // orgAdmin false: the sole-member promotion needs nothing from GitHub.
    const app = authenticatedApi(undefined, async () => false);
    const first = await app.request('https://turbodiff.test/api/organizations/1001/members');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      my_role: 'owner',
      members: [expect.objectContaining({ id: 'm1', role: 'owner' })],
    });
    const row = await database().prepare(`SELECT role FROM "member" WHERE id = 'm1'`).first<{
      role: string;
    }>();
    expect(row?.role).toBe('owner');

    const second = await app.request('https://turbodiff.test/api/organizations/1001/members');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ my_role: 'owner' });
    const count = await database()
      .prepare(`SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = 'org1'`)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('normalizes a sole admin member to owner', async () => {
    await seedOrg('admin');
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'owner' });
    const row = await database().prepare(`SELECT role FROM "member" WHERE id = 'm1'`).first<{
      role: string;
    }>();
    expect(row?.role).toBe('owner');
  });

  it('opens the capability gates for a sole member without touching GitHub', async () => {
    await seedOrg('member');
    // This exact shape returned 403 before the promotion — see the settings
    // capability test above. A 200 here proves the heal runs on the
    // capabilityDenied choke point, not just the members GET.
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

  it("never promotes a caller who is not the organization's sole member row", async () => {
    await seedOrg(null);
    await seedCoOwner();
    // org1's only member row now belongs to u2, not the caller.
    await database().prepare(`UPDATE "member" SET role = 'member' WHERE id = 'm2'`).run();
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'member' });
    const row = await database().prepare(`SELECT role FROM "member" WHERE id = 'm2'`).first<{
      role: string;
    }>();
    expect(row?.role).toBe('member');
  });
});

describe('cockpit chat', () => {
  type EnqueueFactory = NonNullable<ApiRouteDependencies['enqueueFactory']>;

  async function seedFeature(
    repoId: number,
    status = 'pr_opened',
    prNumber: number | null = 42,
  ): Promise<number> {
    const row = await database()
      .prepare(
        `INSERT INTO features (repository_id, title, spec, status, pr_number)
			 VALUES (?1, 'Feature', 'Spec', ?2, ?3) RETURNING id`,
      )
      .bind(repoId, status, prNumber)
      .first<{ id: number }>();
    return row!.id;
  }

  function chatApp(enqueueFactory: EnqueueFactory = async () => {}) {
    return apiApp({
      authenticate: async () => acmeUser,
      canPushToRepo: async () => true,
      orgAdmin: async () => true,
      enqueueFactory,
    });
  }

  function postChat(app: Hono, featureId: number, body: string) {
    return app.request(`https://turbodiff.test/api/factory/features/${featureId}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  it('conceals a foreign feature from both chat routes', async () => {
    const foreignId = await seedFeature(202);
    const app = chatApp();
    const list = await app.request(`https://turbodiff.test/api/factory/features/${foreignId}/chat`);
    expect(list.status).toBe(404);
    expect((await postChat(app, foreignId, 'hello')).status).toBe(404);
    expect(
      (await app.request(`https://turbodiff.test/api/factory/features/${foreignId}/diff?v=abcdef1`))
        .status,
    ).toBe(404);
  });

  it('does not cache arbitrary client-provided diff versions', async () => {
    const featureId = await seedFeature(101, 'generating', null);
    const response = await chatApp().request(
      `https://turbodiff.test/api/factory/features/${featureId}/diff?v=not-a-commit`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: null, files: [], more_files: 0 });
  });

  it('rejects an empty message body', async () => {
    const featureId = await seedFeature(101);
    const response = await postChat(chatApp(), featureId, '   ');
    expect(response.status).toBe(400);
  });

  it('409s when the feature has no open pull request', async () => {
    const noPr = await seedFeature(101, 'generating', null);
    expect((await postChat(chatApp(), noPr, 'hello')).status).toBe(409);

    const merged = await seedFeature(101, 'merged', 42);
    expect((await postChat(chatApp(), merged, 'hello')).status).toBe(409);
  });

  it('records a queued user message, enqueues one chat turn, and lists it back', async () => {
    const featureId = await seedFeature(101);
    const enqueueFactory = vi.fn<EnqueueFactory>(async () => {});
    const app = chatApp(enqueueFactory);

    const response = await postChat(app, featureId, 'Rename the button to Save');
    expect(response.status).toBe(200);
    // SAFETY: the 200 body is the route's {ok, message_id} contract this
    // test exercises.
    const created = (await response.json()) as { ok: boolean; message_id: number };
    expect(created.ok).toBe(true);
    expect(enqueueFactory).toHaveBeenCalledExactlyOnceWith({
      kind: 'chat',
      featureId,
      chatMessageId: created.message_id,
    });
    const row = await database()
      .prepare('SELECT role, body, author, author_id, status FROM chat_messages WHERE id = ?1')
      .bind(created.message_id)
      .first<{ role: string; body: string; author: string; author_id: number; status: string }>();
    expect(row).toEqual({
      role: 'user',
      body: 'Rename the button to Save',
      author: 'octocat',
      author_id: 3001,
      status: 'queued',
    });

    // A second send while the first turn is still queued is refused.
    expect((await postChat(app, featureId, 'and one more thing')).status).toBe(409);

    const list = await app.request(`https://turbodiff.test/api/factory/features/${featureId}/chat`);
    expect(list.status).toBe(200);
    // SAFETY: the 200 body is the ApiChatList contract this test exercises.
    const chat = (await list.json()) as { messages: { id: number; role: string }[] };
    expect(chat.messages.map((m) => m.id)).toEqual([created.message_id]);
  });

  it('lists messages in chronological order with turn outcomes', async () => {
    const featureId = await seedFeature(101);
    await database()
      .prepare(
        `INSERT INTO chat_messages (feature_id, role, body, author, author_id, status, outcome, commit_sha)
			 VALUES (?1, 'user', 'Do it', 'octocat', 3001, 'done', NULL, NULL),
			        (?1, 'assistant', 'Done.', NULL, NULL, 'done', 'changed', 'abc1234')`,
      )
      .bind(featureId)
      .run();

    const response = await chatApp().request(
      `https://turbodiff.test/api/factory/features/${featureId}/chat`,
    );
    expect(response.status).toBe(200);
    // SAFETY: the 200 body is the ApiChatList contract this test exercises.
    const chat = (await response.json()) as {
      messages: { role: string; outcome: string | null; commit_sha: string | null }[];
    };
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chat.messages[1]).toMatchObject({ outcome: 'changed', commit_sha: 'abc1234' });
  });
});

describe('push subscriptions', () => {
  it('includes a VAPID public key string on /me', async () => {
    const response = await authenticatedApi().request('https://turbodiff.test/api/me');
    expect(response.status).toBe(200);
    const me = parseJson(await response.text());
    expect(isJsonObject(me) && isString(me.vapid_public_key)).toBe(true);
    expect(isJsonObject(me) && me.installation_ids).toEqual([1001]);
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
    const row = await database()
      .prepare('SELECT user_github_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?1')
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
    await database()
      .prepare(
        `INSERT INTO push_subscriptions (user_github_id, endpoint, p256dh, auth)
			 VALUES (3001, 'https://push.example/mine', 'p', 'a'),
			        (4001, 'https://push.example/theirs', 'p', 'a')`,
      )
      .run();

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
      await database()
        .prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?1')
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
      await database()
        .prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?1')
        .bind('https://push.example/mine')
        .first(),
    ).toBeNull();
  });
});

// GitHub-dependent success paths (tree listing, save, 409 mapping) are left
// to manual verification: this suite has no outbound-fetch mocking harness,
// so only the paths that resolve before any GitHub call are covered. The
// Artifacts success paths run real git in the per-repo sandbox, which this
// worker pool also lacks — those are deployment-smoke territory; only the
// paths that resolve before the sandbox are covered here.
describe('repo code browser', () => {
  async function seedArtifactsRepo(): Promise<void> {
    await database()
      .prepare(
        `INSERT INTO repositories (id, installation_id, owner, name, provider, artifacts_repo, default_branch)
			 VALUES (303, 1001, 'acme', 'hosted', 'artifacts', 'acme--hosted', 'main')`,
      )
      .run();
  }

  const validSave = {
    path: 'src/index.ts',
    ref: 'main',
    base_sha: 'abc123',
    content: 'export {}\n',
    message: 'Update src/index.ts',
    mode: 'commit',
  };

  it('rejects unauthenticated requests on every code route', async () => {
    for (const path of [
      '/api/repos/101/code',
      '/api/repos/101/tree?ref=main',
      '/api/repos/101/file?ref=main&path=readme.md',
    ]) {
      const response = await apiApp().request(`https://turbodiff.test${path}`);
      expect(response.status).toBe(401);
    }
  });

  it('conceals repositories outside the caller installations', async () => {
    const app = authenticatedApi();
    for (const path of [
      '/api/repos/202/code',
      '/api/repos/202/tree?ref=main',
      '/api/repos/202/file?ref=main&path=readme.md',
    ]) {
      const response = await app.request(`https://turbodiff.test${path}`);
      expect(response.status).toBe(404);
    }
    const write = await app.request('https://turbodiff.test/api/repos/202/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validSave),
    });
    expect(write.status).toBe(404);
  });

  it('rejects mode "pr" for an artifacts-hosted repo before auth', async () => {
    await seedArtifactsRepo();
    const canPush = vi.fn(async () => true);
    const response = await authenticatedApi(canPush).request(
      'https://turbodiff.test/api/repos/303/file',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...validSave, mode: 'pr' }),
      },
    );
    expect(response.status).toBe(400);
    const body = parseJson(await response.text());
    expect(
      isJsonObject(body) && isString(body.error) && body.error.includes('pull-request saves'),
    ).toBe(true);
    expect(canPush).not.toHaveBeenCalled();
  });

  it('gates artifacts saves on the org settings capability', async () => {
    await seedArtifactsRepo();
    // orgAdmin false: the caller has no member row and the org heal denies
    // elevation, so the 'settings' capability check fails.
    const canPushSpy = vi.fn(async () => true);
    const response = await authenticatedApi(canPushSpy, async () => false).request(
      'https://turbodiff.test/api/repos/303/file',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validSave),
      },
    );
    expect(response.status).toBe(403);
    expect(canPushSpy).not.toHaveBeenCalled();
  });

  it('requires the caller’s own GitHub push permission before any write', async () => {
    const canPush = vi.fn(async () => false);
    const response = await authenticatedApi(canPush).request(
      'https://turbodiff.test/api/repos/101/file',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validSave),
      },
    );
    expect(response.status).toBe(403);
    expect(canPush).toHaveBeenCalledWith(acmeUser, 'acme', 'api');
  });

  it('rejects malformed paths, refs, and modes before the push-permission check', async () => {
    const canPush = vi.fn(async () => true);
    const app = authenticatedApi(canPush);
    for (const body of [
      { ...validSave, path: 'src/../../etc/passwd' },
      { ...validSave, path: '/etc/passwd' },
      { ...validSave, ref: 'main..other' },
      { ...validSave, mode: 'yolo' },
      { ...validSave, content: 42 },
    ]) {
      const response = await app.request('https://turbodiff.test/api/repos/101/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(canPush).not.toHaveBeenCalled();

    const badTree = await app.request(
      'https://turbodiff.test/api/repos/101/tree?ref=main&path=src/../..',
    );
    expect(badTree.status).toBe(400);
    const noRef = await app.request('https://turbodiff.test/api/repos/101/tree');
    expect(noRef.status).toBe(400);
    const noPath = await app.request('https://turbodiff.test/api/repos/101/file?ref=main');
    expect(noPath.status).toBe(400);
  });
});

// The success path (a real audio file transcribed by the AI binding) isn't
// covered here: wrangler.test.jsonc has no "ai" binding, matching every
// other worker test's PostgreSQL-only fixture — exercising real Workers AI needs
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
