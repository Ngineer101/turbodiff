import { env } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import {
  agentUsageForMonth,
  automationUsageForMonth,
  connectionSnapshot,
  countReviews,
  createAgent,
  createAutomation,
  createCockpitComment,
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
  getAutomationById,
  getAutomationRunDetail,
  getConnection,
  getFeature,
  getPlan,
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
  listSkills,
  listTodos,
  listVerificationsForFeatures,
  monthlyUsage,
  oauthStatus,
  pipelineCostForMonth,
  repoUsageForMonth,
  resolveAgentEnabled,
  resolveConnectionAuth,
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
  setTodoRepositories,
  todoRepositoriesForTodos,
  updateAgent,
  updateAutomation,
  updateConnectionAuth,
  updateFeature,
  updatePlan,
  updateSkill,
  upsertPushSubscription,
  type AgentRow,
  type AgentRunRow,
  type AutomationFields,
  type AutomationRow,
  type CockpitCommentRow,
  type ConnectionRow,
  type FeatureUsageRow,
  type FixAttemptRow,
  type PlanRow,
  type PlanWithRepo,
  type RepositoryRow,
  type ReviewActivityRow,
  type SkillRow,
  type TaskRepoStatusRow,
  type VerificationRow,
} from '../lib/db.ts';
import { computeNextRunAt } from '../lib/automation-schedule.ts';
import { requireUser, userCanPushToRepo, type AuthedUser } from '../lib/auth.ts';
import { certificateUrl } from '../lib/certificate.ts';
import { syncInstallationRepos } from '../lib/repo-sync.ts';
import { approvePlan } from '../lib/planner.ts';
import {
  encryptionConfigured,
  openJson,
  sealJson,
  sealToken,
  signArtifactKey,
} from '../lib/crypto.ts';
import { gh } from '../tools/github.ts';
import { installationToken } from '../lib/github-app.ts';
import { testMcpEndpoint } from '../lib/mcp-test.ts';
import { checkMergeability } from '../lib/merge-conflicts.ts';
import { type ConflictResolveQueueMessage } from '../lib/conflict-resolver.ts';
import {
  discoverOAuthEndpoints,
  exchangeAuthorizationCode,
  generatePkce,
  packState,
  registerOAuthClient,
  unpackState,
} from '../lib/mcp-oauth.ts';
import { DEFAULT_MODEL, RESERVED_AGENT_SLUGS } from '../lib/personas.ts';
import {
  isBoolean,
  isJsonArray,
  isNumber,
  isString,
  type JsonObject,
  type JsonValue,
} from '../shared/json.ts';
import type {
  ApiAgentDetail,
  ApiAgentRun,
  ApiAgentsList,
  ApiAutomationDetail,
  ApiAutomationRunDetail,
  ApiAutomationRunSummary,
  ApiAutomationRunsList,
  ApiAutomationsList,
  ApiAutomationSummary,
  ApiBoard,
  ApiCockpitComment,
  ApiConnectionTest,
  ApiFeatureDetail,
  ApiFeatureUsage,
  ApiFeatureUsageSession,
  ApiIntegrations,
  ApiMe,
  ApiPlan,
  ApiPlanQuestion,
  ApiReview,
  ApiReviewsPage,
  ApiSettings,
  ApiSkillDetail,
  ApiSkillsList,
  ApiTaskDetail,
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
// (agent error before post_review) rather than still running. Matches the
// sweep threshold in db.ts's tryRecordReview — keep both in sync if changed.
const STALL_AFTER_MS = 20 * 60 * 1000;

function reviewState(r: ReviewActivityRow): ApiReview['state'] {
  if (r.status === 'failed') return 'failed';
  if (r.status !== 'running') return 'completed';
  return Date.now() - parseUtc(r.created_at) > STALL_AFTER_MS ? 'stalled' : 'running';
}

// Shared by every usage-cost row shape (reviews, fix attempts, verifications,
// features' own generation row) — they all carry the same 4 token columns.
function totalTokens(row: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}): number {
  return row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens;
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
    total_tokens: totalTokens(r),
    cost_usd: r.cost_usd,
    duration_s:
      r.completed_at === null ? null : (parseUtc(r.completed_at) - parseUtc(r.created_at)) / 1000,
    created_at: r.created_at,
  };
}

