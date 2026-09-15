import { describe, expect, it } from 'vite-plus/test';
import {
  explanationDocumentSchema,
  explanationProblems,
  type ExplanationDocument,
} from '../../../src/artifacts/explanation.ts';

const document: ExplanationDocument = {
  blocks: [
    { kind: 'summary', text: 'deliver() now retries with bounded backoff.' },
    {
      kind: 'call_tree',
      title: 'deliver()',
      text: 'The single request becomes a retry loop.',
      lines: [{ text: 'deliver()' }, { text: '  retry()', change: '+' }],
      refs: [{ path: 'src/http/webhooks.ts', start: 14, end: 31 }],
    },
  ],
};

describe('explanation artifact', () => {
  it('parses its immutable document shape and defaults sequence styles', () => {
    expect(explanationDocumentSchema.parse(document)).toEqual(document);
    const parsed = explanationDocumentSchema.parse({
      blocks: [
        { kind: 'summary', text: 'Summary' },
        {
          kind: 'sequence',
          title: 'Request',
          text: 'One request and response.',
          participants: ['caller', 'server'],
          messages: [{ from: 'caller', to: 'server', label: 'GET' }],
          refs: [{ path: 'src/http/webhooks.ts' }],
        },
      ],
    });
    const sequence = parsed.blocks[1];
    expect(sequence?.kind === 'sequence' ? sequence.messages[0]?.style : null).toBe('call');
  });

  it('rejects semantic references that cannot land in the diff', () => {
    const invalid: ExplanationDocument = {
      blocks: [
        {
          kind: 'pseudocode',
          title: 'backoff',
          text: 'Doubles from 200ms.',
          lines: [{ text: 'delay = 200 * 2^attempt' }],
          refs: [{ path: 'other.ts', start: 9, end: 3 }],
        },
        { kind: 'summary', text: 'Late summary' },
      ],
    };
    expect(explanationProblems(invalid, ['src/http/webhooks.ts'])).toEqual(
      expect.arrayContaining([
        'the first block must be the summary',
        'block 1 references unknown file other.ts',
        'block 1 has an inverted line range',
      ]),
    );
  });
});
