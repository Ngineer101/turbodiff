import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { AuthedUser } from '../../services/auth.ts';
import type { enqueueFactoryMessage } from '../../services/factory-queue.ts';
import {
  createTodo,
  getFeature,
  getTask,
  listBoard,
  McpToolError,
  readRepoFile,
  repoTree,
  sendChatMessage,
  startTask,
} from '../../services/mcp-tools.ts';
import {
  isJsonArray,
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
} from '../../shared/json.ts';

// Inbound MCP server for turbodiff.dev/mcp — the SDK's low-level Server run
// statelessly over streamable HTTP: one Server + transport pair per POST, no
// mcp-session-id, JSON responses only (no SSE streams). Authentication
// happens in http/mcp.ts before this module sees the request; the tool
// surface itself lives in services/mcp-tools.ts. The sibling client.ts is
// the outbound probe for user-configured agent connections — its request
// shapes double as this server's test vectors.

export interface McpServerDependencies {
  // Injectable for tests (the worker-test fixture has no queue binding).
  enqueue: typeof enqueueFactoryMessage;
}

// The full read + initiate surface — exactly these 8. No approve/merge/
// abandon/retry: destructive and money-moving decisions stay in the cockpit.
const TOOLS: Tool[] = [
  {
    name: 'list_board',
    description:
      'List the Turbodiff board: backlog todos, started tasks with per-repo feature status, and the connected repositories you can target.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task',
    description:
      'Get one task by id: status, requirements, clarifying questions and answers, acceptance criteria, and per-repo feature statuses.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'number', description: 'Task id from list_board' } },
      required: ['task_id'],
    },
  },
  {
    name: 'get_feature',
    description:
      'Get one generated feature by id: status, pull request number, verification summary, and the agent chat transcript.',
    inputSchema: {
      type: 'object',
      properties: { feature_id: { type: 'number', description: 'Feature id from a task repo' } },
      required: ['feature_id'],
    },
  },
  {
    name: 'repo_tree',
    description:
      'List one directory level of a connected GitHub repository (repo root of the default branch unless path/ref are given).',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: { type: 'number', description: 'Repository id from list_board' },
        path: { type: 'string', description: 'Directory path; empty for the repo root' },
        ref: { type: 'string', description: 'Branch, tag, or commit; default branch if omitted' },
      },
      required: ['repository_id'],
    },
  },
  {
    name: 'read_repo_file',
    description:
      'Read one file from a connected GitHub repository (from the default branch unless ref is given).',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: { type: 'number', description: 'Repository id from list_board' },
        path: { type: 'string', description: 'File path within the repository' },
        ref: { type: 'string', description: 'Branch, tag, or commit; default branch if omitted' },
      },
      required: ['repository_id', 'path'],
    },
  },
  {
    name: 'create_todo',
    description:
      'ACTION — create a real backlog todo card on the shared board (visible to the whole team; runs no agent yet).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short card title' },
        installation_id: {
          type: 'number',
          description: 'Installation to file it under; defaults to your first installation',
        },
        notes: { type: 'string', description: 'Optional longer notes' },
        repository_ids: {
          type: 'array',
          items: { type: 'number' },
          maxItems: 3,
          description: 'Up to 3 enabled repositories from the same installation',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'start_task',
    description:
      'ACTION — start a todo: submits requirements and kicks off the real (money-spending) planning pipeline; returns the new task id.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'number', description: 'Todo id from list_board' },
        requirements: { type: 'string', description: 'What to build, in detail' },
        title: { type: 'string', description: 'Task title; defaults to the todo title' },
      },
      required: ['todo_id', 'requirements'],
    },
  },
  {
    name: 'send_chat_message',
    description:
      "ACTION — send a chat message to the coding agent on a feature's open pull request; starts a real sandbox run that may push commits.",
    inputSchema: {
      type: 'object',
      properties: {
        feature_id: { type: 'number', description: 'Feature id with an open pull request' },
        message: { type: 'string', description: 'Instruction for the agent' },
      },
      required: ['feature_id', 'message'],
    },
  },
];

