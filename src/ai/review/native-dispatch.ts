import { env } from 'cloudflare:workers';
import { cockpitFeatureUrl } from '../../services/urls.ts';
import {
  getChangeRequest,
  getInstallation,
  getRepoById,
  listAgentsForRepo,
  upsertCrCheck,
} from '../../data/db.ts';
import {
  agentsForTier,
  computeRiskTierFromFiles,
  remainingDailyBudget,
  tierModelOverride,
  type RiskFileEntry,
} from '../../services/review-policy.ts';
import { changeRequestFiles } from '../../services/change-requests.ts';
import { dispatchReviewAgent } from './dispatch.ts';

// Native change-request review dispatch (docs/artifacts-provider.md): the
// same policy → same agents → same PrReviewer as the GitHub webhook path,
// with the risk tier computed from the CR's own file summary instead of the
// PR files API. Queue-driven ('cr_review' messages), so CR opening never
// waits on dispatch.
export async function dispatchNativeCrReviews(
  changeRequestId: number,
  stageRunId?: number,
): Promise<boolean> {
  const cr = await getChangeRequest(changeRequestId);
  if (!cr || cr.status !== 'open') return false;
  const repo = await getRepoById(cr.repository_id);
  if (!repo?.enabled) return false;

  const installation = await getInstallation(repo.installation_id);
  if (!installation || installation.suspended) return false;

  const enabled = (await listAgentsForRepo(repo)).filter((a) => a.enabled);
  if (enabled.length === 0) return false;

  const files: RiskFileEntry[] = changeRequestFiles(cr).map((f) => ({
    filename: f.path,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
  const tier = computeRiskTierFromFiles(files);
  const modelOverride = tierModelOverride(tier);

  // Same admission control as the webhook path: each selected agent consumes
  // one unit of the installation's rolling daily cap.
  const budget = await remainingDailyBudget(repo.installation_id, installation.account_login);
  if (budget <= 0) return false;
  const agents = agentsForTier(tier, enabled).slice(0, budget);
  const cockpitUrl = cr.feature_id ? cockpitFeatureUrl(cr.feature_id) : `${env.PUBLIC_BASE_URL}/`;

  // Visible from the moment of dispatch — a review that dies before
  // post_review must not read as forever-polling in the cockpit.
  await upsertCrCheck(cr.id, 'review', 'running', `${agents.length} agent(s) dispatched`);
  let dispatched = 0;
  const options: Parameters<typeof dispatchReviewAgent>[5] = {
    riskTier: tier,
    modelOverride,
    changeRequest: { id: cr.id, number: cr.number },
    stageRunId,
  };
  if (cr.source_head) options.headSha = cr.source_head;
  for (const agent of agents) {
    const ok = await dispatchReviewAgent(agent, repo, cr.number, cockpitUrl, 'cr_opened', options);
    if (ok) dispatched += 1;
  }
  if (dispatched === 0) {
    await upsertCrCheck(
      cr.id,
      'review',
      'error',
      'review dispatch failed — re-run from the cockpit',
    );
  }
  return dispatched > 0;
}
