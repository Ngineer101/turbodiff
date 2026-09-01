import type { RepositoryRow } from '../data/db.ts';
import { githubJson, githubJsonCached, githubPaginate } from '../integrations/github/client.ts';
import type { ApiFileSave, ApiRepoFile, ApiRepoTree, ApiTreeEntry } from '../shared/api-types.ts';
import { binaryPreviewKind } from '../shared/binary-preview.ts';
import { isString } from '../shared/json.ts';

// Browser codebase viewer/editor: all repo content is read and written
// through the GitHub REST API — no clone, no sandbox. Callers mint the token
// (cached installation token for reads, least-privilege sandboxGitToken for
// the write) so this module stays a pure GitHub adapter.

// A failure the route should surface with a specific HTTP status (client
// mistake) instead of the generic 502 GitHub-failure mapping.
export class RepoBrowserError extends Error {
  status: 400 | 409;
  constructor(message: string, status: 400 | 409) {
    super(message);
    this.status = status;
  }
}

// Path hygiene shared by the routes: no absolute paths, no `..` segments, no
// NUL. Empty is allowed here — the file endpoints additionally require a
// non-empty path.
export function isValidRepoPath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\0')) return false;
  return !path.split('/').some((segment) => segment === '..');
}

export function isValidRepoRef(ref: string): boolean {
  return ref.length > 0 && !/[\s\\~^:]/.test(ref) && !ref.includes('..');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function listBranchesAndDefault(
  token: string,
  repo: RepositoryRow,
): Promise<{ default_branch: string; branches: string[] }> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const [meta, branches] = await Promise.all([
    githubJson<{ default_branch: string }>(token, base),
    githubPaginate<{ name: string }[], string>(
      token,
      `${base}/branches?per_page=100`,
      (page) => page.map((branch) => branch.name),
      { maxPages: 10 },
    ),
  ]);
  return { default_branch: meta.default_branch, branches };
}

// The GitHub contents API's directory-listing entry shape; `type` is one of
// dir|file|symlink|submodule per the docs, kept open here for forward compat.
interface GithubContentsEntry {
  name: string;
  path: string;
  type: string;
  size: number;
  sha: string;
}

const TREE_ENTRY_TYPES = new Set<ApiTreeEntry['type']>(['dir', 'file', 'symlink', 'submodule']);

function entryType(type: string): ApiTreeEntry['type'] {
  // SAFETY: the membership check proves `type` is one of the union's values.
  return TREE_ENTRY_TYPES.has(type as ApiTreeEntry['type'])
    ? (type as ApiTreeEntry['type'])
    : 'file';
}

// The tree panel's display order — dirs first, each group name-sorted.
// Shared with the Artifacts adapter (repo-browser-artifacts.ts).
export function sortTreeEntries(entries: ApiTreeEntry[]): void {
  entries.sort(
    (a, b) =>
      (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name),
  );
}

