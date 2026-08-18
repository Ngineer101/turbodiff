import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import {
  addRepositories,
  countFixAttempts,
  deleteInstallation,
  ensureBuiltinAgents,
  getFeatureByRepoPr,
  getInstallation,
  getRepoById,
  hasActiveReview,
  listAgentsForRepo,
  removeRepositories,
  reviewCountLastDay,
  reviewedRecently,
  setInstallationSuspended,
  updateFeature,
  upsertInstallation,
  type AgentRow,
  type RepositoryRow,
} from '../lib/db.ts';
import { FIX_MAX_ATTEMPTS, type FixQueueMessage } from '../lib/fixer.ts';
import { verifyWebhookSignature } from '../lib/github-app.ts';
import { agentsForTier, computeRiskTier, tierModelOverride, type RiskTier } from '../lib/risk.ts';
import { parseJson, type JsonValue } from '../shared/json.ts';

// GitHub App webhook receiver. Two jobs:
//   1. Mirror installation / repository-selection changes into D1.
//   2. Drive the factory's review/fix loop: auto-dispatch the repo-enabled
//      agents when a FACTORY-GENERATED PR opens or gets pushed to, and enqueue
//      a fix run when one of turbodiff's own blocking reviews lands.
// Human-opened PRs are never reviewed — reviews exist to gate factory output.

interface WebhookAccount {
  login: string;
  id: number;
  type: string;
}

interface WebhookRepoRef {
  id: number;
  name: string;
  full_name: string;
}

interface InstallationEvent {
  action: string;
  installation: { id: number; account: WebhookAccount };
  repositories?: WebhookRepoRef[];
  repositories_added?: WebhookRepoRef[];
  repositories_removed?: WebhookRepoRef[];
}

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: { draft: boolean; html_url: string; merged?: boolean };
  repository: { id: number; full_name: string };
}

interface PullRequestReviewEvent {
  action: string;
  review: {
    id: number;
    state: string; // lowercase in webhook payloads: changes_requested | approved | commented
    user: { login: string; type: string } | null;
  };
  pull_request: { number: number; html_url: string; state: string; draft: boolean };
  repository: { id: number; full_name: string };
}

interface WorkflowRunEvent {
  action: string;
  workflow_run: { id: number; conclusion: string | null; pull_requests: { number: number }[] };
  repository: { id: number; full_name: string };
}

interface RepositoryEvent {
  action: string;
  repository: WebhookRepoRef;
}

// Handler bodies are flat JSON diagnostics: flags, identifiers, and counts.
// (Deliberately not the recursive JsonObject — Hono's c.json response typing
// recurses into its argument type and blows the instantiation depth on it.)
type HandlerBody = Record<string, string | number | boolean | string[]>;

interface HandlerResult {
  body: HandlerBody;
  status?: 401 | 502;
}

export type DispatchOptions = { riskTier?: string; modelOverride?: string };

export type ReviewDispatcher = (
  agent: AgentRow,
  repo: RepositoryRow,
  prNumber: number,
  prUrl: string,
  trigger: string,
  opts?: DispatchOptions,
) => Promise<boolean>;

export type FixEnqueuer = (message: FixQueueMessage) => Promise<void>;

export interface WebhookRouteDependencies {
  computeRisk?: typeof computeRiskTier;
  enqueueFix?: FixEnqueuer;
}

// A Hono sub-app; the caller supplies dispatch so this module doesn't need to
// know about the agent router.
export function createWebhookRoutes(
  dispatch: ReviewDispatcher,
  dependencies: WebhookRouteDependencies = {},
) {
  const app = new Hono();
  const computeRisk = dependencies.computeRisk ?? computeRiskTier;
  const enqueueFix: FixEnqueuer =
    dependencies.enqueueFix ??
    (async (message: FixQueueMessage) => {
      await env.FACTORY_QUEUE.send(message);
    });

  app.post('/github', async (c) => {
    const rawBody = await c.req.arrayBuffer();
    const ok = await verifyWebhookSignature(rawBody, c.req.header('x-hub-signature-256'));
    if (!ok) return c.json({ error: 'invalid signature' }, 401);

    const event = c.req.header('x-github-event') ?? '';
    const payload = parseJson(new TextDecoder().decode(rawBody));
    const result = await handleEvent(event, payload, dispatch, computeRisk, enqueueFix);
    return c.json(result.body, result.status ?? 200);
  });

  return app;
}

