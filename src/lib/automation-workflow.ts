import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { gh } from '../tools/github.ts';
import { persistAgentLog } from './agent-runs.ts';
import {
  finishAutomationRun,
  getAutomationById,
  getRepoById,
  listEnabledSkillsForRepo,
  tryRecordAutomationRun,
  type AutomationRow,
} from './db.ts';
import { resolveRunnerAuth } from './fixer.ts';
import { NPM_CACHE_ENV } from './generation-workflow.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';
import { skillMarkdown } from './skill-files.ts';

// A recurring, clock-driven counterpart to generation-workflow.ts: a
// user-authored prompt runs on a schedule (src/lib/automation-poll.ts) against
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
const AGENT_TIMEOUT_MS = 20 * 60_000;
const CHECK_TIMEOUT_MS = 12 * 60_000;

export interface AutomationQueueMessage {
  kind: 'automation';
  automationId: number;
}

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

function automationPrompt(ctx: RunContext): string {
  return `You are an automation agent running a scheduled task in a fresh checkout of ${ctx.owner}/${ctx.name}.

Follow the instructions below. Rules:
- Investigate and make only the minimal changes needed to accomplish the task.
- Match the repository's existing conventions: style, structure, naming, idioms.
- Do NOT run dependency installs, builds, or test suites unless the task itself
  requires it — the harness runs the repository's check command after you finish.
- Do NOT run git commit or git push; the harness handles git.
- If nothing needs to change, make no edits — a clean working tree is a valid
  "no changes needed" outcome, not a failure.
- When you do make changes, write ${prFile(ctx.runId)}: a concise pull-request
  description — 1-4 bullet points covering what changed and why.

${UNTRUSTED_CONTENT_RULES}

## Automation: ${ctx.automationName}

${ctx.prompt}
`;
}

