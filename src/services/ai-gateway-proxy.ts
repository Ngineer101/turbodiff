import { requestUsesGrantedModel } from '../domain/ai-gateway-policy.ts';
import { verifyAiGatewayGrantWithSecret } from '../integrations/security/ai-gateway-grant.ts';
import { isJsonObject, isString, parseJson } from '../shared/json.ts';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const ALLOWED_ENDPOINTS = new Set(['chat/completions', 'responses', 'messages']);
const FORWARDED_SDK_HEADERS = ['anthropic-version', 'anthropic-beta', 'openai-beta'];

export interface AiGatewayProxyConfig {
  accountId: string;
  gatewayId: string;
  apiToken: string;
}

function error(message: string, status: number): Response {
  return Response.json({ error: { message, type: 'invalid_request_error' } }, { status });
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  // The Anthropic-native AI SDK transports its configured apiKey in
  // x-api-key; OpenAI and OpenAI-compatible adapters use Bearer auth.
  return request.headers.get('x-api-key') ?? '';
}

function endpointFor(request: Request): string {
  const prefix = '/ai-proxy/v1/';
  const path = new URL(request.url).pathname;
  return path.startsWith(prefix) ? path.slice(prefix.length) : '';
}

// Capability-authenticated relay for OpenCode's model traffic. The sandbox
// receives only a short-lived token bound to one model; the permanent
// Cloudflare account token and gateway coordinates stay inside the Worker.
export async function proxyAiGatewayRequest(
  request: Request,
  config: AiGatewayProxyConfig,
  fetchUpstream: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== 'POST') return error('method not allowed', 405);
  const endpoint = endpointFor(request);
  if (!ALLOWED_ENDPOINTS.has(endpoint)) return error('not found', 404);

  const apiToken = config.apiToken.trim();
  if (!apiToken) return error('AI Gateway is not configured', 503);
  const grant = await verifyAiGatewayGrantWithSecret(apiToken, bearerToken(request));
  if (!grant) return error('invalid or expired grant', 401);

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return error('request body too large', 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_REQUEST_BYTES) return error('request body too large', 413);
  let body = new TextDecoder().decode(bytes);
  if (!requestUsesGrantedModel(body, grant.model)) {
    return error('request model does not match the sandbox grant', 403);
  }

  if (endpoint === 'messages') {
    // Cloudflare's /ai/v1/messages currently requires a system string, but
    // Anthropic SDKs emit text blocks. Preserve all text in order; block-level
    // metadata such as cache_control cannot be represented in this format.
    // The model check above has already validated that the body is JSON.
    const parsed = parseJson(body);
    if (isJsonObject(parsed) && Array.isArray(parsed.system)) {
      const parts: string[] = [];
      for (const block of parsed.system) {
        if (!isJsonObject(block) || block.type !== 'text' || !isString(block.text)) {
          return error('system must contain only text blocks with string text', 400);
        }
        parts.push(block.text);
      }
      if (parts.length) parsed.system = parts.join('\n\n');
      else delete parsed.system;
      body = JSON.stringify(parsed);
    }
  }

  const accountId = config.accountId.trim();
  const gatewayId = config.gatewayId.trim();
  if (!accountId || !gatewayId || !apiToken) return error('AI Gateway is not configured', 503);

  const upstreamHeaders = new Headers({
    accept: request.headers.get('accept') ?? 'application/json',
    authorization: `Bearer ${apiToken}`,
    'cf-aig-gateway-id': gatewayId,
    'cf-aig-max-attempts': '3',
    'cf-aig-backoff': 'exponential',
    'cf-aig-retry-delay': '500',
    'cf-aig-metadata': JSON.stringify({ app: 'turbodiff', harness: 'opencode' }),
    'content-type': 'application/json',
  });
  for (const name of FORWARDED_SDK_HEADERS) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  const upstream = await fetchUpstream(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/${endpoint}`,
    {
      method: 'POST',
      headers: upstreamHeaders,
      body,
    },
  );
  const headers = new Headers();
  for (const name of [
    'content-type',
    'cf-ray',
    'request-id',
    'x-request-id',
    'retry-after',
    'retry-after-ms',
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Preserve SSE/chunked responses as a stream; buffering here would turn a
  // long coding run into an avoidable latency and memory penalty.
  return new Response(upstream.body, { status: upstream.status, headers });
}
