/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { testDatabase } from '../test/database-fixture.ts';
// Transport-level coverage for the signed-in JSON API.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { AuthedUser } from '../services/auth.ts';
import { PREMORTEM_CRITERION } from '../domain/verification.ts';
import type {
  ApiBoard,
  ApiFeatureDetail,
  ApiModels,
  ApiSettings,
  ApiUsage,
} from '../shared/api-types.ts';
import { isJsonObject, isString, parseJson, type JsonObject } from '../shared/json.ts';
import { RUNNER_MODELS } from '../shared/runner-models.ts';
import { createApiRoutes, type ApiRouteDependencies } from './api.ts';
import { handleEmailSignUp } from './auth-email.ts';
import { SkillsShApiError, type SkillsShClient } from '../integrations/skills-sh/client.ts';
import {
  ensureBuiltinAgents,
  getFactoryRun,
  getRepoById,
  getStageRun,
  upsertChange,
} from '../data/db.ts';
import type { FactoryMessage } from '../shared/factory-messages.ts';

type Authenticate = NonNullable<ApiRouteDependencies['authenticate']>;

const acmeUser: AuthedUser = {
  session: { authUserId: 'user-3001', userId: 3001, login: 'octocat' },
  installationIds: [1001],
  githubConnected: true,
  githubStatus: 'ready',
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
  await testDatabase().batch([
    testDatabase().prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization'),
		        (2002, 'other', 2002, 'Organization')`,
    ),
    testDatabase().prepare(
      `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api'),
		        (202, 2002, 'other', 'private')`,
    ),
    testDatabase().prepare(
      `INSERT INTO todos (id, installation_id, title, created_by_login, created_by_id)
		 VALUES (401, 1001, 'Acme backlog', 'octocat', 3001),
		        (402, 2002, 'Other backlog', 'someone-else', 4001)`,
    ),
    testDatabase().prepare(
      `INSERT INTO todo_repositories (todo_id, repository_id, position)
		 VALUES (401, 101, 0), (402, 202, 0)`,
    ),
    // A better-auth user row for acmeUser — session.userId (3001) is the
    // GitHub id memberRole and the owner bootstrap look members up by.
    // Seeded globally so the lazy org heal's elevate-to-owner path (orgAdmin
    // defaults to true in authenticatedApi) actually records the member row,
    // keeping capability-gated suites that never seed org rows on their
    // pre-heal "allowed" outcome.
    testDatabase().prepare(
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
    'repo_skills',
    'skills',
    'models',
    'member',
    'invitation',
    'organization',
    'verifications',
    'fix_attempts',
    'automation_runs',
    'automations',
    'plan_repositories',
    'features',
    'plans',
    'reviews',
    'repositories',
    'installations',
    'session',
    'account',
    'user',
  ];
  await testDatabase().batch(
    tables.map((table) => testDatabase().prepare(`DELETE FROM "${table}"`)),
  );
  await seedTenants();
});

describe('API authentication and CSRF', () => {
  it('rejects a request without a durable session', async () => {
    const response = await apiApp().request('https://turbodiff.test/api/me');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('keeps a migrated user signed in when GitHub needs re-authorization', async () => {
    const response = await apiApp({
      authenticate: async () => ({
        ...acmeUser,
        installationIds: [],
        githubStatus: 'reauthorization_required',
      }),
    }).request('https://turbodiff.test/api/me');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      login: 'octocat',
      github_connected: true,
      github_status: 'reauthorization_required',
      installation_ids: [],
    });
  });

  it('guides a new connected user to install the GitHub App', async () => {
    const response = await apiApp({
      authenticate: async () => ({
        ...acmeUser,
        installationIds: [],
        githubStatus: 'app_not_installed',
      }),
    }).request('https://turbodiff.test/api/me');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      github_connected: true,
      github_status: 'app_not_installed',
      installation_ids: [],
    });
  });

  it('starts repository repair without delaying the migrated user response', async () => {
    const repositoryRepair = vi.fn(async () => {});
    const response = await apiApp({
      authenticate: async () => ({
        ...acmeUser,
        githubStatus: 'syncing',
        repositoryRepair,
      }),
    }).request('https://turbodiff.test/api/me');

    expect(response.status).toBe(200);
    expect(repositoryRepair).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ github_status: 'syncing' });
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

describe('push re-review window', () => {
  it('round-trips the debounce minutes and rejects values outside 0..720', async () => {
    const app = authenticatedApi();
    const patch = (body: JsonObject) =>
      app.request('https://turbodiff.test/api/repos/101', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const invalid of [-1, 721, 1.5, '15']) {
      const rejected = await patch({ review_push_debounce_minutes: invalid });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: 'review_push_debounce_minutes must be an integer between 0 and 720',
      });
    }
    await expect(getRepoById(101)).resolves.toMatchObject({ review_push_debounce_minutes: 10 });

    const saved = await patch({ review_push_debounce_minutes: 30 });
    expect(saved.status).toBe(200);
    await expect(getRepoById(101)).resolves.toMatchObject({ review_push_debounce_minutes: 30 });
    const settings = await app.request('https://turbodiff.test/api/settings');
    const body = await settings.json<ApiSettings>();
    expect(body.installations.flatMap((inst) => inst.repos)).toContainEqual(
      expect.objectContaining({ id: 101, review_push_debounce_minutes: 30 }),
    );
  });
});

describe('on-demand change review', () => {
  it('dispatches an existing human PR without requiring a feature', async () => {
    const configured = await authenticatedApi().request('https://turbodiff.test/api/repos/101', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ process_profile: 'review_on_demand' }),
    });
    expect(configured.status).toBe(200);
    await expect(getRepoById(101)).resolves.toMatchObject({
      process_profile: 'review_on_demand',
      review_intake: 'on_demand',
    });
    await ensureBuiltinAgents(1001);
    const change = await upsertChange({
      repositoryId: 101,
      providerKey: 'github:42',
      number: 42,
      origin: 'human',
      title: 'Existing pull request',
      externalUrl: 'https://github.com/acme/api/pull/42',
      sourceBranch: 'contributor/topic',
      targetBranch: 'main',
      status: 'open',
      sourceHead: 'a'.repeat(40),
      targetHead: 'b'.repeat(40),
      draft: false,
      capabilities: ['read_change', 'publish_review'],
    });
    const queued: FactoryMessage[] = [];
    const app = apiApp({
      authenticate: async () => acmeUser,
      canPushToRepo: async () => true,
      orgAdmin: async () => true,
      enqueueFactory: async (message) => {
        queued.push(message);
      },
    });

    const response = await app.request(`https://turbodiff.test/api/changes/${change.id}/review`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      change_id: change.id,
      run_id: expect.any(Number),
      stage_run_id: expect.any(Number),
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'run_stage', stage: 'review', changeId: change.id });
    if (queued[0]?.kind !== 'run_stage') throw new Error('expected a run_stage command');
    await expect(getFactoryRun(queued[0].factoryRunId)).resolves.toMatchObject({
      status: 'active',
      profile_key: 'review_on_demand',
    });
    await expect(getStageRun(queued[0].stageRunId)).resolves.toMatchObject({ status: 'queued' });
  });

  it('keeps human PRs out of the legacy factory-only profile', async () => {
    const change = await upsertChange({
      repositoryId: 101,
      providerKey: 'github:43',
      number: 43,
      origin: 'human',
      title: 'Existing pull request',
      externalUrl: 'https://github.com/acme/api/pull/43',
      sourceBranch: 'contributor/topic',
      targetBranch: 'main',
      status: 'open',
      sourceHead: null,
      targetHead: null,
      draft: false,
      capabilities: ['read_change', 'publish_review'],
    });
    const queued: FactoryMessage[] = [];
    const app = apiApp({
      authenticate: async () => acmeUser,
      canPushToRepo: async () => true,
      orgAdmin: async () => true,
      enqueueFactory: async (message) => {
        queued.push(message);
      },
    });

    const response = await app.request(`https://turbodiff.test/api/changes/${change.id}/review`, {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'legacy profile admits factory changes only' });
    expect(queued).toHaveLength(0);
  });
});

