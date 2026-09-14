import { describe, expect, it } from 'vite-plus/test';
import { changeRevisionArtifactSchema, repositoryChangeArtifactSchema } from '../change.ts';

describe('repository change artifacts', () => {
  it('requires a reviewable summary when repository files changed', () => {
    expect(() => repositoryChangeArtifactSchema.parse({ kind: 'repository-change' })).toThrow();
    expect(
      repositoryChangeArtifactSchema.parse({
        kind: 'repository-change',
        summary: 'Update the task selector.',
      }),
    ).toEqual({
      kind: 'repository-change',
      summary: 'Update the task selector.',
      notes: null,
    });
  });

  it('represents a clean working tree without fabricated output', () => {
    expect(repositoryChangeArtifactSchema.parse({ kind: 'no-change' })).toEqual({
      kind: 'no-change',
    });
  });

  it('captures the exact immutable revision consumed by review', () => {
    expect(
      changeRevisionArtifactSchema.parse({
        kind: 'change-revision',
        title: 'Update the task selector',
        description: 'Use organization-scoped work items.',
        base: 'main',
        head: 'turbodiff/delivery-1-task-selector',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        files: [{ path: 'src/task.ts', reviewable: true, omittedReason: null }],
        patch: 'diff --git a/src/task.ts b/src/task.ts',
      }),
    ).toMatchObject({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) });
  });
});
