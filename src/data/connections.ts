import { env } from 'cloudflare:workers';

// --- External MCP tool connections per repository (migration 0032) ---

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
  tool_allowlist: string | null; // JSON string array; null = all tools
  auth_ciphertext: string | null; // sealed bearer token, when auth_type = 'bearer'
  optional: number;
  created_at: string;
  auth_type: string; // 'none' | 'bearer' | 'api_key' | 'client_credentials' | 'oauth'
  auth_config_ciphertext: string | null; // sealed JSON blob, shape depends on auth_type
  oauth_token_expires_at: string | null;
  oauth_needs_reauth: number;
  oauth_has_refresh_token: number;
}

// MCP connections attached to one repository and enabled for the given
// mount context.
export async function listRepoConnections(
  repositoryId: number,
  context: 'reviews' | 'automations',
): Promise<ConnectionRow[]> {
  const contextColumn = context === 'reviews' ? 'l.reviews' : 'l.automations';
  const res = await env.DB.prepare(
    `SELECT c.* FROM connections c
		 JOIN repo_connections l ON l.connection_id = c.id
		 WHERE l.repository_id = ?1 AND ${contextColumn} = 1 AND c.kind = 'mcp'
		 ORDER BY c.name`,
  )
    .bind(repositoryId)
    .all<ConnectionRow>();
  return res.results;
}

export async function listConnections(installationIds: number[]): Promise<ConnectionRow[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT * FROM connections WHERE installation_id IN (${placeholders}) ORDER BY name`,
  )
    .bind(...installationIds)
    .all<ConnectionRow>();
  return res.results;
}

export async function getConnection(id: number): Promise<ConnectionRow | null> {
  return env.DB.prepare('SELECT * FROM connections WHERE id = ?1').bind(id).first<ConnectionRow>();
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
  await env.DB.prepare(
    `INSERT INTO connections
		 (installation_id, name, kind, url, tool_allowlist, auth_ciphertext, optional, auth_type, auth_config_ciphertext)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)`,
  )
    .bind(
      fields.installationId,
      fields.name,
      fields.kind,
      fields.url,
      fields.toolAllowlist ? JSON.stringify(fields.toolAllowlist) : null,
      fields.authCiphertext,
      fields.authType,
      fields.authConfigCiphertext,
    )
    .run();
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
  await env.DB.prepare(
    `UPDATE connections SET
		 auth_type = COALESCE(?2, auth_type),
		 auth_config_ciphertext = COALESCE(?3, auth_config_ciphertext),
		 oauth_token_expires_at = COALESCE(?4, oauth_token_expires_at),
		 oauth_needs_reauth = COALESCE(?5, oauth_needs_reauth),
		 oauth_has_refresh_token = COALESCE(?6, oauth_has_refresh_token)
		 WHERE id = ?1`,
  )
    .bind(
      id,
      fields.authType ?? null,
      fields.authConfigCiphertext ?? null,
      fields.oauthTokenExpiresAt ?? null,
      fields.oauthNeedsReauth === undefined ? null : fields.oauthNeedsReauth ? 1 : 0,
      fields.oauthHasRefreshToken === undefined ? null : fields.oauthHasRefreshToken ? 1 : 0,
    )
    .run();
}

export async function deleteConnection(id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM repo_connections WHERE connection_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM connections WHERE id = ?1').bind(id).run();
}

export interface RepoConnectionLink {
  repository_id: number;
  connection_id: number;
  reviews: number;
  automations: number;
}

export async function listRepoConnectionLinks(
  installationIds: number[],
): Promise<RepoConnectionLink[]> {
  if (installationIds.length === 0) return [];
  const placeholders = installationIds.map((_, i) => `?${i + 1}`).join(', ');
  const res = await env.DB.prepare(
    `SELECT l.repository_id, l.connection_id, l.reviews, l.automations FROM repo_connections l
		 JOIN connections c ON c.id = l.connection_id
		 WHERE c.installation_id IN (${placeholders})`,
  )
    .bind(...installationIds)
    .all<RepoConnectionLink>();
  return res.results;
}

// Attach/detach one connection on one repository. Attaching upserts so the
// context toggles can be changed on an existing link with the same call.
export async function setRepoConnectionLink(
  repositoryId: number,
  connectionId: number,
  link: { attached: boolean; reviews: boolean; automations: boolean },
): Promise<void> {
  if (link.attached) {
    await env.DB.prepare(
      `INSERT INTO repo_connections (repository_id, connection_id, reviews, automations)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT (repository_id, connection_id)
			 DO UPDATE SET reviews = ?3, automations = ?4`,
    )
      .bind(repositoryId, connectionId, link.reviews ? 1 : 0, link.automations ? 1 : 0)
      .run();
  } else {
    await env.DB.prepare(
      'DELETE FROM repo_connections WHERE repository_id = ?1 AND connection_id = ?2',
    )
      .bind(repositoryId, connectionId)
      .run();
  }
}

// Atomic compare-and-set used by the connection service to single-flight
// OAuth refreshes. Token policy and network calls stay outside persistence.
export async function tryClaimConnectionRefresh(
  id: number,
  expectedExpiresAt: string | null,
  claimUntil: string,
): Promise<boolean> {
  const claim = await env.DB.prepare(
    `UPDATE connections SET oauth_token_expires_at = ?2
			 WHERE id = ?1 AND (oauth_token_expires_at = ?3 OR (oauth_token_expires_at IS NULL AND ?3 IS NULL))`,
  )
    .bind(id, claimUntil, expectedExpiresAt)
    .run();
  return claim.meta.changes > 0;
}