describe('API constraint validation', () => {
  it.each(['security-', 'a--b'])(
    'rejects an agent slug PostgreSQL would reject: %s',
    async (slug) => {
      const response = await authenticatedApi().request('https://turbodiff.test/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, name: 'Invalid', instructions: 'Review carefully' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('slug') });
    },
  );

  it('rejects a well-formed reviewer model that is not in the catalog', async () => {
    const response = await authenticatedApi().request('https://turbodiff.test/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'strict-reviewer',
        name: 'Strict',
        instructions: 'Review carefully',
        model: 'cloudflare/anthropic/not-a-real-model',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('model') });
  });

  it('accepts a reviewer model backed by an enabled catalog row', async () => {
    await testDatabase()
      .prepare(
        `INSERT INTO models (model_id, provider, label, for_runner, for_reviewer)
         VALUES ('claude-x', 'anthropic', 'Claude X', false, true)`,
      )
      .run();
    const response = await authenticatedApi().request('https://turbodiff.test/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'catalog-reviewer',
        name: 'Catalog',
        instructions: 'Review carefully',
        model: 'cloudflare/anthropic/claude-x',
      }),
    });
    expect(response.status).toBe(200);
  });

  it('serves the constant fallbacks from /api/models while the catalog is empty', async () => {
    const response = await authenticatedApi().request('https://turbodiff.test/api/models');
    expect(response.status).toBe(200);
    // SAFETY: /api/models' 200 body is the ApiModels contract this test
    // exercises; the assertions below fail on any drift in that shape.
    const catalog = (await response.json()) as ApiModels;
    expect(catalog.runner.options).toEqual([...RUNNER_MODELS]);
    expect(catalog.runner.default_model).toBe('claude-fable-5');
    expect(catalog.reviewer.default_model).toBe('cloudflare/anthropic/claude-sonnet-5');
  });

  it('validates the task runner model against the active list', async () => {
    await testDatabase()
      .prepare(
        `INSERT INTO plans (id, repository_id, title, requirements, status)
         VALUES (702, 101, 'Model swap', 'requirements', 'approved')`,
      )
      .run();
    const app = authenticatedApi();
    const rejected = await app.request('https://turbodiff.test/api/tasks/702/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-runner-model' }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'unknown model' });

    const accepted = await app.request('https://turbodiff.test/api/tasks/702/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5' }),
    });
    expect(accepted.status).toBe(200);
  });

  it('rejects line zero before inserting a cockpit comment', async () => {
    const feature = await testDatabase()
      .prepare(
        `INSERT INTO features (repository_id, title, spec, pr_number)
         VALUES (101, 'Feature', 'Spec', 7) RETURNING id`,
      )
      .first<{ id: number }>();
    const response = await authenticatedApi().request(
      `https://turbodiff.test/api/factory/features/${feature!.id}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'src/index.ts', line: 0, body: 'Fix this' }),
      },
    );
    expect(response.status).toBe(400);
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
    const created = await testDatabase()
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
      await testDatabase().prepare('SELECT id FROM todos WHERE id = 402').first<{ id: number }>(),
    ).toEqual({ id: 402 });

    const owned = await app.request('https://turbodiff.test/api/todos/401', {
      method: 'DELETE',
    });
    expect(owned.status).toBe(200);
    expect(await testDatabase().prepare('SELECT id FROM todos WHERE id = 401').first()).toBeNull();
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
    const repo = await testDatabase()
      .prepare('SELECT enabled FROM repositories WHERE id = 101')
      .first<{
        enabled: boolean;
      }>();
    expect(repo?.enabled).toBe(false);
  });
});

describe('pipeline cost reporting', () => {
  // One row per metered stage in the current UTC month (created_at defaults to
  // CURRENT_TIMESTAMP, which is what dashboardStats and the cost union both
  // compare against), plus a foreign installation's row that neither surface
  // may count.
  async function seedPipelineCosts(): Promise<void> {
    await testDatabase().batch([
      testDatabase().prepare(
        `INSERT INTO reviews (repository_id, installation_id, pr_number, trigger_event, cost_usd)
			 VALUES (101, 1001, 7, 'opened', 0.1),
			        (202, 2002, 9, 'opened', 9.99)`,
      ),
      testDatabase().prepare(
        `INSERT INTO features (id, repository_id, title, spec, cost_usd)
			 VALUES (501, 101, 'Ship it', 'spec', 0.02)`,
      ),
      testDatabase().prepare(
        `INSERT INTO fix_attempts (repository_id, pr_number, "trigger", cost_usd)
			 VALUES (101, 7, 'blocking_review', 0.003)`,
      ),
      testDatabase().prepare(
        `INSERT INTO verifications (feature_id, cost_usd) VALUES (501, 0.0004)`,
      ),
      testDatabase().prepare(
        `INSERT INTO automations
           (id, repository_id, name, prompt, schedule_kind, time_of_day, next_run_at)
				 VALUES (601, 101, 'Nightly', 'do the thing', 'daily', '09:00', '2026-01-01T00:00:00Z')`,
      ),
      testDatabase().prepare(
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

    // Decimal aggregation and JSON serialization can differ at the least-significant digits.
    expect(board.stats.month_pipeline_cost_usd).toBeCloseTo(0.12345, 6);
    expect(board.stats.month_pipeline_cost_usd).toBeCloseTo(usage.stats.month_pipeline_cost_usd, 6);

    const currentMonthRow = usage.months.find((m) => m.month === usage.month);
    expect(currentMonthRow?.pipeline_cost_usd).toBeCloseTo(usage.stats.month_pipeline_cost_usd, 6);

    // Still a distinct concept — and the foreign installation's 9.99 is in
    // neither figure.
    expect(usage.stats.month_review_cost_usd).toBeCloseTo(0.1, 6);
  });
});

describe('verification stall display', () => {
  // One approved task on the acme repo with a PR open and a latest
  // verification row — the shape the board serializes per repo.
  async function seedTaskWithVerification(): Promise<void> {
    await testDatabase().batch([
      testDatabase().prepare(
        `INSERT INTO plans (id, repository_id, title, requirements, status)
			 VALUES (701, 101, 'Ship it', 'requirements', 'approved')`,
      ),
      testDatabase().prepare(
        `INSERT INTO plan_repositories (plan_id, repository_id, position) VALUES (701, 101, 0)`,
      ),
      testDatabase().prepare(
        `INSERT INTO features (id, repository_id, plan_id, title, spec, status, pr_number)
			 VALUES (501, 101, 701, 'Ship it', 'spec', 'pr_opened', 7)`,
      ),
      testDatabase().prepare(`INSERT INTO verifications (id, feature_id) VALUES (801, 501)`),
    ]);
  }

  async function boardVerificationStatus(): Promise<string | undefined> {
    const response = await authenticatedApi().request('https://turbodiff.test/api/board');
    expect(response.status).toBe(200);
    // SAFETY: /api/board's 200 body is the ApiBoard contract this test
    // exercises; the assertions below fail on any drift in that shape.
    const board = (await response.json()) as ApiBoard;
    return board.tasks.find((t) => t.id === 701)?.repos[0]?.verification?.status;
  }

  it("reports a fresh running row as 'running' and an over-age one as 'stalled', display-only", async () => {
    await seedTaskWithVerification();
    expect(await boardVerificationStatus()).toBe('running');

    await testDatabase()
      .prepare(
        `UPDATE verifications
         SET created_at = CURRENT_TIMESTAMP - INTERVAL '46 minutes'
         WHERE id = 801`,
      )
      .run();
    expect(await boardVerificationStatus()).toBe('stalled');

    // Display-only: the row itself still says 'running' — the cron sweep,
    // not the read path, resolves it to 'error'.
    const row = await testDatabase()
      .prepare('SELECT status FROM verifications WHERE id = 801')
      .first<{ status: string }>();
    expect(row?.status).toBe('running');
  });

  it('shows the premortem row the verifier appended beyond the stored criteria', async () => {
    // Feature 502 has one human criterion; its failed verification carries a
    // second result at index 1 — the run-time premortem. The cockpit must
    // list it (and its failure), not paint 1/1 proven under a failed verdict.
    // An artifacts-hosted repo keeps the route off GitHub; a PR number is
    // needed because criteria are only graded once a change exists.
    await testDatabase().batch([
      testDatabase().prepare(
        `INSERT INTO installations (id, account_login, account_id, account_type, provider)
         VALUES (3003, 'acme-artifacts', 3003, 'Organization', 'artifacts')`,
      ),
      testDatabase().prepare(
        `INSERT INTO repositories (id, installation_id, owner, name, provider, artifacts_repo, default_branch)
         VALUES (303, 3003, 'acme', 'hosted', 'artifacts', 'acme--hosted', 'main')`,
      ),
      testDatabase().prepare(
        `INSERT INTO features (id, repository_id, title, spec, status, pr_number, acceptance)
         VALUES (502, 303, 'Ship it', 'spec', 'pr_opened', 1, '["GET /a returns 200"]'::jsonb)`,
      ),
      testDatabase().prepare(
        `INSERT INTO verifications (id, feature_id, status, results)
         VALUES (802, 502, 'failed',
           '[{"index":0,"verdict":"pass","note":"ok"},
             {"index":1,"verdict":"fail","note":"Surviving mechanism: X"}]'::jsonb)`,
      ),
    ]);
    const app = apiApp({
      authenticate: async () => ({ ...acmeUser, installationIds: [1001, 3003] }),
      canPushToRepo: async () => true,
      orgAdmin: async () => true,
    });
    const response = await app.request('https://turbodiff.test/api/factory/features/502');
    expect(response.status).toBe(200);
    // SAFETY: the 200 body is the ApiFeatureDetail contract under test; the
    // assertions below fail on any drift in the criteria/verification shape.
    const detail = (await response.json()) as ApiFeatureDetail;
    expect(detail.criteria.map((c) => [c.text, c.verdict])).toEqual([
      ['GET /a returns 200', 'pass'],
      [PREMORTEM_CRITERION, 'fail'],
    ]);
    expect(detail.criteria[1]?.note).toBe('Surviving mechanism: X');
    expect(detail.verification).toEqual({ status: 'failed', total: 2, failed: 1 });
  });

  it("reports a completed 'passed' row as 'passed' regardless of age", async () => {
    await seedTaskWithVerification();
    await testDatabase()
      .prepare(
        `UPDATE verifications
         SET status = 'passed', created_at = CURRENT_TIMESTAMP - INTERVAL '46 minutes'
         WHERE id = 801`,
      )
      .run();
    expect(await boardVerificationStatus()).toBe('passed');
  });
});

