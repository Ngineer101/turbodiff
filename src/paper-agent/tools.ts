// Tool surface presented to the model.
//
// Three logical groups per the design spec:
//   paper.*   WebMCP tools discovered from Paper (structured design operations)
//   browser.* screenshot / navigate / inspect (visual + DOM fallback)
//   job.*     note / request_user_input / complete (job control)
//
// Anthropic tool names must match ^[A-Za-z0-9_-]{1,64}$, while Paper tool names
// may contain dots or other characters, so discovered tools are exposed under a
// sanitised `paper__<name>` alias and mapped back before execution.

import type { ToolDefinition } from './model.ts';
import type { WebMcpTool } from './types.ts';
import type { JsonObject } from '../shared/json.ts';

export const PAPER_PREFIX = 'paper__';

export const BROWSER_SCREENSHOT = 'browser_screenshot';
export const BROWSER_NAVIGATE = 'browser_navigate';
export const BROWSER_INSPECT = 'browser_inspect';
export const JOB_NOTE = 'job_note';
export const JOB_REQUEST_USER_INPUT = 'job_request_user_input';
export const JOB_COMPLETE = 'job_complete';

const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} satisfies JsonObject;

/** Fixed browser + job tools, always available regardless of Paper's surface. */
export const CONTROL_TOOLS: ToolDefinition[] = [
  {
    name: BROWSER_SCREENSHOT,
    description:
      'Capture a screenshot of the current Paper document and return it as an image for visual evaluation. Use this to observe the result of your Paper edits before deciding what to do next.',
    input_schema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: BROWSER_NAVIGATE,
    description: 'Navigate the browser to a URL. Use sparingly; prefer Paper tools for editing.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL to open.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: BROWSER_INSPECT,
    description:
      'DOM fallback: read visible text from the page (optionally scoped to a CSS selector) when WebMCP does not expose what you need.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Optional CSS selector.' } },
      additionalProperties: false,
    },
  },
  {
    name: JOB_NOTE,
    description:
      'Record a short note about your plan or an observation. Does not change the design.',
    input_schema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
      additionalProperties: false,
    },
  },
  {
    name: JOB_REQUEST_USER_INPUT,
    description:
      'Pause the job and hand off to a human (for example, to complete Paper authentication in Live View or resolve an ambiguous requirement). Provide a clear reason.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: JOB_COMPLETE,
    description:
      'Mark the objective complete. Only call this once the design satisfies the objective and you have captured a final screenshot. Provide a brief summary of what you built.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
];

export interface ToolCatalog {
  definitions: ToolDefinition[];
  // Maps a sanitised paper tool alias back to its original WebMCP name.
  paperAlias: Map<string, string>;
}

/** Build the full tool catalog: control tools plus discovered Paper tools. */
export function buildToolCatalog(paperTools: WebMcpTool[]): ToolCatalog {
  const definitions: ToolDefinition[] = [...CONTROL_TOOLS];
  const paperAlias = new Map<string, string>();
  const used = new Set<string>(definitions.map((d) => d.name));

  for (const tool of paperTools) {
    const alias = uniqueAlias(PAPER_PREFIX + sanitize(tool.name), used);
    used.add(alias);
    paperAlias.set(alias, tool.name);
    definitions.push({
      name: alias,
      description: tool.description ?? `Paper WebMCP tool "${tool.name}".`,
      input_schema: normaliseSchema(tool.inputSchema),
    });
  }

  return { definitions, paperAlias };
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  return cleaned.slice(0, 64 - PAPER_PREFIX.length) || 'tool';
}

function uniqueAlias(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 60)}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 58)}_${Math.floor(Math.random() * 1e4)}`;
}

/**
 * The Messages API requires each tool's input_schema to be a JSON Schema object
 * of type "object". Coerce anything else (or a missing schema) into a
 * permissive object schema so discovery never blocks execution.
 */
function normaliseSchema(schema: JsonObject | undefined) {
  if (schema && schema.type === 'object') return schema;
  return {
    type: 'object',
    properties: schema?.properties ?? {},
    additionalProperties: true,
  } satisfies JsonObject;
}
