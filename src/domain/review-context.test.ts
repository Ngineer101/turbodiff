import { describe, expect, it } from 'vite-plus/test';
import {
  buildReviewDiffSnapshot,
  missingReviewFiles,
  reviewConclusion,
  reviewPublicationEvent,
} from './review-context.ts';

function segment(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${body}\n+${body}!\n`;
}

describe('review context', () => {
  it('keeps every reviewable file in the patch and manifest', () => {
    const first = segment('src/large.ts', 'x'.repeat(80));
    const ui = segment('src/client/button.tsx', 'button');
    const snapshot = buildReviewDiffSnapshot(first + ui);

    expect(snapshot.diff).toBe(first + ui);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      'src/large.ts',
      'src/client/button.tsx',
    ]);
  });

  it('omits generated noise without requiring it for coverage', () => {
    const snapshot = buildReviewDiffSnapshot(
      segment('pnpm-lock.yaml', 'lock') + segment('src/app.ts', 'code'),
    );

    expect(snapshot.files[0]).toMatchObject({
      path: 'pnpm-lock.yaml',
      reviewable: false,
      omittedReason: 'lockfile',
    });
    expect(snapshot.diff).toContain('[turbodiff: diff for pnpm-lock.yaml omitted — lockfile]');
    expect(snapshot.diff).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(missingReviewFiles(snapshot.files, ['src/app.ts'])).toEqual([]);
  });

  it('reports every reviewable path not accounted for by the reviewer', () => {
    const manifest = [
      { path: 'src/a.ts', reviewable: true },
      { path: 'src/b.ts', reviewable: true },
      { path: 'pnpm-lock.yaml', reviewable: false },
    ];

    expect(missingReviewFiles(manifest, ['src/a.ts'])).toEqual(['src/b.ts']);
  });

  it('never approves an incomplete review', () => {
    expect(reviewPublicationEvent(true, false, false)).toBe('COMMENT');
    expect(reviewPublicationEvent(true, false, true)).toBe('APPROVE');
    expect(reviewPublicationEvent(true, true, false)).toBe('REQUEST_CHANGES');
    expect(reviewPublicationEvent(false, true, true)).toBe('COMMENT');
  });

  it('keeps uncertainty distinct from a clean or blocking conclusion', () => {
    expect(reviewConclusion(false, false, true)).toBe('ready');
    expect(reviewConclusion(false, true, true)).toBe('ready_with_warnings');
    expect(reviewConclusion(true, true, true)).toBe('not_ready');
    expect(reviewConclusion(false, false, false)).toBe('inconclusive');
  });
});
