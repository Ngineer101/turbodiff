import { Context, Effect, Layer } from 'effect';
import {
  createAgent,
  deleteAgent,
  ensureBuiltinAgents,
  getAgentById,
  getAgentBySlug,
  listAgents,
  updateAgent,
  type AgentRow,
} from '../../../data/db.ts';
import {
  ModelCatalogConfigurationError,
  getModelCatalog,
  getReviewerModelCatalog,
} from '../../../data/models.ts';
import { RESERVED_AGENT_SLUGS } from '../../../domain/personas.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type {
  Agent,
  AgentCollection,
  AgentUpdate,
  AgentWrite,
  ModelCatalog,
} from '../../contract/agents.ts';
import {
  badRequest,
  forbidden,
  internalServerError,
  notFound,
  serviceUnavailable,
  type DomainError,
} from '../../contract/errors.ts';
import { capableInstallationIds } from '../authorization.ts';
import { ApiDependencies } from '../context.ts';

export interface AgentOperations {
  readonly models: () => Effect.Effect<ModelCatalog, DomainError>;
  readonly list: (user: CurrentUserIdentity) => Effect.Effect<AgentCollection, DomainError>;
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Agent, DomainError>;
  readonly create: (
    user: CurrentUserIdentity,
    input: AgentWrite,
  ) => Effect.Effect<Agent, DomainError>;
  readonly update: (
    user: CurrentUserIdentity,
    id: number,
    input: AgentUpdate,
  ) => Effect.Effect<Agent, DomainError>;
  readonly remove: (user: CurrentUserIdentity, id: number) => Effect.Effect<void, DomainError>;
}

export class AgentService extends Context.Tag('Turbodiff/AgentService')<
  AgentService,
  AgentOperations
>() {}

const operation = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      if (error instanceof ModelCatalogConfigurationError) {
        return serviceUnavailable(error.message);
      }
      console.error('turbodiff: Effect agent operation failed', error);
      return internalServerError();
    },
  });

const serialize = (agent: AgentRow): Agent => ({
  id: agent.id,
  slug: agent.slug,
  name: agent.name,
  description: agent.description,
  model: agent.model,
  builtIn: agent.is_builtin,
  instructions: agent.instructions,
  installationId: agent.installation_id,
});

const slugError = (slug: string): string | null => {
  if (slug.length < 2 || slug.length > 31 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return 'slug must be 2-31 chars: lowercase letters and digits separated by single dashes';
  }
  if (RESERVED_AGENT_SLUGS.has(slug)) return `"${slug}" is a reserved word`;
  return null;
};

