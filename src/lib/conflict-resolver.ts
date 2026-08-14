import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { gh } from '../tools/github.ts';
import { persistAgentLog } from './agent-runs.ts';
import { gitAuthorEnv } from './attribution.ts';
import {
  finishFixAttempt,
  getFeatureByRepoPr,
  getRepoById,
  hasRunningFixAttempt,
  listEnabledSkillsForRepo,
  tryRecordFixAttempt,
  type RepositoryRow,
} from './db.ts';
import { FIX_MAX_ATTEMPTS, fetchPrHead, postHandoffComment, resolveRunnerAuth } from './fixer.ts';
import { installationToken, sandboxGitToken } from './github-app.ts';
import { checkMergeability, postConflictResolvedComment } from './merge-conflicts.ts';
import { UNTRUSTED_CONTENT_RULES } from './prompt-security.ts';
import { skillMarkdown } from './skill-files.ts';

// Opt-in agent-driven merge-conflict resolution for factory PRs
// (docs/software-factory-design.md): clone the PR's head branch, merge the
// base branch into it, and either push the merge directly (no textual
// conflict) or hand the conflicted files to a coding agent to resolve.
// Mirrors fixer.ts's shape and reuses its sandbox/auth/attribution helpers —
// same trust model and risk surface as auto_fix, so it shares its
// fix_attempts cap and single-flight guard rather than getting its own.

export interface ConflictResolveQueueMessage {
  kind: 'resolve_conflict';
  repoId: number;
  prNumber: number;
}

interface ConflictResolveOutcome {
  status: 'fixed' | 'no_changes' | 'tests_failed';
  commit?: string;
}

const CLONE_DIR = '/workspace/repo';
const TASK_FILE = '/workspace/conflict-task.md';
const AGENT_TIMEOUT_MS = 15 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

function conflictTaskPrompt(pr: string, branch: string, baseRef: string, files: string[]): string {
  return `You are an automated merge-conflict resolution agent operating on a checked-out pull \
request branch that has just been merged with its base branch, leaving unresolved conflict markers.

Resolve the conflict markers (<<<<<<<, =======, >>>>>>>) in the files listed below, preserving the
intent of both sides wherever possible. Rules:
- Resolve conflicts only in the listed files — no drive-by refactors or cleanups.
- Match the repository's existing code style and conventions.
- Do NOT run git commit or git push; the harness handles git.
- Do not leave any conflict markers in the tree.

${UNTRUSTED_CONTENT_RULES}

## Pull request
${pr} — branch \`${branch}\`, merging \`${baseRef}\` in

## Conflicted files
${files.map((f) => `- ${f}`).join('\n')}
`;
}

