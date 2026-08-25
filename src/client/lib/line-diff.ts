// Line-level diff (Myers) for the save dialog's change preview. Pure and
// DOM-free so it runs under the plugin-free vitest config.

export type DiffOp = { kind: 'same' | 'del' | 'add'; text: string };

export type DiffHunk = {
  // 1-based starting line numbers on each side, for the hunk header.
  oldStart: number;
  newStart: number;
  ops: DiffOp[];
};

// Guard: beyond this many lines per side the preview degrades to a summary
// (the O((N+M)·D) walk below is fine for real edits, not for megafiles).
export const DIFF_PREVIEW_MAX_LINES = 5000;

function splitLines(text: string): string[] {
  // A trailing newline shouldn't manufacture a phantom empty last line.
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

// Myers shortest-edit-script on lines, with common prefix/suffix trimmed
// first so a focused edit in a large file stays cheap.
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const head: DiffOp[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffOp[] = a.slice(endA).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  return [...head, ...myers(midA, midB), ...tail];
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: 'add', text }));
  if (m === 0) return a.map((text) => ({ kind: 'del', text }));

  const max = n + m;
  const offset = max;
  // v[k+offset] = furthest x on diagonal k; trace keeps a snapshot per d for
  // backtracking.
  const v = new Array<number>(2 * max + 1).fill(0);
  const trace: number[][] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)
          ? v[k + 1 + offset]!
          : v[k - 1 + offset]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Backtrack from (n, m) through the d-snapshots to recover the script.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && prev[k - 1 + offset]! < prev[k + 1 + offset]!) ? k + 1 : k - 1;
    const prevX = prev[prevK + offset]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: 'same', text: a[x]! });
    }
    if (x === prevX) {
      y--;
      ops.push({ kind: 'add', text: b[y]! });
    } else {
      x--;
      ops.push({ kind: 'del', text: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: 'same', text: a[x]! });
  }
  while (x > 0) {
    x--;
    ops.push({ kind: 'del', text: a[x]! });
  }
  while (y > 0) {
    y--;
    ops.push({ kind: 'add', text: b[y]! });
  }
  return ops.reverse();
}

export function diffStats(ops: DiffOp[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === 'add') additions++;
    else if (op.kind === 'del') deletions++;
  }
  return { additions, deletions };
}

// Group a full op list into display hunks: changed runs with `context`
// unchanged lines either side; distant unchanged stretches collapse away.
export function toHunks(ops: DiffOp[], context = 2): DiffHunk[] {
  // Mark which indices survive: every change plus `context` neighbours.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== 'same') {
      for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) {
        keep[j] = true;
      }
    }
  }

  const hunks: DiffHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: DiffHunk | null = null;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (keep[i]) {
      current ??= { oldStart: oldLine, newStart: newLine, ops: [] };
      current.ops.push(op);
    } else if (current) {
      hunks.push(current);
      current = null;
    }
    if (op.kind !== 'add') oldLine++;
    if (op.kind !== 'del') newLine++;
  }
  if (current) hunks.push(current);
  return hunks;
}
