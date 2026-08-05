import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import { getFeature, getRepoById, updateFeature, type FeatureRow, type RepositoryRow } from './db.ts';
import { resolveRunnerAuth } from './fixer.ts';
import { installationToken } from './github-app.ts';

// Phase 2 of the software factory (docs/software-factory-design.md): turn an
// approved feature spec into a branch + PR. The generator clones the default
// branch into a sandbox, runs the coding agent against the spec, pushes a
// feature branch, and opens the PR — from there the existing review and
// auto-fix loop take over via webhooks.

const CLONE_DIR = '/workspace/gen';
const SPEC_FILE = '/workspace/gen-spec.md';
// Clone + agent + push must fit inside a queue consumer's 15-minute wall clock.
const AGENT_TIMEOUT_MS = 10 * 60_000;

export interface GenQueueMessage {
	kind: 'generate';
	featureId: number;
}

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

## Feature: ${feature.title}

${feature.spec}
`;
}

export async function runGeneration(featureId: number): Promise<void> {
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
	await updateFeature(featureId, { status: 'generating' });

	try {
		const outcome = await generate(feature, repo);
		await updateFeature(featureId, outcome);
		console.log(`turbodiff: generation ${outcome.status} for ${label}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
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
	const scrub = (s: string) => s.replaceAll(token, '***');
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

	const gitEnv = { GIT_TOKEN: token, GEN_BASE: base, GEN_BRANCH: branch };
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

		const push = await sandbox.exec(
			`git -C ${CLONE_DIR} add -A && ` +
				`git -C ${CLONE_DIR} commit -m "${feature.title.replaceAll('"', "'")} (turbodiff generator, feature #${feature.id})" && ` +
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
