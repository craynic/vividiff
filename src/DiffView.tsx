import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { changeHunks, expandGap, visibleRows, placement } from './diff';
import type { Assets, ChangedFile, DiffRow, Draft, Comment, RowRange } from './types';

const LINE_HEIGHT = 24;
const GAP_HEIGHT = 88;
export function DiffView({
  file,
  comparisonId,
  assets,
  theme,
  view,
  collapse,
  onSelect,
  selected,
  comments,
}: {
  file: ChangedFile;
  comparisonId: string;
  assets: Assets;
  theme: string;
  view: string;
  collapse: boolean;
  onSelect: (draft: Draft) => void;
  selected: Draft | null;
  comments: Comment[];
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<DiffRow[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [warning, setWarning] = useState('');
  const [revealed, setRevealed] = useState<RowRange[]>([]);
  const [activeStart, setActiveStart] = useState<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null),
    rightScroll = useRef<HTMLDivElement>(null);
  const [paneWidths, setPaneWidths] = useState({ left: 300, right: 300 });
  const pendingJump = useRef<number | null>(null);
  const split = view === 'split';

  useEffect(() => {
    setRevealed([]);
    setActiveStart(null);
    pendingJump.current = null;
    for (const element of [scroll.current, rightScroll.current])
      if (element) element.scrollTo(0, 0);
  }, [file, comparisonId]);
  useEffect(() => {
    setBusy(true);
    setError('');
    setWarning('');
    setRows([]);
    const worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => {
      worker.terminate();
      setBusy(false);
      setError('diffTimeout');
    }, 12000);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      setBusy(false);
      if (event.data.error) setError('diffTimeout');
      else {
        setRows(event.data.rows);
        setWarning(event.data.warning ?? '');
      }
    };
    worker.onerror = () => {
      clearTimeout(timeout);
      setBusy(false);
      setError('error');
    };
    worker.postMessage({
      left: file.left?.kind === 'text' ? (file.left.text ?? '') : '',
      right: file.right?.kind === 'text' ? (file.right.text ?? '') : '',
      path: file.path,
      assets,
      theme,
    });
    return () => {
      worker.terminate();
      clearTimeout(timeout);
    };
  }, [file, comparisonId, assets, theme]);

  const hunks = useMemo(() => changeHunks(rows), [rows]);
  const activeIndex = hunks.findIndex((hunk) => hunk.start === activeStart);
  const activeHunk = hunks[activeIndex];
  const visible = useMemo(() => {
    const filtered = visibleRows(rows, collapse, revealed);
    return split
      ? filtered
      : filtered.flatMap((row) =>
          row.kind === 'change' && row.left && row.right
            ? [
                { ...row, right: undefined },
                { ...row, left: undefined },
              ]
            : [row],
        );
  }, [rows, collapse, revealed, split]);
  const markers = useMemo(
    () =>
      comments
        .map((comment) => ({ comment, position: placement(comment.anchor, file, comparisonId) }))
        .filter((marker) => marker.position && marker.comment.status === 'open'),
    [comments, file, comparisonId],
  );
  const codeWidths = useMemo(() => {
    const widths = { left: 0, right: 0 };
    for (const row of rows)
      for (const side of ['left', 'right'] as const) {
        const text = row[side]?.text ?? '';
        // Canvas width affects only the corresponding pane's horizontal scrollbar, never its layout width.
        widths[side] = Math.max(
          widths[side],
          (text.length + (text.match(/\t/g)?.length ?? 0) * 3) * 8 + 80,
        );
      }
    return widths;
  }, [rows]);
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => (visible[index].gap ? GAP_HEIGHT : LINE_HEIGHT),
    getItemKey: (index) => {
      const row = visible[index];
      return row.gap
        ? `gap-${row.sourceIndex}-${row.gapEnd}`
        : `${row.sourceIndex}-${row.left?.line ?? ''}-${row.right?.line ?? ''}`;
    },
    overscan: 12,
  });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() =>
      setPaneWidths({
        left: scroll.current?.clientWidth ?? 300,
        right: rightScroll.current?.clientWidth ?? 300,
      }),
    );
    if (scroll.current) observer.observe(scroll.current);
    if (rightScroll.current) observer.observe(rightScroll.current);
    return () => observer.disconnect();
  }, [split]);
  useLayoutEffect(() => {
    virtual.measure();
    if (pendingJump.current !== null) {
      const index = visible.findIndex((row) => row.sourceIndex === pendingJump.current && !row.gap);
      if (index >= 0) {
        virtual.scrollToIndex(index, { align: 'start' });
        pendingJump.current = null;
      }
    }
    if (scroll.current && rightScroll.current)
      rightScroll.current.scrollTop = scroll.current.scrollTop;
  }, [visible, virtual]);
  useLayoutEffect(() => {
    if (activeStart === null) return;
    const index = visible.findIndex(
      (row) => row.sourceIndex === activeStart && row.kind === 'change',
    );
    if (index >= 0) virtual.scrollToIndex(index, { align: 'center' });
    // A selected hunk remains the navigation target when switching split/unified modes.
  }, [activeStart, split, virtual]);

  const go = (step: number) => {
    if (!hunks.length) return;
    const next =
      activeIndex < 0
        ? step < 0
          ? hunks.length - 1
          : 0
        : (activeIndex + step + hunks.length) % hunks.length;
    const target = hunks[next].start;
    setActiveStart(target);
    // Also scroll when wrapping a single-hunk file to the same state value.
    const index = visible.findIndex((row) => row.sourceIndex === target && row.kind === 'change');
    if (index >= 0) virtual.scrollToIndex(index, { align: 'center' });
  };
  const expand = (row: DiffRow, direction: 'top' | 'bottom' | 'all') => {
    pendingJump.current =
      direction === 'bottom' ? Math.max(row.sourceIndex!, row.gapEnd! - 10) : row.sourceIndex!;
    setRevealed((current) => expandGap(current, row, direction));
  };
  const choose = (side: 'left' | 'right', line: number, shift: boolean) => {
    const extend =
      shift &&
      selected?.comparisonId === comparisonId &&
      selected.path === file.path &&
      selected.side === side;
    const start = extend ? (selected.startLine ?? line) : line;
    onSelect({
      comparisonId,
      path: file.path,
      side,
      startLine: Math.min(start, line),
      endLine: Math.max(start, line),
      body: selected?.body ?? '',
    });
  };
  const cell = (row: DiffRow, side: 'left' | 'right') => {
    const value = row[side];
    const isSelected =
      value &&
      selected?.path === file.path &&
      selected.comparisonId === comparisonId &&
      selected.side === side &&
      value.line >= (selected.startLine ?? 0) &&
      value.line <= (selected.endLine ?? 0);
    const marked =
      value &&
      markers.some(
        (marker) =>
          marker.comment.anchor.side === side &&
          marker.position?.start !== undefined &&
          value.line >= marker.position.start &&
          value.line <= (marker.position.end ?? marker.position.start),
      );
    return (
      <div
        className={
          'code-cell ' +
          (row.kind === 'change' ? (side === 'left' ? 'removed' : 'added') : '') +
          (isSelected ? ' selected' : '')
        }
      >
        <button
          className={'line-number' + (marked ? ' annotated' : '')}
          title={marked ? t('comments') : undefined}
          disabled={!value}
          aria-label={t(side) + ' ' + (value?.line ?? '')}
          onClick={(event) => value && choose(side, value.line, event.shiftKey)}
        >
          {value?.line ?? ''}
        </button>
        <code>
          {value?.tokens
            ? value.tokens.map((token, index) => (
                <span key={index} style={{ color: token.color }}>
                  {token.content.replace(/\r$/, '')}
                </span>
              ))
            : value?.text.replace(/\r$/, '')}
        </code>
      </div>
    );
  };
  const pane = (side: 'left' | 'right') => (
    <div
      className={'diff-scroll diff-pane-' + (split ? side : 'unified')}
      ref={side === 'left' ? scroll : rightScroll}
      aria-label={t(split ? (side === 'left' ? 'beforePane' : 'afterPane') : 'unifiedPane')}
      onScroll={(event) => {
        const other = side === 'left' ? rightScroll.current : scroll.current;
        if (split && other && Math.abs(other.scrollTop - event.currentTarget.scrollTop) > 0.5)
          other.scrollTop = event.currentTarget.scrollTop;
      }}
    >
      <div
        className="diff-canvas"
        style={{
          height: virtual.getTotalSize(),
          width: split ? codeWidths[side] : Math.max(codeWidths.left, codeWidths.right),
          minWidth: '100%',
        }}
      >
        {virtual.getVirtualItems().map((item) => {
          const row = visible[item.index];
          const active =
            activeHunk &&
            row.sourceIndex !== undefined &&
            !row.gap &&
            row.sourceIndex >= activeHunk.start &&
            row.sourceIndex < activeHunk.end;
          return (
            <div
              key={item.key}
              data-source-index={row.sourceIndex}
              data-gap-end={row.gapEnd}
              className={'diff-row' + (active ? ' active-change' : '')}
              style={{ top: item.start, height: row.gap ? GAP_HEIGHT : LINE_HEIGHT }}
            >
              {row.gap ? (
                <div className="gap" style={{ width: paneWidths[side] }}>
                  <button className="gap-summary" onClick={() => expand(row, 'all')}>
                    {t('hiddenLines', { count: row.gap })}
                  </button>
                  <div className="gap-actions">
                    <button onClick={() => expand(row, 'top')}>{t('expandTop')}</button>
                    <button onClick={() => expand(row, 'bottom')}>{t('expandBottom')}</button>
                    <button onClick={() => expand(row, 'all')}>{t('expandAll')}</button>
                  </div>
                </div>
              ) : (
                cell(
                  row,
                  split ? side : row.kind === 'equal' ? 'right' : row.left ? 'left' : 'right',
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
  return (
    <section className="diff-area" aria-label={file.path}>
      <div className="diff-file-header">
        <strong title={file.path}>
          {file.oldPath !== file.path ? file.oldPath + ' → ' : ''}
          {file.path}
        </strong>
        <span className="change-position" aria-live="polite">
          {t('changePosition', { current: activeIndex + 1, total: hunks.length })}
        </span>
        <button disabled={busy || !hunks.length} onClick={() => go(-1)}>
          {t('previous')}
        </button>
        <button disabled={busy || !hunks.length} onClick={() => go(1)}>
          {t('next')}
        </button>
      </div>
      <div className="hint">{t('lineHint')}</div>
      <div className="content-notices">
        {(['left', 'right'] as const).map((side) =>
          file[side] && file[side]!.kind !== 'text' ? (
            <span key={side}>
              {t(side)}: {t(file[side]!.kind)}
            </span>
          ) : file[side]?.text && !file[side]!.text!.endsWith('\n') ? (
            <span key={side}>
              {t(side)}: {t('noNewline')}
            </span>
          ) : null,
        )}
      </div>
      {busy && <p className="empty">{t('processing')}</p>}
      {error && (
        <p role="alert" className="empty">
          {t(error)}
        </p>
      )}
      {warning && (
        <details className="hint">
          <summary>{t('errorAssets')}</summary>
          {warning}
        </details>
      )}
      <div className={'diff-panes ' + (split ? 'split' : 'unified')}>
        {pane('left')}
        {split && pane('right')}
      </div>
    </section>
  );
}
