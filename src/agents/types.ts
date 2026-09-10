import type { ZodType } from 'zod';

export type RepositoryAccess = 'none' | 'read' | 'write';

// A named agent is a pure specification: input and artifact schemas, prompt,
// and required repository access. It knows nothing about databases, queues,
// sandboxes, or provider APIs.
export interface AgentDefinition<Input, Output> {
  readonly id: string;
  readonly repositoryAccess: RepositoryAccess;
  readonly input: ZodType<Input>;
  readonly output: (input: Input) => ZodType<Output>;
  readonly prompt: (input: Input) => string;
}

export interface AgentExecutionRequest {
  agentId: string;
  model: string | null;
  prompt: string;
  repositoryAccess: RepositoryAccess;
}

// Executors own the untrusted runtime boundary. They must parse the runtime's
// result with the supplied schema before returning an artifact.
export type AgentExecutor = <Output>(
  request: AgentExecutionRequest,
  output: ZodType<Output>,
) => Promise<Output>;

export function defineAgent<Input, Output>(
  definition: AgentDefinition<Input, Output>,
): AgentDefinition<Input, Output> {
  return Object.freeze(definition);
}
