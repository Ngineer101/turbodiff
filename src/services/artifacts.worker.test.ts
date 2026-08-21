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
  getArtifactsInstallationByLogin,
  getRepoByArtifactsName,
  getRepoByFullName,
} from '../data/db.ts';
import { applyArtifactsEvent } from './artifacts.ts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };
// SAFETY: vitest.worker.config.ts defines the test-only TEST_MIGRATIONS
// miniflare binding, which the generated production Cloudflare.Env cannot
// know about.
const testEnv = env as TestEnv;

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  // A GitHub tenant, to prove the two id spaces coexist.
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
			 VALUES (1001, 'acme', 2001, 'Organization')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO repositories (id, installation_id, owner, name)
			 VALUES (101, 1001, 'acme', 'api')`,
    ),
  ]);
});

describe('synthetic Artifacts tenancy', () => {
  it('allocates installations downward in the negative id space', async () => {
    const first = await createArtifactsInstallation('hosted-org');
    const second = await createArtifactsInstallation('other-org');
    expect(first.id).toBe(-1);
    expect(second.id).toBe(-2);
    expect(first.provider).toBe('artifacts');
    expect(first.account_type).toBe('Organization');
    // GitHub rows are untouched by the allocation scan.
    expect((await getArtifactsInstallationByLogin('hosted-org'))?.id).toBe(-1);
  });

  it('records artifacts repositories with negative ids alongside GitHub rows', async () => {
    const installation = await getArtifactsInstallationByLogin('hosted-org');
    const repo = await createArtifactsRepository({
      installationId: installation!.id,
      owner: 'hosted-org',
      name: 'shop',
      artifactsRepo: 'hosted-org--shop',
      defaultBranch: 'main',
    });
    expect(repo.id).toBeLessThan(0);
    expect(repo.provider).toBe('artifacts');
    expect(repo.artifacts_repo).toBe('hosted-org--shop');
    expect(repo.default_branch).toBe('main');
    // Lookup paths used by routes and event ingestion.
    expect((await getRepoByArtifactsName('hosted-org--shop'))?.id).toBe(repo.id);
    expect((await getRepoByFullName('hosted-org', 'shop'))?.provider).toBe('artifacts');
    // The GitHub repo is still a GitHub repo.
    expect((await getRepoByFullName('acme', 'api'))?.provider).toBe('github');
  });

  it('rejects duplicate artifacts repo names via the unique index', async () => {
    const installation = await getArtifactsInstallationByLogin('hosted-org');
    await expect(
      createArtifactsRepository({
        installationId: installation!.id,
        owner: 'hosted-org',
        name: 'shop-copy',
        artifactsRepo: 'hosted-org--shop',
        defaultBranch: 'main',
      }),
    ).rejects.toThrow();
  });
});

describe('applyArtifactsEvent', () => {
  it('records pushes on tracked repos and ignores untracked ones', async () => {
    const outcome = await applyArtifactsEvent({
      type: 'cf.artifacts.repo.pushed',
      namespace: 'turbodiff-repos',
      repoName: 'hosted-org--shop',
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      eventTimestamp: '2026-08-21T10:00:00.000Z',
    });
    expect(outcome).toContain('hosted-org/shop');
    expect((await getRepoByArtifactsName('hosted-org--shop'))?.last_push_at).toBe(
      '2026-08-21T10:00:00.000Z',
    );

    const ignored = await applyArtifactsEvent({
      type: 'cf.artifacts.repo.pushed',
      namespace: 'turbodiff-repos',
      repoName: 'not-ours',
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      eventTimestamp: null,
    });
    expect(ignored).toContain('ignored');
  });

  it('drops the repository row when the hosted repo is deleted', async () => {
    const installation = await getArtifactsInstallationByLogin('hosted-org');
    await createArtifactsRepository({
      installationId: installation!.id,
      owner: 'hosted-org',
      name: 'ephemeral',
      artifactsRepo: 'hosted-org--ephemeral',
      defaultBranch: 'main',
    });
    await applyArtifactsEvent({
      type: 'cf.artifacts.repo.deleted',
      namespace: 'turbodiff-repos',
      repoName: 'hosted-org--ephemeral',
      eventTimestamp: null,
    });
    expect(await getRepoByArtifactsName('hosted-org--ephemeral')).toBeNull();
  });

  it('never deletes a GitHub row, even on a name collision', async () => {
    // A malicious or buggy event naming a GitHub repo's slug must not touch it.
    await applyArtifactsEvent({
      type: 'cf.artifacts.repo.deleted',
      namespace: 'turbodiff-repos',
      repoName: 'acme--api',
      eventTimestamp: null,
    });
    expect(await getRepoByFullName('acme', 'api')).not.toBeNull();
  });
});
