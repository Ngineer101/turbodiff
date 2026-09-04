/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers';
import { testDatabase } from '../test/database-fixture.ts';
// Transport-level coverage for authenticated GitHub deliveries.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createFeature,
  createFactoryRunWithStage,
  ensureBuiltinAgents,
  finishFixAttempt,
  getChangeByProviderKey,
  getFactoryRun,
  getFeature,
  getStageRun,
  latestAcceptanceContractForChange,
  listFactoryRunsForFeature,
  listStageRuns,
  tryRecordFixAttempt,
  tryRecordReview,
  updateFeature,
  upsertChange,
} from '../data/db.ts';
import { FIX_MAX_ATTEMPTS, type FactoryMessage } from '../shared/factory-messages.ts';
import type { RunStageCommand } from '../domain/lifecycle-contract.ts';
import type { JsonObject } from '../shared/json.ts';
import { createWebhookRoutes, type WebhookRouteDependencies } from './webhooks.ts';
import type { ReviewDispatcher } from '../services/change-review.ts';
import {
  completeLifecycleRepair,
  completeLifecycleReview,
  completeLifecycleStage,
  failLifecycleReview,
  resumeFailedStage,
  runLifecycleStage,
  scheduleFeatureDelivery,
} from '../services/lifecycle.ts';

type TestEnv = Cloudflare.Env & { GITHUB_WEBHOOK_SECRET: string };
interface ScheduledReviewBody {
  run: number;
  stage_run: number;
}
// SAFETY: the Worker test config provides this fixture secret at runtime.
const testEnv = env as TestEnv;

function webhookApp(dependencies: WebhookRouteDependencies = {}) {
  const app = new Hono();
  app.route('/webhooks', createWebhookRoutes(dependencies));
  return app;
}

