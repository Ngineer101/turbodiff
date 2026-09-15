import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { AuthedUser } from '../../application/auth/session.ts';
import type { enqueueFactoryMessage } from '../../application/factory/queue.ts';
import {
  createWorkItem,
  getWorkItem,
  listRepositories,
  listWorkItems,
  McpToolError,
  readRepositoryFile,
  repositoryTree,
  startFactoryRun,
} from '../../application/mcp/tools.ts';
import {
  isJsonArray,
  isJsonObject,
  isNumber,
  isString,
  type JsonObject,
} from '../../shared/json.ts';

export interface McpServerDependencies {
  enqueue: typeof enqueueFactoryMessage;
}

const TOOLS: Tool[] = [
  {
    name: 'list_work_items',
    description: 'List work items in organizations available to the authenticated user.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_work_item',
    description: 'Get a work item, its repository targets, and its factory runs.',
    inputSchema: {
      type: 'object',
      properties: { work_item_id: { type: 'number' } },
      required: ['work_item_id'],
    },
  },
  {
    name: 'list_repositories',
    description: 'List repositories in organizations available to the authenticated user.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'repository_tree',
    description: 'List one directory level in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: { type: 'number' },
        path: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['repository_id'],
    },
  },
  {
    name: 'read_repository_file',
    description: 'Read a file from a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repository_id: { type: 'number' },
        path: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['repository_id', 'path'],
    },
  },
  {
    name: 'create_work_item',
    description: 'Create a work item targeting one to three repositories in one organization.',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: { type: 'string' },
        repository_ids: { type: 'array', items: { type: 'number' } },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['organization_id', 'repository_ids', 'title', 'description'],
    },
  },
  {
    name: 'start_factory_run',
    description: 'Start a planning or delivery factory run for a work item.',
    inputSchema: {
      type: 'object',
      properties: {
        work_item_id: { type: 'number' },
        flow: { type: 'string', enum: ['planning', 'delivery'] },
      },
      required: ['work_item_id', 'flow'],
    },
  },
];

function requireNumber(args: JsonObject, key: string): number {
  const value = args[key];
  if (!isNumber(value)) throw new McpToolError(`${key} must be a number`);
  return value;
}

function requireString(args: JsonObject, key: string): string {
  const value = args[key];
  if (!isString(value)) throw new McpToolError(`${key} must be a string`);
  return value;
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return isString(value) ? value : undefined;
}

async function dispatchTool(
  name: string,
  args: JsonObject,
  user: AuthedUser,
  dependencies: McpServerDependencies,
) {
  switch (name) {
    case 'list_work_items':
      return listWorkItems(user);
    case 'get_work_item':
      return getWorkItem(user, requireNumber(args, 'work_item_id'));
    case 'list_repositories':
      return listRepositories(user);
    case 'repository_tree':
      return repositoryTree(
        user,
        requireNumber(args, 'repository_id'),
        optionalString(args, 'path'),
        optionalString(args, 'ref'),
      );
    case 'read_repository_file':
      return readRepositoryFile(
        user,
        requireNumber(args, 'repository_id'),
        requireString(args, 'path'),
        optionalString(args, 'ref'),
      );
    case 'create_work_item': {
      const rawIds = args.repository_ids;
      if (!isJsonArray(rawIds) || !rawIds.every(isNumber)) {
        throw new McpToolError('repository_ids must be an array of numbers');
      }
      return createWorkItem(user, {
        organization_id: requireString(args, 'organization_id'),
        repository_ids: rawIds,
        title: requireString(args, 'title'),
        description: requireString(args, 'description'),
      });
    }
    case 'start_factory_run': {
      const flow = requireString(args, 'flow');
      if (flow !== 'planning' && flow !== 'delivery') {
        throw new McpToolError('flow must be planning or delivery');
      }
      return startFactoryRun(
        user,
        { work_item_id: requireNumber(args, 'work_item_id'), flow },
        dependencies.enqueue,
      );
    }
    default:
      throw new McpToolError(`unknown tool: ${name}`);
  }
}

export function createTurbodiffMcpServer(
  user: AuthedUser,
  dependencies: McpServerDependencies,
): Server {
  const server = new Server(
    { name: 'turbodiff', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      const args = request.params.arguments ?? {};
      if (!isJsonObject(args)) throw new McpToolError('arguments must be an object');
      const result = await dispatchTool(request.params.name, args, user, dependencies);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof McpToolError) {
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
      console.error(`turbodiff: MCP tool ${request.params.name} failed`, error);
      return { content: [{ type: 'text', text: 'tool failed' }], isError: true };
    }
  });
  return server;
}

export async function handleMcpPost(
  request: Request,
  user: AuthedUser,
  dependencies: McpServerDependencies,
): Promise<Response> {
  const server = createTurbodiffMcpServer(user, dependencies);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const headers = new Headers(request.headers);
  headers.set('accept', 'application/json, text/event-stream');
  return transport.handleRequest(new Request(request, { headers }));
}
