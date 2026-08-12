import { env } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import {
  agentUsageForMonth,
  connectionSnapshot,
  countReviews,
  createAgent,
  createCockpitComment,
  createConnection,
  createPlan,
  createTodo,
  dashboardStats,
  deleteAgent,
  deleteConnection,
  deleteRunnerCredential,
  deleteTodo,
  ensureBuiltinAgents,
  failStrandedGeneration,
  failStrandedVerifications,
  getAgentById,
  getAgentBySlug,
  getConnection,
  getFeature,
  getPlan,
  getPlanWithRepoById,
  getTaskRepoStatuses,
  getTodo,
  getPlanByFeatureId,
  getRepoById,
  latestVerificationForFeature,
  linkTodoToPlan,
  listAgentConnections,
  listAgents,
  listCockpitComments,
  listConnectionLinks,
  listConnections,
  listInstallationsWithRepos,
  listPlansForInstallations,
  listRecentReviews,
  listRepoAgentOverrides,
  listReposForTodo,
  listRunnerCredentials,
  listTodos,
  markCockpitCommentDispatched,
  monthlyUsage,
  repoUsageForMonth,
  resolveAgentEnabled,
  saveRunnerCredential,
  setAgentConnectionLink,
  setPlanArchived,
  setRepoAgentEnabled,
  setRepoAutoFix,
  setRepoAutoMerge,
  setRepoBlockingReviews,
  setRepoCheckCommand,
  setRepoDemoVideos,
  setRepoEnabled,
  setRepoReviewOnPush,
  setTodoRepositories,
  todoRepositoriesForTodos,
  updateAgent,
  updateFeature,
  updatePlan,
  type AgentRow,
  type ConnectionRow,
  type PlanRow,
  type PlanWithRepo,
  type RepositoryRow,
  type ReviewActivityRow,
  type TaskRepoStatusRow,
} from '../lib/db.ts';
import { requireUser, type AuthedUser } from '../lib/auth.ts';
import { syncInstallationRepos } from '../lib/repo-sync.ts';
import { approvePlan } from '../lib/planner.ts';
import { encryptionConfigured, openToken, sealToken, signArtifactKey } from '../lib/crypto.ts';
import { gh } from '../tools/github.ts';
import { installationToken } from '../lib/github-app.ts';
import { testMcpEndpoint } from '../lib/mcp-test.ts';
import { DEFAULT_MODEL, RESERVED_AGENT_SLUGS } from '../lib/personas.ts';
import type {
  ApiAgentDetail,
  ApiAgentsList,
  ApiBoard,
  ApiConnectionTest,
  ApiFeatureDetail,
  ApiIntegrations,
  ApiMe,
  ApiPlan,
  ApiPlanQuestion,
  ApiReview,
  ApiReviewsPage,
  ApiRunnerCredentialsList,
  ApiSettings,
  ApiUsage,
  ApiVerificationSummary,
} from '../shared/api-types.ts';

// JSON API for the SPA (src/client). Session-cookie authed — the same
// requireUser gate as the old server-rendered pages, but failures answer
// 401 JSON instead of redirecting.

// D1's datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS'.
function parseUtc(sql: string): number {
  return Date.parse(`${sql.replace(' ', 'T')}Z`);
}

// A dispatch that never completed and is older than this is presumed dead
// (agent error before post_review) rather than still running.
const STALL_AFTER_MS = 20 * 60 * 1000;

function reviewState(r: ReviewActivityRow): ApiReview['state'] {
  if (r.status === 'failed') return 'failed';
  if (r.status !== 'running') return 'completed';
  return Date.now() - parseUtc(r.created_at) > STALL_AFTER_MS ? 'stalled' : 'running';
}

function serializeReview(r: ReviewActivityRow): ApiReview {
  const repo = r.repo_owner && r.repo_name ? `${r.repo_owner}/${r.repo_name}` : null;
  return {
    id: r.id,
    repo,
    pr_number: r.pr_number,
    pr_url: repo ? `https://github.com/${repo}/pull/${r.pr_number}` : null,
    agent_slug: r.agent_slug,
    trigger_event: r.trigger_event,
    risk_tier: r.risk_tier,
    findings_count: r.findings_count,
    state: reviewState(r),
    review_url: r.review_url,
    total_tokens: r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens,
    cost_usd: r.cost_usd,
    duration_s:
      r.completed_at === null ? null : (parseUtc(r.completed_at) - parseUtc(r.created_at)) / 1000,
    created_at: r.created_at,
  };
}

