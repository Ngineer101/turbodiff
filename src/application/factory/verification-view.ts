import { verificationEvidenceSchema } from '../../artifacts/verification.ts';
import { getArtifact } from '../../data/artifacts.ts';
import { latestVerificationEvent } from '../../data/delivery-lifecycle.ts';
import { isJsonObject, isNumber } from '../../shared/json.ts';
import { loadJsonArtifact } from '../artifacts.ts';

export async function changeVerification(
  changeId: number,
  revisionId: number,
  organizationId: string,
) {
  const event = await latestVerificationEvent(changeId, revisionId);
  if (!event || !isJsonObject(event.payload) || !isNumber(event.payload.artifactId)) return null;
  const artifact = await getArtifact(event.payload.artifactId);
  if (
    !artifact ||
    artifact.organization_id !== organizationId ||
    artifact.kind !== 'verification_evidence'
  )
    return null;
  const value = await loadJsonArtifact(artifact, verificationEvidenceSchema);
  return {
    artifactId: artifact.id,
    headSha: value.headSha,
    verdict: value.verdict,
    summary: value.assessment.summary,
    criteria: value.assessment.criteria,
  };
}
