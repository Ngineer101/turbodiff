import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import { createFeature, getPlan, getRepoById, updatePlan, type PlanRow, type RepositoryRow } from './db.ts';
import { resolveRunnerAuth } from './fixer.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';

// Phase 3 of the software factory (docs/software-factory-design.md): the
// planning front half. A planning agent clones the repo (read-only), analyzes
// the requirements against the real code, asks clarifying questions, and — once
// answered — produces an implementation plan plus machine-checkable acceptance
// criteria. On approval the plan becomes a feature and flows into generation.

const CLONE_DIR = '/workspace/plan-repo';
const OUT_DIR = '/workspace/plan-out';
const AGENT_TIMEOUT_MS = 8 * 60_000;

export type PlanQueueMessage =
	| { kind: 'plan_analyze'; planId: number }
	| { kind: 'plan_refine'; planId: number };

// Boot a read-only clone of the repo's default branch in a sandbox and return
// it plus a token scrubber. Callers must scrub the remote in a finally block.
async function clonePlanRepo(
	repo: RepositoryRow,
	planId: number,
): Promise<{ sandbox: Sandbox; token: string; scrub: (s: string) => string }> {
	const token = await installationToken(repo.installation_id);
	// Planner sandboxes never push: single-repo, contents READ-ONLY token.
	const gitToken = await sandboxGitToken(repo.installation_id, repo.name, 'read');
	const scrub = (s: string) => s.replaceAll(token, '***').replaceAll(gitToken, '***');
	const full = `${repo.owner}/${repo.name}`;
	const info = (await (await gh(token, `/repos/${full}`)).json()) as { default_branch: string };

	const sandbox = getSandbox(
		env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
		`plan--${repo.owner}--${repo.name}--${planId}`.toLowerCase(),
		{ sleepAfter: '10m' },
	);
	await sandbox.exec(`rm -rf ${CLONE_DIR} ${OUT_DIR} && mkdir -p ${OUT_DIR}`);
	const clone = await sandbox.exec(
		`git clone --depth 50 --single-branch --branch "$GEN_BASE" ` +
			`"https://x-access-token:$GIT_TOKEN@github.com/${full}.git" ${CLONE_DIR}`,
		{ env: { GIT_TOKEN: gitToken, GEN_BASE: info.default_branch }, timeout: 3 * 60_000 },
	);
	if (!clone.success) {
		throw new Error(`git clone failed: ${scrub(clone.stderr).slice(0, 500)}`);
	}
	return { sandbox, token, scrub };
}

