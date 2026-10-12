import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Comment, Comparison, LineStats } from './types';

const MIN_WIDTH = 160;
const STORAGE_KEY = 'vividiff.filesPanelWidth';
function initialWidth() {
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return saved >= MIN_WIDTH && Number.isFinite(saved) ? Math.min(saved, 520) : 210;
  } catch {
    return 210;
  }
}
export function FilesPanel({
  comparison,
  path,
  comments,
  onSelect,
}: {
  comparison: Comparison | null;
  path: string;
  comments: Comment[];
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(initialWidth);
  const [maxWidth, setMaxWidth] = useState(520);
  const [filter, setFilter] = useState('');
  const [stats, setStats] = useState<Record<string, LineStats | null>>({});
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      const commentsWidth =
        parent.querySelector('.comments-panel')?.getBoundingClientRect().width ?? 290;
      const maximum = Math.max(MIN_WIDTH, Math.min(520, parent.clientWidth - commentsWidth - 326));
      setMaxWidth(maximum);
      setWidth((current) => Math.min(current, maximum));
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      /* optional preference */
    }
  }, [width]);
  useEffect(() => {
    setStats({});
    if (!comparison) return;
    const worker = new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' });
    const unknown = () =>
      setStats((current) =>
        Object.fromEntries(
          comparison.files.map((file) => [
            file.path,
            Object.hasOwn(current, file.path) ? current[file.path] : null,
          ]),
        ),
      );
    const timeout = setTimeout(() => {
      worker.terminate();
      unknown();
    }, 20000);
    worker.onmessage = (event) => setStats((current) => ({ ...current, ...event.data }));
    worker.onerror = unknown;
    worker.postMessage(comparison.files);
    return () => {
      clearTimeout(timeout);
      worker.terminate();
    };
  }, [comparison]);
  const resize = (next: number) => setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, next)));
  return (
    <>
      <aside className="files-panel" ref={panel} style={{ width }}>
        <input
          aria-label={t('filter')}
          placeholder={t('filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <small>{t('countFiles', { count: comparison?.files.length ?? 0 })}</small>
        <div className="file-list">
          {comparison?.files
            .filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
            .map((file) => {
              const counts = Object.hasOwn(stats, file.path) ? stats[file.path] : undefined;
              return (
                <button
                  className={'file-entry ' + (path === file.path ? 'active' : '')}
                  key={file.path}
                  title={file.path}
                  onClick={() => onSelect(file.path)}
                >
                  <b className={'file-status ' + file.status}>{file.status}</b>
                  <span className="file-name">{file.path}</span>
                  <span
                    className="file-stats"
                    aria-label={
                      counts
                        ? t('lineStats', counts)
                        : t(counts === null ? 'lineStatsUnavailable' : 'loading')
                    }
                  >
                    {counts ? (
                      <>
                        <span className="stat-added">+{counts.added}</span>
                        <span className="stat-deleted">−{counts.deleted}</span>
                      </>
                    ) : counts === null ? (
                      '—'
                    ) : (
                      '…'
                    )}
                  </span>
                  {comments.some((comment) => comment.anchor.path === file.path) && <i>●</i>}
                </button>
              );
            })}
        </div>
      </aside>
      <div
        className="files-resizer"
        role="separator"
        tabIndex={0}
        aria-label={t('resizeFiles')}
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(width)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          drag.current = { x: e.clientX, width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) resize(drag.current.width + e.clientX - drag.current.x);
        }}
        onPointerUp={(e) => {
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={() => resize(210)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            resize(width + (e.key === 'ArrowLeft' ? -10 : 10));
          } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            resize(e.key === 'Home' ? MIN_WIDTH : maxWidth);
          }
        }}
      />
    </>
  );
}
