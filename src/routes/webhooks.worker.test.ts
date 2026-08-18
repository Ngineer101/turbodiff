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
  finishFixAttempt,
  getFeature,
  tryRecordFixAttempt,
  tryRecordReview,
  updateFeature,
  type AgentRow,
  type RepositoryRow,
} from '../lib/db.ts';
import { FIX_MAX_ATTEMPTS } from '../lib/fixer.ts';
import type { JsonObject } from '../shared/json.ts';
import {
  createWebhookRoutes,
  type ReviewDispatcher,
  type WebhookRouteDependencies,
} from './webhooks.ts';

type TestEnv = Cloudflare.Env & {
  TEST_MIGRATIONS: D1Migration[];
  GITHUB_WEBHOOK_SECRET: string;
};
// SAFETY: vitest.worker.config.ts provisions the TEST_MIGRATIONS binding and
// the GITHUB_WEBHOOK_SECRET var for this pool on top of the generated
// Cloudflare.Env.
const testEnv = env as TestEnv;

function webhookApp(
  dispatch: ReviewDispatcher = async () => true,
  dependencies: WebhookRouteDependencies = {},
) {
  const app = new Hono();
  app.route(
    '/webhooks',
    createWebhookRoutes(dispatch, { computeRisk: async () => 'full', ...dependencies }),
  );
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

async function postWebhook(app: Hono, event: string, payload: JsonObject): Promise<Response> {
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

async function seedRepo(opts: { autoFix?: boolean } = {}): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO repositories (id, installation_id, owner, name, review_on_push, auto_fix)
		 VALUES (101, 1001, 'acme', 'api', 1, ?1)`,
    ).bind(opts.autoFix ? 1 : 0),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  const tables = [
    'agent_runs',
    'fix_attempts',
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

    const counts = await testEnv.DB.batch<{ n: number }>([
      testEnv.DB.prepare('SELECT COUNT(*) AS n FROM installations'),
      testEnv.DB.prepare('SELECT COUNT(*) AS n FROM repositories'),
      testEnv.DB.prepare('SELECT COUNT(*) AS n FROM agents'),
    ]);
    expect(counts.map((result) => result.results[0].n)).toEqual([1, 1, 4]);

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

describe('CI failure auto-fix', () => {
  function workflowRunPayload(overrides: {
    action?: string;
    conclusion?: string | null;
    prNumbers?: number[];
  }) {
    return {
      action: overrides.action ?? 'completed',
      workflow_run: {
        id: 9001,
        conclusion: overrides.conclusion ?? 'failure',
        pull_requests: (overrides.prNumbers ?? [42]).map((number) => ({ number })),
      },
      repository: { id: 101, full_name: 'acme/api' },
    };
  }

  async function openFactoryPr(prNumber: number): Promise<number> {
    const featureId = await createFeature(101, 'Factory feature', 'Implementation spec');
    await updateFeature(featureId, { status: 'pr_opened', prNumber });
    return featureId;
  }

  it('enqueues a fix for a failed CI run on an open factory PR', async () => {
    await seedRepo({ autoFix: true });
    await openFactoryPr(42);
    const enqueueFix = vi.fn<NonNullable<WebhookRouteDependencies['enqueueFix']>>(async () => {});

    const response = await postWebhook(
      webhookApp(undefined, { enqueueFix }),
      'workflow_run',
      workflowRunPayload({}),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fix_enqueued: 'acme/api#42' });
    expect(enqueueFix).toHaveBeenCalledExactlyOnceWith({
      kind: 'fix',
      repoId: 101,
      prNumber: 42,
      trigger: 'ci_failure',
      workflowRunId: 9001,
    });
  });

  it('ignores a run that did not conclude in failure', async () => {
    await seedRepo({ autoFix: true });
    await openFactoryPr(42);

    const response = await postWebhook(
      webhookApp(),
      'workflow_run',
      workflowRunPayload({ conclusion: 'success' }),
    );

    expect(await response.json()).toMatchObject({ ignored: 'conclusion success' });
  });

  it('skips when auto-fix is disabled for the repo', async () => {
    await seedRepo({ autoFix: false });
    await openFactoryPr(42);

    const response = await postWebhook(webhookApp(), 'workflow_run', workflowRunPayload({}));

    expect(await response.json()).toMatchObject({ skipped: 'auto-fix disabled for repo' });
  });

  it('skips when there is no matching open factory PR', async () => {
    await seedRepo({ autoFix: true });
    // No feature at all for this PR.
    const noFeatureResponse = await postWebhook(
      webhookApp(),
      'workflow_run',
      workflowRunPayload({}),
    );
    expect(await noFeatureResponse.json()).toMatchObject({ skipped: 'not an open factory PR' });

    // Feature exists but is no longer open.
    const featureId = await openFactoryPr(42);
    await updateFeature(featureId, { status: 'merged' });
    const mergedResponse = await postWebhook(webhookApp(), 'workflow_run', workflowRunPayload({}));
    expect(await mergedResponse.json()).toMatchObject({ skipped: 'not an open factory PR' });
  });

  it('skips once the fix attempt cap is reached', async () => {
    await seedRepo({ autoFix: true });
    await openFactoryPr(42);
    for (let i = 0; i < FIX_MAX_ATTEMPTS; i++) {
      // Each attempt must be finished (leave 'running') before the next is
      // recorded — tryRecordFixAttempt's single-flight guard blocks a new
      // attempt while one is still running for the same PR.
      const attemptId = await tryRecordFixAttempt(101, 42, 'blocking_review', FIX_MAX_ATTEMPTS);
      await finishFixAttempt(attemptId!, 'failed');
    }

    const response = await postWebhook(webhookApp(), 'workflow_run', workflowRunPayload({}));

    expect(await response.json()).toMatchObject({
      skipped: `fix cap reached (${FIX_MAX_ATTEMPTS})`,
    });
  });

  it('skips a run with no associated pull request', async () => {
    await seedRepo({ autoFix: true });

    const response = await postWebhook(
      webhookApp(),
      'workflow_run',
      workflowRunPayload({ prNumbers: [] }),
    );

    expect(await response.json()).toMatchObject({ skipped: 'no associated pull request' });
  });
});
