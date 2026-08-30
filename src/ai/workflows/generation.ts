import type { Sandbox } from '@cloudflare/sandbox';
import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { githubRequest as gh } from '../../integrations/github/client.ts';
import { persistAgentLog } from '../runtime/agent-runs.ts';
import { parseUtc } from '../../shared/time.ts';
import { coauthorTrailer, gitAuthorEnv } from '../../domain/attribution.ts';
import {
  addCliUsage,
  claudeCliResultText,
  claudeCliSessionId,
  parseClaudeCliUsage,
  type CliUsage,
} from '../runtime/cli-usage.ts';
import {
  changeProviderKey,
  getFeature,
  getRepoById,
  listEnabledSkillsForRepo,
  updateFeature,
  upsertChange,
  type FeatureRow,
  type SkillRow,
} from '../../data/db.ts';
import { resolveRunnerAuth, runnerEnvironment } from '../runtime/runner-auth.ts';
import { generationSandbox } from '../runtime/sandbox.ts';
import { redactSecrets } from '../runtime/redaction.ts';
import { mountSkills } from '../runtime/skills.ts';
import {
  prepareCachedWorktree,
  pushHeadCommand,
  worktreeChanged,
} from '../runtime/repository-workspace.ts';
import {
  remoteSourceOf,
  resolveWorkspaceRemote,
  type RemoteSource,
} from '../../integrations/git/provider.ts';
import {
  authorizesWorkflowFiles,
  describePushFailure,
  installationToken,
} from '../../integrations/github/app.ts';
import { UNTRUSTED_CONTENT_RULES } from '../../domain/prompt-security.ts';
import { installDependencies, NPM_CACHE_ENV } from '../runtime/sandbox-deps.ts';
import { mintUserToken } from '../../services/user-tokens.ts';
import { openNativeChangeRequest } from '../../services/change-requests.ts';
import { notifyFeatureLive } from '../../services/live-updates.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { completeLifecycleStage } from '../../services/lifecycle.ts';
import type { GenerateQueueMessage } from '../../shared/factory-messages.ts';

// Phase 2 of the software factory, re-architected as a Cloudflare Workflow.
// The old design ran the whole pipeline inside one queue-consumer invocation,
// whose hard 15-minute wall clock silently killed long runs. Workflow steps
// have no wall-clock limit (only CPU time, and awaiting sandbox exec is I/O),
// so the agent finally gets a real budget — and the engine's durability gives
// the guarantees the queue never could:
//
//   - every step's result is memoized: once the (paid) agent step completes,
//     no downstream failure can ever re-run it
//   - the agent step retries AT MOST once (retries.limit below) — a workflow
//     instance can never spend more than two agent runs, by construction
//   - a killed isolate resumes the instance at the failed step instead of
//     stranding the feature; terminal failures always reach the record step
//   - business outcomes (no changes, checks failed) are returns, not throws,
//     so they are never retried at all
//
// Step return values are persisted by the engine: never return tokens or
// other secrets from a step — mint them inside the step that uses them.

// The sandbox is per-REPO (warm across features): a shared git cache gets
// fetched instead of re-cloned, and shared package caches make any install
// the agent does run cache-hot. Each feature works in its own directory for
// isolation; only the caches are shared.
const CACHE_DIR = '/workspace/repo-cache';
const workDir = (featureId: number) => `/workspace/gen-${featureId}`;
const specFile = (featureId: number) => `/workspace/gen-spec-${featureId}.md`;
const prFile = (featureId: number) => `/workspace/gen-pr-${featureId}.md`;
const repairFile = (featureId: number, round: number) =>
  `/workspace/gen-repair-${featureId}-${round}.md`;
// Agent exec budgets by tier — trivial requests don't get to burn a
// feature-sized window. Step timeouts sit slightly above so the exec timeout
// (a clean, attributable failure) fires before the step timeout does.
const AGENT_TIMEOUT_MS = { trivial: 8 * 60_000, standard: 25 * 60_000 };
const AGENT_STEP_TIMEOUT = { trivial: '10 minutes', standard: '28 minutes' } as const;
const CHECK_TIMEOUT_MS = 12 * 60_000;
// The repair loop: a failing check goes back to the agent (its session
// resumed, full context intact) instead of ending the run — the local
// edit/check/fix cycle a human gets. Bounded so a hopeless failure (broken
// base, flaky check) can't spend forever.
const REPAIR_ROUNDS = 2;
const REPAIR_TIMEOUT_MS = 15 * 60_000;

