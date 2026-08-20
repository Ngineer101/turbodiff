import { githubRequest as gh } from '../../integrations/github/client.ts';

// Turns a failed GitHub Actions workflow run into the same markdown "findings"
// shape the fixer already consumes from a blocking review (fixer.ts's
// latestBlockingFindings) or a verification report (verifier.ts).

const MAX_FAILED_JOBS = 5;
const MAX_LOG_CHARS = 8_000;

interface JobsResponse {
  jobs: { id: number; name: string; conclusion: string | null }[];
}

// Tail, not head: unlike a diff or file (where the interesting part is near
// the top), a CI log's actual error is almost always its last lines.
async function jobLogTail(
  token: string,
  owner: string,
  repo: string,
  jobId: number,
): Promise<string> {
  try {
    const res = await gh(token, `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
    const log = await res.text();
    return log.slice(-MAX_LOG_CHARS);
  } catch (err) {
    return `_logs unavailable: ${err instanceof Error ? err.message : String(err)}_`;
  }
}

export async function ciFailureFindings(
  token: string,
  owner: string,
  repo: string,
  runId: number,
): Promise<string | null> {
  // SAFETY: gh() throws on non-2xx, and GitHub's "list jobs for a workflow
  // run" response always carries a jobs array with id, name, and a nullable
  // conclusion per job.
  const { jobs } = (await (
    await gh(token, `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`)
  ).json()) as JobsResponse;
  const failed = jobs.filter((j) => j.conclusion === 'failure').slice(0, MAX_FAILED_JOBS);
  if (failed.length === 0) return null;

  const sections = await Promise.all(
    failed.map(async (job) => {
      const log = await jobLogTail(token, owner, repo, job.id);
      return `### Job: ${job.name}\n\`\`\`\n${log}\n\`\`\``;
    }),
  );
  return [`**P1** — CI failed on this pull request.`, ...sections].join('\n\n');
}