// A generation attempt actually ran only when its usage columns hold real
// data — a still-queued (or never-metered) feature keeps its all-zero
// defaults, and the accordion shows no "generate" session for it rather than
// a misleading all-dashes row.
function hasUsage(row: { cost_usd: number; model: string | null }): boolean {
  return row.cost_usd > 0 || row.model !== null;
}

// Every session belonging to one shipped feature, chronological. Reuses
// totalTokens/reviewState for the review sessions; fix/verify/generate rows
// sum their own 4 token columns the same way.
async function serializeFeatureUsage(
  f: FeatureUsageRow,
  reviews: ReviewActivityRow[],
  fixes: FixAttemptRow[],
  verifications: VerificationRow[],
): Promise<ApiFeatureUsage> {
  const repo = `${f.repo_owner}/${f.repo_name}`;
  const prUrl = f.pr_number !== null ? `https://github.com/${repo}/pull/${f.pr_number}` : null;

  const sessions: ApiFeatureUsageSession[] = [];
  if (hasUsage(f)) {
    sessions.push({
      kind: 'generate',
      label: 'generate',
      status: f.status,
      cost_usd: f.cost_usd,
      total_tokens: totalTokens(f),
      duration_s: null,
      created_at: f.created_at,
      url: prUrl,
    });
  }
  for (const r of reviews) {
    sessions.push({
      kind: 'review',
      label: r.agent_slug ?? 'review',
      status: reviewState(r),
      cost_usd: r.cost_usd,
      total_tokens: totalTokens(r),
      duration_s:
        r.completed_at === null ? null : (parseUtc(r.completed_at) - parseUtc(r.created_at)) / 1000,
      created_at: r.created_at,
      url: r.review_url,
    });
  }
  for (const fx of fixes) {
    sessions.push({
      kind: 'fix',
      label: fx.trigger,
      status: fx.status,
      cost_usd: fx.cost_usd,
      total_tokens: totalTokens(fx),
      duration_s: null, // fix_attempts has no completion timestamp
      created_at: fx.created_at,
      url: prUrl,
    });
  }
  for (const v of verifications) {
    // The shareable "Proof of Build" certificate only exists once
    // verification has actually passed (mirrors postReport's cert gate).
    const url = v.status === 'passed' ? await certificateUrl(f.id) : null;
    sessions.push({
      kind: 'verify',
      label: 'verify',
      status: v.status,
      cost_usd: v.cost_usd,
      total_tokens: totalTokens(v),
      duration_s: null, // verifications has no completion timestamp
      created_at: v.created_at,
      url,
    });
  }
  sessions.sort((a, b) => parseUtc(a.created_at) - parseUtc(b.created_at));

  return {
    id: f.id,
    title: f.title,
    repo,
    status: f.status,
    pr_number: f.pr_number,
    pr_url: prUrl,
    created_at: f.created_at,
    total_cost_usd: sessions.reduce((sum, s) => sum + s.cost_usd, 0),
    total_tokens: sessions.reduce((sum, s) => sum + s.total_tokens, 0),
    sessions,
  };
}

