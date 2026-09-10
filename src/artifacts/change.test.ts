import { describe, expect, it } from 'vite-plus/test';
import { repositoryChangeArtifactSchema } from './change.ts';

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
});
