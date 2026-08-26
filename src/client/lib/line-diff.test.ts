import { describe, expect, it } from 'vite-plus/test';
import { diffLines, diffStats, toHunks, type DiffOp } from './line-diff.ts';

function render(ops: DiffOp[]): string[] {
  return ops.map((op) => `${op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '}${op.text}`);
}

describe('diffLines', () => {
  it('reports identical texts as all-same', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(ops.every((op) => op.kind === 'same')).toBe(true);
    expect(ops).toHaveLength(3);
  });

  it('finds a single-line change', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    expect(render(ops)).toEqual([' a', '-b', '+B', ' c']);
  });

  it('handles pure insertion and pure deletion', () => {
    expect(render(diffLines('', 'x\ny\n'))).toEqual(['+x', '+y']);
    expect(render(diffLines('x\ny\n', ''))).toEqual(['-x', '-y']);
  });

  it('does not manufacture a phantom line from the trailing newline', () => {
    expect(diffLines('a\n', 'a\n')).toEqual([{ kind: 'same', text: 'a' }]);
  });

  it('finds separated edits in one pass', () => {
    const ops = diffLines('one\ntwo\nthree\nfour\nfive\n', 'one\n2\nthree\nfour\n5\nsix\n');
    expect(render(ops)).toEqual([' one', '-two', '+2', ' three', ' four', '-five', '+5', '+six']);
  });

  it('round-trips: applying the script reproduces both sides', () => {
    const oldText = 'a\nb\nc\nd\ne\n';
    const newText = 'a\nc\nX\nd\ne\nf\n';
    const ops = diffLines(oldText, newText);
    const left = ops.filter((op) => op.kind !== 'add').map((op) => op.text);
    const right = ops.filter((op) => op.kind !== 'del').map((op) => op.text);
    expect(left.join('\n')).toBe('a\nb\nc\nd\ne');
    expect(right.join('\n')).toBe('a\nc\nX\nd\ne\nf');
  });
});

describe('diffStats', () => {
  it('counts additions and deletions only', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(diffStats(ops)).toEqual({ additions: 2, deletions: 1 });
  });
});

describe('toHunks', () => {
  it('collapses distant unchanged stretches into separate hunks', () => {
    const oldText = ['start', ...Array.from({ length: 20 }, (_, i) => `mid${i}`), 'end'].join('\n');
    const newText = ['START', ...Array.from({ length: 20 }, (_, i) => `mid${i}`), 'END'].join('\n');
    const hunks = toHunks(diffLines(oldText, newText), 2);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.oldStart).toBe(1);
    expect(hunks[0]?.ops.filter((op) => op.kind === 'same')).toHaveLength(2);
    expect(hunks[1]?.oldStart).toBe(20);
    expect(hunks[1]?.newStart).toBe(20);
  });

  it('returns no hunks for an unchanged file', () => {
    expect(toHunks(diffLines('a\nb\n', 'a\nb\n'))).toEqual([]);
  });

  it('keeps context lines around a change', () => {
    const ops = diffLines('a\nb\nc\nd\ne\n', 'a\nb\nC\nd\ne\n');
    const hunks = toHunks(ops, 1);
    expect(hunks).toHaveLength(1);
    expect(render(hunks[0]!.ops)).toEqual([' b', '-c', '+C', ' d']);
    expect(hunks[0]?.oldStart).toBe(2);
  });
});
