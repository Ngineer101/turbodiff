import { describe, expect, it } from 'vite-plus/test';
// Co-located with the pure Explain-tab document contract.
import {
  EXPLAIN_MAX_PATCH_CHARS,
  explainInstanceId,
  explanationProblems,
  explanationRequestBody,
  isExplainInstanceId,
  parseExplanationDocument,
  type ExplanationDocument,
} from './explain.ts';

const sound: ExplanationDocument = {
  blocks: [
    { kind: 'summary', text: 'deliver() now retries with a doubling backoff.' },
    {
      kind: 'call_tree',
      title: 'deliver()',
      text: 'The single fetch becomes a bounded loop.',
      lines: [
        { text: 'deliver(hook, body)' },
        { text: '  fetch(hook.url)', change: '-' },
        { text: '  for attempt in 1..5', change: '+' },
      ],
      refs: [{ path: 'src/http/webhooks.ts', start: 14, end: 31 }],
    },
    {
      kind: 'sequence',
      title: 'Dead endpoint',
      text: 'Five 503s, then one error back to the queue.',
      participants: ['queue', 'deliver()', 'endpoint'],
      messages: [
        { from: 'queue', to: 'deliver()', label: 'deliver(hook)', style: 'call' },
        { from: 'deliver()', to: 'endpoint', label: 'POST', style: 'call' },
        { from: 'endpoint', to: 'deliver()', label: '503', style: 'error' },
        { from: 'deliver()', to: 'queue', label: 'DeliveryError', style: 'error' },
      ],
      loop: { label: 'loop ×5', from: 1, to: 2 },
      refs: [{ path: 'src/http/webhooks.test.ts' }],
    },
  ],
};
const changed = ['src/http/webhooks.ts', 'src/http/webhooks.test.ts'];

describe('parseExplanationDocument', () => {
  it('round-trips a sound document through jsonb-shaped input', () => {
    expect(parseExplanationDocument(JSON.parse(JSON.stringify(sound)))).toEqual(sound);
  });

  it('reads malformed or non-object rows as absent', () => {
    expect(parseExplanationDocument(null)).toBeNull();
    expect(parseExplanationDocument('not a document')).toBeNull();
    expect(parseExplanationDocument({ blocks: [] })).toBeNull();
    expect(parseExplanationDocument({ blocks: [{ kind: 'mermaid', text: 'x' }] })).toBeNull();
  });

  it('defaults a message style to call', () => {
    const parsed = parseExplanationDocument({
      blocks: [
        { kind: 'summary', text: 'x' },
        {
          kind: 'sequence',
          title: 't',
          text: 'x',
          participants: ['a', 'b'],
          messages: [{ from: 'a', to: 'b', label: 'go' }],
          refs: [{ path: 'a.ts' }],
        },
      ],
    });
    expect(parsed?.blocks[1]?.kind === 'sequence' && parsed.blocks[1].messages[0]?.style).toBe(
      'call',
    );
  });
});

describe('explanationProblems', () => {
  it('accepts a sound document', () => {
    expect(explanationProblems(sound, changed)).toEqual([]);
  });

  it('requires the summary first and refs that land in the diff', () => {
    const doc: ExplanationDocument = {
      blocks: [
        {
          kind: 'pseudocode',
          title: 'backoff',
          text: 'Doubles from 200ms.',
          lines: [{ text: 'min(5s, 200ms × 2^n)' }],
          refs: [{ path: 'src/http/other.ts', start: 9, end: 3 }],
        },
        { kind: 'summary', text: 'late' },
      ],
    };
    const problems = explanationProblems(doc, changed);
    expect(problems).toContain('the first block must be the summary');
    expect(
      problems.some((p) => p.includes('"src/http/other.ts", which is not a changed file')),
    ).toBe(true);
    expect(problems.some((p) => p.includes('end line precedes its start line'))).toBe(true);
  });

  it('flags a sketch without refs and a sequence naming an undeclared participant', () => {
    const doc: ExplanationDocument = {
      blocks: [
        { kind: 'summary', text: 'ok' },
        { kind: 'file_tree', title: 'files', text: 'x', lines: [{ text: 'src/' }], refs: [] },
        {
          kind: 'sequence',
          title: 's',
          text: 'x',
          participants: ['a', 'a'],
          messages: [{ from: 'a', to: 'ghost', label: 'hi', style: 'call' }],
          loop: { label: 'l', from: 0, to: 4 },
          refs: [{ path: changed[0]! }],
        },
      ],
    };
    const problems = explanationProblems(doc, changed);
    expect(problems.some((p) => p.includes('needs at least one ref'))).toBe(true);
    expect(problems.some((p) => p.includes('lists a participant twice'))).toBe(true);
    expect(problems.some((p) => p.includes('not declared'))).toBe(true);
    expect(problems.some((p) => p.includes('loop range'))).toBe(true);
  });
});

describe('explanationRequestBody', () => {
  it('lists every file, fences patches, and marks files without one', () => {
    const body = explanationRequestBody(
      'Retry webhooks',
      [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '+x' },
        { filename: 'img.png', status: 'added', additions: 0, deletions: 0, patch: null },
      ],
      'abcdef1234567890',
    );
    expect(body).toContain('Explain the change "Retry webhooks" at head abcdef123456');
    expect(body).toContain('- a.ts\n- img.png');
    expect(body).toContain('### a.ts (modified, +1 −0)\n```diff\n+x\n```');
    expect(body).toContain('### img.png (added, +0 −0)\n[patch not available');
  });

  it('truncates an oversized patch with a marker', () => {
    const body = explanationRequestBody(
      't',
      [
        {
          filename: 'big.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: 'x'.repeat(EXPLAIN_MAX_PATCH_CHARS + 10),
        },
      ],
      'deadbeef',
    );
    expect(body).toContain(`patch truncated at ${EXPLAIN_MAX_PATCH_CHARS} characters`);
  });
});

describe('explainInstanceId', () => {
  it('is lower-cased, prefixed, and keyed by feature + short head + nonce', () => {
    const id = explainInstanceId(42, 'ABCDEF1234567890abc', 'N0nce');
    expect(id).toBe('explain--42--abcdef123456--n0nce');
    expect(isExplainInstanceId(id)).toBe(true);
    expect(isExplainInstanceId('code-review--acme--api--7')).toBe(false);
  });
});
