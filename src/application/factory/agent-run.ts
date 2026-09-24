import type { ZodType } from 'zod';
import { runAgent } from '../../agents/run.ts';
import type { AgentDefinition, AgentExecutionRequest } from '../../agents/types.ts';
import type { CodingAgentRun } from '../../integrations/agent-runtime/coding-agent.ts';
import { isSandboxTransportError } from '../../integrations/agent-runtime/sandbox.ts';
import {
  claimAgentRun,
  completeAgentRun,
  createAgentRun,
  failAgentRun,
  type FactoryRunRow,
  type StageRunRow,
} from '../../data/execution.ts';
import type { AgentRow } from '../../data/agents.ts';
import { getArtifact } from '../../data/artifacts.ts';
import { canonicalModelId, getModel, resolveModel } from '../../data/models.ts';
import { loadJsonArtifact, persistArtifactBody, persistJsonArtifact } from '../artifacts.ts';

export interface AgentInvocation<Output> {
  artifact: Output;
  run: CodingAgentRun;
  sanitize?: (value: string) => string;
}

export interface TrackedAgentExecutionRequest extends AgentExecutionRequest {
  usage: {
    organizationId: string;
    agentRunId: number;
  };
}

function completedInvocation<Output>(
  invocation: AgentInvocation<Output> | null,
): AgentInvocation<Output> {
  if (!invocation) throw new Error('agent executor returned no run metadata');
  return invocation;
}

export async function runTrackedAgent<Input, Output>(input: {
  factoryRun: FactoryRunRow;
  stageRun: StageRunRow;
  agent: AgentRow;
  definition: AgentDefinition<Input, Output>;
  value: Input;
  inputKind: string;
  outputKind: string;
  model?: string | null;
  invoke: (
    request: TrackedAgentExecutionRequest,
    output: ZodType<Output>,
  ) => Promise<AgentInvocation<Output>>;
}): Promise<{ artifact: Output; agentRunId: number; outputArtifactId: number }> {
  if (input.agent.definition_key !== input.definition.id) {
    throw new Error(
      `agent ${input.agent.slug} uses ${input.agent.definition_key}, expected ${input.definition.id}`,
    );
  }
  const prefix =
    `organizations/${input.factoryRun.organization_id}/factory-runs/${input.factoryRun.id}` +
    `/stage-runs/${input.stageRun.id}/agents/${input.agent.id}`;
  const inputArtifact = await persistJsonArtifact({
    organizationId: input.factoryRun.organization_id,
    kind: input.inputKind,
    storageKey: `${prefix}/input.json`,
    schema: input.definition.input,
    value: input.value,
  });
  const selected = input.factoryRun.model_id
    ? await getModel(input.factoryRun.model_id)
    : await resolveModel(input.model);
  if (!selected?.enabled) throw new Error('factory run model is unavailable');
  const model = selected;
  const agentRun = await createAgentRun({
    organizationId: input.factoryRun.organization_id,
    stageRunId: input.stageRun.id,
    agentId: input.agent.id,
    modelId: model.id,
    inputArtifactId: inputArtifact.id,
    idempotencyKey: `${input.stageRun.id}:${input.agent.id}`,
  });

  if (agentRun.status === 'succeeded' && agentRun.output_artifact_id) {
    const outputArtifact = await getArtifact(agentRun.output_artifact_id);
    if (!outputArtifact) throw new Error(`agent run ${agentRun.id} output artifact is missing`);
    return {
      artifact: await loadJsonArtifact(
        outputArtifact,
        input.definition.output(input.definition.input.parse(input.value)),
      ),
      agentRunId: agentRun.id,
      outputArtifactId: outputArtifact.id,
    };
  }
  if (agentRun.status === 'failed' || agentRun.status === 'cancelled') {
    throw new Error(`agent run ${agentRun.id} is ${agentRun.status}`);
  }
  if (agentRun.status === 'queued' && !(await claimAgentRun(agentRun.id))) {
    throw new Error(`agent run ${agentRun.id} could not be claimed`);
  }

  let invocation: AgentInvocation<Output> | null = null;
  try {
    const artifact = await runAgent(input.definition, input.value, {
      model: canonicalModelId(model),
      execute: async (request, output) => {
        invocation = await input.invoke(
          {
            ...request,
            usage: {
              organizationId: input.factoryRun.organization_id,
              agentRunId: agentRun.id,
            },
          },
          output,
        );
        return invocation.artifact;
      },
    });
    const completed = completedInvocation(invocation);
    const sanitize = completed.sanitize ?? ((value: string) => value);
    const logArtifact = await persistArtifactBody({
      organizationId: input.factoryRun.organization_id,
      kind: 'agent_log',
      storageKey: `${prefix}/run-${crypto.randomUUID()}.log`,
      contentType: 'text/plain; charset=utf-8',
      body: sanitize(`${completed.run.resultText}\n${completed.run.stderr}`.trim()),
    });
    const outputArtifact = await persistJsonArtifact({
      organizationId: input.factoryRun.organization_id,
      kind: input.outputKind,
      storageKey: `${prefix}/output.json`,
      schema: input.definition.output(input.definition.input.parse(input.value)),
      value: artifact,
    });
    const usage = completed.run.usage;
    await completeAgentRun({
      id: agentRun.id,
      outputArtifactId: outputArtifact.id,
      logArtifactId: logArtifact.id,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    });
    return { artifact, agentRunId: agentRun.id, outputArtifactId: outputArtifact.id };
  } catch (failure) {
    if (isSandboxTransportError(failure)) throw failure;
    await failAgentRun(agentRun.id, {
      code: 'agent_failed',
      message: failure instanceof Error ? failure.message.slice(0, 1_000) : 'Agent failed',
    });
    throw failure;
  }
}
