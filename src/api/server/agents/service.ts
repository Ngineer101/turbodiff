import { Context, Effect, Layer } from 'effect';
import {
  createAgent,
  deleteAgent,
  getAgent,
  getAgentBySlug,
  listAgents,
  updateAgent,
  type AgentRow,
} from '../../../data/agents.ts';
import { getModelCatalog, ModelCatalogConfigurationError } from '../../../data/models.ts';
import { getSkill, listAgentSkillIds, replaceAgentSkillLinks } from '../../../data/skills.ts';
import { AGENT_DEFINITIONS, BUILTIN_AGENTS } from '../../../domain/agent-definitions.ts';
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
  conflict,
  forbidden,
  internalServerError,
  notFound,
  serviceUnavailable,
  type DomainError,
} from '../../contract/errors.ts';
import { requireOrganizationWrite } from '../authorization.ts';

const builtinDefinitions = new Map<string, string>(
  BUILTIN_AGENTS.map((agent) => [agent.slug, agent.definitionKey]),
);
const isBuiltIn = (row: AgentRow) =>
  builtinDefinitions.get(row.slug) === row.definition_key || row.definition_key === 'verifier';

const operation = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      if (failure instanceof ModelCatalogConfigurationError) {
        return serviceUnavailable(failure.message);
      }
      console.error('turbodiff: agent operation failed', failure);
      return internalServerError();
    },
  });

const summary = (row: AgentRow, skillIds: number[]) => ({
  id: row.id,
  organizationId: row.organization_id,
  definitionKey: row.definition_key,
  slug: row.slug,
  name: row.name,
  description: row.description,
  builtIn: isBuiltIn(row),
  enabled: row.enabled,
  skillIds,
});

const serialize = (row: AgentRow, skillIds: number[]): Agent => ({
  ...summary(row, skillIds),
  instructionsOverride: row.instructions_override,
});

const validSlug = (slug: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

const owned = (user: CurrentUserIdentity, id: number) =>
  operation(() => getAgent(id)).pipe(
    Effect.flatMap((row) =>
      row && user.organizationIds.includes(row.organization_id)
        ? Effect.succeed(row)
        : Effect.fail(notFound('Unknown agent')),
    ),
  );

const validSkillIds = (organizationId: string, rawIds: readonly number[]) =>
  Effect.gen(function* () {
    const skillIds = [...new Set(rawIds)];
    const skills = yield* operation(() => Promise.all(skillIds.map(getSkill)));
    if (!skills.every((skill) => skill?.organization_id === organizationId && skill.enabled)) {
      return yield* Effect.fail(
        badRequest('A skill is unknown, disabled, or belongs to another organization'),
      );
    }
    return skillIds;
  });

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

export const AgentServiceLive = Layer.succeed(AgentService, {
  models: () =>
    operation(getModelCatalog).pipe(
      Effect.map((catalog) => ({
        options: catalog.options.map(({ id, label }) => ({ id, label })),
        defaultModel: catalog.defaultModel,
        fastModel: catalog.fastModel,
      })),
    ),
  list: (user) =>
    Effect.gen(function* () {
      const items = yield* operation(() => listAgents(user.organizationIds));
      const links = yield* operation(() => listAgentSkillIds(items.map((item) => item.id)));
      return {
        items: items.map((item) =>
          summary(
            item,
            links.filter((link) => link.agent_id === item.id).map((link) => link.skill_id),
          ),
        ),
      };
    }),
  get: (user, id) =>
    Effect.gen(function* () {
      const row = yield* owned(user, id);
      const links = yield* operation(() => listAgentSkillIds([row.id]));
      return serialize(
        row,
        links.map((link) => link.skill_id),
      );
    }),
  create: (user, input) =>
    Effect.gen(function* () {
      yield* requireOrganizationWrite(user, input.organizationId);
      const slug = input.slug.trim().toLowerCase();
      const name = input.name.trim();
      const definitionKey = input.definitionKey.trim();
      const instructionsOverride = input.instructionsOverride?.trim() || null;
      if (!validSlug(slug) || slug.length > 63) {
        return yield* Effect.fail(badRequest('Agent slug is invalid'));
      }
      if (!name) return yield* Effect.fail(badRequest('Agent name is required'));
      if (!(definitionKey in AGENT_DEFINITIONS)) {
        return yield* Effect.fail(badRequest('Unknown agent definition'));
      }
      if (yield* operation(() => getAgentBySlug(input.organizationId, slug))) {
        return yield* Effect.fail(conflict(`Agent slug "${slug}" already exists`));
      }
      const skillIds = yield* validSkillIds(input.organizationId, input.skillIds ?? []);
      const created = yield* operation(() =>
        createAgent({
          organizationId: input.organizationId,
          definitionKey,
          slug,
          name,
          description: input.description?.trim() || null,
          instructionsOverride,
        }),
      );
      yield* operation(() => replaceAgentSkillLinks(created.id, created.organization_id, skillIds));
      return serialize(created, skillIds);
    }),
  update: (user, id, input) =>
    Effect.gen(function* () {
      const row = yield* owned(user, id);
      yield* requireOrganizationWrite(user, row.organization_id);
      const name = input.name?.trim();
      if (input.name !== undefined && !name) {
        return yield* Effect.fail(badRequest('Agent name is required'));
      }
      const skillIds =
        input.skillIds === undefined
          ? null
          : yield* validSkillIds(row.organization_id, input.skillIds);
      yield* operation(() =>
        updateAgent(id, {
          name,
          description:
            input.description === undefined ? undefined : input.description?.trim() || null,
          instructionsOverride:
            input.instructionsOverride === undefined
              ? undefined
              : input.instructionsOverride?.trim() || null,
          enabled: input.enabled,
        }),
      );
      if (skillIds) {
        yield* operation(() => replaceAgentSkillLinks(row.id, row.organization_id, skillIds));
      }
      const updated = yield* operation(() => getAgent(id));
      if (!updated) return yield* Effect.fail(notFound('Unknown agent'));
      const links = yield* operation(() => listAgentSkillIds([updated.id]));
      return serialize(
        updated,
        links.map((link) => link.skill_id),
      );
    }),
  remove: (user, id) =>
    Effect.gen(function* () {
      const row = yield* owned(user, id);
      yield* requireOrganizationWrite(user, row.organization_id);
      if (isBuiltIn(row)) {
        return yield* Effect.fail(forbidden('Built-in agents cannot be deleted'));
      }
      yield* operation(() => deleteAgent(id));
    }),
} satisfies AgentOperations);
