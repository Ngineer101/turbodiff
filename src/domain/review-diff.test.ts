import { describe, expect, it } from 'vite-plus/test';
import { REVIEW_NOISE_PATTERNS, splitDiffSegments } from './review-diff.ts';

const noiseReason = (path: string) =>
  REVIEW_NOISE_PATTERNS.find((n) => n.pattern.test(path))?.reason ?? null;

describe('REVIEW_NOISE_PATTERNS', () => {
  it('treats a drizzle schema snapshot as noise but not the migration beside it', () => {
    expect(noiseReason('db/migrations/meta/0015_snapshot.json')).toBe('drizzle schema snapshot');
    expect(noiseReason('drizzle/meta/0000_snapshot.json')).toBe('drizzle schema snapshot');
    expect(noiseReason('db/migrations/0015_fable-5-1.sql')).toBeNull();
    expect(noiseReason('db/migrations/meta/_journal.json')).toBeNull();
    expect(noiseReason('src/snapshot.json')).toBeNull();
  });

  it('keeps matching the lockfile, minified and source-map families', () => {
    expect(noiseReason('pnpm-lock.yaml')).toBe('lockfile');
    expect(noiseReason('packages/web/package-lock.json')).toBe('lockfile');
    expect(noiseReason('public/app.min.js')).toBe('minified asset');
    expect(noiseReason('public/app.js.map')).toBe('source map');
    expect(noiseReason('src/app.ts')).toBeNull();
  });
});

describe('splitDiffSegments', () => {
  it('splits a unified diff into per-file segments keyed by the b-side path', () => {
    const diff =
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n' +
      'diff --git "a/sp ace.ts" "b/sp ace.ts"\n--- "a/sp ace.ts"\n+++ "b/sp ace.ts"\n@@ -1 +1 @@\n-1\n+2\n';
    expect(splitDiffSegments(diff).map((s) => s.path)).toEqual(['src/a.ts', 'sp ace.ts']);
  });
});