async function readJsonArray(sandbox: Sandbox, path: string): Promise<string[]> {
	try {
		const parsed = JSON.parse((await sandbox.readFile(path)).content);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

async function readText(sandbox: Sandbox, path: string): Promise<string | undefined> {
	try {
		return (await sandbox.readFile(path)).content.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function runAgent(
	sandbox: Sandbox,
	prompt: string,
	scrub: (s: string) => string,
): Promise<void> {
	const auth = resolveRunnerAuth();
	await sandbox.writeFile(`${OUT_DIR}/task.md`, prompt);
	const res = await sandbox.exec(
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
	if (!res.success) {
		throw new Error(
			`planning agent exited ${res.exitCode}: ${scrub(`${res.stdout}\n${res.stderr}`).trim().slice(-1_000)}`,
		);
	}
}

function analyzePrompt(plan: PlanRow, repo: RepositoryRow): string {
	return `You are a planning agent for ${repo.owner}/${repo.name}. You are in a read-only checkout — study the code but do NOT modify it.

Analyze the feature requirements below against the actual codebase, then write these files (create the directory if needed):

1. ${OUT_DIR}/analysis.md — a short grounding analysis: which files/modules this touches, how it fits existing conventions, and any risks.
2. ${OUT_DIR}/questions.json — a JSON array of clarifying questions (strings). Include ONLY genuine ambiguities or decisions the requirements leave open and that would change the implementation. If the requirements are clear enough to implement well, write an empty array [].

${UNTRUSTED_CONTENT_RULES}

## Feature: ${plan.title}

## Requirements
${plan.requirements}
`;
}

function planPrompt(plan: PlanRow, repo: RepositoryRow, qa: string): string {
	return `You are a planning agent for ${repo.owner}/${repo.name}. You are in a read-only checkout — study the code but do NOT modify it.

Produce an implementation plan for the feature below, grounded in the real code, then write these files:

1. ${OUT_DIR}/plan.md — a file-level implementation plan: what changes in which files, in what order, and why. Concrete enough for an implementation agent to follow without further questions.
2. ${OUT_DIR}/acceptance.json — a JSON array of machine-checkable acceptance criteria (strings). Each must be objectively verifiable (a specific response shape, a test that would pass, an observable behavior) — not vague ("works well"). These gate whether the generated code satisfies the request.

${UNTRUSTED_CONTENT_RULES}

## Feature: ${plan.title}

## Requirements
${plan.requirements}

## Prior analysis
${plan.analysis ?? '(none)'}
${qa}`;
}

// plan_analyze: clone, analyze the requirements against the repo, emit questions
// and a grounding analysis. Empty questions → straight to the plan; otherwise
// wait for the user's answers (awaiting_answers) before planning.
export async function runPlanAnalyze(planId: number): Promise<void> {
	const plan = await getPlan(planId);
	if (!plan) return;
	const repo = await getRepoById(plan.repository_id);
	if (!repo || !repo.enabled) {
		await updatePlan(planId, { status: 'failed', error: 'repository missing or disabled' });
		return;
	}
	const full = `${repo.owner}/${repo.name}`;
	let sandbox: Sandbox | undefined;
	try {
		const booted = await clonePlanRepo(repo, planId);
		sandbox = booted.sandbox;
		await runAgent(sandbox, analyzePrompt(plan, repo), booted.scrub);
		const analysis = await readText(sandbox, `${OUT_DIR}/analysis.md`);
		const questions = await readJsonArray(sandbox, `${OUT_DIR}/questions.json`);

		if (questions.length === 0) {
			// No ambiguities — plan immediately in the same run.
			await runAgent(sandbox, planPrompt({ ...plan, analysis: analysis ?? null }, repo, ''), booted.scrub);
			const planMd = await readText(sandbox, `${OUT_DIR}/plan.md`);
			const acceptance = await readJsonArray(sandbox, `${OUT_DIR}/acceptance.json`);
			await updatePlan(planId, {
				status: 'plan_ready',
				analysis,
				questions: '[]',
				plan: planMd,
				acceptance: JSON.stringify(acceptance),
			});
		} else {
			await updatePlan(planId, {
				status: 'awaiting_answers',
				analysis,
				questions: JSON.stringify(questions),
			});
		}
		console.log(`turbodiff: plan ${planId} analyzed for ${full} (${questions.length} questions)`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await updatePlan(planId, { status: 'failed', error: message.slice(0, 500) });
		console.error(`turbodiff: plan analyze failed for ${full} #${planId}:`, err);
	} finally {
		if (sandbox) {
			await sandbox
				.exec(`git -C ${CLONE_DIR} remote set-url origin "https://github.com/${full}.git"`)
				.catch(() => {});
		}
	}
}

// plan_refine: the user has answered the clarifying questions; produce the final
// plan + acceptance criteria incorporating their answers.
export async function runPlanRefine(planId: number): Promise<void> {
	const plan = await getPlan(planId);
	if (!plan) return;
	const repo = await getRepoById(plan.repository_id);
	if (!repo || !repo.enabled) {
		await updatePlan(planId, { status: 'failed', error: 'repository missing or disabled' });
		return;
	}
	const full = `${repo.owner}/${repo.name}`;
	const questions: string[] = plan.questions ? JSON.parse(plan.questions) : [];
	const answers: string[] = plan.answers ? JSON.parse(plan.answers) : [];
	const qa =
		'\n## Clarifying questions and answers\n' +
		questions.map((q, i) => `Q: ${q}\nA: ${answers[i] ?? '(no answer)'}`).join('\n\n');

	let sandbox: Sandbox | undefined;
	try {
		const booted = await clonePlanRepo(repo, planId);
		sandbox = booted.sandbox;
		await runAgent(sandbox, planPrompt(plan, repo, qa), booted.scrub);
		const planMd = await readText(sandbox, `${OUT_DIR}/plan.md`);
		const acceptance = await readJsonArray(sandbox, `${OUT_DIR}/acceptance.json`);
		await updatePlan(planId, {
			status: 'plan_ready',
			plan: planMd,
			acceptance: JSON.stringify(acceptance),
		});
		console.log(`turbodiff: plan ${planId} refined for ${full}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await updatePlan(planId, { status: 'failed', error: message.slice(0, 500) });
		console.error(`turbodiff: plan refine failed for ${full} #${planId}:`, err);
	} finally {
		if (sandbox) {
			await sandbox
				.exec(`git -C ${CLONE_DIR} remote set-url origin "https://github.com/${full}.git"`)
				.catch(() => {});
		}
	}
}

// Approval turns a ready plan into a generation feature: the spec is the plan
// plus its acceptance criteria, so the generated code is built against them.
// Returns the new feature id, or null if the plan isn't ready.
// The approver becomes the feature's commit author; the plan creator rides
// along as coauthor when a different user approved (see src/lib/attribution.ts).
export async function approvePlan(
	planId: number,
	approver?: { login: string; id: number },
): Promise<number | null> {
	const plan = await getPlan(planId);
	if (!plan || plan.status !== 'plan_ready' || !plan.plan) return null;
	const acceptance: string[] = plan.acceptance ? JSON.parse(plan.acceptance) : [];
	const spec =
		`${plan.plan}\n\n## Acceptance criteria\n\n` +
		(acceptance.length
			? acceptance.map((c) => `- ${c}`).join('\n')
			: '(none specified)') +
		`\n\nImplement the plan above so that every acceptance criterion holds.`;
	const creator =
		plan.created_by_login && plan.created_by_id !== null
			? { login: plan.created_by_login, id: plan.created_by_id }
			: undefined;
	const author = approver ?? creator;
	const coauthor = creator && author && creator.login !== author.login ? creator : undefined;
	// Criteria travel structured (not only embedded in the spec text) so the
	// verify step can check them one by one after generation.
	const featureId = await createFeature(
		plan.repository_id,
		plan.title,
		spec,
		plan.acceptance ?? undefined,
		author,
		coauthor,
	);
	await updatePlan(planId, { status: 'approved', featureId });
	return featureId;
}
