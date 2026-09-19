import { describe, expect, it } from 'vite-plus/test';
import {
  createAiGatewayGrant,
  verifyAiGatewayGrantWithSecret,
} from '../../../../src/integrations/security/ai-gateway-grant.ts';

describe('AI Gateway sandbox grants', () => {
  it('round-trips a valid model-scoped grant', async () => {
    const token = await createAiGatewayGrant(
      'test-secret',
      'openai/gpt-5.2-codex',
      'org-1',
      42,
      2_000,
    );
    await expect(verifyAiGatewayGrantWithSecret('test-secret', token, 1_000)).resolves.toEqual({
      v: 2,
      model: 'openai/gpt-5.2-codex',
      organizationId: 'org-1',
      agentRunId: 42,
      exp: 2_000,
    });
  });

  it('rejects tampering, the wrong signing key, and expired grants', async () => {
    const token = await createAiGatewayGrant(
      'test-secret',
      'anthropic/claude-sonnet-4-5',
      'org-1',
      42,
      2_000,
    );
    await expect(verifyAiGatewayGrantWithSecret('wrong-secret', token, 1_000)).resolves.toBeNull();
    await expect(
      verifyAiGatewayGrantWithSecret('test-secret', `${token}x`, 1_000),
    ).resolves.toBeNull();
    await expect(verifyAiGatewayGrantWithSecret('test-secret', token, 2_000)).resolves.toBeNull();
  });

  it('rejects malformed grants without throwing', async () => {
    await expect(verifyAiGatewayGrantWithSecret('test-secret', 'not-a-grant')).resolves.toBeNull();
    await expect(verifyAiGatewayGrantWithSecret('test-secret', '!.!')).resolves.toBeNull();
  });
});