// Queue consumer body: re-validate against current state (the toggle, and
// the conflict itself, may have resolved since enqueue), enforce the shared
// fix-attempt cap, resolve the conflict, and record the attempt. Never
// throws — a failed run is recorded and reported on the PR, not retried, so
// a broken run can't spend tokens again on redelivery.
export async function processResolveConflictMessage(
  msg: ConflictResolveQueueMessage,
): Promise<void> {
  const repo = await getRepoById(msg.repoId);
  if (!repo || !repo.enabled || repo.auto_resolve_conflicts !== 1) {
    console.log(
      `turbodiff: conflict resolution skipped for repo ${msg.repoId}#${msg.prNumber} (auto-resolve off)`,
    );
    return;
  }
  const label = `${repo.owner}/${repo.name}#${msg.prNumber}`;
  const token = await installationToken(repo.installation_id);

  const mergeability = await checkMergeability(token, repo.owner, repo.name, msg.prNumber, {
    retryOnUnknown: true,
  });
  if (!mergeability.hasConflict) {
    console.log(`turbodiff: conflict resolution skipped for ${label} (no longer conflicted)`);
    return;
  }

  const attemptId = await tryRecordFixAttempt(
    repo.id,
    msg.prNumber,
    'conflict_resolve',
    FIX_MAX_ATTEMPTS,
  );
  if (attemptId === null) {
    // A run already in flight for this PR is the single-flight guard doing
    // its job, not the cap — the "N attempts have run" handoff text would be
    // misleading here, so only post it when the cap is actually the reason.
    if (await hasRunningFixAttempt(repo.id, msg.prNumber)) {
      console.log(`turbodiff: conflict resolution already running for ${label}, skipping`);
      return;
    }
    console.warn(`turbodiff: conflict resolution cap reached for ${label}`);
    await postHandoffComment(
      repo.installation_id,
      repo.owner,
      repo.name,
      msg.prNumber,
      FIX_MAX_ATTEMPTS,
    );
    return;
  }

  try {
    const outcome = await runConflictResolve(repo, msg.prNumber, mergeability.baseRef, attemptId);
    await finishFixAttempt(attemptId, outcome.status, outcome.commit);
    console.log(
      `turbodiff: conflict resolution ${outcome.status} for ${label} (attempt ${attemptId})`,
    );
    // A conflict-resolution push invalidates prior verification evidence,
    // same as a fix push: re-verify so the report and the auto-merge gate
    // reflect the merged code.
    if (outcome.status === 'fixed') {
      const feature = await getFeatureByRepoPr(repo.id, msg.prNumber);
      if (feature?.acceptance) {
        await env.FACTORY_QUEUE.send({ kind: 'verify', featureId: feature.id });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishFixAttempt(attemptId, 'failed', undefined, message.slice(0, 500));
    console.error(`turbodiff: conflict resolution failed for ${label}:`, err);
    await postFailureComment(token, repo.owner, repo.name, msg.prNumber);
  }
}

async function runConflictResolve(
  repo: RepositoryRow,
  prNumber: number,
  baseRef: string,
  attemptId: number,
): Promise<ConflictResolveOutcome> {
  const token = await installationToken(repo.installation_id);
  const auth = resolveRunnerAuth();
  // Any surfaced output must never leak a token — same scrub discipline as
  // the fixer's sandbox output.
  const gitToken = await sandboxGitToken(repo.installation_id, repo.name, 'write');
  const scrub = (s: string) => s.replaceAll(token, '***').replaceAll(gitToken, '***');

  const { headRef, headRepo } = await fetchPrHead(token, repo.owner, repo.name, prNumber);

  const sandbox = getSandbox(
    env.Sandbox as unknown as DurableObjectNamespace<Sandbox>,
    `resolve-conflict--${repo.owner}--${repo.name}--${prNumber}`.toLowerCase(),
    { sleepAfter: '20m' },
  );

  const gitEnv = { GIT_TOKEN: gitToken, FIX_BRANCH: headRef, BASE_REF: baseRef };
  const pushMerge = async (): Promise<string> => {
    const push = await sandbox.exec(
      `git -C ${CLONE_DIR} push ` +
        `"https://x-access-token:$GIT_TOKEN@github.com/${headRepo}.git" HEAD:"$FIX_BRANCH"`,
      { env: gitEnv, timeout: 2 * 60_000 },
    );
    if (!push.success) {
      throw new Error(`git push failed: ${scrub(push.stderr).slice(0, 500)}`);
    }
    return (await sandbox.exec(`git -C ${CLONE_DIR} rev-parse HEAD`)).stdout.trim();
  };
  await sandbox.exec(`rm -rf ${CLONE_DIR}`);
  const clone = await sandbox.exec(
    `git clone --depth 50 --single-branch --branch "$FIX_BRANCH" ` +
      `"https://x-access-token:$GIT_TOKEN@github.com/${headRepo}.git" ${CLONE_DIR}`,
    { env: gitEnv, timeout: 5 * 60_000 },
  );
  if (!clone.success) {
    throw new Error(`git clone failed: ${scrub(clone.stderr).slice(0, 500)}`);
  }
  // The clone URL (token included) lands in .git/config — strip it before
  // anything else runs in the checkout. The resolution agent and the repo's
  // check command both execute untrusted repo content with network egress,
  // so the token must not be readable from disk during either; fetch and
  // push below supply it via env to explicit-URL commands instead (git
  // anonymizes those URLs in FETCH_HEAD and merge messages).
  await sandbox.exec(
    `git -C ${CLONE_DIR} remote set-url origin "https://github.com/${headRepo}.git" && ` +
      `git -C ${CLONE_DIR} config user.name "turbodiff[bot]" && ` +
      `git -C ${CLONE_DIR} config user.email "turbodiff[bot]@users.noreply.github.com"`,
  );

  try {
    // Explicit refspec into refs/remotes/origin so `merge origin/<base>`
    // resolves regardless of the single-branch clone's configured refspec.
    const fetchBase = await sandbox.exec(
      `git -C ${CLONE_DIR} fetch --depth 50 ` +
        `"https://x-access-token:$GIT_TOKEN@github.com/${headRepo}.git" ` +
        `"+refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF"`,
      { env: gitEnv, timeout: 3 * 60_000 },
    );
    if (!fetchBase.success) {
      throw new Error(`git fetch of base branch failed: ${scrub(fetchBase.stderr).slice(0, 500)}`);
    }

    // Ref name via env, not interpolation — ref names may legally contain
    // characters the shell would evaluate inside double quotes.
    const merge = await sandbox.exec(`git -C ${CLONE_DIR} merge "origin/$BASE_REF" --no-edit`, {
      env: { BASE_REF: baseRef },
      timeout: 60_000,
    });

    if (merge.success) {
      // GitHub's 'dirty' verdict didn't reproduce as a textual conflict here
      // (e.g. it had gone stale) — no agent needed, push the merge directly.
      const commit = await pushMerge();
      await postConflictResolvedComment(token, repo.owner, repo.name, prNumber, commit.slice(0, 8));
      return { status: 'fixed', commit };
    }

    const conflicted = (
      await sandbox.exec(`git -C ${CLONE_DIR} diff --name-only --diff-filter=U`)
    ).stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (conflicted.length === 0) {
      throw new Error(
        `git merge failed with no conflicted files: ${scrub(merge.stderr).slice(0, 500)}`,
      );
    }

    await sandbox.writeFile(
      TASK_FILE,
      conflictTaskPrompt(`${repo.owner}/${repo.name}#${prNumber}`, headRef, baseRef, conflicted),
    );

    const skills = await listEnabledSkillsForRepo(repo.id);
    for (const skill of skills) {
      const dir = `${CLONE_DIR}/.claude/skills/${skill.slug}`;
      await sandbox.exec(`mkdir -p ${dir}`);
      await sandbox.writeFile(`${dir}/SKILL.md`, skillMarkdown(skill));
    }

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
    const fullOutput = scrub(`${agent.stdout}\n${agent.stderr}`.trim());
    await persistAgentLog('resolve_conflict', fullOutput, agent.success, {
      fixAttemptId: attemptId,
    });
    if (!agent.success) {
      throw new Error(
        `conflict resolution agent exited ${agent.exitCode}: ${fullOutput.slice(-1_000)}`,
      );
    }

    const stillConflicted = (
      await sandbox.exec(`git -C ${CLONE_DIR} diff --name-only --diff-filter=U`)
    ).stdout.trim();
    if (stillConflicted) {
      throw new Error(`conflict markers remain unresolved in: ${stillConflicted}`);
    }

    // Commit BEFORE running checks so check-command working-tree mutations
    // (dep installs, config edits) never leak into the pushed commit.
    const committed = await sandbox.exec(
      `git -C ${CLONE_DIR} add -A && git -C ${CLONE_DIR} commit --no-edit`,
      { env: gitAuthorEnv(undefined), timeout: 60_000 },
    );
    if (!committed.success) {
      throw new Error(`git commit failed: ${scrub(committed.stderr).slice(0, 500)}`);
    }

    if (repo.check_command) {
      const tests = await sandbox.exec(repo.check_command, {
        cwd: CLONE_DIR,
        timeout: TEST_TIMEOUT_MS,
      });
      if (!tests.success) {
        return { status: 'tests_failed' };
      }
    }

    const commit = await pushMerge();
    await postConflictResolvedComment(token, repo.owner, repo.name, prNumber, commit.slice(0, 8));
    return { status: 'fixed', commit };
  } finally {
    // Belt and braces: the remote was already scrubbed right after clone,
    // but an idle sandbox (sleepAfter keeps it warm) must never hold a
    // usable credential, so re-assert it on every exit path.
    await sandbox.exec(
      `git -C ${CLONE_DIR} remote set-url origin "https://github.com/${headRepo}.git"`,
    );
  }
}

// This new path must not become a second silent-failure site: automatic
// resolution failing is reported on the PR just like the fix loop's own
// cap-handoff comment.
async function postFailureComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  try {
    await gh(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body:
          '⚠️ **Turbodiff automatic conflict resolution failed.** This pull request still has a ' +
          'merge conflict with its base branch — a manual rebase or merge is needed.',
      }),
    });
  } catch (err) {
    console.error('turbodiff: conflict-resolution failure comment failed:', err);
  }
}
