import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import {
	createVerification,
	finishVerification,
	getFeature,
	getRepoById,
	type FeatureRow,
	type RepositoryRow,
} from './db.ts';
import { signArtifactKey } from './crypto.ts';
import { resolveRunnerAuth } from './fixer.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';

// Phase 4 (docs/software-factory-design.md): empirical verification of factory
// PRs, doubling as the spec-conformance gate. A verifier agent checks each
// acceptance criterion against the checked-out PR branch — static criteria by
// reading the tree, runtime criteria by launching the app (repo.run_command)
// and exercising it, visual criteria by driving headless Chromium and
// capturing screenshots. The evidence lands on the PR as a report comment;
// failed criteria feed the existing auto-fix loop.

const CLONE_DIR = '/workspace/verify-repo';
const OUT_DIR = '/workspace/verify-out';
const SHOTS_DIR = `${OUT_DIR}/screenshots`;
const AGENT_TIMEOUT_MS = 10 * 60_000;

export interface VerifyQueueMessage {
	kind: 'verify';
	featureId: number;
}

interface CriterionResult {
	index: number;
	verdict: 'pass' | 'fail' | 'skip';
	note: string;
	screenshot?: string;
}

function verifyPrompt(feature: FeatureRow, repo: RepositoryRow, criteria: string[]): string {
	const runtime = repo.run_command
		? `## Running the app
The app can be launched with:

    ${repo.run_command}

It listens on port ${repo.app_port ?? '(unknown — check the repo)'} once ready.
Start it in the background (e.g. \`nohup ... > /tmp/app.log 2>&1 &\`), wait for
the port to accept connections, and verify runtime criteria against it with
curl or small node scripts. If it fails to start, mark runtime criteria as
"skip" with a note quoting the relevant log lines — do NOT mark them "fail"
for infrastructure reasons.

## Screenshots
A headless Chrome binary is installed (its path is in the env var
PUPPETEER_EXECUTABLE_PATH) and puppeteer-core is globally available via
NODE_PATH. For criteria with user-visible behavior, write a small node script
that opens the relevant page/state and captures PNG screenshots into
${SHOTS_DIR}/ (create it). Write capture scripts as CommonJS (.cjs files using
require('puppeteer-core')) — ESM import cannot resolve the global install.
Launch with args ['--no-sandbox', '--disable-dev-shm-usage']. Use descriptive
kebab-case filenames and reference each screenshot from the matching
criterion result.`
		: `## Running the app
No run command is configured for this repository, so runtime and visual checks
are unavailable. Verify what can be verified statically from the tree; mark
criteria that would need a running app as "skip" with a note saying why.`;

	return `You are a verification agent for ${repo.owner}/${repo.name}. You are in a checkout of the pull request branch for "${feature.title}". You may read anything and run the app, but do NOT modify tracked files, commit, or push.

Check every acceptance criterion below against reality — the actual tree and
(where possible) the actually running app. Do not infer from the diff what you
can observe directly.

${runtime}

## Output (write these files, creating ${OUT_DIR} first)
1. ${OUT_DIR}/results.json — a JSON array, one entry per criterion, in order:
   [{"index": 0, "verdict": "pass" | "fail" | "skip", "note": "one or two sentences of evidence — what you did and what you observed", "screenshot": "optional-filename.png"}]
   "fail" means the criterion is genuinely not met by the code; "skip" means it
   could not be checked here (say why).
2. ${OUT_DIR}/summary.md — a short reviewer-facing narrative titled "How it
   works": what was implemented and how it behaves, referencing the evidence.

${UNTRUSTED_CONTENT_RULES}

## Acceptance criteria
${criteria.map((c, i) => `${i}. ${c}`).join('\n')}
`;
}

