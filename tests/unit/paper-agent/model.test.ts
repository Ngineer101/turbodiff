import { describe, expect, it } from 'vite-plus/test';
import { parseResponse, toolUsesOf } from '../../../src/paper-agent/model.ts';

describe('parseResponse', () => {
  it('keeps text and tool_use blocks and the stop reason', () => {
    const parsed = parseResponse({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'planning' },
        { type: 'tool_use', id: 't1', name: 'paper__add', input: { x: 1 } },
      ],
    });
    expect(parsed.stopReason).toBe('tool_use');
    expect(parsed.content).toEqual([
      { type: 'text', text: 'planning' },
      { type: 'tool_use', id: 't1', name: 'paper__add', input: { x: 1 } },
    ]);
  });

  it('defaults a tool_use with a non-object input to an empty object', () => {
    const parsed = parseResponse({
      content: [{ type: 'tool_use', id: 't1', name: 'x', input: 'oops' }],
    });
    expect(parsed.content).toEqual([{ type: 'tool_use', id: 't1', name: 'x', input: {} }]);
  });

  it('ignores malformed blocks and missing content', () => {
    expect(parseResponse({ content: [{ type: 'text' }, { type: 'tool_use', id: 1 }, 5] })).toEqual({
      stopReason: null,
      content: [],
    });
    expect(parseResponse({}).content).toEqual([]);
  });

  it('throws when the payload is not an object', () => {
    expect(() => parseResponse('nope')).toThrow();
  });
});

describe('toolUsesOf', () => {
  it('returns only the tool_use blocks', () => {
    const uses = toolUsesOf([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'a', name: 'x', input: {} },
    ]);
    expect(uses).toEqual([{ type: 'tool_use', id: 'a', name: 'x', input: {} }]);
  });
});
