import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from './api';
import i18n, { applyLanguages, builtins, type LanguageOption, type LanguagePack } from './i18n';
import { DiffView } from './DiffView';
import { FilesPanel } from './FilesPanel';
import { placement } from './diff';
import type { Assets, Comment, Comparison, Draft, Provider, Review } from './types';
const emptyAssets: Assets = { grammars: [], themes: [], errors: [] };
type Revision = { id: string; label: string };
type Preferences = { language: string; theme?: string };
export default function App() {
  const { t } = useTranslation();
  const [reviews, setReviews] = useState<Review[]>([]),
    [review, setReview] = useState<Review | null>(null),
    [comparisons, setComparisons] = useState<Comparison[]>([]),
    [comparison, setComparison] = useState<Comparison | null>(null);
  const [comments, setComments] = useState<Comment[]>([]),
    [path, setPath] = useState(''),
    [draft, setDraft] = useState<Draft | null>(null);
  const [left, setLeft] = useState('HEAD'),
    [right, setRight] = useState('WORKTREE'),
    [mode, setMode] = useState('direct'),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [newOpen, setNewOpen] = useState(false),
    [settings, setSettings] = useState(false),
    [providers, setProviders] = useState<Provider[]>([]);
  const [assets, setAssets] = useState<Assets>(emptyAssets),
    [preferences, setPreferences] = useState<Preferences>({ language: 'system' }),
    [languages, setLanguages] = useState<LanguageOption[]>(builtins),
    [packs, setPacks] = useState<LanguagePack[]>([]),
    [localeErrors, setLocaleErrors] = useState<unknown[]>([]),
    [dataPath, setDataPath] = useState('');
  const [capabilities, setCapabilities] = useState<{ mergeBase?: boolean }>({});
  const [view, setView] = useState('split'),
    [collapse, setCollapse] = useState(true),
    [commentScope, setCommentScope] = useState('all'),
    [includeResolved, setIncludeResolved] = useState(true);
  const [pluginPath, setPluginPath] = useState(''),
    [trust, setTrust] = useState(false);
  const [form, setForm] = useState({
    title: '',
    description: '',
    source: 'vcs',
    repo: '',
    provider: 'git',
    left: 'HEAD',
    right: 'WORKTREE',
    mode: 'direct',
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const pendingRef = useRef<string | null>(null);
  const generation = useRef(0);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const refreshReviews = useCallback(
    async () => setReviews(await rpc<Review[]>('review_list')),
    [],
  );
  const refreshComments = async (id: string) => {
    const result = await rpc<{ items: Comment[]; total: number }>('review_comments', {
      reviewId: id,
      limit: 500,
    });
    let all = result.items;
    for (let n = 500; n < result.total; n += 500) {
      const more = await rpc<{ items: Comment[] }>('review_comments', {
        reviewId: id,
        offset: n,
        limit: 500,
      });
      all = all.concat(more.items);
    }
    setComments(all);
  };
  const loadComparison = async (id: string) => {
    const c = await rpc<Comparison>('comparison_get', { comparisonId: id });
    setComparison(c);
    setPath((p) => (c.files.some((f) => f.path === p) ? p : (c.files[0]?.path ?? '')));
    setLeft(c.selection.left);
    setRight(c.selection.right);
    setMode(c.selection.mode);
  };
  const guard = () => {
    if (draftRef.current?.body.trim()) {
      setNotice('unsaved');
      return false;
    }
    setDraft(null);
    return true;
  };
  const loadReview = async (id: string) => {
    const r = await rpc<Review>('review_get', { reviewId: id });
    setReview(r);
    const cs = await rpc<Comparison[]>('comparison_list', { reviewId: id });
    setComparisons(cs);
    if (cs.length) await loadComparison(cs[cs.length - 1].id);
    else setComparison(null);
    await refreshComments(id);
    setRevisions([]);
    setOffset(0);
    setCapabilities({});
    if (r.source === 'vcs')
      try {
        setCapabilities(await rpc('provider_capabilities', { provider: r.provider, repo: r.repo }));
      } catch {
        /* capability absence hides optional controls */
      }
    if (r.source === 'vcs')
      try {
        const values = await rpc<{ items: Revision[]; nextOffset: number }>('revisions', {
          repo: r.repo,
          provider: r.provider,
        });
        setRevisions(values.items);
        setOffset(values.nextOffset);
      } catch (e) {
        setError(String(e));
      }
  };
  const reloadResources = async (pref?: Preferences) => {
    const selected = pref ?? preferences;
    const local = await rpc<{ packs: LanguagePack[]; errors: unknown[] }>('locales');
    setPacks(local.packs);
    setLocaleErrors(local.errors);
    const options = await applyLanguages(local.packs, selected.language);
    setLanguages(options);
    if (selected.language !== 'system' && !options.some((o) => o.locale === selected.language))
      setNotice('languageUnavailable');
    setAssets(await rpc<Assets>('assets'));
    setProviders(await rpc<Provider[]>('providers'));
  };
  useEffect(() => {
    void action(async () => {
      const pref = await rpc<Preferences>('preferences_get');
      setPreferences(pref);
      await reloadResources(pref);
      setDataPath((await rpc<{ path: string }>('data_directory')).path);
      await refreshReviews();
    });
  }, []); // Application bootstrap; language switches must not remount the workspace.
  useEffect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const pending = await rpc<{ reviewId: string | null }>('desktop_pending');
          if (pending.reviewId) pendingRef.current = pending.reviewId;
          if (pendingRef.current && !draftRef.current?.body.trim()) {
            const id = pendingRef.current;
            pendingRef.current = null;
            await action(async () => {
              await loadReview(id);
              await refreshReviews();
            });
          }
        } catch {
          /* service errors are surfaced on explicit actions */
        }
      })();
    }, 2000);
    return () => clearInterval(timer);
  }, []);
  const file = comparison?.files.find((f) => f.path === path);
  const editable = review?.status === 'in_progress';
  const changeLanguage = async (language: string) => {
    const next = { ...preferences, language };
    setPreferences(next);
    await rpc('preferences_set', next);
    setLanguages(await applyLanguages(packs, language));
  };
  const compare = () => {
    if (!review || !guard()) return;
    const token = ++generation.current;
    void action(async () => {
      const c = await rpc<Comparison>('comparison_create', {
        reviewId: review.id,
        left,
        right,
        mode,
      });
      if (token !== generation.current) return;
      setComparisons(await rpc<Comparison[]>('comparison_list', { reviewId: review.id }));
      setComparison(c);
      setPath(c.files[0]?.path ?? '');
      await refreshReviews();
    });
  };
  const saveComment = () => {
    if (!review || !draft) return;
    void action(async () => {
      await rpc('comment_save', { ...draft, reviewId: review.id });
      setDraft(null);
      await refreshComments(review.id);
    });
  };
  const selectDraft = (d: Draft) => {
    if (!editable) return;
    if (draft && draft.path !== d.path && draft.body.trim()) {
      setNotice('unsaved');
      return;
    }
    setDraft(d);
  };
  const saveStatus = (c: Comment) =>
    void action(async () => {
      await rpc('comment_save', {
        id: c.id,
        reviewId: c.reviewId,
        body: c.body,
        status: c.status === 'open' ? 'resolved' : 'open',
      });
      await refreshComments(c.reviewId);
    });
  const complete = () => {
    if (!review || !guard() || !confirm(t('confirmComplete'))) return;
    void action(async () => {
      await rpc('review_complete', { reviewId: review.id });
      await loadReview(review.id);
      await refreshReviews();
    });
  };
  const stateChange = (method: string) => {
    if (!review || !guard()) return;
    void action(async () => {
      await rpc(method, { reviewId: review.id });
      await loadReview(review.id);
      await refreshReviews();
    });
  };
  const exportResult = () =>
    void action(async () => {
      if (!review) return;
      const r = await rpc<{ available: boolean; result: unknown }>('review_result', {
        reviewId: review.id,
      });
      if (!r.available) {
        setNotice('noResult');
        return;
      }
      await navigator.clipboard.writeText(JSON.stringify(r.result, null, 2));
      setNotice('copied');
    });
  const errorKey = error.includes('SOURCE_CHANGED')
    ? 'sourceChanged'
    : error.includes('NOT_FOUND')
      ? 'notFound'
      : error.includes('INVALID_ARGUMENT')
        ? 'invalidArgument'
        : error.includes('TIMEOUT')
          ? 'timeout'
          : error.includes('RESOURCE_LIMIT')
            ? 'resourceLimit'
            : error.includes('PLUGIN_ERROR')
              ? 'pluginError'
              : 'error';
  const date = (timestamp: number) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(
      timestamp,
    );
  const visibleComments = comments.filter(
    (c) =>
      (includeResolved || c.status !== 'resolved') &&
      (commentScope === 'all' || c.anchor.path === path),
  );
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">v</span>vividiff <small>{t('tagline')}</small>
        </div>
        <div className="spacer" />
        <button onClick={() => setNewOpen(true)} disabled={busy}>
          {t('newReview')}
        </button>
        <button onClick={() => setSettings(true)}>{t('settings')}</button>
      </header>
      {error && (
        <div className="banner error" role="alert">
          <strong>{t(errorKey)}</strong>
          <details>
            <summary>{t('diagnostics')}</summary>
            <pre>{error}</pre>
          </details>
          <button onClick={() => setError('')}>{t('close')}</button>
        </div>
      )}
      {notice && (
        <div className="banner" role="status">
          {t(notice)}
          <button onClick={() => setNotice('')}>{t('close')}</button>
        </div>
      )}
      {busy && (
        <div className="progress" role="status">
          {t('working')}
          <button
            onClick={() => {
              generation.current++;
              setBusy(false);
              setNotice('stopped');
            }}
          >
            {t('cancelWait')}
          </button>
        </div>
      )}
      <div className="workspace">
        <aside className="sessions">
          <div className="section-title">
            {t('reviews')}
            <button onClick={() => void action(refreshReviews)} aria-label={t('reload')}>
              ↻
            </button>
          </div>
          {!reviews.length && <p className="hint">{t('noReviews')}</p>}
          {reviews.map((r) => (
            <button
              className={'session ' + (review?.id === r.id ? 'active' : '')}
              key={r.id}
              disabled={busy}
              onClick={() => {
                if (guard()) void action(() => loadReview(r.id));
              }}
            >
              <strong>{r.title}</strong>
              <span className={'status ' + r.status}>{t(r.status)}</span>
              <small>{date(r.updatedAt)}</small>
            </button>
          ))}
        </aside>
        {!review ? (
          <main className="welcome">
            <span className="hero-logo">v</span>
            <h1>vividiff</h1>
            <p>{t('selectReview')}</p>
            <button className="primary" onClick={() => setNewOpen(true)}>
              {t('newReview')}
            </button>
            <p className="hint">{t('pluginReadonly')}</p>
          </main>
        ) : (
          <main className="review-main">
            <section className="review-header">
              <div>
                <h1>{review.title}</h1>
                <small>{review.source === 'vcs' ? review.repo : t('files')}</small>
              </div>
              <span className={'badge ' + review.status}>{t(review.status)}</span>
              <div className="spacer" />
              {editable ? (
                <>
                  <button onClick={() => stateChange('review_cancel')} disabled={busy}>
                    {t('cancelReview')}
                  </button>
                  <button className="primary" onClick={complete} disabled={busy}>
                    {t('complete')}
                  </button>
                </>
              ) : (
                <button onClick={() => stateChange('review_reopen')} disabled={busy}>
                  {t('reopen')}
                </button>
              )}
              <button onClick={exportResult}>{t('export')}</button>
              <button
                className="danger"
                aria-label={t('delete')}
                onClick={() => {
                  if (guard() && confirm(t('confirmDelete')))
                    void action(async () => {
                      await rpc('review_delete', { reviewId: review.id });
                      setReview(null);
                      setComparison(null);
                      setComments([]);
                      await refreshReviews();
                    });
                }}
              >
                ×
              </button>
            </section>
            {review.description && (
              <details className="instructions">
                <summary>{t('reviewInstructions')}</summary>
                <p>{review.description}</p>
              </details>
            )}
            <section className="comparison-toolbar">
              <label>
                {t('left')}
                <input
                  aria-label={t('leftRevision')}
                  value={left}
                  list="revisions"
                  onChange={(e) => setLeft(e.target.value)}
                />
              </label>
              <button
                title={t('swap')}
                onClick={() => {
                  setLeft(right);
                  setRight(left);
                }}
              >
                ⇄
              </button>
              <label>
                {t('right')}
                <input
                  aria-label={t('rightRevision')}
                  value={right}
                  list="revisions"
                  onChange={(e) => setRight(e.target.value)}
                />
              </label>
              <datalist id="revisions">
                {revisions.map((r, i) => (
                  <option value={r.id} key={r.id + i}>
                    {r.label}
                  </option>
                ))}
              </datalist>
              {review.source === 'vcs' && (
                <>
                  <select
                    aria-label={t('mode')}
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="direct">{t('direct')}</option>
                    {capabilities.mergeBase && <option value="merge-base">{t('mergeBase')}</option>}
                  </select>
                  <button
                    title={t('loadMore')}
                    onClick={() =>
                      void action(async () => {
                        const next = await rpc<{ items: Revision[]; nextOffset: number }>(
                          'revisions',
                          { repo: review.repo, provider: review.provider, offset },
                        );
                        setRevisions((old) => [...old, ...next.items]);
                        setOffset(next.nextOffset);
                      })
                    }
                  >
                    …
                  </button>
                </>
              )}
              <button disabled={busy || !editable} title={t('snapshotHint')} onClick={compare}>
                {t('refresh')}
              </button>
              <label>
                {t('history')}
                <select
                  aria-label={t('history')}
                  value={comparison?.id ?? ''}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (guard()) void action(() => loadComparison(id));
                  }}
                >
                  {comparisons.map((c, i) => (
                    <option key={c.id} value={c.id}>
                      #{i + 1} {c.selection.left} → {c.selection.right} · {date(c.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <div className="review-body">
              <FilesPanel
                comparison={comparison}
                path={path}
                comments={comments}
                onSelect={setPath}
              />
              <div className="diff-panel">
                <div className="view-toolbar">
                  <button
                    className={view === 'split' ? 'active' : ''}
                    onClick={() => setView('split')}
                  >
                    {t('split')}
                  </button>
                  <button
                    className={view === 'unified' ? 'active' : ''}
                    onClick={() => setView('unified')}
                  >
                    {t('unified')}
                  </button>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={collapse}
                      onChange={(e) => setCollapse(e.target.checked)}
                    />
                    {t('collapse')}
                  </label>
                  <span className="spacer" />
                  <button
                    disabled={!file || !editable}
                    onClick={() =>
                      file &&
                      comparison &&
                      selectDraft({
                        comparisonId: comparison.id,
                        path: file.path,
                        side: 'file',
                        body: '',
                      })
                    }
                  >
                    {t('fileComment')}
                  </button>
                </div>
                {file && comparison ? (
                  <DiffView
                    file={file}
                    comparisonId={comparison.id}
                    assets={assets}
                    theme={preferences.theme ?? ''}
                    view={view}
                    collapse={collapse}
                    onSelect={selectDraft}
                    selected={draft}
                    comments={comments}
                  />
                ) : (
                  <p className="empty">
                    {t(comparison?.files.length ? 'selectFile' : 'noChanges')}
                  </p>
                )}
              </div>
              <aside className="comments-panel">
                <div className="section-title">
                  {t('comments')} <small>{comments.length}</small>
                </div>
                <select
                  aria-label={t('comments')}
                  value={commentScope}
                  onChange={(e) => setCommentScope(e.target.value)}
                >
                  <option value="all">{t('allComments')}</option>
                  <option value="file">{t('currentComments')}</option>
                </select>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={includeResolved}
                    onChange={(e) => setIncludeResolved(e.target.checked)}
                  />
                  {t('includeResolved')}
                </label>
                {!editable && <p className="hint">{t('readOnly')}</p>}
                {draft && editable && (
                  <form
                    className="comment-editor"
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveComment();
                    }}
                  >
                    <strong>{t(draft.id ? 'edit' : 'comment')}</strong>
                    <small>{draft.path}</small>
                    <small>
                      {t(draft.side)}{' '}
                      {draft.startLine
                        ? t('lineRange', { start: draft.startLine, end: draft.endLine })
                        : ''}
                    </small>
                    <textarea
                      autoFocus
                      aria-label={t('body')}
                      placeholder={t('body')}
                      value={draft.body}
                      onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                      rows={5}
                    />
                    <div className="button-row">
                      <button type="button" onClick={() => setDraft(null)}>
                        {t('discard')}
                      </button>
                      <button className="primary" disabled={!draft.body.trim() || busy}>
                        {t('save')}
                      </button>
                    </div>
                  </form>
                )}
                <div className="comment-list">
                  {!visibleComments.length && <p className="hint">{t('noComments')}</p>}
                  {visibleComments.map((c) => {
                    const target = comparison?.files.find(
                      (f) => f.path === c.anchor.path || f.oldPath === c.anchor.path,
                    );
                    const placed =
                      target && comparison ? placement(c.anchor, target, comparison.id) : null;
                    return (
                      <article className={'comment-card ' + c.status} key={c.id}>
                        <div className="comment-meta">
                          <b>{t(c.status)}</b>
                          <small>{date(c.createdAt)}</small>
                        </div>
                        <small className="path">{c.anchor.path}</small>
                        <small>
                          {t(c.anchor.side)}{' '}
                          {c.anchor.startLine
                            ? t('lineRange', { start: c.anchor.startLine, end: c.anchor.endLine })
                            : ''}
                        </small>
                        {!placed ? (
                          <span className="version-badge">{t('otherVersion')}</span>
                        ) : !placed.original ? (
                          <span className="version-badge">{t('mapped')}</span>
                        ) : null}
                        <p>{c.body}</p>
                        <details>
                          <summary>{t('context')}</summary>
                          <pre>{c.anchor.context ?? c.anchor.path}</pre>
                        </details>
                        <div className="button-row">
                          <button
                            onClick={() => {
                              if (guard())
                                void action(async () => {
                                  await loadComparison(c.anchor.comparisonId);
                                  setPath(c.anchor.path);
                                });
                            }}
                          >
                            {t('original')}
                          </button>
                          {editable && (
                            <>
                              <button onClick={() => saveStatus(c)}>
                                {t(c.status === 'open' ? 'resolve' : 'unresolve')}
                              </button>
                              <button
                                onClick={() => {
                                  if (guard())
                                    setDraft({
                                      id: c.id,
                                      ...c.anchor,
                                      body: c.body,
                                      status: c.status,
                                    });
                                }}
                              >
                                {t('edit')}
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(t('confirmDeleteComment')))
                                    void action(async () => {
                                      await rpc('comment_delete', { commentId: c.id });
                                      await refreshComments(c.reviewId);
                                    });
                                }}
                              >
                                {t('delete')}
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </aside>
            </div>
          </main>
        )}
      </div>
      {newOpen && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              if (!guard()) return;
              void action(async () => {
                const r = await rpc<Review>('review_create', form);
                await loadReview(r.id);
                await refreshReviews();
                setNewOpen(false);
              });
            }}
          >
            <h2>{t('newReview')}</h2>
            <label>
              {t('title')}
              <input
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
            <label>
              {t('description')}
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <label>
              {t('source')}
              <select
                value={form.source}
                onChange={(e) =>
                  setForm({
                    ...form,
                    source: e.target.value,
                    left: e.target.value === 'files' ? '' : 'HEAD',
                    right: e.target.value === 'files' ? '' : 'WORKTREE',
                  })
                }
              >
                <option value="vcs">{t('vcs')}</option>
                <option value="files">{t('files')}</option>
              </select>
            </label>
            {form.source === 'vcs' && (
              <>
                <label>
                  {t('provider')}
                  <select
                    value={form.provider}
                    onChange={(e) => setForm({ ...form, provider: e.target.value })}
                  >
                    {providers
                      .filter((p) => p.kind === 'vcs' && p.enabled)
                      .map((p) => (
                        <option key={p.id}>{p.id}</option>
                      ))}
                  </select>
                </label>
                <label>
                  {t('repo')}
                  <input
                    required
                    value={form.repo}
                    onChange={(e) => setForm({ ...form, repo: e.target.value })}
                  />
                </label>
                <p className="hint">{t('versionHelp')}</p>
              </>
            )}
            <div className="two-fields">
              <label>
                {t('leftRevision')}
                <input
                  required
                  value={form.left}
                  onChange={(e) => setForm({ ...form, left: e.target.value })}
                />
              </label>
              <label>
                {t('rightRevision')}
                <input
                  required
                  value={form.right}
                  onChange={(e) => setForm({ ...form, right: e.target.value })}
                />
              </label>
            </div>
            <div className="button-row">
              <button type="button" onClick={() => setNewOpen(false)}>
                {t('cancel')}
              </button>
              <button className="primary" disabled={busy}>
                {t('create')}
              </button>
            </div>
          </form>
        </div>
      )}
      {settings && (
        <div className="modal-backdrop">
          <section className="modal settings">
            <div className="section-title">
              <h2>{t('settings')}</h2>
              <button onClick={() => setSettings(false)}>{t('close')}</button>
            </div>
            <label>
              {t('language')}
              <select
                aria-label={t('language')}
                value={preferences.language}
                onChange={(e) => void action(() => changeLanguage(e.target.value))}
              >
                <option value="system">{t('system')}</option>
                {languages.map((l) => (
                  <option key={l.locale} value={l.locale}>
                    {l.nativeName} ({l.locale})
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">{t('languageHelp')}</p>
            <button onClick={() => void action(() => reloadResources())}>
              {t('reloadLanguages')}
            </button>
            {localeErrors.length > 0 && (
              <details>
                <summary>{t('errorLocale')}</summary>
                <pre>{JSON.stringify(localeErrors, null, 2)}</pre>
              </details>
            )}
            <label>
              {t('theme')}
              <select
                aria-label={t('theme')}
                value={preferences.theme ?? ''}
                onChange={(e) =>
                  void action(async () => {
                    const next = { ...preferences, theme: e.target.value };
                    setPreferences(next);
                    await rpc('preferences_set', next);
                  })
                }
              >
                <option value="">{t('defaultTheme')}</option>
                {assets.themes.map((th) => (
                  <option key={th.id} value={th.id}>
                    {th.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('dataDirectory')}
              <code>{dataPath}</code>
            </label>
            <h3>{t('plugins')}</h3>
            <p className="hint">{t('pluginReadonly')}</p>
            {providers.map((p) => (
              <div className="plugin-row" key={p.id}>
                <strong>{p.id}</strong>
                <span>{p.kind}</span>
                {p.builtin ? (
                  <small>{t('builtin')}</small>
                ) : (
                  <button
                    disabled={!!p.error}
                    onClick={() =>
                      void action(async () => {
                        await rpc('plugin_toggle', { id: p.id, enabled: !p.enabled });
                        await reloadResources();
                      })
                    }
                  >
                    {t(p.enabled ? 'disable' : 'enable')}
                  </button>
                )}
                {p.error && <small>{p.error}</small>}
              </div>
            ))}
            <label>
              {t('pluginPath')}
              <input value={pluginPath} onChange={(e) => setPluginPath(e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
              {t('trust')}
            </label>
            <button
              disabled={!pluginPath || busy}
              onClick={() =>
                void action(async () => {
                  await rpc('plugin_install', { path: pluginPath, trusted: trust });
                  await reloadResources();
                  setPluginPath('');
                  setTrust(false);
                  setNotice('pluginInstalled');
                })
              }
            >
              {t('install')}
            </button>
            {assets.errors.length > 0 && (
              <details>
                <summary>{t('errorAssets')}</summary>
                <pre>{JSON.stringify(assets.errors, null, 2)}</pre>
              </details>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
