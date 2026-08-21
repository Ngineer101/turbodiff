// Diff files that carry machine noise rather than reviewable intent.
export const REVIEW_NOISE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern:
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|flake\.lock|go\.sum|gradle\.lockfile)$/,
    reason: 'lockfile',
  },
  { pattern: /\.min\.(js|css)$/, reason: 'minified asset' },
  { pattern: /\.map$/, reason: 'source map' },
];

export interface DiffSegment {
  path: string;
  segment: string;
}

// Splits a unified diff into per-file segments with the path from each
// `diff --git` header (quoted paths and renames resolve to the b-side).
// Shared by the reviewer's noise filter (ai/tools/github.ts) and the native
// change-request per-file patch builder (services/change-requests.ts) so the
// two can never disagree on file boundaries.
export function splitDiffSegments(diff: string): DiffSegment[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((segment) => segment.trim())
    .map((segment) => {
      const header = segment.match(/^diff --git "?a\/.+?"? "?b\/(.+?)"?$/m);
      return header ? { path: header[1], segment } : null;
    })
    .filter((entry): entry is DiffSegment => entry !== null);
}
