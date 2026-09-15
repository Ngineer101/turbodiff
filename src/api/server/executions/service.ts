import { Context, Effect, Layer } from 'effect';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type { FactoryRun } from '../../contract/executions.ts';
import type { DomainError } from '../../contract/errors.ts';
import { loadFactoryRun } from './view.ts';

export interface ExecutionOperations {
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<FactoryRun, DomainError>;
}
export class ExecutionService extends Context.Tag('Turbodiff/ExecutionService')<
  ExecutionService,
  ExecutionOperations
>() {}
export const ExecutionServiceLive = Layer.succeed(ExecutionService, {
  get: (user, id) => loadFactoryRun(user.organizationIds, id),
} satisfies ExecutionOperations);