describe('organization member management', () => {
  // The better-auth user row for acmeUser (u1, githubId 3001) is seeded
  // globally in seedTenants — this seeds only the org row (and optionally an
  // explicit member row) on top of it.
  async function seedOrg(role: 'owner' | 'admin' | 'member' | null): Promise<void> {
    await testDatabase()
      .prepare(
        `INSERT INTO "organization" (id, name, slug, "installationId", "createdAt")
				 VALUES ('org1', 'acme', 'acme', 1001, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    if (role) {
      await testDatabase()
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
    await testDatabase()
      .prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", login, "githubId")
				 VALUES ('u2', 'hubot', 'hubot@example.test', true, '2026-01-01T00:00:00.000Z',
				         '2026-01-01T00:00:00.000Z', 'hubot', 3002)`,
      )
      .run();
    await testDatabase()
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
    await testDatabase()
      .prepare(`UPDATE installations SET account_type = 'User' WHERE id = 1001`)
      .run();
    const response = await authenticatedApi().request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(404);
    const orgRow = await testDatabase()
      .prepare('SELECT id FROM "organization" WHERE "installationId" = 1001')
      .first();
    expect(orgRow).toBeNull();
  });

  // The invitation endpoints resolve the recipient from a real better-auth
  // session (cookie), not from the `authenticate` stub — so the invitee is
  // signed up through the same handler production uses.
  async function inviteeCookie(email: string): Promise<string> {
    const app = new Hono();
    app.post('/api/auth/sign-up/email', handleEmailSignUp);
    const response = await app.request('https://turbodiff.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Invitee', email, password: 'a-long-password' }),
    });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  }

  async function seedInvitation(email: string): Promise<void> {
    await testDatabase()
      .prepare(
        `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId")
				 VALUES ('inv1', 'org1', ?1, 'admin', 'pending', '2999-01-01T00:00:00.000Z',
				         '2026-01-01T00:00:00.000Z', 'u1')`,
      )
      .bind(email)
      .run();
  }

  it('lets the invited address read and accept its invitation, recording the member row', async () => {
    await seedOrg('owner');
    await seedInvitation('invitee@example.test');
    const cookie = await inviteeCookie('invitee@example.test');
    const app = authenticatedApi();

    const preview = await app.request('https://turbodiff.test/api/invitations/inv1', {
      headers: { cookie },
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      id: 'inv1',
      email: 'invitee@example.test',
      role: 'admin',
      org_name: 'acme',
      installation_id: 1001,
      invited_by: '@octocat',
    });

    const accept = await app.request('https://turbodiff.test/api/invitations/inv1/accept', {
      method: 'POST',
      headers: { cookie },
    });
    expect(accept.status).toBe(200);
    expect(await accept.json()).toEqual({ org_name: 'acme', installation_id: 1001 });

    const member = await testDatabase()
      .prepare(
        `SELECT m.role FROM "member" m JOIN "user" u ON u.id = m."userId"
				 WHERE m."organizationId" = 'org1' AND u.email = 'invitee@example.test'`,
      )
      .first<{ role: string }>();
    expect(member).toEqual({ role: 'admin' });
    const invitation = await testDatabase()
      .prepare(`SELECT status FROM "invitation" WHERE id = 'inv1'`)
      .first<{ status: string }>();
    expect(invitation).toEqual({ status: 'accepted' });
  });

  it('refuses the invitation to a session whose email does not match', async () => {
    await seedOrg('owner');
    await seedInvitation('invitee@example.test');
    const cookie = await inviteeCookie('someone-else@example.test');
    const app = authenticatedApi();

    const preview = await app.request('https://turbodiff.test/api/invitations/inv1', {
      headers: { cookie },
    });
    expect(preview.status).toBe(403);
    const accept = await app.request('https://turbodiff.test/api/invitations/inv1/accept', {
      method: 'POST',
      headers: { cookie },
    });
    expect(accept.status).toBe(403);
    const members = await testDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = 'org1'`)
      .first<{ n: number }>();
    expect(members).toEqual({ n: 1 });
  });

  it('reports an unknown invitation id as not found rather than a server error', async () => {
    await seedOrg('owner');
    const cookie = await inviteeCookie('invitee@example.test');
    const preview = await authenticatedApi().request(
      'https://turbodiff.test/api/invitations/nope',
      { headers: { cookie } },
    );
    expect(preview.status).toBe(400);
    expect(await preview.json()).toEqual({ error: 'Invitation not found!' });
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

  // Agents are generic across installations. An owner of one org must be able
  // to edit a shared agent even when the list handed the edit page another
  // org's copy, where they are a plain member — the edit lands on the copies
  // they hold 'settings' for and leaves the rest alone.
  it('edits a shared agent through the installations where the caller holds settings', async () => {
    await seedOrg('member');
    await seedCoOwner();
    await testDatabase()
      .prepare(
        `INSERT INTO "organization" (id, name, slug, "installationId", "createdAt")
				 VALUES ('org2', 'other', 'other', 2002, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    await testDatabase()
      .prepare(
        `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
				 VALUES ('m3', 'org2', 'u1', 'owner', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    await ensureBuiltinAgents(1001);
    await ensureBuiltinAgents(2002);
    // orgAdmin false: no GitHub-derived elevation, only the seeded rows count.
    const app = apiApp({
      authenticate: async () => ({ ...acmeUser, installationIds: [1001, 2002] }),
      canPushToRepo: async () => true,
      orgAdmin: async () => false,
    });
    const copyFor = (installationId: number) =>
      testDatabase()
        .prepare(`SELECT id, name FROM agents WHERE installation_id = ?1 AND slug = 'review'`)
        .bind(installationId)
        .first<{ id: number; name: string }>();
    const memberCopy = await copyFor(1001);
    const ownerCopy = await copyFor(2002);

    // The list hands the edit page the copy the caller can actually edit.
    const list = await app.request('https://turbodiff.test/api/agents');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ slug: 'review', id: Number(ownerCopy?.id) }),
      ]),
    });

    // Editing through the member-only copy still succeeds and lands on the
    // owner installation's copy only.
    const response = await app.request(`https://turbodiff.test/api/agents/${memberCopy?.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', instructions: 'Review carefully' }),
    });
    expect(response.status).toBe(200);
    expect((await copyFor(2002))?.name).toBe('Renamed');
    expect((await copyFor(1001))?.name).toBe(memberCopy?.name);
  });

  it('refuses an agent edit only when the caller holds settings nowhere', async () => {
    await seedOrg('member');
    await seedCoOwner();
    await ensureBuiltinAgents(1001);
    const copy = await testDatabase()
      .prepare(`SELECT id FROM agents WHERE installation_id = 1001 AND slug = 'review'`)
      .first<{ id: number }>();
    const response = await authenticatedApi(
      async () => true,
      async () => false,
    ).request(`https://turbodiff.test/api/agents/${copy?.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', instructions: 'Review carefully' }),
    });
    expect(response.status).toBe(403);
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
    await testDatabase()
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
    const healed = await testDatabase()
      .prepare('SELECT id FROM "organization" WHERE "installationId" = 1001')
      .first<{ id: string }>();
    expect(healed).not.toBeNull();
    expect(await first.json()).toMatchObject({ org_id: healed?.id, my_role: 'member' });

    const second = await app.request('https://turbodiff.test/api/organizations/1001/members');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ org_id: healed?.id });
    const count = await testDatabase()
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
    const member = await testDatabase()
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
    await testDatabase()
      .prepare('UPDATE installations SET installer_github_id = 3001 WHERE id = 1001')
      .run();
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'owner' });
    const member = await testDatabase()
      .prepare(`SELECT role FROM "member" WHERE "organizationId" = 'org1' AND "userId" = 'u1'`)
      .first<{ role: string }>();
    expect(member?.role).toBe('owner');
  });

  it('never promotes the installer once the organization has any member row', async () => {
    // An explicit row means the org has working governance — a demoted or
    // removed installer must not climb back in through the bootstrap.
    await seedOrg(null);
    await seedCoOwner();
    await testDatabase()
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
    await testDatabase()
      .prepare('UPDATE installations SET installer_github_id = 9999 WHERE id = 1001')
      .run();
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'member' });
    const count = await testDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = 'org1'`)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('opens the settings capability gate for the recorded installer', async () => {
    // Same shape as the promotion test above, but through a capability-gated
    // mutation — proving the heal runs on the capabilityDenied choke point
    // (the route the production lockout actually 403'd on).
    await seedOrg(null);
    await testDatabase()
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
    const row = await testDatabase().prepare(`SELECT role FROM "member" WHERE id = 'm1'`).first<{
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
    const row = await testDatabase().prepare(`SELECT role FROM "member" WHERE id = 'm1'`).first<{
      role: string;
    }>();
    expect(row?.role).toBe('owner');

    const second = await app.request('https://turbodiff.test/api/organizations/1001/members');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ my_role: 'owner' });
    const count = await testDatabase()
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
    const row = await testDatabase().prepare(`SELECT role FROM "member" WHERE id = 'm1'`).first<{
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
    await testDatabase().prepare(`UPDATE "member" SET role = 'member' WHERE id = 'm2'`).run();
    const response = await authenticatedApi(undefined, async () => false).request(
      'https://turbodiff.test/api/organizations/1001/members',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ my_role: 'member' });
    const row = await testDatabase().prepare(`SELECT role FROM "member" WHERE id = 'm2'`).first<{
      role: string;
    }>();
    expect(row?.role).toBe('member');
  });
});