// Groups reviews/fix attempts (over-fetched by repo id + PR number
// separately, D1 having no clean tuple-IN) down to the exact pair.
function groupByRepoPr<T extends { repository_id: number; pr_number: number }>(
  rows: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.repository_id}:${row.pr_number}`;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function verificationSummary(
  status: string | null,
  resultsJson: string | null,
): ApiVerificationSummary | null {
  if (!status) return null;
  let total = 0;
  let failed = 0;
  try {
    // SAFETY: verifications.results is written only by the verify pipeline as a
    // serialized {index, verdict, note}[]; anything unparsable lands in catch.
    const results = JSON.parse(resultsJson ?? '[]') as { verdict: string }[];
    total = results.length;
    failed = results.filter((r) => r.verdict === 'fail').length;
  } catch {
    // results unparsable — report the bare status
  }
  return { status, total, failed };
}

function serializeAgentRun(r: AgentRunRow): ApiAgentRun {
  return { id: r.id, kind: r.kind, success: r.success === 1, created_at: r.created_at };
}

type CockpitFixStatus = NonNullable<ApiCockpitComment['fix_status']>;
const COCKPIT_FIX_STATUSES = new Set<string>([
  'running',
  'fixed',
  'no_changes',
  'tests_failed',
  'failed',
] satisfies CockpitFixStatus[]);

function isCockpitFixStatus<T extends string>(value: T): value is T & CockpitFixStatus {
  return COCKPIT_FIX_STATUSES.has(value);
}

function serializeCockpitComment(r: CockpitCommentRow): ApiCockpitComment {
  const fixStatus = r.fix_status && isCockpitFixStatus(r.fix_status) ? r.fix_status : null;
  return {
    id: r.id,
    path: r.path,
    line: r.line,
    side: r.side,
    body: r.body,
    author: r.author,
    status: r.status,
    created_at: r.created_at,
    fix_status: fixStatus,
  };
}

function serializeTask(p: PlanWithRepo, repoStatuses: TaskRepoStatusRow[]): ApiPlan {
  // SAFETY: plans.questions is written only by the planner (planner.ts) as a
  // serialized question array matching ApiPlanQuestion.
  const questions = p.questions ? (JSON.parse(p.questions) as ApiPlanQuestion[]) : [];
  // SAFETY: plans.acceptance is written only by the planner as a serialized string[].
  const acceptance = p.acceptance ? (JSON.parse(p.acceptance) as string[]) : [];
  // SAFETY: plans.attachments is written only by POST /todos/:id/start as a
  // serialized {key, name, content_type}[] — name is the only field read back.
  const attachments = p.attachments ? (JSON.parse(p.attachments) as { name: string }[]) : [];
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    error: p.error,
    created_at: p.created_at,
    questions,
    acceptance,
    plan: p.plan,
    archived: p.archived === 1,
    attachments: attachments.map((a) => ({ name: a.name })),
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

function readAgentPayload(body: JsonObject): AgentFormValues {
  const get = (k: string) => {
    const v = body[k];
    return isString(v) ? v.trim() : '';
  };
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

interface SkillFormValues {
  name: string;
  slug: string;
  description: string;
  instructions: string;
}

function readSkillPayload(body: JsonObject): SkillFormValues {
  const get = (k: string) => {
    const v = body[k];
    return isString(v) ? v.trim() : '';
  };
  return {
    name: get('name'),
    slug: get('slug').toLowerCase(),
    description: get('description'),
    instructions: get('instructions'),
  };
}

function validateSkill(v: SkillFormValues, checkSlug: boolean): string | null {
  if (!v.name) return 'name is required';
  if (checkSlug && !SLUG_RE.test(v.slug))
    return 'slug must be 2-31 chars: lowercase letters, digits, dashes';
  if (!v.instructions) return 'instructions are required';
  return null;
}

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SCHEDULE_KINDS = new Set(['hourly', 'daily', 'weekly']);

function readAutomationPayload(body: JsonObject): AutomationFields {
  const get = (k: string) => {
    const v = body[k];
    return isString(v) ? v.trim() : '';
  };
  const timeOfDay = get('time_of_day');
  const dayOfWeek = body.day_of_week;
  return {
    name: get('name'),
    prompt: get('prompt'),
    schedule_kind: get('schedule_kind'),
    time_of_day: timeOfDay || null,
    day_of_week: isNumber(dayOfWeek) && Number.isInteger(dayOfWeek) ? dayOfWeek : null,
  };
}

function validateAutomation(v: AutomationFields): string | null {
  if (!v.name) return 'name is required';
  if (!v.prompt) return 'prompt is required';
  if (!SCHEDULE_KINDS.has(v.schedule_kind)) {
    return 'schedule_kind must be hourly, daily, or weekly';
  }
  if (v.schedule_kind === 'hourly') {
    if (v.time_of_day !== null) return 'hourly automations cannot set a time of day';
  } else if (!v.time_of_day || !TIME_OF_DAY_RE.test(v.time_of_day)) {
    return 'time_of_day is required (HH:MM, 24h UTC)';
  }
  if (v.schedule_kind === 'weekly') {
    if (v.day_of_week === null || v.day_of_week < 0 || v.day_of_week > 6) {
      return 'day_of_week is required for weekly automations (0-6)';
    }
  } else if (v.day_of_week !== null) {
    return 'day_of_week is only valid for weekly automations';
  }
  return null;
}

function serializeAutomation(
  a: AutomationRow,
  repo: { id: number; owner: string; name: string },
  lastRun: { id: number; status: string; created_at: string } | null,
): ApiAutomationSummary {
  return {
    id: a.id,
    name: a.name,
    repository: { id: repo.id, owner: repo.owner, name: repo.name },
    // SAFETY: automations.schedule_kind passes validateAutomation's SCHEDULE_KINDS
    // ('hourly' | 'daily' | 'weekly') membership check before every insert/update.
    schedule_kind: a.schedule_kind as ApiAutomationSummary['schedule_kind'],
    time_of_day: a.time_of_day,
    day_of_week: a.day_of_week,
    enabled: a.enabled === 1,
    next_run_at: a.next_run_at,
    last_run: lastRun,
  };
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

async function authorizedSkill(c: Context<ApiEnv>): Promise<SkillRow | null> {
  const id = Number(c.req.param('id'));
  const skill = Number.isInteger(id) ? await getSkillById(id) : null;
  if (!skill || !c.get('user').installationIds.includes(skill.installation_id)) return null;
  return skill;
}

async function authorizedRepo(c: Context<ApiEnv>): Promise<RepositoryRow | null> {
  const id = Number(c.req.param('id'));
  const repo = Number.isInteger(id) ? await getRepoById(id) : null;
  if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) return null;
  return repo;
}

// Ownership runs through the automation's fixed repository_id — an
// automation has no installation_id of its own.
async function authorizedAutomation(c: Context<ApiEnv>): Promise<AutomationRow | null> {
  const id = Number(c.req.param('id'));
  const automation = Number.isInteger(id) ? await getAutomationById(id) : null;
  if (!automation) return null;
  const repo = await getRepoById(automation.repository_id);
  if (!repo || !c.get('user').installationIds.includes(repo.installation_id)) return null;
  return automation;
}

// Push (write) permission on the repo, verified against GitHub with the
// caller's own token. Installation membership (the read gate on every route)
// is deliberately weaker: GitHub reports an org installation to read-only
// members too, and the write routes below act with the App installation
// token — which carries the App's permissions, not the caller's. Anything
// that writes to the repo or changes how code reaches it re-checks the
// caller's real GitHub permission first. Null when allowed; the 403 to
// return otherwise.
async function requireRepoPush(
  c: Context<ApiEnv>,
  repo: { owner: string; name: string },
  canPush: typeof userCanPushToRepo,
): Promise<Response | null> {
  if (await canPush(c.get('user'), repo.owner, repo.name)) return null;
  return c.json({ error: 'push access to the repository is required for this action' }, 403);
}

export interface ApiRouteDependencies {
  authenticate?: typeof requireUser;
  canPushToRepo?: typeof userCanPushToRepo;
}

export function createApiRoutes(dependencies: ApiRouteDependencies = {}) {
  const app = new Hono<ApiEnv>();
  const authenticate = dependencies.authenticate ?? requireUser;
  const canPushToRepo = dependencies.canPushToRepo ?? userCanPushToRepo;

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
    const user = await authenticate(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  app.get('/me', (c) => {
    return c.json<ApiMe>({
      login: c.get('user').session.login,
      github_app_slug: env.GITHUB_APP_SLUG,
      vapid_public_key: env.VAPID_PUBLIC_KEY,
    });
  });

  // Web Push subscription (src/lib/push.ts). Body shape matches
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
    const [stats, months, repoUsage, agentUsage, groups, features, automationUsage, pipelineCost] =
      await Promise.all([
        dashboardStats(installationIds),
        monthlyUsage(installationIds, 6),
        repoUsageForMonth(installationIds, month),
        agentUsageForMonth(installationIds, month),
        listInstallationsWithRepos(installationIds),
        listRecentFeaturesForUsage(installationIds),
        automationUsageForMonth(installationIds, month),
        pipelineCostForMonth(installationIds, month),
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
      months: months.map((m) => ({
        month: m.month,
        reviews: m.reviews,
        total_tokens: m.total_tokens,
        review_cost_usd: m.cost_usd,
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
        attachments?: JsonObject[];
      }>()
      .catch(() => null);
    const title = body?.title?.trim() || todo.title;
    const requirements = body?.requirements?.trim() ?? '';
    if (!requirements) {
      return c.json({ error: 'requirements are required' }, 400);
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
    );
    if (!started) return c.json({ error: 'todo could not be started' }, 409);
    if (!started.created) return c.json({ error: 'already started' }, 409);
    await env.FACTORY_QUEUE.send({ kind: 'plan_analyze', planId: started.planId });
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
    await env.FACTORY_QUEUE.send({ kind: 'plan_refine', planId: plan.id });
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
    await env.FACTORY_QUEUE.send(
      refine ? { kind: 'plan_refine', planId: plan.id } : { kind: 'plan_analyze', planId: plan.id },
    );
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

    const [plan, verification, token, cockpitComments] = await Promise.all([
      getPlanByFeatureId(feature.id),
      latestVerificationForFeature(feature.id),
      installationToken(repo.installation_id),
      listCockpitComments(feature.id),
    ]);
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
      mergeable_state: prMeta.mergeable_state,
    };
    base.reviews = prReviews.map((r) => ({
      state: r.state,
      body: r.body,
      author: r.user?.login ?? null,
    }));
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
    await env.FACTORY_QUEUE.send({
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

    // Same byte->base64 idiom as src/lib/github-app.ts's base64url() — a
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
    await env.FACTORY_QUEUE.send({ kind: 'plan_refine', planId: plan.id });
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
      if (repo.auto_resolve_conflicts === 1) {
        const msg: ConflictResolveQueueMessage = {
          kind: 'resolve_conflict',
          repoId: repo.id,
          prNumber: feature.pr_number,
        };
        await env.FACTORY_QUEUE.send(msg);
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
    const mergePath = `/repos/${repo.owner}/${repo.name}/pulls/${feature.pr_number}/merge`;
    const mergeBody = { method: 'PUT' as const, body: JSON.stringify({ merge_method: 'merge' }) };
    const userToken = c.get('user').session.ghToken;
    try {
      await gh(userToken || appToken, mergePath, mergeBody);
    } catch (err) {
      if (!userToken) {
        console.error(`turbodiff: cockpit merge failed for feature ${id}:`, err);
        return c.json({ error: 'merge failed — check the PR on GitHub' }, 502);
      }
      console.warn(`turbodiff: user-token merge failed for feature ${id}, retrying as app:`, err);
      try {
        await gh(appToken, mergePath, mergeBody);
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
    await Promise.all(installationIds.map((id) => createAgent(id, values)));
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
    await Promise.all(installationIds.map((id) => createSkill(id, values)));
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
    await deleteAutomation(automation.id);
    return c.json({ ok: true });
  });

  // Manual trigger: enqueues a run directly, bypassing next_run_at — lets a
  // user confirm the prompt/schedule works without waiting for the next
  // scheduled firing.
  app.post('/automations/:id/run', async (c) => {
    const automation = await authorizedAutomation(c);
    if (!automation) return c.json({ error: 'unknown automation' }, 404);
    await env.FACTORY_QUEUE.send({ kind: 'automation', automationId: automation.id });
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

  interface OAuthConfigCache {
    clientId?: string;
    clientSecret?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    accessToken?: string;
    refreshToken?: string;
    scope?: string;
  }

  // Browser-navigated (not fetched by the SPA), so failures redirect back to
  // the integrations page with a query param instead of a JSON error — the
  // one exception is the two caller-error cases below, which 400 before any
  // redirect makes sense.
  app.get('/integrations/:id/oauth/start', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    if (conn.kind !== 'mcp') {
      return c.json({ error: 'OAuth connect is only available for MCP-kind integrations' }, 400);
    }
    if (conn.auth_type !== 'oauth') return c.json({ error: 'not an OAuth integration' }, 400);

    const redirectUri = `${env.PUBLIC_BASE_URL}/api/integrations/${conn.id}/oauth/callback`;
    let endpoints: Awaited<ReturnType<typeof discoverOAuthEndpoints>>;
    try {
      endpoints = await discoverOAuthEndpoints(conn.url);
    } catch (err) {
      console.error(`turbodiff: oauth discovery failed for connection ${conn.id}:`, err);
      return c.redirect('/integrations?oauth=error&reason=discovery_failed');
    }

    let cache: OAuthConfigCache = conn.auth_config_ciphertext
      ? await openJson<OAuthConfigCache>(conn.auth_config_ciphertext)
      : {};
    if (!cache.clientId) {
      if (!endpoints.registrationEndpoint) {
        return c.redirect('/integrations?oauth=error&reason=no_registration_endpoint');
      }
      try {
        const registered = await registerOAuthClient(endpoints.registrationEndpoint, redirectUri);
        cache = { ...cache, clientId: registered.clientId, clientSecret: registered.clientSecret };
      } catch (err) {
        console.error(
          `turbodiff: oauth client registration failed for connection ${conn.id}:`,
          err,
        );
        return c.redirect('/integrations?oauth=error&reason=registration_failed');
      }
    }
    // Re-registering on every connect click would be wasteful, but the
    // discovered endpoints are cheap to refresh each time so /oauth/callback
    // always exchanges against the server's current metadata.
    cache = {
      ...cache,
      authorizationEndpoint: endpoints.authorizationEndpoint,
      tokenEndpoint: endpoints.tokenEndpoint,
    };
    await updateConnectionAuth(conn.id, { authConfigCiphertext: await sealJson(cache) });

    const { verifier, challenge } = await generatePkce();
    const state = await packState({ connectionId: conn.id, verifier }, env.SESSION_SECRET);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cache.clientId!,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return c.redirect(`${endpoints.authorizationEndpoint}?${params}`);
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

    const unpacked = await unpackState(state, env.SESSION_SECRET);
    if (!unpacked || unpacked.connectionId !== conn.id) {
      return c.redirect('/integrations?oauth=error&reason=invalid_state');
    }

    const cache = conn.auth_config_ciphertext
      ? await openJson<OAuthConfigCache>(conn.auth_config_ciphertext)
      : null;
    if (!cache?.clientId || !cache.tokenEndpoint) {
      return c.redirect('/integrations?oauth=error&reason=not_started');
    }

    const redirectUri = `${env.PUBLIC_BASE_URL}/api/integrations/${conn.id}/oauth/callback`;
    let tokens: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
    try {
      tokens = await exchangeAuthorizationCode(
        cache.tokenEndpoint,
        code,
        unpacked.verifier,
        redirectUri,
        cache.clientId,
        cache.clientSecret,
      );
    } catch (err) {
      console.error(`turbodiff: oauth code exchange failed for connection ${conn.id}:`, err);
      return c.redirect('/integrations?oauth=error&reason=exchange_failed');
    }

    const authUpdate: Parameters<typeof updateConnectionAuth>[1] = {
      authConfigCiphertext: await sealJson<OAuthConfigCache>({
        ...cache,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        scope: tokens.scope,
      }),
      oauthNeedsReauth: false,
    };
    if (tokens.expiresAt) authUpdate.oauthTokenExpiresAt = tokens.expiresAt;
    await updateConnectionAuth(conn.id, authUpdate);
    return c.redirect(`/integrations?oauth=connected&name=${encodeURIComponent(conn.name)}`);
  });

  // Attach/detach an MCP integration to an agent.
  app.put('/integrations/:id/repos/:repoId', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
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

  // One PATCH for every repo toggle plus the check command. These flip the
  // repo's security posture (blocking reviews, auto-fix, auto-merge) and
  // check_command is shell that later runs in the fix sandbox — so beyond
  // installation membership this demands verified push permission, the same
  // bar as the merge these toggles can automate.
  app.patch('/repos/:id', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
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
