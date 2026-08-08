import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { gh } from '../tools/github.ts';
import { coauthorTrailer, gitAuthorEnv } from './attribution.ts';
import { getFeature, getRepoById, updateFeature, type FeatureRow, type RepositoryRow } from './db.ts';
import { resolveRunnerAuth } from './fixer.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';

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

const CLONE_DIR = '/workspace/gen';
const SPEC_FILE = '/workspace/gen-spec.md';
// The agent's exec budget — the point of the workflow move. The step timeout
// is set slightly above it so the exec timeout (a clean, attributable
// failure) fires before the step timeout does.
const AGENT_TIMEOUT_MS = 25 * 60_000;
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

function generationPrompt(feature: FeatureRow, repo: RepositoryRow): string {
	return `You are an automated implementation agent working in a fresh checkout of ${repo.owner}/${repo.name}.

Implement the feature specified below. Rules:
- Implement exactly what the spec describes — no scope creep, no drive-by refactors.
- Match the repository's existing conventions: style, structure, naming, idioms.
- If the repository has an established testing pattern, add or update tests for
  the new behavior in that same pattern.
- Do NOT run git commit or git push; the harness handles git.
- If part of the spec is ambiguous, choose the most conventional interpretation
  and note the choice in a "## Implementation notes" section you append to
  ${SPEC_FILE}.

${UNTRUSTED_CONTENT_RULES}

## Feature: ${feature.title}

${feature.spec}
`;
}

