import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import { reviewerAgent, reviewerInputSchema } from '../../agents/reviewer.ts';
import { runAgent } from '../../agents/run.ts';
import { reviewArtifactSchema } from '../../artifacts/review.ts';
import {
  addReviewUsageById,
  getRepoById,
  getReviewRunGuard,
  listEnabledSkillsForRepo,
  listRepoConnections,
  recordReviewFileAcknowledgements,
  recordReviewFindingsById,
} from '../../data/db.ts';
import { planReviewPublication } from '../../domain/review-publication.ts';
import { readArtifact, writeArtifact } from '../../integrations/artifact-store.ts';
import { remoteSourceOf, resolveWorkspaceRemote } from '../../integrations/git/provider.ts';
import { loadArtifactsReviewSource, publishArtifactsReview } from '../../integrations/reviews/artifacts.ts';
import { loadGithubReviewSource, publishGithubReview } from '../../integrations/reviews/github.ts';
import type { ReviewPublication } from '../../integrations/reviews/types.ts';
import { buildSandboxMcpConfig } from '../../services/mcp-proxy.ts';
import { completeLifecycleReviewById, failLifecycleReviewById } from '../../services/lifecycle.ts';
import { mountSkills } from '../runtime/skills.ts';
import { redactSecrets } from '../runtime/redaction.ts';
import { prepareCachedWorktree } from '../runtime/repository-workspace.ts';
import { resolveRunnerAuth } from '../runtime/runner-auth.ts';
import { reviewSandbox } from '../runtime/sandbox.ts';
import { runStructuredAgent } from '../runtime/structured-agent.ts';
import { prepareReviewWorkspace } from '../runtime/review-workspace.ts';
import { reviewWorkspacePath } from '../runtime/review-workspace-policy.ts';

const reviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), number: z.number().int().positive() }).strict(),
  z
    .object({
      kind: z.literal('artifacts'),
      number: z.number().int().positive(),
      changeRequestId: z.number().int().positive(),
    })
    .strict(),
]);

export const reviewWorkflowParamsSchema = z
  .object({
    reviewId: z.number().int().positive(),
    repositoryId: z.number().int().positive(),
    expectedRevision: z.string().regex(/^[0-9a-f]{40}$/i),
    model: z.string().trim().min(1),
    focus: z
      .object({ name: z.string().trim().min(1), instructions: z.string().trim().min(1) })
      .strict(),
    changedSincePreviousReview: z
      .object({
        revision: z.string().trim().min(1),
        paths: z.array(z.string().trim().min(1).max(1_000)).max(2_000),
      })
      .strict()
      .nullable(),
    target: reviewTargetSchema,
  })
  .strict();

export type ReviewWorkflowParams = z.infer<typeof reviewWorkflowParamsSchema>;

type PreparedReview = {
  workDir: string;
  cacheDir: string | null;
  patchFile: string;
  inputArtifactKey: string;
  outputArtifactKey: string;
  repository: { owner: string; name: string };
  blockingReviews: boolean;
};

