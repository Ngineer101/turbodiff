import { githubJson, githubRequest } from '../../integrations/github/client.ts';
import { installationToken } from '../../integrations/github/app.ts';

export async function fetchPushablePrHead(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ headRef: string; headRepo: string }> {
  const pr = await githubJson<{
    head: { ref: string; repo: { full_name: string } | null };
    base: { repo: { full_name: string } };
  }>(token, `/repos/${owner}/${repo}/pulls/${prNumber}`);
  const headRepo = pr.head.repo?.full_name;
  if (!headRepo || headRepo.toLowerCase() !== pr.base.repo.full_name.toLowerCase()) {
    throw new Error('factory runners only support same-repo PR branches');
  }
  return { headRef: pr.head.ref, headRepo };
}

// A factory PR with more than 1,000 changed files is outside the supported
// automation budget. Beyond that bound, retain the conservative existing
// behavior and do not grant workflow-file push permission.
export async function prTouchesWorkflowFiles(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  for (let page = 1; page <= 10; page++) {
    const files = await githubJson<{ filename: string; previous_filename?: string }[]>(
      token,
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    if (
      files.some(
        (file) =>
          file.filename.startsWith('.github/workflows/') ||
          file.previous_filename?.startsWith('.github/workflows/'),
      )
    ) {
      return true;
    }
    if (files.length < 100) break;
  }
  return false;
}

export async function postFixHandoffComment(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  attempts: number,
): Promise<void> {
  try {
    const token = await installationToken(installationId);
    await githubRequest(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body:
          `🔧 Turbodiff auto-fix stopped: ${attempts} fix attempts have run on this PR (the cap) ` +
          `and the latest review still requests changes. A human should take over — see the fix ` +
          `commits and review threads above for what was attempted and what remains open.`,
      }),
    });
  } catch (error) {
    console.error('turbodiff: handoff comment failed:', error);
  }
}
