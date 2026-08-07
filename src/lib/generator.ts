import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import { coauthorTrailer, gitAuthorEnv } from './attribution.ts';
import { getFeature, getRepoById, updateFeature, type FeatureRow, type RepositoryRow } from './db.ts';
import { resolveRunnerAuth } from './fixer.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';

// Phase 2 of the software factory (docs/software-factory-design.md): turn an
// approved feature spec into a branch + PR. The generator clones the default
// branch into a sandbox, runs the coding agent against the spec, pushes a
// feature branch, and opens the PR — from there the existing review and
// auto-fix loop take over via webhooks.

const CLONE_DIR = '/workspace/gen';
const SPEC_FILE = '/workspace/gen-spec.md';
// Clone (2) + agent (8) + checks (4) + push (1) must fit inside a queue
// consumer's 15-minute wall clock.
const AGENT_TIMEOUT_MS = 8 * 60_000;
const CHECK_TIMEOUT_MS = 4 * 60_000;

export interface GenQueueMessage {
	kind: 'generate';
	featureId: number;
	// Platform-interruption retry counter (see PLATFORM_INTERRUPTION below);
	// absent on first delivery.
	attempt?: number;
}

// Sandbox infrastructure failures outside our control — a runtime rollout
// interrupting exec, or the sandbox client's bare 5xx. These are transient:
// instead of failing the feature, the run re-enqueues itself with a delay so
// it lands after the platform settles. Bounded by GEN_PLATFORM_RETRIES.
const PLATFORM_INTERRUPTION = /interrupted while the platform|HTTP error! status: 5\d\d/i;
const GEN_PLATFORM_RETRIES = 3;
const GEN_RETRY_DELAY_S = 600;

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

