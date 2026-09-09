import { describe, expect, it } from 'vite-plus/test';
import { groupModelOptions, modelProvider } from './model-combobox.tsx';

const options = [
  { id: 'anthropic/claude-fable-5.1', label: 'Fable 5.1' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: '@cf/moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' },
];

describe('model combobox catalog', () => {
  it('preserves catalog and provider order when grouping options', () => {
    expect(groupModelOptions(options, '')).toEqual([
      { provider: 'Anthropic', options: [options[0]] },
      { provider: 'OpenAI', options: [options[1]] },
      { provider: 'Workers AI', options: [options[2]] },
    ]);
  });

  it.each([
    ['sol', 'openai/gpt-5.6-sol'],
    ['OPENAI', 'openai/gpt-5.6-sol'],
    ['moonshotai', '@cf/moonshotai/kimi-k2.7-code'],
    ['workers ai', '@cf/moonshotai/kimi-k2.7-code'],
  ])('finds %s by label, canonical id, or provider', (query, expectedId) => {
    const matches = groupModelOptions(options, query).flatMap((group) => group.options);
    expect(matches.map((option) => option.id)).toEqual([expectedId]);
  });

  it('recognizes reviewer and runner forms of the same provider', () => {
    expect(modelProvider('cloudflare/google/gemini-3.7-flash')).toBe('Google');
    expect(modelProvider('cloudflare/@cf/zai-org/glm-5.3')).toBe('Workers AI');
  });
});
