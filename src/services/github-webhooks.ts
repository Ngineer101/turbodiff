import { env } from 'cloudflare:workers';
import {
  addRepositories,
  countFixAttempts,
  deleteInstallation,
  ensureBuiltinAgents,
  getFeatureByRepoPr,
  getInstallation,
  getRepoById,
  removeRepositories,
  setInstallationSuspended,
  updateFeature,
  upsertChange,
  changeProviderKey,
  upsertInstallation,
} from '../data/db.ts';
import { FIX_MAX_ATTEMPTS, type FixQueueMessage } from '../shared/factory-messages.ts';
import { enqueueFactoryMessage } from './factory-queue.ts';
import { ensureOrganizationForInstallation, ensureOwnerMember } from './access-control.ts';
import type { JsonValue } from '../shared/json.ts';
import type { ChangeCapability, ChangeOrigin } from '../domain/lifecycle-contract.ts';
import { scheduleChangeReview } from './lifecycle.ts';

// GitHub App webhook receiver. Two jobs:
//   1. Mirror installation / repository-selection changes into PostgreSQL.
//   2. Drive the configured review/fix intake: legacy repositories admit only
//      factory changes; composable profiles may admit human and automation PRs.

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
  // Present on the initial `installation` delivery (not on
  // installation_repositories) — the GitHub user who installed the app.
  sender?: { id: number; login: string };
}

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    draft: boolean;
    html_url: string;
    merged?: boolean;
    state?: string;
    title?: string;
    updated_at?: string;
    maintainer_can_modify?: boolean;
    user?: { login: string; type: string } | null;
    head?: { ref: string; sha: string; repo: { full_name: string } | null };
    base?: { ref: string; sha: string };
  };
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

export interface WebhookHandlerResult {
  body: HandlerBody;
  status?: 502;
}

export type FixEnqueuer = (message: FixQueueMessage) => Promise<void>;

export interface GithubWebhookDependencies {
  enqueueFix?: FixEnqueuer;
  enqueueLifecycle?: typeof enqueueFactoryMessage;
}