function sandboxFor(repo: { owner: string; name: string }): Sandbox {
  return getSandbox(
    env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
    `automation--${repo.owner}--${repo.name}`.toLowerCase(),
    { sleepAfter: '45m' },
  ) as unknown as Sandbox;
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
};

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
          const gitToken = await sandboxGitToken(ctx.installationId, ctx.name, 'write');
          const sandbox = sandboxFor(ctx);
          // Warm path: update the shared per-repo cache (fetch, seconds) or
          // cold-clone it once; then a local hardlink clone into this run's
          // own directory — same pattern as generation-workflow.ts.
          const sync = await sandbox.exec(
            `if [ -d ${CACHE_DIR}/.git ]; then ` +
              `git -C ${CACHE_DIR} fetch --depth 50 "https://x-access-token:$GIT_TOKEN@github.com/${full}.git" "$AUTOMATION_BASE" && ` +
              `git -C ${CACHE_DIR} checkout -q -B "$AUTOMATION_BASE" FETCH_HEAD; ` +
              `else git clone --depth 50 --single-branch --branch "$AUTOMATION_BASE" ` +
              `"https://x-access-token:$GIT_TOKEN@github.com/${full}.git" ${CACHE_DIR} && ` +
              `git -C ${CACHE_DIR} remote set-url origin "https://github.com/${full}.git"; fi`,
            { env: { GIT_TOKEN: gitToken, AUTOMATION_BASE: ctx.base }, timeout: 5 * 60_000 },
          );
          if (!sync.success) {
            await sandbox.exec(`rm -rf ${CACHE_DIR}`).catch(() => {});
            throw new Error(
              `repo cache sync failed: ${sync.stderr.replaceAll(gitToken, '***').slice(0, 500)}`,
            );
          }
          const clone = await sandbox.exec(
            `rm -rf ${WORK} && git clone --local ${CACHE_DIR} ${WORK} && ` +
              `git -C ${WORK} checkout -q -b "$AUTOMATION_BRANCH" && ` +
              `git -C ${WORK} config user.name "turbodiff[bot]" && ` +
              `git -C ${WORK} config user.email "turbodiff[bot]@users.noreply.github.com"`,
            { env: { AUTOMATION_BRANCH: ctx.branch }, timeout: 2 * 60_000 },
          );
          if (!clone.success) {
            throw new Error(`working-copy clone failed: ${clone.stderr.slice(0, 500)}`);
          }
        },
      );

      // THE paid step. retries.limit 1 = at most two agent runs per instance.
      const agentRan = await step.do(
        'run coding agent',
        { retries: { limit: 1, delay: '5 minutes' }, timeout: '23 minutes' },
        async (): Promise<{ changed: boolean }> => {
          const auth = resolveRunnerAuth();
          const scrub = (s: string) =>
            Object.values(auth.vars).reduce((acc, v) => acc.replaceAll(v, '***'), s);
          const sandbox = sandboxFor(ctx);
          const skills = await listEnabledSkillsForRepo(ctx.repositoryId);
          for (const skill of skills) {
            const dir = `${WORK}/.claude/skills/${skill.slug}`;
            await sandbox.exec(`mkdir -p ${dir}`);
            await sandbox.writeFile(`${dir}/SKILL.md`, skillMarkdown(skill));
          }
          await sandbox.writeFile(specFile(ctx.runId), automationPrompt(ctx));
          const agent = await sandbox.exec(
            `claude -p --dangerously-skip-permissions --output-format text < ${specFile(ctx.runId)}`,
            {
              cwd: WORK,
              timeout: AGENT_TIMEOUT_MS,
              env: {
                ...auth.vars,
                ...NPM_CACHE_ENV,
                IS_SANDBOX: '1',
                DISABLE_AUTOUPDATER: '1',
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              },
            },
          );
          await persistAgentLog(
            'automation',
            scrub(`${agent.stdout}\n${agent.stderr}`.trim()),
            agent.success,
            { automationRunId: ctx.runId },
          );
          if (!agent.success) {
            // Scrubbed: this message persists to automation_runs.error and
            // renders in the dashboard for every installation member.
            throw new Error(
              `automation agent exited ${agent.exitCode}: ${scrub(`${agent.stdout}\n${agent.stderr}`.trim()).slice(-1_000)}`,
            );
          }
          const status = await sandbox.exec(`git -C ${WORK} status --porcelain`);
          return { changed: Boolean(status.stdout.trim()) };
        },
      );

      if (!agentRan.changed) {
        await step.do('record no_changes', QUICK, async () => {
          await finishAutomationRun(ctx.runId, 'no_changes');
        });
        return 'no_changes';
      }

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
            const sandbox = sandboxFor(ctx);
            const res = await sandbox.exec(ctx.checkCommand!, {
              cwd: WORK,
              timeout: CHECK_TIMEOUT_MS,
              env: NPM_CACHE_ENV,
            });
            return { ok: res.success, output: `${res.stdout}\n${res.stderr}`.trim().slice(-500) };
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
            );
          });
          return 'checks_failed';
        }
      }

      await step.do('push branch', QUICK, async () => {
        const gitToken = await sandboxGitToken(ctx.installationId, ctx.name, 'write');
        const sandbox = sandboxFor(ctx);
        const push = await sandbox.exec(
          `git -C ${WORK} push "https://x-access-token:$GIT_TOKEN@github.com/${full}.git" HEAD:"$AUTOMATION_BRANCH"`,
          { env: { GIT_TOKEN: gitToken, AUTOMATION_BRANCH: ctx.branch }, timeout: 3 * 60_000 },
        );
        if (!push.success) {
          throw new Error(
            `git push failed: ${push.stderr.replaceAll(gitToken, '***').slice(0, 500)}`,
          );
        }
      });

      const { prNumber, commitSha } = await step.do(
        'open pull request',
        QUICK,
        async (): Promise<{ prNumber: number; commitSha: string }> => {
          const sandbox = sandboxFor(ctx);
          const commitSha = (await sandbox.exec(`git -C ${WORK} rev-parse HEAD`)).stdout.trim();
          const summary = await sandbox
            .readFile(prFile(ctx.runId))
            .then((f) => f.content.trim() || undefined)
            .catch(() => undefined);
          const token = await installationToken(ctx.installationId);
          const pr = (await (
            await gh(token, `/repos/${full}/pulls`, {
              method: 'POST',
              body: JSON.stringify({
                title: ctx.automationName,
                head: ctx.branch,
                base: ctx.base,
                body:
                  (summary ?? `${ctx.automationName} — automated change; see the diff.`) +
                  `\n\n---\n_opened by the "${ctx.automationName}" automation · turbodiff_`,
              }),
            })
          ).json()) as { number: number };
          return { prNumber: pr.number, commitSha };
        },
      );

      await step.do('record pr_opened', QUICK, async () => {
        await finishAutomationRun(ctx.runId, 'pr_opened', prNumber, commitSha);
      });

      await step.do(
        'clean workspace',
        { retries: { limit: 1, delay: '10 seconds' }, timeout: '2 minutes' },
        async () => {
          await sandboxFor(ctx)
            .exec(`rm -rf ${WORK} ${specFile(ctx.runId)} ${prFile(ctx.runId)}`)
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
