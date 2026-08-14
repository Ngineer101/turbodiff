/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import {
  approvePlanFeatures,
  claimAutomation,
  createAutomation,
  createCockpitComment,
  createFeature,
  createPlan,
  createPlanForTodo,
  createTodo,
  dispatchOpenCockpitComments,
  finishFixAttempt,
  listReposForPlan,
  tryRecordAutomationRun,
  tryRecordFixAttempt,
  updatePlan,
} from './db.ts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
const testEnv = env as TestEnv;

async function seedTenant(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api'), (102, 1001, 'acme', 'web')`,
    ),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  const tables = [
    'agent_runs',
    'cockpit_comments',
    'verifications',
    'fix_attempts',
    'automation_runs',
    'automations',
    'repo_agents',
    'repo_skills',
    'agent_connection_links',
    'connections',
    'skills',
    'agents',
    'reviews',
    'todo_repositories',
    'plan_repositories',
    'features',
    'todos',
    'plans',
    'repositories',
    'installations',
    'session',
    'account',
    'verification',
    'user',
    'user_tokens',
  ];
  await testEnv.DB.batch(tables.map((table) => testEnv.DB.prepare(`DELETE FROM "${table}"`)));
  await seedTenant();
});

describe('fix attempt invariants', () => {
  it('admits one concurrent run and never exceeds the attempt cap', async () => {
    const first = await Promise.all(
      Array.from({ length: 8 }, () => tryRecordFixAttempt(101, 7, 'blocking_review', 3)),
    );
    expect(first.filter((id) => id !== null)).toHaveLength(1);

    await finishFixAttempt(
      first.find((id): id is number => id !== null)!,
      'failed',
    );
    const second = await tryRecordFixAttempt(101, 7, 'blocking_review', 3);
    expect(second).not.toBeNull();
    await finishFixAttempt(second!, 'failed');
    const third = await tryRecordFixAttempt(101, 7, 'blocking_review', 3);
    expect(third).not.toBeNull();
    await finishFixAttempt(third!, 'failed');
    expect(await tryRecordFixAttempt(101, 7, 'blocking_review', 3)).toBeNull();

    const count = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS count FROM fix_attempts WHERE repository_id = 101 AND pr_number = 7',
    ).first<{ count: number }>();
    expect(count?.count).toBe(3);
  });

  it('fails a stale run before admitting its replacement', async () => {
    const stale = await tryRecordFixAttempt(101, 8, 'blocking_review', 3);
    await testEnv.DB.prepare(
      `UPDATE fix_attempts SET created_at = datetime('now', '-21 minutes') WHERE id = ?1`,
    )
      .bind(stale)
      .run();

    const replacement = await tryRecordFixAttempt(101, 8, 'blocking_review', 3);
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(stale);
    const old = await testEnv.DB.prepare('SELECT status, error FROM fix_attempts WHERE id = ?1')
      .bind(stale)
      .first<{ status: string; error: string }>();
    expect(old).toMatchObject({ status: 'failed' });
    expect(old?.error).toContain('stale');
  });
});

describe('single-flight database claims', () => {
  it('dispatches each cockpit comment exactly once under concurrent submits', async () => {
    const featureId = await createFeature(101, 'Feature', 'Spec');
    const commentIds = await Promise.all([
      createCockpitComment(featureId, 'src/a.ts', 10, 'additions', 'Fix A', 'octocat', 1),
      createCockpitComment(featureId, 'src/b.ts', 20, 'additions', 'Fix B', 'octocat', 1),
    ]);

    const claims = await Promise.all([
      dispatchOpenCockpitComments(featureId),
      dispatchOpenCockpitComments(featureId),
    ]);
    const claimedIds = claims.flat().map((comment) => comment.id);
    expect(claimedIds.sort((a, b) => a - b)).toEqual(commentIds.sort((a, b) => a - b));
    expect(new Set(claimedIds).size).toBe(2);
  });

  it('lets one poll claim an automation and one run enter flight', async () => {
    const automationId = await createAutomation(
      101,
      {
        name: 'Dependency update',
        prompt: 'Update dependencies',
        schedule_kind: 'daily',
        time_of_day: '09:00',
        day_of_week: null,
      },
      '2026-08-14 09:00:00',
    );
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimAutomation(automationId, '2026-08-15 09:00:00', '2026-08-14 10:00:00'),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    const runs = await Promise.all(
      Array.from({ length: 8 }, () => tryRecordAutomationRun(automationId)),
    );
    expect(runs.filter((id) => id !== null)).toHaveLength(1);
  });
});

describe('paid-work idempotency', () => {
  it('starts a todo once and preserves its ordered repository set', async () => {
    const todoId = await createTodo(1001, 'Build it', null, { login: 'octocat', id: 1 });
    const starts = await Promise.all([
      createPlanForTodo(todoId, [101, 102], 'Build it', 'Requirements', {
        login: 'octocat',
        id: 1,
      }),
      createPlanForTodo(todoId, [101, 102], 'Build it', 'Requirements', {
        login: 'octocat',
        id: 1,
      }),
    ]);

    expect(starts.filter((result) => result?.created)).toHaveLength(1);
    expect(new Set(starts.map((result) => result?.planId))).toHaveLength(1);
    const planId = starts[0]!.planId;
    const count = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM plans WHERE todo_id = ?1')
      .bind(todoId)
      .first<{ count: number }>();
    const todo = await testEnv.DB.prepare('SELECT plan_id FROM todos WHERE id = ?1')
      .bind(todoId)
      .first<{ plan_id: number }>();
    expect(count?.count).toBe(1);
    expect(todo?.plan_id).toBe(planId);
    expect((await listReposForPlan(planId)).map((repo) => repo.id)).toEqual([101, 102]);
  });

  it('approves a multi-repo plan once and creates one feature per repository', async () => {
    const planId = await createPlan([101, 102], 'Ship feature', 'Requirements', {
      login: 'creator',
      id: 1,
    });
    await updatePlan(planId, {
      status: 'plan_ready',
      plan: '## acme/api\nChange API.\n\n## acme/web\nChange web.',
      acceptance: '["The feature works"]',
    });
    const features = [101, 102].map((repositoryId) => ({
      repositoryId,
      title: 'Ship feature',
      spec: 'Implementation spec',
      acceptance: '["The feature works"]',
      authorLogin: 'approver',
      authorId: 2,
      coauthorLogin: 'creator',
      coauthorId: 1,
      tier: 'standard',
    }));

    const approvals = await Promise.all([
      approvePlanFeatures(planId, features),
      approvePlanFeatures(planId, features),
    ]);
    expect(approvals.filter((ids) => ids !== null)).toHaveLength(1);
    expect(approvals.find((ids) => ids !== null)).toHaveLength(2);

    const rows = await testEnv.DB.prepare(
      'SELECT id, repository_id FROM features WHERE plan_id = ?1 ORDER BY repository_id',
    )
      .bind(planId)
      .all<{ id: number; repository_id: number }>();
    const plan = await testEnv.DB.prepare('SELECT status, feature_id FROM plans WHERE id = ?1')
      .bind(planId)
      .first<{ status: string; feature_id: number }>();
    expect(rows.results.map((row) => row.repository_id)).toEqual([101, 102]);
    expect(plan).toMatchObject({ status: 'approved', feature_id: rows.results[0].id });
    await expect(
      testEnv.DB.prepare(
        `INSERT INTO features (repository_id, title, spec, plan_id)
		 VALUES (101, 'Duplicate', 'Must fail', ?1)`,
      )
        .bind(planId)
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
