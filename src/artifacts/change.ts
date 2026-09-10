import { z } from 'zod';

const artifactText = (maxLength: number) => z.string().trim().min(1).max(maxLength);

const changedRepositorySchema = z
  .object({
    kind: z.literal('repository-change'),
    summary: artifactText(20_000),
    notes: artifactText(20_000).nullable().default(null),
  })
  .strict();

const unchangedRepositorySchema = z.object({ kind: z.literal('no-change') }).strict();

// The semantic result of a repository-writing agent. Git state determines
// which variant exists; usage, sessions, commits, and pull requests belong to
// execution and orchestration rather than this artifact.
export const repositoryChangeArtifactSchema = z.discriminatedUnion('kind', [
  changedRepositorySchema,
  unchangedRepositorySchema,
]);

export type RepositoryChangeArtifact = z.infer<typeof repositoryChangeArtifactSchema>;
