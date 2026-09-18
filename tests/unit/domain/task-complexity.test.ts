import { describe, expect, it } from 'vite-plus/test';
import {
  taskComplexityState,
  tierFromComplexityChoice,
  TRIVIAL_CONFIDENCE_FLOOR,
} from '../../../src/domain/task-complexity.ts';

describe('taskComplexityState', () => {
  it('forwards the lightweight signals as the judgment state', () => {
    expect(
      taskComplexityState({
        title: 'Fix typo',
        requirements: 'Correct the spelling in the footer.',
        repositoryCount: 1,
        attachmentCount: 0,
      }),
    ).toEqual({
      title: 'Fix typo',
      requirements: 'Correct the spelling in the footer.',
      repositoryCount: 1,
      attachmentCount: 0,
    });
  });
});

describe('tierFromComplexityChoice', () => {
  it('takes the trivial path only on a confident trivial selection', () => {
    expect(tierFromComplexityChoice({ choice: 'trivial', confidence: 0.9 })).toBe('trivial');
    expect(
      tierFromComplexityChoice({ choice: 'trivial', confidence: TRIVIAL_CONFIDENCE_FLOOR }),
    ).toBe('trivial');
  });

  it('falls back to standard when the trivial selection is low-confidence', () => {
    expect(
      tierFromComplexityChoice({ choice: 'trivial', confidence: TRIVIAL_CONFIDENCE_FLOOR - 0.01 }),
    ).toBe('standard');
  });

  it('uses standard for a standard selection regardless of confidence', () => {
    expect(tierFromComplexityChoice({ choice: 'standard', confidence: 0.99 })).toBe('standard');
    expect(tierFromComplexityChoice({ choice: 'standard', confidence: 0.2 })).toBe('standard');
  });

  it('errs toward standard for an unexpected label', () => {
    expect(tierFromComplexityChoice({ choice: 'unknown', confidence: 1 })).toBe('standard');
  });
});
