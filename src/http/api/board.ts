import type { Hono } from 'hono';
import {
  boardTaskRepoStatuses,
  boardTodoRepositories,
  createPlanForTodo,
  createTodo,
  dashboardStats,
  deleteTodo,
  factoryVersion,
  getPlanWithRepoById,
  getTaskRepoStatuses,
  getTodo,
  getRepoById,
  listAgentRunsForPlan,
  listInstallationsWithRepos,
  listPlansForInstallations,
  listReposForTodo,
  listTodos,
  pipelineCostForMonth,
  setPlanArchived,
  setTaskRunnerModel,
  setTodoRepositories,
} from '../../data/db.ts';
import { getRunnerModelCatalog } from '../../data/models.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { isBoolean, isString, type JsonObject } from '../../shared/json.ts';
import { type ApiBoard, type ApiTaskDetail } from '../../shared/api-types.ts';
import {
  authorizedPlan,
  currentMonth,
  serializeAgentRun,
  serializeTask,
  type ApiEnv,
} from '../api-support.ts';
import { deferredExecution, immutableRepoJson } from './execution.ts';

export function registerBoardRoutes(app: Hono<ApiEnv>) {
  // --- Kanban board: todos (backlog) + started tasks (plans) ---

  app.get('/board', async (c) => {
    const { installationIds } = c.get('user');
    const version = await factoryVersion();
    const tenantKey = installationIds
      .slice()
      .sort((a, b) => a - b)
      .join(',');
    const board = await immutableRepoJson(
      deferredExecution(c),
      `board/${encodeURIComponent(tenantKey)}/${version}`,
      async (): Promise<ApiBoard> => {
        // All PostgreSQL rollups start in one wave. The repo-link queries are scoped
        // directly by installation rather than waiting for plan/todo ids.
        const [groups, plans, todos, stats, pipelineCost, repoStatuses, todoRepos] =
          await Promise.all([
            listInstallationsWithRepos(installationIds),
            listPlansForInstallations(installationIds),
            listTodos(installationIds),
            dashboardStats(installationIds),
            pipelineCostForMonth(installationIds, currentMonth()),
            boardTaskRepoStatuses(installationIds),
            boardTodoRepositories(installationIds),
          ]);
        const statusesByPlan = new Map<number, typeof repoStatuses>();
        for (const status of repoStatuses) {
          const rows = statusesByPlan.get(status.plan_id) ?? [];
          rows.push(status);
          statusesByPlan.set(status.plan_id, rows);
        }
        const reposByTodo = new Map<number, typeof todoRepos>();
        for (const repo of todoRepos) {
          const rows = reposByTodo.get(repo.todo_id) ?? [];
          rows.push(repo);
          reposByTodo.set(repo.todo_id, rows);
        }
        return {
          stats: { month_pipeline_cost_usd: pipelineCost, running: stats.running },
          todos: todos.map((todo) => ({
            id: todo.id,
            installation_id: todo.installation_id,
            title: todo.title,
            notes: todo.notes,
            created_at: todo.created_at,
            repos: (reposByTodo.get(todo.id) ?? []).map((repo) => ({
              id: repo.repository_id,
              owner: repo.owner,
              name: repo.name,
            })),
          })),
          tasks: plans
            .filter((plan) => !plan.archived)
            .map((plan) =>
              serializeTask(plan, statusesByPlan.get(plan.id) ?? [], { includePlan: false }),
            ),
          installations: groups.map(({ installation }) => ({
            id: installation.id,
            account_login: installation.account_login,
          })),
          repos: groups
            .flatMap((group) => group.repos)
            .filter((repo) => repo.enabled)
            .map((repo) => ({
              id: repo.id,
              owner: repo.owner,
              name: repo.name,
              installation_id: repo.installation_id,
            })),
        };
      },
    );
    return c.json(board);
  });

  // A backlog card targets 1-3 repos from the same installation (multi-repo
  // tasks fan out into one independent PR per repo at approval).
  const MAX_TASK_REPOS = 3;

  // Every id must belong to the installation and be enabled — enforced
  // server-side so the client-side picker can't be bypassed.
  async function validRepoIds(installationId: number, repoIds: number[]): Promise<boolean> {
    if (repoIds.length === 0 || repoIds.length > MAX_TASK_REPOS) return false;
    const repos = await Promise.all(repoIds.map((id) => getRepoById(id)));
    return repos.every((r) => r && r.installation_id === installationId && r.enabled);
  }

  app.post('/todos', async (c) => {
    const { installationIds, session } = c.get('user');
    const body = await c.req
      .json<{
        installation_id?: number;
        title?: string;
        notes?: string;
        repository_ids?: number[];
      }>()
      .catch(() => null);
    const title = body?.title?.trim() ?? '';
    if (!title) return c.json({ error: 'title is required' }, 400);
    const installationId = body?.installation_id ?? installationIds[0];
    if (!installationIds.includes(installationId)) {
      return c.json({ error: 'unknown installation' }, 404);
    }
    const repoIds = Array.isArray(body?.repository_ids) ? body.repository_ids.map(Number) : [];
    if (repoIds.length > MAX_TASK_REPOS) return c.json({ error: 'at most 3 repositories' }, 400);
    if (repoIds.length > 0 && !(await validRepoIds(installationId, repoIds))) {
      return c.json({ error: 'unknown or disabled repository' }, 400);
    }
    const id = await createTodo(installationId, title.slice(0, 200), body?.notes?.trim() || null, {
      login: session.login,
      id: session.userId,
    });
    if (repoIds.length > 0) await setTodoRepositories(id, repoIds);
    return c.json({ ok: true, todo_id: id });
  });

  // Unstarted todos are deletable; a started todo's lifecycle lives on its
  // plan (archive that instead).
  app.delete('/todos/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const todo = Number.isInteger(id) ? await getTodo(id) : null;
    if (!todo || !c.get('user').installationIds.includes(todo.installation_id)) {
      return c.json({ error: 'unknown todo' }, 404);
    }
    if (todo.plan_id !== null)
      return c.json({ error: 'started tasks cannot be deleted — archive instead' }, 409);
    await deleteTodo(todo.id);
    return c.json({ ok: true });
  });

  // The persisted, pre-start repo picker: editable any time up to "Start" —
  // once the todo is linked to a plan the list is frozen.
  app.post('/todos/:id/repos', async (c) => {
    const id = Number(c.req.param('id'));
    const todo = Number.isInteger(id) ? await getTodo(id) : null;
    if (!todo || !c.get('user').installationIds.includes(todo.installation_id)) {
      return c.json({ error: 'unknown todo' }, 404);
    }
    if (todo.plan_id !== null) return c.json({ error: 'already started' }, 409);
    const body = await c.req.json<{ repository_ids?: unknown }>().catch(() => null);
    const repoIds = Array.isArray(body?.repository_ids) ? body.repository_ids.map(Number) : [];
    if (repoIds.length === 0) return c.json({ error: 'at least one repository is required' }, 400);
    if (repoIds.length > MAX_TASK_REPOS) return c.json({ error: 'at most 3 repositories' }, 400);
    if (!(await validRepoIds(todo.installation_id, repoIds))) {
      return c.json({ error: 'unknown or disabled repository' }, 400);
    }
    await setTodoRepositories(todo.id, repoIds);
    return c.json({ ok: true });
  });

  app.post('/todos/:id/start', async (c) => {
    const id = Number(c.req.param('id'));
    const user = c.get('user');
    const todo = await getTodo(id);

    if (!todo || !user.installationIds.includes(todo.installation_id)) {
      return c.json({ error: 'unknown todo' }, 404);
    }

    if (todo.plan_id !== null)
      return c.json({ error: 'already started' }, 409);

    const repos = await listReposForTodo(todo.id);
    if (repos.length === 0) {
      return c.json({ error: 'select at least one repository first' }, 400);
    }

    const body = await c.req
      .json<{
        title?: string;
        requirements?: string;
        attachments?: JsonObject[];
        model?: string;
      }>()
      .catch(() => null);

    const title = body?.title?.trim() || todo.title;
    const requirements = body?.requirements?.trim() ?? '';
    if (!requirements) {
      return c.json({ error: 'requirements are required' }, 400);
    }
    // Resolve and snapshot the database-managed default now so this task stays
    // reproducible if an operator changes the deployment default later.
    const model = body?.model?.trim() ?? '';
    const catalog = await getRunnerModelCatalog();

    if (model && !catalog.options.some((o) => o.id === model)) {
      return c.json({ error: 'unknown model' }, 400);
    }

    const rawAtts = Array.isArray(body?.attachments) ? body.attachments : [];
    const attachments = rawAtts
      .map((a) => ({
        key: isString(a.key) ? a.key : '',
        name: isString(a.name) ? String(a.name).slice(-120) : 'attachment',
        content_type: isString(a.content_type) ? a.content_type : '',
      }))
      .filter((a) => a.key.startsWith('plan-uploads/'))
      .slice(0, 5);

    const { session } = user;
    const started = await createPlanForTodo(
      todo.id,
      repos.map((r) => r.id),
      title,
      requirements,
      { login: session.login, id: session.userId },
      attachments.length > 0 ? attachments : undefined,
      model || catalog.defaultModel,
    );

    if (!started) return c.json({ error: 'todo could not be started' }, 409);
    if (!started.created) return c.json({ error: 'already started' }, 409);

    await enqueueFactoryMessage({ kind: 'plan_analyze', planId: started.planId });

    return c.json({ ok: true, plan_id: started.planId });
  });

  // Task detail for the board's compact cards.
  app.get('/tasks/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const plan = Number.isInteger(id) ? await getPlanWithRepoById(id) : null;
    if (!plan || !c.get('user').installationIds.includes(plan.installation_id)) {
      return c.json({ error: 'unknown task' }, 404);
    }
    const [repoStatuses, runs] = await Promise.all([
      getTaskRepoStatuses([plan.id]),
      listAgentRunsForPlan(plan.id),
    ]);
    return c.json<ApiTaskDetail>({
      ...serializeTask(plan, repoStatuses),
      runs: runs.map(serializeAgentRun),
    });
  });

  // Change the task's model for future runs (retries, repair rounds, fixes).
  // Runs already in flight keep the model they launched with.
  app.post('/tasks/:id/model', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown task' }, 404);
    const body = await c.req.json<{ model?: string }>().catch(() => null);
    const model = body?.model?.trim() ?? '';
    const catalog = await getRunnerModelCatalog();
    if (!catalog.options.some((o) => o.id === model)) {
      return c.json({ error: 'unknown model' }, 400);
    }
    await setTaskRunnerModel(plan.id, model);
    return c.json({ ok: true });
  });

  // Started tasks are never deleted — archived hides them from the board.
  app.post('/tasks/:id/archive', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown task' }, 404);
    const body = await c.req.json<{ archived?: boolean }>().catch(() => null);
    const archived = body?.archived;
    if (!isBoolean(archived)) {
      return c.json({ error: 'body must be {"archived": true|false}' }, 400);
    }
    await setPlanArchived(plan.id, archived);
    return c.json({ ok: true });
  });
}
