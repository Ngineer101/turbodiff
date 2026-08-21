import { env } from 'cloudflare:workers';
import { getChangeRequest, getRepoById, listAgentsForRepo } from '../../data/db.ts';
import {
  agentsForTier,
  computeRiskTierFromFiles,
  tierModelOverride,
  type RiskFileEntry,
} from '../../services/review-policy.ts';
import { dispatchReviewAgent } from './dispatch.ts';

// Native change-request review dispatch (docs/artifacts-provider.md): the
// same policy → same agents → same PrReviewer as the GitHub webhook path,
// with the risk tier computed from the CR's own file summary instead of the
// PR files API. Queue-driven ('cr_review' messages), so CR opening never
// waits on dispatch.
export async function dispatchNativeCrReviews(changeRequestId: number): Promise<void> {
  const cr = await getChangeRequest(changeRequestId);
  if (!cr || cr.status !== 'open') return;
  const repo = await getRepoById(cr.repository_id);
  if (!repo || repo.enabled !== 1) return;

  const enabled = (await listAgentsForRepo(repo)).filter((a) => a.enabled);
  if (enabled.length === 0) return;

  // SAFETY: change_requests.files is written only by refreshChangeRequest as
  // serialized CrFileChange[].
  const crFiles = cr.files
    ? (JSON.parse(cr.files) as {
        path: string;
        additions: number | null;
        deletions: number | null;
      }[])
    : [];
  const files: RiskFileEntry[] = crFiles.map((f) => ({
    filename: f.path,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
  const tier = computeRiskTierFromFiles(files);
  const agents = agentsForTier(tier, enabled);
  const modelOverride = tierModelOverride(tier);
  const cockpitUrl = cr.feature_id
    ? `${env.PUBLIC_BASE_URL}/factory/features/${cr.feature_id}`
    : `${env.PUBLIC_BASE_URL}/`;

  for (const agent of agents) {
    await dispatchReviewAgent(agent, repo, cr.number, cockpitUrl, 'cr_opened', {
      riskTier: tier,
      modelOverride,
      changeRequest: { id: cr.id, number: cr.number },
    });
  }
}
