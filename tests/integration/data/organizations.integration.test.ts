import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { createGithubWebhookService } from '../../../src/application/webhooks/github.ts';
import { ensureBuiltinAgents, getAgentByDefinition, listAgents } from '../../../src/data/agents.ts';
import {
  deletePristinePersonalOrganization,
  ensurePersonalOrganization,
} from '../../../src/data/organizations.ts';
import { execute, queryOne, queryRows, withTransaction } from '../../../src/data/postgres.ts';

const rollback = Symbol('rollback organization integration test');

async function rollbackAfter(run: () => Promise<void>): Promise<void> {
  try {
    await withTransaction(async () => {
      await run();
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function createUser(githubId?: number): Promise<string> {
  const suffix = crypto.randomUUID();
  const userId = `personal-org-test-${suffix}`;
  const now = new Date().toISOString();
  await execute(sql`
    INSERT INTO auth."user" (id, name, email, "createdAt", "updatedAt", login, "githubId")
    VALUES (
      ${userId}, 'Personal User', ${`${suffix}@example.test`}, ${now}, ${now},
      ${githubId ? 'personal-user' : null}, ${githubId ?? null}
    )
  `);
  return userId;
}

describe('personal organizations with PostgreSQL', () => {
  it('preserves a pre-existing custom verifier slug and seeds the builtin under a safe slug', () =>
    rollbackAfter(async () => {
      const userId = await createUser();
      const organization = await ensurePersonalOrganization(userId, 'Verifier Collision');
      await execute(sql`DELETE FROM app.agents WHERE organization_id = ${organization.id}
        AND definition_key = 'verifier'`);
      await execute(sql`INSERT INTO app.agents (organization_id, definition_key, slug, name)
        VALUES (${organization.id}, 'reviewer', 'verifier', 'Custom Verifier')`);

      await Promise.all([
        ensureBuiltinAgents(organization.id),
        ensureBuiltinAgents(organization.id),
      ]);

      const agents = await listAgents([organization.id]);
      expect(agents.find((agent) => agent.slug === 'verifier')).toMatchObject({
        definition_key: 'reviewer',
        name: 'Custom Verifier',
      });
      expect(agents.filter((agent) => agent.definition_key === 'verifier')).toHaveLength(1);
      expect(await getAgentByDefinition(organization.id, 'verifier')).toMatchObject({
        slug: 'verifier-builtin',
        enabled: true,
      });
    }));

  it('creates one organization when session bootstrap runs concurrently', async () => {
    const userId = await createUser();

    try {
      const organizations = await Promise.all(
        Array.from({ length: 8 }, () => ensurePersonalOrganization(userId, 'Personal User')),
      );
      const memberships = await queryRows<{ organization_id: string }>(sql`
        SELECT "organizationId" AS organization_id
        FROM auth."member"
        WHERE "userId" = ${userId}
      `);

      expect(new Set(organizations.map((organization) => organization.id)).size).toBe(1);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.organization_id).toBe(organizations[0]?.id);
    } finally {
      await execute(sql`
        DELETE FROM auth."organization"
        WHERE id IN (
          SELECT "organizationId" FROM auth."member" WHERE "userId" = ${userId}
        )
      `);
      await execute(sql`DELETE FROM auth."user" WHERE id = ${userId}`);
    }
  });

  it('removes an untouched personal organization after a GitHub account organization exists', () =>
    rollbackAfter(async () => {
      const githubId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      const installationId = githubId + 2_000_000_000;
      const userId = await createUser(githubId);
      const personal = await ensurePersonalOrganization(userId, 'Personal User');
      await ensureBuiltinAgents(personal.id);
      const githubOrganizationId = `github-account-${githubId}`;

      const result = await createGithubWebhookService().handle('installation', {
        action: 'created',
        installation: {
          id: installationId,
          account: { id: githubId, login: 'personal-user', type: 'User' },
        },
        repositories: [],
        sender: { id: githubId, login: 'personal-user' },
      });

      expect(result).toEqual({ body: { ok: true, integration: expect.any(Number) } });
      await expect(
        queryOne(sql`SELECT id FROM auth."organization" WHERE id = ${personal.id}`),
      ).resolves.toBeNull();
      await expect(
        queryOne(sql`SELECT id FROM auth."organization" WHERE id = ${githubOrganizationId}`),
      ).resolves.not.toBeNull();
      await expect(
        queryOne(sql`
          SELECT id FROM app.integrations
          WHERE provider = 'github' AND external_account_id = ${String(installationId)}
        `),
      ).resolves.not.toBeNull();
    }));

  it('preserves a personal organization after the user customizes an agent', () =>
    rollbackAfter(async () => {
      const userId = await createUser();
      const personal = await ensurePersonalOrganization(userId, 'Personal User');
      await execute(sql`
        INSERT INTO app.agents (organization_id, definition_key, slug, name)
        VALUES (${personal.id}, 'reviewer', 'security-reviewer', 'Security Reviewer')
      `);

      await expect(
        deletePristinePersonalOrganization(userId, `github-account-${crypto.randomUUID()}`),
      ).resolves.toBeNull();
      await expect(
        queryOne(sql`SELECT id FROM auth."organization" WHERE id = ${personal.id}`),
      ).resolves.not.toBeNull();
    }));

  it('preserves the personal organization when the installation belongs to a GitHub organization', () =>
    rollbackAfter(async () => {
      const githubId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      const accountId = githubId + 2_000_000_000;
      const installationId = githubId + 4_000_000_000;
      const userId = await createUser(githubId);
      const personal = await ensurePersonalOrganization(userId, 'Personal User');

      const result = await createGithubWebhookService().handle('installation', {
        action: 'created',
        installation: {
          id: installationId,
          account: { id: accountId, login: 'expected-team', type: 'Organization' },
        },
        repositories: [],
        sender: { id: githubId, login: 'personal-user' },
      });

      expect(result).toEqual({ body: { ok: true, integration: expect.any(Number) } });
      await expect(
        queryOne(sql`SELECT id FROM auth."organization" WHERE id = ${personal.id}`),
      ).resolves.not.toBeNull();
      await expect(
        queryOne(sql`
          SELECT id FROM auth."organization" WHERE id = ${`github-account-${accountId}`}
        `),
      ).resolves.not.toBeNull();
    }));
});
