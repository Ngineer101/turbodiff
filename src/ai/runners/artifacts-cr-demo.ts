import { env } from 'cloudflare:workers';
import { redactSecrets } from '../runtime/redaction.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';
import { CR_SANDBOX_ID, type CrTiming } from './artifacts-cr-engine.ts';

// Phase-0.5 demo fixture (docs/artifacts-cr-spike.md): a tiny pricing service
// on Artifacts with two feature branches that both merge cleanly against main
// but edit the same lines of pricing.ts — so merging the first flips the
// second CR to conflicted. That ripple is the story the prototype exists to
// show: PR mechanics with no forge underneath.

export const DEMO_BRANCHES = [
  { branch: 'turbodiff/feat-1-annual-billing', title: 'Annual billing interval for paid plans' },
  { branch: 'turbodiff/feat-2-enterprise-tier', title: 'Enterprise tier with custom pricing' },
] as const;

export interface DemoRepoResult {
  repo: { name: string; remote: string; defaultBranch: string };
  branches: typeof DEMO_BRANCHES;
  timings: CrTiming[];
}

// Demo file contents deliberately avoid template-literal syntax so they can
// live in plain strings here without escaping games.
const README_MD = `# demo-pricing

Tiny pricing service used by the turbodiff Artifacts change-request
prototype (docs/artifacts-cr-spike.md). Everything about this repo lives on
Cloudflare Artifacts — it has never seen GitHub.
`;

const INDEX_TS = `import { priceFor } from './pricing.ts';

export default {
  fetch(request: Request): Response {
    const plan = new URL(request.url).searchParams.get('plan') ?? 'hobby';
    return Response.json({ plan, monthlyUsd: priceFor(plan) });
  },
};
`;

const PRICING_MAIN = `export interface Plan {
  name: string;
  monthlyUsd: number;
}

export const PLANS: Plan[] = [
  { name: 'hobby', monthlyUsd: 0 },
  { name: 'pro', monthlyUsd: 20 },
];

export function priceFor(planName: string): number {
  const plan = PLANS.find((p) => p.name === planName);
  if (!plan) throw new Error('unknown plan: ' + planName);
  return plan.monthlyUsd;
}
`;

const PRICING_ANNUAL = `export interface Plan {
  name: string;
  monthlyUsd: number;
  annualUsd: number;
}

export const PLANS: Plan[] = [
  { name: 'hobby', monthlyUsd: 0, annualUsd: 0 },
  { name: 'pro', monthlyUsd: 20, annualUsd: 192 },
];

export type BillingInterval = 'monthly' | 'annual';

export function priceFor(planName: string, interval: BillingInterval = 'monthly'): number {
  const plan = PLANS.find((p) => p.name === planName);
  if (!plan) throw new Error('unknown plan: ' + planName);
  return interval === 'annual' ? plan.annualUsd : plan.monthlyUsd;
}
`;

const PRICING_TEST = `import { priceFor } from './pricing.ts';

if (priceFor('pro', 'annual') !== 192) throw new Error('annual pro price');
if (priceFor('pro') !== 20) throw new Error('monthly stays the default');
if (priceFor('hobby') !== 0) throw new Error('hobby is free');
`;

const PRICING_ENTERPRISE = `export interface Plan {
  name: string;
  monthlyUsd: number | null;
}

export const PLANS: Plan[] = [
  { name: 'hobby', monthlyUsd: 0 },
  { name: 'pro', monthlyUsd: 20 },
  { name: 'enterprise', monthlyUsd: null },
];

export function priceFor(planName: string): number {
  const plan = PLANS.find((p) => p.name === planName);
  if (!plan) throw new Error('unknown plan: ' + planName);
  if (plan.monthlyUsd === null) {
    throw new Error(planName + ' is custom-priced, contact sales');
  }
  return plan.monthlyUsd;
}
`;

