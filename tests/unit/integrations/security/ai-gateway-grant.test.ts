import { describe, expect, it } from 'vite-plus/test';
import {
  createAiGatewayGrant,
  verifyAiGatewayGrantWithSecret,
} from '../../../../src/integrations/security/ai-gateway-grant.ts';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createLegacyGrant(
  secret: string,
  model: string,
  expiresAt: number,
): Promise<string> {
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({ v: 1, model, exp: expiresAt })),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

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

  it('accepts a still-valid v1 grant during the two-hour rollout window', async () => {
    const token = await createLegacyGrant('test-secret', 'openai/gpt-5.2-codex', 2_000);

    await expect(verifyAiGatewayGrantWithSecret('test-secret', token, 1_000)).resolves.toEqual({
      v: 1,
      model: 'openai/gpt-5.2-codex',
      exp: 2_000,
    });
    await expect(verifyAiGatewayGrantWithSecret('test-secret', token, 2_000)).resolves.toBeNull();
  });
});
