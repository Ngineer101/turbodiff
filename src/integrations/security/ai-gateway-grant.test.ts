import { describe, expect, it } from 'vite-plus/test';
import { createAiGatewayGrant, verifyAiGatewayGrantWithSecret } from './ai-gateway-grant.ts';

describe('AI Gateway sandbox grants', () => {
  it('round-trips a valid model-scoped grant', async () => {
    const token = await createAiGatewayGrant('test-secret', 'openai/gpt-5.2-codex', 2_000);
    await expect(verifyAiGatewayGrantWithSecret('test-secret', token, 1_000)).resolves.toEqual({
      v: 1,
      model: 'openai/gpt-5.2-codex',
      exp: 2_000,
    });
  });

  it('rejects tampering, the wrong signing key, and expired grants', async () => {
    const token = await createAiGatewayGrant('test-secret', 'anthropic/claude-sonnet-4-5', 2_000);
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
