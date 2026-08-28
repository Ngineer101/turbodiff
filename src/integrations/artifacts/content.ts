import { env } from 'cloudflare:workers';
import type { RepositoryRow } from '../../data/db.ts';
import type { ApiRepoTree, ApiTreeEntry } from '../../shared/api-types.ts';
import { isJsonObject, isNumber, isString, type JsonValue } from '../../shared/json.ts';

// Cloudflare's live Artifacts binding documentation includes these content
// methods, but Wrangler 4.120's generated declarations lag that surface. Keep
// the temporary augmentation narrow and validate every returned value at the
// RPC boundary. Once Wrangler generates them, declaration merging becomes a
// no-op and this block can be removed.
declare global {
  interface ArtifactsRepo {
    log(options?: { ref?: string; limit?: number; offset?: number }): Promise<JsonValue>;
    readCommit(hash: string): Promise<JsonValue>;
    readTree(hash: string): Promise<JsonValue>;
  }
}

interface ContentEntry {
  name: string;
  sha: string;
  type: ApiTreeEntry['type'];
  size: number | null;
}

function stringField(value: JsonValue | undefined, ...keys: string[]): string | null {
  if (!isJsonObject(value)) return null;
  for (const key of keys) {
    if (isString(value[key]) && value[key]) return value[key];
  }
  return null;
}

function nestedHash(value: JsonValue, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const nested = value[key];
  return stringField(nested, 'hash', 'sha', 'id') ?? (isString(nested) ? nested : null);
}

function commitHash(log: JsonValue): string | null {
  const rows = Array.isArray(log)
    ? log
    : isJsonObject(log) && Array.isArray(log.commits)
      ? log.commits
      : isJsonObject(log) && Array.isArray(log.entries)
        ? log.entries
        : [];
  return stringField(rows[0], 'hash', 'sha', 'id', 'oid');
}

function commitTreeHash(commit: JsonValue): string | null {
  return nestedHash(commit, 'tree') ?? stringField(commit, 'treeHash', 'tree_hash');
}

function contentEntries(tree: JsonValue): ContentEntry[] | null {
  const rows = Array.isArray(tree)
    ? tree
    : isJsonObject(tree) && Array.isArray(tree.entries)
      ? tree.entries
      : isJsonObject(tree) && Array.isArray(tree.tree)
        ? tree.tree
        : null;
  if (!rows) return null;
  const entries: ContentEntry[] = [];
  for (const row of rows) {
    if (!isJsonObject(row)) return null;
    const name = stringField(row, 'name', 'path');
    const sha = stringField(row, 'hash', 'sha', 'id', 'oid');
    const rawType = stringField(row, 'type', 'kind') ?? '';
    if (!name || !sha) return null;
    const type: ApiTreeEntry['type'] =
      rawType === 'tree' || rawType === 'dir'
        ? 'dir'
        : rawType === 'commit' || rawType === 'submodule'
          ? 'submodule'
          : rawType === 'symlink'
            ? 'symlink'
            : 'file';
    const rawSize = row.size;
    entries.push({
      name: name.split('/').at(-1) ?? name,
      sha,
      type,
      size: type === 'dir' ? null : isNumber(rawSize) ? rawSize : null,
    });
  }
  return entries;
}

/**
 * Reads one directory through the Artifacts binding. Null means the deployed
 * binding has not caught up to the documented content surface or returned an
 * unrecognized beta shape; callers transparently use the git-mirror fallback.
 */
export async function readArtifactsTreeDirect(
  repo: RepositoryRow,
  ref: string,
  path: string,
  knownHeadSha?: string,
): Promise<ApiRepoTree | null> {
  if (!repo.artifacts_repo) return null;
  try {
    const handle = await env.GIT_ARTIFACTS.get(repo.artifacts_repo);
    const head = knownHeadSha ?? commitHash(await handle.log({ ref, limit: 1, offset: 0 }));
    if (!head) return null;
    let treeHash = commitTreeHash(await handle.readCommit(head));
    if (!treeHash) return null;

    for (const segment of path.split('/').filter(Boolean)) {
      const children = contentEntries(await handle.readTree(treeHash));
      const child = children?.find((entry) => entry.name === segment && entry.type === 'dir');
      if (!child) return null;
      treeHash = child.sha;
    }

    const children = contentEntries(await handle.readTree(treeHash));
    if (!children) return null;
    const entries = children.map<ApiTreeEntry>((entry) => ({
      name: entry.name,
      path: path ? `${path}/${entry.name}` : entry.name,
      type: entry.type,
      size: entry.size,
      sha: entry.sha,
    }));
    entries.sort(
      (a, b) =>
        (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name),
    );
    return { path, entries };
  } catch (err) {
    console.warn(
      JSON.stringify({
        message: 'artifacts binding content read fell back to sandbox mirror',
        repo: repo.artifacts_repo,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}
