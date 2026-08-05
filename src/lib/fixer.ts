import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import { installationToken } from './github-app.ts';

// Phase 1 spike of the software factory fix loop (docs/software-factory-design.md):
// clone a PR's head branch into a Cloudflare Sandbox, run a coding agent CLI
// against the review findings, run the repo's tests, and push the fix commit.
//
// Runner auth is pluggable so users can spend their existing Claude
// subscription (claude setup-token → CLAUDE_CODE_OAUTH_TOKEN) instead of API
// credits through the AI Gateway.

export type FixAuthMode = 'claude_subscription' | 'gateway';

export interface FixParams {
	owner: string;
	repo: string;
	prNumber: number;
	installationId: number;
	// Markdown work order. When omitted, the latest blocking (CHANGES_REQUESTED)
	// bot review on the PR — i.e. turbodiff's own — is used instead.
	findings?: string;
	authMode?: FixAuthMode;
	// e.g. "npm test". When set, a failing run blocks the push.
	testCommand?: string;
}

export interface FixOutcome {
	status: 'fixed' | 'no_changes' | 'tests_failed';
	authMode: FixAuthMode;
	branch: string;
	commit?: string;
	// Findings the agent declined to fix, with its reasons (from fix-notes.md).
	notes?: string;
	testOutput?: string;
	agentOutput: string;
}

const CLONE_DIR = '/workspace/repo';
const TASK_FILE = '/workspace/fix-task.md';
const NOTES_FILE = '/workspace/fix-notes.md';
const AGENT_TIMEOUT_MS = 15 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

// Pick the runner credential: explicit request wins, otherwise prefer the
// user's subscription token over gateway metering.
function resolveRunnerAuth(requested?: FixAuthMode): {
	mode: FixAuthMode;
	vars: Record<string, string>;
} {
	const subscriptionToken = (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
	const gatewayKey = (env.FIXER_ANTHROPIC_API_KEY ?? '').trim();
	const gatewayUrl = (env.FIXER_ANTHROPIC_BASE_URL ?? '').trim();

	const subscription = subscriptionToken
		? { mode: 'claude_subscription' as const, vars: { CLAUDE_CODE_OAUTH_TOKEN: subscriptionToken } }
		: null;
	const gateway =
		gatewayKey && gatewayUrl
			? {
					mode: 'gateway' as const,
					vars: { ANTHROPIC_BASE_URL: gatewayUrl, ANTHROPIC_API_KEY: gatewayKey },
				}
			: null;

	if (requested === 'claude_subscription' && !subscription) {
		throw new Error('claude_subscription mode requires the CLAUDE_CODE_OAUTH_TOKEN secret');
	}
	if (requested === 'gateway' && !gateway) {
		throw new Error(
			'gateway mode requires the FIXER_ANTHROPIC_API_KEY secret and FIXER_ANTHROPIC_BASE_URL var',
		);
	}
	const picked = requested === 'gateway' ? gateway : (subscription ?? gateway);
	if (!picked) {
		throw new Error(
			'no runner credential configured: set CLAUDE_CODE_OAUTH_TOKEN (subscription) or FIXER_ANTHROPIC_API_KEY + FIXER_ANTHROPIC_BASE_URL (gateway)',
		);
	}
	return picked;
}

async function fetchPrHead(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<{ headRef: string; headRepo: string }> {
	const pr = (await (await gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}`)).json()) as {
		head: { ref: string; repo: { full_name: string } | null };
		base: { repo: { full_name: string } };
	};
	const headRepo = pr.head.repo?.full_name;
	if (!headRepo || headRepo.toLowerCase() !== pr.base.repo.full_name.toLowerCase()) {
		throw new Error('fixer only supports same-repo PR branches (fork PRs are not pushable)');
	}
	return { headRef: pr.head.ref, headRepo };
}

// Latest CHANGES_REQUESTED bot review (turbodiff's blocking review) folded into
// a markdown work order: review body + inline comments with their locations.
async function latestBlockingFindings(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<string | null> {
	const reviews = (await (
		await gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`)
	).json()) as {
		id: number;
		state: string;
		body: string;
		user: { login: string; type: string } | null;
	}[];
	const blocking = reviews.filter(
		(r) => r.state === 'CHANGES_REQUESTED' && r.user?.type === 'Bot',
	).at(-1);
	if (!blocking) return null;

	const comments = (await (
		await gh(token, `/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${blocking.id}/comments?per_page=100`)
	).json()) as { path: string; line: number | null; original_line: number | null; body: string }[];

	const inline = comments.map((c) => {
		const line = c.line ?? c.original_line;
		return `### ${c.path}${line ? `:${line}` : ''}\n${c.body}`;
	});
	return [blocking.body, ...inline].filter(Boolean).join('\n\n');
}

