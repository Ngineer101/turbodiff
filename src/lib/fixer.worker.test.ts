/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createFeature, setInstallationSuspended, updateFeature } from './db.ts';
import {
  fixLabel,
  processFixMessage,
  type FixOutcome,
  type FixProcessorDependencies,
  type FixQueueMessage,
} from './fixer.ts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
type ExecuteFix = NonNullable<FixProcessorDependencies['runFix']>;
// SAFETY: vitest.worker.config.ts defines the test-only TEST_MIGRATIONS
// miniflare binding, which the generated production Cloudflare.Env cannot
// know about.
const testEnv = env as TestEnv;

const ciMessage: FixQueueMessage = {
  kind: 'fix',
  repoId: 101,
  prNumber: 42,
  trigger: 'ci_failure',
  workflowRunId: 9001,
};

const noChanges: FixOutcome = {
  status: 'no_changes',
  authMode: 'gateway',
  branch: 'factory/feature-42',
  agentOutput: '',
  usage: null,
};

async function seedOpenFactoryPr(): Promise<number> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO repositories (id, installation_id, owner, name, enabled, auto_fix)
		 VALUES (101, 1001, 'acme', 'api', 1, 1)`,
    ),
  ]);
  const featureId = await createFeature(101, 'Factory feature', 'Implementation spec');
  await updateFeature(featureId, { status: 'pr_opened', prNumber: 42 });
  return featureId;
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  const tables = [
    'agent_runs',
    'fix_attempts',
    'verifications',
    'features',
    'repositories',
    'installations',
  ];
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM "${table}"`)));
});

describe('CI fix queue consumption', () => {
  it('threads the trigger and workflow run into the fixer and records the outcome', async () => {
    await seedOpenFactoryPr();
    const runFix = vi.fn<ExecuteFix>(async () => noChanges);

    await processFixMessage(ciMessage, { runFix });

    expect(runFix).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'api',
        prNumber: 42,
        installationId: 1001,
        repositoryId: 101,
        trigger: 'ci_failure',
        workflowRunId: 9001,
      }),
    );
    const attempt = await testEnv.DB.prepare(
      'SELECT "trigger", status FROM fix_attempts WHERE repository_id = 101 AND pr_number = 42',
    ).first<{ trigger: string; status: string }>();
    expect(attempt).toEqual({ trigger: 'ci_failure', status: 'no_changes' });
  });

  it('does not spend a fix attempt after the PR closes or installation is suspended', async () => {
    const featureId = await seedOpenFactoryPr();
    const runFix = vi.fn<ExecuteFix>(async () => noChanges);

    await updateFeature(featureId, { status: 'merged' });
    await processFixMessage(ciMessage, { runFix });

    await updateFeature(featureId, { status: 'pr_opened' });
    await setInstallationSuspended(1001, true);
    await processFixMessage(ciMessage, { runFix });

    expect(runFix).not.toHaveBeenCalled();
    const count = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM fix_attempts WHERE repository_id = 101 AND pr_number = 42',
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('fix labels', () => {
  it.each([
    ['ci_failure', 'failing CI checks'],
    ['verification_failed', 'unmet acceptance criteria'],
    ['blocking_review', 'review findings'],
    [undefined, 'review findings'],
  ])('labels %s as %s', (trigger, expected) => {
    expect(fixLabel(trigger)).toBe(expected);
  });
});
