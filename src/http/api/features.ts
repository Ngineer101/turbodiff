import type { Hono } from 'hono';
import { parseUtc } from '../../shared/time.ts';
import {
  formatUnmetCriteriaFindings,
  gradedCriteria,
  type CriterionResult,
} from '../../domain/verification.ts';
import {
  closeChangeRequest,
  createCockpitComment,
  createUserChatMessage,
  hasPendingChatTurn,
  listChatMessages,
  getChangeRequest,
  getChange,
  latestExplanation,
  latestReadyExplanation,
  tryRecordExplanation,
  type ExplanationRow,
  listCrChecks,
  listCrComments,
  dispatchOpenCockpitComments,
  getFeature,
  getPlanByFeatureId,
  getRepoById,
  latestVerificationForFeature,
  listAgentRunsForFeature,
  listCockpitComments,
  listFactoryRunsForFeature,
  listLifecycleEvents,
  listStageRuns,
  updateFeature,
  setFeatureCriteriaConflict,
  updateFeatureAcceptance,
} from '../../data/db.ts';
import { githubTokenForUser } from '../../services/auth.ts';
import { certificateUrl } from '../../services/certificates.ts';
import { CR_BOT_AUTHOR, changeRequestFiles } from '../../services/change-requests.ts';
import { loadFeatureDiff } from '../../services/feature-diff.ts';

import { explainInstanceId, parseExplanationDocument } from '../../domain/explain.ts';
import { DEFAULT_MODEL } from '../../domain/personas.ts';
import { signArtifactKey } from '../../integrations/security/crypto.ts';
import { githubJsonCached, githubRequest as gh } from '../../integrations/github/client.ts';
import { installationToken } from '../../integrations/github/app.ts';
import { checkMergeability, dispatchConflictResolution } from '../../services/merge-conflicts.ts';
import { mergePullRequest } from '../../services/auto-merge.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { resumeFailedStage, scheduleChangeReview } from '../../services/lifecycle.ts';
import { type LifecycleDecision } from '../../domain/lifecycle-contract.ts';
import { isJsonObject, isNumber, isString, type JsonValue } from '../../shared/json.ts';
import {
  type ApiChatList,
  type ApiFeatureDetail,
  type ApiFeatureDiff,
  type ApiFeatureExplanation,
} from '../../shared/api-types.ts';
import {
  requireCapability,
  requireRepoPush,
  serializeAgentRun,
  serializeChatMessage,
  serializeCockpitComment,
  verificationSummary,
  type ApiEnv,
} from '../api-support.ts';
import { deferredExecution, immutableRepoJson } from './execution.ts';
import type { ResolvedApiRouteDependencies } from './types.ts';

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

// POST /factory/features/:id/explain — the head to explain and whether to
// replace a finished document (Regenerate).
interface ExplainRequestBody {
  v?: string;
  force?: boolean;
}

// Only commit-like versions key an explanation (same rule as the diff route).
function explainVersion(raw: string | undefined): string | null {
  return raw && /^[0-9a-f]{7,64}$/i.test(raw) ? raw.toLowerCase() : null;
}

function serializeExplanation(
  version: string | null,
  row: ExplanationRow | null,
): ApiFeatureExplanation {
  const document = row?.status === 'ready' ? parseExplanationDocument(row.document) : null;
  return {
    version,
    // A ready row whose stored document no longer parses reads as failed so
    // the tab offers Regenerate instead of an empty page.
    status: !row ? 'none' : row.status === 'ready' && !document ? 'failed' : row.status,
    document,
    model: row?.model ?? null,
    error: row
      ? row.status === 'ready' && !document
        ? 'stored document is unreadable'
        : row.error
      : null,
    created_at: row?.created_at ?? null,
    completed_at: row?.completed_at ?? null,
    previous: null,
  };
}

// A verify stage completes whenever the verification ran (its pass/fail is a
// coordinator fact, not a stage failure), so the stage row alone reads green
// for a failed verdict. Surface the recorded verdict for the cockpit.
function stageVerdict(output: JsonValue | null): string | null {
  if (!isJsonObject(output) || output.kind !== 'verification_completed') return null;
  return isString(output.status) ? output.status : null;
}

