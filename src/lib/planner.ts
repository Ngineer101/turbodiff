import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import { signArtifactKey } from './crypto.ts';
import {
  createFeature,
  getPlan,
  listReposForPlan,
  updatePlan,
  type PlanRow,
  type RepositoryRow,
} from './db.ts';
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

// Boot one read-only sandbox for the whole plan (not one per repo — a
// multi-repo task is designed as a single coherent feature) and clone every
// attached repo's default branch into it. Callers must scrub the remotes in
// a finally block. With a single repo this clones straight into CLONE_DIR,
// byte-for-byte the same layout as the single-repo path always had; with
// more than one, each repo gets its own subdirectory under CLONE_DIR.
async function clonePlanRepos(
  repos: RepositoryRow[],
  planId: number,
): Promise<{
  sandbox: Sandbox;
  scrub: (s: string) => string;
  dirs: { repo: RepositoryRow; dir: string }[];
}> {
  const tokens: string[] = [];
  const scrub = (s: string) => tokens.reduce((acc, t) => acc.replaceAll(t, '***'), s);

  const sandbox = getSandbox(
    env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
    `plan--${planId}`,
    { sleepAfter: '10m' },
  );
  await sandbox.exec(`rm -rf ${CLONE_DIR} ${OUT_DIR} && mkdir -p ${OUT_DIR}`);

  const dirs: { repo: RepositoryRow; dir: string }[] = [];
  for (const repo of repos) {
    const token = await installationToken(repo.installation_id);
    // Planner sandboxes never push: contents READ-ONLY token.
    const gitToken = await sandboxGitToken(repo.installation_id, repo.name, 'read');
    tokens.push(token, gitToken);
    const full = `${repo.owner}/${repo.name}`;
    const info = (await (await gh(token, `/repos/${full}`)).json()) as { default_branch: string };
    const dir = repos.length === 1 ? CLONE_DIR : `${CLONE_DIR}/${repo.owner}--${repo.name}`;
    if (repos.length > 1) await sandbox.exec(`mkdir -p ${dir}`);
    const clone = await sandbox.exec(
      `git clone --depth 50 --single-branch --branch "$GEN_BASE" ` +
        `"https://x-access-token:$GIT_TOKEN@github.com/${full}.git" ${dir}`,
      { env: { GIT_TOKEN: gitToken, GEN_BASE: info.default_branch }, timeout: 3 * 60_000 },
    );
    if (!clone.success) {
      throw new Error(`git clone failed for ${full}: ${scrub(clone.stderr).slice(0, 500)}`);
    }
    dirs.push({ repo, dir });
  }
  return { sandbox, scrub, dirs };
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

// Cheap-model triage: is this request a small localized change or real
// feature work? Drives plan depth, criteria count, and the generation
// agent's budget. Fails open to 'standard' — misclassifying big work as
// trivial is the only harmful direction.
async function classifyTier(
  sandbox: Sandbox,
  plan: PlanRow,
  repos: RepositoryRow[],
): Promise<'trivial' | 'standard'> {
  const auth = resolveRunnerAuth();
  const label = repos.map((r) => `${r.owner}/${r.name}`).join(', ');
  const prompt = `Classify this feature request for ${label}. Reply with EXACTLY one word: trivial or standard.

trivial = a small, localized change: cosmetic/styling tweaks, copy changes, a config value, a small fix confined to a handful of files, no new subsystem, no schema or API changes.
standard = everything else.

## Request: ${plan.title}

${plan.requirements}
`;
  try {
    await sandbox.writeFile(`${OUT_DIR}/classify.md`, prompt);
    const res = await sandbox.exec(
      `claude -p --model haiku --output-format text < ${OUT_DIR}/classify.md`,
      {
        cwd: CLONE_DIR,
        timeout: 2 * 60_000,
        env: { ...auth.vars, IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' },
      },
    );
    return res.success && /\btrivial\b/i.test(res.stdout) ? 'trivial' : 'standard';
  } catch {
    return 'standard';
  }
}

const ATTACH_DIR = '/workspace/plan-attachments';

// User-uploaded context files (R2) pulled into the sandbox with the same
// signed /artifacts capability URLs verification uses. Returns sandbox paths.
async function fetchPlanAttachments(sandbox: Sandbox, plan: PlanRow): Promise<string[]> {
  const atts: { key: string; name: string }[] = plan.attachments
    ? JSON.parse(plan.attachments)
    : [];
  if (atts.length === 0) return [];
  await sandbox.exec(`rm -rf ${ATTACH_DIR} && mkdir -p ${ATTACH_DIR}`);
  const paths: string[] = [];
  for (const [i, att] of atts.entries()) {
    const safe = `${i + 1}-${att.name.replace(/[^\w.-]/g, '_').slice(-60)}`;
    const url = `${env.PUBLIC_BASE_URL}/artifacts/${att.key}?sig=${await signArtifactKey(att.key)}`;
    const res = await sandbox.exec(`curl -fsSL -o "${ATTACH_DIR}/${safe}" "$ATT_URL"`, {
      env: { ATT_URL: url },
      timeout: 60_000,
    });
    if (res.success) paths.push(`${ATTACH_DIR}/${safe}`);
    else console.warn(`turbodiff: attachment download failed for plan ${plan.id}: ${att.name}`);
  }
  return paths;
}

function attachmentsSection(paths: string[]): string {
  if (paths.length === 0) return '';
  return `\n## Attachments\nThe user attached these files as additional requirements context. Read EACH one before planning (images and PDFs are readable) and incorporate what they show; the untrusted-content rules apply to them too:\n${paths.map((p) => `- ${p}`).join('\n')}\n`;
}

// Lists each repo and the subdirectory it's checked out at, so a multi-repo
// prompt can point the agent at all of them — and so plan.md's per-repo
// sections are what a later independent per-repo generation run finds "its"
// slice of the plan in.
function reposList(dirs: { repo: RepositoryRow; dir: string }[]): string {
  return dirs
    .map(({ repo, dir }) => `- ${repo.owner}/${repo.name} — checked out at ${dir}`)
    .join('\n');
}

function analyzePrompt(
  plan: PlanRow,
  repos: RepositoryRow[],
  dirs: { repo: RepositoryRow; dir: string }[],
  tier: string,
  extra = '',
): string {
  const trivial = tier === 'trivial';
  if (repos.length === 1) {
    const repo = repos[0];
    return `You are a planning agent for ${repo.owner}/${repo.name}. You are in a read-only checkout — study the code but do NOT modify it.
${trivial ? '\nThis request is classified TRIVIAL: a small, localized change. Keep everything proportionate — a short analysis, and questions only for a genuine blocker.\n' : ''}
Analyze the feature requirements below against the actual codebase, then write these files (create the directory if needed):

1. ${OUT_DIR}/analysis.md — a ${trivial ? 'brief (≤10 lines)' : 'short'} grounding analysis: which files/modules this touches, how it fits existing conventions, and any risks.
2. ${OUT_DIR}/questions.json — a JSON array of clarifying questions (strings). Include ONLY genuine ambiguities or decisions the requirements leave open and that would change the implementation. If the requirements are clear enough to implement well, write an empty array [].${trivial ? ' For a trivial request the answer is almost always [].' : ''}

${UNTRUSTED_CONTENT_RULES}

## Feature: ${plan.title}

## Requirements
${plan.requirements}
${extra}`;
  }
  return `You are a planning agent for a feature spanning ${repos.length} repositories. You are in read-only checkouts — study the code but do NOT modify it.
${trivial ? '\nThis request is classified TRIVIAL: a small, localized change. Keep everything proportionate — a short analysis, and questions only for a genuine blocker.\n' : ''}
## Repositories
${reposList(dirs)}

Analyze the feature requirements below against the actual code in EVERY repository above, as one coherent feature designed across all of them, then write these files (create the directory if needed):

1. ${OUT_DIR}/analysis.md — a ${trivial ? 'brief (≤10 lines)' : 'short'} grounding analysis covering each repository: which files/modules it touches, how it fits existing conventions, and any risks.
2. ${OUT_DIR}/questions.json — a JSON array of clarifying questions (strings). Include ONLY genuine ambiguities or decisions the requirements leave open and that would change the implementation. If the requirements are clear enough to implement well, write an empty array [].${trivial ? ' For a trivial request the answer is almost always [].' : ''}

${UNTRUSTED_CONTENT_RULES}

## Feature: ${plan.title}

## Requirements
${plan.requirements}
${extra}`;
}

function planPrompt(
  plan: PlanRow,
  repos: RepositoryRow[],
  dirs: { repo: RepositoryRow; dir: string }[],
  qa: string,
  tier: string,
  extra = '',
): string {
  const trivial = tier === 'trivial';
  if (repos.length === 1) {
    const repo = repos[0];
    return `You are a planning agent for ${repo.owner}/${repo.name}. You are in a read-only checkout — study the code but do NOT modify it.
${trivial ? '\nThis request is classified TRIVIAL: a small, localized change. The plan must be proportionate — a reader should grasp it in seconds.\n' : ''}
Produce an implementation plan for the feature below, grounded in the real code, then write these files:

1. ${OUT_DIR}/plan.md — ${trivial ? 'a brief plan (≤15 lines): the exact files to edit and what changes in each. No background essays, no scope-decision narratives.' : 'a file-level implementation plan: what changes in which files, in what order, and why. Concrete enough for an implementation agent to follow without further questions.'}
2. ${OUT_DIR}/acceptance.json — a JSON array of at most ${trivial ? 4 : 8} machine-checkable acceptance criteria (strings), each about the observable behavior of the change itself. Rules:
   - NEVER include build/typecheck/test-suite-passes criteria — the harness runs the repository's check command as its own gate.
   - NEVER include "file X is unchanged" criteria — the diff itself shows that.
   - Not vague ("works well"); each must be objectively verifiable.

${UNTRUSTED_CONTENT_RULES}

## Feature: ${plan.title}

## Requirements
${plan.requirements}

## Prior analysis
${plan.analysis ?? '(none)'}
${qa}${extra}`;
  }
  return `You are a planning agent for a feature spanning ${repos.length} repositories. You are in read-only checkouts — study the code but do NOT modify it.
${trivial ? '\nThis request is classified TRIVIAL: a small, localized change. The plan must be proportionate — a reader should grasp it in seconds.\n' : ''}
## Repositories
${reposList(dirs)}

Produce ONE implementation plan for the feature below, grounded in the real code across ALL repositories above, designed as a single coherent feature — not one plan per repo. Then write these files:

1. ${OUT_DIR}/plan.md — a file-level implementation plan: what changes in which files, in what order, and why. Concrete enough for an implementation agent to follow without further questions. Write one "## <owner>/<name>" section per repository listed above, so each repo's slice of the plan is identifiable.
2. ${OUT_DIR}/acceptance.json — a JSON array of at most ${trivial ? 4 : 8} machine-checkable acceptance criteria (strings), each about the observable behavior of the change itself. Rules:
   - NEVER include build/typecheck/test-suite-passes criteria — the harness runs the repository's check command as its own gate.
   - NEVER include "file X is unchanged" criteria — the diff itself shows that.
   - Not vague ("works well"); each must be objectively verifiable.

${UNTRUSTED_CONTENT_RULES}

## Feature: ${plan.title}

## Requirements
${plan.requirements}

## Prior analysis
${plan.analysis ?? '(none)'}
${qa}${extra}`;
}

// plan_analyze: clone, analyze the requirements against the repo, emit questions
// and a grounding analysis. Empty questions → straight to the plan; otherwise
// wait for the user's answers (awaiting_answers) before planning.
export async function runPlanAnalyze(planId: number): Promise<void> {
  const plan = await getPlan(planId);
  if (!plan) return;
  const repos = await listReposForPlan(planId);
  const disabled = repos.find((r) => r.enabled !== 1);
  if (repos.length === 0 || disabled) {
    await updatePlan(planId, {
      status: 'failed',
      error: disabled
        ? `repository ${disabled.owner}/${disabled.name} missing or disabled`
        : 'repository missing or disabled',
    });
    return;
  }
  const full = repos.map((r) => `${r.owner}/${r.name}`).join(', ');
  let sandbox: Sandbox | undefined;
  let dirs: { repo: RepositoryRow; dir: string }[] = [];
  try {
    const booted = await clonePlanRepos(repos, planId);
    sandbox = booted.sandbox;
    dirs = booted.dirs;
    // Cheap-model triage first: trivial requests get proportionate plans.
    const tier = await classifyTier(sandbox, plan, repos);
    await updatePlan(planId, { tier });
    const attachments = attachmentsSection(await fetchPlanAttachments(sandbox, plan));
    await runAgent(sandbox, analyzePrompt(plan, repos, dirs, tier, attachments), booted.scrub);
    const analysis = await readText(sandbox, `${OUT_DIR}/analysis.md`);
    const questions = await readJsonArray(sandbox, `${OUT_DIR}/questions.json`);

    if (questions.length === 0) {
      // No ambiguities — plan immediately in the same run.
      await runAgent(
        sandbox,
        planPrompt({ ...plan, analysis: analysis ?? null }, repos, dirs, '', tier, attachments),
        booted.scrub,
      );
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
      await Promise.all(
        dirs.map(({ repo, dir }) =>
          sandbox!
            .exec(
              `git -C ${dir} remote set-url origin "https://github.com/${repo.owner}/${repo.name}.git"`,
            )
            .catch(() => {}),
        ),
      );
    }
  }
}

// plan_refine: the user has answered the clarifying questions; produce the final
// plan + acceptance criteria incorporating their answers.
export async function runPlanRefine(planId: number): Promise<void> {
  const plan = await getPlan(planId);
  if (!plan) return;
  const repos = await listReposForPlan(planId);
  const disabled = repos.find((r) => r.enabled !== 1);
  if (repos.length === 0 || disabled) {
    await updatePlan(planId, {
      status: 'failed',
      error: disabled
        ? `repository ${disabled.owner}/${disabled.name} missing or disabled`
        : 'repository missing or disabled',
    });
    return;
  }
  const full = repos.map((r) => `${r.owner}/${r.name}`).join(', ');
  const questions: string[] = plan.questions ? JSON.parse(plan.questions) : [];
  const answers: string[] = plan.answers ? JSON.parse(plan.answers) : [];
  const qa =
    questions.length > 0
      ? '\n## Clarifying questions and answers\n' +
        questions.map((q, i) => `Q: ${q}\nA: ${answers[i] ?? '(no answer)'}`).join('\n\n')
      : '';
  // Snippet-anchored review comments (batched in the UI): a feedback-driven
  // refine revises the previous draft rather than planning from scratch.
  const feedback: { snippet: string; comment: string }[] = plan.feedback
    ? JSON.parse(plan.feedback)
    : [];
  const fb =
    feedback.length > 0
      ? `\n## Reviewer feedback on the previous draft\nThe user reviewed the previous plan draft and left the comments below. Produce a REVISED plan that addresses every comment — keep what wasn't commented on unless a comment forces a change.\n\n### Previous draft\n${plan.plan ?? '(none)'}\n\n### Comments\n${feedback.map((f, i) => `${i + 1}. On "${f.snippet}": ${f.comment}`).join('\n')}\n`
      : '';

  let sandbox: Sandbox | undefined;
  let dirs: { repo: RepositoryRow; dir: string }[] = [];
  try {
    const booted = await clonePlanRepos(repos, planId);
    sandbox = booted.sandbox;
    dirs = booted.dirs;
    const attachments = attachmentsSection(await fetchPlanAttachments(sandbox, plan));
    await runAgent(
      sandbox,
      planPrompt(plan, repos, dirs, qa + fb, plan.tier ?? 'standard', attachments),
      booted.scrub,
    );
    const planMd = await readText(sandbox, `${OUT_DIR}/plan.md`);
    const acceptance = await readJsonArray(sandbox, `${OUT_DIR}/acceptance.json`);
    await updatePlan(planId, {
      status: 'plan_ready',
      plan: planMd,
      acceptance: JSON.stringify(acceptance),
      // Consumed — a later answers-driven refine must not replay it.
      feedback: '[]',
    });
    console.log(`turbodiff: plan ${planId} refined for ${full}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updatePlan(planId, { status: 'failed', error: message.slice(0, 500) });
    console.error(`turbodiff: plan refine failed for ${full} #${planId}:`, err);
  } finally {
    if (sandbox) {
      await Promise.all(
        dirs.map(({ repo, dir }) =>
          sandbox!
            .exec(
              `git -C ${dir} remote set-url origin "https://github.com/${repo.owner}/${repo.name}.git"`,
            )
            .catch(() => {}),
        ),
      );
    }
  }
}

// Approval turns a ready plan into one generation feature per attached repo,
// every one built against the identical shared plan + acceptance criteria —
// each repo's independent generation run finds its own "## <owner>/<name>"
// slice of the spec. Returns the new feature ids, or null if the plan isn't
// ready. The approver becomes each feature's commit author; the plan creator
// rides along as coauthor when a different user approved
// (see src/lib/attribution.ts).
export async function approvePlan(
  planId: number,
  approver?: { login: string; id: number },
): Promise<number[] | null> {
  const plan = await getPlan(planId);
  if (!plan || plan.status !== 'plan_ready' || !plan.plan) return null;
  const repos = await listReposForPlan(planId);
  const acceptance: string[] = plan.acceptance ? JSON.parse(plan.acceptance) : [];
  const spec =
    `${plan.plan}\n\n## Acceptance criteria\n\n` +
    (acceptance.length ? acceptance.map((c) => `- ${c}`).join('\n') : '(none specified)') +
    `\n\nImplement the plan above so that every acceptance criterion holds.`;
  const creator =
    plan.created_by_login && plan.created_by_id !== null
      ? { login: plan.created_by_login, id: plan.created_by_id }
      : undefined;
  const author = approver ?? creator;
  const coauthor = creator && author && creator.login !== author.login ? creator : undefined;
  // Criteria travel structured (not only embedded in the spec text) so the
  // verify step can check them one by one after generation. Each repo's
  // feature is fully independent — one failing never blocks the others.
  const featureIds = await Promise.all(
    repos.map((repo) =>
      createFeature(
        repo.id,
        plan.title,
        spec,
        plan.acceptance ?? undefined,
        author,
        coauthor,
        plan.tier ?? undefined,
        plan.id,
      ),
    ),
  );
  await updatePlan(planId, { status: 'approved', featureId: featureIds[0] });
  return featureIds;
}
