import { Effect } from 'effect';
import {
  listAgentRunsForFactoryRuns,
  listFactoryRunsById,
  listLifecycleEventsForFactoryRuns,
  listStageRunsForFactoryRuns,
  type AgentRunRow,
  type FactoryRunRow,
  type LifecycleEventRow,
  type StageRunRow,
} from '../../../data/execution.ts';
import { canonicalModelId, listModelsForFactoryRuns, type ModelRow } from '../../../data/models.ts';
import type { FactoryRun } from '../../contract/executions.ts';
import { notFound, type DomainError } from '../../contract/errors.ts';
import { dataEffect } from '../authorization.ts';

interface FactoryRunViewSources {
  readonly runs: (ids: readonly number[]) => Promise<FactoryRunRow[]>;
  readonly stages: (ids: readonly number[]) => Promise<StageRunRow[]>;
  readonly agentRuns: (ids: readonly number[]) => Promise<AgentRunRow[]>;
  readonly events: (ids: readonly number[]) => Promise<LifecycleEventRow[]>;
  readonly models: (ids: readonly number[]) => Promise<ModelRow[]>;
}

const defaultSources: FactoryRunViewSources = {
  runs: listFactoryRunsById,
  stages: listStageRunsForFactoryRuns,
  agentRuns: listAgentRunsForFactoryRuns,
  events: listLifecycleEventsForFactoryRuns,
  models: listModelsForFactoryRuns,
};

function grouped<Row, Key>(rows: readonly Row[], key: (row: Row) => Key): Map<Key, Row[]> {
  const result = new Map<Key, Row[]>();
  for (const row of rows) {
    const value = key(row);
    const bucket = result.get(value);
    if (bucket) bucket.push(row);
    else result.set(value, [row]);
  }
  return result;
}

/** Hydrate any number of execution graphs in five bulk database reads. */
export const loadFactoryRuns = (
  organizationIds: readonly string[],
  rawIds: readonly number[],
  sources: FactoryRunViewSources = defaultSources,
): Effect.Effect<FactoryRun[], DomainError> => {
  const ids = [...new Set(rawIds)];
  if (ids.length === 0) return Effect.succeed([]);
  return dataEffect(() => sources.runs(ids)).pipe(
    Effect.flatMap((rows) => {
      const rowById = new Map(rows.map((row) => [row.id, row]));
      if (
        ids.some((id) => {
          const row = rowById.get(id);
          return !row || !organizationIds.includes(row.organization_id);
        })
      ) {
        return Effect.fail(notFound('Unknown factory run'));
      }
      // Only hydrate related rows after every requested run has passed the
      // organization boundary above.
      return dataEffect(() =>
        Promise.all([
          sources.stages(ids),
          sources.agentRuns(ids),
          sources.events(ids),
          sources.models(ids),
        ]),
      ).pipe(
        Effect.map(([stages, agentRuns, events, models]) => {
          const stagesByRun = grouped(stages, (stage) => stage.factory_run_id);
          const agentRunsByStage = grouped(agentRuns, (agentRun) => agentRun.stage_run_id);
          const eventsByRun = grouped(events, (event) => event.factory_run_id);
          const modelById = new Map(models.map((model) => [model.id, model]));
          return ids.map((id): FactoryRun => {
            const row = rowById.get(id)!;
            const model = row.model_id ? modelById.get(row.model_id) : null;
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
              events: (eventsByRun.get(row.id) ?? []).map((event) => ({
                id: event.id,
                stageRunId: event.stage_run_id,
                kind: event.kind,
                payload: event.payload,
                createdAt: event.created_at,
              })),
              stages: (stagesByRun.get(row.id) ?? []).map((stage) => ({
                id: stage.id,
                stageKey: stage.stage_key,
                attempt: stage.attempt,
                status: stage.status,
                errorCode: stage.error_code,
                errorMessage: stage.error_message,
                agentRuns: (agentRunsByStage.get(stage.id) ?? []).map((agentRun) => ({
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
        }),
      );
    }),
  );
};

export const loadFactoryRun = (
  organizationIds: readonly string[],
  id: number,
): Effect.Effect<FactoryRun, DomainError> =>
  loadFactoryRuns(organizationIds, [id]).pipe(Effect.map((runs) => runs[0]!));
