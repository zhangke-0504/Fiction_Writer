import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { api } from './bridge';
import { startReload } from './diagnostics';
import type { UiRefreshContext } from '../shared/diagnostics';
import { Dialog, ErrorText, Icon, errorMessage, kinds, labels, norm } from './ui';
import type {
  BookView,
  ChapterPreview,
  DocRef,
  DocSummary,
  DocType,
  Fields,
  Manuscript,
  SubjectKind,
  WriteReport,
} from '../shared/contracts';
const MarkdownEditor = lazy(() =>
  import('./MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })),
);
type BookInfo = { title: string; summary: string; genre: string; style: string };
type Draft = { base: string; text: string; info?: BookInfo };
export type Drafts = Map<string, Draft>;
export type ActiveChapter = { bookId: string; chapterId: string };
const icons = {
  book: 'page',
  outline: 'outline',
  subject: 'people',
  clue: 'spark',
  chapter: 'book',
} as const;
const title = (doc?: DocSummary) => doc?.fields.title ?? doc?.fields.name ?? '未命名';
const matches = (doc: DocRef, ref: DocRef) => doc.type === ref.type && doc.id === ref.id;
function check(report: WriteReport) {
  if (report.error)
    throw new Error(
      `${report.error}${report.committed.length ? `（已提交：${report.committed.map((d) => `${d.type}/${d.id}`).join('、')}；未提交：${report.pending.map((d) => `${d.type}/${d.id}`).join('、')}）` : ''}`,
    );
}

export function Workspace({
  bookId,
  refresh,
  preview,
  drafts,
  back,
  onChapter,
}: {
  bookId: string;
  refresh: UiRefreshContext;
  preview?: ChapterPreview;
  drafts: Drafts;
  back: () => void;
  onChapter?: (chapter: ActiveChapter | undefined) => void;
}) {
  const [view, setView] = useState<BookView>(),
    [loaded, setLoaded] = useState<{
      doc: Manuscript;
      origin?: ReturnType<typeof startReload>['origin'];
    }>(),
    [selection, setSelection] = useState<DocRef>({ type: 'book', id: bookId });
  const [error, setError] = useState(''),
    [tick, setTick] = useState(0),
    [saving, setSaving] = useState(false);
  const [query, setQuery] = useState(''),
    [editing, setEditing] = useState<{ type: 'subject' | 'clue' | 'chapter'; item?: Manuscript }>();
  const [orphan, setOrphan] = useState<Draft>(),
    [, redraw] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const chapterList = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const assetListScroll = useRef({ subject: 0, clue: 0 });
  const doc = loaded?.doc;
  const bookReadOrigin = useRef<UiRefreshContext>({ reason: 'load' });
  const lastReadDocument = useRef<string>(undefined);
  const documents = view?.documents ?? [],
    book = documents.find((d) => d.type === 'book');
  const chapters = documents.filter((d) => d.type === 'chapter'),
    subjects = documents.filter((d) => d.type === 'subject'),
    clues = documents.filter((d) => d.type === 'clue');
  const selected = documents.find((d) => matches(d, selection)),
    current = doc && matches(doc, selection) ? doc : undefined;
  const assetType =
    selection.type === 'subject' || selection.type === 'clue' ? selection.type : undefined;
  const listType = selection.id ? undefined : assetType;
  const assetList = !!listType;
  const { type: selectionType, id: selectionId } = selection;
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = listType ? assetListScroll.current[listType] : 0;
  }, [listType, selectionType, selectionId]);
  const draftKey = `${bookId}/${selection.type}/${selection.id}`,
    draft = drafts.get(draftKey);
  const savedInfo =
    current?.type === 'book'
      ? {
          title: current.fields.title ?? '',
          summary: current.body,
          genre: current.fields.genre ?? '',
          style: current.fields.style ?? '',
        }
      : undefined;
  const info = savedInfo ? (draft?.info ?? savedInfo) : undefined;
  const live =
    !draft &&
    current?.type === 'chapter' &&
    preview?.bookId === bookId &&
    preview.chapterId === current.id &&
    preview.base === current.revision
      ? preview
      : undefined;
  const conflict = !!draft && !!current && draft.base !== current.revision;
  const select = (ref: DocRef) => {
    if (listType && content.current) assetListScroll.current[listType] = content.current.scrollTop;
    setError('');
    setSelection({ type: ref.type, id: ref.id });
  };
  const refreshLocal = () => setTick((n) => n + 1);
  useEffect(() => {
    let active = true;
    const context = { ...refresh, workspaceRef: bookId };
    const reload = startReload('workspace', context);
    void api.request<BookView>('book.read', { bookId }).then(
      (v) => {
        if (active) {
          bookReadOrigin.current = context;
          setView(v);
        }
        reload.finish(active ? 'ok' : 'superseded', {
          count: v.documents.length,
          issueCount: v.diagnostics.length,
        });
      },
      (e) => {
        if (active) setError(errorMessage(e));
        reload.finish(active ? 'failed' : 'superseded');
      },
    );
    return () => {
      active = false;
    };
  }, [bookId, refresh, tick]);
  useEffect(() => {
    onChapter?.(selection.type === 'chapter' ? { bookId, chapterId: selection.id } : undefined);
    api.diagnostic('ui.section', {
      section: selection.type,
      workspaceRef: bookId,
      documentRef: selection.id ? `${selection.type}/${selection.id}` : undefined,
    });
    return () => onChapter?.(undefined);
  }, [bookId, selection, onChapter]);
  useEffect(() => {
    if (!selection.id) {
      setLoaded(undefined);
      lastReadDocument.current = undefined;
      return;
    }
    let active = true;
    const documentRef = `${selection.type}/${selection.id}`;
    const origin = bookReadOrigin.current;
    const reason =
      lastReadDocument.current !== documentRef && origin.reason !== 'load' ? 'user' : origin.reason;
    lastReadDocument.current = documentRef;
    const reload = startReload('document', { ...origin, reason, workspaceRef: bookId, documentRef });
    void api.request<Manuscript>('book.doc.read', { bookId, doc: selection }).then(
      (d) => {
        if (active) setLoaded({ doc: d, origin: reload.origin });
        reload.finish(active ? 'ok' : 'superseded', { revision: d.revision });
      },
      (e) => {
        if (active) {
          setLoaded(undefined);
          if (selected) setError(errorMessage(e));
        }
        reload.finish(active ? 'failed' : 'superseded');
      },
    );
    return () => {
      active = false;
    };
  }, [bookId, selection, selected?.revision]);
  const lastVisible = useRef('');
  const currentRef = current && `${current.type}/${current.id}`;
  const revision = current?.revision,
    base = draft?.base;
  const showingPreview = !!live,
    showingDraft = !!draft;
  const observeVisible = useCallback(() => {
    if (!currentRef || !revision || showingPreview) {
      lastVisible.current = '';
      return;
    }
    const context = { workspaceRef: bookId, documentRef: currentRef, ...loaded?.origin };
    const key = `${currentRef}/${revision}/${showingDraft}/${base ?? ''}`;
    if (lastVisible.current === key) return;
    lastVisible.current = key;
    if (conflict && base)
      api.diagnostic('ui.draft_preserved', {
        ...context,
        expectedRevision: base,
        revision,
        reason: 'conflict',
      });
    else if (!showingDraft) api.diagnostic('ui.revision_applied', { ...context, revision });
  }, [currentRef, revision, showingDraft, showingPreview, conflict, base, bookId, loaded?.origin]);
  const markdown = current?.type === 'chapter' || current?.type === 'outline';
  useEffect(() => {
    if (!markdown) observeVisible();
  }, [markdown, observeVisible]);
  useEffect(() => {
    if (!showingPreview || !currentRef) return;
    const fields = { workspaceRef: bookId, documentRef: currentRef };
    api.diagnostic('ui.preview', { ...fields, outcome: 'started' });
    return () => api.diagnostic('ui.preview', { ...fields, outcome: 'cleared' });
  }, [bookId, currentRef, showingPreview]);
  useEffect(() => {
    if (view && selection.id && !selected && ['chapter', 'subject', 'clue'].includes(selection.type)) {
      if (draft) {
        setOrphan(draft);
        drafts.delete(draftKey);
        const { journalSeq, workerId } = bookReadOrigin.current;
        api.diagnostic('ui.draft_preserved', {
          workspaceRef: bookId,
          documentRef: `${selection.type}/${selection.id}`,
          journalSeq,
          workerId,
          expectedRevision: draft.base,
          reason: 'missing',
        });
      }
      setSelection(
        selection.type === 'chapter' ? { type: 'book', id: bookId } : { type: selection.type, id: '' },
      );
    }
  }, [view, selected, selection, draft, drafts, draftKey, bookId]);
  function editText(text: string) {
    if (!current) return;
    if (text === current.body && (!draft || draft.base === current.revision)) drafts.delete(draftKey);
    else drafts.set(draftKey, { base: draft?.base ?? current.revision, text });
    redraw((n) => n + 1);
  }
  async function saveBody() {
    if (!current || !draft || saving || live || conflict) return;
    setSaving(true);
    setError('');
    try {
      check(
        await api.request<WriteReport>('book.doc.write', {
          bookId,
          doc: { ...current, revision: draft.base, body: draft.text },
        }),
      );
      const latest = await api.request<Manuscript>('book.doc.read', { bookId, doc: current });
      if (drafts.get(draftKey) === draft) drafts.delete(draftKey);
      else {
        const next = drafts.get(draftKey);
        if (next?.base === draft.base && latest.body === draft.text)
          drafts.set(draftKey, { base: latest.revision, text: next.text });
      }
      setLoaded((old) => (old && matches(old.doc, current) ? { doc: latest } : old));
      refreshLocal();
    } catch (e) {
      setError(errorMessage(e));
      refreshLocal();
    } finally {
      setSaving(false);
    }
  }
  const saveRef = useRef(saveBody);
  saveRef.current = current?.type === 'book' ? saveInfo : saveBody;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  function editInfo(field: keyof BookInfo, value: string) {
    if (!current || !savedInfo || !info) return;
    const next = { ...info, [field]: value };
    const base = draft?.base ?? current.revision;
    if (
      base === current.revision &&
      (Object.keys(next) as (keyof BookInfo)[]).every((key) => next[key] === savedInfo[key])
    ) {
      drafts.delete(draftKey);
    } else {
      drafts.set(draftKey, { base, text: next.summary, info: next });
    }
    redraw((n) => n + 1);
  }
  async function saveInfo() {
    if (current?.type !== 'book' || !draft?.info || saving || conflict) return;
    const { title, summary, genre, style } = draft.info;
    const name = title.trim(),
      body = summary.trim();
    if (!name || !body) {
      setError('小说名和简介不能为空');
      return;
    }
    setSaving(true);
    setError('');
    try {
      check(
        await api.request<WriteReport>('book.doc.write', {
          bookId,
          doc: {
            ...current,
            revision: draft.base,
            fields: {
              ...current.fields,
              title: name,
              genre: genre.trim() || undefined,
              style: style.trim() || undefined,
            },
            body,
          },
        }),
      );
      const latest = await api.request<Manuscript>('book.doc.read', { bookId, doc: current });
      if (drafts.get(draftKey) === draft) drafts.delete(draftKey);
      setLoaded((old) => (old && matches(old.doc, current) ? { doc: latest } : old));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      refreshLocal();
      setSaving(false);
    }
  }
  async function remove(item: DocSummary) {
    setError('');
    try {
      check(await api.request<WriteReport>('book.doc.delete', { bookId, doc: item }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      refreshLocal();
    }
  }
  async function reorder(index: number, offset: number) {
    const a = chapters[index],
      b = chapters[index + offset];
    if (!a || !b) return;
    setError('');
    try {
      const reordered = [...chapters];
      [reordered[index], reordered[index + offset]] = [b, a];
      const changes = [];
      for (const [i, item] of reordered.entries()) {
        if (item.fields.order === i + 1) continue;
        const full = await api.request<Manuscript>('book.doc.read', { bookId, doc: item });
        changes.push({
          type: item.type,
          id: item.id,
          expect: full.revision,
          fields: { ...full.fields, order: i + 1 },
          body: full.body,
        });
      }
      check(await api.request<WriteReport>('book.changes.write', { bookId, changes }));
      if (current?.type === 'chapter') {
        const latest = await api.request<Manuscript>('book.doc.read', { bookId, doc: current });
        const previous = drafts.get(draftKey);
        if (previous?.base === current.revision && latest.body === current.body)
          drafts.set(draftKey, { ...previous, base: latest.revision });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      refreshLocal();
    }
  }
  async function assetForm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const values = new FormData(e.currentTarget),
      original = editing.item;
    const id = original?.id ?? crypto.randomUUID(),
      type = editing.type;
    const text = String(values.get('name') ?? '').trim();
    if (!text) {
      setError('名称不能为空');
      return;
    }
    const fields: Fields = { ...original?.fields };
    if (type === 'subject') {
      fields.name = text;
      fields.kind = String(values.get('kind')) as SubjectKind;
    } else fields.title = text;
    if (type === 'chapter' && !original)
      fields.order = 1 + Math.max(0, ...chapters.map((c) => c.fields.order ?? 0));
    if (type === 'clue') {
      fields.subjectIds = values.getAll('subject').map(String);
      fields.setupChapterId = String(values.get('setup') ?? '') || undefined;
      fields.payoffChapterId = String(values.get('payoff') ?? '') || undefined;
      if (fields.setupChapterId) delete fields.setupBeatId;
      if (fields.payoffChapterId) delete fields.payoffBeatId;
    }
    setSaving(true);
    setError('');
    try {
      const body = type === 'chapter' ? (original?.body ?? '') : String(values.get('body') ?? '');
      check(
        await api.request<WriteReport>('book.doc.write', {
          bookId,
          doc: { type, id, revision: original?.revision ?? '', body, fields },
        }),
      );
      const nextView = await api.request<BookView>('book.read', { bookId });
      bookReadOrigin.current = { reason: 'user' };
      setView(nextView);
      if (type === 'chapter' && draft && selected?.id === id && draft.base === original?.revision) {
        const latest = await api.request<Manuscript>('book.doc.read', { bookId, doc: { type, id } });
        if (latest.body === body) drafts.set(draftKey, { ...draft, base: latest.revision });
      }
      setEditing(undefined);
      if (type === 'chapter' || original) select({ type, id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function editAsset(item: DocSummary) {
    try {
      setError('');
      setEditing({
        type: item.type as 'chapter' | 'subject' | 'clue',
        item: await api.request('book.doc.read', { bookId, doc: item }),
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const openSection = (type: DocType) =>
    select({ type, id: type === 'outline' ? 'outline' : type === 'book' ? bookId : '' });
  const sectionTitle =
    current && ['chapter', 'subject', 'clue'].includes(current.type)
      ? title(current)
      : labels[selection.type];
  const editingTitle =
    editing &&
    (editing.item
      ? editing.type === 'chapter'
        ? '重命名章节'
        : `编辑${labels[editing.type]}`
      : `新建${labels[editing.type]}`);
  return (
    <div className="workspace page-container">
      <div className="breadcrumb">
        <button className="text-button" onClick={back}>
          <Icon name="back" size={16} />
          返回书库
        </button>
        <Icon name="right" size={13} />
        <span className="breadcrumb-title" title={book ? title(book) : undefined}>
          {book ? title(book) : '小说工作区'}
        </span>
      </div>
      <div className="workspace-frame surface">
        <aside className="workspace-nav">
          <div className="workspace-brand">
            <span className="book-mark">
              <Icon name="book" size={22} />
            </span>
            <div className="workspace-brand-text">
              <strong title={book ? title(book) : undefined}>{book ? title(book) : '小说工作区'}</strong>
              <small>个人作品</small>
            </div>
          </div>
          <div className="nav-block">
            <p className="eyebrow">故事资产</p>
            {(['book', 'subject', 'clue', 'outline'] as const).map((type) => (
              <button
                key={type}
                onClick={() => openSection(type)}
                className={`nav-item ${selection.type === type ? 'selected' : ''}`}
              >
                <Icon name={icons[type]} />
                {labels[type]}
              </button>
            ))}
          </div>
          <div className="nav-block chapters-nav">
            <div className="section-label">
              <span>
                章节 <small>{chapters.length}</small>
              </span>
              <button
                className="icon-button"
                aria-label="新建章节"
                onClick={() => {
                  setError('');
                  setEditing({ type: 'chapter' });
                }}
              >
                <Icon name="plus" />
              </button>
            </div>
            {!!chapters.length && (
              <input
                className="chapter-search"
                aria-label="查找章节"
                placeholder="查找章节"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (chapterList.current) chapterList.current.scrollTop = 0;
                }}
              />
            )}
            <section
              className="chapter-list scroll-region"
              aria-label="章节列表"
              tabIndex={0}
              ref={chapterList}
            >
              {chapters.map((c, i) =>
                norm(title(c)).includes(norm(query)) ? (
                  <div className={`chapter-row ${matches(selection, c) ? 'selected' : ''}`} key={c.id}>
                    <button className="nav-item" onClick={() => select(c)}>
                      <span aria-hidden="true" className="chapter-number">
                        {i + 1}
                      </span>
                      {title(c)}
                    </button>
                  </div>
                ) : null,
              )}
              {!chapters.length && <p className="empty-mini">还没有章节</p>}
            </section>
          </div>
        </aside>
        <section className="workspace-main" aria-label="写作区域">
          <div className="workspace-heading">
            <div className="book-mark small">
              <Icon name={icons[selection.type]} />
            </div>
            <div className="workspace-title">
              <p className="eyebrow">
                {selection.type === 'chapter'
                  ? `章节 ${Math.max(1, chapters.findIndex((c) => c.id === selection.id) + 1)}`
                  : '小说工作区'}
              </p>
              <h1 title={sectionTitle}>{sectionTitle}</h1>
            </div>
            <div className="actions heading-actions">
              {assetList && (
                <button
                  className="primary"
                  onClick={() => {
                    setError('');
                    setEditing({ type: selection.type as 'subject' | 'clue' });
                  }}
                >
                  <Icon name="plus" />
                  新建{labels[selection.type]}
                </button>
              )}
              {current && ['subject', 'clue', 'chapter'].includes(current.type) && (
                <>
                  <button
                    className="icon-button"
                    aria-label={current.type === 'chapter' ? '重命名章节' : '编辑资料'}
                    onClick={() => void editAsset(current)}
                  >
                    <Icon name="edit" />
                  </button>
                  {current.type === 'chapter' && (
                    <>
                      <button
                        className="icon-button"
                        aria-label="上移章节"
                        disabled={chapters[0]?.id === current.id}
                        onClick={() =>
                          void reorder(
                            chapters.findIndex((c) => c.id === current.id),
                            -1,
                          )
                        }
                      >
                        <Icon name="up" />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="下移章节"
                        disabled={chapters.at(-1)?.id === current.id}
                        onClick={() =>
                          void reorder(
                            chapters.findIndex((c) => c.id === current.id),
                            1,
                          )
                        }
                      >
                        <Icon name="down" />
                      </button>
                    </>
                  )}
                  <button
                    className="icon-button destructive"
                    aria-label={current.type === 'chapter' ? '删除章节' : '删除资料'}
                    onClick={() => void remove(current)}
                  >
                    <Icon name="trash" />
                  </button>
                </>
              )}
            </div>
          </div>
          {assetType && selectionId && (
            <div className="workspace-return">
              <button className="text-button muted" onClick={() => openSection(assetType)}>
                <Icon name="back" />
                返回{labels[assetType]}列表
              </button>
            </div>
          )}
          <div
            className={`workspace-content ${markdown ? 'workspace-editor-content' : 'scroll-region'}`}
            ref={content}
            role={markdown ? undefined : 'region'}
            aria-label={
              markdown ? undefined : listType ? `${labels[listType]}列表` : `${sectionTitle}内容`
            }
            tabIndex={markdown ? undefined : 0}
          >
            <div className={markdown ? 'workspace-alerts scroll-region' : undefined}>
              {!editing && <ErrorText text={error} />}
              {orphan && (
                <p className="notice">
                  所选文档已移除。
                  <button
                    className="text-button"
                    onClick={() => void navigator.clipboard.writeText(orphan.text)}
                  >
                    复制未保存文字
                  </button>
                  <button className="text-button" onClick={() => setOrphan(undefined)}>
                    关闭
                  </button>
                </p>
              )}
              {conflict && (
                <p className="notice">
                  磁盘上的文档已变化，未保存的文字仍保留。
                  <button
                    className="text-button"
                    onClick={() => {
                      const details = draft?.info;
                      void navigator.clipboard.writeText(
                        details
                          ? `小说名：${details.title}\n题材：${details.genre}\n文风：${details.style}\n\n${details.summary}`
                          : draft!.text,
                      );
                    }}
                  >
                    复制草稿
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      drafts.delete(draftKey);
                      setError('');
                      redraw((n) => n + 1);
                      refreshLocal();
                    }}
                  >
                    重载文件
                  </button>
                </p>
              )}
            </div>
            {info && (
              <form
                className="form-grid"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveInfo();
                }}
              >
                <label className="wide">
                  小说名
                  <input
                    name="title"
                    value={info.title}
                    required
                    disabled={saving}
                    onChange={(e) => editInfo('title', e.target.value)}
                  />
                </label>
                <label className="wide">
                  简介
                  <textarea
                    name="summary"
                    rows={5}
                    value={info.summary}
                    required
                    disabled={saving}
                    onChange={(e) => editInfo('summary', e.target.value)}
                  />
                </label>
                <label>
                  题材
                  <input
                    name="genre"
                    value={info.genre}
                    disabled={saving}
                    onChange={(e) => editInfo('genre', e.target.value)}
                  />
                </label>
                <label>
                  文风
                  <input
                    name="style"
                    value={info.style}
                    disabled={saving}
                    onChange={(e) => editInfo('style', e.target.value)}
                  />
                </label>
                <div className="wide dialog-actions">
                  <button className="primary" disabled={!draft?.info || conflict || saving}>
                    保存基本信息
                  </button>
                </div>
              </form>
            )}
            {assetList &&
              (selection.type === 'subject' ? (
                <div className="asset-groups">
                  {(Object.keys(kinds) as SubjectKind[]).map((kind) => (
                    <div key={kind}>
                      <h2>{kinds[kind]}</h2>
                      {subjects
                        .filter((s) => s.fields.kind === kind)
                        .map((s) => (
                          <button className="asset-card" key={s.id} onClick={() => select(s)}>
                            <Icon
                              name={
                                kind === 'character' ? 'people' : kind === 'item' ? 'spark' : 'folder'
                              }
                            />
                            <strong>{title(s)}</strong>
                            <Icon name="right" />
                          </button>
                        ))}
                      {!subjects.some((s) => s.fields.kind === kind) && (
                        <p className="empty-mini">尚无{kinds[kind]}资料</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="asset-groups">
                  {clues.map((c) => (
                    <button className="asset-card" key={c.id} onClick={() => select(c)}>
                      <Icon name="spark" />
                      <strong>{title(c)}</strong>
                      <small>{c.fields.payoffChapterId ? '已有回收点' : '未设回收点'}</small>
                      <Icon name="right" />
                    </button>
                  ))}
                  {!clues.length && <p className="empty-mini">还没有伏笔</p>}
                </div>
              ))}
            {(current?.type === 'subject' || current?.type === 'clue') && (
              <>
                <div className="asset-body">{current.body || '暂无说明'}</div>
                {current.type === 'clue' && (
                  <dl className="references">
                    <dt>关联主体</dt>
                    <dd>
                      {(current.fields.subjectIds ?? [])
                        .map((id) => title(subjects.find((s) => s.id === id)))
                        .join('、') || '无'}
                    </dd>
                    <dt>埋设章节</dt>
                    <dd>
                      {current.fields.setupChapterId
                        ? title(chapters.find((c) => c.id === current.fields.setupChapterId))
                        : '未设置'}
                    </dd>
                    <dt>回收章节</dt>
                    <dd>
                      {current.fields.payoffChapterId
                        ? title(chapters.find((c) => c.id === current.fields.payoffChapterId))
                        : '未设置'}
                    </dd>
                  </dl>
                )}
              </>
            )}
            {(current?.type === 'chapter' || current?.type === 'outline') && (
              <div className="writing-area">
                <div className="editor-meta">
                  <span role="status">
                    {live ? '生成中 · 未保存' : conflict ? '存在编辑冲突' : draft ? '未保存' : '已保存'}
                  </span>
                  <span>{Array.from(live?.content ?? draft?.text ?? current.body).length} 字符</span>
                </div>
                <Suspense fallback={<p>正在打开 Markdown 编辑器…</p>}>
                  <MarkdownEditor
                    key={`${current.type}/${current.id}`}
                    value={live?.content ?? draft?.text ?? current.body}
                    onChange={editText}
                    readOnly={!!live}
                    onApplied={observeVisible}
                  />
                </Suspense>
                <div className="editor-footer">
                  <small>Markdown · Ctrl+S 保存</small>
                  <button
                    className="primary"
                    disabled={saving || !draft || conflict || !!live}
                    onClick={() => void saveBody()}
                  >
                    <Icon name="check" />
                    保存
                  </button>
                </div>
              </div>
            )}
            {!!view?.diagnostics.length && (
              <button
                className="text-button muted workspace-diagnostics"
                onClick={() => setShowDiagnostics(true)}
              >
                文件读取提示 ({view.diagnostics.length})
              </button>
            )}
          </div>
        </section>
      </div>
      {showDiagnostics && (
        <Dialog title="文件读取提示" kicker="小说工作区" close={() => setShowDiagnostics(false)}>
          <div className="diagnostics">
            {view?.diagnostics.map((message, index) => (
              <p key={`${index}-${message}`}>{message}</p>
            ))}
          </div>
        </Dialog>
      )}
      {editing && (
        <Dialog
          title={editingTitle!}
          kicker={book ? title(book) : '小说工作区'}
          close={() => {
            if (!saving) {
              setEditing(undefined);
              setError('');
            }
          }}
        >
          <form className="form-grid" onSubmit={assetForm}>
            <label className="wide">
              {editing.type === 'chapter' ? '章节名' : '名称'}
              <input
                name="name"
                required
                autoFocus
                defaultValue={editing.item ? title(editing.item) : ''}
              />
            </label>
            {editing.type === 'subject' && (
              <label className="wide">
                主体类型
                <select name="kind" defaultValue={editing.item?.fields.kind ?? 'character'}>
                  {Object.entries(kinds).map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {editing.type !== 'chapter' && (
              <label className="wide">
                说明
                <textarea name="body" rows={5} defaultValue={editing.item?.body ?? ''} />
              </label>
            )}
            {editing.type === 'clue' && (
              <>
                <fieldset className="wide">
                  <legend>关联主体</legend>
                  {subjects.map((s) => (
                    <label className="check-label" key={s.id}>
                      <input
                        type="checkbox"
                        name="subject"
                        value={s.id}
                        defaultChecked={editing.item?.fields.subjectIds?.includes(s.id)}
                      />
                      {title(s)}
                    </label>
                  ))}
                </fieldset>
                <label>
                  埋设章节
                  <select name="setup" defaultValue={editing.item?.fields.setupChapterId ?? ''}>
                    <option value="">未设置</option>
                    {chapters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {title(c)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  回收章节
                  <select name="payoff" defaultValue={editing.item?.fields.payoffChapterId ?? ''}>
                    <option value="">未设置</option>
                    {chapters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {title(c)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <div className="wide">
              <ErrorText text={error} />
            </div>
            <footer className="wide dialog-actions">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setEditing(undefined);
                  setError('');
                }}
              >
                取消
              </button>
              <button className="primary" disabled={saving}>
                {editing.item ? '保存' : '创建'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </div>
  );
}