export type GenerationParams = {
  featureId: number;
  factoryRunId?: number;
  stageRunId?: number;
};

interface CreatedGithubPullRequest {
  number: number;
  html_url: string;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

function branchName(feature: FeatureRow): string {
  const slug = feature.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `turbodiff/feat-${feature.id}-${slug}`;
}

function generationPrompt(ctx: RunContext): string {
  const trivial = ctx.tier === 'trivial';
  // Trivial runs keep the tight no-checks budget; standard runs with a check
  // command are told to verify their own work — the harness re-runs the check
  // afterwards either way, and the repair loop catches what slips through.
  const checkRule =
    !trivial && ctx.checkCommand
      ? `- Dependencies are already installed. Before finishing, run \`${ctx.checkCommand}\`
  and fix any failures your changes caused. Failures that clearly pre-date this
  feature are not yours to fix — note them in Implementation notes instead.`
      : `- Do NOT run dependency installs, builds, or test suites unless the change itself
  requires it — the harness runs the repository's check command after you finish,
  and a separate verification phase checks the acceptance criteria empirically.`;
  return `You are an automated implementation agent working in a fresh checkout of ${ctx.owner}/${ctx.name}.

Implement the feature specified below. Rules:
- Implement exactly what the spec describes — no scope creep, no drive-by refactors.
- Match the repository's existing conventions: style, structure, naming, idioms.
${
  trivial
    ? '- This is a small, localized change: make the edits, verify them by reading, and stop.'
    : `- If the repository has an established testing pattern, add or update tests for
  the new behavior in that same pattern.`
}
${checkRule}
- Do NOT run git commit or git push; the harness handles git.
- If part of the spec is ambiguous, choose the most conventional interpretation
  and note the choice in a "## Implementation notes" section you append to
  ${specFile(ctx.featureId)}.
- When done, write ${prFile(ctx.featureId)}: a concise pull-request description —
  ${trivial ? '1-3' : '3-6'} bullet points covering what changed and why. No spec restatement, no
  process narration; just what a reviewer needs.

${UNTRUSTED_CONTENT_RULES}

## Feature: ${ctx.title}

${ctx.spec}
`;
}

// Work order for a repair round. The resumed session already carries the
// spec and the reasoning behind every change; the check output is all it
// needs. A fresh-session fallback (no resumable id) gets pointed at the spec
// file, which is still on disk.
function repairPrompt(ctx: RunContext, checkOutput: string, fresh: boolean): string {
  return `${
    fresh
      ? `Read ${specFile(ctx.featureId)} for the feature spec previously implemented in this checkout.\n\n`
      : ''
  }The repository check command (\`${ctx.checkCommand}\`) failed after your changes:

\`\`\`
${checkOutput}
\`\`\`

Fix the failures your changes caused, then re-run the check to confirm. Rules
unchanged: no git commit or push, no scope creep. If a failure clearly
pre-dates this feature and cannot be fixed safely, note it under
"## Implementation notes" in ${specFile(ctx.featureId)} and stop.

${UNTRUSTED_CONTENT_RULES}
`;
}

function sandboxFor(repo: { owner: string; name: string }): Sandbox {
  return generationSandbox(repo);
}

// Serializable context threaded between steps (a type alias, not an
// interface — interfaces fail the engine's Rpc.Serializable constraint).
type RunContext = {
  featureId: number;
  owner: string;
  name: string;
  installationId: number;
  repositoryId: number;
  base: string;
  branch: string;
  checkCommand: string | null;
  runnerModel: string | null; // the task's requested model; null = default
  title: string;
  spec: string;
  authorLogin: string | null;
  authorId: number | null;
  coauthorLogin: string | null;
  coauthorId: number | null;
  acceptance: boolean;
  tier: 'trivial' | 'standard';
  skills: SkillRow[];
  // The approved spec mentions .github/workflows — the push token may carry
  // the App's workflows permission (see sandboxGitToken).
  workflows: boolean;
  // Provider-resolved git identity (git/provider.ts) so steps can mint
  // run-scoped credentials without re-reading the repo row.
  remoteSource: RemoteSource;
};

const QUICK = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class GenerationWorkflow extends WorkflowEntrypoint<unknown, GenerationParams> {
  async run(event: WorkflowEvent<GenerationParams>, step: WorkflowStep): Promise<string> {
    const { featureId, stageRunId } = event.payload;
    const settleLifecycle = async (
      success: boolean,
      outcome: string,
      detail?: string,
    ): Promise<void> => {
      if (!stageRunId) return;
      await step.do('settle lifecycle implement', QUICK, async () => {
        if (detail) {
          await completeLifecycleStage(stageRunId, 'implement', success, {
            kind: outcome,
            featureId,
            detail,
          });
          return;
        }
        await completeLifecycleStage(stageRunId, 'implement', success, {
          kind: outcome,
          featureId,
        });
      });
    };

    try {
      // Load, guard, and flip to 'generating'. NonRetryableError for
      // business-invalid states so the engine doesn't burn retries on them.
      const ctx = await step.do(
        'load feature and mark generating',
        QUICK,
        async (): Promise<RunContext | null> => {
          const feature = await getFeature(featureId);
          if (!feature) throw new NonRetryableError(`feature ${featureId} not found`);
          if (feature.status === 'pr_opened') return null; // duplicate instance — no-op
          const repo = await getRepoById(feature.repository_id);
          if (!repo || !repo.enabled) {
            await updateFeature(featureId, {
              status: 'failed',
              error: 'repository missing or disabled',
            });
            await notifyFeatureLive(featureId);
            return null;
          }
          let base: string;
          if (repo.provider === 'artifacts') {
            // Artifacts repos carry their default branch in PostgreSQL — there is no
            // forge API to ask, and installationToken would reject the
            // synthetic installation id.
            base = repo.default_branch ?? 'main';
          } else {
            const token = await installationToken(repo.installation_id);
            // SAFETY: GitHub's get-repository endpoint always includes
            // default_branch in its success response.
            const info = (await (await gh(token, `/repos/${repo.owner}/${repo.name}`)).json()) as {
              default_branch: string;
            };
            base = info.default_branch;
          }
          const skills = await listEnabledSkillsForRepo(repo.id);
          await updateFeature(featureId, { status: 'generating', runStartedAt: 'now' });
          return {
            featureId,
            owner: repo.owner,
            name: repo.name,
            installationId: repo.installation_id,
            repositoryId: repo.id,
            base,
            branch: branchName(feature),
            checkCommand: repo.check_command,
            runnerModel: feature.runner_model,
            title: feature.title,
            spec: feature.spec,
            authorLogin: feature.author_login,
            authorId: feature.author_id,
            coauthorLogin: feature.coauthor_login,
            coauthorId: feature.coauthor_id,
            acceptance: feature.acceptance !== null,
            tier: feature.tier === 'trivial' ? 'trivial' : 'standard',
            skills,
            workflows: authorizesWorkflowFiles(feature.spec),
            remoteSource: remoteSourceOf(repo),
          };
        },
      );
      if (!ctx) {
        const current = await step.do('load skipped feature outcome', QUICK, () =>
          getFeature(featureId),
        );
        const published = current?.status === 'pr_opened' && current.change_id !== null;
        await settleLifecycle(published, published ? 'pr_already_opened' : 'generation_skipped');
        return 'skipped';
      }
      const full = `${ctx.owner}/${ctx.name}`;
      const label = `${full} feature #${featureId}`;

      const WORK = workDir(featureId);
      await step.do(
        'prepare working copy',
        { retries: { limit: 3, delay: '1 minute', backoff: 'exponential' }, timeout: '8 minutes' },
        async () => {
          await updateFeature(featureId, { runStartedAt: 'now' }); // heartbeat for the strand sweep
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

      // Install dependencies up front so the agent can run the repo's check
      // command while it works instead of flying blind until the post-run
      // check (and so the repair loop's re-checks don't each pay an install).
      if (ctx.checkCommand) {
        await step.do(
          'install dependencies',
          { retries: { limit: 1, delay: '30 seconds' }, timeout: '12 minutes' },
          async () => {
            await updateFeature(featureId, { runStartedAt: 'now' });
            const failure = await installDependencies(sandboxFor(ctx), WORK);
            if (failure) {
              console.warn(`turbodiff: dependency preinstall failed for ${label}: ${failure}`);
            }
          },
        );
      }

      // THE paid step. retries.limit 1 = at most two agent runs per
      // instance, ever. Memoization means success is never re-bought.
      const agentRan = await step.do(
        'run coding agent',
        { retries: { limit: 1, delay: '5 minutes' }, timeout: AGENT_STEP_TIMEOUT[ctx.tier] },
        async (): Promise<{
          changed: boolean;
          usage: CliUsage | null;
          sessionId: string | null;
        }> => {
          await updateFeature(featureId, { runStartedAt: 'now' });
          const auth = resolveRunnerAuth(undefined, ctx.runnerModel);
          // The git/installation tokens live in other steps' scopes, not this
          // one — only the runner credential can appear in this step's output.
          const scrub = (s: string) => redactSecrets(s, Object.values(auth.vars));
          const sandbox = sandboxFor(ctx);
          await mountSkills(sandbox, WORK, ctx.skills);
          await sandbox.writeFile(specFile(featureId), generationPrompt(ctx));
          // stream-json (requires --verbose headless) captures every turn,
          // not just the final result — persisted below so a sandbox run can
          // be compared against a local session turn by turn.
          const agent = await sandbox.exec(
            `claude -p --dangerously-skip-permissions --output-format stream-json --verbose < ${specFile(featureId)}`,
            {
              cwd: WORK,
              timeout: AGENT_TIMEOUT_MS[ctx.tier],
              env: runnerEnvironment(auth, NPM_CACHE_ENV),
            },
          );
          const usage = parseClaudeCliUsage(agent.stdout);
          const resultText = claudeCliResultText(agent.stdout);
          await persistAgentLog(
            'generate',
            scrub(`${resultText}\n${agent.stderr}`.trim()),
            agent.success,
            { featureId },
            scrub(agent.stdout),
          );
          if (!agent.success) {
            // Scrubbed: this message persists to features.error and renders
            // in the dashboard for every installation member.
            throw new Error(
              `generation agent exited ${agent.exitCode}: ${scrub(`${resultText}\n${agent.stderr}`.trim()).slice(-1_000)}`,
            );
          }
          return {
            changed: await worktreeChanged(sandbox, WORK),
            usage,
            sessionId: claudeCliSessionId(agent.stdout),
          };
        },
      );

      if (!agentRan.changed) {
        await step.do('record no_changes', QUICK, async () => {
          await updateFeature(featureId, {
            status: 'no_changes',
            error: 'agent produced no file changes',
            usage: agentRan.usage ?? undefined,
          });
          await notifyFeatureLive(featureId);
        });
        await settleLifecycle(false, 'no_changes', 'agent produced no file changes');
        return 'no_changes';
      }

      // Attribution: instructing user is the git author (bot stays
      // committer), coauthor rides as a trailer — on the main commit and any
      // repair commits alike.
      const author =
        ctx.authorLogin && ctx.authorId !== null
          ? { login: ctx.authorLogin, id: ctx.authorId }
          : null;
      const coauthor =
        ctx.coauthorLogin && ctx.coauthorId !== null
          ? { login: ctx.coauthorLogin, id: ctx.coauthorId }
          : null;

      await step.do('commit', QUICK, async () => {
        // Commit BEFORE checks so check-command working-tree mutations never
        // leak into the pushed commit.
        const sandbox = sandboxFor(ctx);
        const commit = await sandbox.exec(
          `git -C ${WORK} add -A && git -C ${WORK} commit -m "$COMMIT_MSG"`,
          {
            env: {
              COMMIT_MSG:
                `${ctx.title} (turbodiff generator, feature #${featureId})` +
                coauthorTrailer(coauthor),
              ...gitAuthorEnv(author),
            },
            timeout: 60_000,
          },
        );
        if (!commit.success) throw new Error(`git commit failed: ${commit.stderr.slice(0, 500)}`);
      });

      let totalUsage = agentRan.usage;

      if (ctx.checkCommand) {
        // A failing check command is a business outcome, not an infra error —
        // returned, never thrown, so the step is never retried for it. The
        // tail is sized for the repair prompt to see the actual errors;
        // features.error gets a shorter slice below.
        const runCheck = (name: string) =>
          step.do(
            name,
            { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' },
            async (): Promise<{ ok: boolean; output: string }> => {
              await updateFeature(featureId, { runStartedAt: 'now' });
              const res = await sandboxFor(ctx).exec(ctx.checkCommand!, {
                cwd: WORK,
                timeout: CHECK_TIMEOUT_MS,
                env: NPM_CACHE_ENV,
              });
              return {
                ok: res.success,
                output: `${res.stdout}\n${res.stderr}`.trim().slice(-6_000),
              };
            },
          );

        let checks = await runCheck('run check command');
        let sessionId = agentRan.sessionId;
        for (let round = 1; !checks.ok && round <= REPAIR_ROUNDS; round++) {
          const repair = await step.do(
            `repair check failures (round ${round})`,
            { retries: { limit: 1, delay: '2 minutes' }, timeout: '18 minutes' },
            async (): Promise<{
              ok: boolean;
              changed: boolean;
              usage: CliUsage | null;
              sessionId: string | null;
            }> => {
              await updateFeature(featureId, { runStartedAt: 'now' });
              const auth = resolveRunnerAuth(undefined, ctx.runnerModel);
              const scrub = (s: string) => redactSecrets(s, Object.values(auth.vars));
              const sandbox = sandboxFor(ctx);
              // Drop check-command working-tree mutations before the agent
              // looks: tracked files reset to the agent's own commit, and
              // untracked check artifacts (non-ignored only) go with them.
              await sandbox.exec(`git -C ${WORK} checkout -- . && git -C ${WORK} clean -fd`);
              await sandbox.writeFile(
                repairFile(featureId, round),
                repairPrompt(ctx, checks.output, sessionId === null),
              );
              // --resume continues the run that made the changes with its
              // full context intact (each resume prints a fresh session id,
              // carried forward for the next round). No id — a killed run
              // that never printed its result payload — falls back to a
              // fresh session pointed at the spec file.
              const baseEnv = runnerEnvironment(auth, NPM_CACHE_ENV);
              const agentEnv = sessionId ? { ...baseEnv, RESUME_SESSION: sessionId } : baseEnv;
              const agent = await sandbox.exec(
                `claude -p ${sessionId ? '--resume "$RESUME_SESSION" ' : ''}` +
                  `--dangerously-skip-permissions --output-format stream-json --verbose < ${repairFile(featureId, round)}`,
                { cwd: WORK, timeout: REPAIR_TIMEOUT_MS, env: agentEnv },
              );
              const usage = parseClaudeCliUsage(agent.stdout);
              await persistAgentLog(
                'generate',
                scrub(`${claudeCliResultText(agent.stdout)}\n${agent.stderr}`.trim()),
                agent.success,
                { featureId },
                scrub(agent.stdout),
              );
              // A failed repair run ends the loop, not the workflow — the
              // check verdict (checks_failed) is the recorded outcome.
              if (!agent.success) return { ok: false, changed: false, usage, sessionId: null };
              const status = await sandbox.exec(`git -C ${WORK} status --porcelain`);
              return {
                ok: true,
                changed: Boolean(status.stdout.trim()),
                usage,
                sessionId: claudeCliSessionId(agent.stdout),
              };
            },
          );
          totalUsage = addCliUsage(totalUsage, repair.usage);
          sessionId = repair.sessionId ?? sessionId;
          // Agent failed or found nothing to change: the last verdict stands.
          if (!repair.ok || !repair.changed) break;
          await step.do(`commit repair (round ${round})`, QUICK, async () => {
            const commit = await sandboxFor(ctx).exec(
              `git -C ${WORK} add -A && git -C ${WORK} commit -m "$COMMIT_MSG"`,
              {
                env: {
                  COMMIT_MSG:
                    `Fix check failures (turbodiff generator, feature #${featureId})` +
                    coauthorTrailer(coauthor),
                  ...gitAuthorEnv(author),
                },
                timeout: 60_000,
              },
            );
            if (!commit.success) {
              throw new Error(`repair commit failed: ${commit.stderr.slice(0, 500)}`);
            }
          });
          checks = await runCheck(`re-run check command (round ${round})`);
        }

        if (!checks.ok) {
          await step.do('record checks_failed', QUICK, async () => {
            await updateFeature(featureId, {
              status: 'checks_failed',
              error: checks.output.slice(-500),
              usage: totalUsage ?? undefined,
            });
            await notifyFeatureLive(featureId);
          });
          await settleLifecycle(false, 'checks_failed', checks.output.slice(-500));
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

      const prNumber = await step.do('open pull request', QUICK, async (): Promise<number> => {
        const sandbox = sandboxFor(ctx);
        // Concise PR body: the agent's own summary (what changed and why),
        // not a spec dump. Implementation notes ride along only when the
        // agent recorded a judgment call worth surfacing.
        const summary = await sandbox
          .readFile(prFile(featureId))
          .then((f) => f.content.trim() || undefined)
          .catch(() => undefined);
        const notes = await sandbox
          .readFile(specFile(featureId))
          .then((f) => f.content.split('## Implementation notes')[1]?.trim())
          .catch(() => undefined);
        if (ctx.remoteSource.provider === 'artifacts') {
          // Native change request instead of a GitHub PR
          // (docs/artifacts-provider.md): the CR service computes the diff,
          // records it, and queues the native review. Reaching this step
          // means the repo check command (when set) already passed.
          const repo = await getRepoById(ctx.repositoryId);
          if (!repo) throw new NonRetryableError(`repository ${ctx.repositoryId} vanished`);
          const cr = await openNativeChangeRequest({
            repo,
            featureId,
            title: ctx.title,
            sourceBranch: ctx.branch,
            targetBranch: ctx.base,
            openedBy: 'factory',
            summary:
              (summary ?? `${ctx.title} — generated change; see the diff.`) +
              (notes ? `\n\n**Implementation notes**\n\n${notes}` : ''),
            checkOutcome: ctx.checkCommand ? 'passed' : undefined,
          });
          await updateFeature(featureId, {
            status: 'pr_opened',
            branch: ctx.branch,
            prNumber: cr.number,
            changeRequestId: cr.id,
            changeId: cr.change_id ?? undefined,
            usage: totalUsage ?? undefined,
          });
          await notifyFeatureLive(featureId);
          if (ctx.acceptance && !stageRunId) {
            await enqueueFactoryMessage({ kind: 'verify', featureId });
          }
          return cr.number;
        }
        const createPr = async (authToken: string) =>
          // SAFETY: GitHub's create-pull-request endpoint returns the created
          // PR object, which always carries its number.
          (await (
            await gh(authToken, `/repos/${full}/pulls`, {
              method: 'POST',
              body: JSON.stringify({
                title: ctx.title,
                head: ctx.branch,
                base: ctx.base,
                body:
                  (summary ?? `${ctx.title} — generated change; see the diff.`) +
                  (notes
                    ? `\n\n<details><summary>Implementation notes</summary>\n\n${notes}\n\n</details>`
                    : '') +
                  `\n\n---\n_turbodiff factory · feature #${featureId}_`,
              }),
            })
          ).json()) as CreatedGithubPullRequest;
        // Open the PR AS the instructing user when their stored credential
        // can mint a token ("opened by <user>"). The bot is the fallback —
        // both when no credential exists and when the user token can't
        // create the PR (e.g. missing repo permission), so a user-token
        // problem costs one extra call, never the run.
        const userToken = ctx.authorId !== null ? await mintUserToken(ctx.authorId) : null;
        let pr: CreatedGithubPullRequest;
        if (userToken) {
          try {
            pr = await createPr(userToken);
          } catch (err) {
            console.warn(
              `turbodiff: user-token PR creation failed for feature ${featureId}, falling back to app:`,
              err,
            );
            pr = await createPr(await installationToken(ctx.installationId));
          }
        } else {
          pr = await createPr(await installationToken(ctx.installationId));
        }
        const change = await upsertChange({
          repositoryId: ctx.repositoryId,
          providerKey: changeProviderKey('github', pr.number),
          number: pr.number,
          origin: 'factory',
          title: ctx.title,
          externalUrl: pr.html_url,
          sourceBranch: pr.head.ref,
          targetBranch: pr.base.ref,
          status: 'open',
          sourceHead: pr.head.sha,
          targetHead: pr.base.sha,
          draft: false,
          capabilities: ['read_change', 'publish_review', 'write_head', 'publish_check', 'merge'],
          providerUpdatedAt: pr.updated_at,
        });
        await updateFeature(featureId, {
          status: 'pr_opened',
          branch: ctx.branch,
          prNumber: pr.number,
          changeId: change.id,
          usage: totalUsage ?? undefined,
        });
        await notifyFeatureLive(featureId);
        // Phase 4: acceptance criteria get an empirical verification run.
        if (ctx.acceptance && !stageRunId) {
          await enqueueFactoryMessage({ kind: 'verify', featureId });
        }
        return pr.number;
      });

      await step.do(
        'clean workspace',
        { retries: { limit: 1, delay: '10 seconds' }, timeout: '2 minutes' },
        async () => {
          // Bound the warm container's disk: drop this feature's working copy
          // and prompt files; the shared repo/package caches stay.
          await sandboxFor(ctx)
            .exec(
              `rm -rf ${WORK} ${specFile(featureId)} ${prFile(featureId)} ` +
                `/workspace/gen-repair-${featureId}-*.md`,
            )
            .catch(() => {});
        },
      );

      console.log(`turbodiff: generation pr_opened for ${label} (PR #${prNumber})`);
      await settleLifecycle(true, 'change_published');
      return 'pr_opened';
    } catch (err) {
      // Terminal failure (a step exhausted its retries, or a
      // NonRetryableError). Recording it is itself a durable step, so the
      // feature can never strand in 'generating' just because PostgreSQL blinked.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await step.do(
        'record failure',
        {
          retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
          timeout: '2 minutes',
        },
        async () => {
          await updateFeature(featureId, { status: 'failed', error: message });
          await notifyFeatureLive(featureId);
        },
      );
      console.error(`turbodiff: generation workflow failed for feature ${featureId}:`, err);
      await settleLifecycle(false, 'generation_failed', message);
      return 'failed';
    }
  }
}

// Entry point used by the queue consumer (and, transitively, every retry
// path). Cheap guards against duplicate instances; the workflow re-checks in
// its first step.
export async function startGeneration(message: GenerateQueueMessage): Promise<void> {
  const { featureId, factoryRunId, stageRunId } = message;
  const feature = await getFeature(featureId);
  if (!feature) {
    console.warn(`turbodiff: generation skipped, feature ${featureId} not found`);
    return;
  }
  if (feature.status === 'pr_opened') {
    console.log(`turbodiff: generation skipped for feature ${featureId} — PR already opened`);
    if (stageRunId) {
      await completeLifecycleStage(stageRunId, 'implement', feature.change_id !== null, {
        kind: 'pr_already_opened',
        featureId,
      });
    }
    return;
  }
  const startedMs = feature.run_started_at ? parseUtc(feature.run_started_at) : 0;
  // A live instance heartbeats runStartedAt from its steps; fresh = in flight.
  if (feature.status === 'generating' && Date.now() - startedMs < 45 * 60_000) {
    console.log(
      `turbodiff: generation skipped for feature ${featureId} — an instance is in flight`,
    );
    if (stageRunId) {
      await completeLifecycleStage(stageRunId, 'implement', false, {
        kind: 'generation_already_in_flight',
        featureId,
      });
    }
    return;
  }
  await env.GEN_WORKFLOW.create({
    id: `gen-${featureId}-${Date.now()}`,
    params: { featureId, factoryRunId, stageRunId },
  });
}