export async function buildCrDemoRepo(): Promise<DemoRepoResult> {
  const name = `cr-demo-${crypto.randomUUID().slice(0, 6)}`;
  const timings: CrTiming[] = [];
  const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const value = await run();
    timings.push({ step: label, ms: Date.now() - started });
    return value;
  };

  const created = await step('create repo (binding)', () =>
    env.GIT_ARTIFACTS.create(name, { description: 'turbodiff phase-0.5 CR prototype demo' }),
  );

  const sandbox = runnerSandbox(CR_SANDBOX_ID);
  const dir = `/tmp/artifacts-cr/${name}`;
  // The repo-creation token is write-scoped; reuse it for the fixture pushes.
  const execEnv = { GIT_TOKEN: created.token, REMOTE: created.remote };
  const run = async (label: string, command: string, timeoutMs = 2 * 60_000): Promise<void> => {
    await step(label, async () => {
      const result = await sandbox.exec(`cd ${dir} && ${command}`, {
        env: execEnv,
        timeout: timeoutMs,
      });
      if (!result.success) {
        throw new Error(
          `${label}: ${redactSecrets(result.stderr || result.stdout, [created.token]).slice(0, 500)}`,
        );
      }
      return undefined;
    });
  };
  const auth = '-c http.extraHeader="Authorization: Bearer $GIT_TOKEN"';

  await step('init workspace (sandbox)', async () => {
    // First exec on a cold container pays the boot, hence the timeout.
    const result = await sandbox.exec(
      // mkdir src up front — writeFile's parent-dir behavior is undocumented.
      `rm -rf ${dir} && mkdir -p ${dir}/src && cd ${dir} && git init -q -b main && ` +
        `git config user.name "turbodiff[bot]" && git config user.email "bot@turbodiff.dev"`,
      { timeout: 5 * 60_000 },
    );
    if (!result.success) throw new Error(`init failed: ${result.stderr.slice(0, 500)}`);
    return undefined;
  });

  await step('write scaffold files', async () => {
    await sandbox.writeFile(`${dir}/README.md`, README_MD);
    await sandbox.writeFile(`${dir}/src/index.ts`, INDEX_TS);
    await sandbox.writeFile(`${dir}/src/pricing.ts`, PRICING_MAIN);
    return undefined;
  });
  await run(
    'commit + push main',
    `git add -A && git commit -q -m "Scaffold pricing service" && git ${auth} push -q "$REMOTE" main`,
  );

  const [annual, enterprise] = DEMO_BRANCHES;
  await run(`branch ${annual.branch}`, `git checkout -q -b ${annual.branch}`);
  await step('write annual-billing changes', async () => {
    await sandbox.writeFile(`${dir}/src/pricing.ts`, PRICING_ANNUAL);
    await sandbox.writeFile(`${dir}/src/pricing.test.ts`, PRICING_TEST);
    return undefined;
  });
  await run(
    `commit + push ${annual.branch}`,
    `git add -A && git commit -q -m "feat: annual billing interval" && ` +
      `git ${auth} push -q "$REMOTE" ${annual.branch}`,
  );

  await run(
    `branch ${enterprise.branch}`,
    `git checkout -q main && git checkout -q -b ${enterprise.branch}`,
  );
  await step('write enterprise-tier changes', async () => {
    await sandbox.writeFile(`${dir}/src/pricing.ts`, PRICING_ENTERPRISE);
    return undefined;
  });
  await run(
    `commit + push ${enterprise.branch}`,
    `git add -A && git commit -q -m "feat: enterprise tier" && ` +
      `git ${auth} push -q "$REMOTE" ${enterprise.branch}`,
  );
  // Leave the shared workspace on main so the CR engine's fetch starts clean.
  await run('checkout main', 'git checkout -q main');

  return {
    repo: { name: created.name, remote: created.remote, defaultBranch: created.defaultBranch },
    branches: DEMO_BRANCHES,
    timings,
  };
}
