import type { Hono } from 'hono';
import {
  agentUsageForMonth,
  automationUsageForMonth,
  countReviews,
  dashboardStats,
  factoryVersion,
  listFixAttemptsForRepoPrs,
  listInstallationsWithRepos,
  listRecentFeaturesForUsage,
  listRecentReviews,
  listReviewFileEvidenceForReviews,
  reviewQualityDashboard,
  listReviewsForRepoPrs,
  listVerificationsForFeatures,
  monthlyUsage,
  pipelineCostByMonth,
  pipelineCostForMonth,
  repoUsageForMonth,
  setReviewFindingFeedback,
  type ReviewFindingFeedback,
  type VerificationRow,
} from '../../data/db.ts';
import { isString } from '../../shared/json.ts';
import { type ApiReviewsPage, type ApiUsage } from '../../shared/api-types.ts';
import {
  currentMonth,
  groupByRepoPr,
  serializeFeatureUsage,
  serializeReview,
  type ApiEnv,
} from '../api-support.ts';

export function registerUsageReviewRoutes(app: Hono<ApiEnv>) {
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
    const evidence = await listReviewFileEvidenceForReviews(reviews.map((review) => review.id));
    return c.json<ApiReviewsPage>({
      total,
      page,
      pages,
      reviews: reviews.map((review) => serializeReview(review, evidence)),
    });
  });

  app.get('/review-quality', async (c) => {
    const { installationIds } = c.get('user');
    return c.json(await reviewQualityDashboard(installationIds));
  });

  app.patch('/review-findings/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.json<{ feedback?: unknown }>().catch(() => null);
    const feedback = body?.feedback;
    if (!Number.isInteger(id) || id <= 0 || !isString(feedback)) {
      return c.json({ error: 'invalid finding feedback' }, 400);
    }
    let parsedFeedback: ReviewFindingFeedback;
    switch (feedback) {
      case 'useful':
      case 'false_positive':
      case 'fixed':
      case 'dismissed':
        parsedFeedback = feedback;
        break;
      default:
        return c.json({ error: 'invalid finding feedback' }, 400);
    }
    const { installationIds, session } = c.get('user');
    const updated = await setReviewFindingFeedback(
      id,
      installationIds,
      session.userId,
      parsedFeedback,
    );
    if (!updated) return c.json({ error: 'finding not found' }, 404);
    return c.json({ ok: true });
  });

  // Cheap live-poll target: a single-row change counter (0042 triggers) the
  // client checks every few seconds, refetching the real payloads only when
  // it moves — instead of rebuilding board/task/feature responses per poll.
  app.get('/factory/version', async (c) => {
    return c.json({ v: await factoryVersion() });
  });
}
