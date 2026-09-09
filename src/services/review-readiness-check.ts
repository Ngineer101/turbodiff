import { env } from 'cloudflare:workers';
import {
  getChange,
  getFactoryRun,
  getRepoById,
  getStageRun,
  reviewStageEvidence,
} from '../data/db.ts';
import { reviewReadinessReport } from '../domain/review-readiness.ts';
import { installationToken } from '../integrations/github/app.ts';
import { githubRequest as gh } from '../integrations/github/client.ts';

export const REVIEW_READINESS_CHECK_NAME = 'Turbodiff / Review readiness';

export async function publishReviewReadinessCheckForStage(stageRunId: number): Promise<void> {
  const stage = await getStageRun(stageRunId);
  if (!stage || stage.stage !== 'review' || !stage.change_id) return;
  const [run, change, evidence] = await Promise.all([
    getFactoryRun(stage.factory_run_id),
    getChange(stage.change_id),
    reviewStageEvidence(stageRunId),
  ]);
  if (!run || !change || !change.provider_key.startsWith('github:') || !change.source_head) return;
  if (!change.capabilities.includes('publish_check')) return;
  const repo = await getRepoById(run.repository_id);
  if (!repo) return;

  const heads = [...new Set(evidence.map((item) => item.head_sha).filter(Boolean))];
  if (heads.length !== 1) throw new Error('review evidence does not resolve to one GitHub head');
  const headSha = heads[0]!;
  const report = reviewReadinessReport(
    evidence.map((item) => ({
      agentSlug: item.agent_slug,
      status: item.status,
      conclusion: item.conclusion,
      coveredFileCount: item.covered_file_count,
      reviewableFileCount: item.reviewable_file_count,
      missingPaths: item.missing_paths,
      findingsCount: item.findings_count,
      error: item.error,
    })),
  );
  const token = await installationToken(repo.installation_id);
  const externalId = `review-readiness:${repo.id}:${change.number}:${headSha}`;
  const base = `/repos/${repo.owner}/${repo.name}`;
  const current = await gh(
    token,
    `${base}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(REVIEW_READINESS_CHECK_NAME)}&per_page=100`,
  ).then((response) =>
    response.json<{
      check_runs: { id: number; external_id: string | null; name: string }[];
    }>(),
  );
  const existing = current.check_runs.find(
    (check) => check.external_id === externalId && check.name === REVIEW_READINESS_CHECK_NAME,
  );
  const body = {
    name: REVIEW_READINESS_CHECK_NAME,
    external_id: externalId,
    details_url: `${env.PUBLIC_BASE_URL}/reviews`,
    status: 'completed',
    conclusion: report.checkConclusion,
    output: { title: report.title, summary: report.summary, text: report.text || undefined },
  };
  await gh(token, existing ? `${base}/check-runs/${existing.id}` : `${base}/check-runs`, {
    method: existing ? 'PATCH' : 'POST',
    body: JSON.stringify(existing ? body : { ...body, head_sha: headSha }),
  });
}
