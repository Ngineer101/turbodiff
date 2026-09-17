// WebMCP payload normalisation, kept free of browser bindings so it can be
// unit-tested and reused independently of the Browser Run session wrapper.

import { isJsonArray, isJsonObject, isString } from '../shared/json.ts';
import type { JsonValue } from '../shared/json.ts';
import type { WebMcpTool } from './types.ts';

/**
 * Normalise the WebMCP listTools payload, which may be an array of tools or an
 * object with a `tools` array, into the agent's WebMcpTool shape. Entries
 * without a string name are dropped; the argument schema is read from any of
 * the common keys Paper might use.
 */
export function normaliseTools(raw: JsonValue): WebMcpTool[] {
  const list = isJsonArray(raw)
    ? raw
    : isJsonObject(raw) && isJsonArray(raw.tools)
      ? raw.tools
      : [];
  const tools: WebMcpTool[] = [];
  for (const entry of list) {
    if (!isJsonObject(entry) || !isString(entry.name)) continue;
    const schema = entry.inputSchema ?? entry.input_schema ?? entry.parameters;
    const tool: WebMcpTool = { name: entry.name };
    if (isString(entry.description)) tool.description = entry.description;
    if (isJsonObject(schema)) tool.inputSchema = schema;
    tools.push(tool);
  }
  return tools;
}