// Base64 → UTF-8 text; null means the bytes are not valid UTF-8 and the
// caller should render the file as binary. Shared with the Artifacts adapter.
export function decodeBase64Text(b64: string): string | null {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

// One directory level, lazily fetched per expansion to keep installation-token
// rate-limit usage sane.
export async function readTree(
  token: string,
  repo: RepositoryRow,
  ref: string,
  path: string,
): Promise<ApiRepoTree> {
  // Conditional request: re-expanding a directory (or the tree's auto-reveal
  // on a deep link) usually hits an unchanged listing — GitHub's 304 costs
  // no rate-limit credit and no body.
  const data = await githubJsonCached<GithubContentsEntry[] | GithubContentsEntry>(
    token,
    `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (!Array.isArray(data)) throw new RepoBrowserError('path is a file, not a directory', 400);
  const entries: ApiTreeEntry[] = data.map((entry) => {
    const type = entryType(entry.type);
    return {
      name: entry.name,
      path: entry.path,
      type,
      size: type === 'dir' ? null : entry.size,
      sha: entry.sha,
    };
  });
  sortTreeEntries(entries);
  return { path, entries };
}

// Cap for the git/blobs fallback on too_large previewable files: past this,
// showing the notice beats shipping tens of MB of base64 to the client.
const PREVIEW_FALLBACK_MAX_BYTES = 10 * 1024 * 1024;

// The contents API rejects 1–100 MB blobs with too_large, so a large PNG
// screenshot would get a notice instead of a preview. For previewable types
// under the cap, recover the bytes via the git/blobs API — the parent
// directory listing supplies the blob sha and size.
async function readPreviewFallback(
  token: string,
  repo: RepositoryRow,
  ref: string,
  path: string,
): Promise<ApiRepoFile | null> {
  if (!binaryPreviewKind(path)) return null;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const listing = await githubJson<GithubContentsEntry[] | GithubContentsEntry>(
    token,
    `/repos/${repo.owner}/${repo.name}/contents/${encodePath(dir)}?ref=${encodeURIComponent(ref)}`,
  );
  if (!Array.isArray(listing)) return null;
  const entry = listing.find((item) => item.path === path);
  if (!entry || entry.size > PREVIEW_FALLBACK_MAX_BYTES) return null;
  const blob = await githubJson<{ content?: string; encoding?: string }>(
    token,
    `/repos/${repo.owner}/${repo.name}/git/blobs/${entry.sha}`,
  );
  if (!isString(blob.content) || blob.encoding !== 'base64') return null;
  return {
    path,
    ref,
    sha: entry.sha,
    size: entry.size,
    text: null,
    binary: true,
    too_large: false,
    content_base64: blob.content.replace(/\s+/g, ''),
  };
}

export async function readFile(
  token: string,
  repo: RepositoryRow,
  ref: string,
  path: string,
): Promise<ApiRepoFile> {
  let data: GithubContentsEntry[] | (GithubContentsEntry & { content?: string; encoding?: string });
  try {
    data = await githubJson(
      token,
      `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
  } catch (err) {
    // GitHub's documented error code for 1–100 MB blobs, embedded in the
    // thrown message by githubRequest. Previewable types get a git/blobs
    // fallback under the cap; everything else shows a notice.
    if (err instanceof Error && err.message.includes('too_large')) {
      const fallback = await readPreviewFallback(token, repo, ref, path).catch(() => null);
      if (fallback) return fallback;
      return {
        path,
        ref,
        sha: '',
        size: 0,
        text: null,
        binary: false,
        too_large: true,
        content_base64: null,
      };
    }
    throw err;
  }
  if (Array.isArray(data)) throw new RepoBrowserError('path is a directory, not a file', 400);
  const file: ApiRepoFile = {
    path,
    ref,
    sha: data.sha,
    size: data.size,
    text: null,
    binary: false,
    too_large: false,
    content_base64: null,
  };
  // Symlinks/submodules (and any response without base64 content) have no
  // text to show — render as binary rather than erroring.
  if (!isString(data.content) || data.encoding !== 'base64') {
    file.binary = true;
    return file;
  }
  // Previewable types ship their bytes regardless of UTF-8 validity — a
  // small uncompressed PDF can be pure ASCII and still needs a preview.
  // GitHub's contents API base64 contains newlines; strip them so the
  // client can atob directly.
  if (binaryPreviewKind(path)) {
    file.content_base64 = data.content.replace(/\s+/g, '');
  }
  const text = decodeBase64Text(data.content);
  if (text === null) file.binary = true;
  else file.text = text;
  return file;
}

export interface SaveFileInput {
  path: string;
  ref: string;
  base_sha: string | null;
  content: string;
  message: string;
  mode: 'commit' | 'pr';
  // The session user, so the commit is attributed to the person rather than
  // just the App bot.
  author: { name: string; email: string };
}

// btoa breaks on non-Latin1 input, so encode to UTF-8 bytes first and build
// the binary string in chunks (String.fromCharCode has an argument limit).
function base64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function saveFile(
  writeToken: string,
  repo: RepositoryRow,
  input: SaveFileInput,
): Promise<ApiFileSave> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  let branch = input.ref;
  if (input.mode === 'pr') {
    const slug = input.path
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    branch = `turbodiff/edit-${slug.slice(0, 40)}-${Date.now().toString(36)}`;
    const baseRef = await githubJson<{ object: { sha: string } }>(
      writeToken,
      `${base}/git/ref/heads/${encodeURIComponent(input.ref)}`,
    );
    await githubJson(writeToken, `${base}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
    });
  }
  const put = await githubJson<{ content: { sha: string }; commit: { sha: string } }>(
    writeToken,
    `${base}/contents/${encodePath(input.path)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        message: input.message,
        content: base64EncodeUtf8(input.content),
        branch,
        sha: input.base_sha ?? undefined,
        committer: input.author,
        author: input.author,
      }),
    },
  );
  let pr: ApiFileSave['pr'] = null;
  if (input.mode === 'pr') {
    const created = await githubJson<{ number: number; html_url: string }>(
      writeToken,
      `${base}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({ title: input.message, head: branch, base: input.ref }),
      },
    );
    pr = { number: created.number, url: created.html_url };
  }
  return { ok: true, content_sha: put.content.sha, commit_sha: put.commit.sha, branch, pr };
}