function sandboxFor(repo: { owner: string; name: string }, featureId: number): Sandbox {
	return getSandbox(
		env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
		`gen--${repo.owner}--${repo.name}--${featureId}`.toLowerCase(),
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
			const ctx = await step.do('load feature and mark generating', QUICK, async (): Promise<RunContext | null> => {
				const feature = await getFeature(featureId);
				if (!feature) throw new NonRetryableError(`feature ${featureId} not found`);
				if (feature.status === 'pr_opened') return null; // duplicate instance — no-op
				const repo = await getRepoById(feature.repository_id);
				if (!repo || !repo.enabled) {
					await updateFeature(featureId, { status: 'failed', error: 'repository missing or disabled' });
					return null;
				}
				const token = await installationToken(repo.installation_id);
				const info = (await (await gh(token, `/repos/${repo.owner}/${repo.name}`)).json()) as {
					default_branch: string;
				};
				await updateFeature(featureId, { status: 'generating', runStartedAt: 'now' });
				return {
					featureId,
					owner: repo.owner,
					name: repo.name,
					installationId: repo.installation_id,
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
				};
			});
			if (!ctx) return 'skipped';
			const full = `${ctx.owner}/${ctx.name}`;
			const label = `${full} feature #${featureId}`;

			await step.do('clone into sandbox', { retries: { limit: 3, delay: '1 minute', backoff: 'exponential' }, timeout: '8 minutes' }, async () => {
				await updateFeature(featureId, { runStartedAt: 'now' }); // heartbeat for the strand sweep
				const gitToken = await sandboxGitToken(ctx.installationId, ctx.name, 'write');
				const sandbox = sandboxFor(ctx, featureId);
				await sandbox.exec(`rm -rf ${CLONE_DIR}`);
				const clone = await sandbox.exec(
					`git clone --depth 50 --single-branch --branch "$GEN_BASE" ` +
						`"https://x-access-token:$GIT_TOKEN@github.com/${full}.git" ${CLONE_DIR} && ` +
						`git -C ${CLONE_DIR} checkout -b "$GEN_BRANCH" && ` +
						`git -C ${CLONE_DIR} config user.name "turbodiff[bot]" && ` +
						`git -C ${CLONE_DIR} config user.email "turbodiff[bot]@users.noreply.github.com"`,
					{ env: { GIT_TOKEN: gitToken, GEN_BASE: ctx.base, GEN_BRANCH: ctx.branch }, timeout: 5 * 60_000 },
				);
				// Never leave the credentialed remote behind, even on failure paths.
				await sandbox
					.exec(`git -C ${CLONE_DIR} remote set-url origin "https://github.com/${full}.git"`)
					.catch(() => {});
				if (!clone.success) {
					throw new Error(`git clone failed: ${clone.stderr.replaceAll(gitToken, '***').slice(0, 500)}`);
				}
			});

			// THE paid step. retries.limit 1 = at most two agent runs per
			// instance, ever. Memoization means success is never re-bought.
			const agentRan = await step.do(
				'run coding agent',
				{ retries: { limit: 1, delay: '5 minutes' }, timeout: '28 minutes' },
				async (): Promise<{ changed: boolean }> => {
					await updateFeature(featureId, { runStartedAt: 'now' });
					const auth = resolveRunnerAuth();
					const sandbox = sandboxFor(ctx, featureId);
					const feature = { title: ctx.title, spec: ctx.spec } as FeatureRow;
					const repo = { owner: ctx.owner, name: ctx.name } as RepositoryRow;
					await sandbox.writeFile(SPEC_FILE, generationPrompt(feature, repo));
					const agent = await sandbox.exec(
						`claude -p --dangerously-skip-permissions --output-format text < ${SPEC_FILE}`,
						{
							cwd: CLONE_DIR,
							timeout: AGENT_TIMEOUT_MS,
							env: {
								...auth.vars,
								IS_SANDBOX: '1',
								DISABLE_AUTOUPDATER: '1',
								CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
							},
						},
					);
					if (!agent.success) {
						throw new Error(
							`generation agent exited ${agent.exitCode}: ${`${agent.stdout}\n${agent.stderr}`.trim().slice(-1_000)}`,
						);
					}
					const status = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
					return { changed: Boolean(status.stdout.trim()) };
				},
			);

			if (!agentRan.changed) {
				await step.do('record no_changes', QUICK, async () => {
					await updateFeature(featureId, { status: 'no_changes', error: 'agent produced no file changes' });
				});
				return 'no_changes';
			}

			await step.do('commit', QUICK, async () => {
				// Commit BEFORE checks so check-command working-tree mutations never
				// leak into the pushed commit. Attribution: instructing user is the
				// git author (bot stays committer), coauthor rides as a trailer.
				const author =
					ctx.authorLogin && ctx.authorId !== null ? { login: ctx.authorLogin, id: ctx.authorId } : null;
				const coauthor =
					ctx.coauthorLogin && ctx.coauthorId !== null
						? { login: ctx.coauthorLogin, id: ctx.coauthorId }
						: null;
				const sandbox = sandboxFor(ctx, featureId);
				const commit = await sandbox.exec(
					`git -C ${CLONE_DIR} add -A && git -C ${CLONE_DIR} commit -m "$COMMIT_MSG"`,
					{
						env: {
							COMMIT_MSG:
								`${ctx.title} (turbodiff generator, feature #${featureId})` + coauthorTrailer(coauthor),
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
						const sandbox = sandboxFor(ctx, featureId);
						const res = await sandbox.exec(ctx.checkCommand!, { cwd: CLONE_DIR, timeout: CHECK_TIMEOUT_MS });
						// A failing check command is a business outcome, not an infra
						// error — return it so the step is never retried for it.
						return { ok: res.success, output: `${res.stdout}\n${res.stderr}`.trim().slice(-500) };
					},
				);
				if (!checks.ok) {
					await step.do('record checks_failed', QUICK, async () => {
						await updateFeature(featureId, { status: 'checks_failed', error: checks.output });
					});
					return 'checks_failed';
				}
			}

			await step.do('push branch', QUICK, async () => {
				const gitToken = await sandboxGitToken(ctx.installationId, ctx.name, 'write');
				const sandbox = sandboxFor(ctx, featureId);
				const push = await sandbox.exec(
					`git -C ${CLONE_DIR} push "https://x-access-token:$GIT_TOKEN@github.com/${full}.git" HEAD:"$GEN_BRANCH"`,
					{ env: { GIT_TOKEN: gitToken, GEN_BRANCH: ctx.branch }, timeout: 3 * 60_000 },
				);
				if (!push.success) {
					throw new Error(`git push failed: ${push.stderr.replaceAll(gitToken, '***').slice(0, 500)}`);
				}
			});

			const prNumber = await step.do('open pull request', QUICK, async (): Promise<number> => {
				const sandbox = sandboxFor(ctx, featureId);
				// The agent may have appended implementation notes to the spec file.
				const notes = await sandbox
					.readFile(SPEC_FILE)
					.then((f) => f.content.split('## Implementation notes')[1]?.trim())
					.catch(() => undefined);
				const token = await installationToken(ctx.installationId);
				const pr = (await (
					await gh(token, `/repos/${full}/pulls`, {
						method: 'POST',
						body: JSON.stringify({
							title: ctx.title,
							head: ctx.branch,
							base: ctx.base,
							body:
								`Generated by the turbodiff software factory (feature #${featureId}).\n\n` +
								`## Spec\n\n${ctx.spec}` +
								(notes ? `\n\n## Implementation notes\n\n${notes}` : ''),
						}),
					})
				).json()) as { number: number };
				await updateFeature(featureId, { status: 'pr_opened', branch: ctx.branch, prNumber: pr.number });
				// Phase 4: acceptance criteria get an empirical verification run.
				if (ctx.acceptance) await env.FACTORY_QUEUE.send({ kind: 'verify', featureId });
				return pr.number;
			});

			console.log(`turbodiff: generation pr_opened for ${label} (PR #${prNumber})`);
			return 'pr_opened';
		} catch (err) {
			// Terminal failure (a step exhausted its retries, or a
			// NonRetryableError). Recording it is itself a durable step, so the
			// feature can never strand in 'generating' just because D1 blinked.
			const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
			await step.do('record failure', { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
				await updateFeature(featureId, { status: 'failed', error: message });
			});
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
		console.log(`turbodiff: generation skipped for feature ${featureId} — an instance is in flight`);
		return;
	}
	await env.GEN_WORKFLOW.create({ id: `gen-${featureId}-${Date.now()}`, params: { featureId } });
}