function verificationSummary(
  status: string | null,
  resultsJson: string | null,
): ApiVerificationSummary | null {
  if (!status) return null;
  let total = 0;
  let failed = 0;
  try {
    const results = JSON.parse(resultsJson ?? '[]') as { verdict: string }[];
    total = results.length;
    failed = results.filter((r) => r.verdict === 'fail').length;
  } catch {
    // results unparsable — report the bare status
  }
  return { status, total, failed };
}

function serializeTask(p: PlanWithRepo, repoStatuses: TaskRepoStatusRow[]): ApiPlan {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    error: p.error,
    created_at: p.created_at,
    questions: p.questions ? (JSON.parse(p.questions) as ApiPlanQuestion[]) : [],
    acceptance: p.acceptance ? (JSON.parse(p.acceptance) as string[]) : [],
    plan: p.plan,
    archived: p.archived === 1,
    attachments: (p.attachments ? (JSON.parse(p.attachments) as { name: string }[]) : []).map(
      (a) => ({ name: a.name }),
    ),
    repos: repoStatuses
      .filter((r) => r.plan_id === p.id)
      .map((r) => ({
        repository_id: r.repository_id,
        owner: r.owner,
        name: r.name,
        feature_id: r.feature_id,
        pr_number: r.pr_number,
        feature_status: r.feature_status,
        feature_error: r.feature_error,
        verification: verificationSummary(r.verification_status, r.verification_results),
      })),
  };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
// Gateway-only model ids: cloudflare/<provider>/<model>.
const MODEL_RE = /^cloudflare\/[\w.-]+\/[\w.:-]+$/;

interface AgentFormValues {
  name: string;
  slug: string;
  description: string;
  instructions: string;
  model: string;
}

function readAgentPayload(body: Record<string, unknown>): AgentFormValues {
  const get = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  return {
    name: get('name'),
    slug: get('slug').toLowerCase(),
    description: get('description'),
    instructions: get('instructions'),
    model: get('model') || DEFAULT_MODEL,
  };
}

function validateAgent(v: AgentFormValues, checkSlug: boolean): string | null {
  if (!v.name) return 'name is required';
  if (checkSlug && !SLUG_RE.test(v.slug))
    return 'slug must be 2-31 chars: lowercase letters, digits, dashes';
  if (checkSlug && RESERVED_AGENT_SLUGS.has(v.slug)) return `"${v.slug}" is a reserved word`;
  if (!v.instructions) return 'instructions are required';
  if (!MODEL_RE.test(v.model))
    return 'model must be an AI Gateway id like cloudflare/anthropic/claude-sonnet-5';
  return null;
}

const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function validConnectionUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    // Plain http only for local development targets.
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// Bring-your-own runner subscriptions: which auth_mode values are valid for
// each runner, and which (runner, auth_mode) combinations the software-factory
// design doc flags as ToS-uncertain — those require an explicit acknowledgment
// (tos_ack) before the credential can be saved, rather than a hard block.
const RUNNER_AUTH_MODES: Record<string, string[]> = {
  claude: ['subscription', 'gateway'],
  codex: ['subscription', 'api_key'],
};
const TOS_GATED_RUNNER_MODES = new Set(['codex:subscription']);

type ApiEnv = { Variables: { user: AuthedUser } };

// Load the plan named by the :id param only if the caller may manage the repo
// it belongs to (its installation is in the user's set). Null otherwise.
async function authorizedPlan(c: Context<ApiEnv>): Promise<PlanRow | null> {
  const id = Number(c.req.param('id'));
  const plan = Number.isInteger(id) ? await getPlan(id) : null;
  if (!plan) return null;
  const repo = await getRepoById(plan.repository_id);
  if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) return null;
  return plan;
}

async function authorizedAgent(c: Context<ApiEnv>): Promise<AgentRow | null> {
  const id = Number(c.req.param('id'));
  const agent = Number.isInteger(id) ? await getAgentById(id) : null;
  if (!agent || !c.get('user').installationIds.includes(agent.installation_id)) return null;
  return agent;
}

async function authorizedRepo(c: Context<ApiEnv>): Promise<RepositoryRow | null> {
  const id = Number(c.req.param('id'));
  const repo = Number.isInteger(id) ? await getRepoById(id) : null;
  if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) return null;
  return repo;
}