export function registerFeatureCockpitRoutes(
  app: Hono<ApiEnv>,
  dependencies: Pick<
    ResolvedApiRouteDependencies,
    'canPushToRepo' | 'orgAdmin' | 'enqueueFactory' | 'dispatchExplain'
  >,
) {
  const { canPushToRepo, orgAdmin, enqueueFactory, dispatchExplain: explain } = dependencies;
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
            verdict: stageVerdict(stage.output),
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
          // A Workflow that dies before settlement can leave this check
          // running; surface the shared stall cutoff instead of polling forever.
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
    // gradedCriteria keeps any result row beyond the stored criteria (older
    // verifications carry one) — zipping by index alone dropped the one
    // failing row and painted N/N proven under a failed verdict.
    base.criteria = await Promise.all(
      gradedCriteria(feature.acceptance ?? [], verification?.results ?? []).map(
        async ({ text, result: r }) => {
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
        },
      ),
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
    if (!feature.pr_number) {
      return c.json({ version: diffVersion, files: [], more_files: 0 } satisfies ApiFeatureDiff);
    }
    const cacheKey = diffVersion
      ? `feature-diff/${feature.id}/${encodeURIComponent(diffVersion)}`
      : null;
    return c.json(
      await immutableRepoJson(deferredExecution(c), cacheKey, () =>
        loadFeatureDiff(feature, repo, artifactsCr, requestedVersion),
      ),
    );
  });

  // Explain tab (src/domain/explain.ts): the show-me document for the head
  // the cockpit is showing. `v` is the diff version the client holds; a head
  // with no row reads as 'none' so the tab can request one. `previous` is
  // the newest finished document for an earlier head — shown, marked stale,
  // while the current one is written.
  app.get('/factory/features/:id/explain', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    const version = explainVersion(c.req.query('v'));
    const current = version ? await latestExplanation(feature.id, version) : null;
    const body = serializeExplanation(version, current);
    if (body.status !== 'ready') {
      const previous = await latestReadyExplanation(feature.id);
      const document = previous ? parseExplanationDocument(previous.document) : null;
      if (previous && document && previous.head_sha !== version) {
        body.previous = {
          version: previous.head_sha,
          document,
          completed_at: previous.completed_at ?? previous.created_at,
        };
      }
    }
    return c.json(body);
  });

  // Write (or rewrite) the explanation for a head. Idempotent by default: an
  // existing running/ready row for the head is returned untouched; `force`
  // starts a fresh row (Regenerate). One explanation runs per feature at a
  // time — a concurrent request sees 409 and polls the running row.
  app.post('/factory/features/:id/explain', async (c) => {
    const id = Number(c.req.param('id'));
    const feature = Number.isInteger(id) ? await getFeature(id) : null;
    const repo = feature ? await getRepoById(feature.repository_id) : null;
    if (!feature || !repo || !c.get('user').installationIds.includes(repo.installation_id)) {
      return c.json({ error: 'unknown feature' }, 404);
    }
    if (!feature.pr_number) return c.json({ error: 'no change to explain yet' }, 409);
    const payload = await c.req.json<ExplainRequestBody>().catch((): ExplainRequestBody => ({}));
    const version = explainVersion(payload.v);
    if (!version) return c.json({ error: 'a diff version is required' }, 400);
    if (!payload.force) {
      const existing = await latestExplanation(feature.id, version);
      if (existing && existing.status !== 'failed') {
        return c.json(serializeExplanation(version, existing));
      }
    }
    // Gateway model id (the reviewer's default) — runner_model is a sandbox
    // CLI id and does not apply on this path.
    const model = DEFAULT_MODEL;
    const instanceId = explainInstanceId(feature.id, version, crypto.randomUUID().slice(0, 8));
    const rowId = await tryRecordExplanation(feature.id, version, instanceId, model);
    if (rowId === null) return c.json({ error: 'an explanation is already being written' }, 409);
    await explain(feature, repo, version, instanceId, model);
    return c.json(serializeExplanation(version, await latestExplanation(feature.id, version)), 202);
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
}

export function registerFeatureActionRoutes(
  app: Hono<ApiEnv>,
  dependencies: Pick<ResolvedApiRouteDependencies, 'canPushToRepo' | 'orgAdmin' | 'enqueueFactory'>,
) {
  const { canPushToRepo, orgAdmin, enqueueFactory } = dependencies;
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
}
