import { describe, expect, it } from 'vite-plus/test';
import { decideDelivery } from '../../../src/domain/delivery-lifecycle.ts';
import { repositoryPolicy } from '../../../src/domain/repository-policy.ts';
import { verifierAgent } from '../../../src/agents/verifier.ts';

const ready = {
  policy: repositoryPolicy({ processProfile: 'full_delivery' }),
  review: 'passed' as const,
  verification: 'passed' as const,
  ci: 'passed' as const,
  repairAttempts: 0,
  repairUnchanged: false,
};
describe('automatic delivery decisions', () => {
  it('never merges before review, acceptance verification, and CI are complete', () => {
    expect(decideDelivery({ ...ready, review: null })).toMatchObject({ operation: 'review' });
    expect(decideDelivery({ ...ready, verification: null })).toMatchObject({ operation: 'verify' });
    expect(decideDelivery({ ...ready, ci: 'pending' })).toMatchObject({ kind: 'wait' });
    expect(decideDelivery({ ...ready, verification: 'inconclusive' })).toMatchObject({
      kind: 'wait',
    });
    expect(decideDelivery(ready)).toMatchObject({ operation: 'merge' });
  });
  it.each(['ci', 'review', 'verification'] as const)('repairs a failed %s gate', (gate) => {
    expect(decideDelivery({ ...ready, [gate]: 'failed' })).toMatchObject({ operation: 'repair' });
  });
  it('hands off after no-change repair or the durable three-attempt budget', () => {
    expect(decideDelivery({ ...ready, ci: 'failed', repairUnchanged: true })).toMatchObject({
      kind: 'wait',
    });
    expect(decideDelivery({ ...ready, ci: 'failed', repairAttempts: 3 })).toMatchObject({
      kind: 'wait',
    });
  });
  it('honors disabled delivery, assisted delivery, and nonblocking review policy', () => {
    expect(decideDelivery({ ...ready, policy: repositoryPolicy({}) })).toMatchObject({
      kind: 'wait',
    });
    expect(
      decideDelivery({
        ...ready,
        policy: repositoryPolicy({ processProfile: 'assisted_delivery' }),
      }),
    ).toMatchObject({ kind: 'complete' });
    expect(
      decideDelivery({
        ...ready,
        review: 'failed',
        policy: repositoryPolicy({ processProfile: 'full_delivery', blockingReviews: false }),
      }),
    ).toMatchObject({ operation: 'merge' });
  });
  it('rejects verification for a different head or missing/changed acceptance criteria', () => {
    const schema = verifierAgent.output({
      headSha: 'a'.repeat(40),
      criteria: ['Loads saved data'],
      instructions: 'Task',
      checkCommand: null,
    });
    const result = {
      kind: 'verification',
      headSha: 'a'.repeat(40),
      summary: 'Verified',
      criteria: [
        {
          text: 'Loads saved data',
          verdict: 'passed',
          evidence: 'Test observed the saved record.',
        },
      ],
    };
    expect(schema.safeParse(result).success).toBe(true);
    expect(schema.safeParse({ ...result, headSha: 'b'.repeat(40) }).success).toBe(false);
    expect(schema.safeParse({ ...result, criteria: [] }).success).toBe(false);
    expect(
      schema.safeParse({
        ...result,
        criteria: [{ ...result.criteria[0], text: 'Something easier' }],
      }).success,
    ).toBe(false);
  });
});
