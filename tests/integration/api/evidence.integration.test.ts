import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { createEffectApiHandler } from '../../../src/api/server/handler.ts';
import { createGithubWebhookService } from '../../../src/application/webhooks/github.ts';
import { persistJsonArtifact } from '../../../src/application/artifacts.ts';
import { changeRevisionArtifactSchema } from '../../../src/artifacts/change.ts';
import { reviewArtifactSchema } from '../../../src/artifacts/review.ts';
import {
  createChangeRevision,
  recordReviewOutcome,
  upsertChange,
} from '../../../src/data/changes.ts';
import { listChangeChecks } from '../../../src/data/change-checks.ts';
import {
  claimAgentRun,
  completeAgentRun,
  createAgentRun,
  createFactoryRunWithStage,
} from '../../../src/data/execution.ts';
import { resolveModel } from '../../../src/data/models.ts';
import { execute } from '../../../src/data/postgres.ts';
import { createWorkItem, createDeliveries } from '../../../src/data/work.ts';
import { apiDependencies, createTenant, rollbackAfter } from './support.ts';

async function fixture() {
  const tenant = await createTenant();
  const item = await createWorkItem({
    organizationId: tenant.organizationId,
    title: 'Evidence',
    description: 'Evidence',
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
    title: 'Evidence',
    sourceRef: 'turbodiff/test',
    targetRef: 'main',
    origin: 'factory',
  });
  const value = {
    kind: 'change-revision' as const,
    title: 'Evidence',
    description: '',
    base: 'main',
    head: 'turbodiff/test',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    files: [],
    patch: '',
  };
  const artifact = await persistJsonArtifact({
    organizationId: tenant.organizationId,
    kind: 'change_revision',
    storageKey: `tests/${crypto.randomUUID()}`,
    schema: changeRevisionArtifactSchema,
    value,
  });
  const revision = await createChangeRevision({
    change,
    baseSha: value.baseSha,
    headSha: value.headSha,
    artifactId: artifact.id,
  });
  return { tenant, delivery: delivery!, change, revision };
}

describe('delivery evidence and settings', () => {
  it('returns the named reviewer, full artifact summary/findings, and the separate review run', () =>
    rollbackAfter(async () => {
      const { tenant, delivery, change, revision } = await fixture();
      const review = await persistJsonArtifact({
        organizationId: tenant.organizationId,
        kind: 'review',
        storageKey: `tests/${crypto.randomUUID()}`,
        schema: reviewArtifactSchema,
        value: {
          summary: 'Cached clients need a version bump.',
          findings: [
            {
              path: 'src/client/main.tsx',
              line: 20,
              severity: 'P2',
              body: 'Invalidate persisted caches.',
              evidence: 'The shape changed.',
              failurePath: 'An existing browser crashes.',
              side: 'RIGHT',
            },
          ],
          fileEvidence: [],
        },
      });
      const { stageRun } = await createFactoryRunWithStage(
        {
          organizationId: tenant.organizationId,
          flowKey: 'review',
          flowVersion: 1,
          changeId: change.id,
          trigger: 'opened',
          idempotencyKey: crypto.randomUUID(),
        },
        { stageKey: 'review', idempotencyKey: crypto.randomUUID() },
      );
      const run = await createAgentRun({
        organizationId: tenant.organizationId,
        stageRunId: stageRun.id,
        agentId: tenant.agentId,
        modelId: (await resolveModel()).id,
        inputArtifactId: review.id,
        idempotencyKey: crypto.randomUUID(),
      });
      await claimAgentRun(run.id);
      await completeAgentRun({
        id: run.id,
        outputArtifactId: review.id,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      });
      await recordReviewOutcome({
        organizationId: tenant.organizationId,
        agentRunId: run.id,
        changeRevisionId: revision.id,
        verdict: 'approve',
        conclusion: 'ready_with_warnings',
        coverageStatus: 'complete',
        findingCount: 1,
      });
      const handle = createEffectApiHandler(apiDependencies([], async () => tenant.user));
      const response = await handle(
        new Request(`https://app.test/api/deliveries/${delivery.id}/view`),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        change: {
          currentRevision: {
            reviewOutcomes: [
              {
                author: 'Planner',
                summary: 'Cached clients need a version bump.',
                findings: [{ body: 'Invalidate persisted caches.' }],
              },
            ],
          },
        },
        factoryRuns: [{ flowKey: 'review', trigger: 'opened' }],
      });
    }));

  it('persists policy and check-command clearing while preserving unrelated settings', () =>
    rollbackAfter(async () => {
      const tenant = await createTenant();
      await execute(
        sql`UPDATE app.repositories SET settings = '{"custom":"retained","checkCommand":"vp check"}'::jsonb WHERE id = ${tenant.repositoryId}`,
      );
      const handle = createEffectApiHandler(apiDependencies([], async () => tenant.user));
      const response = await handle(
        new Request(`https://app.test/api/repositories/${tenant.repositoryId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            processProfile: 'full_delivery',
            checkCommand: null,
            blockingReviews: false,
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        processProfile: 'full_delivery',
        checkCommand: null,
        blockingReviews: false,
      });
      const list = await handle(new Request('https://app.test/api/repositories'));
      expect(await list.json()).toMatchObject({
        items: [{ settings: { processProfile: 'full_delivery', checkCommand: null } }],
      });
    }));

  it('deduplicates CI updates and rejects older or unrelated-commit evidence', () =>
    rollbackAfter(async () => {
      const { tenant, revision } = await fixture();
      await execute(
        sql`UPDATE app.repositories SET external_id = '12345' WHERE id = ${tenant.repositoryId}`,
      );
      await execute(
        sql`UPDATE app.integrations SET external_account_id = '45678' WHERE id = ${tenant.integrationId}`,
      );
      const webhook = createGithubWebhookService();
      const payload = {
        action: 'completed',
        installation: { id: 45678 },
        repository: { id: 12345, name: 'test', full_name: 'test/test' },
        workflow_run: {
          id: 12,
          workflow_id: 34,
          name: 'CI',
          head_sha: revision.head_sha,
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/test/test/actions/runs/12',
          updated_at: '2026-09-19T11:30:00Z',
        },
      };
      await webhook.handle('workflow_run', payload);
      await webhook.handle('workflow_run', payload);
      await webhook.handle('workflow_run', {
        ...payload,
        workflow_run: {
          ...payload.workflow_run,
          status: 'queued',
          conclusion: null,
          updated_at: '2026-09-19T11:00:00Z',
        },
      });
      expect(await listChangeChecks(revision.id)).toMatchObject([
        { status: 'completed', conclusion: 'failure' },
      ]);
      expect(await listChangeChecks(revision.id)).toHaveLength(1);
      await webhook.handle('workflow_run', {
        ...payload,
        workflow_run: { ...payload.workflow_run, head_sha: 'c'.repeat(40), conclusion: 'success' },
      });
      expect(await listChangeChecks(revision.id)).toMatchObject([{ conclusion: 'failure' }]);
    }));
});
