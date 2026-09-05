import type { ChangeRequestRow } from '../data/change-requests.ts';
import type { FeatureRow } from '../data/factory.ts';
import type { RepositoryRow } from '../data/repositories.ts';
import { installationToken } from '../integrations/github/app.ts';
import { githubJsonCached } from '../integrations/github/client.ts';
import type { ApiFeatureDiff } from '../shared/api-types.ts';
import { changeRequestFiles, getCrDiffPatch, splitPatchByFile } from './change-requests.ts';

// The cockpit's diff snapshot for a feature's change — per-file pseudo-patches
// ready for @pierre/diffs. Shared by the diff route (what the reviewer sees)
// and the Explain dispatcher (what the model explains), so both describe the
// same files at the same cap.

export const DIFF_MAX_FILES = 50;
const PATCH_MAX_CHARS = 100_000;

export async function loadFeatureDiff(
  feature: FeatureRow,
  repo: RepositoryRow,
  artifactsCr: ChangeRequestRow | null,
  requestedVersion: string | null,
): Promise<ApiFeatureDiff> {
  const diffVersion = artifactsCr?.source_head ?? requestedVersion;
  const empty: ApiFeatureDiff = { version: diffVersion, files: [], more_files: 0 };
  if (!feature.pr_number) return empty;

  if (repo.provider === 'artifacts') {
    if (!artifactsCr) return empty;
    const patchByPath = new Map(
      splitPatchByFile(await getCrDiffPatch(artifactsCr)).map((file) => [file.path, file.patch]),
    );
    const crFiles = changeRequestFiles(artifactsCr);
    return {
      version: artifactsCr.source_head,
      files: crFiles.slice(0, DIFF_MAX_FILES).map((file) => {
        const patch = patchByPath.get(file.path);
        return {
          filename: file.path,
          status: file.status,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          patch: patch && patch.length < PATCH_MAX_CHARS ? patch : null,
        };
      }),
      more_files: Math.max(0, crFiles.length - DIFF_MAX_FILES),
    };
  }

  const token = await installationToken(repo.installation_id);
  const files = await githubJsonCached<
    {
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }[]
  >(token, `/repos/${repo.owner}/${repo.name}/pulls/${feature.pr_number}/files?per_page=100`);
  return {
    version: requestedVersion,
    files: files.slice(0, DIFF_MAX_FILES).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch:
        file.patch && file.patch.length < PATCH_MAX_CHARS
          ? `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n`
          : null,
    })),
    more_files: Math.max(0, files.length - DIFF_MAX_FILES),
  };
}
