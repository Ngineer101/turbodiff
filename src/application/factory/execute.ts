import {
  activeAcceptanceContract,
  approveWorkItemPlan,
  createAcceptanceContract,
  createDeliveries,
  getWorkItem,
  listDeliveriesForWorkItem,
  updateDeliveryStatus,
  updateWorkItem,
  type WorkItemRow,
} from '../../data/work.ts';
import { getAgent } from '../../data/agents.ts';
import { getArtifact } from '../../data/artifacts.ts';
import { getAutomation } from '../../data/automations.ts';
import {
  claimStageRun,
  createFactoryRunWithStage,
  finishStageRun,
  failAgentRun,
  listAgentRunsForStage,
  getFactoryRun,
  getStageRun,
  recordLifecycleEvent,
  updateFactoryRunStatus,
  waitStageRun,
  type FactoryRunRow,
  type StageRunRow,
} from '../../data/execution.ts';
import type { RunFactoryMessage } from './message.ts';
import { isJsonObject, isString, type JsonObject } from '../../shared/json.ts';
import {
  acceptanceContractArtifactSchema,
  storedPlanArtifactSchema,
} from '../../artifacts/plan.ts';
import { isSandboxTransportError } from '../../integrations/agent-runtime/sandbox.ts';
import { notifyOrganizationsLive } from '../notifications/live-updates.ts';
import { loadJsonArtifact, persistJsonArtifact } from '../artifacts.ts';
import { executeChatStage, type ChatStageRuntime } from './stages/chat.ts';
import { executeDeliveryStage } from './stages/delivery.ts';
import { executePlanningStage } from './stages/planning.ts';
import { executeReviewStage } from './stages/review.ts';
import { executeExplanationStage } from './stages/explanation.ts';
import { DELIVERY_FLOW, factoryFlow, factoryStage } from './flows.ts';
import { enqueueFactoryMessages } from './queue.ts';

async function finishSucceeded(
  run: FactoryRunRow,
  stage: StageRunRow,
  kind: string,
  payload: JsonObject,
): Promise<void> {
  await finishStageRun(stage.id, 'succeeded');
  await updateFactoryRunStatus(run.id, 'succeeded');
  await recordLifecycleEvent({
    organizationId: run.organization_id,
    factoryRunId: run.id,
    stageRunId: stage.id,
    kind,
    payload,
  });
  await notifyOrganizationsLive([run.organization_id]);
}

async function finishAtGate(
  run: FactoryRunRow,
  stage: StageRunRow,
  kind: string,
  payload: JsonObject,
  gate: string,
  nextStage: string,
): Promise<void> {
  await waitStageRun(stage.id);
  await updateFactoryRunStatus(run.id, 'waiting');
  await recordLifecycleEvent({
    organizationId: run.organization_id,
    factoryRunId: run.id,
    stageRunId: stage.id,
    kind,
    payload,
  });
  await recordLifecycleEvent({
    organizationId: run.organization_id,
    factoryRunId: run.id,
    stageRunId: stage.id,
    kind: 'gate_waiting',
    payload: { gate, nextStage },
  });
  await notifyOrganizationsLive([run.organization_id]);
}