describe('skills catalog & import', () => {
  const catalogEntry = {
    source: 'acme/skills',
    slug: 'pdf-forms',
    name: 'PDF Forms',
    description: 'Fill PDF forms',
    installs: 7,
  };

  // Fake catalog client: configured by default, every method overridable.
  function fakeSkillsSh(overrides: Partial<SkillsShClient> = {}): SkillsShClient {
    return {
      configured: () => true,
      search: async () => [catalogEntry],
      leaderboard: async () => [catalogEntry],
      detail: async () => ({
        ...catalogEntry,
        hash: 'a'.repeat(64),
        files: [
          {
            path: 'SKILL.md',
            contents: '---\nname: pdf-forms\ndescription: Fill PDF forms\n---\n\nUse pdftk.',
          },
          { path: 'references/notes.md', contents: 'field naming notes' },
        ],
      }),
      audit: async () => [{ auditor: 'claude', verdict: 'pass' }],
      ...overrides,
    };
  }

  function skillsApp(skillsSh: SkillsShClient, orgAdmin = async () => true) {
    return apiApp({
      authenticate: async () => acmeUser,
      canPushToRepo: async () => true,
      orgAdmin,
      skillsSh,
    });
  }

  function postJson(app: Hono, path: string, body: JsonObject) {
    return app.request(`https://turbodiff.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('reports an unconfigured catalog instead of erroring', async () => {
    const app = skillsApp(fakeSkillsSh({ configured: () => false }));
    const response = await app.request('https://turbodiff.test/api/skills/catalog');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, skills: [] });
  });

  it('degrades the catalog on a non-HTTP failure instead of erroring the browse page', async () => {
    // fetch rejecting (DNS, reset, TLS) surfaces as a TypeError, not a
    // SkillsShApiError — the browse loader must still get a 200 so the
    // GitHub-direct import form stays reachable.
    const app = skillsApp(
      fakeSkillsSh({
        leaderboard: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    );
    const response = await app.request('https://turbodiff.test/api/skills/catalog');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      skills: [],
      error: 'skills.sh catalog request failed',
    });
  });

  it('answers 502 with the upstream message when a preview fetch rejects', async () => {
    const app = skillsApp(
      fakeSkillsSh({
        detail: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    );
    const response = await postJson(app, '/api/skills/import/preview', {
      reference: 'acme/skills/pdf-forms',
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'skill source request failed: fetch failed',
    });
  });

  it('proxies a catalog search through the server-side client', async () => {
    const search = vi.fn(async () => [catalogEntry]);
    const app = skillsApp(fakeSkillsSh({ search }));
    const response = await app.request('https://turbodiff.test/api/skills/catalog?q=review');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, skills: [catalogEntry] });
    expect(search).toHaveBeenCalledWith('review', 30);
  });

  it('degrades a failing configured catalog to a 200 instead of a 502', async () => {
    const app = skillsApp(
      fakeSkillsSh({
        leaderboard: async () => {
          throw new SkillsShApiError(401, 'skills.sh request failed (401)');
        },
      }),
    );
    const response = await app.request('https://turbodiff.test/api/skills/catalog');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      skills: [],
      error: 'skills.sh catalog request failed',
    });
  });

  it('imports a catalog skill with provenance and file paths', async () => {
    const app = skillsApp(fakeSkillsSh());

    const preview = await postJson(app, '/api/skills/import/preview', {
      reference: 'acme/skills/pdf-forms',
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      name: 'pdf-forms',
      suggested_slug: 'pdf-forms',
      slug_taken: false,
      instructions: 'Use pdftk.',
      files: [{ path: 'references/notes.md' }],
      source: 'skills.sh',
      source_ref: 'acme/skills/pdf-forms',
      installs: 7,
      audit: [{ auditor: 'claude', verdict: 'pass' }],
    });

    const imported = await postJson(app, '/api/skills/import', {
      reference: 'https://skills.sh/acme/skills/pdf-forms',
    });
    expect(imported.status).toBe(200);
    // SAFETY: the 200 body is the route's {ok, id} contract this test exercises.
    const created = (await imported.json()) as { ok: boolean; id: number };
    expect(created.ok).toBe(true);

    const list = await app.request('https://turbodiff.test/api/skills');
    expect(await list.json()).toMatchObject({
      skills: [{ slug: 'pdf-forms', source: 'skills.sh' }],
    });

    const detail = await app.request(`https://turbodiff.test/api/skills/${created.id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      skill: {
        slug: 'pdf-forms',
        source: 'skills.sh',
        source_ref: 'acme/skills/pdf-forms',
        source_hash: 'a'.repeat(64),
        imported_at: expect.any(String),
        files: [{ path: 'references/notes.md' }],
      },
    });
    const row = await testDatabase()
      .prepare(`SELECT files FROM skills WHERE id = ?1`)
      .bind(created.id)
      .first<{ files: { path: string; contents: string }[] }>();
    expect(row?.files).toEqual([{ path: 'references/notes.md', contents: 'field naming notes' }]);
  });

  it('rejects a colliding slug without creating rows, then accepts an override slug', async () => {
    const app = skillsApp(fakeSkillsSh());
    const custom = await postJson(app, '/api/skills', {
      name: 'Mine',
      slug: 'pdf-forms',
      instructions: 'hand-written',
    });
    expect(custom.status).toBe(200);

    const collision = await postJson(app, '/api/skills/import', {
      reference: 'acme/skills/pdf-forms',
    });
    expect(collision.status).toBe(400);
    expect(await collision.json()).toMatchObject({
      error: expect.stringContaining('already exists'),
    });
    const count = await testDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM skills`)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const overridden = await postJson(app, '/api/skills/import', {
      reference: 'acme/skills/pdf-forms',
      slug: 'pdf-forms-upstream',
    });
    expect(overridden.status).toBe(200);
    const imported = await testDatabase()
      .prepare(`SELECT source FROM skills WHERE slug = 'pdf-forms-upstream'`)
      .first<{ source: string }>();
    expect(imported?.source).toBe('skills.sh');
  });

  it('gates import on the settings capability', async () => {
    const app = skillsApp(fakeSkillsSh(), async () => false);
    const response = await postJson(app, '/api/skills/import', {
      reference: 'acme/skills/pdf-forms',
    });
    expect(response.status).toBe(403);
  });

  it('rejects an unparseable import reference', async () => {
    const app = skillsApp(fakeSkillsSh());
    const response = await postJson(app, '/api/skills/import/preview', {
      reference: 'not a reference',
    });
    expect(response.status).toBe(400);
  });

  it('still accepts a plain custom-skill payload with null provenance', async () => {
    const app = skillsApp(fakeSkillsSh({ configured: () => false }));
    const create = await postJson(app, '/api/skills', {
      name: 'Custom',
      slug: 'custom-skill',
      instructions: 'do the thing',
    });
    expect(create.status).toBe(200);
    const row = await testDatabase()
      .prepare(`SELECT source, files FROM skills WHERE slug = 'custom-skill'`)
      .first<{ source: string | null; files: unknown }>();
    expect(row).toEqual({ source: null, files: [] });
  });
});

describe('cockpit chat', () => {
  type EnqueueFactory = NonNullable<ApiRouteDependencies['enqueueFactory']>;

  async function seedFeature(
    repoId: number,
    status = 'pr_opened',
    prNumber: number | null = 42,
  ): Promise<number> {
    const row = await testDatabase()
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
    const row = await testDatabase()
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
    await testDatabase()
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
    const row = await testDatabase()
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

  it('rejects push setup cleanly until an email/password user connects GitHub', async () => {
    const emailUser: AuthedUser = {
      session: { authUserId: 'email-user', userId: 0, login: '' },
      installationIds: [],
      githubConnected: false,
      githubStatus: 'not_connected',
      name: 'Email User',
    };
    const response = await apiApp({ authenticate: async () => emailUser }).request(
      'https://turbodiff.test/api/push/subscribe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'https://push.example/email-only',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'connect GitHub before enabling push notifications',
    });
  });

  it('deletes only the calling user’s subscription by endpoint', async () => {
    await testDatabase().batch([
      testDatabase().prepare(
        `INSERT INTO "user"
           (id, name, email, "emailVerified", "createdAt", "updatedAt", login, "githubId")
         VALUES ('push-4001', 'hubot', 'push-4001@example.test', true,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'hubot', 4001)`,
      ),
      testDatabase().prepare(
        `INSERT INTO push_subscriptions (user_github_id, endpoint, p256dh, auth)
				 VALUES (3001, 'https://push.example/mine', 'p', 'a'),
				        (4001, 'https://push.example/theirs', 'p', 'a')`,
      ),
    ]);

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
      await testDatabase()
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
      await testDatabase()
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
  const artifactsUser: AuthedUser = {
    ...acmeUser,
    installationIds: [...acmeUser.installationIds, 3003],
  };

  async function seedArtifactsRepo(): Promise<void> {
    await testDatabase().batch([
      testDatabase().prepare(
        `INSERT INTO installations
           (id, account_login, account_id, account_type, provider)
         VALUES (3003, 'acme-artifacts', 3003, 'Organization', 'artifacts')`,
      ),
      testDatabase().prepare(
        `INSERT INTO repositories (id, installation_id, owner, name, provider, artifacts_repo, default_branch)
				 VALUES (303, 3003, 'acme', 'hosted', 'artifacts', 'acme--hosted', 'main')`,
      ),
    ]);
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
    const response = await apiApp({
      authenticate: async () => artifactsUser,
      canPushToRepo: canPush,
      orgAdmin: async () => true,
    }).request('https://turbodiff.test/api/repos/303/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validSave, mode: 'pr' }),
    });
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
    const response = await apiApp({
      authenticate: async () => artifactsUser,
      canPushToRepo: canPushSpy,
      orgAdmin: async () => false,
    }).request('https://turbodiff.test/api/repos/303/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validSave),
    });
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
