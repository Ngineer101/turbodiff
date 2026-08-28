/* oxlint-disable typescript/triple-slash-reference -- generated Worker bindings */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { database } from '../data/postgres.ts';
// Transport-level coverage for the inbound MCP server: JSON-RPC over
// stateless streamable HTTP, bearer auth stubbed at the route seam. Request
// shapes mirror the outbound probe in integrations/mcp/client.ts.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { auth } from '../integrations/auth/better-auth.ts';
import type { AuthedUser } from '../services/auth.ts';
import { isJsonArray, isJsonObject, isString, parseJson, type JsonObject } from '../shared/json.ts';
import { createMcpRoutes, type McpRouteDependencies } from './mcp.ts';

type EnqueueFactory = NonNullable<McpRouteDependencies['enqueueFactory']>;

const acmeUser: AuthedUser = {
  session: { authUserId: 'user-3001', userId: 3001, login: 'octocat' },
  installationIds: [1001],
  githubConnected: true,
  name: 'octocat',
};

function mcpApp(dependencies: McpRouteDependencies = {}) {
  const app = new Hono();
  app.route(
    '/mcp',
    createMcpRoutes({
      authenticate: async () => acmeUser,
      enqueueFactory: async () => {},
      ...dependencies,
    }),
  );
  return app;
}

