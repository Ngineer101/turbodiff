import { env } from 'cloudflare:workers';
// HTTP JSON transport for the signed-in SPA.
import { Hono, type Context } from 'hono';
import { factoryUnsupportedReason } from '../integrations/git/provider.ts';
import {
  agentUsageForMonth,
  automationUsageForMonth,
  closeChangeRequest,
  countReviews,
  createAgent,
  createAutomation,
  createCockpitComment,
  getChangeRequest,
  getRepoByFullName,
  listCrChecks,
  listCrComments,
  createConnection,
  createPlanForTodo,
  createSkill,
  createTodo,
  dashboardStats,
  deleteAgent,
  deleteAutomation,
  deleteConnection,
  deletePushSubscriptionByEndpoint,
  deleteSkill,
  deleteTodo,
  dispatchOpenCockpitComments,
  ensureBuiltinAgents,
  failStrandedGeneration,
  failStrandedVerifications,
  getAgentById,
  getAgentBySlug,
  getAgentRunForAuth,
  getAutomationRunDetail,
  getConnection,
  getFeature,
  getPlanWithRepoById,
  getSkillById,
  getSkillBySlug,
  getTaskRepoStatuses,
  getTodo,
  getPlanByFeatureId,
  getRepoById,
  latestVerificationForFeature,
  listAgentRunsForAutomationRun,
  listAgentRunsForFeature,
  listAgentRunsForPlan,
  listAgents,
  listAutomationRuns,
  listAutomationsForInstallations,
  listCockpitComments,
  listRepoConnectionLinks,
  listConnections,
  listFixAttemptsForRepoPrs,
  listInstallationsWithRepos,
  listPlansForInstallations,
  listRecentFeaturesForUsage,
  listRecentReviews,
  listRepoAgentOverrides,
  listRepoSkillOverrides,
  listReposForTodo,
  listReviewsForRepoPrs,
  listMembersWithGithubLogin,
  listPendingInvitations,
  listSkills,
  listTodos,
  listVerificationsForFeatures,
  monthlyUsage,
  pipelineCostByMonth,
  pipelineCostForMonth,
  repoUsageForMonth,
  resolveAgentEnabled,
  resolveSkillEnabled,
  setRepoConnectionLink,
  setPlanArchived,
  setRepoAgentEnabled,
  setRepoAutoFix,
  setRepoAutoMerge,
  setRepoAutoResolveConflicts,
  setRepoBlockingReviews,
  setRepoCheckCommand,
  setRepoDemoVideos,
  setRepoEnabled,
  setRepoReviewOnPush,
  setRepoSkillEnabled,
  setTaskRunnerModel,
  setTodoRepositories,
  todoRepositoriesForTodos,
  updateAgent,
  updateAutomation,
  updateFeature,
  updatePlan,
  updateSkill,
  upsertPushSubscription,
  type ConnectionRow,
  type VerificationRow,
} from '../data/db.ts';
import {
  completeOAuthConnect,
  connectionSnapshot,
  oauthStatus,
  resolveConnectionAuth,
  startOAuthConnect,
} from '../services/connections.ts';
import { transcriptKey } from '../ai/runtime/agent-runs.ts';
import { isRunnerModel } from '../shared/runner-models.ts';
import { computeNextRunAt } from '../domain/automation-schedule.ts';
import { requireUser, userCanPushToRepo, userIsGithubOrgAdmin } from '../services/auth.ts';
import { APIError } from 'better-auth';
import { auth } from '../integrations/auth/better-auth.ts';
import { certificateUrl } from '../services/certificates.ts';
import { memberRole } from '../services/access-control.ts';
import {
  CR_BOT_AUTHOR,
  getCrDiffPatch,
  mergeNativeChangeRequest,
  parseCrFiles,
  splitPatchByFile,
} from '../services/change-requests.ts';
import {
  createArtifactsProject,
  mintArtifactsCloneToken,
  PROJECT_SEGMENT,
} from '../services/artifacts.ts';
import { syncInstallationRepos } from '../services/repository-sync.ts';
import { approvePlan } from '../ai/runners/planner.ts';
import {
  encryptionConfigured,
  sealJson,
  sealToken,
  signArtifactKey,
} from '../integrations/security/crypto.ts';
import { githubRequest as gh } from '../integrations/github/client.ts';
import { installationToken } from '../integrations/github/app.ts';
import { testMcpEndpoint } from '../integrations/mcp/client.ts';
import { checkMergeability, dispatchConflictResolution } from '../services/merge-conflicts.ts';
import { mergePullRequest } from '../services/auto-merge.ts';
import { enqueueFactoryMessage, enqueueFactoryMessages } from '../services/factory-queue.ts';
import { DEFAULT_MODEL } from '../domain/personas.ts';
import {
  isBoolean,
  isJsonArray,
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from '../shared/json.ts';
import type {
  ApiAgentDetail,
  ApiAgentsList,
  ApiAutomationDetail,
  ApiAutomationRunDetail,
  ApiAutomationRunSummary,
  ApiAutomationRunsList,
  ApiAutomationsList,
  ApiBoard,
  ApiConnectionTest,
  ApiFeatureDetail,
  ApiIntegrations,
  ApiInvitation,
  ApiMe,
  ApiMember,
  ApiOrgMembers,
  ApiPlanQuestion,
  ApiReviewsPage,
  ApiRole,
  ApiSettings,
  ApiSkillDetail,
  ApiSkillsList,
  ApiTaskDetail,
  ApiUsage,
  ApiCreatedProject,
} from '../shared/api-types.ts';

// JSON API for the SPA (src/client). Session-cookie authed — the same
// requireUser gate as the old server-rendered pages, but failures answer
// 401 JSON instead of redirecting.

import {
  CONNECTION_NAME_RE,
  authorizedAgent,
  authorizedAutomation,
  authorizedOrg,
  authorizedPlan,
  authorizedRepo,
  authorizedSkill,
  capableInstallationIds,
  requireCapability,
  currentMonth,
  groupByRepoPr,
  readAgentPayload,
  readAutomationPayload,
  readSkillPayload,
  requireRepoPush,
  serializeAgentRun,
  serializeAutomation,
  serializeCockpitComment,
  serializeFeatureUsage,
  serializeReview,
  serializeTask,
  validateAgent,
  validateAutomation,
  validateSkill,
  validConnectionUrl,
  verificationSummary,
  type ApiEnv,
} from './api-support.ts';

export interface ApiRouteDependencies {
  authenticate?: typeof requireUser;
  canPushToRepo?: typeof userCanPushToRepo;
  orgAdmin?: typeof userIsGithubOrgAdmin;
}

export function createApiRoutes(dependencies: ApiRouteDependencies = {}) {
  const app = new Hono<ApiEnv>();
  const authenticate = dependencies.authenticate ?? requireUser;
  const canPushToRepo = dependencies.canPushToRepo ?? userCanPushToRepo;
  const orgAdmin = dependencies.orgAdmin ?? userIsGithubOrgAdmin;

  // CSRF gate for the cookie-authed data plane: browsers attach Origin to
  // every POST (same-origin and cross-site alike), so a mismatched Origin is
  // a forged cross-site request regardless of cookie SameSite behavior —
  // this must not silently regress if the cookie config ever changes.
  // Requests without an Origin header pass: a non-browser client sends the
  // cookie only if it already holds it, which is not CSRF.
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  app.use('*', async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== new URL(c.req.url).origin) {
        return c.json({ error: 'cross-origin request rejected' }, 403);
      }
    }
    await next();
  });

  app.use('*', async (c, next) => {
    const user = await authenticate(c.req.raw);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  app.get('/me', (c) => {
    const user = c.get('user');
    return c.json<ApiMe>({
      login: user.githubConnected ? user.session.login : null,
      name: user.name,
      github_connected: user.githubConnected,
      github_app_slug: env.GITHUB_APP_SLUG,
      vapid_public_key: env.VAPID_PUBLIC_KEY,
    });
  });

  // Web Push subscription (src/services/push-notifications.ts). Body shape matches
  // PushSubscription.toJSON() natively — no client-side reshaping needed.
  app.post('/push/subscribe', async (c) => {
    const body = await c.req
      .json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>()
      .catch(() => null);
    const endpoint = body?.endpoint?.trim() ?? '';
    const p256dh = body?.keys?.p256dh?.trim() ?? '';
    const auth = body?.keys?.auth?.trim() ?? '';
    if (!endpoint || !p256dh || !auth) {
      return c.json({ error: 'body must be {"endpoint", "keys": {"p256dh", "auth"}}' }, 400);
    }
    await upsertPushSubscription(c.get('user').session.userId, { endpoint, p256dh, auth });
    return c.json({ ok: true });
  });

  app.post('/push/unsubscribe', async (c) => {
    const body = await c.req.json<{ endpoint?: string }>().catch(() => null);
    const endpoint = body?.endpoint?.trim() ?? '';
    if (!endpoint) return c.json({ error: 'body must be {"endpoint"}' }, 400);
    await deletePushSubscriptionByEndpoint(c.get('user').session.userId, endpoint);
    return c.json({ ok: true });
  });

  // Usage page: headline metrics, monthly cost, per-repo/agent cost, and the
  // features-shipped accordion (the pre-board dashboard).
  app.get('/usage', async (c) => {
    const { installationIds } = c.get('user');
    const month = currentMonth();
    const [
      stats,
      reviewMonthly,
      repoUsage,
      agentUsage,
      groups,
      features,
      automationUsage,
      pipelineCost,
      pipelineMonths,
    ] = await Promise.all([
      dashboardStats(installationIds),
      monthlyUsage(installationIds, 6),
      repoUsageForMonth(installationIds, month),
      agentUsageForMonth(installationIds, month),
      listInstallationsWithRepos(installationIds),
      listRecentFeaturesForUsage(installationIds),
      automationUsageForMonth(installationIds, month),
      pipelineCostForMonth(installationIds, month),
      pipelineCostByMonth(installationIds, 6),
    ]);

    // Second fan-out needs the feature ids/repo-pr pairs from the first.
    const prPairs = features
      .filter((f) => f.pr_number !== null)
      .map((f) => ({ repositoryId: f.repository_id, prNumber: f.pr_number! }));
    const [reviews, fixes, verifications] = await Promise.all([
      listReviewsForRepoPrs(prPairs),
      listFixAttemptsForRepoPrs(prPairs),
      listVerificationsForFeatures(features.map((f) => f.id)),
    ]);
    const reviewsByPr = groupByRepoPr(reviews);
    const fixesByPr = groupByRepoPr(fixes);
    const verificationsByFeature = new Map<number, VerificationRow[]>();
    for (const v of verifications) {
      const list = verificationsByFeature.get(v.feature_id);
      if (list) list.push(v);
      else verificationsByFeature.set(v.feature_id, [v]);
    }
    const featureUsages = await Promise.all(
      features.map((f) => {
        const prKey = f.pr_number !== null ? `${f.repository_id}:${f.pr_number}` : null;
        return serializeFeatureUsage(
          f,
          prKey ? (reviewsByPr.get(prKey) ?? []) : [],
          prKey ? (fixesByPr.get(prKey) ?? []) : [],
          verificationsByFeature.get(f.id) ?? [],
        );
      }),
    );

    const usageByRepo = new Map(repoUsage.map((u) => [u.repository_id, u]));
    // The months table is driven by the pipeline rows (a superset of review
    // months, so a month with only generation/automation spend still shows);
    // the review-only counts are joined in by month.
    const reviewMonths = new Map(reviewMonthly.map((m) => [m.month, m]));
    // The 5 most recently connected repos; the rest live on /settings.
    const recentRepos = groups
      .flatMap(({ installation, repos }) => repos.map((repo) => ({ installation, repo })))
      .sort((a, b) => b.repo.created_at.localeCompare(a.repo.created_at))
      .slice(0, 5);

    return c.json<ApiUsage>({
      month,
      stats: {
        month_reviews: stats.month_reviews,
        month_review_cost_usd: stats.month_cost_usd,
        month_pipeline_cost_usd: pipelineCost,
        month_tokens: stats.month_tokens,
        avg_duration_s: stats.avg_duration_s,
        avg_findings: stats.avg_findings,
        running: stats.running,
      },
      months: pipelineMonths.map((m) => ({
        month: m.month,
        reviews: reviewMonths.get(m.month)?.reviews ?? 0,
        total_tokens: reviewMonths.get(m.month)?.total_tokens ?? 0,
        pipeline_cost_usd: m.cost_usd,
      })),
      agent_usage: agentUsage,
      repo_count: groups.reduce((n, g) => n + g.repos.length, 0),
      enabled_count: groups.reduce((n, g) => n + g.repos.filter((r) => r.enabled).length, 0),
      recent_repos: recentRepos.map(({ installation, repo }) => {
        const u = usageByRepo.get(repo.id);
        return {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          enabled: repo.enabled === 1,
          suspended: installation.suspended === 1,
          reviews: u?.reviews ?? 0,
          cost_usd: u?.cost_usd ?? 0,
        };
      }),
      features: featureUsages,
      automation_usage: automationUsage.map((a) => ({
        automation_id: a.automation_id,
        name: a.name,
        repo: `${a.repo_owner}/${a.repo_name}`,
        runs: a.runs,
        cost_usd: a.cost_usd,
      })),
    });
  });

  // Full review history, newest first, paginated.
  const PER_PAGE = 25;
  app.get('/reviews', async (c) => {
    const { installationIds } = c.get('user');
    const total = await countReviews(installationIds);
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const page = Math.min(pages, Math.max(1, Number(c.req.query('page')) || 1));
    const reviews = await listRecentReviews(installationIds, PER_PAGE, (page - 1) * PER_PAGE);
    return c.json<ApiReviewsPage>({ total, page, pages, reviews: reviews.map(serializeReview) });
  });

  // --- Kanban board: todos (backlog) + started tasks (plans) ---

  app.get('/board', async (c) => {
    const { installationIds } = c.get('user');
    // Flip wall-clock-killed runs to failed before reading, so the cards
    // never show an eternal "generating" for a dead run.
    await failStrandedGeneration();
    await failStrandedVerifications();
    // The board deliberately shows /api/usage's pipeline figure, not the
    // review-only one dashboardStats computes — same number, both surfaces.
    const [groups, plans, todos, stats, pipelineCost] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listPlansForInstallations(installationIds),
      listTodos(installationIds),
      dashboardStats(installationIds),
      pipelineCostForMonth(installationIds, currentMonth()),
    ]);
    // Batched per-task/per-todo repo reads — one query each, not per-row.
    const [repoStatuses, todoRepos] = await Promise.all([
      getTaskRepoStatuses(plans.map((p) => p.id)),
      todoRepositoriesForTodos(todos.map((t) => t.id)),
    ]);
    return c.json<ApiBoard>({
      stats: { month_pipeline_cost_usd: pipelineCost, running: stats.running },
      todos: todos.map((t) => ({
        id: t.id,
        installation_id: t.installation_id,
        title: t.title,
        notes: t.notes,
        created_at: t.created_at,
        repos: todoRepos
          .filter((r) => r.todo_id === t.id)
          .map((r) => ({ id: r.repository_id, owner: r.owner, name: r.name })),
      })),
      tasks: plans.filter((p) => p.archived !== 1).map((p) => serializeTask(p, repoStatuses)),
      installations: groups.map(({ installation }) => ({
        id: installation.id,
        account_login: installation.account_login,
      })),
      repos: groups
        .flatMap((g) => g.repos)
        .filter((r) => r.enabled === 1)
        .map((r) => ({
          id: r.id,
          owner: r.owner,
          name: r.name,
          installation_id: r.installation_id,
        })),
    });
  });

  // A backlog card targets 1-3 repos from the same installation (multi-repo
  // tasks fan out into one independent PR per repo at approval).
  const MAX_TASK_REPOS = 3;

  // Every id must belong to the installation and be enabled — enforced
  // server-side so the client-side picker can't be bypassed.
  async function validRepoIds(installationId: number, repoIds: number[]): Promise<boolean> {
    if (repoIds.length === 0 || repoIds.length > MAX_TASK_REPOS) return false;
    const repos = await Promise.all(repoIds.map((id) => getRepoById(id)));
    return repos.every((r) => r && r.installation_id === installationId && r.enabled === 1);
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

  // Start a todo: fills in requirements and fires the normal planning flow
  // against its persisted repo list; the todo links to the plan and leaves
  // the To Do column.
  app.post('/todos/:id/start', async (c) => {
    const id = Number(c.req.param('id'));
    const todo = Number.isInteger(id) ? await getTodo(id) : null;
    if (!todo || !c.get('user').installationIds.includes(todo.installation_id)) {
      return c.json({ error: 'unknown todo' }, 404);
    }
    if (todo.plan_id !== null) return c.json({ error: 'already started' }, 409);
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
    // Per-task model for the sandboxed runs; unset rides as NULL (= default),
    // so the picker's default choice doesn't pin future default changes.
    const model = body?.model?.trim() ?? '';
    if (model && !isRunnerModel(model)) {
      return c.json({ error: 'unknown model' }, 400);
    }
    const rawAtts = Array.isArray(body?.attachments) ? body.attachments : [];
    const attachments = rawAtts
      .map((a) => ({
        key: isString(a.key) ? a.key : '',
        name: isString(a.name) ? a.name.slice(-120) : 'attachment',
        content_type: isString(a.content_type) ? a.content_type : '',
      }))
      .filter((a) => a.key.startsWith('plan-uploads/'))
      .slice(0, 5);
    const { session } = c.get('user');
    const started = await createPlanForTodo(
      todo.id,
      repos.map((r) => r.id),
      title,
      requirements,
      { login: session.login, id: session.userId },
      attachments.length > 0 ? JSON.stringify(attachments) : undefined,
      model || undefined,
    );
    if (!started) return c.json({ error: 'todo could not be started' }, 409);
    if (!started.created) return c.json({ error: 'already started' }, 409);
    await enqueueFactoryMessage({ kind: 'plan_analyze', planId: started.planId });
    return c.json({ ok: true, plan_id: started.planId });
  });

  // Task detail for the board's compact cards.
  app.get('/tasks/:id', async (c) => {
    await failStrandedGeneration();
    await failStrandedVerifications();
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
    if (!isRunnerModel(model)) return c.json({ error: 'unknown model' }, 400);
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

  app.post('/factory/plans/:id/answers', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    if (plan.status !== 'awaiting_answers') {
      return c.json({ error: `plan is ${plan.status}, not awaiting answers` }, 409);
    }
    const body = await c.req.json<{ answers?: JsonValue }>().catch(() => null);
    const given = body?.answers;
    if (!isJsonArray(given)) {
      return c.json({ error: 'body must be {"answers": ["...", ...]}' }, 400);
    }
    const questions: ApiPlanQuestion[] = plan.questions ? JSON.parse(plan.questions) : [];
    const answers = questions.map((_, i) => {
      const v = given[i];
      return isString(v) ? v : v == null ? '' : JSON.stringify(v);
    });
    await updatePlan(plan.id, { status: 'refining', answers: JSON.stringify(answers) });
    await enqueueFactoryMessage({ kind: 'plan_refine', planId: plan.id });
    return c.json({ ok: true });
  });

  // Re-run planning for a failed plan (transient sandbox/platform errors are
  // the common cause). A failure before the user answered anything re-runs
  // the analyze step from scratch; once answers or plan feedback exist, the
  // refine step re-runs so that input is kept. Status flips immediately so
  // the UI resumes polling without waiting on the queue.
  app.post('/factory/plans/:id/retry', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    if (plan.status !== 'failed') {
      return c.json({ error: `plan is ${plan.status}, not retryable` }, 409);
    }
    const feedback: unknown[] = plan.feedback ? JSON.parse(plan.feedback) : [];
    const refine = plan.answers !== null || feedback.length > 0;
    await updatePlan(plan.id, { status: refine ? 'refining' : 'analyzing' });
    await enqueueFactoryMessage(
      refine ? { kind: 'plan_refine', planId: plan.id } : { kind: 'plan_analyze', planId: plan.id },
    );
    return c.json({ ok: true });
  });

  app.post('/factory/plans/:id/approve', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    const { session } = c.get('user');
    // The approver authors the generated commit (src/domain/attribution.ts).
    const featureIds = await approvePlan(plan.id, { login: session.login, id: session.userId });
    if (featureIds === null) return c.json({ error: 'plan is not ready for approval' }, 409);
    // One independent feature per repo — generation runs fully in parallel.
    await enqueueFactoryMessages(featureIds.map((featureId) => ({ kind: 'generate', featureId })));
    return c.json({ ok: true, feature_ids: featureIds });
  });

  // Full agent-session transcript for one run (plan analyze/refine, generate,
  // verify, fix). Session-authed rather than the public signed /artifacts/*
  // capability route — a full agent transcript is more sensitive than a
  // screenshot, so it's gated by installation ownership like every other
  // factory read here.
  app.get('/factory/runs/:id/log', async (c) => {
    const id = Number(c.req.param('id'));
    const run = Number.isInteger(id) ? await getAgentRunForAuth(id) : null;
    if (!run || !c.get('user').installationIds.includes(run.installationId)) {
      return c.json({ error: 'unknown run' }, 404);
    }
    const object = await env.ARTIFACTS.get(run.logKey);
    if (!object) return c.json({ error: 'log no longer available' }, 404);
    return c.json({ log: await object.text() });
  });

  // Raw stream-json transcript for one run — every turn, not just the final
  // result. Same JSONL schema as a local Claude Code session file
  // (~/.claude/projects/<project>/<session>.jsonl), so a sandbox run can be
  // diffed against a local one. Served raw (not JSON-wrapped): transcripts
  // are large and this is jq food, not UI copy. Same auth gate as the log.
  app.get('/factory/runs/:id/transcript', async (c) => {
    const id = Number(c.req.param('id'));
    const run = Number.isInteger(id) ? await getAgentRunForAuth(id) : null;
    if (!run || !c.get('user').installationIds.includes(run.installationId)) {
      return c.json({ error: 'unknown run' }, 404);
    }
    const object = await env.ARTIFACTS.get(transcriptKey(run.logKey));
    if (!object) {
      return c.json({ error: 'no transcript for this run (pre-dates transcript capture)' }, 404);
    }
    return c.body(object.body, 200, { 'content-type': 'application/x-ndjson' });
  });

  // --- Artifacts-hosted projects (docs/artifacts-provider.md) ---

  // Create a turbodiff-hosted project: Artifacts repo + synthetic tenancy +
  // an organization the creator owns. Access is keyed to the GitHub identity
  // (member rows join on githubId), so a GitHub-connected session is
  // required even though the project itself never touches GitHub.
  app.post('/projects', async (c) => {
    const user = c.get('user');
    if (!user.githubConnected || user.session.userId === 0) {
      return c.json(
        { error: 'connect a GitHub account first — turbodiff access is keyed to it' },
        409,
      );
    }
    const body = await c.req
      .json<{ owner?: string; name?: string; description?: string }>()
      .catch(() => null);
    const owner = body?.owner?.trim().toLowerCase() ?? '';
    const name = body?.name?.trim() ?? '';
    if (!PROJECT_SEGMENT.test(owner) || !PROJECT_SEGMENT.test(name)) {
      return c.json(
        { error: 'owner and name must be 1-80 letters, digits, dots, dashes, or underscores' },
        400,
      );
    }
    if (await getRepoByFullName(owner, name)) {
      return c.json({ error: `${owner}/${name} already exists` }, 409);
    }
    try {
      const project = await createArtifactsProject({
        owner,
        name,
        description: isString(body?.description) ? body.description : undefined,
        creatorGithubId: user.session.userId,
      });
      const response: ApiCreatedProject = {
        ok: true,
        repository_id: project.repo.id,
        repo: `${project.repo.owner}/${project.repo.name}`,
        default_branch: project.repo.default_branch,
        remote: project.remote,
      };
      return c.json(response);
    } catch (err) {
      console.error('turbodiff: project creation failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'project creation failed' }, 502);
    }
  });

  // Clone credential for an Artifacts-hosted repo — lets the user work with
  // plain git. Read tokens for any member; write tokens need 'settings'.
  app.post('/repos/:id/clone-token', async (c) => {
    const repoId = Number(c.req.param('id'));
    const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
    if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown repository' }, 404);
    }
    const body = await c.req.json<{ scope?: string }>().catch(() => null);
    const scope = body?.scope === 'write' ? 'write' : 'read';
    if (scope === 'write') {
      const deniedCapability = await requireCapability(
        c,
        repo.installation_id,
        'settings',
        orgAdmin,
      );
      if (deniedCapability) return deniedCapability;
    }
    try {
      return c.json(await mintArtifactsCloneToken(repo, scope, 24 * 3600));
    } catch (err) {
      console.error('turbodiff: clone-token mint failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'token mint failed' }, 502);
    }
  });

  // --- Factory PR cockpit ---

  app.get('/factory/features/:id', async (c) => {
    await failStrandedGeneration();
    await failStrandedVerifications();
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }

    const base: ApiFeatureDetail = {
      feature: {
        id: feature.id,
        title: feature.title,
        status: feature.status,
        error: feature.error,
        pr_number: feature.pr_number,
      },
      repo: `${repo.owner}/${repo.name}`,
      provider: repo.provider,
      cr_number: null,
      checks: [],
      plan: null,
      pr: null,
      files: [],
      more_files: 0,
      reviews: [],
      comments: [],
      demo: null,
      certificate_url: null,
      criteria: [],
      verification: null,
      runs: [],
    };
    // Fetched even when generation never opened a PR — a failed run is
    // exactly the case where an advanced user most wants the full log.
    base.runs = (await listAgentRunsForFeature(feature.id)).map(serializeAgentRun);
    if (!feature.pr_number) return c.json(base);
    base.certificate_url = await certificateUrl(feature.id);

    const [plan, verification, cockpitComments] = await Promise.all([
      getPlanByFeatureId(feature.id),
      latestVerificationForFeature(feature.id),
      listCockpitComments(feature.id),
    ]);
    const MAX_FILES = 50;
    if (repo.provider === 'artifacts') {
      // Native change request: same response shape as the GitHub path,
      // sourced from the CR row and the R2 diff cache.
      const cr = feature.change_request_id
        ? await getChangeRequest(feature.change_request_id)
        : null;
      if (cr) {
        base.cr_number = cr.number;
        const patchByPath = new Map(
          splitPatchByFile(await getCrDiffPatch(cr)).map((f) => [f.path, f.patch]),
        );
        const crFiles = parseCrFiles(cr);
        base.files = crFiles.slice(0, MAX_FILES).map((f) => {
          const filePatch = patchByPath.get(f.path);
          return {
            filename: f.path,
            status: f.status,
            additions: f.additions ?? 0,
            deletions: f.deletions ?? 0,
            patch: filePatch && filePatch.length < 100_000 ? filePatch : null,
          };
        });
        base.more_files = Math.max(0, crFiles.length - MAX_FILES);
        base.pr = {
          state: cr.status,
          html_url: null,
          additions: crFiles.reduce((sum, f) => sum + (f.additions ?? 0), 0),
          deletions: crFiles.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
          changed_files: crFiles.length,
          mergeable_state: cr.mergeable === 0 ? 'dirty' : cr.mergeable === 1 ? 'clean' : null,
        };
        const crComments = await listCrComments(cr.id);
        const findings = crComments.filter((comment) => comment.kind === 'finding');
        const reviewSummary = crComments.filter((comment) => comment.kind === 'summary').at(-1);
        if (cr.review_status) {
          const findingLines = findings
            .map(
              (f) =>
                `- **${f.severity ?? 'P3'}** ` +
                (f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` — ` : '') +
                f.body,
            )
            .join('\n');
          base.reviews = [
            {
              state: cr.review_status === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED',
              body: (reviewSummary?.body ?? '') + (findingLines ? `\n\n${findingLines}` : ''),
              author: CR_BOT_AUTHOR,
            },
          ];
        }
        base.checks = (await listCrChecks(cr.id)).map((check) => ({
          name: check.name,
          status: check.status,
          summary: check.summary,
        }));
      }
    } else {
      const token = await installationToken(repo.installation_id);
      const ghBase = `/repos/${repo.owner}/${repo.name}`;
      const [prMeta, prFiles, prReviews] = await Promise.all([
        gh(token, `${ghBase}/pulls/${feature.pr_number}`).then((r) =>
          r.json<{
            state: string;
            merged: boolean;
            html_url: string;
            additions: number;
            deletions: number;
            changed_files: number;
            mergeable_state: string | null;
          }>(),
        ),
        gh(token, `${ghBase}/pulls/${feature.pr_number}/files?per_page=100`).then((r) =>
          r.json<
            {
              filename: string;
              status: string;
              additions: number;
              deletions: number;
              patch?: string;
            }[]
          >(),
        ),
        gh(token, `${ghBase}/pulls/${feature.pr_number}/reviews?per_page=100`).then((r) =>
          r.json<{ state: string; body: string; user: { login: string } | null }[]>(),
        ),
      ]);

      // GitHub's per-file patch lacks git headers, so wrap it into a minimal
      // single-file patch for @pierre/diffs (rendered client-side).
      base.files = prFiles.slice(0, MAX_FILES).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch:
          f.patch && f.patch.length < 100_000
            ? `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`
            : null,
      }));
      base.more_files = Math.max(0, prFiles.length - MAX_FILES);
      base.pr = {
        state: prMeta.merged ? 'merged' : prMeta.state,
        html_url: prMeta.html_url,
        additions: prMeta.additions,
        deletions: prMeta.deletions,
        changed_files: prMeta.changed_files,
        mergeable_state: prMeta.mergeable_state,
      };
      base.reviews = prReviews.map((r) => ({
        state: r.state,
        body: r.body,
        author: r.user?.login ?? null,
      }));
    }
    base.comments = cockpitComments.map(serializeCockpitComment);
    base.plan = plan?.plan ?? null;

    // SAFETY: verifications.demo is written only by the verify pipeline as a
    // serialized {video, caption} object.
    const demo = verification?.demo
      ? (JSON.parse(verification.demo) as { video?: string; caption?: string })
      : null;
    if (demo?.video) {
      base.demo = {
        url: `/artifacts/${demo.video}?sig=${await signArtifactKey(demo.video)}`,
        caption: demo.caption ?? null,
      };
    }
    const criteria: string[] = feature.acceptance ? JSON.parse(feature.acceptance) : [];
    const results: { index: number; verdict: string; note: string; screenshot?: string }[] =
      verification?.results ? JSON.parse(verification.results) : [];
    base.criteria = await Promise.all(
      criteria.map(async (text, i) => {
        const r = results.find((x) => x.index === i);
        let screenshotUrl: string | null = null;
        if (r?.screenshot) {
          const key = `verify/${feature.id}/${r.screenshot.replace(/[^\w.-]/g, '')}`;
          screenshotUrl = `/artifacts/${key}?sig=${await signArtifactKey(key)}`;
        }
        return {
          text,
          verdict: r?.verdict ?? null,
          note: r?.note ?? null,
          screenshot_url: screenshotUrl,
        };
      }),
    );
    base.verification = verificationSummary(
      verification?.status ?? null,
      verification?.results ?? null,
    );
    return c.json(base);
  });

  // Line-anchored review comment from the cockpit diff. This only records
  // the comment (status 'open') — it does not dispatch the fix agent. The
  // fix agent is dispatched in one batch when the user hits Submit below.
  app.post('/factory/features/:id/comments', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    const payload = await c.req
      .json<{ path?: string; line?: number; side?: string; body?: string }>()
      .catch(() => null);
    const line = payload?.line;
    if (
      !payload?.path ||
      !isNumber(line) ||
      !Number.isInteger(line) ||
      !payload.body?.trim() ||
      !feature.pr_number
    ) {
      return c.json({ error: 'body must be {path, line, side?, body}' }, 400);
    }
    const { session } = c.get('user');
    const commentId = await createCockpitComment(
      feature.id,
      payload.path,
      line,
      payload.side === 'deletions' ? 'deletions' : 'additions',
      payload.body.trim(),
      session.login,
      session.userId,
    );
    return c.json({ ok: true, comment_id: commentId });
  });

  // Batch-submit every open comment on this feature as one fix run: claims
  // them atomically, links them to a single new fix_attempts row, and
  // enqueues one fix queue message covering all of them together.
  app.post('/factory/features/:id/comments/submit', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    if (!feature.pr_number) return c.json({ error: 'no pull request yet' }, 409);
    if (repo.provider === 'artifacts') {
      return c.json(
        { error: 'the fix loop for Artifacts change requests is not available yet' },
        409,
      );
    }
    if (!repo.auto_fix) {
      return c.json({ error: 'enable auto-fix for this repo before submitting comments' }, 409);
    }
    // The fix run pushes commits to the PR branch with a write-scoped token
    // and executes the repo's check command — dispatching it requires the
    // same push permission GitHub would demand to push those commits.
    const denied = await requireRepoPush(c, repo, canPushToRepo);
    if (denied) return denied;
    const claimed = await dispatchOpenCockpitComments(feature.id);
    if (claimed.length === 0) {
      return c.json({ error: 'no pending comments to submit' }, 400);
    }
    const { session } = c.get('user');
    const findings = claimed
      .map(
        (cm) =>
          `**P1** — Reviewer comment on \`${cm.path}:${cm.line}\` ` +
          `(from @${cm.author} in the Turbodiff cockpit):\n\n${cm.body}`,
      )
      .join('\n\n---\n\n');
    await enqueueFactoryMessage({
      kind: 'fix',
      repoId: repo.id,
      prNumber: feature.pr_number,
      trigger: 'cockpit_comment',
      author: { login: session.login, id: session.userId },
      findings,
      commentIds: claimed.map((cm) => cm.id),
    });
    return c.json({ ok: true, submitted: claimed.length });
  });

  // Re-enqueue generation for a failed feature. The feature row (and its
  // commit attribution) is reused as-is; status flips to 'generating'
  // immediately so the UI reflects the retry without waiting on the queue.
  app.post('/factory/features/:id/retry', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    const RETRYABLE = new Set(['failed', 'checks_failed', 'no_changes']);
    if (!RETRYABLE.has(feature.status)) {
      return c.json({ error: `feature is ${feature.status}, not retryable` }, 409);
    }
    // The workflow's first step flips status to 'generating' — pre-setting it
    // here would trip startGeneration's in-flight guard.
    await updateFeature(feature.id, { error: 'retry queued' });
    await enqueueFactoryMessage({ kind: 'generate', featureId: feature.id });
    return c.json({ ok: true });
  });

  // Context-file upload for planning (pdf/images). Stored in the ARTIFACTS
  // bucket under a harness-generated key; the planner downloads them into
  // the sandbox via the same signed /artifacts URLs verification uses.
  const UPLOAD_TYPES = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ]);
  const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

  app.post('/uploads', async (c) => {
    // Signed-in is not enough: any GitHub account authenticates even with
    // zero installations. Attachments exist to feed planning runs, so
    // require at least one installation before accepting bytes into R2.
    if (c.get('user').installationIds.length === 0) {
      return c.json({ error: 'install the GitHub App before uploading attachments' }, 403);
    }
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File))
      return c.json({ error: 'multipart "file" field is required' }, 400);
    if (!UPLOAD_TYPES.has(file.type)) {
      return c.json({ error: 'only PDF and image attachments are supported' }, 400);
    }
    if (file.size > UPLOAD_MAX_BYTES) return c.json({ error: 'attachment exceeds 10MB' }, 400);
    const safeName = file.name.replace(/[^\w.-]/g, '_').slice(-80) || 'attachment';
    const key = `plan-uploads/${crypto.randomUUID()}/${safeName}`;
    await env.ARTIFACTS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });
    return c.json({ ok: true, key, name: file.name.slice(-120), content_type: file.type });
  });

  // Speech-to-text for dictation into requirement/feedback/comment fields.
  // Transient: the recording is transcribed and discarded, never written to
  // R2 (contrast with /uploads, which persists planning attachments).
  const TRANSCRIBE_MAX_BYTES = 15 * 1024 * 1024;

  app.post('/transcribe', async (c) => {
    // Same cost-control gate as /uploads: dictation is only reachable from
    // screens that already require an installation (todo start, plan
    // feedback, feature comments), so this only blocks the zero-installation
    // edge case from spending Workers AI inference.
    if (c.get('user').installationIds.length === 0) {
      return c.json({ error: 'install the GitHub App before using dictation' }, 403);
    }
    const body = await c.req.parseBody();
    const file = body.audio;
    if (!(file instanceof File)) {
      return c.json({ error: 'multipart "audio" field is required' }, 400);
    }
    if (!file.type.startsWith('audio/')) {
      return c.json({ error: 'only audio recordings are supported' }, 400);
    }
    if (file.size > TRANSCRIBE_MAX_BYTES) {
      return c.json({ error: 'recording exceeds 15MB' }, 400);
    }
    if (file.size === 0) return c.json({ ok: true, text: '' });

    // Same byte->base64 idiom as src/integrations/github/app.ts's base64url() — a
    // fromCharCode loop instead of a spread, so it doesn't blow the call
    // stack on a multi-MB buffer.
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const audio = btoa(bin);

    try {
      const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio });
      return c.json({ ok: true, text: (result.text ?? '').trim() });
    } catch (err) {
      console.error('turbodiff: transcription failed:', err);
      return c.json({ error: 'transcription failed' }, 502);
    }
  });

  // Batched plan-review feedback: snippet-anchored comments collected in the
  // UI, submitted once, and consumed by a revise (plan_refine) run.
  app.post('/factory/plans/:id/feedback', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    if (plan.status !== 'plan_ready') {
      return c.json({ error: `plan is ${plan.status}, not ready for feedback` }, 409);
    }
    const body = await c.req
      .json<{ comments?: { snippet?: unknown; comment?: unknown }[] }>()
      .catch(() => null);
    const raw = Array.isArray(body?.comments) ? body.comments : [];
    const comments = raw
      .map((f) => ({
        snippet: isString(f.snippet) ? f.snippet.trim().slice(0, 300) : '',
        comment: isString(f.comment) ? f.comment.trim().slice(0, 1000) : '',
      }))
      .filter((f) => f.comment)
      .slice(0, 20);
    if (comments.length === 0) return c.json({ error: 'at least one comment is required' }, 400);
    await updatePlan(plan.id, { status: 'refining', feedback: JSON.stringify(comments) });
    await enqueueFactoryMessage({ kind: 'plan_refine', planId: plan.id });
    return c.json({ ok: true, comments: comments.length });
  });

  // Human-initiated merge from the cockpit. Deliberately does not reuse the
  // auto-merge gates: a signed-in user with verified push permission clicking
  // Merge IS the authority (requireRepoPush — the App-token fallback below
  // must never hand merge rights to someone GitHub wouldn't let push).
  // Merged with the clicking user's own OAuth token when possible so GitHub
  // attributes the merge to them, not turbodiff[bot]; falls back to the App
  // installation token when the user token can't merge (missing push
  // permission, SSO enforcement, or the empty dev-fake session token).
  app.post('/factory/features/:id/merge', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    if (!feature.pr_number) return c.json({ error: 'no pull request yet' }, 409);
    if (repo.provider === 'artifacts') {
      // Native merge (docs/artifacts-provider.md): org 'settings' capability
      // replaces the GitHub push-permission bar; the engine's merge fails on
      // conflicts rather than pushing a broken tree.
      if (!feature.change_request_id) return c.json({ error: 'no change request yet' }, 409);
      const deniedCapability = await requireCapability(
        c,
        repo.installation_id,
        'settings',
        orgAdmin,
      );
      if (deniedCapability) return deniedCapability;
      const cr = await getChangeRequest(feature.change_request_id);
      if (!cr) return c.json({ error: 'unknown change request' }, 409);
      if (cr.status === 'merged') return c.json({ ok: true }); // idempotent re-click
      if (cr.status !== 'open') return c.json({ error: `change request is ${cr.status}` }, 409);
      if (cr.mergeable === 0) {
        return c.json(
          { error: 'merge blocked — the change request has conflicts', conflict: true },
          409,
        );
      }
      // Sandbox git work happens on the queue, not in this request (it can
      // wait minutes behind agent execs in the same container); the cockpit's
      // poll shows the CR flip to merged.
      await enqueueFactoryMessage({
        kind: 'cr_merge',
        changeRequestId: cr.id,
        actor: c.get('user').session.login || 'cockpit',
      });
      return c.json({ ok: true, queued: true });
    }
    const denied = await requireRepoPush(c, repo, canPushToRepo);
    if (denied) return denied;
    const appToken = await installationToken(repo.installation_id);
    const mergeability = await checkMergeability(
      appToken,
      repo.owner,
      repo.name,
      feature.pr_number,
      {
        retryOnUnknown: true,
      },
    );
    if (mergeability.hasConflict) {
      if (await dispatchConflictResolution(repo, feature.pr_number)) {
        return c.json({ ok: true, conflict: true, resolving: true });
      }
      return c.json(
        {
          error: 'merge blocked — this PR has a merge conflict with the base branch',
          conflict: true,
        },
        409,
      );
    }
    const userToken = c.get('user').session.ghToken;
    try {
      await mergePullRequest(userToken || appToken, repo.owner, repo.name, feature.pr_number);
    } catch (err) {
      if (!userToken) {
        console.error(`turbodiff: cockpit merge failed for feature ${id}:`, err);
        return c.json({ error: 'merge failed — check the PR on GitHub' }, 502);
      }
      console.warn(`turbodiff: user-token merge failed for feature ${id}, retrying as app:`, err);
      try {
        await mergePullRequest(appToken, repo.owner, repo.name, feature.pr_number);
      } catch (appErr) {
        console.error(`turbodiff: cockpit merge failed for feature ${id}:`, appErr);
        return c.json({ error: 'merge failed — check the PR on GitHub' }, 502);
      }
    }
    // Reflect the merge immediately (the closed webhook confirms it too).
    await updateFeature(feature.id, { status: 'merged' });
    return c.json({ ok: true });
  });

  // Abandon a PR from the cockpit: closes it without merging and best-effort
  // deletes the source branch. Closed with the clicking user's own OAuth token
  // when possible (same attribution rationale as Merge), falling back to the
  // App installation token.
  app.post('/factory/features/:id/abandon', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    if (!feature.pr_number) return c.json({ error: 'no pull request yet' }, 409);
    if (repo.provider === 'artifacts') {
      if (!feature.change_request_id) return c.json({ error: 'no change request yet' }, 409);
      const deniedCapability = await requireCapability(
        c,
        repo.installation_id,
        'settings',
        orgAdmin,
      );
      if (deniedCapability) return deniedCapability;
      await closeChangeRequest(feature.change_request_id);
      await updateFeature(feature.id, { status: 'abandoned' });
      // The source branch stays on the remote — Artifacts branch GC is a
      // provisioning follow-up, and a closed CR's branch is inert.
      return c.json({ ok: true, branch_deleted: false });
    }
    // Same bar as Merge: closing PRs and deleting branches via the App-token
    // fallback must not exceed what GitHub lets the caller do directly.
    const denied = await requireRepoPush(c, repo, canPushToRepo);
    if (denied) return denied;
    const appToken = await installationToken(repo.installation_id);
    const userToken = c.get('user').session.ghToken;
    const closePath = `/repos/${repo.owner}/${repo.name}/pulls/${feature.pr_number}`;
    const closeBody = { method: 'PATCH' as const, body: JSON.stringify({ state: 'closed' }) };
    try {
      await gh(userToken || appToken, closePath, closeBody);
    } catch (err) {
      if (!userToken) {
        console.error(`turbodiff: cockpit abandon failed for feature ${id}:`, err);
        return c.json({ error: 'abandon failed — check the PR on GitHub' }, 502);
      }
      console.warn(`turbodiff: user-token abandon failed for feature ${id}, retrying as app:`, err);
      try {
        await gh(appToken, closePath, closeBody);
      } catch (appErr) {
        console.error(`turbodiff: cockpit abandon failed for feature ${id}:`, appErr);
        return c.json({ error: 'abandon failed — check the PR on GitHub' }, 502);
      }
    }
    // Branch delete is best-effort: already-gone, protected, or a null branch
    // on older rows must not turn a successful PR close into a reported failure.
    let branchDeleted = false;
    if (feature.branch) {
      const deletePath = `/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodeURIComponent(feature.branch)}`;
      try {
        await gh(userToken || appToken, deletePath, { method: 'DELETE' });
        branchDeleted = true;
      } catch (err) {
        if (!userToken) {
          console.warn(`turbodiff: branch delete failed for feature ${id}:`, err);
        } else {
          console.warn(
            `turbodiff: user-token branch delete failed for feature ${id}, retrying as app:`,
            err,
          );
          try {
            await gh(appToken, deletePath, { method: 'DELETE' });
            branchDeleted = true;
          } catch (appErr) {
            console.warn(`turbodiff: branch delete failed for feature ${id}:`, appErr);
          }
        }
      }
    }
    // Reflect the abandon immediately. The closed webhook also fires for this
    // PATCH, but it now skips features already marked 'abandoned' so it can't
    // clobber this with 'pr_closed' regardless of delivery order.
    await updateFeature(feature.id, { status: 'abandoned' });
    return c.json({ ok: true, branchDeleted });
  });

  // --- Agents: list, create, edit, delete + MCP connections ---

  // Agents are generic, not per-organization: every installation carries the
  // same set of rows (UNIQUE(installation_id, slug)), and writes fan out by
  // slug, so the list dedupes to one entry per slug and any repo in any
  // installation can enable any agent.
  app.get('/agents', async (c) => {
    const { installationIds } = c.get('user');
    await Promise.all(installationIds.map((id) => ensureBuiltinAgents(id)));
    const agents = await listAgents(installationIds);
    const seen = new Set<string>();
    return c.json<ApiAgentsList>({
      github_app_slug: env.GITHUB_APP_SLUG,
      agents: agents
        .filter((a) => (seen.has(a.slug) ? false : (seen.add(a.slug), true)))
        .map((a) => ({
          id: a.id,
          slug: a.slug,
          name: a.name,
          description: a.description,
          model: a.model,
          is_builtin: a.is_builtin === 1,
        })),
    });
  });

  app.post('/agents', async (c) => {
    const { installationIds } = c.get('user');
    if (installationIds.length === 0) return c.json({ error: 'no installations' }, 404);
    const capableIds = await capableInstallationIds(c, installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const values = readAgentPayload(body);
    let error = validateAgent(values, true);
    if (!error) {
      const existing = await Promise.all(
        installationIds.map((id) => getAgentBySlug(id, values.slug)),
      );
      if (existing.some(Boolean)) error = `an agent with slug "${values.slug}" already exists`;
    }
    if (error) return c.json({ error }, 400);
    await Promise.all(capableIds.map((id) => createAgent(id, values)));
    return c.json({ ok: true });
  });

  app.get('/agents/:id', async (c) => {
    const agent = await authorizedAgent(c);
    if (!agent) return c.json({ error: 'unknown agent' }, 404);
    return c.json<ApiAgentDetail>({
      agent: {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        model: agent.model,
        is_builtin: agent.is_builtin === 1,
        instructions: agent.instructions,
        installation_id: agent.installation_id,
      },
      default_model: DEFAULT_MODEL,
    });
  });

  app.put('/agents/:id', async (c) => {
    const agent = await authorizedAgent(c);
    if (!agent) return c.json({ error: 'unknown agent' }, 404);
    const deniedCapability = await requireCapability(
      c,
      agent.installation_id,
      'settings',
      orgAdmin,
    );
    if (deniedCapability) return deniedCapability;
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const values = { ...readAgentPayload(body), slug: agent.slug };
    const error = validateAgent(values, false);
    if (error) return c.json({ error }, 400);
    // Fan out by slug so the edit applies everywhere; custom agents that
    // predate the generic model gain their missing per-installation copies.
    const { installationIds } = c.get('user');
    const siblings = (await listAgents(installationIds)).filter((a) => a.slug === agent.slug);
    await Promise.all(siblings.map((s) => updateAgent(s.id, values)));
    if (agent.is_builtin === 0) {
      const covered = new Set(siblings.map((s) => s.installation_id));
      await Promise.all(
        installationIds.filter((id) => !covered.has(id)).map((id) => createAgent(id, values)),
      );
    }
    return c.json({ ok: true });
  });

  app.delete('/agents/:id', async (c) => {
    const agent = await authorizedAgent(c);
    if (!agent) return c.json({ error: 'unknown agent' }, 404);
    const deniedCapability = await requireCapability(
      c,
      agent.installation_id,
      'settings',
      orgAdmin,
    );
    if (deniedCapability) return deniedCapability;
    if (agent.is_builtin === 1) return c.json({ error: 'built-in agents cannot be deleted' }, 403);
    // Fan out by slug: deleting a generic agent removes every installation's copy.
    const siblings = (await listAgents(c.get('user').installationIds)).filter(
      (a) => a.slug === agent.slug && a.is_builtin === 0,
    );
    await Promise.all(siblings.map((s) => deleteAgent(s.id)));
    return c.json({ ok: true });
  });

  // --- Skills: list, create, edit, delete ---

  // Same generic-across-installations, fan-out-by-slug behavior as agents:
  // one flat skill list usable on any repo in any of the caller's installations.
  app.get('/skills', async (c) => {
    const { installationIds } = c.get('user');
    const skills = await listSkills(installationIds);
    const seen = new Set<string>();
    return c.json<ApiSkillsList>({
      skills: skills
        .filter((s) => (seen.has(s.slug) ? false : (seen.add(s.slug), true)))
        .map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          description: s.description,
        })),
    });
  });

  app.post('/skills', async (c) => {
    const { installationIds } = c.get('user');
    if (installationIds.length === 0) return c.json({ error: 'no installations' }, 404);
    const capableIds = await capableInstallationIds(c, installationIds, orgAdmin);
    if (capableIds.length === 0) {
      return c.json({ error: "'settings' capability required for this action" }, 403);
    }
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const values = readSkillPayload(body);
    let error = validateSkill(values, true);
    if (!error) {
      const existing = await Promise.all(
        installationIds.map((id) => getSkillBySlug(id, values.slug)),
      );
      if (existing.some(Boolean)) error = `a skill with slug "${values.slug}" already exists`;
    }
    if (error) return c.json({ error }, 400);
    await Promise.all(capableIds.map((id) => createSkill(id, values)));
    return c.json({ ok: true });
  });

  app.get('/skills/:id', async (c) => {
    const skill = await authorizedSkill(c);
    if (!skill) return c.json({ error: 'unknown skill' }, 404);
    return c.json<ApiSkillDetail>({
      skill: {
        id: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        installation_id: skill.installation_id,
      },
    });
  });

  app.put('/skills/:id', async (c) => {
    const skill = await authorizedSkill(c);
    if (!skill) return c.json({ error: 'unknown skill' }, 404);
    const deniedCapability = await requireCapability(
      c,
      skill.installation_id,
      'settings',
      orgAdmin,
    );
    if (deniedCapability) return deniedCapability;
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const values = readSkillPayload(body);
    const error = validateSkill(values, true);
    if (error) return c.json({ error }, 400);
    // The slug is immutable after creation; the fan-out below always keys off
    // the existing slug regardless of what the request body sent.
    values.slug = skill.slug;
    // Fan out by slug so the edit applies everywhere; skills that predate a
    // caller's installation gain their missing per-installation copies.
    const { installationIds } = c.get('user');
    const siblings = (await listSkills(installationIds)).filter((s) => s.slug === skill.slug);
    await Promise.all(siblings.map((s) => updateSkill(s.id, values)));
    const covered = new Set(siblings.map((s) => s.installation_id));
    await Promise.all(
      installationIds.filter((id) => !covered.has(id)).map((id) => createSkill(id, values)),
    );
    return c.json({ ok: true });
  });

  app.delete('/skills/:id', async (c) => {
    const skill = await authorizedSkill(c);
    if (!skill) return c.json({ error: 'unknown skill' }, 404);
    const deniedCapability = await requireCapability(
      c,
      skill.installation_id,
      'settings',
      orgAdmin,
    );
    if (deniedCapability) return deniedCapability;
    // Fan out by slug: deleting a generic skill removes every installation's copy.
    const siblings = (await listSkills(c.get('user').installationIds)).filter(
      (s) => s.slug === skill.slug,
    );
    await Promise.all(siblings.map((s) => deleteSkill(s.id)));
    return c.json({ ok: true });
  });

  // --- Automations: recurring per-repo prompt runs (migration 0028) ---

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
        .filter((r) => r.enabled === 1)
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
    const repositoryId = Number(body.repository_id);
    const repo = Number.isInteger(repositoryId) ? await getRepoById(repositoryId) : null;
    if (!repo || !installationIds.includes(repo.installation_id) || repo.enabled !== 1) {
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
    const enabled = body.enabled === undefined ? automation.enabled === 1 : Boolean(body.enabled);
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
        // no_changes | checks_failed | failed (migration 0028, finishAutomationRun).
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
        // no_changes | checks_failed | failed (migration 0028, finishAutomationRun).
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
        success: r.success === 1,
        created_at: r.created_at,
      })),
    });
  });

  // --- Integrations registry: installation-level MCP/API connections ---

  async function authorizedConnection(c: Context<ApiEnv>): Promise<ConnectionRow | null> {
    const id = Number(c.req.param('id'));
    const conn = Number.isInteger(id) ? await getConnection(id) : null;
    if (!conn || !c.get('user').installationIds.includes(conn.installation_id)) return null;
    return conn;
  }

  app.get('/integrations', async (c) => {
    const { installationIds } = c.get('user');
    const [groups, connections, links] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listConnections(installationIds),
      listRepoConnectionLinks(installationIds),
    ]);
    return c.json<ApiIntegrations>({
      encryption_configured: encryptionConfigured(),
      installations: groups.map(({ installation }) => ({
        id: installation.id,
        account_login: installation.account_login,
      })),
      // A connection may only attach to repos of its own installation — the
      // client filters on installation_id.
      repos: groups.flatMap(({ repos }) =>
        repos
          .filter((r) => r.enabled === 1)
          .map((r) => ({
            id: r.id,
            installation_id: r.installation_id,
            owner: r.owner,
            name: r.name,
          })),
      ),
      connections: connections.map((conn) => {
        const snap = connectionSnapshot(conn);
        return {
          id: conn.id,
          installation_id: conn.installation_id,
          name: conn.name,
          kind: conn.kind,
          url: conn.url,
          tools: snap.tools ?? null,
          has_auth: conn.auth_type !== 'none',
          auth_type: conn.auth_type,
          oauth_status: oauthStatus(conn),
          repo_links: links
            .filter((l) => l.connection_id === conn.id)
            .map((l) => ({
              repository_id: l.repository_id,
              reviews: l.reviews === 1,
              automations: l.automations === 1,
            })),
        };
      }),
    });
  });

  const AUTH_TYPES = ['none', 'bearer', 'api_key', 'client_credentials', 'oauth'];

  app.post('/integrations', async (c) => {
    const { installationIds } = c.get('user');
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const get = (k: string) => {
      const v = body[k];
      return isString(v) ? v.trim() : '';
    };
    const installationId = Number(body.installation_id ?? installationIds[0]);
    const name = get('name').toLowerCase();
    const kind = get('kind') === 'api' ? 'api' : 'mcp';
    const url = get('url');
    const token = get('token');
    const tools = get('tools')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    // Preserves the pre-auth_type behavior for clients that only ever sent
    // `token`: no explicit auth_type + a token means 'bearer'.
    const rawAuthType = get('auth_type');
    const authType = AUTH_TYPES.includes(rawAuthType) ? rawAuthType : token ? 'bearer' : 'none';
    const headerName = get('header_name');
    const headerValue = get('header_value');
    const clientId = get('client_id');
    const clientSecret = get('client_secret');
    const tokenEndpoint = get('token_endpoint');
    const scope = get('scope');

    let error: string | null = null;
    if (!installationIds.includes(installationId)) {
      error = 'unknown installation';
    } else if (!CONNECTION_NAME_RE.test(name)) {
      error = 'name must be 1-31 chars: lowercase letters, digits, dashes, underscores';
    } else if (!validConnectionUrl(url)) {
      error = 'endpoint must be an https:// URL';
    } else if (authType !== 'none' && !encryptionConfigured()) {
      error =
        'credential storage needs the TOKEN_ENCRYPTION_KEY secret (openssl rand -hex 32, then wrangler secret put TOKEN_ENCRYPTION_KEY)';
    } else if (authType === 'api_key' && (!headerName || !headerValue)) {
      error = 'api_key auth needs both a header name and a header value';
    } else if (
      authType === 'client_credentials' &&
      (!clientId || !clientSecret || !tokenEndpoint)
    ) {
      error = 'client_credentials auth needs a client id, client secret, and token endpoint';
    } else if (authType === 'client_credentials' && !validConnectionUrl(tokenEndpoint)) {
      error = 'token endpoint must be an https:// URL';
    } else if (authType === 'oauth' && kind !== 'mcp') {
      // The OAuth *connect* action is MCP-only in the UI, but a bearer-auth
      // 'api' integration behind OAuth is otherwise a legitimate config —
      // only reject when auth_type is actually 'oauth' on a non-mcp kind.
      error = 'OAuth auth is only available for MCP-kind integrations';
    } else if ((await listConnections([installationId])).some((conn) => conn.name === name)) {
      error = `an integration named "${name}" already exists`;
    }
    if (error) return c.json({ error }, 400);
    const deniedCapability = await requireCapability(c, installationId, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;

    let authCiphertext: string | null = null;
    let authConfigCiphertext: string | null = null;
    if (authType === 'bearer') {
      authCiphertext = await sealToken(token);
    } else if (authType === 'api_key') {
      authConfigCiphertext = await sealJson({ headerName, headerValue });
    } else if (authType === 'client_credentials') {
      authConfigCiphertext = await sealJson({
        clientId,
        clientSecret,
        tokenEndpoint,
        scope: scope || undefined,
      });
    }
    // 'oauth' starts with no config — unusable until "Connect via OAuth"
    // completes the authorization-code flow (/oauth/start + /oauth/callback).

    await createConnection({
      installationId,
      name,
      kind,
      url,
      toolAllowlist: tools.length > 0 ? tools : null,
      authCiphertext,
      authType,
      authConfigCiphertext,
    });
    return c.json({ ok: true });
  });

  app.delete('/integrations/:id', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    const deniedCapability = await requireCapability(c, conn.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    await deleteConnection(conn.id);
    return c.json({ ok: true });
  });

  // MCP: handshake (initialize + tools/list) without mounting anything.
  // API: a GET against the base URL with the resolved auth header, reporting
  // the status.
  app.post('/integrations/:id/test', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    let auth: { headerName: string; headerValue: string } | null;
    try {
      auth = await resolveConnectionAuth(conn);
    } catch (err) {
      return c.json<ApiConnectionTest>({
        ok: false,
        detail: err instanceof Error ? err.message : 'could not resolve credentials',
        tools: [],
      });
    }
    if (conn.kind === 'api') {
      try {
        const res = await fetch(conn.url, {
          headers: auth ? { [auth.headerName]: auth.headerValue } : undefined,
        });
        return c.json<ApiConnectionTest>({
          ok: res.ok,
          detail: `HTTP ${res.status} ${res.statusText}`,
          tools: [],
        });
      } catch (err) {
        return c.json<ApiConnectionTest>({
          ok: false,
          detail: err instanceof Error ? err.message : 'request failed',
          tools: [],
        });
      }
    }
    const result = await testMcpEndpoint(conn.url, auth ?? undefined);
    return c.json<ApiConnectionTest>({
      ok: result.ok,
      detail: result.detail,
      tools: result.tools ?? [],
    });
  });

  // Browser-navigated (not fetched by the SPA), so failures redirect back to
  // the integrations page with a query param instead of a JSON error — the
  // one exception is the two caller-error cases below, which 400 before any
  // redirect makes sense. The connect flow itself (discovery, registration,
  // PKCE, token exchange) lives in services/connections.ts.
  app.get('/integrations/:id/oauth/start', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    if (conn.kind !== 'mcp') {
      return c.json({ error: 'OAuth connect is only available for MCP-kind integrations' }, 400);
    }
    if (conn.auth_type !== 'oauth') return c.json({ error: 'not an OAuth integration' }, 400);

    const started = await startOAuthConnect(conn);
    return c.redirect(
      started.ok ? started.authorizeUrl : `/integrations?oauth=error&reason=${started.reason}`,
    );
  });

  app.get('/integrations/:id/oauth/callback', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);

    const oauthError = c.req.query('error');
    if (oauthError) {
      return c.redirect(`/integrations?oauth=error&reason=${encodeURIComponent(oauthError)}`);
    }
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.redirect('/integrations?oauth=error&reason=missing_code');

    const result = await completeOAuthConnect(conn, code, state);
    if (!result.ok) return c.redirect(`/integrations?oauth=error&reason=${result.reason}`);
    return c.redirect(`/integrations?oauth=connected&name=${encodeURIComponent(conn.name)}`);
  });

  // Attach/detach an MCP integration to a repository.
  app.put('/integrations/:id/repos/:repoId', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    const deniedCapability = await requireCapability(c, conn.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    if (conn.kind !== 'mcp') return c.json({ error: 'only MCP integrations attach to repos' }, 400);
    const repoId = Number(c.req.param('repoId'));
    const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
    if (!repo || repo.installation_id !== conn.installation_id) {
      return c.json({ error: 'unknown repository' }, 404);
    }
    const body = await c.req
      .json<{ attached?: boolean; reviews?: boolean; automations?: boolean }>()
      .catch(() => null);
    const attached = body?.attached;
    if (!isBoolean(attached)) {
      return c.json({ error: 'body must be {"attached": true|false, ...}' }, 400);
    }
    const reviews = body?.reviews;
    const automations = body?.automations;
    if (
      (reviews !== undefined && !isBoolean(reviews)) ||
      (automations !== undefined && !isBoolean(automations))
    ) {
      return c.json({ error: '"reviews" and "automations" must be booleans when present' }, 400);
    }
    await setRepoConnectionLink(repo.id, conn.id, {
      attached,
      reviews: reviews ?? true,
      automations: automations ?? true,
    });
    return c.json({ ok: true });
  });

  // --- Settings: per-repo config, master switch plus per-agent toggles ---

  app.get('/settings', async (c) => {
    const { installationIds } = c.get('user');
    // Self-heal the repo mirror against GitHub — a missed
    // installation_repositories webhook otherwise leaves stale repos here
    // (and on every other page reading the repositories table) forever.
    await Promise.all(
      installationIds.map((id) =>
        syncInstallationRepos(id).catch((err) =>
          console.warn(`turbodiff: repo sync failed for installation ${id}:`, err),
        ),
      ),
    );
    await Promise.all(installationIds.map((id) => ensureBuiltinAgents(id)));
    const [groups, agents, overrides, skills, skillOverrides] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listAgents(installationIds),
      listRepoAgentOverrides(installationIds),
      listSkills(installationIds),
      listRepoSkillOverrides(installationIds),
    ]);
    const overrideMap = new Map(
      overrides.map((o) => [`${o.repository_id}:${o.agent_id}`, o.enabled]),
    );
    const skillOverrideMap = new Map(
      skillOverrides.map((o) => [`${o.repository_id}:${o.skill_id}`, o.enabled]),
    );

    return c.json<ApiSettings>({
      github_app_slug: env.GITHUB_APP_SLUG,
      installations: groups.map(({ installation, repos }) => {
        const instAgents = agents.filter((a) => a.installation_id === installation.id);
        const instSkills = skills.filter((s) => s.installation_id === installation.id);
        return {
          id: installation.id,
          account_login: installation.account_login,
          account_type: installation.account_type,
          suspended: installation.suspended === 1,
          repos: repos.map((r) => ({
            id: r.id,
            owner: r.owner,
            name: r.name,
            provider: r.provider,
            enabled: r.enabled === 1,
            review_on_push: r.review_on_push === 1,
            blocking_reviews: r.blocking_reviews === 1,
            auto_fix: r.auto_fix === 1,
            auto_merge: r.auto_merge === 1,
            auto_resolve_conflicts: r.auto_resolve_conflicts === 1,
            demo_videos: r.demo_videos === 1,
            check_command: r.check_command,
            agents: instAgents.map((a) => ({
              id: a.id,
              slug: a.slug,
              name: a.name,
              enabled: resolveAgentEnabled(a, overrideMap.get(`${r.id}:${a.id}`)),
            })),
            skills: instSkills.map((s) => ({
              id: s.id,
              slug: s.slug,
              name: s.name,
              enabled: resolveSkillEnabled(skillOverrideMap.get(`${r.id}:${s.id}`)),
            })),
          })),
        };
      }),
    });
  });

  // --- Organizations: member management for Organization-type installations ---
  // (migrations/0031_organizations.sql). Reads use plain installation
  // membership (the hybrid model's baseline), but the org row itself is now
  // provisioned lazily on first visit for installations whose webhook was
  // missed, with the first owner bootstrapped from GitHub org-admin status
  // (orgForInstallationWithHeal); writes go through requireCapability
  // then better-auth's own organization endpoints, which double-enforce
  // permission (via the caller's real session) and already implement the
  // "can't remove/demote the org's last owner" guard — see
  // src/services/access-control.ts for why the 'member'/'invitation' resources keep
  // better-auth's own action vocabulary instead of app-specific verbs.

  function orgApiErrorResponse<T>(c: Context<ApiEnv>, err: T): Response {
    if (!(err instanceof APIError)) throw err;
    const body = err.body;
    const message =
      body !== undefined && isJsonObject(body) && isString(body.message)
        ? body.message
        : err.message;
    switch (err.statusCode) {
      case 401:
        return c.json({ error: message }, 401);
      case 403:
        return c.json({ error: message }, 403);
      case 404:
        return c.json({ error: message }, 404);
      case 409:
        return c.json({ error: message }, 409);
      default:
        return c.json({ error: message }, 400);
    }
  }

  app.get('/organizations/:installationId/members', async (c) => {
    const resolved = await authorizedOrg(c, orgAdmin);
    if (!resolved) return c.json({ error: 'unknown organization' }, 404);
    const [members, invitations, myRole] = await Promise.all([
      listMembersWithGithubLogin(resolved.orgId),
      listPendingInvitations(resolved.orgId),
      memberRole(resolved.orgId, c.get('user').session.userId),
    ]);
    const asRole = (role: string): ApiRole =>
      role === 'owner' || role === 'admin' ? role : 'member';
    return c.json<ApiOrgMembers>({
      org_id: resolved.orgId,
      members: members.map(
        (m): ApiMember => ({
          id: m.id,
          login: m.login,
          email: m.email,
          role: asRole(m.role),
          joined_at: m.created_at,
        }),
      ),
      invitations: invitations.map(
        (i): ApiInvitation => ({
          id: i.id,
          email: i.email,
          role: asRole(i.role),
          status: i.status,
          expires_at: i.expires_at,
        }),
      ),
      my_role: myRole,
    });
  });

  app.post('/organizations/:installationId/invitations', async (c) => {
    const resolved = await authorizedOrg(c, orgAdmin);
    if (!resolved) return c.json({ error: 'unknown organization' }, 404);
    const denied = await requireCapability(c, resolved.installationId, 'member', orgAdmin);
    if (denied) return denied;
    const body = await c.req.json<{ email?: string; role?: string }>().catch(() => null);
    const email = body?.email?.trim();
    const role = body?.role;
    if (!email || (role !== 'owner' && role !== 'admin' && role !== 'member')) {
      return c.json(
        { error: 'body must be {"email": string, "role": "owner"|"admin"|"member"}' },
        400,
      );
    }
    try {
      const invitation = await auth().api.createInvitation({
        headers: c.req.raw.headers,
        body: { email, role, organizationId: resolved.orgId },
      });
      return c.json<ApiInvitation>({
        id: invitation.id,
        email: invitation.email,
        // SAFETY: this endpoint rejected any role outside
        // owner/admin/member above, before calling better-auth.
        role: invitation.role as ApiRole,
        status: invitation.status,
        expires_at: invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null,
      });
    } catch (err) {
      return orgApiErrorResponse(c, err);
    }
  });

  app.delete('/organizations/:installationId/members/:memberId', async (c) => {
    const resolved = await authorizedOrg(c, orgAdmin);
    if (!resolved) return c.json({ error: 'unknown organization' }, 404);
    const denied = await requireCapability(c, resolved.installationId, 'member', orgAdmin);
    if (denied) return denied;
    try {
      await auth().api.removeMember({
        headers: c.req.raw.headers,
        body: { memberIdOrEmail: c.req.param('memberId'), organizationId: resolved.orgId },
      });
      return c.json({ ok: true });
    } catch (err) {
      return orgApiErrorResponse(c, err);
    }
  });

  app.patch('/organizations/:installationId/members/:memberId', async (c) => {
    const resolved = await authorizedOrg(c, orgAdmin);
    if (!resolved) return c.json({ error: 'unknown organization' }, 404);
    const denied = await requireCapability(c, resolved.installationId, 'member', orgAdmin);
    if (denied) return denied;
    const body = await c.req.json<{ role?: string }>().catch(() => null);
    const role = body?.role;
    if (role !== 'owner' && role !== 'admin' && role !== 'member') {
      return c.json({ error: 'body must be {"role": "owner"|"admin"|"member"}' }, 400);
    }
    try {
      await auth().api.updateMemberRole({
        headers: c.req.raw.headers,
        body: { memberId: c.req.param('memberId'), role, organizationId: resolved.orgId },
      });
      return c.json({ ok: true });
    } catch (err) {
      return orgApiErrorResponse(c, err);
    }
  });

  // One PATCH for every repo toggle plus the check command. These flip the
  // repo's security posture (blocking reviews, auto-fix, auto-merge) and
  // check_command is shell that later runs in the fix sandbox — so beyond
  // installation membership this demands verified push permission, the same
  // bar as the merge these toggles can automate.
  app.patch('/repos/:id', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    const denied = await requireRepoPush(c, repo, canPushToRepo);
    if (denied) return denied;
    const body = await c.req
      .json<{
        enabled?: boolean;
        review_on_push?: boolean;
        blocking_reviews?: boolean;
        auto_fix?: boolean;
        auto_merge?: boolean;
        auto_resolve_conflicts?: boolean;
        demo_videos?: boolean;
        check_command?: string;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (isBoolean(body.enabled)) await setRepoEnabled(repo.id, body.enabled);
    if (isBoolean(body.review_on_push)) await setRepoReviewOnPush(repo.id, body.review_on_push);
    if (isBoolean(body.blocking_reviews))
      await setRepoBlockingReviews(repo.id, body.blocking_reviews);
    if (isBoolean(body.auto_fix)) await setRepoAutoFix(repo.id, body.auto_fix);
    if (isBoolean(body.auto_merge)) await setRepoAutoMerge(repo.id, body.auto_merge);
    if (isBoolean(body.auto_resolve_conflicts))
      await setRepoAutoResolveConflicts(repo.id, body.auto_resolve_conflicts);
    if (isBoolean(body.demo_videos)) await setRepoDemoVideos(repo.id, body.demo_videos);
    if (isString(body.check_command)) await setRepoCheckCommand(repo.id, body.check_command);
    return c.json({ ok: true });
  });

  app.put('/repos/:id/agents/:agentId', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    const denied = await requireRepoPush(c, repo, canPushToRepo);
    if (denied) return denied;
    const agentId = Number(c.req.param('agentId'));
    const agent = Number.isInteger(agentId) ? await getAgentById(agentId) : null;
    if (!agent || agent.installation_id !== repo.installation_id) {
      return c.json({ error: 'unknown agent' }, 404);
    }
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => null);
    const enabled = body?.enabled;
    if (!isBoolean(enabled)) {
      return c.json({ error: 'body must be {"enabled": true|false}' }, 400);
    }
    await setRepoAgentEnabled(repo.id, agent.id, enabled);
    return c.json({ ok: true });
  });

  app.put('/repos/:id/skills/:skillId', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    const denied = await requireRepoPush(c, repo, canPushToRepo);
    if (denied) return denied;
    const skillId = Number(c.req.param('skillId'));
    const skill = Number.isInteger(skillId) ? await getSkillById(skillId) : null;
    if (!skill || skill.installation_id !== repo.installation_id) {
      return c.json({ error: 'unknown skill' }, 404);
    }
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => null);
    const enabled = body?.enabled;
    if (!isBoolean(enabled)) {
      return c.json({ error: 'body must be {"enabled": true|false}' }, 400);
    }
    await setRepoSkillEnabled(repo.id, skill.id, enabled);
    return c.json({ ok: true });
  });

  return app;
}
