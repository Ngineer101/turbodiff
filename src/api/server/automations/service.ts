import { Context, Effect, Layer } from 'effect';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  updateAutomation,
  type AutomationRow,
} from '../../../data/automations.ts';
import { getAgent } from '../../../data/agents.ts';
import {
  createFactoryRunWithStage,
  getFactoryRun,
  listFactoryRuns,
  type FactoryRunRow,
} from '../../../data/execution.ts';
import {
  getIntegration,
  listAutomationIntegrationIds,
  replaceAutomationIntegrationLinks,
} from '../../../data/integrations.ts';
import { getRepository } from '../../../data/repositories.ts';
import {
  getSkill,
  listAutomationSkillIds,
  replaceAutomationSkillLinks,
} from '../../../data/skills.ts';
import { createWorkItem } from '../../../data/work.ts';
import { nextAutomationRunAt } from '../../../domain/automation-schedule.ts';
import { AUTOMATION_FLOW } from '../../../application/factory/flows.ts';
import { withTransaction } from '../../../data/postgres.ts';
import { isJsonObject, isString, type JsonValue } from '../../../shared/json.ts';
import type {
  Automation,
  AutomationCollection,
  AutomationRun,
  CreateAutomation,
  UpdateAutomation,
} from '../../contract/automations.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import {
  badRequest,
  conflict,
  internalServerError,
  notFound,
  type DomainError,
} from '../../contract/errors.ts';
import { requireOrganizationWrite } from '../authorization.ts';
import { ApiDependencies } from '../context.ts';

const dataEffect = <A>(run: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: run,
    catch: (failure) => {
      console.error('turbodiff: automation operation failed', failure);
      return internalServerError();
    },
  });

