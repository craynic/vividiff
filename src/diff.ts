import { diffLines } from 'diff';
import type { Anchor, ChangedFile, DiffRow, RowRange, LineStats } from './types';
export function buildRows(left: string, right: string): DiffRow[] {
  const changes = diffLines(left, right, { timeout: 2000, maxEditLength: 20000 });
  if (!changes) throw new Error('DIFF_TIMEOUT');
  const rows: DiffRow[] = [];
  let l = 1,
    r = 1;
  const lines = (s: string) => {
    const a = s.split('\n');
    if (a.at(-1) === '') a.pop();
    return a;
  };
  for (let i = 0; i < changes.length; i++) {
    const part = changes[i],
      values = lines(part.value);
    if (!part.added && !part.removed) {
      for (const text of values)
        rows.push({ kind: 'equal', left: { line: l++, text }, right: { line: r++, text } });
    } else if (part.removed) {
      const next = changes[i + 1];
      const added = next?.added ? lines(next.value) : [];
      if (next?.added) i++;
      for (let j = 0; j < Math.max(values.length, added.length); j++)
        rows.push({
          kind: 'change',
          left: j < values.length ? { line: l++, text: values[j] } : undefined,
          right: j < added.length ? { line: r++, text: added[j] } : undefined,
        });
    } else {
      for (const text of values) rows.push({ kind: 'change', right: { line: r++, text } });
    }
  }
  return rows;
}
export function changeHunks(rows: DiffRow[]): RowRange[] {
  const hunks: RowRange[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== 'change') return;
    const last = hunks.at(-1);
    if (last?.end === index) last.end = index + 1;
    else hunks.push({ start: index, end: index + 1 });
  });
  return hunks;
}
export function visibleRows(
  rows: DiffRow[],
  collapse: boolean,
  revealed: RowRange[] = [],
): DiffRow[] {
  const indexed = rows.map((row, sourceIndex) => ({ ...row, sourceIndex }));
  if (!collapse || rows.length < 30) return indexed;
  const keep = new Uint8Array(rows.length);
  for (const hunk of changeHunks(rows))
    keep.fill(1, Math.max(0, hunk.start - 3), Math.min(rows.length, hunk.end + 3));
  for (const range of revealed)
    keep.fill(1, Math.max(0, range.start), Math.min(rows.length, range.end));
  if (!keep.some(Boolean)) return indexed;
  const out: DiffRow[] = [];
  for (let index = 0; index < rows.length;) {
    if (keep[index]) out.push(indexed[index++]);
    else {
      const start = index;
      while (index < rows.length && !keep[index]) index++;
      out.push({ kind: 'equal', sourceIndex: start, gap: index - start, gapEnd: index });
    }
  }
  return out;
}
/** Reveal the first/last ten of the *currently hidden* rows, or the whole gap. */
export function expandGap(
  revealed: RowRange[],
  gap: DiffRow,
  direction: 'top' | 'bottom' | 'all',
): RowRange[] {
  if (!gap.gap || gap.sourceIndex === undefined || gap.gapEnd === undefined) return revealed;
  const start =
    direction === 'bottom' ? Math.max(gap.sourceIndex, gap.gapEnd - 10) : gap.sourceIndex;
  const end = direction === 'top' ? Math.min(gap.gapEnd, gap.sourceIndex + 10) : gap.gapEnd;
  const ranges = [...revealed, { start, end }].sort((a, b) => a.start - b.start);
  const merged: RowRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
export function fileLineStats(file: ChangedFile): LineStats | null {
  if ([file.left, file.right].some((content) => content && content.kind !== 'text')) return null;
  const changes = diffLines(file.left?.text ?? '', file.right?.text ?? '', {
    timeout: 200,
    maxEditLength: 20000,
  });
  if (!changes) return null;
  return changes.reduce(
    (stats, part) => ({
      added: stats.added + (part.added ? (part.count ?? 0) : 0),
      deleted: stats.deleted + (part.removed ? (part.count ?? 0) : 0),
    }),
    { added: 0, deleted: 0 },
  );
}
export function placement(
  anchor: Anchor,
  file: ChangedFile,
  comparisonId: string,
): { start?: number; end?: number; original: boolean } | null {
  if (anchor.comparisonId === comparisonId && anchor.path === file.path)
    return { start: anchor.startLine, end: anchor.endLine, original: true };
  if (anchor.path !== file.path && anchor.path !== file.oldPath) return null;
  if (anchor.side === 'file') return null; // File comments retain explicit original ownership.
  const content = file[anchor.side];
  if (content?.kind !== 'text') return null;
  if (content.hash && content.hash === anchor.contentHash)
    return { start: anchor.startLine, end: anchor.endLine, original: false };
  if (!anchor.context || !anchor.selectedText?.trim()) return null;
  const lines = content.text!.split('\n'),
    context = anchor.context.split('\n');
  const matches: number[] = [];
  for (let i = 0; i <= lines.length - context.length; i++)
    if (context.every((line, j) => lines[i + j] === line)) matches.push(i);
  if (matches.length !== 1) return null;
  const start = matches[0] + Math.min(3, (anchor.startLine ?? 1) - 1) + 1;
  return { start, end: start + (anchor.endLine ?? 1) - (anchor.startLine ?? 1), original: false };
}
