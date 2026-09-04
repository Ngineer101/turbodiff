import { env } from 'cloudflare:workers';
// HTTP JSON transport for the signed-in SPA.
import { Hono, type Context } from 'hono';
import { factoryUnsupportedReason } from '../integrations/git/provider.ts';
import { parseUtc } from '../shared/time.ts';
import { formatUnmetCriteriaFindings, type CriterionResult } from '../domain/verification.ts';
import {
  agentUsageForMonth,
  automationUsageForMonth,
  boardTaskRepoStatuses,
  boardTodoRepositories,
  closeChangeRequest,
  countReviews,
  createAgent,
  createAutomation,
  createCockpitComment,
  createUserChatMessage,
  hasPendingChatTurn,
  listChatMessages,
  getChangeRequest,
  getChange,
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
  factoryVersion,
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
  listFactoryRunsForFeature,
  listInstallationsWithRepos,
  listPlansForInstallations,
  listRecentFeaturesForUsage,
  listRecentReviews,
  listRepoAgentOverrides,
  listRepoSkillOverrides,
  listReposForTodo,
  listReviewsForRepoPrs,
  listLifecycleEvents,
  listStageRuns,
  listMembersWithGithubLogin,
  listPendingInvitations,
  listSkills,
  listTodos,
  listVerificationsForFeatures,
  monthlyUsage,
  pipelineCostByMonth,
  pipelineCostForMonth,
  repoUsageForMonth,
  repositoryRef,
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
  setRepoReviewPushDebounceMinutes,
  setRepoReviewIntake,
  setRepoProcessProfile,
  setRepoSkillEnabled,
  setTaskRunnerModel,
  setTodoRepositories,
  updateAgent,
  updateAutomation,
  updateFeature,
  updatePlan,
  updateSkill,
  upsertPushSubscription,
  type ConnectionRow,
  type VerificationRow,
  setFeatureCriteriaConflict,
  updateFeatureAcceptance,
} from '../data/db.ts';
import {
  completeOAuthConnect,
  connectionSnapshot,
  oauthStatus,
  resolveConnectionAuth,
  startOAuthConnect,
} from '../services/connections.ts';
import { notifyInstallationsLive } from '../services/live-updates.ts';
import { transcriptKey } from '../ai/runtime/agent-runs.ts';
import { getModelCatalog } from '../data/models.ts';
import { computeNextRunAt } from '../domain/automation-schedule.ts';
import {
  githubTokenForUser,
  requireUser,
  userCanPushToRepo,
  userIsGithubOrgAdmin,
} from '../services/auth.ts';
import { APIError } from 'better-auth';
import { withAuth } from '../integrations/auth/better-auth.ts';
import { certificateUrl } from '../services/certificates.ts';
import { memberRole } from '../services/access-control.ts';
import {
  CR_BOT_AUTHOR,
  getCrDiffPatch,
  changeRequestFiles,
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
import { githubJsonCached, githubRequest as gh } from '../integrations/github/client.ts';
import { installationToken, sandboxGitToken } from '../integrations/github/app.ts';
import {
  isValidRepoPath,
  isValidRepoRef,
  listBranchesAndDefault,
  readFile,
  readTree,
  RepoBrowserError,
  saveFile,
} from '../services/repo-browser.ts';
import {
  listBranchesAndDefaultArtifacts,
  readFileArtifacts,
  readTreeArtifacts,
  saveFileArtifacts,
} from '../services/repo-browser-artifacts.ts';
import { testMcpEndpoint } from '../integrations/mcp/client.ts';
import { checkMergeability, dispatchConflictResolution } from '../services/merge-conflicts.ts';
import { mergePullRequest } from '../services/auto-merge.ts';
import { enqueueFactoryMessage, enqueueFactoryMessages } from '../services/factory-queue.ts';
import { resumeFailedStage, scheduleChangeReview } from '../services/lifecycle.ts';
import type { LifecycleDecision } from '../domain/lifecycle-contract.ts';
import {
  ADOPTABLE_PROCESS_PROFILE_KEYS,
  type AdoptableProcessProfileKey,
} from '../domain/process-profiles.ts';
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
  ApiChatList,
  ApiConnectionTest,
  ApiFeatureDetail,
  ApiFeatureDiff,
  ApiIntegrations,
  ApiInvitation,
  ApiMe,
  ApiMember,
  ApiModels,
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
  ApiFileSave,
  ApiRepoCode,
} from '../shared/api-types.ts';

interface DeferredExecution {
  waitUntil(promise: Promise<void>): void;
}

function lifecycleDecisionReason(decision: LifecycleDecision | null): string | null {
  if (!decision) return null;
  switch (decision.kind) {
    case 'wait':
    case 'handoff':
    case 'ignore':
      return decision.reason;
    default:
      return null;
  }
}

const fallbackExecution: DeferredExecution = {
  waitUntil(promise) {
    // Hono's direct-request test harness has no Worker ExecutionContext.
    // The operation has already started; consume a background rejection so
    // response semantics remain the same as production waitUntil.
    void promise.catch(() => {});
  },
};

function deferredExecution(c: Context): DeferredExecution {
  try {
    return c.executionCtx;
  } catch {
    return fallbackExecution;
  }
}

