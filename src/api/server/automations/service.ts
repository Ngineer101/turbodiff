import { Context, Effect, Layer } from 'effect';
import {
  createAutomation,
  deleteAutomation,
  getAutomationById,
  getAutomationRunDetail,
  getRepoById,
  listAgentRunsForAutomationRun,
  listAutomationRuns,
  listAutomationsForInstallations,
  listInstallationsWithRepos,
  updateAutomation,
  type AutomationFields,
  type AutomationRow,
} from '../../../data/db.ts';
import { ModelCatalogConfigurationError, getRunnerModelCatalog } from '../../../data/models.ts';
import { computeNextRunAt } from '../../../domain/automation-schedule.ts';
import { factoryUnsupportedReason } from '../../../integrations/git/provider.ts';
import { capabilityDenied } from '../../../application/auth/access-control.ts';
import type {
  Automation,
  AutomationCollection,
  AutomationRunCollection,
  AutomationRunDetail,
  CreateAutomation,
  UpdateAutomation,
} from '../../contract/automations.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import {
  badRequest,
  conflict,
  forbidden,
  internalServerError,
  notFound,
  serviceUnavailable,
  type DomainError,
} from '../../contract/errors.ts';
import { ApiDependencies } from '../context.ts';

type AutomationRunStatus = 'running' | 'pr_opened' | 'no_changes' | 'checks_failed' | 'failed';

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
  ) => Effect.Effect<AutomationRunCollection, DomainError>;
  readonly run: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<{ automationId: number; status: 'queued' }, DomainError>;
  readonly getRun: (
    user: CurrentUserIdentity,
    id: number,
  ) => Effect.Effect<AutomationRunDetail, DomainError>;
}

export class AutomationService extends Context.Tag('Turbodiff/AutomationService')<
  AutomationService,
  AutomationOperations
>() {}

function dataEffect<A>(operation: () => Promise<A>): Effect.Effect<A, DomainError> {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => {
      if (error instanceof ModelCatalogConfigurationError) {
        return serviceUnavailable(error.message);
      }
      console.error('turbodiff: Effect API operation failed', error);
      return internalServerError();
    },
  });
}

function serialize(
  automation: AutomationRow,
  repository: { id: number; owner: string; name: string },
  lastRun: { id: number; status: string; created_at: string } | null,
): Automation {
  // SAFETY: app.automations.schedule_kind has a database CHECK constraint for this closed set.
  const scheduleKind = automation.schedule_kind as Automation['scheduleKind'];
  return {
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    repository,
    scheduleKind,
    timeOfDay: automation.time_of_day,
    dayOfWeek: automation.day_of_week,
    enabled: automation.enabled,
    runnerModel: automation.runner_model,
    nextRunAt: automation.next_run_at,
    lastRun: lastRun
      ? { id: lastRun.id, status: lastRun.status, createdAt: lastRun.created_at }
      : null,
  };
}

function normalizedFields(input: {
  name: string;
  prompt: string;
  scheduleKind: 'hourly' | 'daily' | 'weekly';
  timeOfDay: string | null;
  dayOfWeek: number | null;
  runnerModel: string | null;
}): AutomationFields {
  return {
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    schedule_kind: input.scheduleKind,
    time_of_day: input.timeOfDay?.trim() || null,
    day_of_week: input.dayOfWeek,
    runner_model: input.runnerModel?.trim() || null,
  };
}

function validate(fields: AutomationFields): string | null {
  if (!fields.name) return 'name is required';
  if (!fields.prompt) return 'prompt is required';
  if (fields.schedule_kind === 'hourly') {
    if (fields.time_of_day !== null) return 'hourly automations cannot set a time of day';
  } else if (!fields.time_of_day || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(fields.time_of_day)) {
    return 'timeOfDay is required (HH:MM, 24h UTC)';
  }
  if (fields.schedule_kind === 'weekly') {
    if (fields.day_of_week === null || fields.day_of_week < 0 || fields.day_of_week > 6) {
      return 'dayOfWeek is required for weekly automations (0-6)';
    }
  } else if (fields.day_of_week !== null) {
    return 'dayOfWeek is only valid for weekly automations';
  }
  return null;
}

