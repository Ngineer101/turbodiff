import { describe, expect, it } from 'vite-plus/test';
import { parseLsTreeZ } from './ls-tree.ts';

// Real `git ls-tree -l -z` shape: `mode SP type SP sha SP+ size TAB name`,
// records NUL-terminated. Sizes are right-aligned by git, hence the runs of
// spaces before them. NUL rides as a named constant — a NUL escape inside a
// template literal is a syntax error when a digit follows it.
const NUL = String.fromCharCode(0);
const SHA_A = 'a0373c127e472633630c8da9f9440ae5bb4c9127';
const SHA_B = '5322d7feeaeae76b7cb1abac69cfbb2992b11e76';
const SHA_TREE = 'ca7fbed7d08676e31c1e0999ce324bd40f04b981';

const ROOT_LISTING =
  `100644 blob ${SHA_A}     144\t.cta.json${NUL}` +
  `100644 blob ${SHA_B}      42\t.gitignore${NUL}` +
  `040000 tree ${SHA_TREE}       -\tsrc${NUL}`;

describe('parseLsTreeZ', () => {
  it('parses NUL-separated records into entries', () => {
    const entries = parseLsTreeZ(ROOT_LISTING, '');
    expect(entries).toEqual([
      { name: '.cta.json', path: '.cta.json', type: 'file', size: 144, sha: SHA_A },
      { name: '.gitignore', path: '.gitignore', type: 'file', size: 42, sha: SHA_B },
      { name: 'src', path: 'src', type: 'dir', size: null, sha: SHA_TREE },
    ]);
  });

  it('prefixes the parent path onto entry paths', () => {
    const entries = parseLsTreeZ(`100644 blob ${SHA_A}      10\tindex.ts${NUL}`, 'src/http');
    expect(entries[0]?.path).toBe('src/http/index.ts');
  });

  it('keeps spaces in filenames intact (the point of -z)', () => {
    const entries = parseLsTreeZ(`100644 blob ${SHA_A}       9\tmy notes.md${NUL}`, '');
    expect(entries[0]?.name).toBe('my notes.md');
  });

  it('classifies symlinks and submodules', () => {
    const entries = parseLsTreeZ(
      `120000 blob ${SHA_A}      11\tlink${NUL}160000 commit ${SHA_B}       -\tvendored${NUL}`,
      '',
    );
    expect(entries.map((entry) => entry.type)).toEqual(['symlink', 'submodule']);
  });

  it('returns nothing for an empty tree and ignores a trailing empty record', () => {
    expect(parseLsTreeZ('', '')).toEqual([]);
  });

  it('regression: a listing with its NULs stripped must not parse as one giant entry', () => {
    // The bug this file exists for: sandbox exec stdout drops NUL bytes, so
    // the un-encoded listing collapsed into a single record whose "name" was
    // the rest of the whole listing. The caller now base64-ships the bytes so
    // parseLsTreeZ never sees stripped input — but if it ever does, the
    // damage shows up as one entry, which this test documents.
    const stripped = ROOT_LISTING.replaceAll(NUL, '');
    const entries = parseLsTreeZ(stripped, '');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name.startsWith('.cta.json100644 blob')).toBe(true);
    // And the intact input parses to the real three entries (asserted above).
    expect(parseLsTreeZ(ROOT_LISTING, '')).toHaveLength(3);
  });
});
