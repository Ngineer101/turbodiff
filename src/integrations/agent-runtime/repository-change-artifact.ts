import type { ZodType } from 'zod';

type RepositoryChangeRuntime = {
  exec(command: string): Promise<{ success: boolean; stdout: string; stderr: string }>;
  readFile(path: string): Promise<{ content: string }>;
};

type RepositoryChangeOutputFiles = {
  summary: string;
  notes: string;
};

async function readOptionalText(
  runtime: RepositoryChangeRuntime,
  path: string,
): Promise<string | null> {
  try {
    return (await runtime.readFile(path)).content.trim() || null;
  } catch {
    return null;
  }
}

// Adapts an untrusted repository-writing runtime into the agent's supplied
// artifact schema. Git state is authoritative; a changed tree must also carry
// the summary required for downstream publication.
export async function readRepositoryChangeArtifact<Output>(
  runtime: RepositoryChangeRuntime,
  workDirectory: string,
  output: ZodType<Output>,
  outputFiles: RepositoryChangeOutputFiles,
  fallbackSummary?: string,
): Promise<Output> {
  const status = await runtime.exec(`git -C ${workDirectory} status --porcelain`);
  if (!status.success) {
    throw new Error(`git status failed: ${status.stderr.trim().slice(-500) || 'unknown error'}`);
  }
  if (!status.stdout.trim()) return output.parse({ kind: 'no-change' });

  const summary = (await readOptionalText(runtime, outputFiles.summary)) ?? fallbackSummary;
  if (!summary) throw new Error(`implementer did not produce ${outputFiles.summary}`);

  return output.parse({
    kind: 'repository-change',
    summary,
    notes: await readOptionalText(runtime, outputFiles.notes),
  });
}
