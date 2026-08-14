import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { gh } from '../tools/github.ts';
import { persistAgentLog } from './agent-runs.ts';
import { coauthorTrailer, gitAuthorEnv } from './attribution.ts';
import { claudeCliResultText, parseClaudeCliUsage, type CliUsage } from './cli-usage.ts';
import {
  getFeature,
  getRepoById,
  listEnabledSkillsForRepo,
  updateFeature,
  type FeatureRow,
  type SkillRow,
} from './db.ts';
import { resolveRunnerAuth } from './fixer.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';
import { skillMarkdown } from './skill-files.ts';
import { mintUserToken } from './user-tokens.ts';

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
export const NPM_CACHE_ENV = {
  npm_config_cache: '/workspace/.npm-cache',
  npm_config_store_dir: '/workspace/.pnpm-store',
};
const workDir = (featureId: number) => `/workspace/gen-${featureId}`;
const specFile = (featureId: number) => `/workspace/gen-spec-${featureId}.md`;
const prFile = (featureId: number) => `/workspace/gen-pr-${featureId}.md`;
// Agent exec budgets by tier — trivial requests don't get to burn a
// feature-sized window. Step timeouts sit slightly above so the exec timeout
// (a clean, attributable failure) fires before the step timeout does.
const AGENT_TIMEOUT_MS = { trivial: 8 * 60_000, standard: 25 * 60_000 };
const AGENT_STEP_TIMEOUT = { trivial: '10 minutes', standard: '28 minutes' } as const;
const CHECK_TIMEOUT_MS = 12 * 60_000;

export interface GenQueueMessage {
  kind: 'generate';
  featureId: number;
  // Legacy field from the pre-workflow retry loop; ignored.
  attempt?: number;
}

export type GenerationParams = {
  featureId: number;
};

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
- Do NOT run dependency installs, builds, or test suites unless the change itself
  requires it — the harness runs the repository's check command after you finish,
  and a separate verification phase checks the acceptance criteria empirically.
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

function sandboxFor(repo: { owner: string; name: string }): Sandbox {
  return getSandbox(
    env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
    `gen--${repo.owner}--${repo.name}`.toLowerCase(),
    { sleepAfter: '45m' },
  ) as unknown as Sandbox;
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
  title: string;
  spec: string;
  authorLogin: string | null;
  authorId: number | null;
  coauthorLogin: string | null;
  coauthorId: number | null;
  acceptance: boolean;
  tier: 'trivial' | 'standard';
  skills: SkillRow[];
};

