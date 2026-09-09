import { describe, expect, it } from 'vite-plus/test';
import { REVIEW_NOISE_PATTERNS, splitDiffSegmentChunks, splitDiffSegments } from './review-diff.ts';

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

describe('splitDiffSegmentChunks', () => {
  it('pages an oversized patch without dropping content or losing line counters', () => {
    const header =
      'diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n';
    const body =
      '@@ -20,3000 +20,3000 @@\n' +
      Array.from({ length: 3_000 }, (_, i) => `-${i}\n+${i}!\n`).join('');
    const chunks = splitDiffSegmentChunks(header + body, 10_000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 10_000)).toBe(true);
    expect(chunks[0]).toContain('@@ -20,3000 +20,3000 @@');
    expect(chunks[1]).toMatch(/continued patch; next old line \d+, next new line \d+/);
    expect(chunks.join('\n')).toContain('+2999!');
  });

  it('keeps a normal patch as one chunk', () => {
    expect(
      splitDiffSegmentChunks('diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n', 20_000),
    ).toHaveLength(1);
  });
});