// GitHub's webhook contract fixes the payload schema delivered for each
// x-github-event name, so once a delivery is authenticated the event name is
// the schema selector.
function verifiedEventPayload<T>(payload: JsonValue): T {
  // SAFETY: callers reach this only after verifyWebhookSignature accepted the
  // delivery's HMAC, so the body is a genuine GitHub payload whose schema is
  // fixed by the x-github-event name each handleEvent case matches on.
  return payload as T;
}

async function handleEvent(
  event: string,
  payload: JsonValue,
  dispatch: ReviewDispatcher,
  computeRisk: typeof computeRiskTier,
  enqueueFix: FixEnqueuer,
): Promise<HandlerResult> {
  switch (event) {
    case 'installation':
      return handleInstallation(verifiedEventPayload<InstallationEvent>(payload));
    case 'installation_repositories':
      return handleInstallationRepositories(verifiedEventPayload<InstallationEvent>(payload));
    case 'pull_request':
      return handlePullRequest(
        verifiedEventPayload<PullRequestEvent>(payload),
        dispatch,
        computeRisk,
      );
    case 'pull_request_review':
      return handlePullRequestReview(
        verifiedEventPayload<PullRequestReviewEvent>(payload),
        enqueueFix,
      );
    case 'workflow_run':
      return handleWorkflowRun(verifiedEventPayload<WorkflowRunEvent>(payload), enqueueFix);
    case 'repository': {
      // Keep owner/name current when a repo is renamed or transferred.
      const p = verifiedEventPayload<RepositoryEvent>(payload);
      if (p.action === 'renamed' || p.action === 'transferred') {
        const row = await getRepoById(p.repository.id);
        if (row) await addRepositories(row.installation_id, [p.repository]);
        return { body: { ok: true, updated: p.repository.full_name } };
      }
      return { body: { ok: true, ignored: p.action } };
    }
    default:
      return { body: { ok: true, ignored: event } };
  }
}

async function handleInstallation(p: InstallationEvent): Promise<HandlerResult> {
  switch (p.action) {
    case 'created':
      await upsertInstallation(p.installation.id, p.installation.account);
      await addRepositories(p.installation.id, p.repositories ?? []);
      await ensureBuiltinAgents(p.installation.id);
      return { body: { ok: true, installed: p.installation.account.login } };
    case 'deleted':
      await deleteInstallation(p.installation.id);
      return { body: { ok: true, uninstalled: p.installation.account.login } };
    case 'suspend':
    case 'unsuspend':
      await setInstallationSuspended(p.installation.id, p.action === 'suspend');
      return { body: { ok: true, [p.action]: p.installation.account.login } };
    default:
      return { body: { ok: true, ignored: p.action } };
  }
}

async function handleInstallationRepositories(p: InstallationEvent): Promise<HandlerResult> {
  // Repo selection changed in GitHub's UI — make sure the installation row
  // exists (e.g. if the original `installation created` delivery was missed).
  await upsertInstallation(p.installation.id, p.installation.account);
  await addRepositories(p.installation.id, p.repositories_added ?? []);
  await removeRepositories((p.repositories_removed ?? []).map((r) => r.id));
  return {
    body: {
      ok: true,
      added: (p.repositories_added ?? []).length,
      removed: (p.repositories_removed ?? []).length,
    },
  };
}

// A push burst re-dispatches an agent at most once per window.
const PUSH_DEBOUNCE_MINUTES = 10;

