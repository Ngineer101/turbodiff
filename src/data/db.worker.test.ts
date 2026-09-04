/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { testDatabase } from '../test/database-fixture.ts';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  addAssistantChatMessage,
  approvePlanFeatures,
  claimAutomation,
  createAutomation,
  createCockpitComment,
  createFeature,
  createVerification,
  createPlan,
  createPlanForTodo,
  createTodo,
  createUserChatMessage,
  deleteRepositoryRef,
  claimInstallationRepoSync,
  deletePushSubscriptionByEndpoint,
  deletePushSubscriptionById,
  dispatchOpenCockpitComments,
  finishFixAttempt,
  getChatMessage,
  getFeature,
  installationAccessSnapshot,
  hasPendingChatTurn,
  listChatMessages,
  listPushSubscriptionsForUser,
  listReposForPlan,
  pipelineCostByMonth,
  recentChatHistory,
  recordRepositoryRef,
  repositoryRef,
  repositoryRefs,
  setChatMessageStatus,
  setChatSessionId,
  tryRecordAutomationRun,
  tryRecordFixAttempt,
  markReviewFailed,
  tryRecordReview,
  completeReview,
  headHasCompletedReview,
  lastReviewedHead,
  latestCompletedReviewsByAgent,
  updatePlan,
  upsertInstallation,
  upsertPushSubscription,
  finishInstallationRepoSync,
  storeInstallationAccessSnapshot,
} from './db.ts';

async function seedTenant(): Promise<void> {
  await testDatabase().batch([
    testDatabase().prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ('user-1', 'Test User', 'user-1@example.test', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ),
    testDatabase().prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "githubId")
       VALUES ('push-3001', 'Push 3001', 'push-3001@example.test', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 3001),
              ('push-4001', 'Push 4001', 'push-4001@example.test', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 4001)`,
    ),
    testDatabase().prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testDatabase().prepare(
      `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api'), (102, 1001, 'acme', 'web')`,
    ),
  ]);
}

