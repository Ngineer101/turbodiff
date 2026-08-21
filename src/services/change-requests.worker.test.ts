/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import {
  createArtifactsInstallation,
  createArtifactsRepository,
  createChangeRequest,
  getChangeRequest,
  getOpenChangeRequest,
  listCrChecks,
  markChangeRequestMerged,
  setChangeRequestReviewStatus,
  updateChangeRequestState,
  upsertCrCheck,
  type RepositoryRow,
} from '../data/db.ts';
import { maybeAutoMergeCr, splitPatchByFile } from './change-requests.ts';
import { computeRiskTierFromFiles } from './review-policy.ts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
// SAFETY: vitest.worker.config.ts defines the test-only TEST_MIGRATIONS
// miniflare binding, which the generated production Cloudflare.Env cannot
// know about.
const testEnv = env as TestEnv;

let repo: RepositoryRow;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const installation = await createArtifactsInstallation('cr-org');
  repo = await createArtifactsRepository({
    installationId: installation.id,
    owner: 'cr-org',
    name: 'shop',
    artifactsRepo: 'cr-org--shop',
    defaultBranch: 'main',
  });
});

describe('change request records', () => {
  it('allocates per-repo display numbers sequentially', async () => {
    const first = await createChangeRequest({
      repositoryId: repo.id,
      featureId: null,
      title: 'First change',
      sourceBranch: 'turbodiff/feat-1',
      targetBranch: 'main',
      openedBy: 'factory',
    });
    const second = await createChangeRequest({
      repositoryId: repo.id,
      featureId: null,
      title: 'Second change',
      sourceBranch: 'turbodiff/feat-2',
      targetBranch: 'main',
      openedBy: 'factory',
    });
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(first.status).toBe('open');
  });

  it('finds the open CR for a branch pair and enforces one-open-per-pair', async () => {
    const open = await getOpenChangeRequest(repo.id, 'turbodiff/feat-1', 'main');
    expect(open?.title).toBe('First change');
    await expect(
      createChangeRequest({
        repositoryId: repo.id,
        featureId: null,
        title: 'Duplicate',
        sourceBranch: 'turbodiff/feat-1',
        targetBranch: 'main',
        openedBy: 'factory',
      }),
    ).rejects.toThrow();
  });

  it('persists engine state and merge/review transitions', async () => {
    const cr = (await getOpenChangeRequest(repo.id, 'turbodiff/feat-1', 'main'))!;
    await updateChangeRequestState(cr.id, {
      sourceHead: 'a'.repeat(40),
      targetHead: 'b'.repeat(40),
      mergeBase: 'c'.repeat(40),
      mergeable: false,
      conflictFiles: ['src/pricing.ts'],
      filesJson: JSON.stringify([
        { path: 'src/pricing.ts', status: 'modified', additions: 5, deletions: 2 },
      ]),
      diffKey: `crs/${repo.id}/${cr.id}/aaaaaaaaaaaa.patch`,
      patchTruncated: false,
    });
    let reread = (await getChangeRequest(cr.id))!;
    expect(reread.mergeable).toBe(0);
    expect(JSON.parse(reread.conflict_files!)).toEqual(['src/pricing.ts']);

    await setChangeRequestReviewStatus(cr.id, 'changes_requested');
    await markChangeRequestMerged(cr.id, 'd'.repeat(40));
    reread = (await getChangeRequest(cr.id))!;
    expect(reread.status).toBe('merged');
    expect(reread.merged_head).toBe('d'.repeat(40));
    expect(reread.mergeable).toBe(1);
    expect(reread.review_status).toBe('changes_requested');
  });

  it('upserts one live check row per name', async () => {
    const cr = (await getOpenChangeRequest(repo.id, 'turbodiff/feat-2', 'main'))!;
    await upsertCrCheck(cr.id, 'review', 'running');
    await upsertCrCheck(cr.id, 'review', 'passed', '0 finding(s)');
    await upsertCrCheck(cr.id, 'check', 'passed');
    const checks = await listCrChecks(cr.id);
    expect(checks).toHaveLength(2);
    expect(checks.find((c) => c.name === 'review')?.status).toBe('passed');
  });
});

describe('maybeAutoMergeCr gates', () => {
  it('never merges when the repo has not opted in or the CR is not clean', async () => {
    const cr = (await getOpenChangeRequest(repo.id, 'turbodiff/feat-2', 'main'))!;
    // Repo has auto_merge = 0 (default): no-op even with green checks.
    await maybeAutoMergeCr(repo, cr.id);
    expect((await getChangeRequest(cr.id))!.status).toBe('open');

    // Opted in, but no review verdict yet: still a no-op. (The full-green
    // path reaches the sandbox engine and is exercised in deployment smoke
    // tests, not here.)
    const optedIn = { ...repo, auto_merge: 1 };
    await maybeAutoMergeCr(optedIn, cr.id);
    expect((await getChangeRequest(cr.id))!.status).toBe('open');
  });
});

describe('splitPatchByFile', () => {
  it('splits a multi-file unified diff and keeps paths', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+created',
      '',
    ].join('\n');
    const files = splitPatchByFile(patch);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files[0].patch.startsWith('diff --git a/src/a.ts')).toBe(true);
    expect(files[1].patch).toContain('+created');
  });

  it('uses the old path for deletions', () => {
    const patch = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    expect(splitPatchByFile(patch)[0].path).toBe('gone.ts');
  });
});

describe('computeRiskTierFromFiles (native CR path)', () => {
  it('classifies by reviewable size with the same thresholds as GitHub PRs', () => {
    expect(computeRiskTierFromFiles([{ filename: 'a.ts', additions: 3, deletions: 2 }])).toBe(
      'trivial',
    );
    expect(computeRiskTierFromFiles([{ filename: 'a.ts', additions: 60, deletions: 10 }])).toBe(
      'lite',
    );
    expect(computeRiskTierFromFiles([{ filename: 'a.ts', additions: 300, deletions: 0 }])).toBe(
      'full',
    );
  });

  it('escalates sensitive paths regardless of size', () => {
    expect(
      computeRiskTierFromFiles([{ filename: 'src/services/auth.ts', additions: 1, deletions: 0 }]),
    ).toBe('full');
  });

  it('ignores noise files when sizing', () => {
    expect(
      computeRiskTierFromFiles([
        { filename: 'pnpm-lock.yaml', additions: 5000, deletions: 4000 },
        { filename: 'src/a.ts', additions: 2, deletions: 1 },
      ]),
    ).toBe('trivial');
  });
});
