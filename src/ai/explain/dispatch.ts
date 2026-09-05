import { dispatch } from '@flue/runtime';
import {
  failExplanation,
  getChangeRequest,
  type FeatureRow,
  type RepositoryRow,
} from '../../data/db.ts';
import { explanationRequestBody } from '../../domain/explain.ts';
import { loadFeatureDiff } from '../../services/feature-diff.ts';
import { Explainer } from '../agents/explainer.ts';

// Application boundary for the Explain tab: loads the same diff snapshot the
// cockpit renders, hands it to the Explainer agent, and fails the admitted
// row when the dispatch itself cannot happen (the agent's own failures are
// settled by the metering observer). Routes only call this.
export async function dispatchExplain(
  feature: FeatureRow,
  repo: RepositoryRow,
  headSha: string,
  instanceId: string,
  model: string,
): Promise<void> {
  try {
    const artifactsCr =
      repo.provider === 'artifacts' && feature.change_request_id
        ? await getChangeRequest(feature.change_request_id)
        : null;
    const diff = await loadFeatureDiff(feature, repo, artifactsCr, headSha);
    if (diff.files.length === 0) throw new Error('the change has no files to explain');
    await dispatch(Explainer, {
      id: instanceId,
      message: {
        kind: 'signal',
        type: 'explain.request',
        tagName: 'explain-request',
        attributes: {
          model,
          feature_id: String(feature.id),
          head_sha: headSha,
          paths: diff.files.map((file) => file.filename).join('\n'),
        },
        body: explanationRequestBody(feature.title, diff.files, headSha),
      },
    });
  } catch (error) {
    console.error(`turbodiff: explain dispatch failed for ${instanceId}:`, error);
    await failExplanation(
      instanceId,
      `dispatch failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
    );
  }
}
