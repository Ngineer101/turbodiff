import type { AgentDefinition, AgentExecutor } from './types.ts';

export interface RunAgentOptions {
  model: string | null;
  execute: AgentExecutor;
}

// The single generic agent boundary. Inputs are checked before paid work starts;
// the executor receives the exact artifact schema it must satisfy.
export async function runAgent<Input, Output>(
  agent: AgentDefinition<Input, Output>,
  input: Input,
  options: RunAgentOptions,
): Promise<Output> {
  const checkedInput = agent.input.parse(input);
  return options.execute(
    {
      agentId: agent.id,
      model: options.model,
      prompt: agent.prompt(checkedInput),
      repositoryAccess: agent.repositoryAccess,
    },
    agent.output(checkedInput),
  );
}
