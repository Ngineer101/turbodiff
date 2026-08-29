import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vite-plus/test';
import { applyOptimistic, optimisticId, optimisticNow } from './optimistic.ts';

describe('applyOptimistic', () => {
  it('patches the cached value immediately and rolls back to the snapshot', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['list'], { items: [1, 2] });
    const ctx = await applyOptimistic<{ items: number[] }>(qc, ['list'], (prev) => ({
      items: [...prev.items, 3],
    }));
    expect(qc.getQueryData(['list'])).toEqual({ items: [1, 2, 3] });
    ctx.rollback();
    expect(qc.getQueryData(['list'])).toEqual({ items: [1, 2] });
  });

  it('is a no-op when nothing is cached yet', async () => {
    const qc = new QueryClient();
    const ctx = await applyOptimistic<{ items: number[] }>(qc, ['empty'], (prev) => prev);
    expect(qc.getQueryData(['empty'])).toBeUndefined();
    ctx.rollback();
    expect(qc.getQueryData(['empty'])).toBeUndefined();
  });
});

describe('optimisticNow', () => {
  it('matches the PostgreSQL adapter ISO timestamp shape', () => {
    expect(optimisticNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('optimisticId', () => {
  it('yields unique negative ids', () => {
    const a = optimisticId();
    const b = optimisticId();
    expect(a).toBeLessThan(0);
    expect(b).toBeLessThan(0);
    expect(a).not.toBe(b);
  });
});
