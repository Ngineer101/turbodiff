import { describe, expect, it, vi } from 'vite-plus/test';
import { createAiGatewayGrant } from '../integrations/security/ai-gateway-grant.ts';
import { proxyAiGatewayRequest, type AiGatewayProxyConfig } from './ai-gateway-proxy.ts';

const config: AiGatewayProxyConfig = {
  accountId: 'account-123',
  gatewayId: 'production',
  apiToken: 'permanent-worker-token',
};

async function request(model: string, grantModel = model): Promise<Request> {
  const grant = await createAiGatewayGrant(config.apiToken, grantModel, Date.now() + 60_000);
  return new Request('https://turbodiff.test/ai-proxy/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${grant}`, accept: 'text/event-stream' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], stream: true }),
  });
}

describe('AI Gateway sandbox proxy', () => {
  it('exchanges a model grant for Worker-only credentials and preserves streaming', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: done\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cf-ray': 'ray-123' },
      }),
    );
    const response = await proxyAiGatewayRequest(
      await request('openai/gpt-5.2-codex'),
      config,
      upstream,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('data: done\n\n');
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/chat/completions',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer permanent-worker-token');
    expect(headers.get('cf-aig-gateway-id')).toBe('production');
    expect(headers.get('cf-aig-max-attempts')).toBe('3');
  });

  it('rejects attempts to use the grant for another model before fetching', async () => {
    const upstream = vi.fn<typeof fetch>();
    const response = await proxyAiGatewayRequest(
      await request('openai/gpt-5.2-codex', 'google/gemini-3-flash'),
      config,
      upstream,
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('accepts the Anthropic SDK x-api-key transport without forwarding it', async () => {
    const model = 'anthropic/claude-fable-5.1';
    const grant = await createAiGatewayGrant(config.apiToken, model, Date.now() + 60_000);
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: 'message' }));
    const response = await proxyAiGatewayRequest(
      new Request('https://turbodiff.test/ai-proxy/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': grant, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 128, messages: [] }),
      }),
      config,
      upstream,
    );

    expect(response.status).toBe(200);
    const headers = new Headers(upstream.mock.calls[0]![1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer permanent-worker-token');
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
  });

  it('rejects missing grants and unsupported endpoints before fetching', async () => {
    const upstream = vi.fn<typeof fetch>();
    const missingGrant = new Request('https://turbodiff.test/ai-proxy/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'openai/gpt-5.2-codex' }),
    });
    expect((await proxyAiGatewayRequest(missingGrant, config, upstream)).status).toBe(401);

    const invalidEndpoint = new Request('https://turbodiff.test/ai-proxy/v1/files', {
      method: 'POST',
    });
    expect((await proxyAiGatewayRequest(invalidEndpoint, config, upstream)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
