import type { Sandbox } from '@cloudflare/sandbox';
import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { implementerAgent, type ImplementInput } from '../../agents/implementer.ts';
import { runAgent } from '../../agents/run.ts';
import type { RepositoryChangeArtifact } from '../../artifacts/change.ts';
import { githubRequest as gh } from '../../integrations/github/client.ts';
import { persistAgentLog } from '../runtime/agent-runs.ts';
import { runCodingAgent, type CliUsage } from '../runtime/coding-agent.ts';
import {
  finishAutomationRun,
  getAutomationById,
  getRepoById,
  listEnabledSkillsForRepo,
  listRepoConnections,
  tryRecordAutomationRun,
  type AutomationRow,
} from '../../data/db.ts';
import { getRunnerModelCatalog } from '../../data/models.ts';
import { buildSandboxMcpConfig } from '../../services/mcp-proxy.ts';
import { resolveRunnerAuth } from '../runtime/runner-auth.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';
import { redactSecrets } from '../runtime/redaction.ts';
import { mountSkills } from '../runtime/skills.ts';
import { prepareCachedWorktree, pushHeadCommand } from '../runtime/repository-workspace.ts';
import {
  remoteSourceOf,
  resolveWorkspaceRemote,
  type RemoteSource,
} from '../../integrations/git/provider.ts';
import { NPM_CACHE_ENV } from '../runtime/sandbox-deps.ts';
import { checkCommandUnrunnable, runCheckCommand } from '../runtime/check-command.ts';
import {
  authorizesWorkflowFiles,
  describePushFailure,
  installationToken,
} from '../../integrations/github/app.ts';
import { notifyAutomationLive } from '../../services/live-updates.ts';
import { readRepositoryChangeArtifact } from '../runtime/repository-change-artifact.ts';

// A recurring, clock-driven counterpart to the generation workflow: a
// user-authored prompt runs on a schedule (src/services/automation-poll.ts) against
// a fresh checkout of one repo and, when it produces changes, opens a PR. Same
// Workflow shape as generation for the same reason — no wall-clock kill,
// memoized steps, and business outcomes (no changes, checks failed) are
// returns rather than throws so they're never retried.
//
// Unlike generation, there is no instructing human: every PR this opens is
// bot-authored (installationToken), and every firing — including one where
// the agent makes no changes — is recorded as an automation_runs row so the
// automation's "Runs" list proves the schedule is actually executing.

const CACHE_DIR = '/workspace/repo-cache';
const workDir = (runId: number) => `/workspace/automation-${runId}`;
const specFile = (runId: number) => `/workspace/automation-spec-${runId}.md`;
const prFile = (runId: number) => `/workspace/automation-pr-${runId}.md`;
const notesFile = (runId: number) => `/workspace/automation-notes-${runId}.md`;
const AGENT_TIMEOUT_MS = 20 * 60_000;
const CHECK_TIMEOUT_MS = 12 * 60_000;

export type AutomationParams = {
  automationId: number;
};

function branchName(automation: AutomationRow, runId: number): string {
  const slug = automation.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `turbodiff/automation-${automation.id}-${runId}-${slug}`;
}

function sandboxFor(repo: { owner: string; name: string }): Sandbox {
  return runnerSandbox(`automation--${repo.owner}--${repo.name}`.toLowerCase(), {
    sleepAfter: '45m',
  });
}

// Serializable context threaded between steps (a type alias, not an
// interface — interfaces fail the engine's Rpc.Serializable constraint).
type RunContext = {
  automationId: number;
  runId: number;
  owner: string;
  name: string;
  installationId: number;
  repositoryId: number;
  base: string;
  branch: string;
  checkCommand: string | null;
  automationName: string;
  prompt: string;
  // Per-automation runner model; a NULL column resolves to the catalog's
  // runner default at claim time, so "Default (X)" in the form runs X.
  runnerModel: string;
  // The user-authored prompt mentions .github/workflows — the push token may
  // carry the App's workflows permission (see sandboxGitToken).
  workflows: boolean;
  // Provider-resolved git identity (git/provider.ts) so steps can mint
  // run-scoped credentials without re-reading the repo row.
  remoteSource: RemoteSource;
};

