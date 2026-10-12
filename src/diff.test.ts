import { describe, it, expect } from 'vitest';
import { buildRows, visibleRows, placement, expandGap, changeHunks, fileLineStats } from './diff';
import type { Anchor, ChangedFile } from './types';
describe('diff', () => {
  it('preserves line positions for additions and removals', () => {
    const rows = buildRows('a\nb\n', 'a\nc\nd\n');
    expect(rows[0].kind).toBe('equal');
    expect(rows[1].left?.line).toBe(2);
    expect(rows[1].right?.text).toBe('c');
    expect(rows[2].right?.line).toBe(3);
  });
  it('handles empty files and missing newline', () => {
    expect(buildRows('', '')).toEqual([]);
    expect(buildRows('', 'x')[0].right?.text).toBe('x');
    expect(buildRows('x', '')[0].left?.line).toBe(1);
  });
  it('folds unchanged context', () => {
    const text = Array.from({ length: 100 }, (_, i) => String(i)).join('\n');
    const rows = buildRows(text, text.replace('50\n', 'changed\n'));
    expect(visibleRows(rows, true).some((r) => r.gap)).toBe(true);
  });
  it('reveals each gap from either end without changing source line numbers', () => {
    const before = Array.from({ length: 120 }, (_, i) => String(i)).join('\n');
    const rows = buildRows(
      before,
      before.replace('10\n', 'changed-10\n').replace('100\n', 'changed-100\n'),
    );
    const initial = visibleRows(rows, true);
    const gap = initial.find((row) => (row.gap ?? 0) > 50)!;
    const top = expandGap([], gap, 'top');
    expect(top).toEqual([{ start: gap.sourceIndex, end: gap.sourceIndex! + 10 }]);
    const afterTop = visibleRows(rows, true, top);
    expect(afterTop.find((row) => row.sourceIndex === gap.sourceIndex)?.left?.line).toBe(
      gap.sourceIndex! + 1,
    );
    const remainder = afterTop.find((row) => row.sourceIndex === gap.sourceIndex! + 10)!;
    expect(remainder.gap).toBe(gap.gap! - 10);
    const both = expandGap(top, remainder, 'bottom');
    const afterBoth = visibleRows(rows, true, both);
    const middle = afterBoth.find((row) => row.gap && row.sourceIndex === remainder.sourceIndex)!;
    expect(middle.gap).toBe(gap.gap! - 20);
    const all = visibleRows(rows, true, expandGap(both, middle, 'all'));
    expect(
      all
        .filter((row) => row.sourceIndex! >= gap.sourceIndex! && row.sourceIndex! < gap.gapEnd!)
        .some((row) => row.gap),
    ).toBe(false);
    expect(all.find((row) => row.sourceIndex === gap.gapEnd! - 1)?.left?.line).toBe(gap.gapEnd);
  });
  it('clamps short gaps and keeps unrelated gaps collapsed', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      kind: i === 5 || i === 80 ? ('change' as const) : ('equal' as const),
      left: { line: i + 1, text: String(i) },
      right: { line: i + 1, text: String(i) },
    }));
    const initial = visibleRows(rows, true);
    const gap = initial[0];
    expect(gap.gap).toBe(2);
    const expanded = visibleRows(rows, true, expandGap([], gap, 'bottom'));
    expect(expanded[0].left?.line).toBe(1);
    expect(expanded[1].left?.line).toBe(2);
    expect(expanded.filter((row) => row.gap)).toHaveLength(2);
  });
  it('groups adjacent changed rows into hunks rather than navigating each line', () => {
    const rows = buildRows('a\nb\nc\nd\ne\nf\n', 'A\nB\nc\nd\nE\nf\n');
    expect(changeHunks(rows)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 5 },
    ]);
    expect(changeHunks(buildRows('same', 'same'))).toEqual([]);
  });
  it('counts additions/deletions including new files and missing final newline', () => {
    const file = (left: string | null, right: string | null): ChangedFile => ({
      path: 'x',
      oldPath: 'x',
      status: 'M',
      left: left === null ? null : { kind: 'text', text: left, size: left.length },
      right: right === null ? null : { kind: 'text', text: right, size: right.length },
    });
    expect(fileLineStats(file('a\nb\n', 'a\nc\nd'))).toEqual({ added: 2, deleted: 1 });
    expect(fileLineStats(file(null, 'a\nb'))).toEqual({ added: 2, deleted: 0 });
    expect(fileLineStats(file('a\n', null))).toEqual({ added: 0, deleted: 1 });
    expect(fileLineStats(file('same', 'same'))).toEqual({ added: 0, deleted: 0 });
    expect(fileLineStats({ ...file(null, ''), right: { kind: 'binary', size: 20 } })).toBeNull();
  });
  it('does not attach ambiguous context', () => {
    const anchor = {
      path: 'x',
      side: 'right',
      comparisonId: 'old',
      startLine: 1,
      endLine: 1,
      selectedText: 'a',
      context: 'a',
      contentHash: 'old',
    } as Anchor;
    const file = {
      path: 'x',
      oldPath: 'x',
      right: { kind: 'text', text: 'a\na', hash: 'new' },
    } as ChangedFile;
    expect(placement(anchor, file, 'new')).toBeNull();
  });
  it('maps unique complete context without mutating the anchor', () => {
    const a = {
      path: 'x',
      side: 'right',
      comparisonId: 'old',
      startLine: 2,
      endLine: 2,
      selectedText: 'b',
      context: 'a\nb\nc',
    } as Anchor;
    const f = {
      path: 'x',
      oldPath: 'x',
      right: { kind: 'text', text: 'new\na\nb\nc' },
    } as ChangedFile;
    expect(placement(a, f, 'new')).toEqual({ start: 3, end: 3, original: false });
    expect(a.startLine).toBe(2);
  });
  it('scales row calculation to 100000 lines', () => {
    const text = 'unchanged\n'.repeat(100000);
    const start = performance.now();
    const rows = buildRows(text, text + 'added\n');
    expect(rows).toHaveLength(100001);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