function requireNumber(args: JsonObject, key: string): number {
  const value = args[key];
  if (!isNumber(value)) throw new McpToolError(`${key} is required and must be a number`);
  return value;
}

function requireString(args: JsonObject, key: string): string {
  const value = args[key];
  if (!isString(value)) throw new McpToolError(`${key} is required and must be a string`);
  return value;
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return isString(value) ? value : undefined;
}

// The inferred return union covers every tool's result shape; all of them
// are plain serializable data for the JSON.stringify below.
async function dispatchTool(
  name: string,
  args: JsonObject,
  user: AuthedUser,
  deps: McpServerDependencies,
) {
  switch (name) {
    case 'list_board':
      return listBoard(user);
    case 'get_task':
      return getTask(user, requireNumber(args, 'task_id'));
    case 'get_feature':
      return getFeature(user, requireNumber(args, 'feature_id'));
    case 'repo_tree':
      return repoTree(
        user,
        requireNumber(args, 'repository_id'),
        optionalString(args, 'path'),
        optionalString(args, 'ref'),
      );
    case 'read_repo_file':
      return readRepoFile(
        user,
        requireNumber(args, 'repository_id'),
        requireString(args, 'path'),
        optionalString(args, 'ref'),
      );
    case 'create_todo': {
      const rawRepos = args['repository_ids'];
      const repositoryIds = isJsonArray(rawRepos) ? rawRepos.filter(isNumber) : [];
      if (isJsonArray(rawRepos) && repositoryIds.length !== rawRepos.length) {
        throw new McpToolError('repository_ids must be numbers');
      }
      const installationId = args['installation_id'];
      const input: Parameters<typeof createTodo>[1] = {
        title: requireString(args, 'title'),
        notes: optionalString(args, 'notes'),
        repository_ids: repositoryIds,
      };
      if (isNumber(installationId)) input.installation_id = installationId;
      return createTodo(user, input);
    }
    case 'start_task':
      return startTask(
        user,
        {
          todo_id: requireNumber(args, 'todo_id'),
          requirements: requireString(args, 'requirements'),
          title: optionalString(args, 'title'),
        },
        deps.enqueue,
      );
    case 'send_chat_message':
      return sendChatMessage(
        user,
        {
          feature_id: requireNumber(args, 'feature_id'),
          message: requireString(args, 'message'),
        },
        deps.enqueue,
      );
    default:
      throw new McpToolError(`unknown tool: ${name}`);
  }
}

export function createTurbodiffMcpServer(user: AuthedUser, deps: McpServerDependencies): Server {
  const server = new Server(
    { name: 'turbodiff', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      // The SDK's default validator is Ajv, whose compiled validators need
      // new Function — banned in the Workers runtime.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = request.params.arguments ?? {};
    try {
      if (!isJsonObject(args)) throw new McpToolError('arguments must be an object');
      const result = await dispatchTool(request.params.name, args, user, deps);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      if (err instanceof McpToolError) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
      // Never leak internals (GitHub error bodies, SQL) to the MCP host.
      console.error(`turbodiff: mcp tool ${request.params.name} failed:`, err);
      return { content: [{ type: 'text', text: 'tool failed' }], isError: true };
    }
  });

  return server;
}

export async function handleMcpPost(
  request: Request,
  user: AuthedUser,
  deps: McpServerDependencies,
): Promise<Response> {
  // Stateless: a fresh Server + transport per request, no session id, JSON
  // responses (never SSE). Requests carry no cross-request state beyond the
  // bearer-derived user, so initialize / tools/list / tools/call all work on
  // a cold pair.
  const server = createTurbodiffMcpServer(user, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  // The transport 406s a POST whose Accept lists only application/json, but
  // in JSON-response mode the SSE half is never used — normalize the header
  // so simple JSON-RPC clients aren't turned away on a formality.
  const headers = new Headers(request.headers);
  headers.set('accept', 'application/json, text/event-stream');
  return transport.handleRequest(new Request(request, { headers }));
}