beforeEach(async () => {
  const tables = [
    'installation_repo_sync',
    'repository_refs',
    'user_installation_access',
    'push_subscriptions',
    'agent_runs',
    'chat_messages',
    'cockpit_comments',
    'verifications',
    'fix_attempts',
    'automation_runs',
    'automations',
    'repo_agents',
    'repo_skills',
    'repo_connections',
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
  await testDatabase().batch(
    tables.map((table) => testDatabase().prepare(`DELETE FROM "${table}"`)),
  );
  await seedTenant();
});

describe('installation mirroring', () => {
  it('replaces a stale GitHub installation when the account is reinstalled with a new id', async () => {
    await upsertInstallation(1002, { login: 'acme', id: 2001, type: 'Organization' }, 3001);

    const installations = await testDatabase()
      .prepare(
        `SELECT id, account_login, account_id, installer_github_id
         FROM installations ORDER BY id`,
      )
      .all<{
        id: number;
        account_login: string;
        account_id: number;
        installer_github_id: number | null;
      }>();
    expect(installations.results).toEqual([
      { id: 1002, account_login: 'acme', account_id: 2001, installer_github_id: 3001 },
    ]);

    const oldRepos = await testDatabase()
      .prepare('SELECT COUNT(*) AS count FROM repositories WHERE installation_id = 1001')
      .first<{ count: number }>();
    expect(oldRepos?.count).toBe(0);
  });
});

describe('performance state', () => {
  it('round-trips durable membership snapshots and rejects corrupt data', async () => {
    await storeInstallationAccessSnapshot('user-1', [1001, 2002]);
    const snapshot = await installationAccessSnapshot('user-1');
    expect(snapshot?.installationIds).toEqual([1001, 2002]);
    expect(snapshot?.verifiedAt).toBeGreaterThan(0);

    await expect(
      testDatabase()
        .prepare(
          `UPDATE user_installation_access
         SET installation_ids = ARRAY[1001::bigint, NULL] WHERE user_id = 'user-1'`,
        )
        .run(),
    ).rejects.toThrow();
    expect((await installationAccessSnapshot('user-1'))?.installationIds).toEqual([1001, 2002]);
  });

  it('records ref heads and serializes repository refresh claims across callers', async () => {
    await recordRepositoryRef(101, 'refs/heads/main', 'abc123', '2026-01-02T03:04:05Z');
    await recordRepositoryRef(101, 'refs/heads/main', 'def456', '2026-01-03T03:04:05Z');
    await recordRepositoryRef(101, 'refs/heads/topic', 'fedcba', '2026-01-03T03:04:06Z');
    expect(await repositoryRef(101, 'refs/heads/main')).toMatchObject({ head_sha: 'def456' });
    expect((await repositoryRefs(101)).map((ref) => ref.ref)).toEqual([
      'refs/heads/main',
      'refs/heads/topic',
    ]);
    await deleteRepositoryRef(101, 'refs/heads/topic');
    expect((await repositoryRefs(101)).map((ref) => ref.ref)).toEqual(['refs/heads/main']);

    const claims = await Promise.all(
      Array.from({ length: 6 }, () => claimInstallationRepoSync(1001)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await finishInstallationRepoSync(1001, true);
    expect(await claimInstallationRepoSync(1001)).toBe(false);
    await testDatabase()
      .prepare(
        `UPDATE installation_repo_sync SET last_synced_at = CURRENT_TIMESTAMP - INTERVAL '6 minutes'
		 WHERE installation_id = 1001`,
      )
      .run();
    expect(await claimInstallationRepoSync(1001)).toBe(true);
  });
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

    const count = await testDatabase()
      .prepare(
        'SELECT COUNT(*) AS count FROM fix_attempts WHERE repository_id = 101 AND pr_number = 7',
      )
      .first<{ count: number }>();
    expect(count?.count).toBe(3);
  });

  it('fails a stale run before admitting its replacement', async () => {
    const stale = await tryRecordFixAttempt(101, 8, 'blocking_review', 3);
    await testDatabase()
      .prepare(
        `UPDATE fix_attempts SET created_at = CURRENT_TIMESTAMP - INTERVAL '21 minutes' WHERE id = ?1`,
      )
      .bind(stale)
      .run();

    const replacement = await tryRecordFixAttempt(101, 8, 'blocking_review', 3);
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(stale);
    const old = await testDatabase()
      .prepare('SELECT status, error FROM fix_attempts WHERE id = ?1')
      .bind(stale)
      .first<{ status: string; error: string }>();
    expect(old).toMatchObject({ status: 'failed' });
    expect(old?.error).toContain('stale');
  });

  it('never counts chat turns against the automated fix cap', async () => {
    // Three finished chat turns — with FIX_MAX_ATTEMPTS = 3 they would
    // exhaust the cap if they counted.
    for (let i = 0; i < 3; i++) {
      const chat = await tryRecordFixAttempt(101, 7, 'chat', Number.MAX_SAFE_INTEGER, 'chat');
      expect(chat).not.toBeNull();
      await finishFixAttempt(chat!, 'fixed');
    }

    const fix = await tryRecordFixAttempt(101, 7, 'blocking_review', 3);
    expect(fix).not.toBeNull();
  });

  it('single-flights chat turns against fixes and other chat turns', async () => {
    const chat = await tryRecordFixAttempt(101, 7, 'chat', Number.MAX_SAFE_INTEGER, 'chat');
    expect(chat).not.toBeNull();
    expect(await tryRecordFixAttempt(101, 7, 'blocking_review', 3)).toBeNull();
    expect(await tryRecordFixAttempt(101, 7, 'chat', Number.MAX_SAFE_INTEGER, 'chat')).toBeNull();
    await finishFixAttempt(chat!, 'fixed');

    const fix = await tryRecordFixAttempt(101, 7, 'blocking_review', 3);
    expect(fix).not.toBeNull();
    expect(await tryRecordFixAttempt(101, 7, 'chat', Number.MAX_SAFE_INTEGER, 'chat')).toBeNull();
  });
});

describe('verification invariants', () => {
  it('fails a stale running verification before admitting its replacement', async () => {
    const featureId = await createFeature(101, 'Verify me', 'Check the implementation');
    const stale = await createVerification(featureId);
    await testDatabase()
      .prepare(
        `UPDATE verifications SET created_at = CURRENT_TIMESTAMP - INTERVAL '46 minutes' WHERE id = ?1`,
      )
      .bind(stale)
      .run();

    const replacement = await createVerification(featureId);
    expect(replacement).not.toBe(stale);
    const old = await testDatabase()
      .prepare('SELECT status, error FROM verifications WHERE id = ?1')
      .bind(stale)
      .first<{ status: string; error: string }>();
    expect(old).toMatchObject({ status: 'error' });
    expect(old?.error).toContain('replaced');
  });
});

describe('cockpit chat messages', () => {
  it('round-trips a turn: queued user row, status transitions, assistant reply', async () => {
    const featureId = await createFeature(101, 'Feature', 'Spec');
    const userId = await createUserChatMessage(featureId, 'Rename the button', 'octocat', 1);
    expect(await getChatMessage(userId)).toMatchObject({
      feature_id: featureId,
      role: 'user',
      body: 'Rename the button',
      author: 'octocat',
      author_id: 1,
      status: 'queued',
    });
    expect(await hasPendingChatTurn(featureId)).toBe(true);

    await setChatMessageStatus(userId, 'running');
    expect(await hasPendingChatTurn(featureId)).toBe(true);
    await addAssistantChatMessage(featureId, 'Done — renamed it.', 'changed', 'abc1234');
    await setChatMessageStatus(userId, 'done');
    expect(await hasPendingChatTurn(featureId)).toBe(false);

    const messages = await listChatMessages(featureId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]).toMatchObject({
      status: 'done',
      outcome: 'changed',
      commit_sha: 'abc1234',
    });
  });

  it('returns recent history oldest-first and persists the chat session id', async () => {
    const featureId = await createFeature(101, 'Feature', 'Spec');
    for (let i = 0; i < 25; i++) {
      const messageId = await createUserChatMessage(featureId, `msg ${i}`, 'octocat', 1);
      await setChatMessageStatus(messageId, 'done');
    }
    const history = await recentChatHistory(featureId, 20);
    expect(history).toHaveLength(20);
    expect(history[0].body).toBe('msg 5');
    expect(history.at(-1)?.body).toBe('msg 24');

    await setChatSessionId(featureId, 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb');
    expect((await getFeature(featureId))?.chat_session_id).toBe(
      'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    );
    await setChatSessionId(featureId, null);
    expect((await getFeature(featureId))?.chat_session_id).toBeNull();
  });
});

describe('review dispatch invariants', () => {
  it('records why a review failed', async () => {
    const id = await tryRecordReview(101, 1001, 12, 'opened', 'review', 'review--acme--api--12');
    await expect(
      markReviewFailed('review--acme--api--12', 'dispatch failed: boom'),
    ).resolves.toMatchObject({ stage_run_id: null });
    const row = await testDatabase()
      .prepare(`SELECT status, error FROM reviews WHERE id = ?1`)
      .bind(id)
      .first<{ status: string; error: string | null }>();
    expect(row).toEqual({ status: 'failed', error: 'dispatch failed: boom' });
  });

  it('admits exactly one concurrent claim for the same agent instance', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        tryRecordReview(101, 1001, 9, 'opened', 'review', 'review--acme--api--9'),
      ),
    );
    expect(results.filter((id) => id !== null)).toHaveLength(1);

    const count = await testDatabase()
      .prepare(
        `SELECT COUNT(*) AS count FROM reviews WHERE agent_instance_id = 'review--acme--api--9'`,
      )
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it('remembers each agent’s last verdict, the head it judged, and its findings’ files', async () => {
    const headA = 'a'.repeat(40);
    const headB = 'b'.repeat(40);
    const record = (slug: string, trigger: string, head: string | null) =>
      tryRecordReview(101, 1001, 13, trigger, slug, `${slug}--acme--api--13`, 'full', null, head);

    await record('review', 'opened', headA);
    await completeReview('review--acme--api--13', null, 1, 'approve', ['src/a.ts']);
    // A failed dispatch concluded nothing and must not count as a prior.
    await record('security', 'opened', headA);
    await markReviewFailed('security--acme--api--13', 'boom');
    // A row from before heads were tracked still carries its verdict.
    await tryRecordReview(101, 1001, 13, 'opened', 'a11y', 'a11y--acme--api--13');
    await completeReview('a11y--acme--api--13', null, 2, 'request_changes', ['src/x.ts']);
    // The newest completed row per agent wins.
    await record('review', 'synchronize', headB);
    await completeReview('review--acme--api--13', null, 0, 'approve', []);

    await expect(latestCompletedReviewsByAgent(101, 13)).resolves.toEqual([
      {
        agent_slug: 'a11y',
        verdict: 'request_changes',
        head_sha: null,
        finding_paths: ['src/x.ts'],
      },
      { agent_slug: 'review', verdict: 'approve', head_sha: headB, finding_paths: [] },
    ]);
    await expect(lastReviewedHead(101, 13)).resolves.toBe(headB);
    await expect(lastReviewedHead(101, 14)).resolves.toBeNull();
    await expect(headHasCompletedReview(101, 13, headA)).resolves.toBe(true);
    await expect(headHasCompletedReview(101, 13, 'c'.repeat(40))).resolves.toBe(false);
  });

  it('fails a stale running claim before admitting its replacement', async () => {
    const stale = await tryRecordReview(101, 1001, 10, 'opened', 'review', 'review--acme--api--10');
    await testDatabase()
      .prepare(
        `UPDATE reviews SET created_at = CURRENT_TIMESTAMP - INTERVAL '21 minutes' WHERE id = ?1`,
      )
      .bind(stale)
      .run();

    // A running claim younger than 20 minutes blocks a second insert outright.
    const blocked = await tryRecordReview(
      101,
      1001,
      11,
      'opened',
      'review',
      'review--acme--api--11',
    );
    expect(blocked).not.toBeNull();
    const blockedAgain = await tryRecordReview(
      101,
      1001,
      11,
      'opened',
      'review',
      'review--acme--api--11',
    );
    expect(blockedAgain).toBeNull();

    const replacement = await tryRecordReview(
      101,
      1001,
      10,
      'synchronize',
      'review',
      'review--acme--api--10',
    );
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(stale);
    const old = await testDatabase()
      .prepare('SELECT status FROM reviews WHERE id = ?1')
      .bind(stale)
      .first<{ status: string }>();
    expect(old).toMatchObject({ status: 'failed' });
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

  it('fails a stale automation run before admitting its replacement', async () => {
    const automationId = await createAutomation(
      101,
      {
        name: 'Dependency update',
        prompt: 'Update dependencies',
        schedule_kind: 'daily',
        time_of_day: '09:00',
        day_of_week: null,
      },
      '2026-08-14T09:00:00Z',
    );
    const stale = await tryRecordAutomationRun(automationId);
    await testDatabase()
      .prepare(
        `UPDATE automation_runs
         SET created_at = CURRENT_TIMESTAMP - INTERVAL '21 minutes'
         WHERE id = ?1`,
      )
      .bind(stale)
      .run();

    const replacement = await tryRecordAutomationRun(automationId);
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(stale);
    const old = await testDatabase()
      .prepare('SELECT status, error FROM automation_runs WHERE id = ?1')
      .bind(stale)
      .first<{ status: string; error: string | null }>();
    expect(old).toMatchObject({
      status: 'failed',
      error: 'stale: consumer killed before completion',
    });
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
    const count = await testDatabase()
      .prepare('SELECT COUNT(*) AS count FROM plans WHERE todo_id = ?1')
      .bind(todoId)
      .first<{ count: number }>();
    const todo = await testDatabase()
      .prepare('SELECT plan_id FROM todos WHERE id = ?1')
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
      acceptance: ['The feature works'],
    });
    const features = [101, 102].map((repositoryId) => ({
      repositoryId,
      title: 'Ship feature',
      spec: 'Implementation spec',
      acceptance: ['The feature works'],
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

    const rows = await testDatabase()
      .prepare('SELECT id, repository_id FROM features WHERE plan_id = ?1 ORDER BY repository_id')
      .bind(planId)
      .all<{ id: number; repository_id: number }>();
    const plan = await testDatabase()
      .prepare('SELECT status, feature_id FROM plans WHERE id = ?1')
      .bind(planId)
      .first<{ status: string; feature_id: number }>();
    expect(rows.results.map((row) => row.repository_id)).toEqual([101, 102]);
    expect(plan).toMatchObject({ status: 'approved', feature_id: rows.results[0].id });
    await expect(
      testDatabase()
        .prepare(
          `INSERT INTO features (repository_id, title, spec, plan_id)
		 VALUES (101, 'Duplicate', 'Must fail', ?1)`,
        )
        .bind(planId)
        .run(),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

describe('push subscriptions', () => {
  it('upserts on the endpoint, repointing an existing row to a new user', async () => {
    await upsertPushSubscription(3001, {
      endpoint: 'https://push.example/a',
      p256dh: 'p1',
      auth: 'a1',
    });
    await upsertPushSubscription(4001, {
      endpoint: 'https://push.example/a',
      p256dh: 'p2',
      auth: 'a2',
    });

    const rows = await listPushSubscriptionsForUser(4001);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_github_id: 4001,
      endpoint: 'https://push.example/a',
      p256dh: 'p2',
      auth: 'a2',
    });
    expect(await listPushSubscriptionsForUser(3001)).toHaveLength(0);
  });

  it('scopes deleteByEndpoint to the calling user', async () => {
    await upsertPushSubscription(3001, {
      endpoint: 'https://push.example/mine',
      p256dh: 'p',
      auth: 'a',
    });

    await deletePushSubscriptionByEndpoint(4001, 'https://push.example/mine');
    expect(await listPushSubscriptionsForUser(3001)).toHaveLength(1);

    await deletePushSubscriptionByEndpoint(3001, 'https://push.example/mine');
    expect(await listPushSubscriptionsForUser(3001)).toHaveLength(0);
  });

  it('deletes an expired subscription by id regardless of owner', async () => {
    await upsertPushSubscription(3001, {
      endpoint: 'https://push.example/x',
      p256dh: 'p',
      auth: 'a',
    });
    const [row] = await listPushSubscriptionsForUser(3001);

    await deletePushSubscriptionById(row.id);
    expect(await listPushSubscriptionsForUser(3001)).toHaveLength(0);
  });
});

describe('pipeline cost by month', () => {
  it('reports a month whose only spend is non-review, and scopes to the caller', async () => {
    await testDatabase().batch([
      testDatabase().prepare(
        `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (2002, 'other', 2002, 'Organization')`,
      ),
      testDatabase().prepare(
        `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (202, 2002, 'other', 'private')`,
      ),
      testDatabase().prepare(
        `INSERT INTO automations
           (id, repository_id, name, prompt, schedule_kind, time_of_day, next_run_at)
         VALUES (601, 101, 'Nightly', 'do the thing', 'daily', '09:00', '2026-01-01T00:00:00Z'),
                (602, 202, 'Theirs', 'not mine', 'daily', '09:00', '2026-01-01T00:00:00Z')`,
      ),
      testDatabase().prepare(
        `INSERT INTO automation_runs (automation_id, cost_usd, created_at)
		 VALUES (601, 0.25, '2026-03-04 05:06:07'),
		        (602, 9.99, '2026-03-04 05:06:07')`,
      ),
    ]);

    const rows = await pipelineCostByMonth([1001], 6);
    expect(rows).toHaveLength(1);
    expect(rows[0].month).toBe('2026-03');
    expect(rows[0].cost_usd).toBeCloseTo(0.25, 6);
  });

  it('orders months newest first', async () => {
    await testDatabase().batch([
      testDatabase().prepare(
        `INSERT INTO reviews (repository_id, installation_id, pr_number, trigger_event, cost_usd, created_at)
		 VALUES (101, 1001, 7, 'opened', 0.5, '2026-01-15 00:00:00'),
		        (101, 1001, 8, 'opened', 0.75, '2026-02-15 00:00:00')`,
      ),
    ]);

    const rows = await pipelineCostByMonth([1001], 6);
    expect(rows.map((r) => r.month)).toEqual(['2026-02', '2026-01']);
  });
});
