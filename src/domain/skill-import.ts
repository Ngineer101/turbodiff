// Pure policies for importing external skills (skills.sh catalog entries and
// GitHub skill folders): reference parsing, SKILL.md frontmatter extraction,
// slug derivation, and file-path/size sanitization. No I/O — the HTTP layer
// resolves references through the integration clients.

export interface SkillFile {
  path: string;
  contents: string;
}

// Limits applied by sanitizeSkillFiles — a skill is instructions plus a few
// helper files, not a repository snapshot.
const MAX_FILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

const FILE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// Security-relevant: sanctioned paths end up interpolated into sandbox
// `mkdir -p` commands and writeFile targets under the skill's mount
// directory, so anything that could escape it (absolute paths, `..`
// segments, empty segments) or smuggle shell-significant characters is
// rejected. The leading character must be alphanumeric (no `-`, so a path
// can never read as a command flag).
export function validSkillFilePath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (!FILE_PATH_RE.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export interface ParsedSkillMarkdown {
  name: string | null;
  description: string | null;
  body: string;
}

// Tolerant YAML-frontmatter extractor for a SKILL.md: pulls scalar `name:` /
// `description:` lines (quoted or bare) from a leading `---` block and
// returns everything after the closing `---` as the body. No YAML dependency
// — skills in the wild use simple one-line scalars, and anything fancier
// falls back to null (callers derive the name elsewhere).
export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { name: null, description: null, body: markdown.trim() };
  const frontmatter = match[1];
  const scalar = (key: string): string | null => {
    const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
    if (!line) return null;
    const raw = line[1].trim();
    if (!raw) return null;
    if (
      (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    ) {
      const inner = raw.slice(1, -1);
      // Double-quoted YAML scalars escape backslashes and quotes; single
      // quotes double themselves.
      return raw.startsWith('"')
        ? inner.replace(/\\(["\\])/g, '$1')
        : inner.replace(/''/g, "'");
    }
    return raw;
  };
  return {
    name: scalar('name'),
    description: scalar('description'),
    body: markdown.slice(match[0].length).trim(),
  };
}

// Derives a slug satisfying the app-wide slug contract (SLUG_RE in
// api-support.ts and the skills_slug_format DB check): lowercase runs of
// [a-z0-9] separated by single dashes, 2-31 chars, no leading/trailing dash.
export function deriveSkillSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31)
    .replace(/-+$/, '');
  return slug;
}

// Drops the root SKILL.md (its body becomes `instructions` and it is
// re-rendered at mount time), drops invalid paths, and enforces the size
// budget. Over-budget imports fail loudly rather than silently truncating.
export function sanitizeSkillFiles(files: { path: string; contents: string }[]): SkillFile[] {
  const kept = files.filter((f) => f.path !== 'SKILL.md' && validSkillFilePath(f.path));
  if (kept.length > MAX_FILES) {
    throw new Error(`skill has too many files (${kept.length}; the limit is ${MAX_FILES})`);
  }
  let total = 0;
  for (const file of kept) {
    const bytes = new TextEncoder().encode(file.contents).length;
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`skill file "${file.path}" is too large (the limit is 256 KiB per file)`);
    }
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new Error('skill files exceed the 1 MiB total size limit');
  }
  return kept.map((f) => ({ path: f.path, contents: f.contents }));
}

export type SkillReference =
  | { kind: 'catalog'; source: string; slug: string }
  | { kind: 'github'; owner: string; repo: string; ref: string | null; path: string };

// Accepts an `owner/repo/slug` triple, a skills.sh skill URL, or a GitHub
// folder URL (`https://github.com/{owner}/{repo}/tree/{ref}/{path}`).
// Returns null when the reference matches none of those shapes.
export function parseSkillReference(reference: string): SkillReference | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'skills.sh' || url.hostname === 'www.skills.sh') {
      // Skill pages address as .../{owner}/{repo}/{slug}; take the last
      // three path segments regardless of any leading route prefix.
      if (segments.length < 3) return null;
      const [owner, repo, slug] = segments.slice(-3);
      return { kind: 'catalog', source: `${owner}/${repo}`, slug };
    }
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      // /{owner}/{repo}/tree/{ref}/{path...}
      if (segments.length < 5 || segments[2] !== 'tree') return null;
      const [owner, repo, , ref, ...pathSegments] = segments;
      return { kind: 'github', owner, repo, ref, path: pathSegments.join('/') };
    }
    return null;
  }

  // Bare `owner/repo/slug` catalog triple.
  const parts = trimmed.split('/');
  if (parts.length === 3 && parts.every((p) => p.length > 0)) {
    return { kind: 'catalog', source: `${parts[0]}/${parts[1]}`, slug: parts[2] };
  }
  return null;
}
