/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { testDatabase } from '../../test/database-fixture.ts';
// The user.update.before hook: what a GitHub profile sync may rewrite.
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { withAuth } from './better-auth.ts';

// overrideUserInfoOnSignIn reaches the user row through better-auth's
// internal adapter, which is where database hooks run — so drive that
// adapter with the same shape the GitHub sign-in produces rather than a
// full OAuth round-trip.
async function syncGithubProfile(
  userId: string,
  profile: { githubId: number; login: string; email: string },
): Promise<void> {
  await withAuth(async (instance) => {
    const context = await instance.$context;
    await context.internalAdapter.updateUser(userId, {
      name: profile.login,
      login: profile.login,
      githubId: profile.githubId,
      email: profile.email,
      emailVerified: true,
    });
  });
}

async function seedUser(id: string, email: string, githubId: number | null): Promise<void> {
  await testDatabase()
    .prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", login, "githubId")
       VALUES (?1, ?1, ?2, false, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
               ?1, ?3)`,
    )
    .bind(id, email, githubId)
    .run();
}

async function storedEmail(id: string): Promise<{ email: string; emailVerified: boolean } | null> {
  return testDatabase()
    .prepare('SELECT email, "emailVerified" FROM "user" WHERE id = ?1')
    .bind(id)
    .first<{ email: string; emailVerified: boolean }>();
}

describe('GitHub profile sync and the stored email', () => {
  beforeEach(async () => {
    for (const table of ['session', 'account', 'user']) {
      await testDatabase().prepare(`DELETE FROM "${table}"`).run();
    }
  });

  it('replaces the noreply placeholder with the address GitHub now reports', async () => {
    await seedUser('u1', '583231+octocat@users.noreply.github.com', 583231);
    await syncGithubProfile('u1', {
      githubId: 583231,
      login: 'octocat',
      email: 'Octocat@Example.test',
    });
    expect(await storedEmail('u1')).toEqual({ email: 'octocat@example.test', emailVerified: true });
  });

  it('keeps a real stored email when the sync carries a different one', async () => {
    // A password account that linked GitHub signs in with the address it
    // typed — the GitHub address must never replace it.
    await seedUser('u1', 'pat@example.test', 583231);
    await syncGithubProfile('u1', { githubId: 583231, login: 'pat', email: 'pat@github.test' });
    expect(await storedEmail('u1')).toEqual({ email: 'pat@example.test', emailVerified: false });
  });

  it('keeps the placeholder when another account already owns the synced address', async () => {
    await seedUser('u1', '583231+octocat@users.noreply.github.com', 583231);
    await seedUser('u2', 'octocat@example.test', null);
    await syncGithubProfile('u1', {
      githubId: 583231,
      login: 'octocat',
      email: 'octocat@example.test',
    });
    expect(await storedEmail('u1')).toEqual({
      email: '583231+octocat@users.noreply.github.com',
      emailVerified: false,
    });
  });

  it('keeps the placeholder when GitHub still reports none', async () => {
    await seedUser('u1', '583231+octocat@users.noreply.github.com', 583231);
    await syncGithubProfile('u1', {
      githubId: 583231,
      login: 'octocat',
      email: '583231+octocat@users.noreply.github.com',
    });
    expect(await storedEmail('u1')).toEqual({
      email: '583231+octocat@users.noreply.github.com',
      emailVerified: false,
    });
  });
});
