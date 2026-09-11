import type { Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import type { ZodType } from 'zod';
import { parsePlanFeedback, type PlanningTier } from '../../artifacts/plan.ts';
import {
  plannerAgent,
  PLANNER_OUTPUT_DIR,
  type PlannerAnalyzeInput,
  type PlannerDraftInput,
  type PlannerInput,
} from '../../agents/planner.ts';
import { runAgent } from '../../agents/run.ts';
import type { AgentExecutionRequest } from '../../agents/types.ts';
import {
  getPlan,
  listReposForPlan,
  updatePlan,
  type PlanRow,
  type RepositoryRow,
} from '../../data/db.ts';
import { resolveWorkspaceRemote } from '../../integrations/git/provider.ts';
import { installationToken } from '../../integrations/github/app.ts';
import { githubRequest as gh } from '../../integrations/github/client.ts';
import { signArtifactKey } from '../../integrations/security/crypto.ts';
import { notifyPlanUsers } from '../../application/notifications/push.ts';
import { persistAgentLog } from '../runtime/agent-runs.ts';
import { runCodingAgent } from '../runtime/coding-agent.ts';
import {
  exportPlanningSession,
  importPlanningSession,
  PLANNING_CONFIG,
} from '../runtime/planning-session.ts';
import { redactSecrets } from '../runtime/redaction.ts';
import { resolveRunnerAuth } from '../runtime/runner-auth.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';

const CLONE_DIR = '/workspace/plan-repo';
const OUT_DIR = PLANNER_OUTPUT_DIR;
const ATTACH_DIR = '/workspace/plan-attachments';
const AGENT_TIMEOUT_MS = 8 * 60_000;

type PlanWorkspace = {
  sandbox: Sandbox;
  scrub: (value: string) => string;
  dirs: { repo: RepositoryRow; dir: string; cleanUrl: string }[];
};

// Planning gets one read-only sandbox for all attached repositories so the
// planner can design a coherent multi-repository change.
async function clonePlanRepos(repos: RepositoryRow[], planId: number): Promise<PlanWorkspace> {
  const tokens: string[] = [];
  const scrub = (value: string) => redactSecrets(value, tokens);
  const sandbox = runnerSandbox(`plan--${planId}`, { sleepAfter: '10m' });
  await sandbox.exec(`rm -rf ${CLONE_DIR} ${OUT_DIR} && mkdir -p ${OUT_DIR}`);

  const dirs: PlanWorkspace['dirs'] = [];
  for (const repo of repos) {
    const remote = await resolveWorkspaceRemote(repo, 'read');
    tokens.push(remote.token);
    const fullName = `${repo.owner}/${repo.name}`;
    let base: string;
    if (repo.provider === 'artifacts') {
      base = repo.default_branch ?? 'main';
    } else {
      const token = await installationToken(repo.installation_id);
      tokens.push(token);
      // SAFETY: GitHub's GET /repos/:owner/:repo response always includes default_branch.
      const info = (await (await gh(token, `/repos/${fullName}`)).json()) as {
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
      throw new Error(`git clone failed for ${fullName}: ${scrub(clone.stderr).slice(0, 500)}`);
    }
    dirs.push({ repo, dir, cleanUrl: remote.cleanUrl });
  }

  return { sandbox, scrub, dirs };
}

async function readText(sandbox: Sandbox, path: string): Promise<string | undefined> {
  try {
    return (await sandbox.readFile(path)).content.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readRequiredText(sandbox: Sandbox, path: string): Promise<string> {
  const content = await readText(sandbox, path);
  if (!content) throw new Error(`planner did not produce ${path}`);
  return content;
}

async function executePlanningInvocation(
  sandbox: Sandbox,
  request: AgentExecutionRequest,
  scrub: (value: string) => string,
  kind: 'plan_analyze' | 'plan_refine',
  planId: number,
  resume: boolean,
): Promise<void> {
  if (request.agentId !== plannerAgent.id || request.repositoryAccess !== 'read') {
    throw new Error('planner executor only accepts the read-only planner agent');
  }

  const auth = await resolveRunnerAuth(request.model);
  const scrubRun = (value: string) => redactSecrets(scrub(value), Object.values(auth.vars));
  const sessionKey = `planning-sessions/${planId}.json`;
  const saved = resume ? await env.ARTIFACTS.get(sessionKey) : null;
  const sessionId = saved
    ? await importPlanningSession(sandbox, auth, CLONE_DIR, await saved.text())
    : null;

  await sandbox.writeFile(`${OUT_DIR}/task.md`, request.prompt);
  const result = await runCodingAgent(sandbox, auth, {
    promptFile: `${OUT_DIR}/task.md`,
    cwd: CLONE_DIR,
    timeout: AGENT_TIMEOUT_MS,
    sessionId,
    configExtensionJson: PLANNING_CONFIG,
  });

  await persistAgentLog(
    kind,
    scrubRun(`${result.resultText}\n${result.stderr}`.trim()),
    result.success,
    { planId },
    scrubRun(result.stdout),
  );

  if (!result.success) {
    throw new Error(
      `planning agent exited ${result.exitCode}: ${scrubRun(`${result.stdout}\n${result.stderr}`).trim().slice(-1_000)}`,
    );
  }
  if (!result.codingSessionId) throw new Error('Planning agent did not return a session');

  const snapshot = await exportPlanningSession(sandbox, auth, CLONE_DIR, result.codingSessionId);
  await env.ARTIFACTS.put(sessionKey, scrubRun(snapshot), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function readPlannerOutput<Output>(
  sandbox: Sandbox,
  operation: PlannerInput['operation'],
  output: ZodType<Output>,
): Promise<Output> {
  if (operation === 'analyze') {
    const tier =
      (await readText(sandbox, `${OUT_DIR}/tier.txt`)) === 'trivial' ? 'trivial' : 'standard';
    return output.parse({
      kind: 'analysis',
      analysis: await readRequiredText(sandbox, `${OUT_DIR}/analysis.md`),
      questions: JSON.parse((await sandbox.readFile(`${OUT_DIR}/questions.json`)).content),
      tier,
    });
  }

  return output.parse({
    kind: 'plan',
    plan: await readRequiredText(sandbox, `${OUT_DIR}/plan.md`),
    summary: (await readText(sandbox, `${OUT_DIR}/summary.md`)) ?? null,
    acceptance: JSON.parse((await sandbox.readFile(`${OUT_DIR}/acceptance.json`)).content),
  });
}

async function invokePlanner(
  input: PlannerInput,
  workspace: PlanWorkspace,
  kind: 'plan_analyze' | 'plan_refine',
  planId: number,
  model: string | null,
  resume = false,
) {
  return runAgent(plannerAgent, input, {
    model,
    execute: async (request, output) => {
      await executePlanningInvocation(
        workspace.sandbox,
        request,
        workspace.scrub,
        kind,
        planId,
        resume,
      );
      return readPlannerOutput(workspace.sandbox, input.operation, output);
    },
  });
}

// User-uploaded requirements context is copied into the sandbox through a
// short-lived signed artifact URL. The returned paths become planner input.
async function fetchPlanAttachments(sandbox: Sandbox, plan: PlanRow): Promise<string[]> {
  const attachments = plan.attachments ?? [];
  if (attachments.length === 0) return [];
  await sandbox.exec(`rm -rf ${ATTACH_DIR} && mkdir -p ${ATTACH_DIR}`);
  const paths: string[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const safeName = `${index + 1}-${attachment.name.replace(/[^\w.-]/g, '_').slice(-60)}`;
    const path = `${ATTACH_DIR}/${safeName}`;
    const url = `${env.PUBLIC_BASE_URL}/artifacts/${attachment.key}?sig=${await signArtifactKey(attachment.key)}`;
    const result = await sandbox.exec(`curl -fsSL -o "${path}" "$ATT_URL"`, {
      env: { ATT_URL: url },
      timeout: 60_000,
    });
    if (result.success) paths.push(path);
    else
      console.warn(`turbodiff: attachment download failed for plan ${plan.id}: ${attachment.name}`);
  }

  return paths;
}

function plannerRepositories(dirs: PlanWorkspace['dirs']) {
  return dirs.map(({ repo, dir }) => ({ fullName: `${repo.owner}/${repo.name}`, path: dir }));
}

function normalizedTier(tier: string | null): PlanningTier {
  return tier === 'trivial' ? 'trivial' : 'standard';
}

async function cleanWorkspace(workspace: PlanWorkspace | undefined): Promise<void> {
  if (!workspace) return;
  await Promise.all(
    workspace.dirs.map(({ dir, cleanUrl }) =>
      workspace.sandbox.exec(`git -C ${dir} remote set-url origin "${cleanUrl}"`).catch(() => {}),
    ),
  );
}

export async function runPlanAnalyze(planId: number): Promise<void> {
  const plan = await getPlan(planId);
  if (!plan) return;

  const repos = await listReposForPlan(planId);
  const disabled = repos.find((repo) => !repo.enabled);
  if (repos.length === 0 || disabled) {
    await updatePlan(planId, {
      status: 'failed',
      error: disabled
        ? `repository ${disabled.owner}/${disabled.name} missing or disabled`
        : 'repository missing or disabled',
    });
    return;
  }

  const fullName = repos.map((repo) => `${repo.owner}/${repo.name}`).join(', ');
  let workspace: PlanWorkspace | undefined;
  try {
    workspace = await clonePlanRepos(repos, planId);
    const attachments = await fetchPlanAttachments(workspace.sandbox, plan);
    const analyzeInput: PlannerAnalyzeInput = {
      operation: 'analyze',
      title: plan.title,
      requirements: plan.requirements,
      repositories: plannerRepositories(workspace.dirs),
      attachments,
    };
    const analysis = await invokePlanner(
      analyzeInput,
      workspace,
      'plan_analyze',
      planId,
      plan.runner_model,
    );
    if (analysis.kind !== 'analysis') throw new Error('planner returned the wrong artifact kind');

    await updatePlan(planId, { tier: analysis.tier });
    if (analysis.questions.length === 0) {
      const draftInput: PlannerDraftInput = {
        operation: 'draft',
        title: plan.title,
        requirements: plan.requirements,
        repositories: plannerRepositories(workspace.dirs),
        attachments,
        analysis: analysis.analysis,
        tier: analysis.tier,
        answers: [],
        feedback: [],
        previousPlan: null,
        previousSummary: null,
      };
      const artifact = await invokePlanner(
        draftInput,
        workspace,
        'plan_analyze',
        planId,
        plan.runner_model,
        true,
      );
      if (artifact.kind !== 'plan') throw new Error('planner returned the wrong artifact kind');

      await updatePlan(planId, {
        status: 'plan_ready',
        analysis: analysis.analysis,
        questions: [],
        plan: artifact.plan,
        summary: artifact.summary ?? undefined,
        acceptance: artifact.acceptance,
      });
      await notifyPlanUsers(planId, {
        title: plan.title,
        body: 'Turbodiff finished a plan — ready for your review.',
        url: `${env.PUBLIC_BASE_URL}/tasks/${planId}`,
      });
    } else {
      await updatePlan(planId, {
        status: 'awaiting_answers',
        analysis: analysis.analysis,
        questions: analysis.questions,
      });
      await notifyPlanUsers(planId, {
        title: plan.title,
        body: 'Turbodiff has questions before it can plan this.',
        url: `${env.PUBLIC_BASE_URL}/tasks/${planId}`,
      });
    }

    console.log(
      `turbodiff: plan ${planId} analyzed for ${fullName} (${analysis.questions.length} questions)`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updatePlan(planId, { status: 'failed', error: message.slice(0, 500) });
    console.error(`turbodiff: plan analyze failed for ${fullName} #${planId}:`, error);
  } finally {
    await cleanWorkspace(workspace);
  }
}

export async function runPlanRefine(planId: number): Promise<void> {
  const plan = await getPlan(planId);
  if (!plan) return;

  const repos = await listReposForPlan(planId);
  const disabled = repos.find((repo) => !repo.enabled);
  if (repos.length === 0 || disabled) {
    await updatePlan(planId, {
      status: 'failed',
      error: disabled
        ? `repository ${disabled.owner}/${disabled.name} missing or disabled`
        : 'repository missing or disabled',
    });
    return;
  }

  const fullName = repos.map((repo) => `${repo.owner}/${repo.name}`).join(', ');
  let workspace: PlanWorkspace | undefined;
  try {
    workspace = await clonePlanRepos(repos, planId);
    const attachments = await fetchPlanAttachments(workspace.sandbox, plan);
    const questions = plan.questions ?? [];
    const answers = plan.answers ?? [];
    const input: PlannerDraftInput = {
      operation: 'draft',
      title: plan.title,
      requirements: plan.requirements,
      repositories: plannerRepositories(workspace.dirs),
      attachments,
      analysis: plan.analysis,
      tier: normalizedTier(plan.tier),
      answers: questions.map((question, index) => ({
        question,
        answer: answers[index] ?? '',
      })),
      feedback: parsePlanFeedback(plan.feedback),
      previousPlan: plan.plan,
      previousSummary: plan.summary,
    };
    const artifact = await invokePlanner(
      input,
      workspace,
      'plan_refine',
      planId,
      plan.runner_model,
      true,
    );
    if (artifact.kind !== 'plan') throw new Error('planner returned the wrong artifact kind');

    await updatePlan(planId, {
      status: 'plan_ready',
      plan: artifact.plan,
      summary: artifact.summary ?? undefined,
      acceptance: artifact.acceptance,
      feedback: '[]',
    });
    await notifyPlanUsers(planId, {
      title: plan.title,
      body: 'Turbodiff finished a plan — ready for your review.',
      url: `${env.PUBLIC_BASE_URL}/tasks/${planId}`,
    });
    console.log(`turbodiff: plan ${planId} refined for ${fullName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updatePlan(planId, { status: 'failed', error: message.slice(0, 500) });
    console.error(`turbodiff: plan refine failed for ${fullName} #${planId}:`, error);
  } finally {
    await cleanWorkspace(workspace);
  }
}
