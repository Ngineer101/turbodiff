import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import {
  reconcileChangeDelivery,
  executeChangeDeliveryStage,
  type DeliveryDependencies,
} from '../../../src/application/factory/delivery-lifecycle.ts';
import { persistJsonArtifact } from '../../../src/application/artifacts.ts';
import { changeRevisionArtifactSchema } from '../../../src/artifacts/change.ts';
import {
  createChangeRevision,
  upsertChange,
  type ChangeRevisionRow,
} from '../../../src/data/changes.ts';
import { completeDeliveryStage, resumeDeliveryRun } from '../../../src/data/delivery-lifecycle.ts';
import {
  claimStageRun,
  getFactoryRun,
  listFactoryRuns,
  listLifecycleEvents,
  listRecoverableFactoryStages,
  listStageRuns,
} from '../../../src/data/execution.ts';
import { execute } from '../../../src/data/postgres.ts';
import { createWorkItem, createDeliveries, getDelivery } from '../../../src/data/work.ts';
import { createEffectApiHandler } from '../../../src/api/server/handler.ts';
import { apiDependencies, createTenant, rollbackAfter } from './support.ts';
import type { RunFactoryMessage } from '../../../src/application/factory/message.ts';
import type { GithubDeliveryState } from '../../../src/integrations/changes/github-delivery.ts';

async function fixture() {
  const tenant = await createTenant();
  await execute(
    sql`UPDATE app.repositories SET settings = '{"processProfile":"full_delivery"}'::jsonb WHERE id = ${tenant.repositoryId}`,
  );
  const item = await createWorkItem({
    organizationId: tenant.organizationId,
    title: 'Delivery',
    description: 'Task',
    origin: 'idea',
    repositoryIds: [tenant.repositoryId],
  });
  const [delivery] = await createDeliveries(item);
  const change = await upsertChange({
    organizationId: tenant.organizationId,
    repositoryId: tenant.repositoryId,
    deliveryId: delivery!.id,
    providerIntegrationId: tenant.integrationId,
    providerKey: 'pull_request:185',
    number: 185,
    title: 'Delivery',
    sourceRef: 'turbodiff/test',
    targetRef: 'main',
    origin: 'factory',
  });
  const newRevision = async (headSha: string) => {
    const artifact = await persistJsonArtifact({
      organizationId: tenant.organizationId,
      kind: 'change_revision',
      storageKey: `test/${crypto.randomUUID()}`,
      schema: changeRevisionArtifactSchema,
      value: {
        kind: 'change-revision',
        title: 'Delivery',
        description: '',
        base: 'main',
        head: 'turbodiff/test',
        baseSha: 'a'.repeat(40),
        headSha,
        files: [],
        patch: '',
      },
    });
    const revision = await createChangeRevision({
      change,
      baseSha: 'a'.repeat(40),
      headSha,
      artifactId: artifact.id,
    });
    await execute(
      sql`UPDATE app.change_revisions SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 minutes' WHERE id = ${revision.id}`,
    );
    return revision;
  };
  const revision = await newRevision('b'.repeat(40));
  const messages: RunFactoryMessage[] = [];
  const state: GithubDeliveryState = {
    headSha: revision.head_sha,
    status: 'open',
    draft: false,
    writable: true,
    humanReviewBlocked: false,
    mergeable: true,
    checks: [],
    failureEvidence: '',
  };
  const dependencies: DeliveryDependencies = {
    readGithub: async () => state,
    syncGithub: async (_repo, _change, head) => newRevision(head!),
    enqueue: async (message) => {
      messages.push(message);
    },
    notify: async () => undefined,
  };
  const reconcile = () => reconcileChangeDelivery(change.id, dependencies);
  const complete = async (revision: ChangeRevisionRow, verdict: string) => {
    const run = (await listFactoryRuns({ changeId: change.id }))[0]!;
    const stage = (await listStageRuns(run.id)).at(-1)!;
    await claimStageRun(stage.id);
    await completeDeliveryStage(run, stage, { revisionId: revision.id, verdict });
  };
  return {
    tenant,
    delivery: delivery!,
    change,
    revision,
    newRevision,
    messages,
    state,
    dependencies,
    reconcile,
    complete,
  };
}

