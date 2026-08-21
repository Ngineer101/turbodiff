import { isJsonObject, isNumber, isString, parseJson, type JsonValue } from '../../shared/json.ts';
import {
  addCrComment,
  getChangeRequest,
  getRepoById,
  setChangeRequestReviewStatus,
  upsertCrCheck,
  type ChangeRequestRow,
  type RepositoryRow,
} from '../../data/db.ts';
import { CR_BOT_AUTHOR, getCrDiffPatch, maybeAutoMergeCr } from '../../services/change-requests.ts';
import { UNTRUSTED_CONTENT_RULES } from '../../domain/prompt-security.ts';
import { resolveRunnerAuth, runnerEnvironment } from '../runtime/runner-auth.ts';
import { runnerSandbox } from '../runtime/sandbox.ts';

// Native change-request review (docs/artifacts-provider.md): the review leg
// of the factory loop for Artifacts repos, with no forge underneath. The
// reviewer agent reads the CR's cached diff inside the same warm per-repo
// container the engine uses; findings land in cr_comments, the verdict on
// the CR row, and a 'review' check records the outcome. Verdict semantics
// mirror the GitHub reviewer: P1 findings block when the repo has
// blocking_reviews enabled.

const REVIEW_TIMEOUT_MS = 10 * 60_000;
const DIFF_FILE = '/workspace/cr-review-diff.patch';
const TASK_FILE = '/workspace/cr-review-task.md';
const OUT_FILE = '/workspace/cr-review-out.json';

interface ReviewFinding {
  file: string;
  line: number | null;
  severity: 'P1' | 'P2' | 'P3';
  body: string;
}

interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
}

function reviewPrompt(cr: ChangeRequestRow, repo: RepositoryRow): string {
  return `You are an automated code reviewer for ${repo.owner}/${repo.name}.

Review change request #${cr.number}: "${cr.title}" (branch ${cr.source_branch} into ${cr.target_branch}).

The unified diff is in ${DIFF_FILE}. The repository checkout in your working
directory is at the change's head commit — read surrounding code for context
before judging a hunk.

Report only findings that matter:
- P1: bugs, data loss, security holes — must be fixed before merge.
- P2: correctness risks or significant quality problems worth fixing.
- P3: minor improvements; use sparingly.
No style nits, no praise padding, no restating the diff.

When done, write ${OUT_FILE} as JSON exactly shaped:
{"summary": "<2-4 sentence review summary>",
 "findings": [{"file": "path/from/repo/root", "line": <new-side line number or null>, "severity": "P1"|"P2"|"P3", "body": "<the finding>"}]}
An empty findings array is a valid, good outcome.

${UNTRUSTED_CONTENT_RULES}
`;
}

function parseReviewResult(raw: string): ReviewResult | null {
  let value: JsonValue;
  try {
    value = parseJson(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(value) || !isString(value.summary) || !Array.isArray(value.findings)) {
    return null;
  }
  const findings: ReviewFinding[] = [];
  for (const entry of value.findings) {
    if (!isJsonObject(entry) || !isString(entry.file) || !isString(entry.body)) continue;
    const severity =
      entry.severity === 'P1' || entry.severity === 'P2' || entry.severity === 'P3'
        ? entry.severity
        : 'P3';
    const rawLine = entry.line;
    const line = isNumber(rawLine) && Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null;
    findings.push({ file: entry.file, line, severity, body: entry.body });
  }
  return { summary: value.summary, findings };
}

export async function runCrReview(changeRequestId: number): Promise<void> {
  const cr = await getChangeRequest(changeRequestId);
  if (!cr || cr.status !== 'open') return;
  const repo = await getRepoById(cr.repository_id);
  if (!repo) return;

  await upsertCrCheck(cr.id, 'review', 'running');
  try {
    const patch = await getCrDiffPatch(cr);
    if (!patch.trim()) {
      await setChangeRequestReviewStatus(cr.id, 'approved');
      await upsertCrCheck(cr.id, 'review', 'passed', 'empty diff — nothing to review');
      return;
    }

    const auth = resolveRunnerAuth(undefined, repo.model ?? undefined);
    const sandbox = runnerSandbox(`gen--${repo.owner}--${repo.name}`.toLowerCase(), {
      sleepAfter: '45m',
    });
    // The engine keeps /workspace/cr-workspace synced; point the reviewer's
    // checkout at the CR head so file reads match the diff.
    await sandbox.exec(
      `git -C /workspace/cr-workspace checkout -q --detach refs/remotes/origin/${cr.source_branch} 2>/dev/null || true`,
    );
    await sandbox.writeFile(DIFF_FILE, patch);
    await sandbox.writeFile(TASK_FILE, reviewPrompt(cr, repo));
    await sandbox.exec(`rm -f ${OUT_FILE}`);
    const agent = await sandbox.exec(
      `claude -p --dangerously-skip-permissions --output-format json < ${TASK_FILE}`,
      {
        cwd: '/workspace/cr-workspace',
        timeout: REVIEW_TIMEOUT_MS,
        env: runnerEnvironment(auth),
      },
    );
    if (!agent.success) {
      throw new Error(`review agent failed: ${(agent.stderr || agent.stdout).slice(0, 400)}`);
    }
    const out = await sandbox
      .readFile(OUT_FILE)
      .then((f) => f.content)
      .catch(() => '');
    const result = parseReviewResult(out);
    if (!result) throw new Error('review agent produced no parseable output file');

    for (const finding of result.findings) {
      await addCrComment({
        changeRequestId: cr.id,
        file: finding.file,
        line: finding.line,
        author: CR_BOT_AUTHOR,
        kind: 'finding',
        severity: finding.severity,
        body: finding.body,
      });
    }
    await addCrComment({
      changeRequestId: cr.id,
      file: null,
      line: null,
      author: CR_BOT_AUTHOR,
      kind: 'summary',
      severity: null,
      body: result.summary,
    });

    // P1s block only when the repo opted into blocking reviews — same
    // policy as the GitHub reviewer's verdict.
    const blocking =
      repo.blocking_reviews === 1 && result.findings.some((f) => f.severity === 'P1');
    await setChangeRequestReviewStatus(cr.id, blocking ? 'changes_requested' : 'approved');
    await upsertCrCheck(
      cr.id,
      'review',
      blocking ? 'failed' : 'passed',
      `${result.findings.length} finding(s)` +
        (blocking ? ' — P1 blocks merge (blocking reviews on)' : ''),
    );
    await maybeAutoMergeCr(repo, cr.id);
  } catch (err) {
    console.error(`turbodiff: native review of CR ${changeRequestId} failed:`, err);
    await upsertCrCheck(
      cr.id,
      'review',
      'error',
      err instanceof Error ? err.message.slice(0, 300) : 'review failed',
    );
  }
}