export function createApiRoutes() {
  const app = new Hono<ApiEnv>();

  app.use('*', async (c, next) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  app.get('/me', (c) => {
    return c.json<ApiMe>({
      login: c.get('user').session.login,
      github_app_slug: env.GITHUB_APP_SLUG,
    });
  });

  // --- Runner credentials: bring-your-own Claude/Codex subscription, per
  // signed-in user (not per-installation — a subscription belongs to one
  // human, so any teammate spending it silently would be wrong). Factory
  // runs the user triggers use it instead of the Worker-level secrets; see
  // resolveRunnerAuth in src/lib/fixer.ts. ---

  app.get('/runner-credentials', async (c) => {
    const rows = await listRunnerCredentials(c.get('user').session.userId);
    return c.json<ApiRunnerCredentialsList>({
      encryption_configured: encryptionConfigured(),
      credentials: rows.map((r) => ({
        runner: r.runner,
        auth_mode: r.auth_mode,
        has_secret: true,
        base_url: r.base_url,
        tos_acknowledged_at: r.tos_acknowledged_at,
        updated_at: r.updated_at,
      })),
    });
  });

  app.post('/runner-credentials', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const get = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const runner = get('runner');
    const authMode = get('auth_mode');
    const secret = get('secret');
    const baseUrl = get('base_url');
    const tosAck = body.tos_ack === true;
    const gated = TOS_GATED_RUNNER_MODES.has(`${runner}:${authMode}`);

    const modes = RUNNER_AUTH_MODES[runner];
    let error: string | null = null;
    if (!modes) {
      error = 'runner must be "claude" or "codex"';
    } else if (!modes.includes(authMode)) {
      error = `auth_mode for ${runner} must be one of: ${modes.join(', ')}`;
    } else if (!secret) {
      error = 'secret is required';
    } else if (authMode === 'gateway' && !validConnectionUrl(baseUrl)) {
      error = 'base_url must be an https:// URL for gateway mode';
    } else if (baseUrl && authMode !== 'gateway' && !validConnectionUrl(baseUrl)) {
      error = 'base_url must be an https:// URL';
    } else if (!encryptionConfigured()) {
      error =
        'credential storage needs the TOKEN_ENCRYPTION_KEY secret (openssl rand -hex 32, then wrangler secret put TOKEN_ENCRYPTION_KEY)';
    } else if (gated && !tosAck) {
      error =
        `${runner} ${authMode} reuses your own account session headlessly — its provider's terms ` +
        'around that are less clear than a first-party API. Acknowledge to continue (tos_ack).';
    }
    if (error) return c.json({ error }, 400);

    await saveRunnerCredential({
      userId: c.get('user').session.userId,
      runner,
      authMode,
      secretCiphertext: await sealToken(secret),
      baseUrl: baseUrl || undefined,
      tosAcknowledged: gated,
    });
    return c.json({ ok: true });
  });

  app.delete('/runner-credentials/:runner', async (c) => {
    await deleteRunnerCredential(c.get('user').session.userId, c.req.param('runner'));
    return c.json({ ok: true });
  });

  // Usage page: headline metrics, monthly cost, per-repo/agent cost, recent
  // reviews (the pre-board dashboard).
  app.get('/usage', async (c) => {
    const { installationIds } = c.get('user');
    const month = currentMonth();
    const [stats, months, repoUsage, agentUsage, groups, recent] = await Promise.all([
      dashboardStats(installationIds),
      monthlyUsage(installationIds, 6),
      repoUsageForMonth(installationIds, month),
      agentUsageForMonth(installationIds, month),
      listInstallationsWithRepos(installationIds),
      listRecentReviews(installationIds, 5),
    ]);

    const usageByRepo = new Map(repoUsage.map((u) => [u.repository_id, u]));
    // The 5 most recently connected repos; the rest live on /settings.
    const recentRepos = groups
      .flatMap(({ installation, repos }) => repos.map((repo) => ({ installation, repo })))
      .sort((a, b) => b.repo.created_at.localeCompare(a.repo.created_at))
      .slice(0, 5);

    return c.json<ApiUsage>({
      month,
      stats,
      months: months.map((m) => ({
        month: m.month,
        reviews: m.reviews,
        total_tokens: m.total_tokens,
        cost_usd: m.cost_usd,
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
      recent_reviews: recent.map(serializeReview),
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
    const [groups, plans, todos, stats] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listPlansForInstallations(installationIds),
      listTodos(installationIds),
      dashboardStats(installationIds),
    ]);
    // Batched per-task/per-todo repo reads — one query each, not per-row.
    const [repoStatuses, todoRepos] = await Promise.all([
      getTaskRepoStatuses(plans.map((p) => p.id)),
      todoRepositoriesForTodos(todos.map((t) => t.id)),
    ]);
    return c.json<ApiBoard>({
      stats: { month_cost_usd: stats.month_cost_usd, running: stats.running },
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
        attachments?: Record<string, unknown>[];
      }>()
      .catch(() => null);
    const title = body?.title?.trim() || todo.title;
    const requirements = body?.requirements?.trim() ?? '';
    if (!requirements) {
      return c.json({ error: 'requirements are required' }, 400);
    }
    const rawAtts = Array.isArray(body?.attachments) ? body.attachments : [];
    const attachments = rawAtts
      .map((a: Record<string, unknown>) => ({
        key: typeof a.key === 'string' ? a.key : '',
        name: typeof a.name === 'string' ? a.name.slice(-120) : 'attachment',
        content_type: typeof a.content_type === 'string' ? a.content_type : '',
      }))
      .filter((a) => a.key.startsWith('plan-uploads/'))
      .slice(0, 5);
    const { session } = c.get('user');
    const planId = await createPlan(
      repos.map((r) => r.id),
      title,
      requirements,
      { login: session.login, id: session.userId },
      attachments.length > 0 ? JSON.stringify(attachments) : undefined,
    );
    await linkTodoToPlan(todo.id, planId);
    await env.FACTORY_QUEUE.send({ kind: 'plan_analyze', planId });
    return c.json({ ok: true, plan_id: planId });
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
    const repoStatuses = await getTaskRepoStatuses([plan.id]);
    return c.json<ApiPlan>(serializeTask(plan, repoStatuses));
  });

  // Started tasks are never deleted — archived hides them from the board.
  app.post('/tasks/:id/archive', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown task' }, 404);
    const body = await c.req.json<{ archived?: boolean }>().catch(() => null);
    if (typeof body?.archived !== 'boolean') {
      return c.json({ error: 'body must be {"archived": true|false}' }, 400);
    }
    await setPlanArchived(plan.id, body.archived);
    return c.json({ ok: true });
  });

  app.post('/factory/plans/:id/answers', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    if (plan.status !== 'awaiting_answers') {
      return c.json({ error: `plan is ${plan.status}, not awaiting answers` }, 409);
    }
    const body = await c.req.json<{ answers?: unknown }>().catch(() => null);
    if (!Array.isArray(body?.answers)) {
      return c.json({ error: 'body must be {"answers": ["...", ...]}' }, 400);
    }
    const given = body.answers as unknown[];
    const questions: ApiPlanQuestion[] = plan.questions ? JSON.parse(plan.questions) : [];
    const answers = questions.map((_, i) => {
      const v = given[i];
      return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
    });
    await updatePlan(plan.id, { status: 'refining', answers: JSON.stringify(answers) });
    await env.FACTORY_QUEUE.send({ kind: 'plan_refine', planId: plan.id });
    return c.json({ ok: true });
  });

  app.post('/factory/plans/:id/approve', async (c) => {
    const plan = await authorizedPlan(c);
    if (!plan) return c.json({ error: 'unknown plan' }, 404);
    const { session } = c.get('user');
    // The approver authors the generated commit (src/lib/attribution.ts).
    const featureIds = await approvePlan(plan.id, { login: session.login, id: session.userId });
    if (featureIds === null) return c.json({ error: 'plan is not ready for approval' }, 409);
    // One independent feature per repo — generation runs fully in parallel.
    await Promise.all(
      featureIds.map((featureId) => env.FACTORY_QUEUE.send({ kind: 'generate', featureId })),
    );
    return c.json({ ok: true, feature_ids: featureIds });
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
      plan: null,
      pr: null,
      files: [],
      more_files: 0,
      reviews: [],
      comments: [],
      demo: null,
      criteria: [],
      verification: null,
    };
    if (!feature.pr_number) return c.json(base);

    const [plan, verification, token, cockpitComments] = await Promise.all([
      getPlanByFeatureId(feature.id),
      latestVerificationForFeature(feature.id),
      installationToken(repo.installation_id),
      listCockpitComments(feature.id),
    ]);
    const ghBase = `/repos/${repo.owner}/${repo.name}`;
    const [prMeta, prFiles, prReviews] = await Promise.all([
      gh(token, `${ghBase}/pulls/${feature.pr_number}`).then(
        (r) =>
          r.json() as Promise<{
            state: string;
            merged: boolean;
            html_url: string;
            additions: number;
            deletions: number;
            changed_files: number;
          }>,
      ),
      gh(token, `${ghBase}/pulls/${feature.pr_number}/files?per_page=100`).then(
        (r) =>
          r.json() as Promise<
            {
              filename: string;
              status: string;
              additions: number;
              deletions: number;
              patch?: string;
            }[]
          >,
      ),
      gh(token, `${ghBase}/pulls/${feature.pr_number}/reviews?per_page=100`).then(
        (r) =>
          r.json() as Promise<{ state: string; body: string; user: { login: string } | null }[]>,
      ),
    ]);

    // GitHub's per-file patch lacks git headers, so wrap it into a minimal
    // single-file patch for @pierre/diffs (rendered client-side).
    const MAX_FILES = 50;
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
    };
    base.reviews = prReviews.map((r) => ({
      state: r.state,
      body: r.body,
      author: r.user?.login ?? null,
    }));
    base.comments = cockpitComments;
    base.plan = plan?.plan ?? null;

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

  // Line-anchored review comment from the cockpit diff. Submitting one
  // dispatches the fix agent against that exact finding — this replaces
  // GitHub review threads as the fix channel for factory PRs.
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
    if (
      !payload?.path ||
      !Number.isInteger(payload.line) ||
      !payload.body?.trim() ||
      !feature.pr_number
    ) {
      return c.json({ error: 'body must be {path, line, side?, body}' }, 400);
    }
    const { session } = c.get('user');
    const login = session.login;
    const side = payload.side === 'deletions' ? 'deletions' : 'additions';
    const commentId = await createCockpitComment(
      feature.id,
      payload.path,
      payload.line as number,
      side,
      payload.body.trim(),
      login,
      session.userId,
    );
    // The comment IS the work order: dispatch the fixer with it verbatim.
    // The consumer re-validates the auto_fix toggle and the attempt cap.
    // The commenter rides along as the fix commit's git author.
    await env.FACTORY_QUEUE.send({
      kind: 'fix',
      repoId: repo.id,
      prNumber: feature.pr_number,
      trigger: 'cockpit_comment',
      author: { login, id: session.userId },
      findings:
        `**P1** — Reviewer comment on \`${payload.path}:${payload.line}\` ` +
        `(from @${login} in the Turbodiff cockpit):\n\n${payload.body.trim()}`,
    });
    await markCockpitCommentDispatched(commentId);
    return c.json({ ok: true, comment_id: commentId, fix_dispatched: true });
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
    await env.FACTORY_QUEUE.send({ kind: 'generate', featureId: feature.id });
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
        snippet: typeof f.snippet === 'string' ? f.snippet.trim().slice(0, 300) : '',
        comment: typeof f.comment === 'string' ? f.comment.trim().slice(0, 1000) : '',
      }))
      .filter((f) => f.comment)
      .slice(0, 20);
    if (comments.length === 0) return c.json({ error: 'at least one comment is required' }, 400);
    await updatePlan(plan.id, { status: 'refining', feedback: JSON.stringify(comments) });
    await env.FACTORY_QUEUE.send({ kind: 'plan_refine', planId: plan.id });
    return c.json({ ok: true, comments: comments.length });
  });

  // Human-initiated merge from the cockpit. Deliberately does not reuse the
  // auto-merge gates: a signed-in repo admin clicking Merge IS the authority.
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
    const mergePath = `/repos/${repo.owner}/${repo.name}/pulls/${feature.pr_number}/merge`;
    const mergeBody = { method: 'PUT' as const, body: JSON.stringify({ merge_method: 'merge' }) };
    const userToken = c.get('user').session.ghToken;
    try {
      await gh(userToken || (await installationToken(repo.installation_id)), mergePath, mergeBody);
    } catch (err) {
      if (!userToken) {
        console.error(`turbodiff: cockpit merge failed for feature ${id}:`, err);
        return c.json({ error: 'merge failed — check the PR on GitHub' }, 502);
      }
      console.warn(`turbodiff: user-token merge failed for feature ${id}, retrying as app:`, err);
      try {
        await gh(await installationToken(repo.installation_id), mergePath, mergeBody);
      } catch (appErr) {
        console.error(`turbodiff: cockpit merge failed for feature ${id}:`, appErr);
        return c.json({ error: 'merge failed — check the PR on GitHub' }, 502);
      }
    }
    // Reflect the merge immediately (the closed webhook confirms it too).
    await updateFeature(feature.id, { status: 'merged' });
    return c.json({ ok: true });
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
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
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
    await Promise.all(installationIds.map((id) => createAgent(id, values)));
    return c.json({ ok: true });
  });

  app.get('/agents/:id', async (c) => {
    const agent = await authorizedAgent(c);
    if (!agent) return c.json({ error: 'unknown agent' }, 404);
    const connections = await listAgentConnections(agent.id);
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
      connections: connections.map((conn) => {
        const snap = connectionSnapshot(conn);
        return {
          id: conn.id,
          name: conn.name,
          url: conn.url,
          tools: snap.tools ?? null,
          has_auth: conn.auth_ciphertext !== null,
        };
      }),
      encryption_configured: encryptionConfigured(),
      default_model: DEFAULT_MODEL,
    });
  });

  app.put('/agents/:id', async (c) => {
    const agent = await authorizedAgent(c);
    if (!agent) return c.json({ error: 'unknown agent' }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
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
    if (agent.is_builtin === 1) return c.json({ error: 'built-in agents cannot be deleted' }, 403);
    // Fan out by slug: deleting a generic agent removes every installation's copy.
    const siblings = (await listAgents(c.get('user').installationIds)).filter(
      (a) => a.slug === agent.slug && a.is_builtin === 0,
    );
    await Promise.all(siblings.map((s) => deleteAgent(s.id)));
    return c.json({ ok: true });
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
    await Promise.all(installationIds.map((id) => ensureBuiltinAgents(id)));
    const [groups, agents, connections, links] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listAgents(installationIds),
      listConnections(installationIds),
      listConnectionLinks(installationIds),
    ]);
    return c.json<ApiIntegrations>({
      encryption_configured: encryptionConfigured(),
      installations: groups.map(({ installation }) => ({
        id: installation.id,
        account_login: installation.account_login,
      })),
      agents: agents.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        model: a.model,
        is_builtin: a.is_builtin === 1,
      })),
      connections: connections.map((conn) => {
        const snap = connectionSnapshot(conn);
        return {
          id: conn.id,
          installation_id: conn.installation_id,
          name: conn.name,
          kind: conn.kind,
          url: conn.url,
          tools: snap.tools ?? null,
          has_auth: conn.auth_ciphertext !== null,
          agent_ids: links.filter((l) => l.connection_id === conn.id).map((l) => l.agent_id),
        };
      }),
    });
  });

  app.post('/integrations', async (c) => {
    const { installationIds } = c.get('user');
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const get = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const installationId = Number(body.installation_id ?? installationIds[0]);
    const name = get('name').toLowerCase();
    const kind = get('kind') === 'api' ? 'api' : 'mcp';
    const url = get('url');
    const token = get('token');
    const tools = get('tools')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    let error: string | null = null;
    if (!installationIds.includes(installationId)) {
      error = 'unknown installation';
    } else if (!CONNECTION_NAME_RE.test(name)) {
      error = 'name must be 1-31 chars: lowercase letters, digits, dashes, underscores';
    } else if (!validConnectionUrl(url)) {
      error = 'endpoint must be an https:// URL';
    } else if (token && !encryptionConfigured()) {
      error =
        'token storage needs the TOKEN_ENCRYPTION_KEY secret (openssl rand -hex 32, then wrangler secret put TOKEN_ENCRYPTION_KEY)';
    } else if ((await listConnections([installationId])).some((conn) => conn.name === name)) {
      error = `an integration named "${name}" already exists`;
    }
    if (error) return c.json({ error }, 400);

    await createConnection({
      installationId,
      name,
      kind,
      url,
      toolAllowlist: tools.length > 0 ? tools : null,
      authCiphertext: token ? await sealToken(token) : null,
    });
    return c.json({ ok: true });
  });

  app.delete('/integrations/:id', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    await deleteConnection(conn.id);
    return c.json({ ok: true });
  });

  // MCP: handshake (initialize + tools/list) without mounting anything.
  // API: a bearer-auth GET against the base URL, reporting the status.
  app.post('/integrations/:id/test', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    const token = conn.auth_ciphertext ? await openToken(conn.auth_ciphertext) : undefined;
    if (conn.kind === 'api') {
      try {
        const res = await fetch(conn.url, {
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
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
    const result = await testMcpEndpoint(conn.url, token);
    return c.json<ApiConnectionTest>({
      ok: result.ok,
      detail: result.detail,
      tools: result.tools ?? [],
    });
  });

  // Attach/detach an MCP integration to an agent.
  app.put('/integrations/:id/agents/:agentId', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    if (conn.kind !== 'mcp')
      return c.json({ error: 'only MCP integrations attach to agents' }, 400);
    const agentId = Number(c.req.param('agentId'));
    const agent = Number.isInteger(agentId) ? await getAgentById(agentId) : null;
    if (!agent || agent.installation_id !== conn.installation_id) {
      return c.json({ error: 'unknown agent' }, 404);
    }
    const body = await c.req.json<{ attached?: boolean }>().catch(() => null);
    if (typeof body?.attached !== 'boolean') {
      return c.json({ error: 'body must be {"attached": true|false}' }, 400);
    }
    await setAgentConnectionLink(agent.id, conn.id, body.attached);
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
    const [groups, agents, overrides] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listAgents(installationIds),
      listRepoAgentOverrides(installationIds),
    ]);
    const overrideMap = new Map(
      overrides.map((o) => [`${o.repository_id}:${o.agent_id}`, o.enabled]),
    );

    return c.json<ApiSettings>({
      github_app_slug: env.GITHUB_APP_SLUG,
      installations: groups.map(({ installation, repos }) => {
        const instAgents = agents.filter((a) => a.installation_id === installation.id);
        return {
          id: installation.id,
          account_login: installation.account_login,
          suspended: installation.suspended === 1,
          repos: repos.map((r) => ({
            id: r.id,
            owner: r.owner,
            name: r.name,
            enabled: r.enabled === 1,
            review_on_push: r.review_on_push === 1,
            blocking_reviews: r.blocking_reviews === 1,
            auto_fix: r.auto_fix === 1,
            auto_merge: r.auto_merge === 1,
            demo_videos: r.demo_videos === 1,
            check_command: r.check_command,
            agents: instAgents.map((a) => ({
              id: a.id,
              slug: a.slug,
              name: a.name,
              enabled: resolveAgentEnabled(a, overrideMap.get(`${r.id}:${a.id}`)),
            })),
          })),
        };
      }),
    });
  });

  // One PATCH for every repo toggle plus the check command.
  app.patch('/repos/:id', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const body = await c.req
      .json<{
        enabled?: boolean;
        review_on_push?: boolean;
        blocking_reviews?: boolean;
        auto_fix?: boolean;
        auto_merge?: boolean;
        demo_videos?: boolean;
        check_command?: string;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (typeof body.enabled === 'boolean') await setRepoEnabled(repo.id, body.enabled);
    if (typeof body.review_on_push === 'boolean')
      await setRepoReviewOnPush(repo.id, body.review_on_push);
    if (typeof body.blocking_reviews === 'boolean')
      await setRepoBlockingReviews(repo.id, body.blocking_reviews);
    if (typeof body.auto_fix === 'boolean') await setRepoAutoFix(repo.id, body.auto_fix);
    if (typeof body.auto_merge === 'boolean') await setRepoAutoMerge(repo.id, body.auto_merge);
    if (typeof body.demo_videos === 'boolean') await setRepoDemoVideos(repo.id, body.demo_videos);
    if (typeof body.check_command === 'string')
      await setRepoCheckCommand(repo.id, body.check_command);
    return c.json({ ok: true });
  });

  app.put('/repos/:id/agents/:agentId', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const agentId = Number(c.req.param('agentId'));
    const agent = Number.isInteger(agentId) ? await getAgentById(agentId) : null;
    if (!agent || agent.installation_id !== repo.installation_id) {
      return c.json({ error: 'unknown agent' }, 404);
    }
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => null);
    if (typeof body?.enabled !== 'boolean') {
      return c.json({ error: 'body must be {"enabled": true|false}' }, 400);
    }
    await setRepoAgentEnabled(repo.id, agent.id, body.enabled);
    return c.json({ ok: true });
  });

  return app;
}