async function immutableRepoJson<T>(
  executionCtx: DeferredExecution,
  cacheKey: string | null,
  load: () => Promise<T>,
): Promise<T> {
  if (!cacheKey) return load();
  const request = new Request(`https://repo-read-cache.turbodiff.internal/${cacheKey}`);
  try {
    const cached = await caches.default.match(request);
    if (cached) return cached.json<T>();
  } catch {
    // Cache API is best-effort (and absent in some unit harnesses).
  }
  const value = await load();
  try {
    executionCtx.waitUntil(
      caches.default
        .put(
          request,
          Response.json(value, {
            headers: { 'cache-control': 'public, max-age=31536000, immutable' },
          }),
        )
        .catch(() => {}),
    );
  } catch {
    // The read result remains valid when the edge cache is unavailable.
  }
  return value;
}

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
  serializeChatMessage,
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
  // Injectable for tests (the worker-test fixture has no queue binding).
  enqueueFactory?: typeof enqueueFactoryMessage;
}

export function createApiRoutes(dependencies: ApiRouteDependencies = {}) {
  const app = new Hono<ApiEnv>();
  const authenticate = dependencies.authenticate ?? requireUser;
  const canPushToRepo = dependencies.canPushToRepo ?? userCanPushToRepo;
  const orgAdmin = dependencies.orgAdmin ?? userIsGithubOrgAdmin;
  const enqueueFactory = dependencies.enqueueFactory ?? enqueueFactoryMessage;

  // Every API response exposes its Worker time to DevTools. Slow paths emit a
  // structured event into Workers Observability with a stable 250ms budget.
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    const durationMs = performance.now() - started;
    if (c.res.status !== 101) {
      c.res.headers.append('server-timing', `worker;dur=${durationMs.toFixed(1)}`);
    }
    if (durationMs >= 250) {
      console.warn(
        JSON.stringify({
          event: 'api_latency_budget_exceeded',
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          duration_ms: Math.round(durationMs),
        }),
      );
    }
  });

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

  // Successful writes publish a tiny invalidation to this user's
  // installation hubs. The RPC is deferred so mutation latency never waits
  // for connected browsers; background jobs can call the same service.
  app.use('*', async (c, next) => {
    await next();
    if (SAFE_METHODS.has(c.req.method) || c.req.path === '/performance' || c.res.status >= 400) {
      return;
    }
    deferredExecution(c).waitUntil(
      notifyInstallationsLive(c.get('user').installationIds).catch((err) => {
        console.warn('turbodiff: live write invalidation failed', err);
      }),
    );
  });

  app.use('*', async (c, next) => {
    const user = await authenticate(c.req.raw);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', user);
    if (user.membershipRefresh) deferredExecution(c).waitUntil(user.membershipRefresh());
    if (user.repositoryRepair) deferredExecution(c).waitUntil(user.repositoryRepair());
    await next();
  });

  // Conditional GETs: hash the JSON body into a strong ETag and answer 304
  // to a matching If-None-Match. The server still builds the payload, but
  // polls and focus-refetches stop re-downloading (and re-rendering) bodies
  // that haven't changed — the client wrapper (src/client/lib/api.ts) keeps
  // the parsed payload alongside the etag.
  app.use('*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' || c.res.status !== 200) return;
    if (!c.res.headers.get('content-type')?.includes('application/json')) return;
    const body = await c.res.clone().arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-1', body);
    const etag = `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
    if (c.req.header('if-none-match') === etag) {
      c.res = new Response(null, { status: 304, headers: { etag } });
      return;
    }
    const headers = new Headers(c.res.headers);
    headers.set('etag', etag);
    c.res = new Response(body, { status: 200, headers });
  });

  app.get('/me', (c) => {
    const user = c.get('user');
    return c.json<ApiMe>({
      login: user.githubConnected ? user.session.login : null,
      name: user.name,
      github_connected: user.githubConnected,
      github_status: user.githubStatus,
      github_app_slug: env.GITHUB_APP_SLUG,
      vapid_public_key: env.VAPID_PUBLIC_KEY,
      installation_ids: user.installationIds,
    });
  });

  app.get('/live/:installationId', async (c) => {
    const installationId = Number(c.req.param('installationId'));
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) {
      return c.json({ error: 'cross-origin websocket rejected' }, 403);
    }
    if (
      !Number.isInteger(installationId) ||
      !c.get('user').installationIds.includes(installationId)
    ) {
      return c.json({ error: 'unknown installation' }, 404);
    }
    return await env.LIVE_UPDATES.getByName(String(installationId)).fetch(c.req.raw);
  });

  app.post('/performance', async (c) => {
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body || !isString(body.path) || !isJsonObject(body.metrics)) {
      return c.json({ error: 'invalid performance sample' }, 400);
    }
    const allowed = new Set(['ttfb', 'dom_interactive', 'lcp', 'inp', 'cls']);
    const metrics = Object.fromEntries(
      Object.entries(body.metrics).filter(
        ([name, value]) => allowed.has(name) && isNumber(value) && Number.isFinite(value),
      ),
    );
    console.log(
      JSON.stringify({
        event: 'client_performance',
        path: body.path.slice(0, 160),
        metrics,
      }),
    );
    return c.json({ ok: true });
  });

  // Web Push subscription (src/services/push-notifications.ts). Body shape matches
  // PushSubscription.toJSON() natively — no client-side reshaping needed.
  app.post('/push/subscribe', async (c) => {
    const user = c.get('user');
    if (!user.githubConnected || user.session.userId <= 0) {
      return c.json({ error: 'connect GitHub before enabling push notifications' }, 409);
    }
    const body = await c.req
      .json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>()
      .catch(() => null);
    const endpoint = body?.endpoint?.trim() ?? '';
    const p256dh = body?.keys?.p256dh?.trim() ?? '';
    const auth = body?.keys?.auth?.trim() ?? '';
    if (!endpoint || !p256dh || !auth) {
      return c.json({ error: 'body must be {"endpoint", "keys": {"p256dh", "auth"}}' }, 400);
    }
    await upsertPushSubscription(user.session.userId, { endpoint, p256dh, auth });
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
          enabled: repo.enabled,
          suspended: installation.suspended,
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

  // Cheap live-poll target: a single-row change counter (0042 triggers) the
  // client checks every few seconds, refetching the real payloads only when
  // it moves — instead of rebuilding board/task/feature responses per poll.
  app.get('/factory/version', async (c) => {
    return c.json({ v: await factoryVersion() });
  });

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
    if (model) {
      const catalog = await getModelCatalog();
      if (!catalog.runner.options.some((o) => o.id === model)) {
        return c.json({ error: 'unknown model' }, 400);
      }
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
    const { session } = c.get('user');
    const started = await createPlanForTodo(
      todo.id,
      repos.map((r) => r.id),
      title,
      requirements,
      { login: session.login, id: session.userId },
      attachments.length > 0 ? attachments : undefined,
      model || undefined,
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
    const catalog = await getModelCatalog();
    if (!catalog.runner.options.some((o) => o.id === model)) {
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
    const questions: ApiPlanQuestion[] = plan.questions ?? [];
    const answers = questions.map((_, i) => {
      const v = given[i];
      return isString(v) ? v : v == null ? '' : JSON.stringify(v);
    });
    await updatePlan(plan.id, { status: 'refining', answers });
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
      .json<{
        owner?: string;
        name?: string;
        description?: string;
        process_profile?: AdoptableProcessProfileKey;
      }>()
      .catch(() => null);
    const owner = body?.owner?.trim().toLowerCase() ?? '';
    const name = body?.name?.trim() ?? '';
    if (!PROJECT_SEGMENT.test(owner) || !PROJECT_SEGMENT.test(name)) {
      return c.json(
        { error: 'owner and name must be 1-80 letters, digits, dots, dashes, or underscores' },
        400,
      );
    }
    if (
      body?.process_profile !== undefined &&
      !ADOPTABLE_PROCESS_PROFILE_KEYS.includes(body.process_profile)
    ) {
      return c.json(
        { error: `process_profile must be ${ADOPTABLE_PROCESS_PROFILE_KEYS.join(', ')}` },
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
        processProfile: body?.process_profile,
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

  // --- Repo code browser ---

  // Branches + default branch for the code page header. GitHub answers off
  // the REST API; Artifacts off real git in the per-repo sandbox mirror.
  app.get('/repos/:id/code', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const repoSummary = {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      provider: repo.provider,
    };
    try {
      const { default_branch, branches } =
        repo.provider === 'github'
          ? await listBranchesAndDefault(await installationToken(repo.installation_id), repo)
          : await listBranchesAndDefaultArtifacts(repo);
      return c.json<ApiRepoCode>({
        repo: repoSummary,
        supported: true,
        default_branch,
        branches,
      });
    } catch (err) {
      console.error('turbodiff: code branch listing failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'branch listing failed' }, 502);
    }
  });

  // One directory level of the repo tree at ?ref=&path= (lazy — the client
  // fetches per expanded directory).
  app.get('/repos/:id/tree', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const ref = c.req.query('ref') ?? '';
    const path = c.req.query('path') ?? '';
    if (!isValidRepoRef(ref)) return c.json({ error: 'a valid ref query param is required' }, 400);
    if (!isValidRepoPath(path)) return c.json({ error: 'invalid path' }, 400);
    try {
      if (repo.provider === 'github') {
        const token = await installationToken(repo.installation_id);
        return c.json(await readTree(token, repo, ref, path));
      }
      const recorded = await repositoryRef(repo.id, ref);
      const data = await immutableRepoJson(
        deferredExecution(c),
        recorded
          ? `artifacts/tree/${repo.id}/${recorded.head_sha}/${encodeURIComponent(path)}`
          : null,
        () => readTreeArtifacts(repo, ref, path),
      );
      return c.json(data);
    } catch (err) {
      if (err instanceof RepoBrowserError) return c.json({ error: err.message }, err.status);
      console.error('turbodiff: tree read failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'tree read failed' }, 502);
    }
  });

  app.get('/repos/:id/file', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const ref = c.req.query('ref') ?? '';
    const path = c.req.query('path') ?? '';
    if (!isValidRepoRef(ref)) return c.json({ error: 'a valid ref query param is required' }, 400);
    if (!path || !isValidRepoPath(path)) return c.json({ error: 'invalid path' }, 400);
    try {
      if (repo.provider === 'github') {
        const token = await installationToken(repo.installation_id);
        return c.json(await readFile(token, repo, ref, path));
      }
      const recorded = await repositoryRef(repo.id, ref);
      const data = await immutableRepoJson(
        deferredExecution(c),
        recorded
          ? // v2: the payload gained content_base64 — a fresh key so cached
            // field-less JSON from before the change is never served.
            `artifacts/file/v2/${repo.id}/${recorded.head_sha}/${encodeURIComponent(path)}`
          : null,
        () => readFileArtifacts(repo, ref, path),
      );
      return c.json(data);
    } catch (err) {
      if (err instanceof RepoBrowserError) return c.json({ error: err.message }, err.status);
      console.error('turbodiff: file read failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'file read failed' }, 502);
    }
  });

  // Save one edited file: commit directly to the branch, or branch + PR.
  // base_sha is the optimistic-concurrency token — a stale one maps to 409.
  app.put('/repos/:id/file', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const body = await c.req
      .json<{
        path?: unknown;
        ref?: unknown;
        base_sha?: unknown;
        content?: unknown;
        message?: unknown;
        mode?: unknown;
      }>()
      .catch(() => null);
    const path = isString(body?.path) ? body.path : '';
    const ref = isString(body?.ref) ? body.ref : '';
    const content = body?.content;
    const mode = body?.mode;
    if (!path || !isValidRepoPath(path)) return c.json({ error: 'invalid path' }, 400);
    if (!isValidRepoRef(ref)) return c.json({ error: 'a valid ref is required' }, 400);
    if (!isString(content) || new TextEncoder().encode(content).length > 1024 * 1024) {
      return c.json({ error: 'content must be a string of at most 1 MB' }, 400);
    }
    if (mode !== 'commit' && mode !== 'pr') {
      return c.json({ error: 'mode must be "commit" or "pr"' }, 400);
    }
    if (repo.provider !== 'github' && mode === 'pr') {
      return c.json(
        {
          error:
            'pull-request saves are not available for turbodiff-hosted repositories — commit directly to the branch',
        },
        400,
      );
    }
    const message =
      isString(body?.message) && body.message.trim() ? body.message.trim() : `Update ${path}`;
    // The save pushes a commit to the branch — Artifacts repos gate on the
    // org 'settings' capability (same bar as Merge); GitHub repos on the
    // caller's own push permission, before any write token exists —
    // installation membership alone also covers read-only members.
    if (repo.provider === 'artifacts') {
      const deniedCapability = await requireCapability(
        c,
        repo.installation_id,
        'settings',
        orgAdmin,
      );
      if (deniedCapability) return deniedCapability;
    } else {
      const deniedPush = await requireRepoPush(c, repo, canPushToRepo);
      if (deniedPush) return deniedPush;
    }
    try {
      const login = c.get('user').session.login || 'turbodiff';
      const author = { name: login, email: `${login}@users.noreply.github.com` };
      const base_sha = isString(body?.base_sha) ? body.base_sha : null;
      if (repo.provider === 'github') {
        const writeToken = await sandboxGitToken(repo.installation_id, repo.name, 'write');
        const result = await saveFile(writeToken, repo, {
          path,
          ref,
          base_sha,
          content,
          message,
          mode,
          author,
        });
        return c.json<ApiFileSave>(result);
      }
      const result = await saveFileArtifacts(repo, {
        path,
        ref,
        base_sha,
        content,
        message,
        author,
      });
      return c.json<ApiFileSave>(result);
    } catch (err) {
      if (err instanceof RepoBrowserError) return c.json({ error: err.message }, err.status);
      const detail = err instanceof Error ? err.message : String(err);
      // GitHub answers 409 (or a "does not match" 422) when base_sha is stale.
      if (/GitHub API 409\b/.test(detail) || detail.includes('does not match')) {
        return c.json(
          {
            error: 'file changed on the branch since you opened it — reload and reapply your edit',
          },
          409,
        );
      }
      console.error('turbodiff: file save failed:', err);
      return c.json({ error: detail }, 502);
    }
  });

  // --- Factory PR cockpit ---

  // Explicit review entry point for any canonical change. This is the
  // partial-adoption path: a team can hand Turbodiff an existing PR without a
  // feature, plan, generation run, or commitment to downstream automation.
  app.post('/changes/:id/review', async (c) => {
    const id = Number(c.req.param('id'));
    const change = Number.isInteger(id) ? await getChange(id) : null;
    const repo = change ? await getRepoById(change.repository_id) : null;
    if (!change || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown change' }, 404);
    }
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;

    const scheduled = await scheduleChangeReview({
      changeId: change.id,
      trigger: 'manual',
      actor: c.get('user').session.login,
      idempotencyKey: `manual-review:${change.id}:${crypto.randomUUID()}`,
      enqueue: enqueueFactory,
    });
    if (scheduled.decision.kind !== 'schedule') {
      const reason =
        'reason' in scheduled.decision ? scheduled.decision.reason : 'review was not scheduled';
      return c.json({ error: reason }, 409);
    }
    return c.json({
      ok: true,
      change_id: change.id,
      run_id: scheduled.runId,
      stage_run_id: scheduled.stageRunId,
    });
  });

  app.get('/factory/features/:id', async (c) => {
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
        criteria_conflict: feature.criteria_conflict,
        proposed_criteria: feature.proposed_acceptance,
      },
      repo: `${repo.owner}/${repo.name}`,
      provider: repo.provider,
      diff_version: null,
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
      lifecycle_runs: [],
    };
    // Fetched even when generation never opened a PR — a failed run is
    // exactly the case where an advanced user most wants the full log.
    const [agentRuns, lifecycleRuns] = await Promise.all([
      listAgentRunsForFeature(feature.id),
      listFactoryRunsForFeature(feature.id),
    ]);
    base.runs = agentRuns.map(serializeAgentRun);
    base.lifecycle_runs = await Promise.all(
      lifecycleRuns.map(async (run) => {
        const [stages, events] = await Promise.all([
          listStageRuns(run.id),
          listLifecycleEvents(run.id),
        ]);
        return {
          id: run.id,
          profile: run.profile_key,
          status: run.status,
          start_stage: run.start_stage,
          stop_after_stage: run.stop_after_stage,
          handoff_reason: run.handoff_reason,
          created_at: run.created_at,
          completed_at: run.completed_at,
          stages: stages.map((stage) => ({
            id: stage.id,
            stage: stage.stage,
            attempt: stage.attempt,
            status: stage.status,
            error: stage.error,
            started_at: stage.started_at,
            completed_at: stage.completed_at,
          })),
          events: events.map((event) => ({
            key: event.idempotency_key,
            kind: event.kind,
            decision: event.decision?.kind ?? null,
            reason: lifecycleDecisionReason(event.decision),
            created_at: event.created_at,
          })),
        };
      }),
    );
    if (!feature.pr_number) return c.json(base);
    base.certificate_url = await certificateUrl(feature.id);

    const [plan, verification, cockpitComments] = await Promise.all([
      getPlanByFeatureId(feature.id),
      latestVerificationForFeature(feature.id),
      listCockpitComments(feature.id),
    ]);
    if (repo.provider === 'artifacts') {
      // Native change request: same response shape as the GitHub path,
      // sourced from the CR row and the R2 diff cache.
      const cr = feature.change_request_id
        ? await getChangeRequest(feature.change_request_id)
        : null;
      if (cr) {
        base.diff_version = cr.source_head;
        base.cr_number = cr.number;
        const crFiles = changeRequestFiles(cr);
        base.pr = {
          state: cr.status,
          html_url: null,
          additions: crFiles.reduce((sum, f) => sum + (f.additions ?? 0), 0),
          deletions: crFiles.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
          changed_files: crFiles.length,
          mergeable_state:
            cr.mergeable === false ? 'dirty' : cr.mergeable === true ? 'clean' : null,
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
        const REVIEW_STALL_MS = 15 * 60_000;
        base.checks = (await listCrChecks(cr.id)).map((check) => {
          // Only post_review resolves the review check; an agent that died
          // mid-processing (e.g. model-gateway failure) leaves it 'running'
          // forever — surface that honestly instead of eternal polling.
          const stalled =
            check.name === 'review' &&
            check.status === 'running' &&
            Date.now() - parseUtc(check.updated_at) > REVIEW_STALL_MS;
          return {
            name: check.name,
            status: stalled ? 'error' : check.status,
            summary: stalled ? 'review stalled — re-run from the cockpit' : check.summary,
          };
        });
      }
    } else {
      const token = await installationToken(repo.installation_id);
      const ghBase = `/repos/${repo.owner}/${repo.name}`;
      // Conditional requests (githubJsonCached): between polls these three
      // reads are usually unchanged — GitHub's 304s cost no rate-limit
      // credit and skip re-downloading up to 100 file patches.
      const [prMeta, prReviews] = await Promise.all([
        githubJsonCached<{
          state: string;
          merged: boolean;
          html_url: string;
          additions: number;
          deletions: number;
          changed_files: number;
          mergeable_state: string | null;
          head: { sha: string };
        }>(token, `${ghBase}/pulls/${feature.pr_number}`),
        githubJsonCached<{ state: string; body: string; user: { login: string } | null }[]>(
          token,
          `${ghBase}/pulls/${feature.pr_number}/reviews?per_page=100`,
        ),
      ]);

      base.pr = {
        state: prMeta.merged ? 'merged' : prMeta.state,
        html_url: prMeta.html_url,
        additions: prMeta.additions,
        deletions: prMeta.deletions,
        changed_files: prMeta.changed_files,
        mergeable_state: prMeta.mergeable_state,
      };
      base.diff_version = prMeta.head.sha;
      base.reviews = prReviews.map((r) => ({
        state: r.state,
        body: r.body,
        author: r.user?.login ?? null,
      }));
    }
    base.comments = cockpitComments.map(serializeCockpitComment);
    base.plan = plan?.plan ?? null;

    const demo = verification?.demo ?? null;
    if (demo?.video) {
      base.demo = {
        url: `/artifacts/${demo.video}?sig=${await signArtifactKey(demo.video)}`,
        caption: demo.caption ?? null,
      };
    }
    const criteria = feature.acceptance ?? [];
    const results = verification?.results ?? [];
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
      verification?.created_at ?? null,
    );
    return c.json(base);
  });

  // Diff snapshot: intentionally separate from the volatile cockpit summary.
  // Comments, checks, and run statuses can refresh without re-fetching or
  // re-parsing hundreds of kilobytes of patches. This endpoint is loaded only
  // after the summary has painted.
  app.get('/factory/features/:id/diff', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    const rawVersion = c.req.query('v');
    // Versioned snapshots are immutable, but only accept commit-like client
    // versions so an authenticated caller cannot create unbounded cache keys.
    const requestedVersion =
      rawVersion && /^[0-9a-f]{7,64}$/i.test(rawVersion) ? rawVersion.toLowerCase() : null;
    const artifactsCr =
      repo.provider === 'artifacts' && feature.change_request_id
        ? await getChangeRequest(feature.change_request_id)
        : null;
    const diffVersion = artifactsCr?.source_head ?? requestedVersion;
    const empty: ApiFeatureDiff = { version: diffVersion, files: [], more_files: 0 };
    if (!feature.pr_number) return c.json(empty);

    const MAX_FILES = 50;
    const load = async (): Promise<ApiFeatureDiff> => {
      if (repo.provider === 'artifacts') {
        if (!artifactsCr) return empty;
        const patchByPath = new Map(
          splitPatchByFile(await getCrDiffPatch(artifactsCr)).map((file) => [
            file.path,
            file.patch,
          ]),
        );
        const crFiles = changeRequestFiles(artifactsCr);
        return {
          version: artifactsCr.source_head,
          files: crFiles.slice(0, MAX_FILES).map((file) => {
            const patch = patchByPath.get(file.path);
            return {
              filename: file.path,
              status: file.status,
              additions: file.additions ?? 0,
              deletions: file.deletions ?? 0,
              patch: patch && patch.length < 100_000 ? patch : null,
            };
          }),
          more_files: Math.max(0, crFiles.length - MAX_FILES),
        };
      }

      const token = await installationToken(repo.installation_id);
      const files = await githubJsonCached<
        {
          filename: string;
          status: string;
          additions: number;
          deletions: number;
          patch?: string;
        }[]
      >(token, `/repos/${repo.owner}/${repo.name}/pulls/${feature.pr_number}/files?per_page=100`);
      return {
        version: requestedVersion,
        files: files.slice(0, MAX_FILES).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch:
            file.patch && file.patch.length < 100_000
              ? `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n`
              : null,
        })),
        more_files: Math.max(0, files.length - MAX_FILES),
      };
    };
    const cacheKey = diffVersion
      ? `feature-diff/${feature.id}/${encodeURIComponent(diffVersion)}`
      : null;
    return c.json(await immutableRepoJson(deferredExecution(c), cacheKey, load));
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
      line <= 0 ||
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
    // The fix run pushes commits to the source branch — Artifacts repos gate
    // on the org 'settings' capability (same bar as Merge); GitHub repos on
    // the push permission GitHub itself would demand for those commits.
    if (repo.provider === 'artifacts') {
      const deniedCapability = await requireCapability(
        c,
        repo.installation_id,
        'settings',
        orgAdmin,
      );
      if (deniedCapability) return deniedCapability;
    } else {
      const denied = await requireRepoPush(c, repo, canPushToRepo);
      if (denied) return denied;
    }
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

  // Chat history for the cockpit's agent chat panel, chronological.
  app.get('/factory/features/:id/chat', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    return c.json({
      messages: (await listChatMessages(feature.id)).map(serializeChatMessage),
    } satisfies ApiChatList);
  });

  // One chat turn: records the user message ('queued') and enqueues the
  // durable chat workflow. The reply lands as an assistant row the panel
  // picks up by polling.
  app.post('/factory/features/:id/chat', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    const payload = await c.req.json<{ body?: string }>().catch(() => null);
    const body = payload?.body?.trim();
    if (!body) return c.json({ error: 'body must be {body}' }, 400);
    if (!feature.pr_number || feature.status !== 'pr_opened') {
      return c.json({ error: 'no open pull request for this feature' }, 409);
    }
    // Chat turns push commits to the source branch — same gate as
    // /comments/submit. Deliberately NO repo.auto_fix check: chat is
    // human-supervised, not part of the automated fix loop.
    if (repo.provider === 'artifacts') {
      const deniedCapability = await requireCapability(
        c,
        repo.installation_id,
        'settings',
        orgAdmin,
      );
      if (deniedCapability) return deniedCapability;
    } else {
      const denied = await requireRepoPush(c, repo, canPushToRepo);
      if (denied) return denied;
    }
    // One turn in flight at a time — matches the disabled input client-side.
    if (await hasPendingChatTurn(feature.id)) {
      return c.json({ error: 'a chat turn is already running — wait for the reply' }, 409);
    }
    const { session } = c.get('user');
    const chatMessageId = await createUserChatMessage(
      feature.id,
      body,
      session.login,
      session.userId,
    );
    await enqueueFactory({ kind: 'chat', featureId: feature.id, chatMessageId });
    return c.json({ ok: true, message_id: chatMessageId });
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

  // A delivery run parked by a stage failure waits on a human — this is the
  // human: re-run the failed stage as a fresh attempt on the same run.
  app.post('/factory/features/:id/lifecycle/:runId/resume', async (c) => {
    const id = Number(c.req.param('id'));
    const runId = Number(c.req.param('runId'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    const run = (await listFactoryRunsForFeature(feature.id)).find((r) => r.id === runId);
    if (!run) return c.json({ error: 'unknown run' }, 404);
    const result = await resumeFailedStage(run.id, c.get('user').session.login, enqueueFactory);
    if (result.kind === 'rejected') return c.json({ error: result.reason }, 409);
    return c.json({
      ok: true,
      stage: result.stage,
      attempt: result.attempt,
      stage_run_id: result.stageRunId,
    });
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
  // Dispatch (or re-dispatch) the native review for an Artifacts change
  // request — the recovery path for stalled/failed reviews and the manual
  // trigger after config changes. Same capability bar as merge: reviews
  // spend model budget.
  app.post('/factory/features/:id/review', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    if (repo.provider !== 'artifacts' || !feature.change_request_id) {
      return c.json({ error: 'native reviews apply to Artifacts change requests only' }, 409);
    }
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    const cr = await getChangeRequest(feature.change_request_id);
    if (!cr || cr.status !== 'open') {
      return c.json({ error: 'the change request is not open' }, 409);
    }
    if (!cr.change_id) return c.json({ error: 'the canonical change is unavailable' }, 409);
    const scheduled = await scheduleChangeReview({
      changeId: cr.change_id,
      trigger: 'manual',
      actor: c.get('user').session.login,
      idempotencyKey: `manual-native-review:${cr.change_id}:${crypto.randomUUID()}`,
      enqueue: enqueueFactory,
    });
    if (!scheduled.stageRunId) {
      const reason =
        'reason' in scheduled.decision ? scheduled.decision.reason : 'review was not scheduled';
      return c.json({ error: reason }, 409);
    }
    return c.json({
      ok: true,
      run_id: scheduled.runId,
      stage_run_id: scheduled.stageRunId,
    });
  });

  // Criteria-conflict resolution (see verifier.ts postCriteriaConflictNotice):
  // the human decides. "update" rewrites the acceptance criteria to the
  // user's edited text and re-verifies; "keep" explicitly authorizes the fix
  // that restores the planned behavior.
  app.post('/factory/features/:id/criteria', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    const body = await c.req.json<{ criteria?: unknown }>().catch(() => null);
    const criteria = Array.isArray(body?.criteria)
      ? body.criteria
          .filter(isString)
          .map((text) => text.trim())
          .filter(Boolean)
      : null;
    if (!criteria || criteria.length === 0) {
      return c.json({ error: 'body must be {"criteria": ["...", ...]} with at least one' }, 400);
    }
    // A same-text "update" keeps the same contract and re-fails identically —
    // the two ways that happens are a stale page or an unedited textarea,
    // and both deserve words, not a silent loop.
    if (feature.acceptance && JSON.stringify(criteria) === JSON.stringify(feature.acceptance)) {
      return c.json(
        {
          error:
            'these criteria are identical to the current ones — verification would fail the same way. ' +
            'Edit them to describe the intended behavior, or choose "Keep criteria" to restore the planned behavior.',
        },
        409,
      );
    }
    await updateFeatureAcceptance(feature.id, criteria);
    await enqueueFactoryMessage({ kind: 'verify', featureId: feature.id });
    return c.json({ ok: true, reverifying: true });
  });

  app.post('/factory/features/:id/criteria/keep', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    if (!feature.criteria_conflict || !feature.pr_number) {
      return c.json({ error: 'no criteria conflict to resolve' }, 409);
    }
    const verification = await latestVerificationForFeature(feature.id);
    const results: CriterionResult[] = verification?.results ?? [];
    const criteria = feature.acceptance ?? [];
    await setFeatureCriteriaConflict(feature.id, false);
    // The explicit authorization the automatic path refused to assume: the
    // user chose the planned behavior over their comment's direction.
    await enqueueFactoryMessage({
      kind: 'fix',
      repoId: repo.id,
      prNumber: feature.pr_number,
      trigger: 'verification_failed',
      findings: formatUnmetCriteriaFindings(criteria, results),
    });
    return c.json({ ok: true, restoring: true });
  });

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
      if (cr.mergeable === false) {
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
    const userToken = await githubTokenForUser(c.get('user'));
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
    const userToken = await githubTokenForUser(c.get('user'));
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

  // The model catalog for both pickers (runner + reviewer). Deployment-wide —
  // no tenant scoping; the router already requires an authenticated user.
  app.get('/models', async (c) => {
    const catalog = await getModelCatalog();
    return c.json<ApiModels>({
      runner: { options: catalog.runner.options, default_model: catalog.runner.defaultModel },
      reviewer: {
        options: catalog.reviewer.options,
        default_model: catalog.reviewer.defaultModel,
      },
    });
  });

  // Agents are generic, not per-organization: every installation carries the
  // same set of rows (UNIQUE(installation_id, slug)), and writes fan out by
  // slug, so the list dedupes to one entry per slug and any repo in any
  // installation can enable any agent.
  app.get('/agents', async (c) => {
    const { installationIds } = c.get('user');
    const agents = await listAgents(installationIds);
    // Installation webhooks own normal seeding. Keep this best-effort repair
    // path off the response's critical path for legacy or partially mirrored
    // installations.
    deferredExecution(c).waitUntil(
      Promise.all(
        installationIds.map((id) =>
          ensureBuiltinAgents(id).catch((err) =>
            console.warn(`turbodiff: agent repair failed for installation ${id}:`, err),
          ),
        ),
      ).then(() => undefined),
    );
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
          is_builtin: a.is_builtin,
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
    const catalog = await getModelCatalog();
    const values = readAgentPayload(body, catalog.reviewer.defaultModel);
    let error = validateAgent(
      values,
      true,
      catalog.reviewer.options.map((o) => o.id),
    );
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
    const catalog = await getModelCatalog();
    return c.json<ApiAgentDetail>({
      agent: {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        description: agent.description,
        model: agent.model,
        is_builtin: agent.is_builtin,
        instructions: agent.instructions,
        installation_id: agent.installation_id,
      },
      default_model: catalog.reviewer.defaultModel,
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
    const catalog = await getModelCatalog();
    const values = { ...readAgentPayload(body, catalog.reviewer.defaultModel), slug: agent.slug };
    const error = validateAgent(
      values,
      false,
      catalog.reviewer.options.map((o) => o.id),
      agent.model,
    );
    if (error) return c.json({ error }, 400);
    // Fan out by slug so the edit applies everywhere; custom agents that
    // predate the generic model gain their missing per-installation copies.
    const { installationIds } = c.get('user');
    const siblings = (await listAgents(installationIds)).filter((a) => a.slug === agent.slug);
    await Promise.all(siblings.map((s) => updateAgent(s.id, values)));
    if (!agent.is_builtin) {
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
    if (agent.is_builtin) return c.json({ error: 'built-in agents cannot be deleted' }, 403);
    // Fan out by slug: deleting a generic agent removes every installation's copy.
    const siblings = (await listAgents(c.get('user').installationIds)).filter(
      (a) => a.slug === agent.slug && !a.is_builtin,
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
          .filter((r) => r.enabled)
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
              reviews: l.reviews,
              automations: l.automations,
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
    deferredExecution(c).waitUntil(
      Promise.all(
        installationIds.map((id) =>
          syncInstallationRepos(id).catch((err) =>
            console.warn(`turbodiff: repo sync failed for installation ${id}:`, err),
          ),
        ),
      ).then(() => undefined),
    );
    const [groups, agents, overrides, skills, skillOverrides] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listAgents(installationIds),
      listRepoAgentOverrides(installationIds),
      listSkills(installationIds),
      listRepoSkillOverrides(installationIds),
    ]);
    deferredExecution(c).waitUntil(
      Promise.all(
        installationIds.map((id) =>
          ensureBuiltinAgents(id).catch((err) =>
            console.warn(`turbodiff: agent repair failed for installation ${id}:`, err),
          ),
        ),
      ).then(() => undefined),
    );
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
          suspended: installation.suspended,
          repos: repos.map((r) => ({
            id: r.id,
            owner: r.owner,
            name: r.name,
            provider: r.provider,
            enabled: r.enabled,
            review_on_push: r.review_on_push,
            review_push_debounce_minutes: r.review_push_debounce_minutes,
            review_intake: r.review_intake,
            process_profile: r.process_profile,
            blocking_reviews: r.blocking_reviews,
            auto_fix: r.auto_fix,
            auto_merge: r.auto_merge,
            auto_resolve_conflicts: r.auto_resolve_conflicts,
            demo_videos: r.demo_videos,
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
  // in the auth schema. Reads use plain installation
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
      const invitation = await withAuth((instance) =>
        instance.api.createInvitation({
          headers: c.req.raw.headers,
          body: { email, role, organizationId: resolved.orgId },
        }),
      );
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
      await withAuth((instance) =>
        instance.api.removeMember({
          headers: c.req.raw.headers,
          body: { memberIdOrEmail: c.req.param('memberId'), organizationId: resolved.orgId },
        }),
      );
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
      await withAuth((instance) =>
        instance.api.updateMemberRole({
          headers: c.req.raw.headers,
          body: { memberId: c.req.param('memberId'), role, organizationId: resolved.orgId },
        }),
      );
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
  // The queue delays a push review by at most 12 hours (the repositories
  // CHECK constraint mirrors this bound).
  const MAX_PUSH_DEBOUNCE_MINUTES = 720;
  const isValidPushDebounceMinutes = (minutes: number): boolean =>
    Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_PUSH_DEBOUNCE_MINUTES;
  app.patch('/repos/:id', async (c) => {
    const repo = await authorizedRepo(c);
    if (!repo) return c.json({ error: 'unknown repository' }, 404);
    const deniedCapability = await requireCapability(c, repo.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    // GitHub repos additionally demand verified push permission (these
    // toggles automate pushes and merges). Artifacts repos have no GitHub
    // side to ask — the org 'settings' capability above IS the authority,
    // same bar as the native merge.
    if (repo.provider !== 'artifacts') {
      const denied = await requireRepoPush(c, repo, canPushToRepo);
      if (denied) return denied;
    }
    const body = await c.req
      .json<{
        enabled?: boolean;
        review_on_push?: boolean;
        review_push_debounce_minutes?: number;
        review_intake?: 'factory_only' | 'on_demand' | 'all_changes';
        process_profile?: AdoptableProcessProfileKey;
        blocking_reviews?: boolean;
        auto_fix?: boolean;
        auto_merge?: boolean;
        auto_resolve_conflicts?: boolean;
        demo_videos?: boolean;
        check_command?: string;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    if (
      body.review_intake !== undefined &&
      body.review_intake !== 'factory_only' &&
      body.review_intake !== 'on_demand' &&
      body.review_intake !== 'all_changes'
    ) {
      return c.json(
        { error: 'review_intake must be factory_only, on_demand, or all_changes' },
        400,
      );
    }
    if (
      body.process_profile !== undefined &&
      !ADOPTABLE_PROCESS_PROFILE_KEYS.includes(body.process_profile)
    ) {
      return c.json(
        { error: `process_profile must be ${ADOPTABLE_PROCESS_PROFILE_KEYS.join(', ')}` },
        400,
      );
    }
    if (
      body.review_push_debounce_minutes !== undefined &&
      !(
        isNumber(body.review_push_debounce_minutes) &&
        isValidPushDebounceMinutes(body.review_push_debounce_minutes)
      )
    ) {
      return c.json(
        {
          error: `review_push_debounce_minutes must be an integer between 0 and ${MAX_PUSH_DEBOUNCE_MINUTES}`,
        },
        400,
      );
    }
    if (isBoolean(body.enabled)) await setRepoEnabled(repo.id, body.enabled);
    if (isBoolean(body.review_on_push)) await setRepoReviewOnPush(repo.id, body.review_on_push);
    if (isNumber(body.review_push_debounce_minutes)) {
      await setRepoReviewPushDebounceMinutes(repo.id, body.review_push_debounce_minutes);
    }
    if (body.review_intake) await setRepoReviewIntake(repo.id, body.review_intake);
    if (body.process_profile) await setRepoProcessProfile(repo.id, body.process_profile);
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
    // GitHub repos additionally demand verified push permission (these
    // toggles automate pushes and merges). Artifacts repos have no GitHub
    // side to ask — the org 'settings' capability above IS the authority,
    // same bar as the native merge.
    if (repo.provider !== 'artifacts') {
      const denied = await requireRepoPush(c, repo, canPushToRepo);
      if (denied) return denied;
    }
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
    // GitHub repos additionally demand verified push permission (these
    // toggles automate pushes and merges). Artifacts repos have no GitHub
    // side to ask — the org 'settings' capability above IS the authority,
    // same bar as the native merge.
    if (repo.provider !== 'artifacts') {
      const denied = await requireRepoPush(c, repo, canPushToRepo);
      if (denied) return denied;
    }
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
