// Multimodal model access for the Paper design agent, via Cloudflare AI
// Gateway's Anthropic-compatible endpoint.
//
// The same account token and gateway coordinates the rest of turbodiff uses
// for sandbox coding runs drive planning and screenshot critique here. Requests
// go to the account-bound `/ai/v1/messages` endpoint, which accepts the
// Anthropic Messages shape with a string `system` field.

import { MODEL_MAX_TOKENS } from './config.ts';
import type { PaperAgentEnv } from './config.ts';
import { isJsonArray, isJsonObject, isString, parseJson } from '../shared/json.ts';
import type { JsonObject, JsonValue } from '../shared/json.ts';

// --- Anthropic Messages content blocks (minimal subset the agent uses) ---

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/png'; data: string };
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: JsonObject;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonObject;
}

export interface ModelRequest {
  model: string;
  system: string;
  tools: ToolDefinition[];
  messages: Message[];
}

export interface ModelResponse {
  stopReason: string | null;
  content: ContentBlock[];
}

export async function callModel(
  env: PaperAgentEnv,
  request: ModelRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelResponse> {
  const accountId = env.AI_GATEWAY_ACCOUNT_ID.trim();
  const gatewayId = env.AI_GATEWAY_ID.trim();
  const apiToken = env.AI_GATEWAY_API_TOKEN.trim();
  if (!accountId || !gatewayId || !apiToken) {
    throw new Error('AI Gateway is not configured (AI_GATEWAY_ACCOUNT_ID/ID/API_TOKEN)');
  }

  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'cf-aig-gateway-id': gatewayId,
        'cf-aig-metadata': JSON.stringify({ app: 'turbodiff', harness: 'paper-agent' }),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: MODEL_MAX_TOKENS,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
      }),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`model request failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  return parseResponse(parseJson(await response.text()));
}

/** Parse the Messages API response into the blocks the loop understands. */
export function parseResponse(payload: JsonValue): ModelResponse {
  if (!isJsonObject(payload)) throw new Error('model response was not an object');

  const rawContent = isJsonArray(payload.content) ? payload.content : [];
  const content: ContentBlock[] = [];
  for (const block of rawContent) {
    if (!isJsonObject(block)) continue;
    if (block.type === 'text' && isString(block.text)) {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use' && isString(block.id) && isString(block.name)) {
      content.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: isJsonObject(block.input) ? block.input : {},
      });
    }
  }

  return {
    stopReason: isString(payload.stop_reason) ? payload.stop_reason : null,
    content,
  };
}

/** Convenience: the tool_use blocks the model emitted this turn. */
export function toolUsesOf(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}
