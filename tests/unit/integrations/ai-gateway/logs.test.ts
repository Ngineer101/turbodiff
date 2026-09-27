import { describe, expect, it, vi } from 'vite-plus/test';
import { getAiGatewayLogUsage } from '../../../../src/integrations/ai-gateway/logs.ts';

const config = {
  accountId: 'account-123',
  gatewayId: 'default',
  apiToken: 'worker-token',
};

const reference = {
  logId: 'log-123',
  organizationId: 'org-1',
  agentRunId: 42,
};

describe('AI Gateway log usage', () => {
  it('accepts Cloudflare cost only when the durable attribution matches', async () => {
    const fetchUpstream = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        result: {
          id: 'log-123',
          tokens_in: 1_500_000,
          tokens_out: 250_000,
          cost: 9.98,
          metadata: JSON.stringify({
            app: 'turbodiff',
            organization_id: 'org-1',
            agent_run_id: 42,
          }),
        },
      }),
    );

    await expect(getAiGatewayLogUsage(config, reference, fetchUpstream)).resolves.toEqual({
      ...reference,
      tokensIn: 1_500_000,
      tokensOut: 250_000,
      costUsd: 9.98,
    });
    expect(fetchUpstream).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-123/ai-gateway/gateways/default/logs/log-123',
      { headers: { authorization: 'Bearer worker-token' } },
    );
  });

  it('keeps a log pending while Cloudflare has not published its cost', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(getAiGatewayLogUsage(config, reference, missing)).resolves.toBeNull();

    const noCost = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        result: {
          id: 'log-123',
          tokens_in: 10,
          tokens_out: 2,
          metadata: JSON.stringify({ organization_id: 'org-1', agent_run_id: 42 }),
        },
      }),
    );
    await expect(getAiGatewayLogUsage(config, reference, noCost)).resolves.toBeNull();
  });

  it('rejects a Cloudflare log attributed to another tenant or run', async () => {
    const fetchUpstream = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        result: {
          id: 'log-123',
          tokens_in: 10,
          tokens_out: 2,
          cost: 0.01,
          metadata: JSON.stringify({ organization_id: 'org-2', agent_run_id: 99 }),
        },
      }),
    );

    await expect(getAiGatewayLogUsage(config, reference, fetchUpstream)).rejects.toThrow(
      'attribution does not match',
    );
  });
});