async function dispatchWorkItem(
  run: FactoryRunRow,
  workItem: WorkItemRow,
): Promise<{ deliveryIds: number[]; messages: RunFactoryMessage[] }> {
  if (!workItem.approved_plan_artifact_id) throw new Error('work item has no approved plan');
  const planRow = await getArtifact(workItem.approved_plan_artifact_id);
  if (!planRow || planRow.organization_id !== workItem.organization_id) {
    throw new Error('approved plan artifact is missing');
  }
  const plan = await loadJsonArtifact(planRow, storedPlanArtifactSchema);
  await createDeliveries(workItem);
  const deliveries = await listDeliveriesForWorkItem(workItem.id);
  const messages: RunFactoryMessage[] = [];
  for (const delivery of deliveries) {
    if (!(await activeAcceptanceContract(delivery.id))) {
      const artifact = await persistJsonArtifact({
        organizationId: run.organization_id,
        kind: 'acceptance_contract',
        storageKey:
          `organizations/${run.organization_id}/deliveries/${delivery.id}` +
          `/acceptance-contracts/plan-${planRow.id}.json`,
        schema: acceptanceContractArtifactSchema,
        value: {
          kind: 'acceptance-contract',
          planArtifactId: planRow.id,
          criteria: plan.acceptance,
        },
      });
      await createAcceptanceContract({ delivery, artifact, status: 'active' });
    }
    const key = `dispatch:${run.id}:delivery:${delivery.id}`;
    const child = await createFactoryRunWithStage(
      {
        organizationId: run.organization_id,
        flowKey: DELIVERY_FLOW.key,
        flowVersion: DELIVERY_FLOW.version,
        modelId: run.model_id ?? undefined,
        deliveryId: delivery.id,
        automationId: run.automation_id ?? undefined,
        parentRunId: run.id,
        trigger: 'dispatch',
        actorUserId: run.actor_user_id ?? undefined,
        idempotencyKey: key,
      },
      {
        stageKey: DELIVERY_FLOW.initialStage,
        idempotencyKey: `${key}:${DELIVERY_FLOW.initialStage}:1`,
      },
    );
    await updateDeliveryStatus(delivery.id, 'active');
    messages.push({
      kind: 'run_factory',
      factoryRunId: child.factoryRun.id,
      stageRunId: child.stageRun.id,
    });
  }
  await updateWorkItem(workItem.id, { status: 'in_progress' });
  return { deliveryIds: deliveries.map((delivery) => delivery.id), messages };
}

async function prepareAutomationPlan(run: FactoryRunRow, workItem: WorkItemRow): Promise<void> {
  if (!run.automation_id) throw new Error('automation run has no automation');
  const automation = await getAutomation(run.automation_id);
  if (!automation || automation.organization_id !== run.organization_id) {
    throw new Error('automation is missing');
  }
  const template = isJsonObject(automation.input_template) ? automation.input_template : {};
  const plan = isString(template.description)
    ? template.description
    : isString(template.prompt)
      ? template.prompt
      : workItem.description;
  const artifact = await persistJsonArtifact({
    organizationId: run.organization_id,
    kind: 'plan',
    storageKey: `organizations/${run.organization_id}/factory-runs/${run.id}/automation-plan.json`,
    schema: storedPlanArtifactSchema,
    value: {
      kind: 'plan',
      plan,
      summary: automation.name,
      acceptance: [],
    },
  });
  await approveWorkItemPlan(workItem.id, artifact);
}