const QUICK = {
  retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class GenerationWorkflow extends WorkflowEntrypoint<unknown, GenerationParams> {
  async run(event: WorkflowEvent<GenerationParams>, step: WorkflowStep): Promise<string> {
    const { featureId } = event.payload;

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
            return null;
          }
          const token = await installationToken(repo.installation_id);
          const info = (await (await gh(token, `/repos/${repo.owner}/${repo.name}`)).json()) as {
            default_branch: string;
          };
          const skills = await listEnabledSkillsForRepo(repo.id);
          await updateFeature(featureId, { status: 'generating', runStartedAt: 'now' });
          return {
            featureId,
            owner: repo.owner,
            name: repo.name,
            installationId: repo.installation_id,
            repositoryId: repo.id,
            base: info.default_branch,
            branch: branchName(feature),
            checkCommand: repo.check_command,
            title: feature.title,
            spec: feature.spec,
            authorLogin: feature.author_login,
            authorId: feature.author_id,
            coauthorLogin: feature.coauthor_login,
            coauthorId: feature.coauthor_id,
            acceptance: feature.acceptance !== null,
            tier: feature.tier === 'trivial' ? 'trivial' : 'standard',
            skills,
          };
        },
      );
      if (!ctx) return 'skipped';
      const full = `${ctx.owner}/${ctx.name}`;
      const label = `${full} feature #${featureId}`;

      const WORK = workDir(featureId);
      await step.do(
        'prepare working copy',
        { retries: { limit: 3, delay: '1 minute', backoff: 'exponential' }, timeout: '8 minutes' },
        async () => {
          await updateFeature(featureId, { runStartedAt: 'now' }); // heartbeat for the strand sweep
          const gitToken = await sandboxGitToken(ctx.installationId, ctx.name, 'write');
          const sandbox = sandboxFor(ctx);
          // Warm path: update the shared per-repo cache (fetch, seconds) or
          // cold-clone it once; then a local hardlink clone into this
          // feature's own directory. Credentials only ever travel via env to
          // explicit-URL commands — nothing credentialed persists on disk.
          const sync = await sandbox.exec(
            `if [ -d ${CACHE_DIR}/.git ]; then ` +
              `git -C ${CACHE_DIR} fetch --depth 50 "https://x-access-token:$GIT_TOKEN@github.com/${full}.git" "$GEN_BASE" && ` +
              `git -C ${CACHE_DIR} checkout -q -B "$GEN_BASE" FETCH_HEAD; ` +
              `else git clone --depth 50 --single-branch --branch "$GEN_BASE" ` +
              `"https://x-access-token:$GIT_TOKEN@github.com/${full}.git" ${CACHE_DIR} && ` +
              `git -C ${CACHE_DIR} remote set-url origin "https://github.com/${full}.git"; fi`,
            { env: { GIT_TOKEN: gitToken, GEN_BASE: ctx.base }, timeout: 5 * 60_000 },
          );
          if (!sync.success) {
            // A corrupted cache must never wedge the repo — drop it for next time.
            await sandbox.exec(`rm -rf ${CACHE_DIR}`).catch(() => {});
            throw new Error(
              `repo cache sync failed: ${sync.stderr.replaceAll(gitToken, '***').slice(0, 500)}`,
            );
          }
          const clone = await sandbox.exec(
            `rm -rf ${WORK} && git clone --local ${CACHE_DIR} ${WORK} && ` +
              `git -C ${WORK} checkout -q -b "$GEN_BRANCH" && ` +
              `git -C ${WORK} config user.name "turbodiff[bot]" && ` +
              `git -C ${WORK} config user.email "turbodiff[bot]@users.noreply.github.com"`,
            { env: { GEN_BRANCH: ctx.branch }, timeout: 2 * 60_000 },
          );
          if (!clone.success) {
            throw new Error(`working-copy clone failed: ${clone.stderr.slice(0, 500)}`);
          }
        },
      );

      // THE paid step. retries.limit 1 = at most two agent runs per
      // instance, ever. Memoization means success is never re-bought.
      const agentRan = await step.do(
        'run coding agent',
        { retries: { limit: 1, delay: '5 minutes' }, timeout: AGENT_STEP_TIMEOUT[ctx.tier] },
        async (): Promise<{ changed: boolean; usage: CliUsage | null }> => {
          await updateFeature(featureId, { runStartedAt: 'now' });
          const auth = resolveRunnerAuth();
          // The git/installation tokens live in other steps' scopes, not this
          // one — only the runner credential can appear in this step's output.
          const scrub = (s: string) =>
            Object.values(auth.vars).reduce((acc, v) => acc.replaceAll(v, '***'), s);
          const sandbox = sandboxFor(ctx);
          for (const skill of ctx.skills) {
            const dir = `${WORK}/.claude/skills/${skill.slug}`;
            await sandbox.exec(`mkdir -p ${dir}`);
            await sandbox.writeFile(`${dir}/SKILL.md`, skillMarkdown(skill));
          }
          await sandbox.writeFile(specFile(featureId), generationPrompt(ctx));
          const agent = await sandbox.exec(
            `claude -p --dangerously-skip-permissions --output-format json < ${specFile(featureId)}`,
            {
              cwd: WORK,
              timeout: AGENT_TIMEOUT_MS[ctx.tier],
              env: {
                ...auth.vars,
                ...NPM_CACHE_ENV,
                IS_SANDBOX: '1',
                DISABLE_AUTOUPDATER: '1',
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              },
            },
          );
          const usage = parseClaudeCliUsage(agent.stdout);
          const resultText = claudeCliResultText(agent.stdout);
          await persistAgentLog(
            'generate',
            scrub(`${resultText}\n${agent.stderr}`.trim()),
            agent.success,
            { featureId },
          );
          if (!agent.success) {
            // Scrubbed: this message persists to features.error and renders
            // in the dashboard for every installation member.
            throw new Error(
              `generation agent exited ${agent.exitCode}: ${scrub(`${resultText}\n${agent.stderr}`.trim()).slice(-1_000)}`,
            );
          }
          const status = await sandbox.exec(`git -C ${WORK} status --porcelain`);
          return { changed: Boolean(status.stdout.trim()), usage };
        },
      );

      if (!agentRan.changed) {
        await step.do('record no_changes', QUICK, async () => {
          await updateFeature(featureId, {
            status: 'no_changes',
            error: 'agent produced no file changes',
            usage: agentRan.usage ?? undefined,
          });
        });
        return 'no_changes';
      }

      await step.do('commit', QUICK, async () => {
        // Commit BEFORE checks so check-command working-tree mutations never
        // leak into the pushed commit. Attribution: instructing user is the
        // git author (bot stays committer), coauthor rides as a trailer.
        const author =
          ctx.authorLogin && ctx.authorId !== null
            ? { login: ctx.authorLogin, id: ctx.authorId }
            : null;
        const coauthor =
          ctx.coauthorLogin && ctx.coauthorId !== null
            ? { login: ctx.coauthorLogin, id: ctx.coauthorId }
            : null;
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

      if (ctx.checkCommand) {
        const checks = await step.do(
          'run check command',
          { retries: { limit: 1, delay: '1 minute' }, timeout: '15 minutes' },
          async (): Promise<{ ok: boolean; output: string }> => {
            await updateFeature(featureId, { runStartedAt: 'now' });
            const sandbox = sandboxFor(ctx);
            const res = await sandbox.exec(ctx.checkCommand!, {
              cwd: WORK,
              timeout: CHECK_TIMEOUT_MS,
              env: NPM_CACHE_ENV,
            });
            // A failing check command is a business outcome, not an infra
            // error — return it so the step is never retried for it.
            return { ok: res.success, output: `${res.stdout}\n${res.stderr}`.trim().slice(-500) };
          },
        );
        if (!checks.ok) {
          await step.do('record checks_failed', QUICK, async () => {
            await updateFeature(featureId, {
              status: 'checks_failed',
              error: checks.output,
              usage: agentRan.usage ?? undefined,
            });
          });
          return 'checks_failed';
        }
      }

      await step.do('push branch', QUICK, async () => {
        const gitToken = await sandboxGitToken(ctx.installationId, ctx.name, 'write');
        const sandbox = sandboxFor(ctx);
        const push = await sandbox.exec(
          `git -C ${WORK} push "https://x-access-token:$GIT_TOKEN@github.com/${full}.git" HEAD:"$GEN_BRANCH"`,
          { env: { GIT_TOKEN: gitToken, GEN_BRANCH: ctx.branch }, timeout: 3 * 60_000 },
        );
        if (!push.success) {
          throw new Error(
            `git push failed: ${push.stderr.replaceAll(gitToken, '***').slice(0, 500)}`,
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
        const createPr = async (authToken: string) =>
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
          ).json()) as { number: number };
        // Open the PR AS the instructing user when their stored credential
        // can mint a token ("opened by <user>"). The bot is the fallback —
        // both when no credential exists and when the user token can't
        // create the PR (e.g. missing repo permission), so a user-token
        // problem costs one extra call, never the run.
        const userToken = ctx.authorId !== null ? await mintUserToken(ctx.authorId) : null;
        let pr: { number: number };
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
        await updateFeature(featureId, {
          status: 'pr_opened',
          branch: ctx.branch,
          prNumber: pr.number,
          usage: agentRan.usage ?? undefined,
        });
        // Phase 4: acceptance criteria get an empirical verification run.
        if (ctx.acceptance) await env.FACTORY_QUEUE.send({ kind: 'verify', featureId });
        return pr.number;
      });

      await step.do(
        'clean workspace',
        { retries: { limit: 1, delay: '10 seconds' }, timeout: '2 minutes' },
        async () => {
          // Bound the warm container's disk: drop this feature's working copy
          // and prompt files; the shared repo/package caches stay.
          await sandboxFor(ctx)
            .exec(`rm -rf ${WORK} ${specFile(featureId)} ${prFile(featureId)}`)
            .catch(() => {});
        },
      );

      console.log(`turbodiff: generation pr_opened for ${label} (PR #${prNumber})`);
      return 'pr_opened';
    } catch (err) {
      // Terminal failure (a step exhausted its retries, or a
      // NonRetryableError). Recording it is itself a durable step, so the
      // feature can never strand in 'generating' just because D1 blinked.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await step.do(
        'record failure',
        {
          retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
          timeout: '2 minutes',
        },
        async () => {
          await updateFeature(featureId, { status: 'failed', error: message });
        },
      );
      console.error(`turbodiff: generation workflow failed for feature ${featureId}:`, err);
      return 'failed';
    }
  }
}

// Entry point used by the queue consumer (and, transitively, every retry
// path). Cheap guards against duplicate instances; the workflow re-checks in
// its first step.
export async function startGeneration(featureId: number): Promise<void> {
  const feature = await getFeature(featureId);
  if (!feature) {
    console.warn(`turbodiff: generation skipped, feature ${featureId} not found`);
    return;
  }
  if (feature.status === 'pr_opened') {
    console.log(`turbodiff: generation skipped for feature ${featureId} — PR already opened`);
    return;
  }
  const startedMs = feature.run_started_at
    ? Date.parse(`${feature.run_started_at.replace(' ', 'T')}Z`)
    : 0;
  // A live instance heartbeats runStartedAt from its steps; fresh = in flight.
  if (feature.status === 'generating' && Date.now() - startedMs < 45 * 60_000) {
    console.log(
      `turbodiff: generation skipped for feature ${featureId} — an instance is in flight`,
    );
    return;
  }
  await env.GEN_WORKFLOW.create({ id: `gen-${featureId}-${Date.now()}`, params: { featureId } });
}
