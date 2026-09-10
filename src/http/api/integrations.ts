import type { Hono, Context } from 'hono';
import {
  createConnection,
  deleteConnection,
  getConnection,
  getRepoById,
  listRepoConnectionLinks,
  listConnections,
  listInstallationsWithRepos,
  setRepoConnectionLink,
  updateConnectionAuth,
  type ConnectionRow,
} from '../../data/db.ts';
import {
  ConnectionAuthError,
  completeOAuthConnect,
  connectionSnapshot,
  oauthStatus,
  startOAuthConnect,
} from '../../services/connections.ts';
import { encryptionConfigured, sealJson, sealToken } from '../../integrations/security/crypto.ts';

import { isBoolean, isString, type JsonObject } from '../../shared/json.ts';
import { type ApiConnectionTest, type ApiIntegrations } from '../../shared/api-types.ts';
import {
  CONNECTION_NAME_RE,
  requireCapability,
  validConnectionUrl,
  type ApiEnv,
} from '../api-support.ts';
import type { ResolvedApiRouteDependencies } from './types.ts';

export function registerIntegrationRoutes(
  app: Hono<ApiEnv>,
  dependencies: Pick<
    ResolvedApiRouteDependencies,
    'orgAdmin' | 'resolveConnectionAuth' | 'testMcpEndpoint'
  >,
) {
  const { orgAdmin, resolveConnectionAuth: resolveAuth, testMcpEndpoint: testMcp } = dependencies;
  // --- Integrations registry: installation-level MCP/API connections ---

  async function authorizedConnection(c: Context<ApiEnv>): Promise<ConnectionRow | null> {
    const id = Number(c.req.param('id'));
    const conn = Number.isInteger(id) ? await getConnection(id) : null;
    if (!conn || !c.get('user').installationIds.includes(conn.installation_id)) return null;
    return conn;
  }

  app.get('/integrations', async (c) => {
    const { installationIds } = c.get('user');
    const [groups, connections, links] = await Promise.all([
      listInstallationsWithRepos(installationIds),
      listConnections(installationIds),
      listRepoConnectionLinks(installationIds),
    ]);
    return c.json<ApiIntegrations>({
      encryption_configured: encryptionConfigured(),
      installations: groups.map(({ installation }) => ({
        id: installation.id,
        account_login: installation.account_login,
      })),
      // A connection may only attach to repos of its own installation — the
      // client filters on installation_id.
      repos: groups.flatMap(({ repos }) =>
        repos
          .filter((r) => r.enabled)
          .map((r) => ({
            id: r.id,
            installation_id: r.installation_id,
            owner: r.owner,
            name: r.name,
          })),
      ),
      connections: connections.map((conn) => {
        const snap = connectionSnapshot(conn);
        return {
          id: conn.id,
          installation_id: conn.installation_id,
          name: conn.name,
          kind: conn.kind,
          url: conn.url,
          tools: snap.tools ?? null,
          has_auth: conn.auth_type !== 'none',
          auth_type: conn.auth_type,
          oauth_status: oauthStatus(conn),
          repo_links: links
            .filter((l) => l.connection_id === conn.id)
            .map((l) => ({
              repository_id: l.repository_id,
              reviews: l.reviews,
              automations: l.automations,
            })),
        };
      }),
    });
  });

  const AUTH_TYPES = ['none', 'bearer', 'api_key', 'client_credentials', 'oauth'];

  app.post('/integrations', async (c) => {
    const { installationIds } = c.get('user');
    const body = await c.req.json<JsonObject>().catch(() => null);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const get = (k: string) => {
      const v = body[k];
      return isString(v) ? v.trim() : '';
    };
    const installationId = Number(body.installation_id ?? installationIds[0]);
    const name = get('name').toLowerCase();
    const kind = get('kind') === 'api' ? 'api' : 'mcp';
    const url = get('url');
    const token = get('token');
    const tools = get('tools')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    // Preserves the pre-auth_type behavior for clients that only ever sent
    // `token`: no explicit auth_type + a token means 'bearer'.
    const rawAuthType = get('auth_type');
    const authType = AUTH_TYPES.includes(rawAuthType) ? rawAuthType : token ? 'bearer' : 'none';
    const headerName = get('header_name');
    const headerValue = get('header_value');
    const clientId = get('client_id');
    const clientSecret = get('client_secret');
    const tokenEndpoint = get('token_endpoint');
    const scope = get('scope');

    let error: string | null = null;
    if (!installationIds.includes(installationId)) {
      error = 'unknown installation';
    } else if (!CONNECTION_NAME_RE.test(name)) {
      error = 'name must be 1-31 chars: lowercase letters, digits, dashes, underscores';
    } else if (!validConnectionUrl(url)) {
      error = 'endpoint must be an https:// URL';
    } else if (authType !== 'none' && !encryptionConfigured()) {
      error =
        'credential storage needs the TOKEN_ENCRYPTION_KEY secret (openssl rand -hex 32, then wrangler secret put TOKEN_ENCRYPTION_KEY)';
    } else if (authType === 'api_key' && (!headerName || !headerValue)) {
      error = 'api_key auth needs both a header name and a header value';
    } else if (
      authType === 'client_credentials' &&
      (!clientId || !clientSecret || !tokenEndpoint)
    ) {
      error = 'client_credentials auth needs a client id, client secret, and token endpoint';
    } else if (authType === 'client_credentials' && !validConnectionUrl(tokenEndpoint)) {
      error = 'token endpoint must be an https:// URL';
    } else if (authType === 'oauth' && kind !== 'mcp') {
      // The OAuth *connect* action is MCP-only in the UI, but a bearer-auth
      // 'api' integration behind OAuth is otherwise a legitimate config —
      // only reject when auth_type is actually 'oauth' on a non-mcp kind.
      error = 'OAuth auth is only available for MCP-kind integrations';
    } else if ((await listConnections([installationId])).some((conn) => conn.name === name)) {
      error = `an integration named "${name}" already exists`;
    }
    if (error) return c.json({ error }, 400);
    const deniedCapability = await requireCapability(c, installationId, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;

    let authCiphertext: string | null = null;
    let authConfigCiphertext: string | null = null;
    if (authType === 'bearer') {
      authCiphertext = await sealToken(token);
    } else if (authType === 'api_key') {
      authConfigCiphertext = await sealJson({ headerName, headerValue });
    } else if (authType === 'client_credentials') {
      authConfigCiphertext = await sealJson({
        clientId,
        clientSecret,
        tokenEndpoint,
        scope: scope || undefined,
      });
    }
    // 'oauth' starts with no config — unusable until "Connect via OAuth"
    // completes the authorization-code flow (/oauth/start + /oauth/callback).

    await createConnection({
      installationId,
      name,
      kind,
      url,
      toolAllowlist: tools.length > 0 ? tools : null,
      authCiphertext,
      authType,
      authConfigCiphertext,
    });
    return c.json({ ok: true });
  });

  app.delete('/integrations/:id', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    const deniedCapability = await requireCapability(c, conn.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    await deleteConnection(conn.id);
    return c.json({ ok: true });
  });

  // MCP: handshake (initialize + tools/list) without mounting anything.
  // API: a GET against the base URL with the resolved auth header, reporting
  // the status.
  app.post('/integrations/:id/test', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    let auth: { headerName: string; headerValue: string } | null;
    try {
      auth = await resolveAuth(conn);
    } catch (err) {
      if (err instanceof ConnectionAuthError) {
        return c.json<ApiConnectionTest>({
          ok: false,
          detail: err.message,
          tools: [],
          reauth_required: err.reason === 'reauth_required',
        });
      }
      console.error(`turbodiff: could not resolve credentials for connection ${conn.id}:`, err);
      return c.json<ApiConnectionTest>({
        ok: false,
        detail: 'We could not verify this connection because of an internal error. Try again.',
        tools: [],
        reauth_required: false,
      });
    }
    if (conn.kind === 'api') {
      try {
        const res = await fetch(conn.url, {
          headers: auth ? { [auth.headerName]: auth.headerValue } : undefined,
        });
        return c.json<ApiConnectionTest>({
          ok: res.ok,
          detail: `HTTP ${res.status} ${res.statusText}`,
          tools: [],
          reauth_required: false,
        });
      } catch (err) {
        console.error(`turbodiff: API connection test failed for connection ${conn.id}:`, err);
        return c.json<ApiConnectionTest>({
          ok: false,
          detail: 'We could not reach this integration. Check its URL and try again.',
          tools: [],
          reauth_required: false,
        });
      }
    }
    const result = await testMcp(conn.url, auth ?? undefined);
    if (conn.auth_type === 'oauth' && (result.status === 401 || result.status === 403)) {
      try {
        await updateConnectionAuth(conn.id, { oauthNeedsReauth: true });
      } catch (err) {
        // The reconnect flow can still repair the credential even if this
        // best-effort status update fails. Keep persistence details server-side.
        console.error(`turbodiff: could not mark connection ${conn.id} for OAuth re-auth:`, err);
      }
      return c.json<ApiConnectionTest>({
        ok: false,
        detail: 'The integration rejected its OAuth authorization. Reconnect it to continue.',
        tools: [],
        reauth_required: true,
      });
    }
    return c.json<ApiConnectionTest>({
      ok: result.ok,
      detail: result.detail,
      tools: result.tools ?? [],
      reauth_required: false,
    });
  });

  // Browser-navigated (not fetched by the SPA), so failures redirect back to
  // the integrations page with a query param instead of a JSON error — the
  // one exception is the two caller-error cases below, which 400 before any
  // redirect makes sense. The connect flow itself (discovery, registration,
  // PKCE, token exchange) lives in services/connections.ts.
  app.get('/integrations/:id/oauth/start', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    if (conn.kind !== 'mcp') {
      return c.json({ error: 'OAuth connect is only available for MCP-kind integrations' }, 400);
    }
    if (conn.auth_type !== 'oauth') return c.json({ error: 'not an OAuth integration' }, 400);

    const started = await startOAuthConnect(conn);
    return c.redirect(
      started.ok ? started.authorizeUrl : `/integrations?oauth=error&reason=${started.reason}`,
    );
  });

  app.get('/integrations/:id/oauth/callback', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);

    const oauthError = c.req.query('error');
    if (oauthError) {
      return c.redirect(`/integrations?oauth=error&reason=${encodeURIComponent(oauthError)}`);
    }
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.redirect('/integrations?oauth=error&reason=missing_code');

    const result = await completeOAuthConnect(conn, code, state);
    if (!result.ok) return c.redirect(`/integrations?oauth=error&reason=${result.reason}`);
    return c.redirect(`/integrations?oauth=connected&name=${encodeURIComponent(conn.name)}`);
  });

  // Attach/detach an MCP integration to a repository.
  app.put('/integrations/:id/repos/:repoId', async (c) => {
    const conn = await authorizedConnection(c);
    if (!conn) return c.json({ error: 'unknown integration' }, 404);
    const deniedCapability = await requireCapability(c, conn.installation_id, 'settings', orgAdmin);
    if (deniedCapability) return deniedCapability;
    if (conn.kind !== 'mcp') return c.json({ error: 'only MCP integrations attach to repos' }, 400);
    const repoId = Number(c.req.param('repoId'));
    const repo = Number.isInteger(repoId) ? await getRepoById(repoId) : null;
    if (!repo || repo.installation_id !== conn.installation_id) {
      return c.json({ error: 'unknown repository' }, 404);
    }
    const body = await c.req
      .json<{ attached?: boolean; reviews?: boolean; automations?: boolean }>()
      .catch(() => null);
    const attached = body?.attached;
    if (!isBoolean(attached)) {
      return c.json({ error: 'body must be {"attached": true|false, ...}' }, 400);
    }
    const reviews = body?.reviews;
    const automations = body?.automations;
    if (
      (reviews !== undefined && !isBoolean(reviews)) ||
      (automations !== undefined && !isBoolean(automations))
    ) {
      return c.json({ error: '"reviews" and "automations" must be booleans when present' }, 400);
    }
    await setRepoConnectionLink(repo.id, conn.id, {
      attached,
      reviews: reviews ?? true,
      automations: automations ?? true,
    });
    return c.json({ ok: true });
  });
}
