/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { createPlan, upsertPushSubscription } from './db.ts';
import { notifyPlanUsers, sendPushToSubscription } from './push.ts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
// SAFETY: vitest.worker.config.ts defines the test-only TEST_MIGRATIONS
// miniflare binding, which the generated production Cloudflare.Env cannot
// know about.
const testEnv = env as TestEnv;

// Fixture client keys (a valid ECDH P-256 public point + 16-byte auth
// secret) — buildPushPayload derives a real shared secret from these, so
// arbitrary strings fail with "Point is not on curve" before fetch is ever
// called.
const P256DH =
  'BLrWn8rWI8dZelMSSqVi0rah4tWXjJ3LJB52reUt6_u7CmyZUqKPcJvr497BbuZSFQ2UGeHN2D4MUr0gapZwGrg';
const AUTH = 'QhkWkXwEh4Tj7XFNfBQnVg';

async function seedTenant(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api')`,
    ),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  const tables = [
    'push_subscriptions',
    'plan_repositories',
    'plans',
    'repositories',
    'installations',
  ];
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM "${table}"`)));
  await seedTenant();
});

describe('sendPushToSubscription', () => {
  it('returns gone on a 410 response', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 410 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await sendPushToSubscription(
        {
          id: 1,
          user_github_id: 3001,
          endpoint: 'https://push.example/dead',
          p256dh: P256DH,
          auth: AUTH,
          created_at: '',
        },
        { title: 'Turbodiff', body: 'hi', url: 'https://turbodiff.test/tasks/1' },
      );
      expect(result).toBe('gone');
      expect(fetchMock).toHaveBeenCalledWith('https://push.example/dead', expect.any(Object));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns sent on a 2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await sendPushToSubscription(
        {
          id: 1,
          user_github_id: 3001,
          endpoint: 'https://push.example/live',
          p256dh: P256DH,
          auth: AUTH,
          created_at: '',
        },
        { title: 'Turbodiff', body: 'hi', url: 'https://turbodiff.test/tasks/1' },
      );
      expect(result).toBe('sent');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never throws — a send error is swallowed as "error"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    try {
      const result = await sendPushToSubscription(
        {
          id: 1,
          user_github_id: 3001,
          endpoint: 'https://push.example/x',
          p256dh: P256DH,
          auth: AUTH,
          created_at: '',
        },
        { title: 'Turbodiff', body: 'hi', url: 'https://turbodiff.test/tasks/1' },
      );
      expect(result).toBe('error');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('notifyPlanUsers', () => {
  it('no-ops for an operator/API-created plan (no created_by_id)', async () => {
    const planId = await createPlan([101], 'Operator plan', 'Requirements');
    await upsertPushSubscription(3001, {
      endpoint: 'https://push.example/unrelated',
      p256dh: P256DH,
      auth: AUTH,
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await notifyPlanUsers(planId, { title: 't', body: 'b', url: 'u' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends to every subscription of the plan creator and prunes gone ones', async () => {
    const planId = await createPlan([101], 'Feature', 'Requirements', {
      login: 'octocat',
      id: 3001,
    });
    await upsertPushSubscription(3001, {
      endpoint: 'https://push.example/live',
      p256dh: P256DH,
      auth: AUTH,
    });
    await upsertPushSubscription(3001, {
      endpoint: 'https://push.example/dead',
      p256dh: P256DH,
      auth: AUTH,
    });
    // A different user's subscription must never be touched.
    await upsertPushSubscription(4001, {
      endpoint: 'https://push.example/other-user',
      p256dh: P256DH,
      auth: AUTH,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(null, { status: url.includes('dead') ? 410 : 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await notifyPlanUsers(planId, {
        title: 'Turbodiff',
        body: 'Needs input',
        url: 'https://turbodiff.test/tasks/1',
      });
      const calledEndpoints = fetchMock.mock.calls.map(([input]) => String(input)).sort();
      expect(calledEndpoints).toEqual(['https://push.example/dead', 'https://push.example/live']);
    } finally {
      vi.unstubAllGlobals();
    }

    const remaining = await testEnv.DB.prepare(
      'SELECT endpoint FROM push_subscriptions ORDER BY endpoint',
    ).all<{ endpoint: string }>();
    expect(remaining.results.map((r) => r.endpoint)).toEqual([
      'https://push.example/live',
      'https://push.example/other-user',
    ]);
  });
});