// Application service: authenticated payloads enter here after the transport
// verifies GitHub's signature and parses JSON.
export function createGithubWebhookService(dependencies: GithubWebhookDependencies = {}) {
  const enqueueFix: FixEnqueuer =
    dependencies.enqueueFix ??
    (async (message: FixQueueMessage) => {
      await enqueueFactoryMessage(message);
    });

  return {
    handle(event: string, payload: JsonValue): Promise<WebhookHandlerResult> {
      return handleEvent(event, payload, enqueueFix, dependencies.enqueueLifecycle);
    },
  };
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
  enqueueFix: FixEnqueuer,
  enqueueLifecycle?: typeof enqueueFactoryMessage,
): Promise<WebhookHandlerResult> {
  switch (event) {
    case 'installation':
      return handleInstallation(verifiedEventPayload<InstallationEvent>(payload));
    case 'installation_repositories':
      return handleInstallationRepositories(verifiedEventPayload<InstallationEvent>(payload));
    case 'pull_request':
      return handlePullRequest(verifiedEventPayload<PullRequestEvent>(payload), enqueueLifecycle);
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

async function handleInstallation(p: InstallationEvent): Promise<WebhookHandlerResult> {
  switch (p.action) {
    case 'created':
      await upsertInstallation(p.installation.id, p.installation.account, p.sender?.id);
      await addRepositories(p.installation.id, p.repositories ?? []);
      await ensureBuiltinAgents(p.installation.id);
      // Teams & orgs: Organization-type
      // installations get a linked better-auth organization, with the
      // installer recorded as its owner — the natural provisioning point,
      // since this delivery already carries both the installation and the
      // installer's identity (sender).
      if (p.installation.account.type === 'Organization') {
        const orgId = await ensureOrganizationForInstallation(
          p.installation.id,
          p.installation.account.login,
        );
        if (p.sender) await ensureOwnerMember(orgId, p.sender.id);
      }
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

async function handleInstallationRepositories(p: InstallationEvent): Promise<WebhookHandlerResult> {
  // Repo selection changed in GitHub's UI — make sure the installation row
  // exists (e.g. if the original `installation created` delivery was missed).
  await upsertInstallation(p.installation.id, p.installation.account);
  // Same self-heal for the organization row: if the `installation created`
  // delivery was missed, this is the next chance to provision it (no sender
  // on this event, so no owner to assign — that gap is closed lazily: the
  // recorded installer or a GitHub org admin is bootstrapped as owner on
  // their first authenticated org request, see orgForInstallationWithHeal in
  // src/services/access-control.ts, and an existing owner/admin can always
  // add one by hand).
  if (p.installation.account.type === 'Organization') {
    await ensureOrganizationForInstallation(p.installation.id, p.installation.account.login);
  }
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

function githubChangeCapabilities(p: PullRequestEvent): ChangeCapability[] {
  const capabilities: ChangeCapability[] = [
    'read_change',
    'publish_review',
    'publish_check',
    'merge',
  ];
  // Fork pull requests remain reviewable but are not assumed writable. A
  // future live capability probe may add write_head when the installation can
  // prove it has authority in the contributor repository.
  if (p.pull_request.head?.repo?.full_name === p.repository.full_name) {
    capabilities.push('write_head');
  }
  return capabilities;
}

function githubChangeOrigin(p: PullRequestEvent, factoryFeature: boolean): ChangeOrigin {
  if (factoryFeature || p.pull_request.head?.ref.startsWith('turbodiff/')) return 'factory';
  if (p.pull_request.user?.type === 'Bot') return 'automation';
  return 'human';
}

async function handlePullRequest(
  p: PullRequestEvent,
  enqueueLifecycle?: typeof enqueueFactoryMessage,
): Promise<WebhookHandlerResult> {
  const repo = await getRepoById(p.repository.id);
  if (!repo) return { body: { ok: true, skipped: 'repo not tracked' } };
  const feature = await getFeatureByRepoPr(repo.id, p.number);
  const change = await upsertChange({
    repositoryId: repo.id,
    providerKey: changeProviderKey('github', p.number),
    number: p.number,
    origin: githubChangeOrigin(p, feature !== null),
    title: p.pull_request.title ?? feature?.title ?? `Pull request #${p.number}`,
    externalUrl: p.pull_request.html_url,
    sourceBranch: p.pull_request.head?.ref ?? feature?.branch ?? `refs/pull/${p.number}/head`,
    targetBranch: p.pull_request.base?.ref ?? repo.default_branch ?? 'main',
    status: p.action === 'closed' ? (p.pull_request.merged ? 'merged' : 'closed') : 'open',
    sourceHead: p.pull_request.head?.sha ?? null,
    targetHead: p.pull_request.base?.sha ?? null,
    draft: p.pull_request.draft,
    capabilities: githubChangeCapabilities(p),
    providerUpdatedAt: p.pull_request.updated_at ?? null,
  });
  if (feature) await updateFeature(feature.id, { changeId: change.id });

  // Closed factory PRs feed the board's Done column: merged -> 'merged',
  // closed-unmerged -> 'pr_closed'. GitHub fires this for every merge path
  // (cockpit button, auto-merge, the GitHub UI itself).
  if (p.action === 'closed') {
    if (!feature) {
      return {
        body: {
          ok: true,
          change: change.id,
          status: p.pull_request.merged ? 'merged' : 'closed',
        },
      };
    }
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
        change: change.id,
        feature: feature.id,
        status: p.pull_request.merged ? 'merged' : 'pr_closed',
      },
    };
  }
  if (p.action !== 'opened' && p.action !== 'ready_for_review' && p.action !== 'synchronize') {
    return { body: { ok: true, ignored: p.action } };
  }
  if (p.action === 'synchronize' && !repo.review_on_push) {
    return { body: { ok: true, skipped: 'push reviews disabled for repo' } };
  }

  const scheduled = await scheduleChangeReview({
    changeId: change.id,
    trigger: p.action,
    idempotencyKey: [
      'github-review',
      change.id,
      p.action,
      change.source_head ?? change.provider_updated_at ?? 'unknown-head',
    ].join(':'),
    enqueue: enqueueLifecycle,
  });
  if (!scheduled.stageRunId) {
    const skipped =
      scheduled.decision.kind === 'ignore' || scheduled.decision.kind === 'handoff'
        ? scheduled.decision.reason
        : scheduled.decision.kind;
    return { body: { ok: true, change: change.id, run: scheduled.runId, skipped } };
  }
  return {
    body: {
      ok: true,
      review: `${p.repository.full_name}#${p.number}`,
      run: scheduled.runId,
      stage_run: scheduled.stageRunId,
    },
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
): Promise<WebhookHandlerResult> {
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
): Promise<WebhookHandlerResult> {
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
