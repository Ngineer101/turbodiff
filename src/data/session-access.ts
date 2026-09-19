import { sql } from 'drizzle-orm';
import { queryOne } from './postgres.ts';

/** Fresh authorization in one round trip; never cache membership across requests. */
export async function getSessionAccess(userId: string, githubId: number | null) {
  const row = await queryOne<{
    organization_ids: string[];
    github_connected: boolean;
    has_unclaimed: boolean;
  }>(sql`
    WITH memberships AS (
      SELECT o.id, o."createdAt" FROM auth.organization o
      JOIN auth.member m ON m."organizationId" = o.id WHERE m."userId" = ${userId}
    )
    SELECT
      ARRAY(SELECT id FROM memberships ORDER BY "createdAt", id) AS organization_ids,
      EXISTS(SELECT 1 FROM app.integrations i JOIN memberships m ON m.id = i.organization_id
        WHERE i.kind = 'scm' AND i.provider = 'github' AND i.enabled) AS github_connected,
      EXISTS(SELECT 1 FROM app.integrations i
        WHERE i.provider = 'github' AND i.config->>'installerGithubId' = ${githubId === null ? null : String(githubId)}
        AND NOT EXISTS(SELECT 1 FROM auth.member m WHERE m."organizationId" = i.organization_id)) AS has_unclaimed
  `);
  if (!row) throw new Error('session access query returned no row');
  return row;
}
