import { describe, expect, it } from 'vite-plus/test';
import { redactSecrets } from '../../../../src/integrations/agent-runtime/redaction.ts';

describe('redactSecrets', () => {
  it('redacts every non-empty secret', () => {
    expect(redactSecrets('token-a then token-b', ['token-a', 'token-b'])).toBe('*** then ***');
  });

  it('ignores empty configured secrets', () => {
    expect(redactSecrets('safe output', ['', 'missing'])).toBe('safe output');
  });
});