export const AgentServiceLive = Layer.effect(
  AgentService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const authorized = (user: CurrentUserIdentity, id: number) =>
      operation(() => getAgentById(id)).pipe(
        Effect.flatMap((agent) =>
          agent && user.installationIds.includes(agent.installation_id)
            ? Effect.succeed(agent)
            : Effect.fail(notFound('Unknown agent')),
        ),
      );

    const capable = (user: CurrentUserIdentity) => {
      if (user.installationIds.length === 0) return Effect.fail(notFound('No installations'));
      return capableInstallationIds(user, dependencies);
    };

    const validate = (
      values: { name: string; instructions: string; model: string },
      models: readonly { id: string }[],
      currentModel?: string,
    ): string | null => {
      if (!values.name) return 'name is required';
      if (!values.instructions) return 'instructions are required';
      if (!models.some((model) => model.id === values.model) && values.model !== currentModel) {
        return 'model must be one of the configured models';
      }
      return null;
    };

    return {
      models: () =>
        operation(getModelCatalog).pipe(
          Effect.map((catalog) => ({
            runner: {
              options: catalog.runner.options,
              defaultModel: catalog.runner.defaultModel,
              fastModel: catalog.runner.fastModel,
            },
            reviewer: {
              options: catalog.reviewer.options,
              defaultModel: catalog.reviewer.defaultModel,
            },
          })),
        ),
      list: (user) =>
        Effect.gen(function* () {
          const [agents, editableIds] = yield* Effect.all([
            operation(() => listAgents(user.installationIds)),
            capableInstallationIds(user, dependencies).pipe(
              Effect.catchTag('Forbidden', () => Effect.succeed([])),
            ),
          ]);
          dependencies.defer(
            Promise.all(
              user.installationIds.map((id) =>
                ensureBuiltinAgents(id).catch((error) =>
                  console.warn(`turbodiff: agent repair failed for installation ${id}`, error),
                ),
              ),
            ).then(() => undefined),
          );
          const editable = new Set(editableIds);
          const preferred = [
            ...agents.filter((agent) => editable.has(agent.installation_id)),
            ...agents.filter((agent) => !editable.has(agent.installation_id)),
          ];
          const seen = new Set<string>();
          return {
            githubAppSlug: dependencies.githubAppSlug,
            items: preferred
              .filter((agent) => (seen.has(agent.slug) ? false : (seen.add(agent.slug), true)))
              .map((agent) => ({
                id: agent.id,
                slug: agent.slug,
                name: agent.name,
                description: agent.description,
                model: agent.model,
                builtIn: agent.is_builtin,
              })),
          };
        }),
      get: (user, id) => authorized(user, id).pipe(Effect.map(serialize)),
      create: (user, input) =>
        Effect.gen(function* () {
          const installationIds = yield* capable(user);
          const catalog = yield* operation(getReviewerModelCatalog);
          const values = {
            slug: input.slug.trim().toLowerCase(),
            name: input.name.trim(),
            description: input.description.trim(),
            instructions: input.instructions.trim(),
            model: input.model?.trim() || catalog.defaultModel,
          };
          const error = slugError(values.slug) ?? validate(values, catalog.options);
          if (error) return yield* Effect.fail(badRequest(error));
          const existing = yield* operation(() =>
            Promise.all(user.installationIds.map((id) => getAgentBySlug(id, values.slug))),
          );
          if (existing.some(Boolean)) {
            return yield* Effect.fail(
              badRequest(`An agent with slug "${values.slug}" already exists`),
            );
          }
          yield* operation(() => Promise.all(installationIds.map((id) => createAgent(id, values))));
          const created = yield* operation(() => getAgentBySlug(installationIds[0], values.slug));
          if (!created) return yield* Effect.fail(internalServerError());
          return serialize(created);
        }),
      update: (user, id, input) =>
        Effect.gen(function* () {
          const agent = yield* authorized(user, id);
          const installationIds = yield* capable(user);
          const catalog = yield* operation(getReviewerModelCatalog);
          const values = {
            name: input.name?.trim() ?? agent.name,
            description: input.description?.trim() ?? agent.description ?? '',
            instructions: input.instructions?.trim() ?? agent.instructions,
            model: input.model?.trim() || agent.model,
          };
          const error = validate(values, catalog.options, agent.model);
          if (error) return yield* Effect.fail(badRequest(error));
          const siblings = (yield* operation(() => listAgents(installationIds))).filter(
            (candidate) => candidate.slug === agent.slug,
          );
          yield* operation(() =>
            Promise.all(siblings.map((sibling) => updateAgent(sibling.id, values))),
          );
          if (!agent.is_builtin) {
            const covered = new Set(siblings.map((sibling) => sibling.installation_id));
            yield* operation(() =>
              Promise.all(
                installationIds
                  .filter((installationId) => !covered.has(installationId))
                  .map((installationId) =>
                    createAgent(installationId, { ...values, slug: agent.slug }),
                  ),
              ),
            );
          }
          const updated = yield* operation(() => getAgentBySlug(installationIds[0], agent.slug));
          if (!updated) return yield* Effect.fail(notFound('Unknown agent'));
          return serialize(updated);
        }),
      remove: (user, id) =>
        Effect.gen(function* () {
          const agent = yield* authorized(user, id);
          const installationIds = yield* capable(user);
          if (agent.is_builtin) {
            return yield* Effect.fail(forbidden('Built-in agents cannot be deleted'));
          }
          const siblings = (yield* operation(() => listAgents(installationIds))).filter(
            (candidate) => candidate.slug === agent.slug && !candidate.is_builtin,
          );
          yield* operation(() => Promise.all(siblings.map((sibling) => deleteAgent(sibling.id))));
        }),
    } satisfies AgentOperations;
  }),
);
