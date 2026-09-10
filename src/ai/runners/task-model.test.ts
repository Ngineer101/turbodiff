import type { ExecOptions } from '@cloudflare/sandbox';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { verifyAiGatewayGrantWithSecret } from '../../integrations/security/ai-gateway-grant.ts';
import { runPlanAnalyze } from './planner.ts';
import { runVerification } from './verifier.ts';

// Runner contract tests: orchestration, OpenCode command/config generation and
// capability signing are real. Sandbox execution, persistence and other services
// are faked; these tests do not exercise the actual CLI, database or provider.
const boundary = vi.hoisted(() => {
  const runs: { command: string; prompt: string; env: Record<string, string | undefined> }[] = [];
  return {
    files: new Map<string, string>(),
    runs,
    tier: 'trivial',
    plan: {
      id: 10,
      repository_id: 1,
      title: 'Show running tasks in the factory indicator',
      requirements: 'Include manual tasks in the existing running indicator.',
      runner_model: 'moonshotai/kimi-k3',
      attachments: [],
    },
    repo: {
      id: 1,
      installation_id: 1,
      owner: 'test-owner',
      name: 'test-repo',
      provider: 'artifacts',
      default_branch: 'main',
      enabled: true,
      demo_videos: false,
      launchable: false,
      run_command: null,
      auto_fix: true,
    },
    updatePlan: vi.fn(),
    setProposedAcceptance: vi.fn(),
    resolveRunnerModel: vi.fn(async () => 'anthropic/claude-opus-4.8'),
    exec: vi.fn(),
  };
});