export async function executeFactoryStage(
  message: RunFactoryMessage,
  chatRuntime?: ChatStageRuntime,
): Promise<void> {
  const [run, stage] = await Promise.all([
    getFactoryRun(message.factoryRunId),
    getStageRun(message.stageRunId),
  ]);
  if (!run || !stage || stage.factory_run_id !== run.id) return;
  if (!(await claimStageRun(stage.id)) && stage.status !== 'running') return;

  await updateFactoryRunStatus(run.id, 'running');
  await recordLifecycleEvent({
    organizationId: run.organization_id,
    factoryRunId: run.id,
    stageRunId: stage.id,
    kind: 'stage_started',
    payload: { stageKey: stage.stage_key },
  });

  try {
    // An interrupted chat may already have pushed a commit. Never replay its
    // mutable checkout; expose the failure so a new turn starts from remote HEAD.
    if (run.flow_key === 'chat' && stage.status === 'running') {
      throw new Error('Chat execution was interrupted. Check the branch and retry your message.');
    }
    const flow = factoryFlow(run.flow_key, run.flow_version);
    const definition = flow ? factoryStage(flow, stage.stage_key) : undefined;
    if (!flow || !definition) {
      throw new Error(
        `unknown factory stage ${run.flow_key}@${run.flow_version}/${stage.stage_key}`,
      );
    }

    if (definition.operation === 'dispatch' || definition.operation === 'invoke_automation') {
      if (!run.work_item_id) throw new Error('factory run has no work item');
      const workItem = await getWorkItem(run.work_item_id);
      if (!workItem) throw new Error('work item is missing');
      if (definition.operation === 'invoke_automation') {
        if (!run.automation_id) throw new Error('automation run has no automation');
        const automation = await getAutomation(run.automation_id);
        if (!automation || automation.organization_id !== run.organization_id) {
          throw new Error('automation is missing');
        }
        const agent = await getAgent(automation.agent_id);
        if (!agent?.enabled || agent.organization_id !== run.organization_id) {
          throw new Error('automation agent is unavailable');
        }
        if (agent.definition_key === 'planner') {
          const result = await executePlanningStage(run, stage, agent.id);
          await finishSucceeded(run, stage, 'plan_created', result);
          return;
        }
        if (agent.definition_key !== 'implementer') {
          throw new Error(`automation agent definition ${agent.definition_key} is unsupported`);
        }
        await prepareAutomationPlan(run, workItem);
      }
      const dispatched = await dispatchWorkItem(run, workItem);
      await finishSucceeded(run, stage, 'deliveries_dispatched', {
        deliveryIds: dispatched.deliveryIds,
      });
      try {
        await enqueueFactoryMessages(dispatched.messages);
      } catch (error) {
        console.warn('turbodiff: child factory enqueue deferred to recovery', error);
      }
      return;
    }

    if (definition.operation === 'plan') {
      const result = await executePlanningStage(run, stage);
      if (definition.success.kind !== 'gate') throw new Error('planning stage must end at a gate');
      await finishAtGate(
        run,
        stage,
        'plan_created',
        result,
        definition.success.gate,
        definition.success.nextStage,
      );
      return;
    }
    if (definition.operation === 'implement') {
      const result = await executeDeliveryStage(run, stage);
      await finishSucceeded(run, stage, result.outcome, result);
      return;
    }
    if (definition.operation === 'chat') {
      const result = await executeChatStage(run, stage, chatRuntime);
      await finishSucceeded(run, stage, 'chat_completed', result);
      return;
    }
    if (definition.operation === 'review') {
      const result = await executeReviewStage(run, stage);
      await finishSucceeded(run, stage, 'review_completed', result);
      return;
    }
    if (definition.operation === 'explain') {
      const result = await executeExplanationStage(run, stage);
      await finishSucceeded(run, stage, 'explanation_completed', result);
      return;
    }
    throw new Error('Unsupported factory operation');
  } catch (failure) {
    if (run.flow_key !== 'chat' && isSandboxTransportError(failure)) throw failure;
    const detail = failure instanceof Error ? failure.message : 'Factory stage failed';
    await finishStageRun(stage.id, 'failed', { code: 'stage_failed', message: detail });
    await updateFactoryRunStatus(run.id, 'failed');
    if (run.flow_key === 'chat') {
      for (const agent of await listAgentRunsForStage(stage.id)) {
        await failAgentRun(agent.id, { code: 'stage_failed', message: detail });
      }
    } else if (run.delivery_id) await updateDeliveryStatus(run.delivery_id, 'failed');
    await recordLifecycleEvent({
      organizationId: run.organization_id,
      factoryRunId: run.id,
      stageRunId: stage.id,
      kind: 'stage_failed',
      payload: { message: detail },
    });
    await notifyOrganizationsLive([run.organization_id]);
  }
}

export async function failFactoryStageInfrastructure(
  message: RunFactoryMessage,
  failure: Error,
): Promise<void> {
  const [run, stage] = await Promise.all([
    getFactoryRun(message.factoryRunId),
    getStageRun(message.stageRunId),
  ]);
  if (!run || !stage || stage.factory_run_id !== run.id) return;
  if (['succeeded', 'failed', 'skipped', 'cancelled'].includes(stage.status)) return;
  const detail = failure.message.slice(0, 1_000);
  await finishStageRun(stage.id, 'failed', {
    code: 'infrastructure_failed',
    message: detail,
  });
  await updateFactoryRunStatus(run.id, 'failed');
  if (run.flow_key !== 'chat' && run.delivery_id)
    await updateDeliveryStatus(run.delivery_id, 'failed');
  await recordLifecycleEvent({
    organizationId: run.organization_id,
    factoryRunId: run.id,
    stageRunId: stage.id,
    kind: 'stage_failed',
    payload: { code: 'infrastructure_failed', message: detail },
  });
  await notifyOrganizationsLive([run.organization_id]);
}