function implementationInput(ctx: RunContext): ImplementInput {
  return {
    operation: 'implement',
    repository: `${ctx.owner}/${ctx.name}`,
    title: ctx.automationName,
    instructions: ctx.prompt,
    scope: 'standard',
    testing: 'harness-only',
    noChangeOutcome: 'allowed',
    check: { kind: 'harness', command: ctx.checkCommand },
    outputFiles: {
      summary: prFile(ctx.runId),
      notes: notesFile(ctx.runId),
    },
  };
}

const QUICK = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class AutomationWorkflow extends WorkflowEntrypoint<unknown, AutomationParams> {
  async run(event: WorkflowEvent<AutomationParams>, step: WorkflowStep): Promise<string> {
    const { automationId } = event.payload;
    let runId: number | null = null;

    try {
      // Load, guard, and single-flight-claim a run row. NonRetryableError for
      // a missing automation so the engine doesn't burn retries on it; every
      // other bail (disabled, repo missing, a run already in flight) is a
      // quiet skip — the next scheduled firing tries again.
      const ctx = await step.do(
        'load automation and claim run',
        QUICK,
        async (): Promise<RunContext | null> => {
          const automation = await getAutomationById(automationId);
          if (!automation) throw new NonRetryableError(`automation ${automationId} not found`);
          if (!automation.enabled) return null;
          const repo = await getRepoById(automation.repository_id);
          if (!repo || !repo.enabled) return null;
          const token = await installationToken(repo.installation_id);
          // SAFETY: GitHub's get-repository endpoint always includes
          // default_branch in its success response.
          const info = (await (await gh(token, `/repos/${repo.owner}/${repo.name}`)).json()) as {
            default_branch: string;
          };
          const claimedRunId = await tryRecordAutomationRun(automationId);
          if (claimedRunId === null) return null; // a run is already in flight — skip this beat
          return {
            automationId,
            runId: claimedRunId,
            owner: repo.owner,
            name: repo.name,
            installationId: repo.installation_id,
            repositoryId: repo.id,
            base: info.default_branch,
            branch: branchName(automation, claimedRunId),
            checkCommand: repo.check_command,
            automationName: automation.name,
            prompt: automation.prompt,
            runnerModel: automation.runner_model ?? (await getRunnerModelCatalog()).defaultModel,
            workflows: authorizesWorkflowFiles(automation.prompt),
            remoteSource: remoteSourceOf(repo),
          };
        },
      );
      if (!ctx) return 'skipped';
      runId = ctx.runId;
      const full = `${ctx.owner}/${ctx.name}`;
      const label = `${full} automation #${ctx.automationId} run #${ctx.runId}`;

      const WORK = workDir(ctx.runId);
      await step.do(
        'prepare working copy',
        { retries: { limit: 3, delay: '1 minute', backoff: 'exponential' }, timeout: '8 minutes' },
        async () => {
          const remote = await resolveWorkspaceRemote(ctx.remoteSource, 'write');
          const sandbox = sandboxFor(ctx);
          await prepareCachedWorktree({
            sandbox,
            cacheDir: CACHE_DIR,
            workDir: WORK,
            remote,
            base: ctx.base,
            branch: ctx.branch,
          });
        },
      );

      // THE paid step. retries.limit 1 = at most two agent runs per instance.
      const implementInput = implementationInput(ctx);
      const agentRan = await step.do(
        'run coding agent',
        { retries: { limit: 1, delay: '5 minutes' }, timeout: '23 minutes' },
        async (): Promise<{ artifact: RepositoryChangeArtifact; usage: CliUsage | null }> => {
          let usage: CliUsage | null = null;
          const artifact = await runAgent(implementerAgent, implementInput, {
            model: ctx.runnerModel,
            execute: async (request, output) => {
              if (request.agentId !== implementerAgent.id || request.repositoryAccess !== 'write') {
                throw new Error('automation executor only accepts the write-capable implementer');
              }

              const auth = await resolveRunnerAuth(request.model);
              const sandbox = sandboxFor(ctx);
              await mountSkills(sandbox, WORK, await listEnabledSkillsForRepo(ctx.repositoryId));
              // Mount the repo's MCP connections through the Worker's relay:
              // the sandbox only ever holds run-scoped grants, never connection
              // credentials (see lib/mcp-proxy.ts).
              const connections = await listRepoConnections(ctx.repositoryId, 'automations');
              const mcp = await buildSandboxMcpConfig(connections, ctx.repositoryId);
              const scrubValues = [...Object.values(auth.vars), ...(mcp?.secrets ?? [])];
              const scrub = (s: string) => redactSecrets(s, scrubValues);
              await sandbox.exec(
                `rm -f ${implementInput.outputFiles.summary} ${implementInput.outputFiles.notes}`,
              );
              await sandbox.writeFile(specFile(ctx.runId), request.prompt);
              const agent = await runCodingAgent(sandbox, auth, {
                promptFile: specFile(ctx.runId),
                cwd: WORK,
                timeout: AGENT_TIMEOUT_MS,
                env: NPM_CACHE_ENV,
                configExtensionJson: mcp?.configJson,
              });
              usage = agent.usage;
              const resultText = agent.resultText;
              await persistAgentLog(
                'automation',
                scrub(`${resultText}\n${agent.stderr}`.trim()),
                agent.success,
                { automationRunId: ctx.runId },
              );
              if (!agent.success) {
                // Scrubbed: this message persists to automation_runs.error and
                // renders in the dashboard for every installation member.
                throw new Error(
                  `automation agent exited ${agent.exitCode}: ${scrub(`${resultText}\n${agent.stderr}`.trim()).slice(-1_000)}`,
                );
              }
              return readRepositoryChangeArtifact(
                sandbox,
                WORK,
                output,
                implementInput.outputFiles,
                `${ctx.automationName} — automated change; see the diff.`,
              );
            },
          });
          return { artifact, usage };
        },
      );

      if (agentRan.artifact.kind === 'no-change') {
        await step.do('record no_changes', QUICK, async () => {
          await finishAutomationRun(
            ctx.runId,
            'no_changes',
            undefined,
            undefined,
            undefined,
            agentRan.usage ?? undefined,
          );
          await notifyAutomationLive(automationId);
        });
        return 'no_changes';
      }
      const changeArtifact = agentRan.artifact;

      await step.do('commit', QUICK, async () => {
        const sandbox = sandboxFor(ctx);
        const commit = await sandbox.exec(
          `git -C ${WORK} add -A && git -C ${WORK} commit -m "$COMMIT_MSG"`,
          {
            env: { COMMIT_MSG: `${ctx.automationName} (turbodiff automation, run #${ctx.runId})` },
            timeout: 60_000,
          },
        );
        if (!commit.success) throw new Error(`git commit failed: ${commit.stderr.slice(0, 500)}`);
      });

      if (ctx.checkCommand) {
        const checks = await step.do(
          'run check command',
          { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' },
          async (): Promise<{ ok: boolean; output: string }> => {
            // Same PATH handling and executable-vs-failing distinction as
            // the generation workflow: a check that cannot run at all is a
            // misconfiguration to report, not a checks_failed verdict.
            const auth = await resolveRunnerAuth(ctx.runnerModel);
            const scrub = (s: string) => redactSecrets(s, Object.values(auth.vars));
            const res = await runCheckCommand(
              sandboxFor(ctx),
              WORK,
              ctx.checkCommand!,
              scrub,
              CHECK_TIMEOUT_MS,
            );
            if (res.notExecutable) {
              throw new NonRetryableError(
                checkCommandUnrunnable(ctx.checkCommand!, res.output).message,
              );
            }
            return { ok: res.ok, output: res.output.slice(-500) };
          },
        );
        if (!checks.ok) {
          await step.do('record checks_failed', QUICK, async () => {
            await finishAutomationRun(
              ctx.runId,
              'checks_failed',
              undefined,
              undefined,
              checks.output,
              agentRan.usage ?? undefined,
            );
            await notifyAutomationLive(automationId);
          });
          return 'checks_failed';
        }
      }

      await step.do('push branch', QUICK, async () => {
        const remote = await resolveWorkspaceRemote(ctx.remoteSource, 'write', {
          workflows: ctx.workflows,
        });
        const sandbox = sandboxFor(ctx);
        const push = await sandbox.exec(pushHeadCommand(remote, WORK), {
          env: { ...remote.env, PUSH_BRANCH: ctx.branch },
          timeout: 3 * 60_000,
        });
        if (!push.success) {
          throw new Error(
            describePushFailure(redactSecrets(push.stderr, [remote.token]).slice(0, 500)),
          );
        }
      });

      const { prNumber, commitSha } = await step.do(
        'open pull request',
        QUICK,
        async (): Promise<{ prNumber: number; commitSha: string }> => {
          const sandbox = sandboxFor(ctx);
          const commitSha = (await sandbox.exec(`git -C ${WORK} rev-parse HEAD`)).stdout.trim();
          const { summary, notes } = changeArtifact;
          const token = await installationToken(ctx.installationId);
          // SAFETY: GitHub's create-pull-request endpoint returns the created
          // PR object, which always carries its number.
          const pr = (await (
            await gh(token, `/repos/${full}/pulls`, {
              method: 'POST',
              body: JSON.stringify({
                title: ctx.automationName,
                head: ctx.branch,
                base: ctx.base,
                body:
                  summary +
                  (notes
                    ? `\n\n<details><summary>Implementation notes</summary>\n\n${notes}\n\n</details>`
                    : '') +
                  `\n\n---\n_opened by the "${ctx.automationName}" automation · turbodiff_`,
              }),
            })
          ).json()) as { number: number };
          return { prNumber: pr.number, commitSha };
        },
      );

      await step.do('record pr_opened', QUICK, async () => {
        await finishAutomationRun(
          ctx.runId,
          'pr_opened',
          prNumber,
          commitSha,
          undefined,
          agentRan.usage ?? undefined,
        );
        await notifyAutomationLive(automationId);
      });

      await step.do(
        'clean workspace',
        { retries: { limit: 1, delay: '10 seconds' }, timeout: '2 minutes' },
        async () => {
          await sandboxFor(ctx)
            .exec(
              `rm -rf ${WORK} ${specFile(ctx.runId)} ${prFile(ctx.runId)} ${notesFile(ctx.runId)}`,
            )
            .catch(() => {});
        },
      );

      console.log(`turbodiff: automation pr_opened for ${label} (PR #${prNumber})`);
      return 'pr_opened';
    } catch (err) {
      // Terminal failure (a step exhausted its retries, or a
      // NonRetryableError). Recording it is itself a durable step. When the
      // failure happened before a run row was ever claimed (e.g. the
      // automation itself doesn't exist), there's nothing to record.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (runId !== null) {
        const failedRunId = runId;
        await step.do(
          'record failure',
          {
            retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
            timeout: '2 minutes',
          },
          async () => {
            await finishAutomationRun(failedRunId, 'failed', undefined, undefined, message);
            await notifyAutomationLive(automationId);
          },
        );
      }
      console.error(`turbodiff: automation workflow failed for automation ${automationId}:`, err);
      return 'failed';
    }
  }
}

// Entry point used by the queue consumer. Cheap guard against a deleted
// automation; the workflow re-validates enabled/repo state in its first step.
export async function startAutomationRun(automationId: number): Promise<void> {
  const automation = await getAutomationById(automationId);
  if (!automation) {
    console.warn(`turbodiff: automation run skipped, automation ${automationId} not found`);
    return;
  }
  await env.AUTOMATION_WORKFLOW.create({
    id: `automation-${automationId}-${Date.now()}`,
    params: { automationId },
  });
}