vi.mock('@cloudflare/sandbox', () => ({ collectFile: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  env: {
    ARTIFACTS: {
      get: async (key: string) =>
        boundary.files.has(key) ? { text: async () => boundary.files.get(key)! } : null,
      put: async (key: string, content: string) => {
        boundary.files.set(key, content);
      },
    },
    AI_GATEWAY_ACCOUNT_ID: 'test-account',
    AI_GATEWAY_ID: 'test-gateway',
    AI_GATEWAY_API_TOKEN: 'test-only-gateway-secret',
    PUBLIC_BASE_URL: 'https://turbodiff.test',
  },
}));
vi.mock('../../data/models.ts', () => ({ resolveRunnerModel: boundary.resolveRunnerModel }));
vi.mock('../../data/db.ts', () => ({
  getPlan: async () => boundary.plan,
  listReposForPlan: async () => [boundary.repo],
  updatePlan: boundary.updatePlan,
  approvePlanFeatures: vi.fn(),
  getFeature: async () => ({
    id: 20,
    repository_id: 1,
    branch: 'feature-20',
    pr_number: 7,
    title: boundary.plan.title,
    runner_model: boundary.plan.runner_model,
    acceptance: ['Indicator follows automation state'],
    acceptance_updated_at: null,
  }),
  getRepoById: async () => boundary.repo,
  createVerification: async () => 30,
  finishVerification: vi.fn(),
  latestFixedAttempt: async () => ({
    trigger: 'cockpit_comment',
    created_at: '2026-09-09T19:00:00Z',
  }),
  setFeatureCriteriaConflict: vi.fn(),
  listCockpitComments: async () => [
    { path: 'indicator.tsx', line: 10, body: 'Include manual tasks.' },
  ],
  setProposedAcceptance: boundary.setProposedAcceptance,
}));
vi.mock('../runtime/sandbox.ts', () => {
  const sandbox = {
    exec: boundary.exec,
    writeFile: async (path: string, content: string) => {
      boundary.files.set(path, content);
    },
    readFile: async (path: string) => {
      const content = boundary.files.get(path);
      if (content === undefined) throw new Error('File not found');
      return { content };
    },
  };
  return { runnerSandbox: () => sandbox, generationSandbox: () => sandbox };
});
vi.mock('../runtime/agent-runs.ts', () => ({ persistAgentLog: vi.fn() }));
vi.mock('../runtime/repository-workspace.ts', () => ({ prepareCachedWorktree: vi.fn() }));
vi.mock('../../integrations/github/app.ts', () => ({ installationToken: vi.fn() }));
vi.mock('../../integrations/github/client.ts', () => ({ githubRequest: vi.fn() }));
vi.mock('../../integrations/git/provider.ts', () => ({
  resolveWorkspaceRemote: async () => ({
    token: 'test-repo-token',
    configFlags: '',
    authUrl: 'https://git.test/repo',
    cleanUrl: 'https://git.test/repo',
    env: {},
  }),
}));
vi.mock('../../services/push-notifications.ts', () => ({ notifyPlanUsers: vi.fn() }));
vi.mock('../../services/auto-merge.ts', () => ({ maybeAutoMerge: vi.fn() }));
vi.mock('../../services/merge-conflicts.ts', () => ({ maybeResolveConflict: vi.fn() }));
vi.mock('../../services/change-requests.ts', () => ({
  CR_BOT_AUTHOR: 'test-bot',
  maybeAutoMergeCr: vi.fn(),
}));
vi.mock('../../services/factory-queue.ts', () => ({ enqueueFactoryMessage: vi.fn() }));
vi.mock('../../services/certificates.ts', () => ({ certificateUrl: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  boundary.files.clear();
  boundary.runs.length = 0;
  boundary.tier = 'trivial';
  boundary.exec.mockImplementation(async (command: string, options?: ExecOptions) => {
    if (command.startsWith('opencode export ')) {
      boundary.files.set(
        options!.env!.TURBODIFF_SESSION_FILE!,
        JSON.stringify({ info: { id: 'ses_testplanning123' }, messages: [] }),
      );
    }
    if (command.startsWith('opencode import ')) {
      return {
        success: true,
        exitCode: 0,
        stdout: 'Imported session: ses_testplanning123',
        stderr: '',
      };
    }
    if (command.startsWith('opencode run ')) {
      const env = options?.env ?? {};
      const prompt = boundary.files.get(env.TURBODIFF_AGENT_PROMPT ?? '') ?? '';
      boundary.runs.push({ command, prompt, env });
      if (env.TURBODIFF_AGENT_PROMPT === '/workspace/plan-out/task.md') {
        boundary.files.set('/workspace/plan-out/analysis.md', 'Update the running-state selector.');
        boundary.files.set('/workspace/plan-out/questions.json', '[]');
        boundary.files.set('/workspace/plan-out/tier.txt', boundary.tier);
        boundary.files.set(
          '/workspace/plan-out/plan.md',
          'Update the selector and verify manual task states.',
        );
        boundary.files.set(
          '/workspace/plan-out/acceptance.json',
          '["Manual tasks activate the indicator"]',
        );
        if (boundary.tier !== 'trivial') {
          boundary.files.set(
            '/workspace/plan-out/summary.md',
            'Update the running indicator to include manual tasks.',
          );
        }
      } else if (env.TURBODIFF_AGENT_PROMPT === '/workspace/verify-out-20/task.md') {
        boundary.files.set(
          '/workspace/verify-out-20/results.json',
          '[{"index":0,"verdict":"fail","note":"Manual tasks now activate the indicator too"}]',
        );
      } else if (env.TURBODIFF_AGENT_PROMPT === '/workspace/criteria-prompt-20.md') {
        boundary.files.set(
          '/workspace/criteria-proposal-20.json',
          '["Indicator follows automations and manual tasks"]',
        );
      }
    }
    return {
      success: true,
      exitCode: 0,
      stdout: '{"type":"text","sessionID":"ses_testplanning123","part":{"text":"Done"}}',
      stderr: '',
    };
  });
});

async function expectRunModels(models: string[]) {
  expect(boundary.runs).toHaveLength(models.length);
  for (const [index, model] of models.entries()) {
    const { command, env } = boundary.runs[index];
    expect(command).toContain(' --model "$TURBODIFF_RUNNER_MODEL"');
    expect(env.TURBODIFF_RUNNER_MODEL).toBe(`cloudflare-ai-gateway/${model}`);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({
      enabled_providers: ['cloudflare-ai-gateway'],
      provider: {
        'cloudflare-ai-gateway': {
          options: {
            apiKey: '{env:TURBODIFF_AI_GATEWAY_GRANT}',
            baseURL: 'https://turbodiff.test/ai-proxy/v1',
          },
          models: { [model]: { name: model } },
        },
      },
    });
    expect(
      await verifyAiGatewayGrantWithSecret(
        'test-only-gateway-secret',
        env.TURBODIFF_AI_GATEWAY_GRANT ?? '',
      ),
    ).toMatchObject({ model });
  }
}

describe('task model across planning and verification', () => {
  it('plans with the selected model without a separate classifier session', async () => {
    await runPlanAnalyze(10);

    await expectRunModels(['moonshotai/kimi-k3', 'moonshotai/kimi-k3']);
    expect(boundary.runs[0].prompt).toContain('/workspace/plan-out/tier.txt');
    expect(boundary.updatePlan).toHaveBeenCalledWith(10, { tier: 'trivial' });
    expect(boundary.runs[1].prompt).toContain('at most 4');
    expect(boundary.runs[1].env.TURBODIFF_AGENT_SESSION).toBe('ses_testplanning123');
    expect(boundary.updatePlan).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        status: 'plan_ready',
        acceptance: ['Manual tasks activate the indicator'],
      }),
    );
  });

  it('does not shorten the plan when classification says "not trivial"', async () => {
    boundary.tier = 'not trivial';
    await runPlanAnalyze(10);

    expect(boundary.updatePlan).toHaveBeenCalledWith(10, { tier: 'standard' });
    expect(boundary.runs[1].prompt).toContain('at most 8');
    expect(boundary.updatePlan).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ status: 'plan_ready' }),
    );
  });

  it('uses the selected model for criteria rewrites after a human-directed fix', async () => {
    await runVerification(20);

    await expectRunModels(['moonshotai/kimi-k3', 'moonshotai/kimi-k3']);
    expect(boundary.setProposedAcceptance).toHaveBeenCalledWith(20, [
      'Indicator follows automations and manual tasks',
    ]);
  });
});
