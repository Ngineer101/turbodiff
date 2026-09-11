import { describe, expect, it, vi } from 'vite-plus/test';
import { createAiGatewayGrant } from '../security/ai-gateway-grant.ts';
import { proxyAiGatewayRequest, type AiGatewayProxyConfig } from './proxy.ts';

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

async function messagesRequest(body: string): Promise<Request> {
  const grant = await createAiGatewayGrant(
    config.apiToken,
    'anthropic/claude-opus-4.8',
    Date.now() + 60_000,
  );
  return new Request('https://turbodiff.test/ai-proxy/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': grant, 'anthropic-version': '2023-06-01' },
    body,
  });
}

describe('AI Gateway sandbox proxy', () => {
  it.each(['60', 'Wed, 09 Sep 2026 18:11:19 GMT'])(
    'preserves upstream retry timing (%s) and the error stream',
    async (retryAfter) => {
      const errorBody = '{"error":{"message":"Wholesale rate limit exceeded"}}';
      const upstreamResponse = new Response(errorBody, {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': retryAfter,
          'retry-after-ms': '60000',
          'set-cookie': 'upstream-only=value',
        },
      });
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(upstreamResponse);
      const response = await proxyAiGatewayRequest(
        await request('openai/gpt-5.2-codex'),
        config,
        upstream,
      );

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe(retryAfter);
      expect(response.headers.get('retry-after-ms')).toBe('60000');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.body).toBe(upstreamResponse.body);
      expect(await response.text()).toBe(errorBody);
      expect(upstream).toHaveBeenCalledOnce();
    },
  );

  it('adapts Claude system text blocks without changing messages, tools, or generation options', async () => {
    const payload = {
      model: 'anthropic/claude-opus-4.8',
      system: [
        { type: 'text', text: 'Review carefully.\nKeep this whitespace. ' },
        { type: 'text', text: 'Respect café conventions.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Review the diff.' }] }],
      tools: [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }],
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      stream: true,
    };
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response('data: done\n\n'));
    const response = await proxyAiGatewayRequest(
      await messagesRequest(JSON.stringify(payload)),
      config,
      upstream,
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/messages');
    expect(await new Request(url, init).json()).toEqual({
      ...payload,
      system: 'Review carefully.\nKeep this whitespace. \n\nRespect café conventions.',
    });
  });

  it.each([
    [{}, {}],
    [{ system: 'Already a string.' }, { system: 'Already a string.' }],
    [{ system: [] }, {}],
  ])('handles absent, string, and empty Claude system prompts: %j', async (system, expected) => {
    const payload = {
      model: 'anthropic/claude-opus-4.8',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 128,
    };
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    await proxyAiGatewayRequest(
      await messagesRequest(JSON.stringify({ ...payload, ...system })),
      config,
      upstream,
    );

    const [url, init] = upstream.mock.calls[0]!;
    expect(await new Request(url, init).json()).toEqual({
      ...payload,
      ...expected,
    });
  });

  it.each([null, { type: 'image', source: 'unsupported' }, { type: 'text', text: 123 }])(
    'rejects unsupported system blocks instead of silently removing instructions: %j',
    async (block) => {
      const upstream = vi.fn<typeof fetch>();
      const response = await proxyAiGatewayRequest(
        await messagesRequest(
          JSON.stringify({
            model: 'anthropic/claude-opus-4.8',
            system: [{ type: 'text', text: 'Keep these instructions.' }, block],
            messages: [],
            max_tokens: 128,
          }),
        ),
        config,
        upstream,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: 'system must contain only text blocks with string text' },
      });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('checks the model grant before adapting a Claude request', async () => {
    const upstream = vi.fn<typeof fetch>();
    const response = await proxyAiGatewayRequest(
      await messagesRequest(
        JSON.stringify({
          model: 'anthropic/claude-haiku-4.5',
          system: [{ type: 'text', text: 'Instructions' }],
        }),
      ),
      config,
      upstream,
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['responses', 'chat/completions'])(
    'leaves request bodies unchanged outside the Messages endpoint: %s',
    async (endpoint) => {
      const model = 'openai/gpt-5.2-codex';
      const grant = await createAiGatewayGrant(config.apiToken, model, Date.now() + 60_000);
      const body = JSON.stringify({ model, system: [{ type: 'text', text: 'Instructions' }] });
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      await proxyAiGatewayRequest(
        new Request(`https://turbodiff.test/ai-proxy/v1/${endpoint}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${grant}` },
          body,
        }),
        config,
        upstream,
      );
      expect(upstream.mock.calls[0]![1]?.body).toBe(body);
    },
  );

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