export async function runGeneration(featureId: number, attempt = 0): Promise<void> {
	const feature = await getFeature(featureId);
	if (!feature) {
		console.warn(`turbodiff: generation skipped, feature ${featureId} not found`);
		return;
	}
	const repo = await getRepoById(feature.repository_id);
	if (!repo || !repo.enabled) {
		await updateFeature(featureId, { status: 'failed', error: 'repository missing or disabled' });
		return;
	}
	const label = `${repo.owner}/${repo.name} feature #${featureId}`;
	// runStartedAt restarts the strand-detection clock for this attempt.
	await updateFeature(featureId, { status: 'generating', runStartedAt: 'now' });

	try {
		const outcome = await generate(feature, repo);
		await updateFeature(featureId, outcome);
		console.log(`turbodiff: generation ${outcome.status} for ${label}`);
		// Phase 4: a fresh PR with acceptance criteria gets an empirical
		// verification run (its own queue message → own consumer wall clock).
		if (outcome.status === 'pr_opened' && feature.acceptance) {
			await env.FACTORY_QUEUE.send({ kind: 'verify', featureId });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Transient platform interruption: keep the feature 'generating' and
		// re-enqueue with a delay so the next attempt lands after the rollout.
		if (PLATFORM_INTERRUPTION.test(message) && attempt < GEN_PLATFORM_RETRIES) {
			await updateFeature(featureId, {
				error: `platform interruption (attempt ${attempt + 1}/${GEN_PLATFORM_RETRIES + 1}), retrying in ${GEN_RETRY_DELAY_S / 60}m: ${message.slice(0, 300)}`,
			});
			await env.FACTORY_QUEUE.send(
				{ kind: 'generate', featureId, attempt: attempt + 1 },
				{ delaySeconds: GEN_RETRY_DELAY_S },
			);
			console.warn(
				`turbodiff: generation platform-interrupted for ${label} (attempt ${attempt + 1}), re-enqueued with ${GEN_RETRY_DELAY_S}s delay:`,
				err,
			);
			return;
		}
		await updateFeature(featureId, { status: 'failed', error: message.slice(0, 500) });
		console.error(`turbodiff: generation failed for ${label}:`, err);
	}
}

async function generate(
	feature: FeatureRow,
	repo: RepositoryRow,
): Promise<{ status: string; branch?: string; prNumber?: number; error?: string }> {
	const token = await installationToken(repo.installation_id);
	const auth = resolveRunnerAuth();
	// The sandbox only sees gitToken: single-repo, contents-only.
	const gitToken = await sandboxGitToken(repo.installation_id, repo.name, 'write');
	const scrub = (s: string) => s.replaceAll(token, '***').replaceAll(gitToken, '***');
	const full = `${repo.owner}/${repo.name}`;

	const repoInfo = (await (await gh(token, `/repos/${full}`)).json()) as {
		default_branch: string;
	};
	const base = repoInfo.default_branch;
	const branch = branchName(feature);

	const sandbox = getSandbox(
		env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
		`gen--${repo.owner}--${repo.name}--${feature.id}`.toLowerCase(),
		{ sleepAfter: '20m' },
	);

	const gitEnv = { GIT_TOKEN: gitToken, GEN_BASE: base, GEN_BRANCH: branch };
	try {
		await sandbox.exec(`rm -rf ${CLONE_DIR}`);
		const clone = await sandbox.exec(
			`git clone --depth 50 --single-branch --branch "$GEN_BASE" ` +
				`"https://x-access-token:$GIT_TOKEN@github.com/${full}.git" ${CLONE_DIR} && ` +
				`git -C ${CLONE_DIR} checkout -b "$GEN_BRANCH" && ` +
				`git -C ${CLONE_DIR} config user.name "turbodiff[bot]" && ` +
				`git -C ${CLONE_DIR} config user.email "turbodiff[bot]@users.noreply.github.com"`,
			{ env: gitEnv, timeout: 3 * 60_000 },
		);
		if (!clone.success) {
			throw new Error(`git clone failed: ${scrub(clone.stderr).slice(0, 500)}`);
		}

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
				`generation agent exited ${agent.exitCode}: ${scrub(`${agent.stdout}\n${agent.stderr}`).trim().slice(-1_000)}`,
			);
		}

		const status = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
		if (!status.stdout.trim()) {
			return { status: 'no_changes', error: 'agent produced no file changes' };
		}

		// Commit the agent's changes BEFORE running checks: the check command may
		// mutate the working tree (installing deps, editing config), and those
		// mutations must never end up in the pushed commit. The commit is local
		// only until the check passes and we push.
		// The title is user input: it travels via env so shell metacharacters in
		// it are data, never code. When a signed-in user instructed this feature
		// they become the git author (the bot stays committer); a differing plan
		// creator rides the message as a Co-authored-by trailer.
		const author =
			feature.author_login && feature.author_id !== null
				? { login: feature.author_login, id: feature.author_id }
				: null;
		const coauthor =
			feature.coauthor_login && feature.coauthor_id !== null
				? { login: feature.coauthor_login, id: feature.coauthor_id }
				: null;
		const commit = await sandbox.exec(
			`git -C ${CLONE_DIR} add -A && git -C ${CLONE_DIR} commit -m "$COMMIT_MSG"`,
			{
				env: {
					COMMIT_MSG:
						`${feature.title} (turbodiff generator, feature #${feature.id})` +
						coauthorTrailer(coauthor),
					...gitAuthorEnv(author),
				},
				timeout: 60_000,
			},
		);
		if (!commit.success) {
			throw new Error(`git commit failed: ${scrub(commit.stderr).slice(0, 500)}`);
		}

		// Verification gate: generated code must pass the repo's checks before the
		// commit is allowed to become a PR. Runs against the committed tree; any
		// files the check dirties stay in the working tree and are never pushed.
		if (repo.check_command) {
			const checks = await sandbox.exec(repo.check_command, {
				cwd: CLONE_DIR,
				timeout: CHECK_TIMEOUT_MS,
			});
			if (!checks.success) {
				return {
					status: 'checks_failed',
					error: scrub(`${checks.stdout}\n${checks.stderr}`.trim()).slice(-500),
				};
			}
		}

		const push = await sandbox.exec(
			`git -C ${CLONE_DIR} push origin HEAD:"$GEN_BRANCH"`,
			{ env: gitEnv, timeout: 2 * 60_000 },
		);
		if (!push.success) {
			throw new Error(`git push failed: ${scrub(push.stderr).slice(0, 500)}`);
		}
	} finally {
		// Never leave a live credential in an idle container's git config.
		await sandbox
			.exec(`git -C ${CLONE_DIR} remote set-url origin "https://github.com/${full}.git"`)
			.catch(() => {});
	}

	// The agent may have appended implementation notes to the spec file.
	const notes = await sandbox
		.readFile(SPEC_FILE)
		.then((f) => f.content.split('## Implementation notes')[1]?.trim())
		.catch(() => undefined);

	const pr = (await (
		await gh(token, `/repos/${full}/pulls`, {
			method: 'POST',
			body: JSON.stringify({
				title: feature.title,
				head: branch,
				base,
				body:
					`Generated by the turbodiff software factory (feature #${feature.id}).\n\n` +
					`## Spec\n\n${feature.spec}` +
					(notes ? `\n\n## Implementation notes\n\n${notes}` : ''),
			}),
		})
	).json()) as { number: number };

	return { status: 'pr_opened', branch, prNumber: pr.number };
}
