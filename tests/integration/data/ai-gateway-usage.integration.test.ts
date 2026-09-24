import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { persistJsonArtifact } from '../../../src/application/artifacts.ts';
import {
  recordAiGatewayUsage,
  registerAiGatewayUsage,
} from '../../../src/data/ai-gateway-usage.ts';
import { createAgentRun, createFactoryRunWithStage } from '../../../src/data/execution.ts';
import { resolveModel } from '../../../src/data/models.ts';
import { execute, queryOne } from '../../../src/data/postgres.ts';
import { createWorkItem } from '../../../src/data/work.ts';
import { createTenant, rollbackAfter } from '../api/support.ts';

async function createUsageFixture() {
  const tenant = await createTenant();
  const artifact = await persistJsonArtifact({
    organizationId: tenant.organizationId,
    kind: 'test_input',
    storageKey: `tests/${crypto.randomUUID()}`,
    schema: z.object({ task: z.string() }),
    value: { task: 'Reconcile cost' },
  });
  const workItem = await createWorkItem({
    organizationId: tenant.organizationId,
    title: 'Usage reconciliation',
    description: 'Exercise Cloudflare cost persistence',
    origin: 'idea',
    repositoryIds: [],
  });
  const { stageRun } = await createFactoryRunWithStage(
    {
      organizationId: tenant.organizationId,
      flowKey: 'planning',
      flowVersion: 1,
      workItemId: workItem.id,
      trigger: 'manual',
      idempotencyKey: crypto.randomUUID(),
    },
    { stageKey: 'planning', idempotencyKey: crypto.randomUUID() },
  );
  const run = await createAgentRun({
    organizationId: tenant.organizationId,
    stageRunId: stageRun.id,
    agentId: tenant.agentId,
    modelId: (await resolveModel()).id,
    inputArtifactId: artifact.id,
    idempotencyKey: crypto.randomUUID(),
  });
  return { tenant, run };
}

async function deleteUsageFixture(organizationId: string, userId: string): Promise<void> {
  await execute(sql`DELETE FROM app.factory_runs WHERE organization_id = ${organizationId}`);
  await execute(sql`DELETE FROM app.work_items WHERE organization_id = ${organizationId}`);
  await execute(sql`DELETE FROM app.artifacts WHERE organization_id = ${organizationId}`);
  await execute(sql`DELETE FROM app.agents WHERE organization_id = ${organizationId}`);
  await execute(sql`DELETE FROM app.repositories WHERE organization_id = ${organizationId}`);
  await execute(sql`DELETE FROM app.integrations WHERE organization_id = ${organizationId}`);
  await execute(sql`DELETE FROM auth."organization" WHERE id = ${organizationId}`);
  await execute(sql`DELETE FROM auth."user" WHERE id = ${userId}`);
}

describe('AI Gateway usage persistence', () => {
  it('idempotently sums Cloudflare request costs onto their durable agent run', () =>
    rollbackAfter(async () => {
      const { tenant, run } = await createUsageFixture();

      for (const [logId, costUsd] of [
        ['log-1', 1.23],
        ['log-2', 2.34],
      ] as const) {
        const reference = {
          logId,
          organizationId: tenant.organizationId,
          agentRunId: run.id,
        };
        await registerAiGatewayUsage(reference);
        await registerAiGatewayUsage(reference);
        await recordAiGatewayUsage({
          ...reference,
          tokensIn: 100,
          tokensOut: 20,
          costUsd,
        });
        await recordAiGatewayUsage({
          ...reference,
          tokensIn: 999,
          tokensOut: 999,
          costUsd: 99,
        });
      }

      await expect(
        queryOne<{ cost_usd: number; usage_rows: number }>(sql`
          SELECT ar.cost_usd,
            (SELECT COUNT(*) FROM app.ai_gateway_usage WHERE agent_run_id = ar.id) AS usage_rows
          FROM app.agent_runs ar WHERE ar.id = ${run.id}
        `),
      ).resolves.toEqual({ cost_usd: 3.57, usage_rows: 2 });
    }));

  it('serializes concurrent log reconciliation before recomputing the run total', async () => {
    const { tenant, run } = await createUsageFixture();
    const references = Array.from({ length: 24 }, (_, index) => ({
      logId: `concurrent-log-${index}`,
      organizationId: tenant.organizationId,
      agentRunId: run.id,
    }));

    try {
      await Promise.all(references.map(registerAiGatewayUsage));
      await Promise.all(
        references.map((reference) =>
          recordAiGatewayUsage({
            ...reference,
            tokensIn: 100,
            tokensOut: 20,
            costUsd: 1,
          }),
        ),
      );

      await expect(
        queryOne<{ cost_usd: number; reconciled_rows: number }>(sql`
          SELECT ar.cost_usd,
            (
              SELECT COUNT(*) FROM app.ai_gateway_usage
              WHERE agent_run_id = ar.id AND reconciled_at IS NOT NULL
            ) AS reconciled_rows
          FROM app.agent_runs ar WHERE ar.id = ${run.id}
        `),
      ).resolves.toEqual({ cost_usd: 24, reconciled_rows: 24 });
    } finally {
      await deleteUsageFixture(tenant.organizationId, tenant.userId);
    }
  });
});
