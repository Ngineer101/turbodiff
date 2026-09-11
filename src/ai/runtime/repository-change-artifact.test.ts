import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { repositoryChangeArtifactSchema } from '../../artifacts/change.ts';
import { readRepositoryChangeArtifact } from './repository-change-artifact.ts';

const outputFiles = {
  summary: '/workspace/summary.md',
  notes: '/workspace/notes.md',
};

function runtime(changed: boolean, files: ReadonlyMap<string, string>) {
  return {
    async exec() {
      return { success: true, stdout: changed ? ' M src/index.ts\n' : '', stderr: '' };
    },
    async readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return { content };
    },
  };
}

describe('repository change artifact runtime adapter', () => {
  it('uses git state for the no-change outcome without requiring output files', async () => {
    await expect(
      readRepositoryChangeArtifact(
        runtime(false, new Map()),
        '/workspace/repo',
        repositoryChangeArtifactSchema,
        outputFiles,
      ),
    ).resolves.toEqual({ kind: 'no-change' });
  });

  it('requires and trims a summary for a changed tree while keeping notes optional', async () => {
    await expect(
      readRepositoryChangeArtifact(
        runtime(true, new Map([[outputFiles.summary, '  Updated scheduling.  \n']])),
        '/workspace/repo',
        repositoryChangeArtifactSchema,
        outputFiles,
      ),
    ).resolves.toEqual({
      kind: 'repository-change',
      summary: 'Updated scheduling.',
      notes: null,
    });

    await expect(
      readRepositoryChangeArtifact(
        runtime(true, new Map()),
        '/workspace/repo',
        repositoryChangeArtifactSchema,
        outputFiles,
      ),
    ).rejects.toThrow(`implementer did not produce ${outputFiles.summary}`);
  });

  it('rejects a failed git status instead of reporting a clean tree', async () => {
    const failedRuntime = {
      async exec() {
        return { success: false, stdout: '', stderr: 'fatal: not a git repository' };
      },
      async readFile() {
        return { content: '' };
      },
    };

    await expect(
      readRepositoryChangeArtifact(
        failedRuntime,
        '/workspace/repo',
        repositoryChangeArtifactSchema,
        outputFiles,
      ),
    ).rejects.toThrow('git status failed: fatal: not a git repository');
  });

  it('uses an explicit orchestration fallback when the agent omitted its summary', async () => {
    await expect(
      readRepositoryChangeArtifact(
        runtime(true, new Map()),
        '/workspace/repo',
        repositoryChangeArtifactSchema,
        outputFiles,
        'Automated change; see the diff.',
      ),
    ).resolves.toEqual({
      kind: 'repository-change',
      summary: 'Automated change; see the diff.',
      notes: null,
    });
  });

  it('validates changed output with the caller-supplied Zod schema', async () => {
    const constrainedOutput = repositoryChangeArtifactSchema.refine(
      (artifact) => artifact.kind === 'no-change' || artifact.summary.startsWith('- '),
      'summary must use bullets',
    );

    await expect(
      readRepositoryChangeArtifact(
        runtime(true, new Map([[outputFiles.summary, 'Not a bullet']])),
        '/workspace/repo',
        constrainedOutput,
        outputFiles,
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});