function nextRun(fields: AutomationFields): string {
  // SAFETY: normalizedFields accepts only the three public schedule literals.
  const kind = fields.schedule_kind as 'hourly' | 'daily' | 'weekly';
  return computeNextRunAt(
    {
      kind,
      timeOfDay: fields.time_of_day,
      dayOfWeek: fields.day_of_week,
    },
    new Date(),
  );
}

export const AutomationServiceLive = Layer.effect(
  AutomationService,
  Effect.gen(function* () {
    const dependencies = yield* ApiDependencies;

    const authorized = (user: CurrentUserIdentity, id: number) =>
      Effect.gen(function* () {
        const automation = yield* dataEffect(() => getAutomationById(id));
        if (!automation) return yield* Effect.fail(notFound('Unknown automation'));
        const repository = yield* dataEffect(() => getRepoById(automation.repository_id));
        if (!repository || !user.installationIds.includes(repository.installation_id)) {
          return yield* Effect.fail(notFound('Unknown automation'));
        }
        return { automation, repository };
      });

    const requireSettings = (
      user: CurrentUserIdentity,
      installationId: number,
    ): Effect.Effect<void, DomainError> =>
      dataEffect(() =>
        capabilityDenied(user, installationId, 'settings', dependencies.orgAdmin),
      ).pipe(Effect.flatMap((denial) => (denial ? Effect.fail(forbidden(denial)) : Effect.void)));

    const detail = (user: CurrentUserIdentity, id: number) =>
      Effect.gen(function* () {
        const { automation, repository } = yield* authorized(user, id);
        const runs = yield* dataEffect(() => listAutomationRuns(id));
        const latest = runs[0];
        return serialize(
          automation,
          repository,
          latest ? { id: latest.id, status: latest.status, created_at: latest.created_at } : null,
        );
      });

    return {
      list: (user) =>
        Effect.gen(function* () {
          const installationIds = [...user.installationIds];
          const [automations, groups] = yield* dataEffect(() =>
            Promise.all([
              listAutomationsForInstallations(installationIds),
              listInstallationsWithRepos(installationIds),
            ]),
          );
          return {
            items: automations.map((automation) =>
              serialize(
                automation,
                {
                  id: automation.repository_id,
                  owner: automation.owner,
                  name: automation.name_repo,
                },
                automation.last_run,
              ),
            ),
            repositories: groups
              .flatMap((group) => group.repos)
              .filter((repository) => repository.enabled)
              .map((repository) => ({
                id: repository.id,
                owner: repository.owner,
                name: repository.name,
                installationId: repository.installation_id,
              })),
          };
        }),
      get: detail,
      create: (user, input) =>
        Effect.gen(function* () {
          const repository = yield* dataEffect(() => getRepoById(input.repositoryId));
          if (
            !repository ||
            !user.installationIds.includes(repository.installation_id) ||
            !repository.enabled
          ) {
            return yield* Effect.fail(notFound('Unknown or disabled repository'));
          }
          const unsupported = factoryUnsupportedReason(repository);
          if (unsupported) return yield* Effect.fail(conflict(unsupported));
          yield* requireSettings(user, repository.installation_id);
          const fields = normalizedFields(input);
          const validationError = validate(fields);
          if (validationError) return yield* Effect.fail(badRequest(validationError));
          if (fields.runner_model) {
            const catalog = yield* dataEffect(getRunnerModelCatalog);
            if (!catalog.options.some((option) => option.id === fields.runner_model)) {
              return yield* Effect.fail(badRequest('Unknown model'));
            }
          }
          const id = yield* dataEffect(() =>
            createAutomation(repository.id, fields, nextRun(fields)),
          );
          return yield* detail(user, id);
        }),
      update: (user, id, input) =>
        Effect.gen(function* () {
          const { automation, repository } = yield* authorized(user, id);
          yield* requireSettings(user, repository.installation_id);
          // SAFETY: app.automations.schedule_kind is constrained to the public schedule literals.
          const storedSchedule = automation.schedule_kind as 'hourly' | 'daily' | 'weekly';
          const fields = normalizedFields({
            name: input.name ?? automation.name,
            prompt: input.prompt ?? automation.prompt,
            scheduleKind: input.scheduleKind ?? storedSchedule,
            timeOfDay: input.timeOfDay === undefined ? automation.time_of_day : input.timeOfDay,
            dayOfWeek: input.dayOfWeek === undefined ? automation.day_of_week : input.dayOfWeek,
            runnerModel:
              input.runnerModel === undefined ? automation.runner_model : input.runnerModel,
          });
          const validationError = validate(fields);
          if (validationError) return yield* Effect.fail(badRequest(validationError));
          if (fields.runner_model && fields.runner_model !== automation.runner_model) {
            const catalog = yield* dataEffect(getRunnerModelCatalog);
            if (!catalog.options.some((option) => option.id === fields.runner_model)) {
              return yield* Effect.fail(badRequest('Unknown model'));
            }
          }
          const scheduleChanged =
            fields.schedule_kind !== automation.schedule_kind ||
            fields.time_of_day !== automation.time_of_day ||
            fields.day_of_week !== automation.day_of_week;
          yield* dataEffect(() =>
            updateAutomation(
              id,
              { ...fields, enabled: input.enabled ?? automation.enabled },
              scheduleChanged ? nextRun(fields) : automation.next_run_at,
            ),
          );
          return yield* detail(user, id);
        }),
      remove: (user, id) =>
        Effect.gen(function* () {
          const { repository } = yield* authorized(user, id);
          yield* requireSettings(user, repository.installation_id);
          yield* dataEffect(() => deleteAutomation(id));
        }),
      listRuns: (user, id) =>
        Effect.gen(function* () {
          const { automation } = yield* authorized(user, id);
          const runs = yield* dataEffect(() => listAutomationRuns(id));
          return {
            automation: { id: automation.id, name: automation.name },
            items: runs.map((run) => ({
              id: run.id,
              // SAFETY: automation_runs.status has a CHECK constraint for AutomationRunStatus.
              status: run.status as AutomationRunStatus,
              pullRequestNumber: run.pr_number,
              error: run.error,
              createdAt: run.created_at,
            })),
          };
        }),
      run: (user, id) =>
        Effect.gen(function* () {
          const { automation, repository } = yield* authorized(user, id);
          yield* requireSettings(user, repository.installation_id);
          yield* dataEffect(() =>
            dependencies.enqueueFactory({ kind: 'automation', automationId: automation.id }),
          );
          return { automationId: automation.id, status: 'queued' as const };
        }),
      getRun: (user, id) =>
        Effect.gen(function* () {
          const found = yield* dataEffect(() => getAutomationRunDetail(id));
          if (!found || !user.installationIds.includes(found.automation.installation_id)) {
            return yield* Effect.fail(notFound('Unknown automation run'));
          }
          const agentRuns = yield* dataEffect(() => listAgentRunsForAutomationRun(id));
          return {
            id: found.run.id,
            // SAFETY: automation_runs.status has a CHECK constraint for AutomationRunStatus.
            status: found.run.status as AutomationRunStatus,
            pullRequestNumber: found.run.pr_number,
            error: found.run.error,
            createdAt: found.run.created_at,
            automation: {
              id: found.automation.id,
              name: found.automation.name,
              repository: `${found.automation.owner}/${found.automation.repo}`,
            },
            agentRuns: agentRuns.map((run) => ({
              id: run.id,
              kind: run.kind,
              success: run.success,
              createdAt: run.created_at,
            })),
          };
        }),
    } satisfies AutomationOperations;
  }),
);
