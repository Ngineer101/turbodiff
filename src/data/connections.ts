import { sql } from 'drizzle-orm';
import { execute, queryOne, queryRows } from './database.ts';
import { bigintArray } from './sql.ts';

// --- External MCP tool connections per repository ---

// Installation-level integrations registry: connections are added once per
// installation on the integrations page; MCP-kind connections are attached to
// repositories via repo_connections, and every action on an attached repo
// (hosted PR reviews, sandbox automation runs) mounts them per its context
// toggle.
export interface ConnectionRow {
  id: number;
  installation_id: number;
  name: string;
  kind: string; // 'mcp' (agent-mountable) | 'api' (stored bearer integration)
  url: string;
  tool_allowlist: string[] | null; // null = all tools
  auth_ciphertext: string | null; // sealed bearer token, when auth_type = 'bearer'
  optional: boolean;
  created_at: string;
  auth_type: string; // 'none' | 'bearer' | 'api_key' | 'client_credentials' | 'oauth'
  auth_config_ciphertext: string | null; // sealed JSON blob, shape depends on auth_type
  oauth_token_expires_at: string | null;
  oauth_needs_reauth: boolean;
  oauth_has_refresh_token: boolean;
}

// MCP connections attached to one repository and enabled for the given
// mount context.
export async function listRepoConnections(
  repositoryId: number,
  context: 'reviews' | 'automations',
): Promise<ConnectionRow[]> {
  const enabledColumn = context === 'reviews' ? sql`l.reviews` : sql`l.automations`;
  return queryRows<ConnectionRow>(sql`
    SELECT c.* FROM app.connections c
    JOIN app.repo_connections l ON l.connection_id = c.id
    WHERE l.repository_id = ${repositoryId} AND ${enabledColumn} AND c.kind = 'mcp'
    ORDER BY c.name
  `);
}

export async function listConnections(installationIds: number[]): Promise<ConnectionRow[]> {
  if (installationIds.length === 0) return [];
  return queryRows<ConnectionRow>(sql`
    SELECT * FROM app.connections
    WHERE installation_id = ANY(${bigintArray(installationIds)})
    ORDER BY name
  `);
}

export async function getConnection(id: number): Promise<ConnectionRow | null> {
  return queryOne<ConnectionRow>(sql`SELECT * FROM app.connections WHERE id = ${id}`);
}

export async function createConnection(fields: {
  installationId: number;
  name: string;
  kind: string;
  url: string;
  toolAllowlist: string[] | null;
  authCiphertext: string | null;
  authType: string;
  authConfigCiphertext: string | null;
}): Promise<void> {
  await execute(sql`
    INSERT INTO app.connections
      (installation_id, name, kind, url, tool_allowlist, auth_ciphertext, optional,
       auth_type, auth_config_ciphertext)
    VALUES (
      ${fields.installationId}, ${fields.name}, ${fields.kind}, ${fields.url},
      ${fields.toolAllowlist ? JSON.stringify(fields.toolAllowlist) : null}::jsonb,
      ${fields.authCiphertext}, TRUE, ${fields.authType}, ${fields.authConfigCiphertext}
    )
  `);
}

// Persists rotated/registered OAuth or client-credentials material. Every
// field is optional and left unchanged when omitted (COALESCE), except the
// booleans, which must still bind 0 for `false` rather than be skipped.
export interface ConnectionAuthUpdate {
  authType?: string;
  authConfigCiphertext?: string;
  oauthTokenExpiresAt?: string;
  oauthNeedsReauth?: boolean;
  oauthHasRefreshToken?: boolean;
}

export async function updateConnectionAuth(
  id: number,
  fields: ConnectionAuthUpdate,
): Promise<void> {
  await execute(sql`
    UPDATE app.connections SET
      auth_type = COALESCE(${fields.authType ?? null}, auth_type),
      auth_config_ciphertext = COALESCE(${fields.authConfigCiphertext ?? null}, auth_config_ciphertext),
      oauth_token_expires_at = COALESCE(${fields.oauthTokenExpiresAt ?? null}, oauth_token_expires_at),
      oauth_needs_reauth = COALESCE(
        ${fields.oauthNeedsReauth ?? null},
        oauth_needs_reauth
      ),
      oauth_has_refresh_token = COALESCE(
        ${fields.oauthHasRefreshToken ?? null},
        oauth_has_refresh_token
      )
    WHERE id = ${id}
  `);
}

export async function deleteConnection(id: number): Promise<void> {
  await execute(sql`DELETE FROM app.connections WHERE id = ${id}`);
}

export interface RepoConnectionLink {
  repository_id: number;
  connection_id: number;
  reviews: boolean;
  automations: boolean;
}

export async function listRepoConnectionLinks(
  installationIds: number[],
): Promise<RepoConnectionLink[]> {
  if (installationIds.length === 0) return [];
  return queryRows<RepoConnectionLink>(sql`
    SELECT l.repository_id, l.connection_id, l.reviews, l.automations
    FROM app.repo_connections l
    JOIN app.connections c ON c.id = l.connection_id
    WHERE c.installation_id = ANY(${bigintArray(installationIds)})
  `);
}

// Attach/detach one connection on one repository. Attaching upserts so the
// context toggles can be changed on an existing link with the same call.
export async function setRepoConnectionLink(
  repositoryId: number,
  connectionId: number,
  link: { attached: boolean; reviews: boolean; automations: boolean },
): Promise<void> {
  if (link.attached) {
    const changes = await execute(sql`
      INSERT INTO app.repo_connections
        (repository_id, connection_id, installation_id, reviews, automations)
      SELECT r.id, c.id, r.installation_id, ${link.reviews}, ${link.automations}
      FROM app.repositories r
      JOIN app.connections c
        ON c.id = ${connectionId} AND c.installation_id = r.installation_id
      WHERE r.id = ${repositoryId}
      ON CONFLICT (repository_id, connection_id)
      DO UPDATE SET reviews = EXCLUDED.reviews, automations = EXCLUDED.automations
    `);
    if (changes === 0) {
      throw new Error('repository and connection must belong to one tenant');
    }
  } else {
    await execute(sql`
      DELETE FROM app.repo_connections
      WHERE repository_id = ${repositoryId} AND connection_id = ${connectionId}
    `);
  }
}

// Atomic compare-and-set used by the connection service to single-flight
// OAuth refreshes. Token policy and network calls stay outside persistence.
export async function tryClaimConnectionRefresh(
  id: number,
  expectedExpiresAt: string | null,
  claimUntil: string,
): Promise<boolean> {
  const changes = await execute(sql`
    UPDATE app.connections SET oauth_token_expires_at = ${claimUntil}
    WHERE id = ${id}
      AND (oauth_token_expires_at = ${expectedExpiresAt}
        OR (oauth_token_expires_at IS NULL AND ${expectedExpiresAt} IS NULL))
  `);
  return changes > 0;
}