const QUICK = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;
const PAID = { retries: { limit: 0, delay: '1 second' }, timeout: '30 minutes' } as const;
const PUBLISH = { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' } as const;
const AGENT_TIMEOUT_MS = 27 * 60_000;

function inputArtifactKey(reviewId: number): string {
  return `agent-artifacts/reviews/${reviewId}/input.json`;
}

function outputArtifactKey(reviewId: number): string {
  return `agent-artifacts/reviews/${reviewId}/output.json`;
}

function patchFile(reviewId: number): string {
  return `/workspace/review-${reviewId}.patch`;
}

function promptFile(reviewId: number): string {
  return `/workspace/review-${reviewId}.md`;
}

function outputFile(reviewId: number): string {
  return `/workspace/review-${reviewId}.json`;
}

export class ReviewWorkflow extends WorkflowEntrypoint<unknown, ReviewWorkflowParams> {
  async run(event: WorkflowEvent<ReviewWorkflowParams>, step: WorkflowStep): Promise<string> {
    const params = reviewWorkflowParamsSchema.parse(event.payload);
    try {
      const prepared = await step.do('prepare review context', QUICK, async (): Promise<PreparedReview> => {
        const repo = await getRepoById(params.repositoryId);
        if (!repo || !repo.enabled) {
          throw new NonRetryableError(`repository ${params.repositoryId} is missing or disabled`);
        }
        const delta = params.changedSincePreviousReview;
        let source;
        let workDir: string;
        let cacheDir: string | null = null;
        if (params.target.kind === 'github') {
          if (repo.provider !== 'github') {
            throw new NonRetryableError('GitHub review target does not match repository provider');
          }
          source = await loadGithubReviewSource(
            repo,
            params.target.number,
            params.expectedRevision,
            params.focus,
            delta,
          );
          if (!source) throw new NonRetryableError('review became stale before context preparation');
          workDir = (
            await prepareReviewWorkspace(
              repo,
              params.target.number,
              params.expectedRevision,
              `review-${params.reviewId}`,
            )
          ).workDir;
        } else {
          if (repo.provider !== 'artifacts') {
            throw new NonRetryableError('Artifacts review target does not match repository provider');
          }
          const loaded = await loadArtifactsReviewSource(
            repo,
            params.target.changeRequestId,
            params.expectedRevision,
            params.focus,
            delta,
          );
          if (!loaded) throw new NonRetryableError('review became stale before context preparation');
          source = loaded.source;
          workDir = reviewWorkspacePath(`review-${params.reviewId}`);
          cacheDir = `/workspace/review-cache-${params.reviewId}`;
          await prepareCachedWorktree({
            sandbox: reviewSandbox(repo),
            cacheDir,
            workDir,
            remote: await resolveWorkspaceRemote(remoteSourceOf(repo), 'read'),
            base: loaded.changeRequest.source_branch,
          });
        }

        const sandbox = reviewSandbox(repo);
        const patch = patchFile(params.reviewId);
        await sandbox.writeFile(patch, source.patch);
        const inputKey = inputArtifactKey(params.reviewId);
        await writeArtifact(inputKey, reviewerInputSchema, source.input);
        return {
          workDir,
          cacheDir,
          patchFile: patch,
          inputArtifactKey: inputKey,
          outputArtifactKey: outputArtifactKey(params.reviewId),
          repository: { owner: repo.owner, name: repo.name },
          blockingReviews: repo.blocking_reviews,
        };
      });

      await step.do('run reviewer agent', PAID, async () => {
        const input = await readArtifact(prepared.inputArtifactKey, reviewerInputSchema);
        const repo = await getRepoById(params.repositoryId);
        if (!repo) throw new NonRetryableError(`repository ${params.repositoryId} was removed`);
        let usageRecorded = false;
        const artifact = await runAgent(reviewerAgent, input, {
          model: params.model,
          execute: async (request, output) => {
            if (request.agentId !== reviewerAgent.id || request.repositoryAccess !== 'read') {
              throw new Error('review executor only accepts the read-only reviewer');
            }
            const auth = await resolveRunnerAuth(request.model);
            const connections = await listRepoConnections(params.repositoryId, 'reviews');
            const mcp = await buildSandboxMcpConfig(connections, params.repositoryId);
            const secrets = [...Object.values(auth.vars), ...(mcp?.secrets ?? [])];
            const scrub = (value: string) => redactSecrets(value, secrets);
            const sandbox = reviewSandbox(prepared.repository);
            await mountSkills(
              sandbox,
              prepared.workDir,
              await listEnabledSkillsForRepo(params.repositoryId),
            );
            const result = await runStructuredAgent({
              sandbox,
              auth,
              request,
              output,
              cwd: prepared.workDir,
              promptFile: promptFile(params.reviewId),
              artifactFile: outputFile(params.reviewId),
              timeout: AGENT_TIMEOUT_MS,
              configExtensionJson: mcp?.configJson,
              sanitize: scrub,
              runtimeContext:
                `The repository is checked out at the exact revision under review. ` +
                `The complete filtered unified patch is at ${prepared.patchFile}. ` +
                'You may inspect and search the checkout, but must not modify it.',
              onComplete: async (run) => {
                await env.ARTIFACTS.put(
                  `logs/review/${params.reviewId}.log`,
                  scrub(`${run.resultText}\n${run.stderr}`.trim()),
                  { httpMetadata: { contentType: 'text/plain; charset=utf-8' } },
                );
                await env.ARTIFACTS.put(
                  `logs/review/${params.reviewId}.transcript.jsonl`,
                  scrub(run.stdout),
                  { httpMetadata: { contentType: 'application/x-ndjson' } },
                );
                if (run.usage) {
                  await addReviewUsageById(params.reviewId, {
                    ...run.usage,
                    model: run.usage.model ?? auth.model,
                  });
                  usageRecorded = true;
                }
              },
            });
            const status = await sandbox.exec('git status --porcelain', {
              cwd: prepared.workDir,
              timeout: 30_000,
            });
            if (!status.success) throw new Error('could not verify the read-only review workspace');
            if (status.stdout.trim()) {
              await sandbox.exec('git reset --hard -q HEAD && git clean -ffdq', {
                cwd: prepared.workDir,
                timeout: 30_000,
              });
              throw new Error('read-only reviewer modified the repository');
            }
            return result.artifact;
          },
        });
        await writeArtifact(prepared.outputArtifactKey, reviewArtifactSchema, artifact);
        return { artifactKey: prepared.outputArtifactKey, usageRecorded };
      });

      const publication = await step.do(
        'publish review artifact',
        PUBLISH,
        async (): Promise<ReviewPublication> => {
          const guard = await getReviewRunGuard(params.reviewId);
          if (
            !guard ||
            guard.status !== 'running' ||
            guard.repository_id !== params.repositoryId ||
            guard.pr_number !== params.target.number ||
            guard.head_sha !== params.expectedRevision
          ) {
            throw new NonRetryableError('the exact review run is no longer active');
          }
          const repo = await getRepoById(params.repositoryId);
          if (!repo) throw new NonRetryableError(`repository ${params.repositoryId} was removed`);
          const input = await readArtifact(prepared.inputArtifactKey, reviewerInputSchema);
          const artifact = await readArtifact(prepared.outputArtifactKey, reviewArtifactSchema);
          const plan = planReviewPublication(input, artifact, prepared.blockingReviews);
          return params.target.kind === 'github'
            ? publishGithubReview(
                repo,
                params.target.number,
                params.expectedRevision,
                params.focus.name,
                plan,
              )
            : publishArtifactsReview(
                params.target.changeRequestId,
                params.expectedRevision,
                params.focus.name,
                plan,
              );
        },
      );

      await step.do('record review artifact', QUICK, async () => {
        const input = await readArtifact(prepared.inputArtifactKey, reviewerInputSchema);
        const artifact = await readArtifact(prepared.outputArtifactKey, reviewArtifactSchema);
        const plan = planReviewPublication(input, artifact, prepared.blockingReviews);
        await recordReviewFileAcknowledgements(params.reviewId, artifact.fileEvidence);
        if (publication.kind === 'stale') {
          await completeLifecycleReviewById(params.reviewId, null, 0, 'comment', [], undefined, {
            conclusion: 'inconclusive',
            coverageStatus: 'stale',
            reviewableFileCount: plan.readiness.reviewableFileCount,
            coveredFileCount: 0,
            missingPaths: input.change.files
              .filter((file) => file.reviewable)
              .map((file) => file.path),
            coverageHeadSha: params.expectedRevision,
            publishedHeadSha: null,
          });
          return;
        }
        await recordReviewFindingsById(params.reviewId, plan.findings);
        await completeLifecycleReviewById(
          params.reviewId,
          publication.url,
          plan.findings.length,
          plan.verdict,
          [...new Set(plan.findings.map((finding) => finding.path))],
          undefined,
          plan.readiness,
        );
      });

      await step.do('clean review workspace', QUICK, async () => {
        const sandbox = reviewSandbox(prepared.repository);
        await sandbox.exec(
          `rm -rf ${prepared.workDir} ${prepared.patchFile} ${promptFile(params.reviewId)} ${outputFile(params.reviewId)}` +
            (prepared.cacheDir ? ` ${prepared.cacheDir}` : ''),
        );
      });

      return publication.kind;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      await step.do('record review failure', QUICK, async () => {
        await failLifecycleReviewById(params.reviewId, reason);
        if (params.target.kind === 'artifacts') {
          const { upsertCrCheck } = await import('../../data/db.ts');
          await upsertCrCheck(
            params.target.changeRequestId,
            'review',
            'error',
            'review failed — re-run from the cockpit',
          );
        }
      });
      console.error(`turbodiff: review workflow ${params.reviewId} failed:`, error);
      return 'failed';
    }
  }
}

export async function startReviewWorkflow(params: ReviewWorkflowParams): Promise<void> {
  const parsed = reviewWorkflowParamsSchema.parse(params);
  await env.REVIEW_WORKFLOW.create({ id: `review-${parsed.reviewId}`, params: parsed });
}
