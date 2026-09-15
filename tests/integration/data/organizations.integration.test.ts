import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { ensurePersonalOrganization } from '../../../src/data/organizations.ts';
import { execute, queryRows } from '../../../src/data/postgres.ts';

describe('personal organizations with PostgreSQL', () => {
  it('creates one organization when session bootstrap runs concurrently', async () => {
    const suffix = crypto.randomUUID();
    const userId = `personal-org-test-${suffix}`;
    const now = new Date().toISOString();

    await execute(sql`
      INSERT INTO auth."user" (id, name, email, "createdAt", "updatedAt")
      VALUES (${userId}, 'Concurrent User', ${`${suffix}@example.test`}, ${now}, ${now})
    `);

    try {
      const organizations = await Promise.all(
        Array.from({ length: 8 }, () => ensurePersonalOrganization(userId, 'Concurrent User')),
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
});
