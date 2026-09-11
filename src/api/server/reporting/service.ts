import { Context, Effect, Layer } from 'effect';
import {
  agentUsageForMonth,
  automationUsageForMonth,
  dashboardStats,
  factoryVersion,
  listFixAttemptsForRepoPrs,
  listInstallationsWithRepos,
  listRecentFeaturesForUsage,
  listReviewsForRepoPrs,
  listVerificationsForFeatures,
  monthlyUsage,
  pipelineCostByMonth,
  pipelineCostForMonth,
  repoUsageForMonth,
  type VerificationRow,
} from '../../../data/db.ts';
import { groupByRepoPr, serializeFeatureUsage } from './serialization.ts';
import type { CurrentUserIdentity } from '../../contract/auth.ts';
import type { UsageSummary } from '../../contract/reporting.ts';
import { internalServerError, type DomainError } from '../../contract/errors.ts';

export interface ReportingOperations {
  readonly usage: (user: CurrentUserIdentity) => Effect.Effect<UsageSummary, DomainError>;
  readonly factoryState: () => Effect.Effect<{ version: number }, DomainError>;
}

export class ReportingService extends Context.Tag('Turbodiff/ReportingService')<
  ReportingService,
  ReportingOperations
>() {}

const dataEffect = <A>(operation: () => Promise<A>): Effect.Effect<A, DomainError> =>
  Effect.tryPromise({
    try: operation,
    catch: (error) => {
      console.error('turbodiff: Effect reporting operation failed', error);
      return internalServerError();
    },
  });

const monthNow = () => new Date().toISOString().slice(0, 7);

export const ReportingServiceLive = Layer.succeed(ReportingService, {
  usage: (user) =>
    Effect.gen(function* () {
      const month = monthNow();
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
      ] = yield* dataEffect(() =>
        Promise.all([
          dashboardStats(user.installationIds),
          monthlyUsage(user.installationIds, 6),
          repoUsageForMonth(user.installationIds, month),
          agentUsageForMonth(user.installationIds, month),
          listInstallationsWithRepos(user.installationIds),
          listRecentFeaturesForUsage(user.installationIds),
          automationUsageForMonth(user.installationIds, month),
          pipelineCostForMonth(user.installationIds, month),
          pipelineCostByMonth(user.installationIds, 6),
        ]),
      );
      const pairs = features
        .filter((feature) => feature.pr_number !== null)
        .map((feature) => ({
          repositoryId: feature.repository_id,
          prNumber: feature.pr_number!,
        }));
      const [reviews, fixes, verifications] = yield* dataEffect(() =>
        Promise.all([
          listReviewsForRepoPrs(pairs),
          listFixAttemptsForRepoPrs(pairs),
          listVerificationsForFeatures(features.map((feature) => feature.id)),
        ]),
      );
      const reviewsByPullRequest = groupByRepoPr(reviews);
      const fixesByPullRequest = groupByRepoPr(fixes);
      const verificationsByFeature = new Map<number, VerificationRow[]>();
      for (const verification of verifications) {
        const rows = verificationsByFeature.get(verification.feature_id) ?? [];
        rows.push(verification);
        verificationsByFeature.set(verification.feature_id, rows);
      }
      const legacyFeatures = yield* dataEffect(() =>
        Promise.all(
          features.map((feature) => {
            const key =
              feature.pr_number === null ? null : `${feature.repository_id}:${feature.pr_number}`;
            return serializeFeatureUsage(
              feature,
              key ? (reviewsByPullRequest.get(key) ?? []) : [],
              key ? (fixesByPullRequest.get(key) ?? []) : [],
              verificationsByFeature.get(feature.id) ?? [],
            );
          }),
        ),
      );
      const usageByRepository = new Map(repoUsage.map((row) => [row.repository_id, row]));
      const reviewsByMonth = new Map(reviewMonthly.map((row) => [row.month, row]));
      const recentRepositories = groups
        .flatMap(({ installation, repos }) =>
          repos.map((repository) => ({ installation, repository })),
        )
        .sort((left, right) =>
          right.repository.created_at.localeCompare(left.repository.created_at),
        )
        .slice(0, 5);
      return {
        month,
        metrics: {
          reviews: stats.month_reviews,
          reviewCostUsd: stats.month_cost_usd,
          pipelineCostUsd: pipelineCost,
          tokens: stats.month_tokens,
          averageDurationSeconds: stats.avg_duration_s,
          averageFindings: stats.avg_findings,
          running: stats.running,
        },
        months: pipelineMonths.map((row) => ({
          month: row.month,
          reviews: reviewsByMonth.get(row.month)?.reviews ?? 0,
          totalTokens: reviewsByMonth.get(row.month)?.total_tokens ?? 0,
          pipelineCostUsd: row.cost_usd,
        })),
        agents: agentUsage.map((row) => ({
          agentSlug: row.agent_slug,
          reviews: row.reviews,
          costUsd: row.cost_usd,
        })),
        repositoryCount: groups.reduce((count, group) => count + group.repos.length, 0),
        enabledRepositoryCount: groups.reduce(
          (count, group) => count + group.repos.filter((repository) => repository.enabled).length,
          0,
        ),
        recentRepositories: recentRepositories.map(({ installation, repository }) => {
          const usage = usageByRepository.get(repository.id);
          return {
            id: repository.id,
            owner: repository.owner,
            name: repository.name,
            enabled: repository.enabled,
            suspended: installation.suspended,
            reviews: usage?.reviews ?? 0,
            costUsd: usage?.cost_usd ?? 0,
          };
        }),
        features: legacyFeatures.map((feature) => ({
          id: feature.id,
          title: feature.title,
          repository: feature.repo,
          status: feature.status,
          pullRequestNumber: feature.pr_number,
          pullRequestUrl: feature.pr_url,
          createdAt: feature.created_at,
          totalCostUsd: feature.total_cost_usd,
          totalTokens: feature.total_tokens,
          sessions: feature.sessions.map((session) => ({
            kind: session.kind,
            label: session.label,
            status: session.status,
            costUsd: session.cost_usd,
            totalTokens: session.total_tokens,
            durationSeconds: session.duration_s,
            createdAt: session.created_at,
            url: session.url,
          })),
        })),
        automations: automationUsage.map((row) => ({
          automationId: row.automation_id,
          name: row.name,
          repository: `${row.repo_owner}/${row.repo_name}`,
          runs: row.runs,
          costUsd: row.cost_usd,
        })),
      };
    }),
  factoryState: () => dataEffect(factoryVersion).pipe(Effect.map((version) => ({ version }))),
} satisfies ReportingOperations);