async function rpc(app: Hono, body: JsonObject): Promise<Response> {
  return app.request('https://turbodiff.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

let nextRpcId = 100;

function callTool(app: Hono, name: string, args: JsonObject): Promise<Response> {
  return rpc(app, {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

async function rpcResult(response: Response): Promise<JsonObject> {
  expect(response.status).toBe(200);
  const body = parseJson(await response.text());
  if (!isJsonObject(body) || !isJsonObject(body.result)) {
    throw new Error(`not a JSON-RPC result: ${JSON.stringify(body)}`);
  }
  return body.result;
}

// The single text block every tool result carries, parsed back to JSON.
function toolPayload(result: JsonObject) {
  const content = result.content;
  const first = isJsonArray(content) ? content[0] : undefined;
  if (!isJsonObject(first) || !isString(first.text)) {
    throw new Error(`no text content in ${JSON.stringify(result)}`);
  }
  return { text: first.text, isError: result.isError === true };
}

async function seedTenants(): Promise<void> {
  await database().batch([
    database().prepare(
      `INSERT INTO installations (id, account_login, account_id, account_type)
		 VALUES (1001, 'acme', 2001, 'Organization'),
		        (2002, 'other', 2002, 'Organization')`,
    ),
    database().prepare(
      `INSERT INTO repositories (id, installation_id, owner, name)
		 VALUES (101, 1001, 'acme', 'api'),
		        (202, 2002, 'other', 'private')`,
    ),
    database().prepare(
      `INSERT INTO todos (id, installation_id, title, created_by_login, created_by_id)
		 VALUES (401, 1001, 'Acme backlog', 'octocat', 3001),
		        (402, 2002, 'Other backlog', 'someone-else', 4001)`,
    ),
    database().prepare(
      `INSERT INTO todo_repositories (todo_id, repository_id, position)
		 VALUES (401, 101, 0), (402, 202, 0)`,
    ),
    database().prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", login, "githubId")
		 VALUES ('u1', 'octocat', 'octocat@example.test', true, '2026-01-01T00:00:00.000Z',
		         '2026-01-01T00:00:00.000Z', 'octocat', 3001)`,
    ),
  ]);
}

beforeEach(async () => {
  const tables = [
    'chat_messages',
    'plan_repositories',
    'plans',
    'todo_repositories',
    'todos',
    'features',
    'repositories',
    'installations',
    'user',
  ];
  await database().batch(tables.map((table) => database().prepare(`DELETE FROM "${table}"`)));
  await seedTenants();
});

describe('MCP transport and auth', () => {
  it('answers 401 with the OAuth resource-metadata pointer when the bearer token fails', async () => {
    const app = mcpApp({ authenticate: async () => null });
    const response = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('resource_metadata=');
    expect(challenge).toContain('https://turbodiff.test/.well-known/oauth-protected-resource');
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('completes the initialize handshake statelessly', async () => {
    const app = mcpApp();
    const initRes = await rpc(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'turbodiff-test', version: '1.0.0' },
      },
    });
    expect(initRes.headers.get('content-type')).toContain('application/json');
    const result = await rpcResult(initRes);
    expect(isJsonObject(result.serverInfo) && result.serverInfo.name).toBe('turbodiff');
    expect(isString(result.protocolVersion)).toBe(true);

    const initialized = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(initialized.status).toBe(202);
  });

  it('rejects GET and DELETE with 405', async () => {
    const app = mcpApp();
    for (const method of ['GET', 'DELETE']) {
      const response = await app.request('https://turbodiff.test/mcp', { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });
});

describe('MCP tool surface', () => {
  it('lists exactly the 8 read + initiate tools', async () => {
    const result = await rpcResult(
      await rpc(mcpApp(), { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    const tools = result.tools;
    if (!isJsonArray(tools)) throw new Error('tools/list returned no tools array');
    const names = tools.map((t) => (isJsonObject(t) ? t.name : undefined)).filter(isString);
    expect(names.sort()).toEqual(
      [
        'list_board',
        'get_task',
        'get_feature',
        'repo_tree',
        'read_repo_file',
        'create_todo',
        'start_task',
        'send_chat_message',
      ].sort(),
    );
  });

  it('scopes list_board to the caller installations', async () => {
    const payload = toolPayload(await rpcResult(await callTool(mcpApp(), 'list_board', {})));
    expect(payload.isError).toBe(false);
    const board = parseJson(payload.text);
    if (!isJsonObject(board) || !isJsonArray(board.todos) || !isJsonArray(board.repos)) {
      throw new Error(`unexpected board shape: ${payload.text}`);
    }
    const todoIds = board.todos.map((t) => (isJsonObject(t) ? t.id : undefined));
    expect(todoIds).toContain(401);
    expect(todoIds).not.toContain(402);
    expect(board.repos.map((r) => (isJsonObject(r) ? r.id : undefined))).toEqual([101]);
  });

  it('creates a todo for a member installation and refuses a foreign one', async () => {
    const app = mcpApp();
    const created = toolPayload(
      await rpcResult(
        await callTool(app, 'create_todo', { installation_id: 1001, title: 'From MCP' }),
      ),
    );
    expect(created.isError).toBe(false);
    const body = parseJson(created.text);
    if (!isJsonObject(body)) throw new Error(`unexpected create_todo result: ${created.text}`);
    const row = await database()
      .prepare(`SELECT installation_id, created_by_login FROM todos WHERE id = ?1`)
      .bind(body.todo_id)
      .first<{ installation_id: number; created_by_login: string }>();
    expect(row).toEqual({ installation_id: 1001, created_by_login: 'octocat' });

    const foreign = toolPayload(
      await rpcResult(
        await callTool(app, 'create_todo', { installation_id: 2002, title: 'Cross-tenant' }),
      ),
    );
    expect(foreign.isError).toBe(true);
    const count = await database()
      .prepare(`SELECT COUNT(*) AS n FROM todos WHERE title = 'Cross-tenant'`)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('starts a todo: creates the plan, links it, and enqueues plan_analyze', async () => {
    const enqueueFactory = vi.fn<EnqueueFactory>(async () => {});
    const app = mcpApp({ enqueueFactory });
    const started = toolPayload(
      await rpcResult(
        await callTool(app, 'start_task', {
          todo_id: 401,
          requirements: 'Ship the MCP endpoint',
        }),
      ),
    );
    expect(started.isError).toBe(false);
    const body = parseJson(started.text);
    if (!isJsonObject(body)) throw new Error(`unexpected start_task result: ${started.text}`);
    const planId = body.task_id;
    expect(enqueueFactory).toHaveBeenCalledExactlyOnceWith({ kind: 'plan_analyze', planId });
    const todo = await database().prepare('SELECT plan_id FROM todos WHERE id = 401').first<{
      plan_id: number | null;
    }>();
    expect(todo?.plan_id).toBe(planId);
  });

  it('conceals a foreign todo from start_task', async () => {
    const enqueueFactory = vi.fn<EnqueueFactory>(async () => {});
    const denied = toolPayload(
      await rpcResult(
        await callTool(mcpApp({ enqueueFactory }), 'start_task', {
          todo_id: 402,
          requirements: 'Should not run',
        }),
      ),
    );
    expect(denied.isError).toBe(true);
    expect(denied.text).toBe('unknown todo');
    expect(enqueueFactory).not.toHaveBeenCalled();
  });
});

describe('OAuth discovery documents', () => {
  // The same handler wiring app.ts mounts at the root .well-known paths.
  function discoveryApp() {
    const app = new Hono();
    app.get('/.well-known/oauth-authorization-server', (c) =>
      oAuthDiscoveryMetadata(auth())(c.req.raw),
    );
    app.get('/.well-known/oauth-protected-resource', (c) =>
      oAuthProtectedResourceMetadata(auth())(c.req.raw),
    );
    return app;
  }

  it('serves authorization-server metadata with the endpoints MCP hosts need', async () => {
    const response = await discoveryApp().request(
      'https://turbodiff.test/.well-known/oauth-authorization-server',
    );
    expect(response.status).toBe(200);
    const metadata = parseJson(await response.text());
    if (!isJsonObject(metadata)) throw new Error('metadata is not an object');
    expect(isString(metadata.authorization_endpoint)).toBe(true);
    expect(isString(metadata.token_endpoint)).toBe(true);
    expect(isString(metadata.registration_endpoint)).toBe(true);
  });

  it('serves protected-resource metadata naming this authorization server', async () => {
    const response = await discoveryApp().request(
      'https://turbodiff.test/.well-known/oauth-protected-resource',
    );
    expect(response.status).toBe(200);
    const metadata = parseJson(await response.text());
    if (!isJsonObject(metadata) || !isJsonArray(metadata.authorization_servers)) {
      throw new Error('metadata has no authorization_servers array');
    }
    expect(metadata.authorization_servers.length).toBeGreaterThan(0);
    expect(metadata.resource).toBe('https://turbodiff.test/mcp');
  });
});
