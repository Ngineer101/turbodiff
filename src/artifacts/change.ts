import { z } from 'zod';

const artifactText = (maxLength: number) => z.string().trim().min(1).max(maxLength);

const changedRepositorySchema = z
  .object({
    kind: z.literal('repository-change'),
    summary: artifactText(20_000),
    notes: artifactText(20_000).nullable().default(null),
  })
  .strict();

const unchangedRepositorySchema = z
  .object({ kind: z.literal('no-change'), summary: artifactText(20_000).optional() })
  .strict();

// The semantic result of a repository-writing agent. Git state determines
// which variant exists; usage, sessions, commits, and pull requests belong to
// execution and orchestration rather than this artifact.
export const repositoryChangeArtifactSchema = z.discriminatedUnion('kind', [
  changedRepositorySchema,
  unchangedRepositorySchema,
]);

export type RepositoryChangeArtifact = z.infer<typeof repositoryChangeArtifactSchema>;

const changeRevisionFileSchema = z
  .object({
    path: artifactText(1_000),
    reviewable: z.boolean(),
    omittedReason: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const changeRevisionArtifactSchema = z
  .object({
    kind: z.literal('change-revision'),
    title: artifactText(2_000),
    description: z.string().max(100_000),
    base: artifactText(1_000),
    head: artifactText(1_000),
    baseSha: artifactText(128),
    headSha: artifactText(128),
    files: z.array(changeRevisionFileSchema).max(2_000),
    patch: z.string().max(10_000_000),
  })
  .strict();

export type ChangeRevisionArtifact = z.infer<typeof changeRevisionArtifactSchema>;
