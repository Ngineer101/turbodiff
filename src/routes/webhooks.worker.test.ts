/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createFeature,
  ensureBuiltinAgents,
  getFeature,
  tryRecordReview,
  updateFeature,
  type AgentRow,
  type RepositoryRow,
} from '../lib/db.ts';
import { createWebhookRoutes, type ReviewDispatcher } from './webhooks.ts';

type TestEnv = Cloudflare.Env & {
  TEST_MIGRATIONS: D1Migration[];
  GITHUB_WEBHOOK_SECRET: string;
};
const testEnv = env as TestEnv;

function webhookApp(dispatch: ReviewDispatcher = async () => true) {
  const app = new Hono();
  app.route('/webhooks', createWebhookRoutes(dispatch, { computeRisk: async () => 'full' }));
  return app;
}

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(testEnv.GITHUB_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  return `sha256=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function postWebhook(
  app: Hono,
  event: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request('https://turbodiff.test/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': await signature(body),
    },
    body,
  });
}

async function seedRepo(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO repositories (id, installation_id, owner, name, review_on_push)
		 VALUES (101, 1001, 'acme', 'api', 1)`,
    ),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  const tables = [
    'agent_runs',
    'reviews',
    'repo_agents',
    'agents',
    'verifications',
    'features',
    'plan_repositories',
    'plans',
    'repositories',
    'installations',
  ];
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM "${table}"`)));
});

describe('GitHub webhook authentication and mirroring', () => {
  it('rejects an invalid signature without mutating D1', async () => {
    const payload = {
      action: 'created',
      installation: {
        id: 1001,
        account: { login: 'acme', id: 2001, type: 'Organization' },
      },
      repositories: [{ id: 101, name: 'api', full_name: 'acme/api' }],
    };
    const response = await webhookApp().request('https://turbodiff.test/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-hub-signature-256': 'sha256=invalid',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(401);
    expect(
      await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM installations').first<{ n: number }>(),
    ).toMatchObject({ n: 0 });
  });

  it('mirrors an installation idempotently and applies suspension changes', async () => {
    const created = {
      action: 'created',
      installation: {
        id: 1001,
        account: { login: 'acme', id: 2001, type: 'Organization' },
      },
      repositories: [{ id: 101, name: 'api', full_name: 'acme/api' }],
    };
    expect((await postWebhook(webhookApp(), 'installation', created)).status).toBe(200);
    expect((await postWebhook(webhookApp(), 'installation', created)).status).toBe(200);

    const counts = await testEnv.DB.batch([
      testEnv.DB.prepare('SELECT COUNT(*) AS n FROM installations'),
      testEnv.DB.prepare('SELECT COUNT(*) AS n FROM repositories'),
      testEnv.DB.prepare('SELECT COUNT(*) AS n FROM agents'),
    ]);
    expect(counts.map((result) => (result.results[0] as { n: number }).n)).toEqual([1, 1, 4]);

    const suspended = {
      action: 'suspend',
      installation: created.installation,
    };
    expect((await postWebhook(webhookApp(), 'installation', suspended)).status).toBe(200);
    const installation = await testEnv.DB.prepare(
      'SELECT suspended FROM installations WHERE id = 1001',
    ).first<{ suspended: number }>();
    expect(installation?.suspended).toBe(1);
  });
});

describe('factory PR webhook decisions', () => {
  it('never dispatches a human-opened pull request', async () => {
    await seedRepo();
    const dispatch = vi.fn<ReviewDispatcher>(async () => true);
    const response = await postWebhook(webhookApp(dispatch), 'pull_request', {
      action: 'opened',
      number: 42,
      pull_request: {
        draft: false,
        html_url: 'https://github.com/acme/api/pull/42',
      },
      repository: { id: 101, full_name: 'acme/api' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: 'not a factory PR' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches a factory PR once and debounces a push while its review is active', async () => {
    await seedRepo();
    await ensureBuiltinAgents(1001);
    const featureId = await createFeature(101, 'Factory feature', 'Implementation spec');
    await updateFeature(featureId, { status: 'pr_opened', prNumber: 42 });

    const calls: { agent: AgentRow; repo: RepositoryRow; trigger: string }[] = [];
    const dispatch: ReviewDispatcher = async (agent, repo, prNumber, _url, trigger, options) => {
      calls.push({ agent, repo, trigger });
      await tryRecordReview(
        repo.id,
        repo.installation_id,
        prNumber,
        trigger,
        agent.slug,
        `${agent.slug}--${repo.owner}--${repo.name}--${prNumber}`,
        options?.riskTier ?? null,
      );
      return true;
    };
    const opened = {
      action: 'opened',
      number: 42,
      pull_request: {
        draft: false,
        html_url: 'https://github.com/acme/api/pull/42',
      },
      repository: { id: 101, full_name: 'acme/api' },
    };
    const openedResponse = await postWebhook(webhookApp(dispatch), 'pull_request', opened);
    expect(await openedResponse.json()).toMatchObject({ tier: 'full', agents: ['review'] });

    const pushResponse = await postWebhook(webhookApp(dispatch), 'pull_request', {
      ...opened,
      action: 'synchronize',
    });
    expect(await pushResponse.json()).toMatchObject({
      skipped: 'all agents busy or within push debounce',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ trigger: 'opened' });
  });

  it('tracks merged closure without overwriting an explicit abandon', async () => {
    await seedRepo();
    const featureId = await createFeature(101, 'Factory feature', 'Implementation spec');
    await updateFeature(featureId, { status: 'pr_opened', prNumber: 55 });
    const closed = {
      action: 'closed',
      number: 55,
      pull_request: {
        draft: false,
        merged: true,
        html_url: 'https://github.com/acme/api/pull/55',
      },
      repository: { id: 101, full_name: 'acme/api' },
    };

    expect((await postWebhook(webhookApp(), 'pull_request', closed)).status).toBe(200);
    expect((await getFeature(featureId))?.status).toBe('merged');

    await updateFeature(featureId, { status: 'abandoned' });
    const abandonedResponse = await postWebhook(webhookApp(), 'pull_request', {
      ...closed,
      pull_request: { ...closed.pull_request, merged: false },
    });
    expect(await abandonedResponse.json()).toMatchObject({ ignored: 'already abandoned' });
    expect((await getFeature(featureId))?.status).toBe('abandoned');
  });
});