export async function runVerification(featureId: number): Promise<void> {
	const feature = await getFeature(featureId);
	if (!feature || !feature.branch || !feature.pr_number) {
		console.warn(`turbodiff: verify skipped, feature ${featureId} has no branch/PR`);
		return;
	}
	const repo = await getRepoById(feature.repository_id);
	if (!repo || !repo.enabled) return;
	const criteria: string[] = feature.acceptance ? JSON.parse(feature.acceptance) : [];
	if (criteria.length === 0) {
		console.log(`turbodiff: verify skipped for feature ${featureId} (no acceptance criteria)`);
		return;
	}
	const label = `${repo.owner}/${repo.name}#${feature.pr_number}`;
	const verificationId = await createVerification(featureId);

	try {
		const outcome = await verify(feature, repo, criteria);
		await finishVerification(verificationId, outcome.status, {
			results: JSON.stringify(outcome.results),
			summary: outcome.summary,
		});
		console.log(`turbodiff: verification ${outcome.status} for ${label}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await finishVerification(verificationId, 'error', { error: message.slice(0, 500) });
		console.error(`turbodiff: verification errored for ${label}:`, err);
	}
}

async function verify(
	feature: FeatureRow,
	repo: RepositoryRow,
	criteria: string[],
): Promise<{ status: string; results: CriterionResult[]; summary?: string }> {
	const token = await installationToken(repo.installation_id);
	const auth = resolveRunnerAuth();
	// Verifier sandboxes never push: single-repo, contents READ-ONLY token.
	const gitToken = await sandboxGitToken(repo.installation_id, repo.name, 'read');
	const scrub = (s: string) => s.replaceAll(token, '***').replaceAll(gitToken, '***');
	const full = `${repo.owner}/${repo.name}`;

	const sandbox = getSandbox(
		env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
		`verify--${repo.owner}--${repo.name}--${feature.id}`.toLowerCase(),
		{ sleepAfter: '15m' },
	);

	try {
		await sandbox.exec(`rm -rf ${CLONE_DIR} ${OUT_DIR} && mkdir -p ${SHOTS_DIR}`);
		const clone = await sandbox.exec(
			`git clone --depth 50 --single-branch --branch "$VERIFY_BRANCH" ` +
				`"https://x-access-token:$GIT_TOKEN@github.com/${full}.git" ${CLONE_DIR}`,
			{ env: { GIT_TOKEN: gitToken, VERIFY_BRANCH: feature.branch! }, timeout: 3 * 60_000 },
		);
		if (!clone.success) {
			throw new Error(`git clone failed: ${scrub(clone.stderr).slice(0, 500)}`);
		}

		await sandbox.writeFile(`${OUT_DIR}/task.md`, verifyPrompt(feature, repo, criteria));
		const agent = await sandbox.exec(
			`claude -p --dangerously-skip-permissions --output-format text < ${OUT_DIR}/task.md`,
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
				`verifier agent exited ${agent.exitCode}: ${scrub(`${agent.stdout}\n${agent.stderr}`).trim().slice(-1_000)}`,
			);
		}

		const results = await readResults(sandbox, criteria.length);
		const summary = await readText(sandbox, `${OUT_DIR}/summary.md`);
		const shots = await uploadScreenshots(sandbox, feature.id, results);

		const failed = results.filter((r) => r.verdict === 'fail');
		await postReport(token, repo, feature, criteria, results, shots, summary);

		// Conformance gate: unmet criteria feed the existing fix loop (toggle and
		// cap are re-validated by the consumer, exactly like review-driven fixes).
		if (failed.length > 0 && repo.auto_fix === 1) {
			await env.FACTORY_QUEUE.send({
				kind: 'fix',
				repoId: repo.id,
				prNumber: feature.pr_number!,
				trigger: 'verification_failed',
				findings: failed
					.map((f) => `**P1** — Acceptance criterion not met: ${criteria[f.index]}\n\nEvidence: ${f.note}`)
					.join('\n\n'),
			});
		}
		return { status: failed.length > 0 ? 'failed' : 'passed', results, summary };
	} finally {
		await sandbox
			.exec(`git -C ${CLONE_DIR} remote set-url origin "https://github.com/${full}.git"`)
			.catch(() => {});
	}
}

async function readResults(sandbox: Sandbox, count: number): Promise<CriterionResult[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse((await sandbox.readFile(`${OUT_DIR}/results.json`)).content);
	} catch {
		throw new Error('verifier agent did not produce a parseable results.json');
	}
	if (!Array.isArray(parsed)) throw new Error('results.json is not an array');
	const byIndex = new Map<number, CriterionResult>();
	for (const raw of parsed as Record<string, unknown>[]) {
		const index = Number(raw.index);
		if (!Number.isInteger(index) || index < 0 || index >= count) continue;
		const verdict = raw.verdict === 'pass' || raw.verdict === 'fail' ? raw.verdict : 'skip';
		byIndex.set(index, {
			index,
			verdict,
			note: String(raw.note ?? '').slice(0, 500),
			screenshot: typeof raw.screenshot === 'string' ? raw.screenshot : undefined,
		});
	}
	// A criterion the agent silently dropped is unverified, not passed.
	return Array.from({ length: count }, (_, i) => {
		return byIndex.get(i) ?? { index: i, verdict: 'skip', note: 'no result reported' };
	});
}

async function readText(sandbox: Sandbox, path: string): Promise<string | undefined> {
	try {
		return (await sandbox.readFile(path)).content.trim() || undefined;
	} catch {
		return undefined;
	}
}

// Screenshots leave the sandbox base64-encoded (binary-safe over the exec
// transport) and land in R2 under verify/<featureId>/, served publicly by the
// GET /artifacts/* route so they render inline in the PR comment.
async function uploadScreenshots(
	sandbox: Sandbox,
	featureId: number,
	results: CriterionResult[],
): Promise<Map<string, string>> {
	const urls = new Map<string, string>();
	const wanted = [...new Set(results.map((r) => r.screenshot).filter((s): s is string => !!s))];
	for (const name of wanted) {
		const safe = name.replace(/[^\w.-]/g, '');
		if (!safe.endsWith('.png')) continue;
		const b64 = await sandbox.exec(`base64 < "${SHOTS_DIR}/${safe}" | tr -d '\\n'`, {
			timeout: 30_000,
		});
		if (!b64.success || !b64.stdout.trim()) continue;
		const bytes = Uint8Array.from(atob(b64.stdout.trim()), (c) => c.charCodeAt(0));
		const key = `verify/${featureId}/${safe}`;
		await env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
		const sig = await signArtifactKey(key);
		urls.set(name, `${env.PUBLIC_BASE_URL}/artifacts/${key}?sig=${sig}`);
	}
	return urls;
}

const VERDICT_BADGE: Record<CriterionResult['verdict'], string> = {
	pass: '✅',
	fail: '❌',
	skip: '⚪',
};

async function postReport(
	token: string,
	repo: RepositoryRow,
	feature: FeatureRow,
	criteria: string[],
	results: CriterionResult[],
	shots: Map<string, string>,
	summary?: string,
): Promise<void> {
	const failed = results.filter((r) => r.verdict === 'fail').length;
	const lines = [
		`## 🔍 Turbodiff verification — ${failed === 0 ? 'all criteria met' : `${failed} criteria not met`}`,
		'',
		'| | Criterion | Evidence |',
		'|---|---|---|',
		...results.map((r) => {
			const note = r.note.replaceAll('|', '\\|').replaceAll('\n', ' ');
			return `| ${VERDICT_BADGE[r.verdict]} | ${criteria[r.index].replaceAll('|', '\\|')} | ${note} |`;
		}),
	];
	const embedded = results
		.map((r) => (r.screenshot && shots.get(r.screenshot) ? { r, url: shots.get(r.screenshot)! } : null))
		.filter((x): x is { r: CriterionResult; url: string } => x !== null);
	if (embedded.length > 0) {
		lines.push('', '### Evidence');
		for (const { r, url } of embedded) {
			lines.push('', `**${criteria[r.index]}**`, `![${r.screenshot}](${url})`);
		}
	}
	if (summary) lines.push('', '### How it works', '', summary.slice(0, 3_000));
	if (failed > 0 && repo.auto_fix === 1) {
		lines.push('', '_The unmet criteria have been handed to the fix agent._');
	}
	try {
		await gh(token, `/repos/${repo.owner}/${repo.name}/issues/${feature.pr_number}/comments`, {
			method: 'POST',
			body: JSON.stringify({ body: lines.join('\n') }),
		});
	} catch (err) {
		console.error('turbodiff: verification report comment failed:', err);
	}
}
