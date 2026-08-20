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
