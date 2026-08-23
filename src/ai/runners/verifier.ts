import { collectFile, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import {
  isJsonArray,
  isJsonObject,
  isString,
  parseJson,
  type JsonValue,
} from '../../shared/json.ts';
import { githubRequest as gh } from '../../integrations/github/client.ts';
import { claudeCliResultText, parseClaudeCliUsage, type CliUsage } from '../runtime/cli-usage.ts';
import {
  addCrComment,
  createVerification,
  finishVerification,
  getFeature,
  getRepoById,
  upsertCrCheck,
  type FeatureRow,
  type RepositoryRow,
  setRepoRunCommand,
  setRepoLaunchable,
  latestFixedAttempt,
  setFeatureCriteriaConflict,
  listCockpitComments,
  setProposedAcceptance,
} from '../../data/db.ts';
import { persistAgentLog } from '../runtime/agent-runs.ts';
import { maybeAutoMerge } from '../../services/auto-merge.ts';
import { maybeResolveConflict } from '../../services/merge-conflicts.ts';
import { CR_BOT_AUTHOR, maybeAutoMergeCr } from '../../services/change-requests.ts';
import { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import { certificateUrl } from '../../services/certificates.ts';
import { cockpitFeatureUrl } from '../../services/urls.ts';
import { formatUnmetCriteriaFindings, type CriterionResult } from '../../domain/verification.ts';
import { parseUtc } from '../../shared/time.ts';
import { signArtifactKey } from '../../integrations/security/crypto.ts';
import { resolveRunnerAuth, runnerEnvironment, type RunnerAuth } from '../runtime/runner-auth.ts';
import { generationSandbox, isSandboxTransportError } from '../runtime/sandbox.ts';
import { redactSecrets } from '../runtime/redaction.ts';
import { prepareCachedWorktree } from '../runtime/repository-workspace.ts';
import { installationToken } from '../../integrations/github/app.ts';
import { resolveWorkspaceRemote } from '../../integrations/git/provider.ts';
import { NPM_CACHE_ENV } from '../runtime/sandbox-deps.ts';
import { UNTRUSTED_CONTENT_RULES } from '../../domain/prompt-security.ts';

// Phase 4 (docs/software-factory-design.md): empirical verification of factory
// PRs, doubling as the spec-conformance gate. A verifier agent checks each
// acceptance criterion against the checked-out PR branch — static criteria by
// reading the tree, runtime criteria by launching the app (repo.run_command)
// and exercising it, visual criteria by driving headless Chromium and
// capturing screenshots. The evidence lands on the PR as a report comment;
// failed criteria feed the existing auto-fix loop.

// Verification shares GENERATION's per-repo container (same sandbox id), so
// a verify that follows a generation lands on a hot container with the repo
// git cache and package caches already warm. Work/output dirs are
// per-feature for isolation; only the caches are shared.
const CACHE_DIR = '/workspace/repo-cache';
const cloneDir = (featureId: number) => `/workspace/verify-${featureId}`;
const outDir = (featureId: number) => `/workspace/verify-out-${featureId}`;
const shotsDir = (featureId: number) => `${outDir(featureId)}/screenshots`;
// Verification runs inside a Workflow step (no wall clock), so the agent can
// afford launch discovery + screenshots + a recording.
const AGENT_TIMEOUT_MS = 20 * 60_000;

function verifyPrompt(feature: FeatureRow, repo: RepositoryRow, criteria: string[]): string {
  const OUT_DIR = outDir(feature.id);
  const SHOTS_DIR = shotsDir(feature.id);
  const demos = repo.demo_videos === 1;
  // launchable is the cached detection verdict: 0 means a previous run
  // proved this repo can't launch in the sandbox — skip discovery entirely.
  const detect = !repo.run_command && demos && repo.launchable !== 0;
  const demosPossible = demos && (repo.run_command !== null || detect);
  const launch = repo.run_command
    ? `## Running the app
The app can be launched with:

    ${repo.run_command}

It listens on port ${repo.app_port ?? '(unknown — check the repo)'} once ready.
Start it in the background (e.g. \`nohup ... > /tmp/app.log 2>&1 &\`), wait for
the port to accept connections, and verify runtime criteria against it with
curl or small node scripts. If it fails to start, mark runtime criteria as
"skip" with a note quoting the relevant log lines — do NOT mark them "fail"
for infrastructure reasons.`
    : detect
      ? `## Running the app (work it out yourself)
No launch command is configured. Determine how to run this app from the
repository itself: package.json scripts (dev/start/preview), the README,
framework config, lockfiles. Install dependencies first if needed. Launch in
the background (\`nohup ... > /tmp/app.log 2>&1 &\`), wait for its port to
accept connections, and verify runtime criteria against the live app.

Timebox launch discovery to a few minutes. If the app needs Docker,
containers, cloud bindings (e.g. Cloudflare Workers/D1/R2), a database, or
other external services to run, treat it as NOT launchable here — do not
fight it; verify statically instead.

Record your conclusion either way by writing ${OUT_DIR}/run-command.json:
- launched successfully: {"command": "<one shell command, including any install step>", "port": <number>}
- not launchable here: {"launchable": false, "reason": "<one line why>"}
so future verification runs skip this discovery entirely.

If this repository is NOT a launchable app with a web UI (a library, an
API-only service, a mobile app), do not force it: verify what you can
statically, mark runtime-only criteria "skip" with a note, and skip
screenshots and the recording. If it fails to start after honest attempts,
mark runtime criteria "skip" quoting the relevant log lines — do NOT mark
them "fail" for infrastructure reasons.`
      : `## Running the app
This repository is known not to be launchable in this sandbox (cached from a
previous run). Verify what can be verified statically from the tree; mark
criteria that would need a running app as "skip" with a note saying why.`;
  const runtime = `${launch}

## Screenshots
A headless Chrome binary is installed (its path is in the env var
PUPPETEER_EXECUTABLE_PATH) and puppeteer-core is globally available via
NODE_PATH. For criteria with user-visible behavior, write a small node script
that opens the relevant page/state and captures PNG screenshots into
${SHOTS_DIR}/ (create it). Write capture scripts as CommonJS (.cjs files using
require('puppeteer-core')) — ESM import cannot resolve the global install.
Launch with args ['--no-sandbox', '--disable-dev-shm-usage']. Use descriptive
kebab-case filenames and reference each screenshot from the matching
criterion result.

${
  demosPossible
    ? `## Demo recording
Also record ONE short screen recording (10–30 seconds) demonstrating the
feature's happy path end to end. This is what humans watch, so drive it like a
demo: pause about a second between meaningful steps and let each state change
be visible before moving on. In a .cjs script, use puppeteer's screencast API:

    const recorder = await page.screencast({ path: '${OUT_DIR}/demo.webm' });
    // ... drive the flow deliberately ...
    await recorder.stop();

Write a one-line caption for the recording to ${OUT_DIR}/demo-caption.txt.
If the app cannot run, skip the recording.`
    : `Do not record a demo for this repository.`
}`;

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
      demo: outcome.demo
        ? JSON.stringify({ video: outcome.demo.key, caption: outcome.demo.caption })
        : undefined,
      usage: outcome.usage ?? undefined,
    });
    console.log(`turbodiff: verification ${outcome.status} for ${label}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishVerification(verificationId, 'error', { error: message.slice(0, 500) });
    console.error(`turbodiff: verification errored for ${label}:`, err);
    // Container-layer 500s are weather, not verdicts: rethrow so the
    // workflow step's retry re-runs the verification (a fresh row supersedes
    // this errored one). Business errors stay recorded-and-final.
    if (isSandboxTransportError(err)) throw err;
  }
}

async function verify(
  feature: FeatureRow,
  repo: RepositoryRow,
  criteria: string[],
): Promise<{
  status: string;
  results: CriterionResult[];
  summary?: string;
  demo?: DemoInfo;
  usage: CliUsage | null;
}> {
  // Artifacts repos have no GitHub side; every GitHub call below is gated on
  // provider, and the empty token is inert in the scrub list.
  const token = repo.provider === 'github' ? await installationToken(repo.installation_id) : '';
  const auth = resolveRunnerAuth();
  // Verifier sandboxes never push: single-repo, contents READ-ONLY token.
  const remote = await resolveWorkspaceRemote(repo, 'read');
  const scrub = (s: string) => redactSecrets(s, [token, remote.token]);
  const full = `${repo.owner}/${repo.name}`;

  // Same container id as generation: verify usually follows a generation on
  // the same repo, so the container, repo cache, and package caches are warm.
  const sandbox = generationSandbox(repo);
  const WORK = cloneDir(feature.id);
  const OUT = outDir(feature.id);

  try {
    await sandbox.exec(`rm -rf ${WORK} ${OUT} && mkdir -p ${shotsDir(feature.id)}`);
    // Warm path: force-fetch the PR branch into the shared repo cache, then
    // hardlink-clone it into this feature's own working dir. Cold path
    // bootstraps the cache.
    await prepareCachedWorktree({
      sandbox,
      cacheDir: CACHE_DIR,
      workDir: WORK,
      remote,
      base: feature.branch!,
      secrets: [token],
    });

    await sandbox.writeFile(`${OUT}/task.md`, verifyPrompt(feature, repo, criteria));
    const agent = await sandbox.exec(
      `claude -p --dangerously-skip-permissions --output-format json < ${OUT}/task.md`,
      {
        cwd: WORK,
        timeout: AGENT_TIMEOUT_MS,
        env: runnerEnvironment(auth, NPM_CACHE_ENV),
      },
    );
    const usage = parseClaudeCliUsage(agent.stdout);
    const resultText = claudeCliResultText(agent.stdout);
    await persistAgentLog('verify', scrub(`${resultText}\n${agent.stderr}`.trim()), agent.success, {
      featureId: feature.id,
    });
    if (!agent.success) {
      throw new Error(
        `verifier agent exited ${agent.exitCode}: ${scrub(`${resultText}\n${agent.stderr}`).trim().slice(-1_000)}`,
      );
    }

    const results = await readResults(sandbox, OUT, criteria.length);
    const summary = await readText(sandbox, `${OUT}/summary.md`);
    const shots = await uploadScreenshots(sandbox, feature.id, results);
    const demo = repo.demo_videos === 1 ? await uploadDemo(sandbox, feature.id) : undefined;

    // Cache the agent's discovery verdict — positive OR negative — so future
    // runs skip it entirely. Same trust domain as running the repo's own
    // code; the sandbox is the boundary.
    if (!repo.run_command && repo.launchable !== 0) {
      try {
        const detected = parseJson((await sandbox.readFile(`${OUT}/run-command.json`)).content);
        if (isJsonObject(detected)) {
          if (detected.launchable === false) {
            await setRepoLaunchable(repo.id, false);
            console.log(
              `turbodiff: cached NOT-launchable verdict for ${full}: ${String(detected.reason ?? '').slice(0, 120)}`,
            );
          } else {
            const cmd = isString(detected.command) ? detected.command.trim() : '';
            const port = Number(detected.port);
            if (cmd && cmd.length <= 500 && Number.isInteger(port) && port > 0 && port < 65536) {
              await setRepoRunCommand(repo.id, cmd, port);
              await setRepoLaunchable(repo.id, true);
              console.log(`turbodiff: cached auto-detected run command for ${full} (port ${port})`);
            }
          }
        }
      } catch {
        // nothing written — discovery inconclusive; try again next run
      }
    }

    const failed = results.filter((r) => r.verdict === 'fail');
    if (repo.provider === 'artifacts') {
      // Native tail (docs/artifacts-provider.md): the report lands on the
      // change request, the 'verify' check records the outcome, and native
      // auto-merge takes over from the GitHub one. Conflict state is already
      // maintained by the CR engine's dry-runs.
      if (feature.change_request_id) {
        const cert = failed.length === 0 ? await certificateUrl(feature.id) : null;
        await addCrComment({
          changeRequestId: feature.change_request_id,
          file: null,
          line: null,
          author: CR_BOT_AUTHOR,
          kind: 'comment',
          severity: null,
          body: reportBody(
            repo,
            feature,
            criteria,
            results,
            shots,
            summary,
            demo,
            failed.length,
            cert,
          ),
        }).catch((err) => console.error('turbodiff: CR verification report failed:', err));
        await upsertCrCheck(
          feature.change_request_id,
          'verify',
          failed.length === 0 ? 'passed' : 'failed',
          `${results.length - failed.length}/${results.length} criteria met`,
        );
        if (failed.length === 0) await maybeAutoMergeCr(repo, feature.change_request_id);
      }
    } else {
      await postReport(token, repo, feature, criteria, results, shots, summary, demo);
      // Conflict detection runs on every verification completion — not only the
      // auto-merge-eligible path — so auto_resolve_conflicts works standalone.
      await maybeResolveConflict(repo, feature.pr_number!);
      if (failed.length === 0) {
        await maybeAutoMerge(repo, feature.pr_number!);
      }
    }

    // Conformance gate: unmet criteria feed the existing fix loop (toggle and
    // cap are re-validated by the consumer, exactly like review-driven fixes).
    // EXCEPT when the code's latest fix came from a human cockpit comment —
    // auto-"fixing" then means silently reverting a human's explicit
    // instruction. Flag the conflict and wait for their decision instead.
    if (failed.length > 0 && repo.auto_fix === 1) {
      const lastFixed = await latestFixedAttempt(repo.id, feature.pr_number!);
      // The guard fires only while the contract is UN-resolved: a criteria
      // edit after the comment-driven fix means the human already chose —
      // failures then feed the normal fix path toward their new criteria.
      const criteriaPredateFix =
        !feature.acceptance_updated_at ||
        (lastFixed !== null &&
          parseUtc(feature.acceptance_updated_at) < parseUtc(lastFixed.created_at));
      if (lastFixed?.trigger === 'cockpit_comment' && criteriaPredateFix) {
        await setFeatureCriteriaConflict(feature.id, true);
        await proposeUpdatedCriteria(sandbox, auth, feature, criteria, results).catch((err) =>
          console.warn('turbodiff: criteria proposal drafting failed (card falls back):', err),
        );
        await postCriteriaConflictNotice(token, repo, feature, criteria, results);
        console.log(
          `turbodiff: criteria conflict flagged for feature ${feature.id} — awaiting decision`,
        );
      } else {
        await enqueueFactoryMessage({
          kind: 'fix',
          repoId: repo.id,
          prNumber: feature.pr_number!,
          trigger: 'verification_failed',
          findings: formatUnmetCriteriaFindings(criteria, results),
        });
      }
    }
    return { status: failed.length > 0 ? 'failed' : 'passed', results, summary, demo, usage };
  } finally {
    // The working copy's origin is the local cache path (no credentials);
    // drop this feature's dirs to bound the warm container's disk.
    await sandbox.exec(`rm -rf ${WORK} ${OUT}`).catch(() => {});
  }
}

async function readResults(
  sandbox: Sandbox,
  out: string,
  count: number,
): Promise<CriterionResult[]> {
  let parsed: JsonValue;
  try {
    parsed = parseJson((await sandbox.readFile(`${out}/results.json`)).content);
  } catch {
    throw new Error('verifier agent did not produce a parseable results.json');
  }
  if (!isJsonArray(parsed)) throw new Error('results.json is not an array');
  const byIndex = new Map<number, CriterionResult>();
  for (const raw of parsed) {
    if (!isJsonObject(raw)) continue;
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    const verdict = raw.verdict === 'pass' || raw.verdict === 'fail' ? raw.verdict : 'skip';
    byIndex.set(index, {
      index,
      verdict,
      note: String(raw.note ?? '').slice(0, 500),
      screenshot: isString(raw.screenshot) ? raw.screenshot : undefined,
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

// Binary-safe read out of the sandbox via the SDK's file streaming.
async function readBinary(sandbox: Sandbox, path: string): Promise<Uint8Array | null> {
  try {
    const { content } = await collectFile(await sandbox.readFileStream(path));
    return content instanceof Uint8Array ? content : new TextEncoder().encode(content);
  } catch {
    return null;
  }
}

// Screenshots land in R2 under verify/<featureId>/, served via the signed
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
    const bytes = await readBinary(sandbox, `${shotsDir(featureId)}/${safe}`);
    if (!bytes || bytes.length === 0) continue;
    const key = `verify/${featureId}/${safe}`;
    await env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
    const sig = await signArtifactKey(key);
    urls.set(name, `${env.PUBLIC_BASE_URL}/artifacts/${key}?sig=${sig}`);
  }
  return urls;
}

interface DemoInfo {
  key: string;
  url: string;
  caption?: string;
}

// The demo recording: Chrome's screencast emits VP9 WebM, which iOS Safari
// cannot play (renders a black box) — transcode to H.264 MP4 in the sandbox
// so the demo plays everywhere. 40MB guard against runaway recordings.
async function uploadDemo(sandbox: Sandbox, featureId: number): Promise<DemoInfo | undefined> {
  const OUT_DIR = outDir(featureId);
  const stat = await sandbox.exec(`stat -c %s "${OUT_DIR}/demo.webm"`, { timeout: 15_000 });
  const size = Number(stat.stdout.trim());
  if (!stat.success || !Number.isFinite(size) || size === 0) return undefined;
  if (size > 40 * 1024 * 1024) {
    console.warn(`turbodiff: demo recording too large (${size} bytes), skipping upload`);
    return undefined;
  }
  const transcode = await sandbox.exec(
    `ffmpeg -y -v error -i "${OUT_DIR}/demo.webm" -c:v libx264 -pix_fmt yuv420p ` +
      `-movflags +faststart -crf 26 "${OUT_DIR}/demo.mp4"`,
    { timeout: 3 * 60_000 },
  );
  if (!transcode.success) {
    console.warn(`turbodiff: demo transcode failed: ${transcode.stderr.slice(0, 300)}`);
    return undefined;
  }
  const bytes = await readBinary(sandbox, `${OUT_DIR}/demo.mp4`);
  if (!bytes || bytes.length === 0) return undefined;
  const key = `verify/${featureId}/demo.mp4`;
  await env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' } });
  const sig = await signArtifactKey(key);
  const caption = await readText(sandbox, `${OUT_DIR}/demo-caption.txt`);
  return { key, url: `${env.PUBLIC_BASE_URL}/artifacts/${key}?sig=${sig}`, caption };
}

const VERDICT_BADGE = {
  pass: '✅',
  fail: '❌',
  skip: '⚪',
} satisfies Record<CriterionResult['verdict'], string>;

async function postReport(
  token: string,
  repo: RepositoryRow,
  feature: FeatureRow,
  criteria: string[],
  results: CriterionResult[],
  shots: Map<string, string>,
  summary?: string,
  demo?: DemoInfo,
): Promise<void> {
  const failed = results.filter((r) => r.verdict === 'fail').length;
  const cert = failed === 0 ? await certificateUrl(feature.id) : null;
  const body = reportBody(repo, feature, criteria, results, shots, summary, demo, failed, cert);
  try {
    await gh(token, `/repos/${repo.owner}/${repo.name}/issues/${feature.pr_number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  } catch (err) {
    console.error('turbodiff: verification report comment failed:', err);
  }
}

// Drafts the criteria rewrite the human is being asked to approve: keep
// still-valid criteria, restate the failing ones to describe the direction
// their comments took the code. Best-effort — the decision card falls back
// to the current criteria when this produces nothing usable.
async function proposeUpdatedCriteria(
  sandbox: Sandbox,
  auth: RunnerAuth,
  feature: FeatureRow,
  criteria: string[],
  results: CriterionResult[],
): Promise<void> {
  const comments = (await listCockpitComments(feature.id))
    .map((c) => `- ${c.path}:${c.line} — ${c.body}`)
    .join('\n');
  const evidence = results
    .map((r) => `${r.verdict.toUpperCase()} — ${criteria[r.index]}\n  Observed: ${r.note}`)
    .join('\n');
  const PROPOSAL_FILE = `/workspace/criteria-proposal-${feature.id}.json`;
  const prompt = `A reviewer's comments changed this feature's direction, and the approved
acceptance criteria no longer match the implemented behavior.

Reviewer comments:
${comments || '(none recorded)'}

Current criteria with the latest verification evidence:
${evidence}

Rewrite the acceptance criteria to describe the implemented direction the
comments asked for. Keep criteria that still hold verbatim; restate the ones
that conflict; each criterion must be empirically checkable against the
running app. Write ONLY a JSON array of criterion strings to ${PROPOSAL_FILE}.
`;
  await sandbox.writeFile(`/workspace/criteria-prompt-${feature.id}.md`, prompt);
  const run = await sandbox.exec(
    `claude -p --model haiku --dangerously-skip-permissions --output-format text < /workspace/criteria-prompt-${feature.id}.md`,
    { timeout: 90_000, env: runnerEnvironment(auth) },
  );
  if (!run.success) throw new Error(`proposal agent exited ${run.exitCode}`);
  const raw = await sandbox.readFile(PROPOSAL_FILE).then((f) => f.content);
  const parsed = parseJson(raw);
  const proposal = Array.isArray(parsed) ? parsed.filter(isString).filter(Boolean) : [];
  if (proposal.length === 0) throw new Error('proposal file held no criteria');
  await setProposedAcceptance(feature.id, proposal);
}

// The criteria-conflict notice: names the failed criteria and spells out the
// two resolutions. Clear communication IS the feature here — the factory is
// refusing to act without the human.
async function postCriteriaConflictNotice(
  token: string,
  repo: RepositoryRow,
  feature: FeatureRow,
  criteria: string[],
  results: CriterionResult[],
): Promise<void> {
  const failedLines = results
    .filter((r) => r.verdict === 'fail')
    .map((r) => `- ${criteria[r.index]}\n  _Evidence: ${r.note.slice(0, 300)}_`);
  const body = [
    '⚖️ **Your requested change conflicts with the approved acceptance criteria.**',
    '',
    'The latest code follows your review comment, but these planned criteria now fail:',
    '',
    ...failedLines,
    '',
    'The factory will NOT auto-revert your change. Decide in the cockpit:',
    `**[Resolve in Turbodiff](${cockpitFeatureUrl(feature.id)})** — either update the criteria to match the new direction (then re-verify), or restore the planned behavior.`,
  ].join('\n');
  if (repo.provider === 'artifacts') {
    if (feature.change_request_id) {
      await addCrComment({
        changeRequestId: feature.change_request_id,
        file: null,
        line: null,
        author: CR_BOT_AUTHOR,
        kind: 'comment',
        severity: null,
        body,
      }).catch((err) => console.error('turbodiff: conflict notice failed:', err));
    }
    return;
  }
  try {
    await gh(token, `/repos/${repo.owner}/${repo.name}/issues/${feature.pr_number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  } catch (err) {
    console.error('turbodiff: conflict notice comment failed:', err);
  }
}

// The evidence report markdown, shared by the GitHub PR comment and the
// native CR comment.
function reportBody(
  repo: RepositoryRow,
  feature: FeatureRow,
  criteria: string[],
  results: CriterionResult[],
  shots: Map<string, string>,
  summary: string | undefined,
  demo: DemoInfo | undefined,
  failed: number,
  cert: string | null,
): string {
  const cockpit = cockpitFeatureUrl(feature.id);
  const lines = [
    `## 🔍 Turbodiff verification — ${failed === 0 ? 'all criteria met' : `${failed} criteria not met`}`,
    '',
    ...(demo
      ? [
          `🎬 **[Watch the demo & review this change in Turbodiff](${cockpit})** — ${demo.caption ?? 'screen recording of the feature in action'} ([raw video](${demo.url}))`,
          '',
        ]
      : [`🔎 **[Review this change in Turbodiff](${cockpit})**`, '']),
    ...(cert
      ? [`📜 **[Proof of build](${cert})** — shareable certificate of this evidence`, '']
      : []),
    '| | Criterion | Evidence |',
    '|---|---|---|',
    ...results.map((r) => {
      const note = r.note.replaceAll('|', '\\|').replaceAll('\n', ' ');
      return `| ${VERDICT_BADGE[r.verdict]} | ${criteria[r.index].replaceAll('|', '\\|')} | ${note} |`;
    }),
  ];
  const embedded = results
    .map((r) =>
      r.screenshot && shots.get(r.screenshot) ? { r, url: shots.get(r.screenshot)! } : null,
    )
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
  return lines.join('\n');
}
