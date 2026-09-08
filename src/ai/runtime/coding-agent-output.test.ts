import { describe, expect, it } from 'vite-plus/test';
import {
  addCliUsage,
  codingAgentResultText,
  codingAgentSessionId,
  parseCodingAgentUsage,
} from './coding-agent-output.ts';

describe('OpenCode JSON event output', () => {
  it('extracts the final narrative and session from a multi-step run', () => {
    const stdout = [
      JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_12345678',
        part: { type: 'step-start' },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_12345678',
        part: { type: 'text', text: 'I will inspect the code.' },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_12345678',
        part: { type: 'text', text: 'Implemented and verified.' },
      }),
    ].join('\n');

    expect(codingAgentResultText(stdout)).toBe('Implemented and verified.');
    expect(codingAgentSessionId(stdout)).toBe('ses_12345678');
  });

  it('sums every model step and tolerates a truncated final event', () => {
    const stdout = [
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_abcdefgh',
        part: {
          type: 'step-finish',
          cost: 0.12,
          tokens: { input: 100, output: 20, cache: { read: 80, write: 4 } },
        },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_abcdefgh',
        part: {
          type: 'step-finish',
          cost: 0.03,
          tokens: { input: 30, output: 8, cache: { read: 10, write: 2 } },
        },
      }),
      '{"type":"step_finish"',
    ].join('\n');

    expect(parseCodingAgentUsage(stdout, 'openai/gpt-5.5')).toEqual({
      inputTokens: 130,
      outputTokens: 28,
      cacheReadTokens: 90,
      cacheWriteTokens: 6,
      costUsd: 0.15,
      model: 'openai/gpt-5.5',
    });
  });

  it('falls back without inventing output or metering', () => {
    expect(codingAgentResultText('process failed before JSON')).toBe('process failed before JSON');
    expect(codingAgentSessionId('process failed before JSON')).toBeNull();
    expect(parseCodingAgentUsage('process failed before JSON')).toBeNull();
  });

  it('adds repair-round usage without losing the original model', () => {
    expect(
      addCliUsage(
        {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 4,
          cacheWriteTokens: 1,
          costUsd: 0.1,
          model: 'anthropic/claude-sonnet-5',
        },
        {
          inputTokens: 5,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          costUsd: 0.04,
          model: 'anthropic/claude-sonnet-5',
        },
      ),
    ).toEqual({
      inputTokens: 15,
      outputTokens: 5,
      cacheReadTokens: 6,
      cacheWriteTokens: 1,
      costUsd: 0.14,
      model: 'anthropic/claude-sonnet-5',
    });
  });
});