describe('durable delivery coordination', () => {
  it('deduplicates overlapping wakeups and advances review → verify → merge without completing early', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      await Promise.all([f.reconcile(), f.reconcile()]);
      expect(f.messages).toHaveLength(1);
      const run = (await listFactoryRuns({ changeId: f.change.id }))[0]!;
      expect((await listStageRuns(run.id)).map((stage) => stage.stage_key)).toEqual(['review']);
      expect((await getDelivery(f.delivery.id))?.status).toBe('active');
      await f.complete(f.revision, 'passed');
      await f.reconcile();
      expect((await listStageRuns(run.id)).map((stage) => stage.stage_key)).toEqual([
        'review',
        'verify',
      ]);
      await f.complete(f.revision, 'passed');
      await f.reconcile();
      expect((await listStageRuns(run.id)).map((stage) => stage.stage_key)).toEqual([
        'review',
        'verify',
        'merge',
      ]);
      expect((await getDelivery(f.delivery.id))?.status).toBe('active');
    }));
  it('schedules CI repair and invalidates every gate after a new commit', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      f.state.checks = [
        {
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          details_url: null,
          updated_at: new Date().toISOString(),
        },
      ];
      await f.reconcile();
      const run = (await listFactoryRuns({ changeId: f.change.id }))[0]!;
      expect((await listStageRuns(run.id))[0]?.stage_key).toBe('repair');
      await f.complete(f.revision, 'repaired');
      f.state.headSha = 'c'.repeat(40);
      f.state.checks = [];
      await f.reconcile();
      const stages = await listStageRuns(run.id);
      expect(stages.map((stage) => stage.stage_key)).toEqual(['repair', 'review']);
      const scheduled = (await listLifecycleEvents(run.id)).filter(
        (event) => event.kind === 'delivery_stage_scheduled',
      );
      expect(scheduled[1]?.payload).not.toEqual(scheduled[0]?.payload);
    }));
  it('waits on incomplete CI and resumes when it passes', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      await f.reconcile();
      await f.complete(f.revision, 'passed');
      await f.reconcile();
      await f.complete(f.revision, 'passed');
      f.state.checks = [
        {
          name: 'CI',
          status: 'running',
          conclusion: null,
          details_url: null,
          updated_at: new Date().toISOString(),
        },
      ];
      await f.reconcile();
      const run = (await listFactoryRuns({ changeId: f.change.id }))[0]!;
      expect((await getFactoryRun(run.id))?.status).toBe('waiting');
      expect(await listStageRuns(run.id)).toHaveLength(2);
      f.state.checks[0]!.status = 'completed';
      f.state.checks[0]!.conclusion = 'success';
      await f.reconcile();
      expect((await listStageRuns(run.id)).at(-1)?.stage_key).toBe('merge');
    }));
  it('preserves queued work if publication to the queue fails', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      f.dependencies.enqueue = async () => {
        throw new Error('queue unavailable');
      };
      await f.reconcile();
      const run = (await listFactoryRuns({ changeId: f.change.id }))[0]!;
      expect(await listRecoverableFactoryStages()).toContainEqual({
        factory_run_id: run.id,
        stage_run_id: (await listStageRuns(run.id))[0]!.id,
      });
      await f.reconcile();
      expect(await listStageRuns(run.id)).toHaveLength(1);
    }));
  it('does not write or schedule for a disabled policy or a foreign PR head', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      f.state.writable = false;
      await f.reconcile();
      expect(f.messages).toHaveLength(0);
      await execute(
        sql`UPDATE app.repositories SET settings = '{}'::jsonb WHERE id = ${f.tenant.repositoryId}`,
      );
      f.dependencies.readGithub = async () => {
        throw new Error('must not fetch disabled delivery');
      };
      await f.reconcile();
      expect(f.messages).toHaveLength(0);
    }));
  it('hands off after no-change repair, and resumption never resets the repair budget', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      f.state.checks = [
        {
          name: 'CI',
          status: 'completed',
          conclusion: 'failure',
          details_url: null,
          updated_at: new Date().toISOString(),
        },
      ];
      await f.reconcile();
      await f.complete(f.revision, 'unchanged');
      await f.reconcile();
      const run = (await listFactoryRuns({ changeId: f.change.id }))[0]!;
      expect((await getFactoryRun(run.id))?.status).toBe('waiting');
      expect(f.messages).toHaveLength(1);
      const resumed = await resumeDeliveryRun(f.change);
      expect(resumed.stage_key).toBe('reconcile');
      await f.complete(f.revision, 'resumed');
      await f.reconcile();
      expect((await listStageRuns(run.id)).at(-1)).toMatchObject({
        stage_key: 'repair',
        attempt: 2,
      });
    }));
  it('authorizes resumption before enqueueing and does not expose another tenant', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      const outsider = await createTenant();
      const messages: RunFactoryMessage[] = [];
      const request = () =>
        new Request(`https://app.test/api/changes/${f.change.id}/delivery-resumptions`, {
          method: 'POST',
        });
      expect(
        (
          await createEffectApiHandler(apiDependencies(messages, async () => outsider.user))(
            request(),
          )
        ).status,
      ).toBe(404);
      expect(messages).toHaveLength(0);
      expect(
        (
          await createEffectApiHandler(apiDependencies(messages, async () => f.tenant.user))(
            request(),
          )
        ).status,
      ).toBe(202);
      expect(messages).toHaveLength(1);
    }));
  it('executes a queued merge only after fresh gates and sends its exact SHA', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      await f.reconcile();
      await f.complete(f.revision, 'passed');
      await f.reconcile();
      await f.complete(f.revision, 'passed');
      await f.reconcile();
      const run = (await listFactoryRuns({ changeId: f.change.id }))[0]!;
      const stage = (await listStageRuns(run.id)).at(-1)!;
      await claimStageRun(stage.id);
      const merges: string[] = [];
      await executeChangeDeliveryStage(run, stage, {
        ...f.dependencies,
        merge: async (_repository, _change, sha) => {
          merges.push(sha!);
        },
      });
      expect(merges).toEqual([f.revision.head_sha]);
      expect((await getDelivery(f.delivery.id))?.status).toBe('completed');
      expect((await getFactoryRun(run.id))?.status).toBe('succeeded');
    }));
  it('rejects a queued merge after its head changes and schedules new evidence', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      await f.reconcile();
      await f.complete(f.revision, 'passed');
      await f.reconcile();
      await f.complete(f.revision, 'passed');
      await f.reconcile();
      const run = (await listFactoryRuns({ changeId: f.change.id }))[0]!;
      const stage = (await listStageRuns(run.id)).at(-1)!;
      await claimStageRun(stage.id);
      f.state.headSha = 'd'.repeat(40);
      await executeChangeDeliveryStage(run, stage, {
        ...f.dependencies,
        merge: async () => {
          throw new Error('stale merge must not run');
        },
      });
      expect((await listStageRuns(run.id)).at(-1)?.stage_key).toBe('review');
      expect((await getDelivery(f.delivery.id))?.status).toBe('active');
    }));
  it('rejects a queued mutation when delivery is disabled, and waits for a human review dismissal', () =>
    rollbackAfter(async () => {
      const f = await fixture();
      await f.reconcile();
      await f.complete(f.revision, 'passed');
      await f.reconcile();
      await f.complete(f.revision, 'passed');
      f.state.humanReviewBlocked = true;
      await f.reconcile();
      const run = (await listFactoryRuns({ changeId: f.change.id }))[0]!;
      expect(await listStageRuns(run.id)).toHaveLength(2);
      f.state.humanReviewBlocked = false;
      await f.reconcile();
      const stage = (await listStageRuns(run.id)).at(-1)!;
      await claimStageRun(stage.id);
      await execute(
        sql`UPDATE app.repositories SET settings = '{}'::jsonb WHERE id = ${f.tenant.repositoryId}`,
      );
      await executeChangeDeliveryStage(run, stage, {
        ...f.dependencies,
        merge: async () => {
          throw new Error('disabled merge must not run');
        },
      });
      expect((await getDelivery(f.delivery.id))?.status).toBe('active');
    }));
});
