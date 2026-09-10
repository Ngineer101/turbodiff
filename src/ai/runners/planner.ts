import type { Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import type { ApiPlanQuestion as Question } from '../../shared/api-types.ts';
import { isJsonArray, isJsonObject, isString, parseJson } from '../../shared/json.ts';
import { githubRequest as gh } from '../../integrations/github/client.ts';
import { signArtifactKey } from '../../integrations/security/crypto.ts';
import {
  approvePlanFeatures,
  getPlan,
  listReposForPlan,
  updatePlan,
  type PlanRow,
  type RepositoryRow,
} from '../../data/db.ts';
import { persistAgentLog } from '../runtime/agent-runs.ts';
import { runCodingAgent } from '../runtime/coding-agent.ts';
import { runManagedCommand } from '../runtime/managed-command.ts';
import { resolveRunnerAuth } from '../runtime/runner-auth.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';
import { redactSecrets } from '../runtime/redaction.ts';
import { installationToken } from '../../integrations/github/app.ts';
import { resolveWorkspaceRemote } from '../../integrations/git/provider.ts';
import { UNTRUSTED_CONTENT_RULES } from '../../domain/prompt-security.ts';
import { notifyPlanUsers } from '../../services/push-notifications.ts';

// Phase 3 of the software factory (docs/software-factory-design.md): the
// planning front half. A planning agent clones the repo (read-only), analyzes
// the requirements against the real code, asks clarifying questions, and — once
// answered — produces an implementation plan plus machine-checkable acceptance
// criteria. On approval the plan becomes a feature and flows into generation.

const CLONE_DIR = '/workspace/plan-repo';
const OUT_DIR = '/workspace/plan-out';
// Each stage has a container-enforced deadline; the Workflow covers both stages.
const AGENT_TIMEOUT_MS = 30 * 60_000;

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
  dirs: { repo: RepositoryRow; dir: string; cleanUrl: string }[];
}> {
  const tokens: string[] = [];
  const scrub = (s: string) => redactSecrets(s, tokens);

  const sandbox = runnerSandbox(`plan--${planId}`, { sleepAfter: '45m' });
  await sandbox.exec(`rm -rf ${CLONE_DIR} ${OUT_DIR} && mkdir -p ${OUT_DIR}`);

  const dirs: { repo: RepositoryRow; dir: string; cleanUrl: string }[] = [];
  for (const repo of repos) {
    // Planner sandboxes never push: contents READ-ONLY token.
    const remote = await resolveWorkspaceRemote(repo, 'read');
    tokens.push(remote.token);
    const full = `${repo.owner}/${repo.name}`;
    let base: string;
    if (repo.provider === 'artifacts') {
      // Artifacts repos carry their default branch in PostgreSQL — no forge API to
      // ask, and installationToken rejects synthetic installation ids.
      base = repo.default_branch ?? 'main';
    } else {
      const token = await installationToken(repo.installation_id);
      tokens.push(token);
      // SAFETY: GitHub's GET /repos/:owner/:repo REST schema always includes
      // default_branch.
      const info = (await (await gh(token, `/repos/${full}`)).json()) as {
        default_branch: string;
      };
      base = info.default_branch;
    }
    const dir = repos.length === 1 ? CLONE_DIR : `${CLONE_DIR}/${repo.owner}--${repo.name}`;
    if (repos.length > 1) await sandbox.exec(`mkdir -p ${dir}`);
    const clone = await sandbox.exec(
      `git ${remote.configFlags} clone --depth 50 --single-branch --branch "$GEN_BASE" ` +
        `"${remote.authUrl}" ${dir}`,
      { env: { ...remote.env, GEN_BASE: base }, timeout: 3 * 60_000 },
    );
    if (!clone.success) {
      throw new Error(`git clone failed for ${full}: ${scrub(clone.stderr).slice(0, 500)}`);
    }
    dirs.push({ repo, dir, cleanUrl: remote.cleanUrl });
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

// Parses questions.json into the structured { text, options?, recommended? }
// shape. Fails open per-entry (and per-file) the same way readJsonArray
// does: a malformed question is dropped or demoted to free-text rather than
// failing the whole analyze step.
async function readQuestions(sandbox: Sandbox, path: string): Promise<Question[]> {
  try {
    const parsed = parseJson((await sandbox.readFile(path)).content);
    if (!isJsonArray(parsed)) return [];
    return parsed
      .map((raw): Question | null => {
        if (isString(raw)) {
          const text = raw.trim();
          return text ? { text } : null;
        }
        if (!isJsonObject(raw)) return null;
        const text = isString(raw.text) ? raw.text.trim() : '';
        if (!text) return null;
        const rawOptions = isJsonArray(raw.options) ? raw.options : [];
        const options = [
          ...new Set(
            rawOptions
              .filter((o): o is string => isString(o) && o.trim().length > 0)
              .map((o) => o.trim()),
          ),
        ];
        if (options.length < 2) return { text };
        const recommended =
          isString(raw.recommended) && options.includes(raw.recommended.trim())
            ? raw.recommended.trim()
            : options[0];
        return { text, options, recommended };
      })
      .filter((q): q is Question => q !== null);
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
  kind: 'plan_analyze' | 'plan_refine',
  planId: number,
  // The task's model snapshot (plans.runner_model); null is legacy-only.
  model: string | null,
): Promise<void> {
  const auth = await resolveRunnerAuth(undefined, model);
  const scrubRun = (value: string) => redactSecrets(scrub(value), Object.values(auth.vars));
  await sandbox.writeFile(`${OUT_DIR}/task.md`, prompt);
  const res = await runCodingAgent(
    { exec: (command, options) => runManagedCommand(sandbox, command, options) },
    auth,
    {
      promptFile: `${OUT_DIR}/task.md`,
      cwd: CLONE_DIR,
      timeout: AGENT_TIMEOUT_MS,
    },
  );
  await persistAgentLog(
    kind,
    scrubRun(`${res.resultText}\n${res.stderr}`.trim()),
    res.success,
    {
      planId,
    },
    scrubRun(res.stdout),
  );
  if (!res.success) {
    throw new Error(
      `planning agent exited ${res.exitCode}: ${scrubRun(`${res.stderr}\n${res.resultText}`).trim().slice(0, 1_000)}`,
    );
  }
}

const ATTACH_DIR = '/workspace/plan-attachments';

// User-uploaded context files (R2) pulled into the sandbox with the same
// signed /artifacts capability URLs verification uses. Returns sandbox paths.
async function fetchPlanAttachments(sandbox: Sandbox, plan: PlanRow): Promise<string[]> {
  const atts = plan.attachments ?? [];
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
  extra = '',
): string {
  if (repos.length === 1) {
    const repo = repos[0];
    return `You are a planning agent for ${repo.owner}/${repo.name}. You are in a read-only checkout — study the code but do NOT modify it.
Keep the analysis proportionate: for a small, localized change, use at most 10 lines and ask questions only for a genuine blocker.
Analyze the feature requirements below against the actual codebase, then write these files (create the directory if needed):

1. ${OUT_DIR}/analysis.md — a short grounding analysis: which files/modules this touches, how it fits existing conventions, and any risks.
2. ${OUT_DIR}/questions.json — a JSON array of clarifying questions. Each question is an object: \`{ "text": "...", "options": ["...", "...", "..."], "recommended": "<exact text of one of the options>" }\`. Give 2-3 concrete, mutually-exclusive options that a user could tap to answer, and mark the one you'd recommend by repeating its exact text in \`recommended\`. If a question genuinely has no small set of sensible choices (open-ended input needed), omit \`options\`/\`recommended\` and it will be shown as free text. Include ONLY genuine ambiguities or decisions that would change the implementation. If the requirements are clear enough to implement well, write an empty array [].
3. ${OUT_DIR}/tier.txt — exactly one word: trivial or standard. Use trivial only for a small, localized change (cosmetic/styling, copy, a config value, or a small fix) with no new subsystem, schema, or API changes. Use standard for everything else, including uncertainty. Classify from the analysis you already performed; do not launch another agent for classification.

${UNTRUSTED_CONTENT_RULES}

## Feature: ${plan.title}

## Requirements
${plan.requirements}
${extra}`;
  }
  return `You are a planning agent for a feature spanning ${repos.length} repositories. You are in read-only checkouts — study the code but do NOT modify it.
Keep the analysis proportionate: for a small, localized change, use at most 10 lines and ask questions only for a genuine blocker.
## Repositories
${reposList(dirs)}

Analyze the feature requirements below against the actual code in EVERY repository above, as one coherent feature designed across all of them, then write these files (create the directory if needed):

1. ${OUT_DIR}/analysis.md — a short grounding analysis covering each repository: which files/modules it touches, how it fits existing conventions, and any risks.
2. ${OUT_DIR}/questions.json — a JSON array of clarifying questions. Each question is an object: \`{ "text": "...", "options": ["...", "...", "..."], "recommended": "<exact text of one of the options>" }\`. Give 2-3 concrete, mutually-exclusive options that a user could tap to answer, and mark the one you'd recommend by repeating its exact text in \`recommended\`. If a question genuinely has no small set of sensible choices (open-ended input needed), omit \`options\`/\`recommended\` and it will be shown as free text. Include ONLY genuine ambiguities or decisions that would change the implementation. If the requirements are clear enough to implement well, write an empty array [].
3. ${OUT_DIR}/tier.txt — exactly one word: trivial or standard. Use trivial only for a small, localized change (cosmetic/styling, copy, a config value, or a small fix) with no new subsystem, schema, or API changes. Use standard for everything else, including uncertainty. Classify from the analysis you already performed; do not launch another agent for classification.

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

1. ${OUT_DIR}/plan.md — ${trivial ? 'a brief plan (≤15 lines): the exact files to edit and what changes in each. No background essays, no scope-decision narratives.' : 'a file-level implementation plan: what changes in which files, in what order, and why. Concrete enough for an implementation agent to follow without further questions. Constraint: no preamble, no background essays, no surveys of options you rejected; do NOT copy code from the repo or write out full implementations — when logic genuinely needs showing, a few lines of pseudocode or a signature is the ceiling. Prefer naming the file/function and saying what changes over showing how the code will look.'}
2. ${OUT_DIR}/acceptance.json — a JSON array of at most ${trivial ? 4 : 8} machine-checkable acceptance criteria (strings), each about the observable behavior of the change itself. Rules:
   - NEVER include build/typecheck/test-suite-passes criteria — the harness runs the repository's check command as its own gate.
   - NEVER include "file X is unchanged" criteria — the diff itself shows that.
   - Not vague ("works well"); each must be objectively verifiable.
${trivial ? '' : `3. ${OUT_DIR}/summary.md — a short summary for the human reviewer (this is what they read first; the full plan sits behind it). Lead with 2–4 sentences: what will be built and the shape of the approach. Then a handful of bullets naming the files/areas that change and what each change does. No code, no pseudocode, no headings-per-file.\n`}
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

1. ${OUT_DIR}/plan.md — a file-level implementation plan: what changes in which files, in what order, and why. Concrete enough for an implementation agent to follow without further questions.${trivial ? '' : ' Constraint: no preamble, no background essays, no surveys of options you rejected; do NOT copy code from the repo or write out full implementations — when logic genuinely needs showing, a few lines of pseudocode or a signature is the ceiling. Prefer naming the file/function and saying what changes over showing how the code will look.'} Write one "## <owner>/<name>" section per repository listed above, so each repo's slice of the plan is identifiable.
2. ${OUT_DIR}/acceptance.json — a JSON array of at most ${trivial ? 4 : 8} machine-checkable acceptance criteria (strings), each about the observable behavior of the change itself. Rules:
   - NEVER include build/typecheck/test-suite-passes criteria — the harness runs the repository's check command as its own gate.
   - NEVER include "file X is unchanged" criteria — the diff itself shows that.
   - Not vague ("works well"); each must be objectively verifiable.
${trivial ? '' : `3. ${OUT_DIR}/summary.md — a short summary for the human reviewer (this is what they read first; the full plan sits behind it). Lead with 2–4 sentences: what will be built and the shape of the approach. Then a handful of bullets naming the files/areas that change and what each change does. No code, no pseudocode, no headings-per-file. Group the bullets by repository.\n`}
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
  const disabled = repos.find((r) => !r.enabled);
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
  let dirs: { repo: RepositoryRow; dir: string; cleanUrl: string }[] = [];
  try {
    const booted = await clonePlanRepos(repos, planId);
    sandbox = booted.sandbox;
    dirs = booted.dirs;
    const attachments = attachmentsSection(await fetchPlanAttachments(sandbox, plan));
    await runAgent(
      sandbox,
      analyzePrompt(plan, repos, dirs, attachments),
      booted.scrub,
      'plan_analyze',
      planId,
      plan.runner_model,
    );
    // Classification is an output of this task's analysis, never a separate
    // agent using the global fast model. Missing/invalid output stays conservative.
    const tier =
      (await readText(sandbox, `${OUT_DIR}/tier.txt`)) === 'trivial' ? 'trivial' : 'standard';
    await updatePlan(planId, { tier });
    const analysis = await readText(sandbox, `${OUT_DIR}/analysis.md`);
    const questions = await readQuestions(sandbox, `${OUT_DIR}/questions.json`);

    if (questions.length === 0) {
      // No ambiguities — plan immediately in the same run.
      await runAgent(
        sandbox,
        planPrompt({ ...plan, analysis: analysis ?? null }, repos, dirs, '', tier, attachments),
        booted.scrub,
        'plan_analyze',
        planId,
        plan.runner_model,
      );
      const planMd = await readText(sandbox, `${OUT_DIR}/plan.md`);
      const summary = await readText(sandbox, `${OUT_DIR}/summary.md`);
      const acceptance = await readJsonArray(sandbox, `${OUT_DIR}/acceptance.json`);
      await updatePlan(planId, {
        status: 'plan_ready',
        analysis,
        questions: [],
        plan: planMd,
        summary,
        acceptance,
      });
      await notifyPlanUsers(planId, {
        title: plan.title,
        body: 'Turbodiff finished a plan — ready for your review.',
        url: `${env.PUBLIC_BASE_URL}/tasks/${planId}`,
      });
    } else {
      await updatePlan(planId, {
        status: 'awaiting_answers',
        analysis,
        questions,
      });
      await notifyPlanUsers(planId, {
        title: plan.title,
        body: 'Turbodiff has questions before it can plan this.',
        url: `${env.PUBLIC_BASE_URL}/tasks/${planId}`,
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
        dirs.map(({ dir, cleanUrl }) =>
          sandbox!.exec(`git -C ${dir} remote set-url origin "${cleanUrl}"`).catch(() => {}),
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
  const disabled = repos.find((r) => !r.enabled);
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
  const questions: Question[] = plan.questions ?? [];
  const answers = plan.answers ?? [];
  const qa =
    questions.length > 0
      ? '\n## Clarifying questions and answers\n' +
        questions.map((q, i) => `Q: ${q.text}\nA: ${answers[i] ?? '(no answer)'}`).join('\n\n')
      : '';
  // Snippet-anchored review comments (batched in the UI): a feedback-driven
  // refine revises the previous draft rather than planning from scratch.
  const feedback: { snippet: string; comment: string }[] = plan.feedback
    ? JSON.parse(plan.feedback)
    : [];
  const fb =
    feedback.length > 0
      ? `\n## Reviewer feedback on the previous draft\nThe user reviewed the previous plan draft and left the comments below. Produce a REVISED plan that addresses every comment — keep what wasn't commented on unless a comment forces a change.${plan.summary ? ` Also write a revised ${OUT_DIR}/summary.md for the new draft.` : ''}\n\n### Previous draft\n${plan.summary ? `#### Summary shown to the reviewer\n${plan.summary}\n\n` : ''}${plan.plan ?? '(none)'}\n\n### Comments\n${feedback.map((f, i) => `${i + 1}. On "${f.snippet}": ${f.comment}`).join('\n')}\n`
      : '';

  let sandbox: Sandbox | undefined;
  let dirs: { repo: RepositoryRow; dir: string; cleanUrl: string }[] = [];
  try {
    const booted = await clonePlanRepos(repos, planId);
    sandbox = booted.sandbox;
    dirs = booted.dirs;
    const attachments = attachmentsSection(await fetchPlanAttachments(sandbox, plan));
    await runAgent(
      sandbox,
      planPrompt(plan, repos, dirs, qa + fb, plan.tier ?? 'standard', attachments),
      booted.scrub,
      'plan_refine',
      planId,
      plan.runner_model,
    );
    const planMd = await readText(sandbox, `${OUT_DIR}/plan.md`);
    const summary = await readText(sandbox, `${OUT_DIR}/summary.md`);
    const acceptance = await readJsonArray(sandbox, `${OUT_DIR}/acceptance.json`);
    await updatePlan(planId, {
      status: 'plan_ready',
      plan: planMd,
      summary,
      acceptance,
      // Consumed — a later answers-driven refine must not replay it.
      feedback: '[]',
    });
    await notifyPlanUsers(planId, {
      title: plan.title,
      body: 'Turbodiff finished a plan — ready for your review.',
      url: `${env.PUBLIC_BASE_URL}/tasks/${planId}`,
    });
    console.log(`turbodiff: plan ${planId} refined for ${full}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updatePlan(planId, { status: 'failed', error: message.slice(0, 500) });
    console.error(`turbodiff: plan refine failed for ${full} #${planId}:`, err);
  } finally {
    if (sandbox) {
      await Promise.all(
        dirs.map(({ dir, cleanUrl }) =>
          sandbox!.exec(`git -C ${dir} remote set-url origin "${cleanUrl}"`).catch(() => {}),
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
// (see src/domain/attribution.ts).
export async function approvePlan(
  planId: number,
  approver?: { login: string; id: number },
): Promise<number[] | null> {
  const plan = await getPlan(planId);
  if (!plan || plan.status !== 'plan_ready' || !plan.plan) return null;
  const repos = await listReposForPlan(planId);
  const acceptance = plan.acceptance ?? [];
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
  return approvePlanFeatures(
    planId,
    repos.map((repo) => ({
      repositoryId: repo.id,
      title: plan.title,
      spec,
      acceptance: plan.acceptance,
      authorLogin: author?.login ?? null,
      authorId: author?.id ?? null,
      coauthorLogin: coauthor?.login ?? null,
      coauthorId: coauthor?.id ?? null,
      tier: plan.tier,
    })),
  );
}
