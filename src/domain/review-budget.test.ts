import { describe, expect, it } from 'vite-plus/test';
import { reviewPacketChars } from './review-budget.ts';

describe('reviewPacketChars', () => {
  it('converts operator-managed token budgets conservatively and bounds mistakes', () => {
    expect(reviewPacketChars(64_000)).toBe(192_000);
    expect(reviewPacketChars(1)).toBe(24_000);
    expect(reviewPacketChars(999_999)).toBe(600_000);
  });
});