async function handlePullRequest(
  p: PullRequestEvent,
  dispatch: ReviewDispatcher,
  computeRisk: typeof computeRiskTier,
): Promise<HandlerResult> {
  // Closed factory PRs feed the board's Done column: merged -> 'merged',
  // closed-unmerged -> 'pr_closed'. GitHub fires this for every merge path
  // (cockpit button, auto-merge, the GitHub UI itself).
  if (p.action === 'closed') {
    const repo = await getRepoById(p.repository.id);
    const feature = repo ? await getFeatureByRepoPr(repo.id, p.number) : null;
    if (!feature) return { body: { ok: true, ignored: 'closed non-factory PR' } };
    // The cockpit's abandon action closes the PR itself and sets 'abandoned'
    // before this webhook delivery lands — don't let the generic 'pr_closed'
    // clobber that more specific status.
    if (feature.status === 'abandoned') {
      return { body: { ok: true, feature: feature.id, ignored: 'already abandoned' } };
    }
    await updateFeature(feature.id, { status: p.pull_request.merged ? 'merged' : 'pr_closed' });
    return {
      body: {
        ok: true,
        feature: feature.id,
        status: p.pull_request.merged ? 'merged' : 'pr_closed',
      },
    };
  }
  if (p.action !== 'opened' && p.action !== 'ready_for_review' && p.action !== 'synchronize') {
    return { body: { ok: true, ignored: p.action } };
  }
  if (p.pull_request.draft) return { body: { ok: true, skipped: 'draft' } };

  const repo = await getRepoById(p.repository.id);
  if (!repo) return { body: { ok: true, skipped: 'repo not tracked' } };
  if (!repo.enabled) return { body: { ok: true, skipped: 'factory disabled for repo' } };
  if (p.action === 'synchronize' && !repo.review_on_push) {
    return { body: { ok: true, skipped: 'push reviews disabled for repo' } };
  }

  // Reviews gate factory output only: a PR gets auto-reviewed only when it
  // belongs to a feature this factory generated. Human-opened PRs are never
  // dispatched (the standalone auto-review product was retired).
  const feature = await getFeatureByRepoPr(repo.id, p.number);
  if (!feature) return { body: { ok: true, skipped: 'not a factory PR' } };

  const installation = await getInstallation(repo.installation_id);
  if (!installation || installation.suspended) {
    return { body: { ok: true, skipped: 'installation missing or suspended' } };
  }

  const enabled = (await listAgentsForRepo(repo)).filter((a) => a.enabled);
  if (enabled.length === 0) return { body: { ok: true, skipped: 'no agents enabled' } };

  // Classify the PR before spending budget: small mechanical changes get one
  // generalist, only large or security-sensitive ones the full fleet. Fail
  // open to 'full' — a tiering hiccup must widen review, never skip it.
  let tier: RiskTier = 'full';
  try {
    tier = await computeRisk(repo.installation_id, repo.owner, repo.name, p.number);
  } catch (err) {
    console.warn(
      `turbodiff: risk tier computation failed for ${p.repository.full_name}#${p.number}, defaulting to full:`,
      err,
    );
  }
  let agents = agentsForTier(tier, enabled);
  const modelOverride = tierModelOverride(tier);

  // Pushes re-review with awareness (the agent reconciles against existing
  // threads), but debounced: skip agents mid-review or dispatched within the
  // window, so a burst of pushes costs one re-review, not one per push.
  if (p.action === 'synchronize') {
    const idle: typeof agents = [];
    for (const agent of agents) {
      const busy =
        (await hasActiveReview(repo.id, p.number, agent.slug)) ||
        (await reviewedRecently(repo.id, p.number, agent.slug, PUSH_DEBOUNCE_MINUTES));
      if (!busy) idle.push(agent);
    }
    agents = idle;
    if (agents.length === 0) {
      return { body: { ok: true, skipped: 'all agents busy or within push debounce' } };
    }
  }

  // The daily cap counts agent-runs, so N selected agents consume N units.
  const budget = await remainingDailyBudget(repo.installation_id, installation.account_login);
  if (budget <= 0) return { body: { ok: true, skipped: 'daily review limit reached' } };
  if (agents.length > budget) {
    console.warn(
      `turbodiff: daily cap leaves budget for ${budget} of ${agents.length} agents on ${p.repository.full_name}#${p.number}`,
    );
  }

  const dispatched: string[] = [];
  for (const agent of agents.slice(0, budget)) {
    const opts: DispatchOptions = { riskTier: tier };
    if (modelOverride) opts.modelOverride = modelOverride;
    if (await dispatch(agent, repo, p.number, p.pull_request.html_url, p.action, opts)) {
      dispatched.push(agent.slug);
    }
  }
  if (dispatched.length === 0) return { body: { error: 'dispatch failed' }, status: 502 };
  return {
    body: { ok: true, review: `${p.repository.full_name}#${p.number}`, tier, agents: dispatched },
  };
}

