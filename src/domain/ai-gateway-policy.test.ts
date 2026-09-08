import { describe, expect, it } from 'vite-plus/test';
import { requestUsesGrantedModel } from './ai-gateway-policy.ts';

describe('AI Gateway proxy model boundary', () => {
  it('accepts only the exact model encoded in the grant', () => {
    expect(
      requestUsesGrantedModel('{"model":"google/gemini-3-flash"}', 'google/gemini-3-flash'),
    ).toBe(true);
    expect(
      requestUsesGrantedModel('{"model":"openai/gpt-5.2-codex"}', 'google/gemini-3-flash'),
    ).toBe(false);
  });

  it('rejects malformed requests and non-string model fields', () => {
    expect(requestUsesGrantedModel('not-json', 'openai/gpt-5.2-codex')).toBe(false);
    expect(requestUsesGrantedModel('{"model":1}', 'openai/gpt-5.2-codex')).toBe(false);
  });
});
