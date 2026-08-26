import type { ApiTreeEntry } from '../shared/api-types.ts';

// Parser for `git ls-tree -l -z` output: NUL-separated records, each
// `mode SP type SP sha SP+ size TAB name`, names unquoted (that's the point
// of -z — spaces and quotes in filenames arrive verbatim). Kept pure and
// dependency-free so the parsing has unit coverage; the sandbox round trip
// it sits behind is only exercised in deployment smoke.
export function parseLsTreeZ(out: string, path: string): ApiTreeEntry[] {
  const entries: ApiTreeEntry[] = [];
  for (const record of out.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const name = record.slice(tab + 1);
    const [mode = '', objectType = '', sha = '', size = ''] = record.slice(0, tab).split(/\s+/);
    const type: ApiTreeEntry['type'] =
      objectType === 'tree'
        ? 'dir'
        : objectType === 'commit'
          ? 'submodule'
          : mode === '120000'
            ? 'symlink'
            : 'file';
    entries.push({
      name,
      path: path ? `${path}/${name}` : name,
      type,
      size: size === '-' ? null : Number(size),
      sha,
    });
  }
  return entries;
}