// The auto-fix trigger: turbodiff's own blocking review (posted when the repo
// has blocking_reviews on and a P1 lands) enqueues a fix run. GitHub delivers
// the app's own review back to it, so the author check is what closes the
// loop deliberately rather than accidentally. The consumer re-validates
// everything; this handler just gates cheaply before enqueueing.
async function handlePullRequestReview(
  p: PullRequestReviewEvent,
  enqueueFix: FixEnqueuer,
): Promise<HandlerResult> {
  if (p.action !== 'submitted') return { body: { ok: true, ignored: p.action } };
  if (p.review.state !== 'changes_requested') {
    return { body: { ok: true, ignored: `review state ${p.review.state}` } };
  }
  const botLogin = `${env.GITHUB_APP_SLUG || 'turbodiff'}[bot]`;
  if (p.review.user?.type !== 'Bot' || p.review.user.login !== botLogin) {
    return { body: { ok: true, ignored: 'not our review' } };
  }
  if (p.pull_request.state !== 'open' || p.pull_request.draft) {
    return { body: { ok: true, skipped: 'PR closed or draft' } };
  }

  const repo = await getRepoById(p.repository.id);
  if (!repo) return { body: { ok: true, skipped: 'repo not tracked' } };
  if (!repo.enabled || !repo.auto_fix) {
    return { body: { ok: true, skipped: 'auto-fix disabled for repo' } };
  }
  const installation = await getInstallation(repo.installation_id);
  if (!installation || installation.suspended) {
    return { body: { ok: true, skipped: 'installation missing or suspended' } };
  }
  const attempts = await countFixAttempts(repo.id, p.pull_request.number);
  if (attempts >= FIX_MAX_ATTEMPTS) {
    return { body: { ok: true, skipped: `fix cap reached (${attempts})` } };
  }

  await enqueueFix({
    kind: 'fix',
    repoId: repo.id,
    prNumber: p.pull_request.number,
    trigger: 'blocking_review',
  });
  return { body: { ok: true, fix_enqueued: `${p.repository.full_name}#${p.pull_request.number}` } };
}

// The CI-failure auto-fix trigger: a failed GitHub Actions run on a PR
// turbodiff itself opened and still manages enqueues a fix run, the same way
// a blocking bot review does. Scoped to factory PRs still in 'pr_opened'
// status only — never a human contributor's branch. The workflow_run
// payload's mini PR refs carry no state/draft flag, so this uses the cached
// feature status (set 'pr_opened' on generation, flipped to
// 'merged'/'pr_closed' by the pull_request 'closed' handler above) instead of
// an extra API round trip. The consumer re-validates everything; this
// handler just gates cheaply before enqueueing.
async function handleWorkflowRun(
  p: WorkflowRunEvent,
  enqueueFix: FixEnqueuer,
): Promise<HandlerResult> {
  if (p.action !== 'completed') return { body: { ok: true, ignored: p.action } };
  if (p.workflow_run.conclusion !== 'failure') {
    return { body: { ok: true, ignored: `conclusion ${p.workflow_run.conclusion}` } };
  }
  const prNumber = p.workflow_run.pull_requests[0]?.number;
  if (!prNumber) return { body: { ok: true, skipped: 'no associated pull request' } };

  const repo = await getRepoById(p.repository.id);
  if (!repo) return { body: { ok: true, skipped: 'repo not tracked' } };
  if (!repo.enabled || !repo.auto_fix) {
    return { body: { ok: true, skipped: 'auto-fix disabled for repo' } };
  }
  const installation = await getInstallation(repo.installation_id);
  if (!installation || installation.suspended) {
    return { body: { ok: true, skipped: 'installation missing or suspended' } };
  }

  const feature = await getFeatureByRepoPr(repo.id, prNumber);
  if (!feature || feature.status !== 'pr_opened') {
    return { body: { ok: true, skipped: 'not an open factory PR' } };
  }

  const attempts = await countFixAttempts(repo.id, prNumber);
  if (attempts >= FIX_MAX_ATTEMPTS) {
    return { body: { ok: true, skipped: `fix cap reached (${attempts})` } };
  }

  await enqueueFix({
    kind: 'fix',
    repoId: repo.id,
    prNumber,
    trigger: 'ci_failure',
    workflowRunId: p.workflow_run.id,
  });
  return { body: { ok: true, fix_enqueued: `${p.repository.full_name}#${prNumber}` } };
}

// Agent-runs left under the installation's daily cap.
async function remainingDailyBudget(installationId: number, accountLogin: string): Promise<number> {
  const limit = Number(env.REVIEW_DAILY_LIMIT) || 50;
  const used = await reviewCountLastDay(installationId);
  const remaining = limit - used;
  if (remaining <= 0) {
    console.warn(
      `turbodiff: daily review cap (${limit}) reached for installation ${installationId} (${accountLogin})`,
    );
  }
  return remaining;
}