const serialize = (
  row: AutomationRow,
  skillIds: number[],
  integrationIds: number[],
): Automation => ({
  id: row.id,
  organizationId: row.organization_id,
  agentId: row.agent_id,
  repositoryId: row.repository_id,
  name: row.name,
  schedule: row.schedule,
  timezone: row.timezone,
  inputTemplate: row.input_template,
  skillIds,
  integrationIds,
  enabled: row.enabled,
  nextRunAt: row.next_run_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const serializeRun = (row: FactoryRunRow): AutomationRun => ({
  id: row.id,
  automationId: row.automation_id!,
  workItemId: row.work_item_id,
  status: row.status,
  createdAt: row.created_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

const owned = (user: CurrentUserIdentity, id: number) =>
  dataEffect(() => getAutomation(id)).pipe(
    Effect.flatMap((row) =>
      row && user.organizationIds.includes(row.organization_id)
        ? Effect.succeed(row)
        : Effect.fail(notFound('Unknown automation')),
    ),
  );

const validateRelations = (organizationId: string, agentId: number, repositoryId: number | null) =>
  dataEffect(async () => {
    const [agent, repository] = await Promise.all([
      getAgent(agentId),
      repositoryId ? getRepository(repositoryId) : null,
    ]);
    if (!agent || agent.organization_id !== organizationId || !agent.enabled) {
      return 'Agent is unknown, disabled, or belongs to another organization';
    }
    if (agent.definition_key !== 'planner' && agent.definition_key !== 'implementer') {
      return `Agent definition ${agent.definition_key} cannot drive an automation`;
    }
    if (!repositoryId) return 'Planner and implementer automations require a repository';
    if (!repository || repository.organization_id !== organizationId || !repository.enabled) {
      return 'Repository is unknown, disabled, or belongs to another organization';
    }
    return null;
  });

const validateBindings = (
  organizationId: string,
  rawSkillIds: readonly number[],
  rawIntegrationIds: readonly number[],
) =>
  dataEffect(async () => {
    const skillIds = [...new Set(rawSkillIds)];
    const integrationIds = [...new Set(rawIntegrationIds)];
    const [skills, integrations] = await Promise.all([
      Promise.all(skillIds.map(getSkill)),
      Promise.all(integrationIds.map(getIntegration)),
    ]);
    const valid =
      skills.every((skill) => skill?.organization_id === organizationId && skill.enabled) &&
      integrations.every(
        (integration) => integration?.organization_id === organizationId && integration.enabled,
      );
    return valid ? { skillIds, integrationIds } : null;
  }).pipe(
    Effect.flatMap((bindings) =>
      bindings
        ? Effect.succeed(bindings)
        : Effect.fail(
            badRequest(
              'A skill or integration is unknown, disabled, or belongs to another organization',
            ),
          ),
    ),
  );

const nextRunAt = (schedule: string, timezone: string): Effect.Effect<string, DomainError> => {
  if (timezone !== 'UTC') return Effect.fail(badRequest('Only the UTC timezone is supported'));
  const next = nextAutomationRunAt(schedule, new Date());
  return next
    ? Effect.succeed(next)
    : Effect.fail(badRequest('schedule must be "hourly", "daily HH:MM", or "weekly D HH:MM"'));
};

interface AutomationWorkItemText {
  title: string;
  description: string;
}

const workItemText = (automation: AutomationRow): AutomationWorkItemText => {
  const template = isJsonObject(automation.input_template) ? automation.input_template : {};
  return {
    title: isString(template.title) ? template.title : automation.name,
    description: isString(template.description)
      ? template.description
      : JSON.stringify(automation.input_template),
  };
};

export interface AutomationOperations {
  readonly list: (user: CurrentUserIdentity) => Effect.Effect<AutomationCollection, DomainError>;
  readonly get: (user: CurrentUserIdentity, id: number) => Effect.Effect<Automation, DomainError>;
  readonly create: (
    user: CurrentUserIdentity,
    input: CreateAutomation,
  ) => Effect.Effect<Automation, DomainError>;
  readonly update: (
    user: CurrentUserIdentity,
    id: number,
    input: UpdateAutomation,
  ) => Effect.Effect<Automation, DomainError>;
  readonly remove: (user: CurrentUserIdentity, id: number) => Effect.Effect<void, DomainError>;
  readonly listRuns: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ items: readonly AutomationRun[] }, DomainError>;
  readonly run: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ factoryRunId: number; status: 'queued' }, DomainError>;
  readonly getRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<AutomationRun, DomainError>;
}

export class AutomationService extends Context.Tag('Turbodiff/AutomationService')<
  AutomationService,
  AutomationOperations
>() {}

export const AutomationServiceLive = Layer.effect(
  AutomationService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const loadBindings = (rows: AutomationRow[]) =>
      dataEffect(async () => {
        const ids = rows.map((row) => row.id);
        const [skills, integrations] = await Promise.all([
          listAutomationSkillIds(ids),
          listAutomationIntegrationIds(ids),
        ]);
        return { skills, integrations };
      });

    const serializeWith = (
      row: AutomationRow,
      bindings: Effect.Effect.Success<ReturnType<typeof loadBindings>>,
    ) =>
      serialize(
        row,
        bindings.skills
          .filter((link) => link.automation_id === row.id)
          .map((link) => link.skill_id),
        bindings.integrations
          .filter((link) => link.automation_id === row.id)
          .map((link) => link.integration_id),
      );

    const trigger = (user: CurrentUserIdentity, automation: AutomationRow) =>
      Effect.gen(function* () {
        const text = workItemText(automation);
        const key = `automation:${automation.id}:${crypto.randomUUID()}`;
        const started = yield* dataEffect(() =>
          withTransaction(async () => {
            const workItem = await createWorkItem({
              organizationId: automation.organization_id,
              origin: 'automation',
              title: text.title.slice(0, 200),
              description: text.description,
              createdByUserId: user.session.authUserId,
              repositoryIds: automation.repository_id ? [automation.repository_id] : [],
            });
            return createFactoryRunWithStage(
              {
                organizationId: automation.organization_id,
                flowKey: AUTOMATION_FLOW.key,
                flowVersion: AUTOMATION_FLOW.version,
                workItemId: workItem.id,
                automationId: automation.id,
                trigger: 'manual',
                actorUserId: user.session.authUserId,
                idempotencyKey: key,
              },
              {
                stageKey: AUTOMATION_FLOW.initialStage,
                idempotencyKey: `${key}:${AUTOMATION_FLOW.initialStage}:1`,
              },
            );
          }),
        );
        yield* dataEffect(() =>
          dependencies.enqueueFactory({
            kind: 'run_factory',
            factoryRunId: started.factoryRun.id,
            stageRunId: started.stageRun.id,
          }),
        );
        return { factoryRunId: started.factoryRun.id, status: 'queued' as const };
      });

    return {
      list: (user) =>
        Effect.gen(function* () {
          const items = yield* dataEffect(() => listAutomations(user.organizationIds));
          const bindings = yield* loadBindings(items);
          return { items: items.map((item) => serializeWith(item, bindings)) };
        }),
      get: (user, id) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          return serializeWith(row, yield* loadBindings([row]));
        }),
      create: (user, input) =>
        Effect.gen(function* () {
          yield* requireOrganizationWrite(user, input.organizationId);
          const name = input.name.trim();
          const schedule = input.schedule.trim().toLowerCase();
          const timezone = input.timezone?.trim() || 'UTC';
          if (!name) return yield* Effect.fail(badRequest('Automation name is required'));
          if (!isJsonObject(input.inputTemplate)) {
            return yield* Effect.fail(badRequest('inputTemplate must be a JSON object'));
          }
          const inputTemplate: JsonValue = input.inputTemplate;
          const repositoryId = input.repositoryId ?? null;
          const relationError = yield* validateRelations(
            input.organizationId,
            input.agentId,
            repositoryId,
          );
          if (relationError) return yield* Effect.fail(badRequest(relationError));
          const bindings = yield* validateBindings(
            input.organizationId,
            input.skillIds ?? [],
            input.integrationIds ?? [],
          );
          const next = yield* nextRunAt(schedule, timezone);
          const row = yield* dataEffect(() =>
            createAutomation({
              organizationId: input.organizationId,
              agentId: input.agentId,
              repositoryId,
              name,
              schedule,
              timezone,
              inputTemplate,
              enabled: input.enabled ?? true,
              nextRunAt: input.enabled === false ? null : next,
              createdByUserId: user.session.authUserId,
            }),
          );
          yield* dataEffect(() =>
            Promise.all([
              replaceAutomationSkillLinks(row.id, row.organization_id, bindings.skillIds),
              replaceAutomationIntegrationLinks(
                row.id,
                row.organization_id,
                bindings.integrationIds,
              ),
            ]),
          );
          return serialize(row, bindings.skillIds, bindings.integrationIds);
        }),
      update: (user, id, input) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          yield* requireOrganizationWrite(user, row.organization_id);
          const name = input.name?.trim() ?? row.name;
          const schedule = input.schedule?.trim().toLowerCase() ?? row.schedule;
          const timezone = input.timezone?.trim() ?? row.timezone;
          const agentId = input.agentId ?? row.agent_id;
          const repositoryId =
            input.repositoryId === undefined ? row.repository_id : input.repositoryId;
          const enabled = input.enabled ?? row.enabled;
          const template = input.inputTemplate ?? row.input_template;
          if (!name) return yield* Effect.fail(badRequest('Automation name is required'));
          if (!isJsonObject(template)) {
            return yield* Effect.fail(badRequest('inputTemplate must be a JSON object'));
          }
          const inputTemplate: JsonValue = template;
          const relationError = yield* validateRelations(
            row.organization_id,
            agentId,
            repositoryId,
          );
          if (relationError) return yield* Effect.fail(badRequest(relationError));
          const existingBindings = yield* loadBindings([row]);
          const bindings = yield* validateBindings(
            row.organization_id,
            input.skillIds ?? existingBindings.skills.map((link) => link.skill_id),
            input.integrationIds ??
              existingBindings.integrations.map((link) => link.integration_id),
          );
          const next = enabled ? yield* nextRunAt(schedule, timezone) : null;
          yield* dataEffect(() =>
            updateAutomation(id, {
              agentId,
              repositoryId,
              name,
              schedule,
              timezone,
              inputTemplate,
              enabled,
              nextRunAt: next,
            }),
          );
          yield* dataEffect(() =>
            Promise.all([
              replaceAutomationSkillLinks(id, row.organization_id, bindings.skillIds),
              replaceAutomationIntegrationLinks(id, row.organization_id, bindings.integrationIds),
            ]),
          );
          const updated = yield* dataEffect(() => getAutomation(id));
          if (!updated) return yield* Effect.fail(notFound('Unknown automation'));
          return serialize(updated, bindings.skillIds, bindings.integrationIds);
        }),
      remove: (user, id) =>
        Effect.gen(function* () {
          const row = yield* owned(user, id);
          yield* requireOrganizationWrite(user, row.organization_id);
          yield* dataEffect(() => deleteAutomation(id));
        }),
      listRuns: (user, id) =>
        Effect.gen(function* () {
          const automation = yield* owned(user, id);
          const rows = yield* dataEffect(() => listFactoryRuns({ automationId: automation.id }));
          return { items: rows.map(serializeRun) };
        }),
      run: (user, id) =>
        Effect.gen(function* () {
          const automation = yield* owned(user, id);
          yield* requireOrganizationWrite(user, automation.organization_id);
          if (!automation.enabled) return yield* Effect.fail(conflict('Automation is disabled'));
          return yield* trigger(user, automation);
        }),
      getRun: (user, id) =>
        Effect.gen(function* () {
          const run = yield* dataEffect(() => getFactoryRun(id));
          if (!run || !run.automation_id || !user.organizationIds.includes(run.organization_id)) {
            return yield* Effect.fail(notFound('Unknown automation factory run'));
          }
          return serializeRun(run);
        }),
    } satisfies AutomationOperations;
  }),
);