function stageCommands(messages: FactoryMessage[]): RunStageCommand[] {
  return messages.filter((message): message is RunStageCommand => message.kind === 'run_stage');
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

async function seedRepo(
  opts: {
    autoFix?: boolean;
    reviewIntake?: 'factory_only' | 'on_demand' | 'all_changes';
    processProfile?: 'review_and_repair';
    pushDebounceMinutes?: number;
  } = {},
): Promise<void> {
  const reviewIntake = opts.reviewIntake ?? 'factory_only';
  const processProfile =
    opts.processProfile ??
    (reviewIntake === 'all_changes'
      ? 'automatic_review'
      : reviewIntake === 'on_demand'
        ? 'review_on_demand'
        : 'legacy_factory');
  await testDatabase().batch([
    testDatabase().prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testDatabase()
      .prepare(
        `INSERT INTO repositories
          (id, installation_id, owner, name, review_on_push, auto_fix, review_intake,
           process_profile, review_push_debounce_minutes)
       VALUES (101, 1001, 'acme', 'api', TRUE, ?1, ?2, ?3, ?4)`,
      )
      .bind(opts.autoFix ?? false, reviewIntake, processProfile, opts.pushDebounceMinutes ?? 10),
  ]);
}

beforeEach(async () => {
  const tables = [
    'agent_runs',
    'lifecycle_events',
    'stage_runs',
    'factory_runs',
    'acceptance_contracts',
    'work_items',
    'changes',
    'fix_attempts',
    'reviews',
    'repo_agents',
    'agents',
    'verifications',
    'features',
    'plan_repositories',
    'plans',
    'repositories',
    'member',
    'invitation',
    'organization',
    'installations',
    'user',
  ];
  await testDatabase().batch(
    tables.map((table) => testDatabase().prepare(`DELETE FROM "${table}"`)),
  );
});

describe('GitHub webhook authentication and mirroring', () => {
  it('rejects an invalid signature without mutating PostgreSQL', async () => {
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
      await testDatabase()
        .prepare('SELECT COUNT(*) AS n FROM installations')
        .first<{ n: number }>(),
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

    const counts = await testDatabase().batch<{ n: number }>([
      testDatabase().prepare('SELECT COUNT(*) AS n FROM installations'),
      testDatabase().prepare('SELECT COUNT(*) AS n FROM repositories'),
      testDatabase().prepare('SELECT COUNT(*) AS n FROM agents'),
    ]);
    expect(counts.map((result) => result.results[0].n)).toEqual([1, 1, 4]);

    const suspended = {
      action: 'suspend',
      installation: created.installation,
    };
    expect((await postWebhook(webhookApp(), 'installation', suspended)).status).toBe(200);
    const installation = await testDatabase()
      .prepare('SELECT suspended FROM installations WHERE id = 1001')
      .first<{ suspended: boolean }>();
    expect(installation?.suspended).toBe(true);
  });

  it('provisions a linked organization and records the installer as owner', async () => {
    // The installer already has a better-auth user row (they signed in to
    // reach the settings page before installing the app on GitHub).
    await testDatabase()
      .prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", login, "githubId")
			 VALUES ('u1', 'octocat', 'octocat@example.test', true, '2026-01-01T00:00:00.000Z',
			         '2026-01-01T00:00:00.000Z', 'octocat', 3001)`,
      )
      .run();

    const created = {
      action: 'created',
      installation: {
        id: 1001,
        account: { login: 'acme', id: 2001, type: 'Organization' },
      },
      sender: { id: 3001, login: 'octocat' },
      repositories: [{ id: 101, name: 'api', full_name: 'acme/api' }],
    };
    expect((await postWebhook(webhookApp(), 'installation', created)).status).toBe(200);

    const org = await testDatabase()
      .prepare('SELECT id, name, "installationId" AS installation_id FROM "organization"')
      .first<{ id: string; name: string; installation_id: number }>();
    expect(org).toMatchObject({ name: 'acme', installation_id: 1001 });

    const member = await testDatabase()
      .prepare('SELECT role FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2')
      .bind(org?.id, 'u1')
      .first<{ role: string }>();
    expect(member?.role).toBe('owner');
  });

  it('does not provision an organization for a personal (User-type) installation', async () => {
    const created = {
      action: 'created',
      installation: {
        id: 1002,
        account: { login: 'octocat', id: 4001, type: 'User' },
      },
      sender: { id: 4001, login: 'octocat' },
      repositories: [],
    };
    expect((await postWebhook(webhookApp(), 'installation', created)).status).toBe(200);

    const org = await testDatabase()
      .prepare('SELECT COUNT(*) AS n FROM "organization" WHERE "installationId" = 1002')
      .first<{ n: number }>();
    expect(org?.n).toBe(0);
  });

  it('provisions the organization without an owner when the installer has never signed in', async () => {
    const created = {
      action: 'created',
      installation: {
        id: 1001,
        account: { login: 'acme', id: 2001, type: 'Organization' },
      },
      sender: { id: 9999, login: 'never-signed-in' },
      repositories: [],
    };
    expect((await postWebhook(webhookApp(), 'installation', created)).status).toBe(200);

    const org = await testDatabase()
      .prepare('SELECT id FROM "organization" WHERE "installationId" = 1001')
      .first<{ id: string }>();
    expect(org).toBeTruthy();
    const memberCount = await testDatabase()
      .prepare('SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?1')
      .bind(org?.id)
      .first<{ n: number }>();
    expect(memberCount?.n).toBe(0);

    // …but the installer's identity is recorded, so the deferred owner
    // bootstrap (ensureInstallerOwner) can promote them once they sign in.
    const installation = await testDatabase()
      .prepare('SELECT installer_github_id FROM installations WHERE id = 1001')
      .first<{ installer_github_id: number | null }>();
    expect(installation?.installer_github_id).toBe(9999);
  });

  it('keeps the recorded installer through deliveries that carry no sender', async () => {
    const created = {
      action: 'created',
      installation: {
        id: 1001,
        account: { login: 'acme', id: 2001, type: 'Organization' },
      },
      sender: { id: 9999, login: 'never-signed-in' },
      repositories: [],
    };
    expect((await postWebhook(webhookApp(), 'installation', created)).status).toBe(200);
    const reposChanged = {
      action: 'added',
      installation: created.installation,
      repositories_added: [{ id: 101, name: 'api', full_name: 'acme/api' }],
    };
    expect(
      (await postWebhook(webhookApp(), 'installation_repositories', reposChanged)).status,
    ).toBe(200);

    const installation = await testDatabase()
      .prepare('SELECT installer_github_id FROM installations WHERE id = 1001')
      .first<{ installer_github_id: number | null }>();
    expect(installation?.installer_github_id).toBe(9999);
  });
});

describe('composable feature delivery', () => {
  it('coordinates an approved idea through implementation and publish, then hands off', async () => {
    await seedRepo();
    await testDatabase()
      .prepare(
        `UPDATE repositories
         SET process_profile = 'idea_to_pr', review_intake = 'on_demand'
         WHERE id = 101`,
      )
      .run();
    const featureId = await createFeature(
      101,
      'Composable delivery',
      'Implement the agreed behavior',
      ['The behavior is covered by tests'],
    );
    const queued: FactoryMessage[] = [];
    const enqueue = async (message: FactoryMessage) => void queued.push(message);

    await expect(scheduleFeatureDelivery(featureId, enqueue)).resolves.toBe(true);
    await expect(scheduleFeatureDelivery(featureId, enqueue)).resolves.toBe(true);
    const implementCommands = stageCommands(queued);
    expect(implementCommands).toHaveLength(2);
    expect(implementCommands[1]).toEqual(implementCommands[0]);

    const dispatch = vi.fn<ReviewDispatcher>(async () => true);
    await runLifecycleStage(implementCommands[0], dispatch, { enqueue });
    await runLifecycleStage(implementCommands[1], dispatch, { enqueue });
    expect(queued.filter((message) => message.kind === 'generate')).toEqual([
      {
        kind: 'generate',
        featureId,
        factoryRunId: implementCommands[0].factoryRunId,
        stageRunId: implementCommands[0].stageRunId,
      },
    ]);

    const change = await upsertChange({
      repositoryId: 101,
      providerKey: 'github:91',
      number: 91,
      origin: 'factory',
      title: 'Composable delivery',
      externalUrl: 'https://github.com/acme/api/pull/91',
      sourceBranch: 'turbodiff/feature-91',
      targetBranch: 'main',
      status: 'open',
      sourceHead: 'a'.repeat(40),
      targetHead: 'b'.repeat(40),
      draft: false,
      capabilities: ['read_change', 'publish_review', 'write_head', 'publish_check', 'merge'],
    });
    await updateFeature(featureId, {
      status: 'pr_opened',
      prNumber: 91,
      changeId: change.id,
    });
    await completeLifecycleStage(
      implementCommands[0].stageRunId,
      'implement',
      true,
      { kind: 'change_published', featureId },
      {},
      enqueue,
    );

    const publishCommand = stageCommands(queued).find((command) => command.stage === 'publish');
    expect(publishCommand).toBeDefined();
    await runLifecycleStage(publishCommand!, dispatch, { enqueue });

    await expect(getFactoryRun(implementCommands[0].factoryRunId)).resolves.toMatchObject({
      change_id: change.id,
      work_item_id: expect.any(Number),
      status: 'handed_off',
      handoff_reason: 'requested stop boundary reached',
    });
    await expect(listFactoryRunsForFeature(featureId)).resolves.toMatchObject([
      { id: implementCommands[0].factoryRunId, profile_key: 'idea_to_pr' },
    ]);
    await expect(listStageRuns(implementCommands[0].factoryRunId)).resolves.toMatchObject([
      { stage: 'implement', status: 'completed', input: { featureId } },
      { stage: 'publish', status: 'completed', change_id: change.id, input: { featureId } },
    ]);
    await expect(latestAcceptanceContractForChange(change.id)).resolves.toMatchObject({
      version: 1,
      criteria: ['The behavior is covered by tests'],
      source: 'feature.acceptance',
    });
  });

  it('retries a stopped implementation as a fresh attempt on the same delivery run', async () => {
    await seedRepo();
    await testDatabase()
      .prepare(`UPDATE repositories SET process_profile = 'full_delivery' WHERE id = 101`)
      .run();
    const featureId = await createFeature(101, 'Retried delivery', 'Fix the flash', ['No flash']);
    const queued: FactoryMessage[] = [];
    const enqueue = async (message: FactoryMessage) => void queued.push(message);
    const dispatch = vi.fn<ReviewDispatcher>(async () => true);

    await expect(scheduleFeatureDelivery(featureId, enqueue)).resolves.toBe(true);
    const [first] = stageCommands(queued);
    await runLifecycleStage(first, dispatch, { enqueue });
    // The generation ran, failed its checks, and settled the stage.
    await updateFeature(featureId, { status: 'checks_failed', error: 'vp: command not found' });
    await completeLifecycleStage(
      first.stageRunId,
      'implement',
      false,
      { kind: 'checks_failed', featureId },
      {},
      enqueue,
    );
    await expect(getFactoryRun(first.factoryRunId)).resolves.toMatchObject({
      status: 'awaiting_human',
    });

    // The retry route re-sends the approval's plain generate message, which
    // the consumer routes back through scheduleFeatureDelivery.
    await updateFeature(featureId, { error: 'retry queued' });
    queued.length = 0;
    await expect(scheduleFeatureDelivery(featureId, enqueue)).resolves.toBe(true);
    const [retry] = stageCommands(queued);
    expect(retry).toMatchObject({
      stage: 'implement',
      factoryRunId: first.factoryRunId,
      idempotencyKey: `${first.factoryRunId}:implement:2`,
    });
    expect(retry.stageRunId).not.toBe(first.stageRunId);
    await expect(getFactoryRun(first.factoryRunId)).resolves.toMatchObject({
      status: 'active',
      handoff_reason: null,
    });

    // A duplicate delivery of the same retry re-sends the scheduled attempt
    // instead of adding another.
    await expect(scheduleFeatureDelivery(featureId, enqueue)).resolves.toBe(true);
    expect(stageCommands(queued)).toEqual([retry, retry]);

    await runLifecycleStage(retry, dispatch, { enqueue });
    expect(queued.filter((message) => message.kind === 'generate')).toEqual([
      {
        kind: 'generate',
        featureId,
        factoryRunId: first.factoryRunId,
        stageRunId: retry.stageRunId,
      },
    ]);
    await expect(listStageRuns(first.factoryRunId)).resolves.toMatchObject([
      { stage: 'implement', attempt: 1, status: 'failed' },
      { stage: 'implement', attempt: 2, status: 'running', input: { featureId } },
    ]);

    // A stage left 'running' by a generation the strand sweep gave up on is
    // settled as failed and retried the same way.
    await testDatabase()
      .prepare(
        `UPDATE app.stage_runs SET started_at = CURRENT_TIMESTAMP - INTERVAL '2 hours'
         WHERE id = ?1`,
      )
      .bind(retry.stageRunId)
      .run();
    await updateFeature(featureId, {
      status: 'failed',
      error: 'generation run was killed — retry',
    });
    queued.length = 0;
    await expect(scheduleFeatureDelivery(featureId, enqueue)).resolves.toBe(true);
    const [third] = stageCommands(queued);
    expect(third).toMatchObject({
      stage: 'implement',
      idempotencyKey: `${first.factoryRunId}:implement:3`,
    });
    await expect(listStageRuns(first.factoryRunId)).resolves.toMatchObject([
      { attempt: 1, status: 'failed' },
      { attempt: 2, status: 'failed', error: 'generation run was killed — retry' },
      { attempt: 3, status: 'queued' },
    ]);
  });

  it('surfaces why a review stage failed and lets a human retry it on the same run', async () => {
    await seedRepo();
    await ensureBuiltinAgents(1001);
    const featureId = await createFeature(101, 'Reviewed delivery', 'Ship it', ['It works']);
    const change = await upsertChange({
      repositoryId: 101,
      providerKey: 'github:43',
      number: 43,
      origin: 'factory',
      title: 'Reviewed delivery',
      externalUrl: 'https://github.com/acme/api/pull/43',
      sourceBranch: 'turbodiff/feature-43',
      targetBranch: 'main',
      status: 'open',
      sourceHead: 'e'.repeat(40),
      targetHead: 'f'.repeat(40),
      draft: false,
      capabilities: ['read_change', 'publish_review', 'write_head', 'publish_check', 'merge'],
    });
    await updateFeature(featureId, { status: 'pr_opened', prNumber: 43, changeId: change.id });
    const created = await createFactoryRunWithStage({
      repositoryId: 101,
      changeId: change.id,
      profileKey: 'full_delivery',
      startStage: 'review',
      stopAfterStage: 'merge',
      policySnapshot: { key: 'full_delivery' },
      trigger: 'test',
      eventKind: 'human.resume_requested',
      decision: { kind: 'schedule', stage: 'review' },
      idempotencyKey: `review-delivery:${featureId}`,
      stageInput: { featureId },
    });
    const queued: FactoryMessage[] = [];
    const enqueue = async (message: FactoryMessage) => void queued.push(message);
    const dispatch: ReviewDispatcher = async (agent, repo, prNumber, _url, trigger, options) => {
      await tryRecordReview(
        repo.id,
        repo.installation_id,
        prNumber,
        trigger,
        agent.slug,
        `${agent.slug}--${repo.owner}--${repo.name}--${prNumber}`,
        options?.riskTier ?? null,
        options?.stageRunId ?? null,
      );
      return true;
    };
    const command: RunStageCommand = {
      kind: 'run_stage',
      factoryRunId: created.run.id,
      stageRunId: created.stageRun!.id,
      stage: 'review',
      idempotencyKey: created.stageRun!.idempotency_key,
      changeId: change.id,
    };
    await runLifecycleStage(command, dispatch, { computeRisk: async () => 'full', enqueue });

    // The agent dies before posting: the settlement reason lands on the
    // review row and on the stage the lifecycle panel shows.
    await failLifecycleReview('review--acme--api--43', 'failed: AiError: model not found', enqueue);
    await expect(getStageRun(created.stageRun!.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'all review dispatches failed: failed: AiError: model not found',
      output: { completed: 0, failed: 1, errors: ['failed: AiError: model not found'] },
    });
    await expect(getFactoryRun(created.run.id)).resolves.toMatchObject({
      status: 'awaiting_human',
    });

    // A human retries the stage: a fresh attempt on the same run, so verify
    // and merge still follow it.
    queued.length = 0;
    await expect(resumeFailedStage(created.run.id, 'nico', enqueue)).resolves.toMatchObject({
      kind: 'scheduled',
      stage: 'review',
      attempt: 2,
    });
    await expect(getFactoryRun(created.run.id)).resolves.toMatchObject({
      status: 'active',
      handoff_reason: null,
    });
    expect(stageCommands(queued)).toMatchObject([
      {
        stage: 'review',
        factoryRunId: created.run.id,
        idempotencyKey: `${created.run.id}:review:2`,
        changeId: change.id,
      },
    ]);
    await expect(listStageRuns(created.run.id)).resolves.toMatchObject([
      { stage: 'review', attempt: 1, status: 'failed' },
      { stage: 'review', attempt: 2, status: 'queued', input: { featureId } },
    ]);
    // Only a parked run can be retried.
    await expect(resumeFailedStage(created.run.id, 'nico', enqueue)).resolves.toMatchObject({
      kind: 'rejected',
    });
  });

  it('hands verified delivery to the merge executor and completes the run', async () => {
    await seedRepo();
    const featureId = await createFeature(101, 'Verified delivery', 'Ship it', [
      'The check passes',
    ]);
    const change = await upsertChange({
      repositoryId: 101,
      providerKey: 'github:92',
      number: 92,
      origin: 'factory',
      title: 'Verified delivery',
      externalUrl: 'https://github.com/acme/api/pull/92',
      sourceBranch: 'turbodiff/feature-92',
      targetBranch: 'main',
      status: 'open',
      sourceHead: 'c'.repeat(40),
      targetHead: 'd'.repeat(40),
      draft: false,
      capabilities: ['read_change', 'publish_review', 'write_head', 'publish_check', 'merge'],
    });
    await updateFeature(featureId, {
      status: 'pr_opened',
      prNumber: 92,
      changeId: change.id,
    });
    const created = await createFactoryRunWithStage({
      repositoryId: 101,
      changeId: change.id,
      profileKey: 'full_delivery',
      startStage: 'verify',
      stopAfterStage: 'merge',
      policySnapshot: { key: 'full_delivery' },
      trigger: 'test',
      eventKind: 'human.resume_requested',
      decision: { kind: 'schedule', stage: 'verify' },
      idempotencyKey: `verify-delivery:${featureId}`,
      stageInput: { featureId },
    });
    expect(created.stageRun).not.toBeNull();
    const queued: FactoryMessage[] = [];
    const enqueue = async (message: FactoryMessage) => void queued.push(message);
    const verifyCommand: RunStageCommand = {
      kind: 'run_stage',
      factoryRunId: created.run.id,
      stageRunId: created.stageRun!.id,
      stage: 'verify',
      changeId: change.id,
      idempotencyKey: created.stageRun!.idempotency_key,
    };
    const dispatch = vi.fn<ReviewDispatcher>(async () => true);

    await runLifecycleStage(verifyCommand, dispatch, { enqueue });
    expect(queued).toContainEqual({
      kind: 'verify',
      featureId,
      factoryRunId: created.run.id,
      stageRunId: created.stageRun!.id,
    });
    await completeLifecycleStage(
      created.stageRun!.id,
      'verify',
      true,
      { kind: 'verification_completed', status: 'passed' },
      { verificationPassed: true },
      enqueue,
    );
    const mergeCommand = stageCommands(queued).find((command) => command.stage === 'merge');
    expect(mergeCommand).toBeDefined();
    const mergeGithub = vi.fn(async () => {});
    await runLifecycleStage(mergeCommand!, dispatch, { enqueue, mergeGithub });

    expect(mergeGithub).toHaveBeenCalledExactlyOnceWith(101, 92);
    await expect(getFactoryRun(created.run.id)).resolves.toMatchObject({ status: 'completed' });
    await expect(getStageRun(mergeCommand!.stageRunId)).resolves.toMatchObject({
      status: 'completed',
    });
  });
});

describe('factory PR webhook decisions', () => {
  it('canonicalizes but never schedules a human-opened pull request', async () => {
    await seedRepo();
    const queued: FactoryMessage[] = [];
    const app = webhookApp({ enqueueLifecycle: async (message) => void queued.push(message) });
    const response = await postWebhook(app, 'pull_request', {
      action: 'opened',
      number: 42,
      pull_request: {
        draft: false,
        html_url: 'https://github.com/acme/api/pull/42',
        title: 'Contributor change',
        user: { login: 'contributor', type: 'User' },
        head: {
          ref: 'topic',
          sha: 'a'.repeat(40),
          repo: { full_name: 'contributor/api' },
        },
        base: { ref: 'main', sha: 'b'.repeat(40) },
      },
      repository: { id: 101, full_name: 'acme/api' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      skipped: 'legacy profile admits factory changes only',
    });
    expect(queued).toHaveLength(0);
    const change = await getChangeByProviderKey(101, 'github:42');
    expect(change).toMatchObject({
      origin: 'human',
      title: 'Contributor change',
      source_branch: 'topic',
      target_branch: 'main',
      source_head: 'a'.repeat(40),
      status: 'open',
    });
    expect(change?.capabilities).toEqual([
      'read_change',
      'publish_review',
      'publish_check',
      'merge',
    ]);

    const synchronized = await postWebhook(app, 'pull_request', {
      action: 'synchronize',
      number: 42,
      pull_request: {
        draft: false,
        html_url: 'https://github.com/acme/api/pull/42',
        title: 'Contributor change',
        user: { login: 'contributor', type: 'User' },
        head: {
          ref: 'topic',
          sha: 'c'.repeat(40),
          repo: { full_name: 'contributor/api' },
        },
        base: { ref: 'main', sha: 'b'.repeat(40) },
      },
      repository: { id: 101, full_name: 'acme/api' },
    });
    expect(synchronized.status).toBe(200);
    const refreshed = await getChangeByProviderKey(101, 'github:42');
    expect(refreshed?.id).toBe(change?.id);
    expect(refreshed?.source_head).toBe('c'.repeat(40));
  });

  it('automatically reviews a human PR only after all-changes intake is selected', async () => {
    await seedRepo({ reviewIntake: 'all_changes' });
    await ensureBuiltinAgents(1001);
    const queued: FactoryMessage[] = [];
    const response = await postWebhook(
      webhookApp({ enqueueLifecycle: async (message) => void queued.push(message) }),
      'pull_request',
      {
        action: 'opened',
        number: 77,
        pull_request: {
          draft: false,
          html_url: 'https://github.com/acme/api/pull/77',
          title: 'Human contribution',
          user: { login: 'contributor', type: 'User' },
          head: {
            ref: 'contribution',
            sha: 'd'.repeat(40),
            repo: { full_name: 'contributor/api' },
          },
          base: { ref: 'main', sha: 'e'.repeat(40) },
        },
        repository: { id: 101, full_name: 'acme/api' },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      review: 'acme/api#77',
      run: expect.any(Number),
      stage_run: expect.any(Number),
    });
    expect(stageCommands(queued)).toHaveLength(1);
  });

  it('schedules duplicate factory deliveries idempotently and executes the stage once', async () => {
    await seedRepo();
    await ensureBuiltinAgents(1001);
    const featureId = await createFeature(101, 'Factory feature', 'Implementation spec');
    await updateFeature(featureId, { status: 'pr_opened', prNumber: 42 });

    const calls: { trigger: string }[] = [];
    const dispatch: ReviewDispatcher = async (agent, repo, prNumber, _url, trigger, options) => {
      calls.push({ trigger });
      await tryRecordReview(
        repo.id,
        repo.installation_id,
        prNumber,
        trigger,
        agent.slug,
        `${agent.slug}--${repo.owner}--${repo.name}--${prNumber}`,
        options?.riskTier ?? null,
        options?.stageRunId ?? null,
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
    const queued: FactoryMessage[] = [];
    const app = webhookApp({ enqueueLifecycle: async (message) => void queued.push(message) });
    const openedResponse = await postWebhook(app, 'pull_request', opened);
    const duplicateResponse = await postWebhook(app, 'pull_request', opened);
    const firstBody = await openedResponse.json<ScheduledReviewBody>();
    const duplicateBody = await duplicateResponse.json<ScheduledReviewBody>();
    expect(firstBody).toMatchObject({ run: expect.any(Number), stage_run: expect.any(Number) });
    expect(duplicateBody).toMatchObject({ run: firstBody.run, stage_run: firstBody.stage_run });
    const feature = await getFeature(featureId);
    const change = await getChangeByProviderKey(101, 'github:42');
    expect(feature?.change_id).toBe(change?.id);
    expect(change?.origin).toBe('factory');

    const commands = stageCommands(queued);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    const lifecycleEnqueue = async (message: FactoryMessage) => {
      queued.push(message);
    };
    await runLifecycleStage(commands[0], dispatch, {
      computeRisk: async () => 'full',
      enqueue: lifecycleEnqueue,
    });
    await runLifecycleStage(commands[1], dispatch, {
      computeRisk: async () => 'full',
      enqueue: lifecycleEnqueue,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ trigger: 'opened' });
    await expect(getStageRun(commands[0].stageRunId)).resolves.toMatchObject({
      status: 'running',
    });
    await completeLifecycleReview(
      'review--acme--api--42',
      'https://github.com/acme/api/pull/42#pullrequestreview-1',
      0,
      'approve',
      [],
      lifecycleEnqueue,
    );
    await expect(getStageRun(commands[0].stageRunId)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(getFactoryRun(commands[0].factoryRunId)).resolves.toMatchObject({
      status: 'handed_off',
      handoff_reason: 'requested stop boundary reached',
    });
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

describe('push re-reviews', () => {
  const headA = 'a'.repeat(40);
  const headB = 'b'.repeat(40);
  const headC = 'c'.repeat(40);
  const instance = (slug: string) => `${slug}--acme--api--77`;

  // Every built-in persona reviews this repo (only the default one is on
  // unless a repo opts the others in), so the selection rules have a fleet
  // to choose from.
  async function seedReviewedRepo(opts: Parameters<typeof seedRepo>[0] = {}): Promise<void> {
    await seedRepo({ reviewIntake: 'all_changes', ...opts });
    await ensureBuiltinAgents(1001);
    await testDatabase()
      .prepare(
        `INSERT INTO repo_agents (repository_id, installation_id, agent_id, enabled)
         SELECT 101, 1001, id, TRUE FROM agents WHERE installation_id = 1001`,
      )
      .run();
  }

  // A same-repo branch (not a fork), so the change is writable and a
  // blocking review can schedule a repair.
  function pullRequest(action: 'opened' | 'synchronize', sha: string): JsonObject {
    return {
      action,
      number: 77,
      pull_request: {
        draft: false,
        html_url: 'https://github.com/acme/api/pull/77',
        title: 'Human contribution',
        user: { login: 'contributor', type: 'User' },
        head: { ref: 'contribution', sha, repo: { full_name: 'acme/api' } },
        base: { ref: 'main', sha: 'e'.repeat(40) },
      },
      repository: { id: 101, full_name: 'acme/api' },
    };
  }

  // The queue as the tests see it: every command with the delivery options
  // it was sent with, so a push's delay is asserted rather than waited for.
  function harness() {
    const queued: { message: FactoryMessage; options?: { delaySeconds?: number } }[] = [];
    const enqueue = async (message: FactoryMessage, options?: { delaySeconds?: number }) => {
      queued.push(options ? { message, options } : { message });
    };
    const calls: { slug: string; trigger: string; headSha?: string; delta?: unknown }[] = [];
    const dispatch: ReviewDispatcher = async (agent, repo, prNumber, _url, trigger, options) => {
      const call: (typeof calls)[number] = { slug: agent.slug, trigger };
      if (options?.headSha) call.headSha = options.headSha;
      if (options?.delta) call.delta = options.delta;
      calls.push(call);
      await tryRecordReview(
        repo.id,
        repo.installation_id,
        prNumber,
        trigger,
        agent.slug,
        `${agent.slug}--${repo.owner}--${repo.name}--${prNumber}`,
        options?.riskTier ?? null,
        options?.stageRunId ?? null,
        options?.headSha ?? null,
      );
      return true;
    };
    const app = webhookApp({ enqueueLifecycle: enqueue });
    const commands = () => stageCommands(queued.map((entry) => entry.message));
    const lastCommand = () => {
      const command = commands().at(-1);
      if (!command) throw new Error('no stage command was enqueued');
      return command;
    };
    return { queued, enqueue, calls, dispatch, app, commands, lastCommand };
  }

  // Opens the PR at head A and lets every built-in agent conclude, so the
  // pushes that follow have priors to reconcile against.
  async function reviewedOpening(
    h: ReturnType<typeof harness>,
    verdicts: Record<string, { verdict: 'approve' | 'request_changes'; paths: string[] }>,
  ): Promise<void> {
    await postWebhook(h.app, 'pull_request', pullRequest('opened', headA));
    await runLifecycleStage(h.lastCommand(), h.dispatch, {
      computeRisk: async () => 'full',
      enqueue: h.enqueue,
    });
    for (const call of h.calls) {
      const outcome = verdicts[call.slug] ?? { verdict: 'approve', paths: [] };
      await completeLifecycleReview(
        instance(call.slug),
        null,
        outcome.paths.length,
        outcome.verdict,
        outcome.paths,
        h.enqueue,
      );
    }
    h.calls.length = 0;
  }

  it('delays a push review by the repository window and records the scheduled head', async () => {
    await seedReviewedRepo();
    const h = harness();
    await postWebhook(h.app, 'pull_request', pullRequest('opened', headA));
    expect(h.queued.at(-1)).toEqual({ message: h.lastCommand() });

    const response = await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    expect(response.status).toBe(200);
    expect(h.queued.at(-1)).toEqual({
      message: h.lastCommand(),
      options: { delaySeconds: 600 },
    });
    await expect(getStageRun(h.lastCommand().stageRunId)).resolves.toMatchObject({
      trigger: 'synchronize',
      input: { scheduledHead: headB },
    });
  });

  it('reviews a push immediately when the window is zero', async () => {
    await seedReviewedRepo({ pushDebounceMinutes: 0 });
    const h = harness();
    await postWebhook(h.app, 'pull_request', pullRequest('opened', headA));
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    expect(h.queued.at(-1)).toEqual({ message: h.lastCommand() });
  });

  it('cancels a delayed push review that a newer push superseded', async () => {
    await seedReviewedRepo();
    const h = harness();
    await postWebhook(h.app, 'pull_request', pullRequest('opened', headA));
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    const pushB = h.lastCommand();
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headC));
    const pushC = h.lastCommand();

    // B's command lands after C was pushed: nothing to review, nothing to retry.
    await runLifecycleStage(pushB, h.dispatch, {
      computeRisk: async () => 'full',
      enqueue: h.enqueue,
    });
    expect(h.calls).toEqual([]);
    await expect(getStageRun(pushB.stageRunId)).resolves.toMatchObject({
      status: 'cancelled',
      error: 'superseded by a newer push',
      output: { kind: 'superseded', scheduledHead: headB, currentHead: headC },
    });
    await expect(getFactoryRun(pushB.factoryRunId)).resolves.toMatchObject({
      status: 'cancelled',
      handoff_reason: 'superseded by a newer push',
    });
    const cancelled = await testDatabase()
      .prepare(
        `SELECT COUNT(*) AS n FROM lifecycle_events WHERE factory_run_id = ?1 AND kind = 'run.cancelled'`,
      )
      .bind(pushB.factoryRunId)
      .first<{ n: number }>();
    expect(cancelled?.n).toBe(1);
    await expect(resumeFailedStage(pushB.factoryRunId, 'nico', h.enqueue)).resolves.toMatchObject({
      kind: 'rejected',
    });

    // C's command reviews the live head; with no completed review to diff
    // from, the whole change is tiered as on opening.
    const computeDelta = vi.fn(async () => null);
    await runLifecycleStage(pushC, h.dispatch, {
      computeRisk: async () => 'full',
      computeDelta,
      enqueue: h.enqueue,
    });
    expect(computeDelta).not.toHaveBeenCalled();
    expect(h.calls.map((call) => call.headSha)).toEqual(h.calls.map(() => headC));
    expect(h.calls.length).toBeGreaterThan(1);
    await expect(getStageRun(pushC.stageRunId)).resolves.toMatchObject({ status: 'running' });
  });

  it('settles a force-push back to an already reviewed head without dispatching', async () => {
    await seedReviewedRepo();
    const h = harness();
    await reviewedOpening(h, {});
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    const pushB = h.lastCommand();
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headA));
    const backToA = h.lastCommand();

    await runLifecycleStage(pushB, h.dispatch, { enqueue: h.enqueue });
    await expect(getFactoryRun(pushB.factoryRunId)).resolves.toMatchObject({ status: 'cancelled' });
    await runLifecycleStage(backToA, h.dispatch, { enqueue: h.enqueue });
    expect(h.calls).toEqual([]);
    await expect(getStageRun(backToA.stageRunId)).resolves.toMatchObject({
      status: 'completed',
      output: { kind: 'nothing_to_do', reason: 'head already reviewed', headSha: headA },
    });
    await expect(getFactoryRun(backToA.factoryRunId)).resolves.toMatchObject({
      status: 'handed_off',
      handoff_reason: 'requested stop boundary reached',
    });
  });

  it('re-runs only the agents the pushed delta concerns', async () => {
    await seedReviewedRepo();
    const h = harness();
    await reviewedOpening(h, {
      review: { verdict: 'approve', paths: ['src/a.ts'] },
      a11y: { verdict: 'request_changes', paths: ['src/dialog.tsx'] },
    });
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    const pushB = h.lastCommand();

    const computeDelta = vi.fn(async (_inst: number, _o: string, _r: string, since: string) => ({
      sinceHead: since,
      files: [{ filename: 'src/b.ts', additions: 3, deletions: 0 }],
      tier: 'trivial' as const,
    }));
    await runLifecycleStage(pushB, h.dispatch, {
      computeRisk: async () => 'full',
      computeDelta,
      enqueue: h.enqueue,
    });
    expect(computeDelta).toHaveBeenCalledWith(1001, 'acme', 'api', headA, headB);
    // The blocker re-judges its block; the approvers' files are untouched.
    expect(h.calls).toEqual([
      {
        slug: 'a11y',
        trigger: 'synchronize',
        headSha: headB,
        delta: { sinceHead: headA, files: ['src/b.ts'] },
      },
    ]);
    const stageRun = await getStageRun(pushB.stageRunId);
    expect(stageRun).toMatchObject({
      status: 'running',
      output: { kind: 'dispatched', tier: 'trivial', agents: ['a11y'], sinceHead: headA },
    });
    expect(stageRun?.output).toMatchObject({
      skipped: expect.arrayContaining([
        { slug: 'review', reason: 'approved earlier and the push does not touch its findings' },
      ]),
    });

    await completeLifecycleReview(instance('a11y'), null, 0, 'approve', [], h.enqueue);
    await expect(getStageRun(pushB.stageRunId)).resolves.toMatchObject({ status: 'completed' });
    await expect(getFactoryRun(pushB.factoryRunId)).resolves.toMatchObject({
      status: 'handed_off',
    });
  });

  it('re-runs an approver whose flagged file the push touches', async () => {
    await seedReviewedRepo();
    const h = harness();
    await reviewedOpening(h, { review: { verdict: 'approve', paths: ['src/a.ts'] } });
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    await runLifecycleStage(h.lastCommand(), h.dispatch, {
      computeRisk: async () => 'full',
      computeDelta: async () => ({
        sinceHead: headA,
        files: [{ filename: 'src/a.ts', additions: 1, deletions: 1 }],
        tier: 'trivial',
      }),
      enqueue: h.enqueue,
    });
    expect(h.calls.map((call) => call.slug)).toEqual(['review']);
  });

  it('settles a push no agent needs to see as a clean review', async () => {
    await seedReviewedRepo({ processProfile: 'review_and_repair' });
    const h = harness();
    await reviewedOpening(h, { review: { verdict: 'approve', paths: ['src/a.ts'] } });
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    const pushB = h.lastCommand();
    await runLifecycleStage(pushB, h.dispatch, {
      computeRisk: async () => 'full',
      computeDelta: async () => ({
        sinceHead: headA,
        files: [{ filename: 'docs/notes.md', additions: 2, deletions: 0 }],
        tier: 'trivial',
      }),
      enqueue: h.enqueue,
    });
    expect(h.calls).toEqual([]);
    await expect(getStageRun(pushB.stageRunId)).resolves.toMatchObject({
      status: 'completed',
      output: { kind: 'nothing_to_do', reason: 'no agent needs to re-review this push' },
    });
    // No standing block, so review-and-repair has nothing left to do — and
    // nothing here reaches merge.
    await expect(getFactoryRun(pushB.factoryRunId)).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(listStageRuns(pushB.factoryRunId)).resolves.toMatchObject([
      { stage: 'review', status: 'completed' },
    ]);
  });

  it('tiers the whole change again when the delta cannot be trusted', async () => {
    await seedReviewedRepo();
    const h = harness();
    await reviewedOpening(h, {});
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    await runLifecycleStage(h.lastCommand(), h.dispatch, {
      computeRisk: async () => 'lite',
      computeDelta: async () => null,
      enqueue: h.enqueue,
    });
    expect(h.calls.map((call) => call.slug).sort()).toEqual(['review', 'security']);
    expect(h.calls.every((call) => call.headSha === headB && call.delta === undefined)).toBe(true);
  });

  it('never mistakes the post-repair re-review for a stale push', async () => {
    await seedReviewedRepo({ processProfile: 'review_and_repair' });
    const h = harness();
    await reviewedOpening(h, {});
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headB));
    const pushB = h.lastCommand();
    await runLifecycleStage(pushB, h.dispatch, {
      computeRisk: async () => 'full',
      computeDelta: async () => null,
      enqueue: h.enqueue,
    });
    for (const call of h.calls) {
      await completeLifecycleReview(
        instance(call.slug),
        null,
        1,
        call.slug === 'review' ? 'request_changes' : 'approve',
        ['src/a.ts'],
        h.enqueue,
      );
    }
    const repair = h.commands().find((command) => command.stage === 'repair');
    if (!repair) throw new Error('repair stage was not scheduled');
    await runLifecycleStage(repair, h.dispatch, { enqueue: h.enqueue });
    // The repair pushed a new head; the coordinator schedules attempt 2 of
    // the review on the same run, which inherits the push's stage input.
    await completeLifecycleRepair(repair.stageRunId, true, { kind: 'fixed' }, h.enqueue);
    await postWebhook(h.app, 'pull_request', pullRequest('synchronize', headC));
    const attempt2 = h
      .commands()
      .find(
        (command) =>
          command.factoryRunId === pushB.factoryRunId &&
          command.stage === 'review' &&
          command.stageRunId !== pushB.stageRunId,
      );
    if (!attempt2) throw new Error('review attempt 2 was not scheduled');
    await expect(getStageRun(attempt2.stageRunId)).resolves.toMatchObject({
      attempt: 2,
      trigger: 'stage.completed',
      input: { scheduledHead: headB },
    });

    h.calls.length = 0;
    await runLifecycleStage(attempt2, h.dispatch, {
      computeRisk: async () => 'full',
      computeDelta: async () => null,
      enqueue: h.enqueue,
    });
    expect(h.calls.length).toBeGreaterThan(0);
    await expect(getStageRun(attempt2.stageRunId)).resolves.toMatchObject({ status: 'running' });
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
      webhookApp({ enqueueFix }),
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
