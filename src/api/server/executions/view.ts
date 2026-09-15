import { Effect } from 'effect';
import { getFactoryRun, listAgentRunsForStage, listStageRuns } from '../../../data/execution.ts';
import type { FactoryRun } from '../../contract/executions.ts';
import { notFound, type DomainError } from '../../contract/errors.ts';
import { dataEffect } from '../authorization.ts';
import { canonicalModelId, getModel } from '../../../data/models.ts';

export const loadFactoryRun = (
  organizationIds: readonly string[],
  id: number,
): Effect.Effect<FactoryRun, DomainError> =>
  Effect.gen(function* () {
    const row = yield* dataEffect(() => getFactoryRun(id));
    if (!row || !organizationIds.includes(row.organization_id)) {
      return yield* Effect.fail(notFound('Unknown factory run'));
    }
    const stages = yield* dataEffect(() => listStageRuns(row.id));
    const modelId = row.model_id;
    const model = modelId ? yield* dataEffect(() => getModel(modelId)) : null;
    const agentRuns = yield* dataEffect(() =>
      Promise.all(stages.map((stage) => listAgentRunsForStage(stage.id))),
    );
    return {
      id: row.id,
      organizationId: row.organization_id,
      flowKey: row.flow_key,
      flowVersion: row.flow_version,
      modelId: row.model_id,
      model: model ? canonicalModelId(model) : null,
      workItemId: row.work_item_id,
      deliveryId: row.delivery_id,
      changeId: row.change_id,
      automationId: row.automation_id,
      parentRunId: row.parent_run_id,
      trigger: row.trigger,
      status: row.status,
      stages: stages.map((stage, index) => ({
        id: stage.id,
        stageKey: stage.stage_key,
        attempt: stage.attempt,
        status: stage.status,
        errorCode: stage.error_code,
        errorMessage: stage.error_message,
        agentRuns: (agentRuns[index] ?? []).map((agentRun) => ({
          id: agentRun.id,
          agentId: agentRun.agent_id,
          modelId: agentRun.model_id,
          inputArtifactId: agentRun.input_artifact_id,
          outputArtifactId: agentRun.output_artifact_id,
          logArtifactId: agentRun.log_artifact_id,
          status: agentRun.status,
          usage: {
            inputTokens: agentRun.input_tokens,
            outputTokens: agentRun.output_tokens,
            cacheReadTokens: agentRun.cache_read_tokens,
            cacheWriteTokens: agentRun.cache_write_tokens,
            costUsd: agentRun.cost_usd,
          },
          errorCode: agentRun.error_code,
          errorMessage: agentRun.error_message,
          createdAt: agentRun.created_at,
          startedAt: agentRun.started_at,
          completedAt: agentRun.completed_at,
        })),
        createdAt: stage.created_at,
        startedAt: stage.started_at,
        completedAt: stage.completed_at,
      })),
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  });
