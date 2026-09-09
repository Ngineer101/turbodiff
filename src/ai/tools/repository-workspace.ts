import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { getRepoByFullName } from '../../data/db.ts';
import { runCheckCommand } from '../runtime/check-command.ts';
import { installDependencies } from '../runtime/sandbox-deps.ts';
import { assertRepositorySearchPath } from '../runtime/review-workspace-policy.ts';
import { prepareReviewWorkspace, type ReviewWorkspace } from '../runtime/review-workspace.ts';
import { assertHeadPinned, assertPrPinned, type RepoPin } from './github.ts';

const MAX_TOOL_OUTPUT = 20_000;

function clip(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n[turbodiff: workspace output truncated]`;
}

async function resetWorkspace(workspace: ReviewWorkspace): Promise<void> {
  await workspace.sandbox
    .exec('git reset --hard -q HEAD && git clean -ffdq', {
      cwd: workspace.workDir,
      timeout: 30_000,
    })
    .catch(() => {});
}

async function pinnedRepo(pin: RepoPin, owner: string, repo: string) {
  if (pin) assertPrPinned(pin, owner, repo, pin.number);
  const row = await getRepoByFullName(owner, repo);
  if (!row) throw new Error(`Turbodiff is not installed on ${owner}/${repo}`);
  return row;
}

export const makeSearchRepository = (agentInstanceId: string, pin: RepoPin) =>
  defineTool({
    name: 'search_repository',
    description:
      'Literal-search the full repository at the exact PR head. Use this to enumerate callers, ' +
      'state writers, invalidators, tests, and definitions outside the changed files. Results are ' +
      'read-only, line-numbered, capped at 200 matches, and scoped to the pinned repository.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      number: v.pipe(v.number(), v.integer(), v.minValue(1)),
      headSha: v.pipe(v.string(), v.length(40)),
      query: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(500)), '.'),
    }),
    async run({ data }) {
      assertPrPinned(pin, data.owner, data.repo, data.number);
      assertHeadPinned(pin, data.headSha);
      const repo = await pinnedRepo(pin, data.owner, data.repo);
      const path = assertRepositorySearchPath(data.path);
      const workspace = await prepareReviewWorkspace(
        repo,
        data.number,
        data.headSha,
        agentInstanceId,
      );
      const result = await workspace.sandbox.exec(
        'git grep -n -I -F -e "$SEARCH_QUERY" -- "$SEARCH_PATH" | head -n 200',
        {
          cwd: workspace.workDir,
          env: { SEARCH_QUERY: data.query, SEARCH_PATH: path },
          timeout: 30_000,
        },
      );
      return { output: clip(workspace.scrub(result.stdout.trim())) };
    },
  });

export const makeRunRepositoryCheck = (agentInstanceId: string, pin: RepoPin) =>
  defineTool({
    name: 'run_repository_check',
    description:
      "Run the repository owner's configured check command at the exact PR head in an isolated, " +
      'credential-free workspace. The command is server-configured, never model-supplied, and has ' +
      'a five-minute execution limit. Use it to verify a concrete candidate when checks are configured.',
    input: v.object({
      owner: v.string(),
      repo: v.string(),
      number: v.pipe(v.number(), v.integer(), v.minValue(1)),
      headSha: v.pipe(v.string(), v.length(40)),
    }),
    async run({ data }) {
      assertPrPinned(pin, data.owner, data.repo, data.number);
      assertHeadPinned(pin, data.headSha);
      const repo = await pinnedRepo(pin, data.owner, data.repo);
      if (!repo.check_command) {
        return { output: { configured: false, ran: false, passed: null, output: '' } };
      }
      const workspace = await prepareReviewWorkspace(
        repo,
        data.number,
        data.headSha,
        agentInstanceId,
      );
      const dependenciesReady = await workspace.sandbox.exec(
        '[ ! -f package.json ] || [ -d node_modules ]',
        { cwd: workspace.workDir, timeout: 10_000 },
      );
      const installFailure = dependenciesReady.success
        ? null
        : await installDependencies(workspace.sandbox, workspace.workDir);
      if (installFailure) {
        await resetWorkspace(workspace);
        return {
          output: {
            configured: true,
            ran: false,
            passed: null,
            output: clip(workspace.scrub(`dependency installation failed: ${installFailure}`)),
          },
        };
      }
      let result: Awaited<ReturnType<typeof runCheckCommand>>;
      try {
        result = await runCheckCommand(
          workspace.sandbox,
          workspace.workDir,
          repo.check_command,
          workspace.scrub,
          5 * 60_000,
        );
      } finally {
        await resetWorkspace(workspace);
      }
      return {
        output: {
          configured: true,
          ran: !result.notExecutable,
          passed: result.ok,
          output: clip(result.output),
        },
      };
    },
  });
