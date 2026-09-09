// Diff files that carry machine noise rather than reviewable intent.
export const REVIEW_NOISE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  {
    pattern:
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|flake\.lock|go\.sum|gradle\.lockfile)$/,
    reason: 'lockfile',
  },
  { pattern: /\.min\.(js|css)$/, reason: 'minified asset' },
  { pattern: /\.map$/, reason: 'source map' },
  // drizzle-kit writes a full schema snapshot (thousands of lines of JSON)
  // beside every migration; the .sql next to it is what changes the schema
  // and gets reviewed. The generated-marker heuristic in ai/tools/github.ts
  // exempts migration paths on purpose, so the snapshot needs its own entry:
  // one snapshot alone overflowed a 131k-token review model (feature 7).
  { pattern: /(^|\/)meta\/\d{4}_snapshot\.json$/, reason: 'drizzle schema snapshot' },
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

// Produces deterministic, line-aligned pages for a single file patch. The
// continuation marker carries the next old/new line counters so a reviewer
// can still derive exact anchors without receiving one unbounded tool result.
export function splitDiffSegmentChunks(segment: string, maxChars: number): string[] {
  const limit = Math.max(10_000, maxChars);
  if (segment.length <= limit) return [segment];

  const lines = segment.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [segment];
  const firstHunk = lines.findIndex((line) => line.startsWith('@@ '));
  const prefix = (firstHunk < 0 ? lines.slice(0, 4) : lines.slice(0, firstHunk)).join('');
  const body = firstHunk < 0 ? lines.slice(4) : lines.slice(firstHunk);
  const chunks: string[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let current = prefix;

  const continuation = () =>
    `${prefix}[turbodiff: continued patch; next old line ${oldLine ?? '-'}, next new line ${newLine ?? '-'}]\n`;

  for (const line of body) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    }
    if (current.length > prefix.length && current.length + line.length > limit) {
      chunks.push(current);
      current = continuation();
    }
    if (current.length + line.length <= limit) {
      current += line;
    } else {
      let rest = line;
      while (rest.length > 0) {
        const room = Math.max(1, limit - current.length);
        current += rest.slice(0, room);
        rest = rest.slice(room);
        if (rest.length > 0) {
          chunks.push(current);
          current = continuation();
        }
      }
    }
    if (!hunk && oldLine !== null && newLine !== null) {
      if (!line.startsWith('+')) oldLine += 1;
      if (!line.startsWith('-')) newLine += 1;
    }
  }
  if (current.length > prefix.length) chunks.push(current);
  return chunks;
}
