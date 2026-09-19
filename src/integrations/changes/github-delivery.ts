import { z } from 'zod';
import type { ChangeRow } from '../../data/changes.ts';
import type { RepositoryRow } from '../../data/repositories.ts';
import type { ChangeCheckRow } from '../../data/change-checks.ts';
import { installationToken } from '../github/app.ts';
import { githubJson, githubPaginate, githubRequest } from '../github/client.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const pullSchema = z.object({
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  head: z.object({ sha, ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
});
const checkSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  output: z.object({
    title: z.string().nullable(),
    summary: z.string().nullable(),
    text: z.string().nullable(),
  }),
});
const statusSchema = z.object({
  id: z.number(),
  context: z.string(),
  state: z.string(),
  description: z.string().nullable(),
  target_url: z.string().nullable(),
  updated_at: z.string(),
});
const workflowSchema = z.object({
  id: z.number(),
  workflow_id: z.number(),
  name: z.string().nullable(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  updated_at: z.string(),
});

const successfulConclusion = (conclusion: string | null) =>
  conclusion !== null && ['success', 'neutral', 'skipped'].includes(conclusion);

export interface GithubDeliveryState {
  headSha: string;
  status: 'open' | 'merged' | 'closed';
  writable: boolean;
  humanReviewBlocked: boolean;
  draft: boolean;
  mergeable: boolean | null;
  checks: ChangeCheckRow[];
  failureEvidence: string;
}
export async function readGithubDeliveryState(
  repository: RepositoryRow,
  change: ChangeRow,
  includeLogs = false,
): Promise<GithubDeliveryState> {
  const token = await installationToken(Number(repository.source_external_account_id));
  const root = `/repos/${repository.owner}/${repository.name}`;
  const pull = pullSchema.parse(await githubJson(token, `${root}/pulls/${change.number}`));
  const [checks, statuses, workflows, reviews] = await Promise.all([
    githubPaginate(
      token,
      `${root}/commits/${pull.head.sha}/check-runs?per_page=100&filter=latest`,
      (page) => z.object({ check_runs: z.array(checkSchema) }).parse(page).check_runs,
      { maxPages: 10 },
    ),
    githubPaginate(
      token,
      `${root}/commits/${pull.head.sha}/statuses?per_page=100`,
      (page) => z.array(statusSchema).parse(page),
      { maxPages: 10 },
    ),
    githubPaginate(
      token,
      `${root}/actions/runs?head_sha=${pull.head.sha}&per_page=100`,
      (page) => z.object({ workflow_runs: z.array(workflowSchema) }).parse(page).workflow_runs,
      { maxPages: 10 },
    ),
    githubPaginate(
      token,
      `${root}/pulls/${change.number}/reviews?per_page=100`,
      (page) =>
        z
          .array(
            z.object({
              id: z.number(),
              state: z.string(),
              user: z.object({ id: z.number(), type: z.string() }).nullable(),
            }),
          )
          .parse(page),
      { maxPages: 10 },
    ),
  ]);
  const humanReviews = new Map<number, { id: number; state: string }>();
  for (const review of reviews) {
    if (
      review.user?.type !== 'User' ||
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
    )
      continue;
    const prior = humanReviews.get(review.user.id);
    if (!prior || prior.id < review.id) humanReviews.set(review.user.id, review);
  }
  const now = new Date().toISOString();
  const latestStatuses = new Map<string, z.infer<typeof statusSchema>>();
  for (const status of statuses)
    if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status);
  const latestWorkflows = new Map<string, z.infer<typeof workflowSchema>>();
  for (const workflow of workflows) {
    const key = `${workflow.workflow_id}:${workflow.event}`;
    const previous = latestWorkflows.get(key);
    if (!previous || workflow.id > previous.id) latestWorkflows.set(key, workflow);
  }
  const rows: ChangeCheckRow[] = checks.map((check) => ({
    name: `check:${check.name}`,
    status: check.status === 'completed' ? 'completed' : 'running',
    conclusion: check.conclusion,
    details_url: check.html_url,
    updated_at: check.completed_at ?? check.started_at ?? now,
  }));
  rows.push(
    ...[...latestStatuses.values()].map((status) => ({
      name: `status:${status.context}`,
      status: status.state === 'pending' ? ('running' as const) : ('completed' as const),
      conclusion: status.state,
      details_url: status.target_url,
      updated_at: status.updated_at,
    })),
  );
  rows.push(
    ...[...latestWorkflows.values()].map((workflow) => ({
      name: `${workflow.name ?? 'GitHub Actions'} (workflow ${workflow.workflow_id}, ${workflow.event})`,
      status: workflow.status === 'completed' ? ('completed' as const) : ('running' as const),
      conclusion: workflow.conclusion,
      details_url: workflow.html_url,
      updated_at: workflow.updated_at,
    })),
  );
  const evidence = checks
    .filter((check) => check.status === 'completed' && !successfulConclusion(check.conclusion))
    .map(
      (check) =>
        `${check.name} (${check.conclusion ?? 'no conclusion'}): ${check.output.title ?? ''}\n${check.output.summary ?? ''}\n${check.output.text ?? ''}`,
    );
  evidence.push(
    ...[...latestStatuses.values()]
      .filter((status) => ['failure', 'error'].includes(status.state))
      .map((status) => `${status.context}: ${status.description ?? status.state}`),
  );
  evidence.push(
    ...[...latestWorkflows.values()]
      .filter(
        (workflow) => workflow.status === 'completed' && !successfulConclusion(workflow.conclusion),
      )
      .map(
        (workflow) =>
          `${workflow.name ?? 'GitHub Actions'}: ${workflow.conclusion ?? 'no conclusion'}; inspect ${workflow.html_url}`,
      ),
  );
  // Job logs explain failures such as dependency installation, which have no check annotations.
  for (const workflow of (includeLogs ? [...latestWorkflows.values()] : [])
    .filter((run) => run.conclusion === 'failure')
    .slice(0, 3)) {
    const jobs = z
      .object({
        jobs: z.array(
          z.object({ id: z.number(), name: z.string(), conclusion: z.string().nullable() }),
        ),
      })
      .parse(
        await githubJson(
          token,
          `${root}/actions/runs/${workflow.id}/jobs?filter=latest&per_page=100`,
        ),
      );
    for (const job of jobs.jobs.filter((job) => job.conclusion === 'failure').slice(0, 3)) {
      try {
        const response = await githubRequest(token, `${root}/actions/jobs/${job.id}/logs`);
        evidence.push(`${job.name}:\n${await logTail(response)}`);
      } catch {
        evidence.push(`${job.name}: logs unavailable; inspect ${workflow.html_url}`);
      }
    }
  }
  return {
    headSha: pull.head.sha,
    status: pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
    draft: pull.draft,
    mergeable: pull.mergeable,
    writable:
      pull.head.repo?.full_name.toLowerCase() ===
        `${repository.owner}/${repository.name}`.toLowerCase() &&
      pull.head.ref === change.source_ref,
    humanReviewBlocked: [...humanReviews.values()].some(
      (review) => review.state === 'CHANGES_REQUESTED',
    ),
    checks: rows,
    failureEvidence: evidence.join('\n\n').slice(-80_000),
  };
}

async function logTail(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let bytes = 0;
  try {
    while (bytes < 2_000_000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-24_000);
    }
    return tail + (bytes >= 2_000_000 ? '\n[Log truncated at 2 MB]' : '');
  } finally {
    await reader.cancel();
  }
}