function taskPrompt(pr: string, branch: string, findings: string): string {
	return `You are an automated fix agent operating on a checked-out pull request branch.

Address every finding listed below. Rules:
- Fix only what the findings describe — no drive-by refactors or cleanups.
- Match the repository's existing code style and conventions.
- Do NOT run git commit or git push; the harness handles git.
- If a finding is wrong, already fixed, or cannot be fixed safely, leave the
  code unchanged and append one line to ${NOTES_FILE} explaining why.

## Pull request
${pr} — branch \`${branch}\`

## Findings
${findings}
`;
}

// Boots the fixer container and reports the runner toolchain versions —
// verifies the image, the DO binding, and exec plumbing without touching
// GitHub or spending any model tokens.
export async function sandboxSmoke(checkAuth = false): Promise<Record<string, string>> {
	const sandbox = getSandbox(
		env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
		'smoke',
		{ sleepAfter: '2m' },
	);
	const out: Record<string, string> = {};
	for (const cmd of ['git --version', 'node --version', 'claude --version']) {
		const res = await sandbox.exec(cmd, { timeout: 60_000 });
		out[cmd] = res.success ? res.stdout.trim() : `exit ${res.exitCode}: ${res.stderr.trim()}`;
	}
	if (checkAuth) {
		const auth = resolveRunnerAuth();
		const ping = await sandbox.exec(
			`claude -p "Reply with exactly: ok" --output-format text`,
			{
				timeout: 2 * 60_000,
				env: { ...auth.vars, IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' },
			},
		);
		out[`agent auth (${auth.mode})`] = ping.success
			? ping.stdout.trim()
			: `exit ${ping.exitCode}: ${`${ping.stdout}\n${ping.stderr}`.trim().slice(-500)}`;
	}
	return out;
}

export async function runFix(params: FixParams): Promise<FixOutcome> {
	const { owner, repo, prNumber } = params;
	const token = await installationToken(params.installationId);
	const auth = resolveRunnerAuth(params.authMode);
	// Any surfaced output must never leak the installation token (it is
	// interpolated into the git remote URL inside the sandbox).
	const scrub = (s: string) => s.replaceAll(token, '***');

	const findings =
		params.findings?.trim() || (await latestBlockingFindings(token, owner, repo, prNumber));
	if (!findings) {
		throw new Error('no findings supplied and no blocking bot review found on the PR');
	}
	const { headRef, headRepo } = await fetchPrHead(token, owner, repo, prNumber);

	const sandbox = getSandbox(
		env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
		`fix--${owner}--${repo}--${prNumber}`.toLowerCase(),
		{ sleepAfter: '20m' },
	);

	// Fresh checkout per run; the branch name and token travel via env so the
	// command string stays free of secrets and shell-hostile ref names.
	const gitEnv = { GIT_TOKEN: token, FIX_BRANCH: headRef };
	await sandbox.exec(`rm -rf ${CLONE_DIR} ${NOTES_FILE}`);
	const clone = await sandbox.exec(
		`git clone --depth 50 --single-branch --branch "$FIX_BRANCH" ` +
			`"https://x-access-token:$GIT_TOKEN@github.com/${headRepo}.git" ${CLONE_DIR}`,
		{ env: gitEnv, timeout: 5 * 60_000 },
	);
	if (!clone.success) {
		throw new Error(`git clone failed: ${scrub(clone.stderr).slice(0, 500)}`);
	}
	await sandbox.exec(
		`git -C ${CLONE_DIR} config user.name "turbodiff[bot]" && ` +
			`git -C ${CLONE_DIR} config user.email "turbodiff[bot]@users.noreply.github.com"`,
	);

	await sandbox.writeFile(TASK_FILE, taskPrompt(`${owner}/${repo}#${prNumber}`, headRef, findings));

	// Headless Claude Code run. --dangerously-skip-permissions is safe here —
	// the container is the isolation boundary (IS_SANDBOX acknowledges that).
	const agent = await sandbox.exec(
		`claude -p --dangerously-skip-permissions --output-format text < ${TASK_FILE}`,
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
	const agentOutput = scrub(`${agent.stdout}\n${agent.stderr}`.trim()).slice(-8_000);
	if (!agent.success) {
		throw new Error(`fix agent exited ${agent.exitCode}: ${agentOutput.slice(-1_000)}`);
	}

	const notes = await sandbox
		.readFile(NOTES_FILE)
		.then((f) => f.content.trim() || undefined)
		.catch(() => undefined);

	const status = await sandbox.exec(`git -C ${CLONE_DIR} status --porcelain`);
	if (!status.stdout.trim()) {
		await postFixComment(token, params, { changed: false, notes });
		return { status: 'no_changes', authMode: auth.mode, branch: headRef, notes, agentOutput };
	}

	let testOutput: string | undefined;
	if (params.testCommand) {
		const tests = await sandbox.exec(params.testCommand, {
			cwd: CLONE_DIR,
			timeout: TEST_TIMEOUT_MS,
		});
		testOutput = scrub(`${tests.stdout}\n${tests.stderr}`.trim()).slice(-4_000);
		if (!tests.success) {
			return {
				status: 'tests_failed',
				authMode: auth.mode,
				branch: headRef,
				notes,
				testOutput,
				agentOutput,
			};
		}
	}

	const push = await sandbox.exec(
		`git -C ${CLONE_DIR} add -A && ` +
			`git -C ${CLONE_DIR} commit -m "Address review findings on #${prNumber} (turbodiff fix agent)" && ` +
			`git -C ${CLONE_DIR} push origin HEAD:"$FIX_BRANCH"`,
		{ env: gitEnv, timeout: 2 * 60_000 },
	);
	if (!push.success) {
		throw new Error(`git push failed: ${scrub(push.stderr).slice(0, 500)}`);
	}
	const commit = (await sandbox.exec(`git -C ${CLONE_DIR} rev-parse HEAD`)).stdout.trim();

	await postFixComment(token, params, { changed: true, commit, notes, tested: !!params.testCommand });
	return {
		status: 'fixed',
		authMode: auth.mode,
		branch: headRef,
		commit,
		notes,
		testOutput,
		agentOutput,
	};
}

async function postFixComment(
	token: string,
	params: FixParams,
	result: { changed: boolean; commit?: string; notes?: string; tested?: boolean },
): Promise<void> {
	const lines = result.changed
		? [
				`🔧 Turbodiff fix agent pushed ${result.commit} addressing the blocking review findings.`,
				result.tested ? 'Tests passed before pushing.' : undefined,
			]
		: ['🔧 Turbodiff fix agent ran but made no code changes.'];
	if (result.notes) lines.push('', '**Findings left unaddressed:**', result.notes);
	try {
		await gh(token, `/repos/${params.owner}/${params.repo}/issues/${params.prNumber}/comments`, {
			method: 'POST',
			body: JSON.stringify({ body: lines.filter((l) => l !== undefined).join('\n') }),
		});
	} catch (err) {
		// The fix itself succeeded; a failed comment shouldn't fail the run.
		console.error('turbodiff: fix summary comment failed:', err);
	}
}
