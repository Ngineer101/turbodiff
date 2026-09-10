import type { Hono } from 'hono';
import { factoryUnsupportedReason } from '../../integrations/git/provider.ts';
import {
  createAutomation,
  deleteAutomation,
  getAutomationRunDetail,
  getRepoById,
  listAgentRunsForAutomationRun,
  listAutomationRuns,
  listAutomationsForInstallations,
  listInstallationsWithRepos,
  updateAutomation,
} from '../../data/db.ts';
import { getRunnerModelCatalog } from '../../data/models.ts';
import { computeNextRunAt } from '../../domain/automation-schedule.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { type JsonObject } from '../../shared/json.ts';
import {
  type ApiAutomationDetail,
  type ApiAutomationRunDetail,
  type ApiAutomationRunSummary,
  type ApiAutomationRunsList,
  type ApiAutomationsList,
} from '../../shared/api-types.ts';
import {
  authorizedAutomation,
  requireCapability,
  readAutomationPayload,
  serializeAutomation,
  validateAutomation,
  type ApiEnv,
} from '../api-support.ts';
import type { ResolvedApiRouteDependencies } from './types.ts';

export function registerAutomationRoutes(
  app: Hono<ApiEnv>,
  dependencies: Pick<ResolvedApiRouteDependencies, 'orgAdmin'>,
) {
  const { orgAdmin } = dependencies;
  // --- Automations: recurring per-repo prompt runs ---

  app.get('/automations', async (c) => {
    const { installationIds } = c.get('user');
    const [automations, groups] = await Promise.all([
      listAutomationsForInstallations(installationIds),
      listInstallationsWithRepos(installationIds),
    ]);
    return c.json<ApiAutomationsList>({
      automations: automations.map((a) =>
        serializeAutomation(
          a,
          { id: a.repository_id, owner: a.owner, name: a.name_repo },
          a.last_run,
        ),
      ),
      repos: groups
        .flatMap((g) => g.repos)
        .filter((r) => r.enabled)
        .map((r) => ({
          id: r.id,
          owner: r.owner,
          name: r.name,
          installation_id: r.installation_id,
        })),
    });
  });

  app.post('/automations', async (c) => {
    const { installationIds } = c.get('user');
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const values = readAutomationPayload(body);
    const error = validateAutomation(values);
    if (error) return c.json({ error }, 400);
    const runnerCatalog = await getRunnerModelCatalog();
    if (values.runner_model && !runnerCatalog.options.some((o) => o.id === values.runner_model)) {
      return c.json({ error: 'unknown model' }, 400);
    }
    const repositoryId = Number(body.repository_id);
    const repo = Number.isInteger(repositoryId) ? await getRepoById(repositoryId) : null;
    if (!repo || !installationIds.includes(repo.installation_id) || !repo.enabled) {
      return c.json({ error: 'unknown or disabled repository' }, 404);
    }
    const automationUnsupported = factoryUnsupportedReason(repo);
    if (automationUnsupported) return c.json({ error: automationUnsupported }, 409);
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    const nextRunAt = computeNextRunAt(
      {
        // SAFETY: validateAutomation returned null above, so schedule_kind passed
        // the SCHEDULE_KINDS ('hourly' | 'daily' | 'weekly') membership check.
        kind: values.schedule_kind as 'hourly' | 'daily' | 'weekly',
        timeOfDay: values.time_of_day,
        dayOfWeek: values.day_of_week,
      },
      new Date(),
    );
    const id = await createAutomation(repo.id, values, nextRunAt);
    return c.json({ ok: true, automation_id: id });
  });

  app.get('/automations/:id', async (c) => {
    const automation = await authorizedAutomation(c);
    if (!automation) return c.json({ error: 'unknown automation' }, 404);
    const repo = await getRepoById(automation.repository_id);
    if (!repo) return c.json({ error: 'unknown automation' }, 404);
    const runs = await listAutomationRuns(automation.id);
    const lastRun = runs[0]
      ? { id: runs[0].id, status: runs[0].status, created_at: runs[0].created_at }
      : null;
    return c.json<ApiAutomationDetail>({
      automation: { ...serializeAutomation(automation, repo, lastRun), prompt: automation.prompt },
    });
  });

  app.put('/automations/:id', async (c) => {
    const automation = await authorizedAutomation(c);
    if (!automation) return c.json({ error: 'unknown automation' }, 404);
    const repoForCapability = await getRepoById(automation.repository_id);
    const deniedCapability =
      repoForCapability &&
      (await requireCapability(c, repoForCapability.installation_id, 'settings', orgAdmin));
    if (deniedCapability) return deniedCapability;
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const values = readAutomationPayload(body);
    const error = validateAutomation(values);
    if (error) return c.json({ error }, 400);
    // Only a *changed* model must be in the catalog: a stored model that has
    // since dropped out may ride along, so unrelated edits still save.
    if (values.runner_model && values.runner_model !== automation.runner_model) {
      const catalog = await getRunnerModelCatalog();
      if (!catalog.options.some((o) => o.id === values.runner_model)) {
        return c.json({ error: 'unknown model' }, 400);
      }
    }
    const enabled = body.enabled === undefined ? automation.enabled : Boolean(body.enabled);
    // Recompute next_run_at only when the schedule actually changed, so an
    // untouched schedule keeps its already-computed firing time.
    const scheduleChanged =
      values.schedule_kind !== automation.schedule_kind ||
      values.time_of_day !== automation.time_of_day ||
      values.day_of_week !== automation.day_of_week;
    const nextRunAt = scheduleChanged
      ? computeNextRunAt(
          {
            // SAFETY: validateAutomation returned null above, so schedule_kind passed
            // the SCHEDULE_KINDS ('hourly' | 'daily' | 'weekly') membership check.
            kind: values.schedule_kind as 'hourly' | 'daily' | 'weekly',
            timeOfDay: values.time_of_day,
            dayOfWeek: values.day_of_week,
          },
          new Date(),
        )
      : automation.next_run_at;
    await updateAutomation(automation.id, { ...values, enabled }, nextRunAt);
    return c.json({ ok: true });
  });

  app.delete('/automations/:id', async (c) => {
    const automation = await authorizedAutomation(c);
    if (!automation) return c.json({ error: 'unknown automation' }, 404);
    const repoForCapability = await getRepoById(automation.repository_id);
    const deniedCapability =
      repoForCapability &&
      (await requireCapability(c, repoForCapability.installation_id, 'settings', orgAdmin));
    if (deniedCapability) return deniedCapability;
    await deleteAutomation(automation.id);
    return c.json({ ok: true });
  });

  // Manual trigger: enqueues a run directly, bypassing next_run_at — lets a
  // user confirm the prompt/schedule works without waiting for the next
  // scheduled firing.
  app.post('/automations/:id/run', async (c) => {
    const automation = await authorizedAutomation(c);
    if (!automation) return c.json({ error: 'unknown automation' }, 404);
    await enqueueFactoryMessage({ kind: 'automation', automationId: automation.id });
    return c.json({ ok: true });
  });

  app.get('/automations/:id/runs', async (c) => {
    const automation = await authorizedAutomation(c);
    if (!automation) return c.json({ error: 'unknown automation' }, 404);
    const runs = await listAutomationRuns(automation.id);
    return c.json<ApiAutomationRunsList>({
      automation: { id: automation.id, name: automation.name },
      runs: runs.map((r) => ({
        id: r.id,
        // SAFETY: automation_runs.status only ever holds running | pr_opened |
        // no_changes | checks_failed | failed (finishAutomationRun).
        status: r.status as ApiAutomationRunSummary['status'],
        pr_number: r.pr_number,
        error: r.error,
        created_at: r.created_at,
      })),
    });
  });

  // Reachable standalone (not nested under /automations/:id) — same shape as
  // the factory's GET /factory/runs/:id/log being independent of its parent.
  app.get('/automations/runs/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const detail = Number.isInteger(id) ? await getAutomationRunDetail(id) : null;
    if (!detail || !c.get('user').installationIds.includes(detail.automation.installation_id)) {
      return c.json({ error: 'unknown run' }, 404);
    }
    const runs = await listAgentRunsForAutomationRun(detail.run.id);
    return c.json<ApiAutomationRunDetail>({
      run: {
        id: detail.run.id,
        // SAFETY: automation_runs.status only ever holds running | pr_opened |
        // no_changes | checks_failed | failed (finishAutomationRun).
        status: detail.run.status as ApiAutomationRunSummary['status'],
        pr_number: detail.run.pr_number,
        error: detail.run.error,
        created_at: detail.run.created_at,
      },
      automation: {
        id: detail.automation.id,
        name: detail.automation.name,
        repo: `${detail.automation.owner}/${detail.automation.repo}`,
      },
      runs: runs.map((r) => ({
        id: r.id,
        kind: r.kind,
        success: r.success,
        created_at: r.created_at,
      })),
    });
  });
}
