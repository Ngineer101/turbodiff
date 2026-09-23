import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { loadFactoryRuns } from '../../../../src/api/server/executions/view.ts';
import type {
  AgentRunRow,
  FactoryRunRow,
  LifecycleEventRow,
  StageRunRow,
} from '../../../../src/data/execution.ts';
import type { ModelRow } from '../../../../src/data/models.ts';

const timestamp = '2026-09-20T08:00:00.000Z';

function factoryRun(id: number): FactoryRunRow {
  return {
    id,
    organization_id: 'org-1',
    flow_key: 'change_delivery',
    flow_version: 1,
    model_id: 7,
    work_item_id: 2,
    delivery_id: 3,
    change_id: 4,
    automation_id: null,
    parent_run_id: null,
    trigger: 'manual',
    actor_user_id: 'user-1',
    status: 'succeeded',
    idempotency_key: `run-${id}`,
    created_at: timestamp,
    started_at: timestamp,
    completed_at: timestamp,
  };
}

function stage(id: number, factoryRunId: number): StageRunRow {
  return {
    id,
    organization_id: 'org-1',
    factory_run_id: factoryRunId,
    stage_key: 'generate',
    attempt: 1,
    status: 'succeeded',
    idempotency_key: `stage-${id}`,
    error_code: null,
    error_message: null,
    created_at: timestamp,
    started_at: timestamp,
    completed_at: timestamp,
  };
}

function agentRun(id: number, stageRunId: number): AgentRunRow {
  return {
    id,
    organization_id: 'org-1',
    stage_run_id: stageRunId,
    agent_id: 9,
    model_id: 7,
    input_artifact_id: 20,
    output_artifact_id: 21,
    log_artifact_id: 22,
    status: 'succeeded',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 10,
    cache_write_tokens: 0,
    cost_usd: 0.01,
    error_code: null,
    error_message: null,
    idempotency_key: `agent-${id}`,
    created_at: timestamp,
    started_at: timestamp,
    completed_at: timestamp,
  };
}

function event(id: number, factoryRunId: number, stageRunId: number): LifecycleEventRow {
  return {
    id,
    organization_id: 'org-1',
    factory_run_id: factoryRunId,
    stage_run_id: stageRunId,
    kind: 'stage_completed',
    payload: { ok: true },
    created_at: timestamp,
  };
}

const model: ModelRow = {
  id: 7,
  provider: 'openai',
  model_id: 'gpt-5',
  label: 'GPT-5',
  capabilities: [],
  enabled: true,
  is_default: true,
  is_fast_default: false,
  created_at: timestamp,
};

describe('factory-run navigation view', () => {
  it('hydrates many execution graphs with one bulk read per relation', async () => {
    // This fails if run or stage history reintroduces per-row database reads,
    // which matters because those reads directly block cockpit navigation.
    const calls = { runs: 0, stages: 0, agentRuns: 0, events: 0, models: 0 };
    const expectedIds = [12, 11];
    const assertIds = (ids: readonly number[]) => expect(ids).toEqual(expectedIds);
    const result = await Effect.runPromise(
      loadFactoryRuns(['org-1'], expectedIds, {
        runs: async (ids) => {
          calls.runs++;
          assertIds(ids);
          return [factoryRun(12), factoryRun(11)];
        },
        stages: async (ids) => {
          calls.stages++;
          assertIds(ids);
          return [stage(120, 12), stage(110, 11)];
        },
        agentRuns: async (ids) => {
          calls.agentRuns++;
          assertIds(ids);
          return [agentRun(1200, 120), agentRun(1100, 110)];
        },
        events: async (ids) => {
          calls.events++;
          assertIds(ids);
          return [event(12000, 12, 120), event(11000, 11, 110)];
        },
        models: async (ids) => {
          calls.models++;
          assertIds(ids);
          return [model];
        },
      }),
    );

    expect(calls).toEqual({ runs: 1, stages: 1, agentRuns: 1, events: 1, models: 1 });
    expect(result.map((run) => run.id)).toEqual(expectedIds);
    expect(result[0]).toMatchObject({
      model: 'openai/gpt-5',
      events: [{ id: 12000 }],
      stages: [{ id: 120, agentRuns: [{ id: 1200 }] }],
    });
    expect(result[1]).toMatchObject({
      events: [{ id: 11000 }],
      stages: [{ id: 110, agentRuns: [{ id: 1100 }] }],
    });
  });
});
