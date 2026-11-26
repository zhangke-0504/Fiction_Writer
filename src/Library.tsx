import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { BookSummary, LibraryView } from '../shared/contracts';
import { api } from './bridge';
import type { UiRefreshContext } from '../shared/diagnostics';
import { startReload } from './diagnostics';
import { Dialog, ErrorText, Icon, errorMessage, norm } from './ui';
export type LibraryPosition = { query: string; start: number; pageSize: number; firstBookId?: string };

export function Library({
  refresh,
  open,
  position,
  setPosition,
}: {
  refresh: UiRefreshContext;
  open: (id: string) => void;
  position: LibraryPosition;
  setPosition: (position: LibraryPosition) => void;
}) {
  const { query } = position;
  const [view, setView] = useState<LibraryView>(),
    [create, setCreate] = useState(false),
    [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const list = useRef<HTMLElement>(null);
  const [pageSize, setPageSize] = useState(1);
  const [createdId, setCreatedId] = useState<string>();

  useLayoutEffect(() => {
    const node = list.current!;
    const measure = () => {
      const style = getComputedStyle(node);
      const rowHeight = Number.parseFloat(style.getPropertyValue('--book-row-height'));
      const borderHeight =
        Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
      setPageSize(
        Math.max(1, Math.floor((node.getBoundingClientRect().height - borderHeight) / rowHeight)),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);

  const sync = async () => {
    const reload = startReload('library', { reason: 'user' });
    try {
      const result = await api.request<LibraryView>('library.list');
      setView(result);
      reload.finish('ok', { count: result.books.length, issueCount: result.diagnostics.length });
    } catch (error) {
      reload.finish('failed');
      throw error;
    }
  };
  useEffect(() => {
    let active = true;
    const reload = startReload('library', refresh);
    void api.request<LibraryView>('library.list').then(
      (v) => {
        if (active) setView(v);
        reload.finish(active ? 'ok' : 'superseded', {
          count: v.books.length,
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
  }, [refresh]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError('');
    setBusy(true);
    try {
      const result = await api.request<Pick<BookSummary, 'id'>>('book.create', Object.fromEntries(form));
      await sync();
      setPosition({ query: '', start: 0, pageSize });
      setCreatedId(result.id);
      setCreate(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setError('');
    try {
      await api.request('book.delete', { bookId: id });
      await sync();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const normalizedQuery = norm(query);
  const books =
    view?.books.filter((book) =>
      [book.title, book.author ?? ''].some((value) => norm(value).includes(normalizedQuery)),
    ) ?? [];
  const pageCount = Math.max(1, Math.ceil(books.length / pageSize));
  const anchorId = createdId ?? (pageSize !== position.pageSize ? position.firstBookId : undefined);
  const anchorIndex = anchorId ? books.findIndex((book) => book.id === anchorId) : -1;
  const page = Math.min(
    pageCount - 1,
    Math.floor((anchorIndex >= 0 ? anchorIndex : position.start) / pageSize),
  );
  const start = page * pageSize;
  const firstBookId = books[start]?.id;

  useLayoutEffect(() => {
    if (!view) return;
    if (
      start !== position.start ||
      pageSize !== position.pageSize ||
      firstBookId !== position.firstBookId
    )
      setPosition({ query, start, pageSize, firstBookId });
    if (createdId) setCreatedId(undefined);
  }, [createdId, firstBookId, pageSize, position, query, setPosition, start, view]);

  function showPage(next: number) {
    const start = next * pageSize;
    setPosition({ query, start, pageSize, firstBookId: books[start]?.id });
  }

  return (
    <div className="library page-container">
      <div className="page-heading">
        <div>
          <p className="eyebrow">FICTION WRITER / 书库</p>
          <h1>书库</h1>
          <p className="muted">在这里开始故事，回到还没写完的那一页。</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setError('');
            setCreate(true);
          }}
        >
          <Icon name="plus" />
          新建小说
        </button>
      </div>
      <div className="tabline">
        <span className="current-tab">
          个人 <small>{view?.books.length ?? 0} 本</small>
        </span>
      </div>
      <label className="search-box">
        <Icon name="search" />
        <input
          aria-label="搜索书库"
          placeholder="搜索小说名或作者"
          value={query}
          onChange={(e) => setPosition({ query: e.target.value, start: 0, pageSize })}
        />
      </label>
      {!create && <ErrorText text={error} />}
      <section className="library-list surface" aria-label="个人书库" ref={list}>
        {books.slice(start, start + pageSize).map((b) => (
          <article key={b.id} className="book-row">
            <div className="book-mark">
              <Icon name="book" size={21} />
            </div>
            <div className="book-info">
              <button className="text-button book-title" title={b.title} onClick={() => open(b.id)}>
                {b.title}
              </button>
              <p className="book-summary">{b.summary}</p>
              {(b.author || b.genre) && (
                <small className="muted book-meta">
                  {[b.author, b.genre].filter(Boolean).join(' · ')}
                </small>
              )}
            </div>
            <div className="actions">
              <button onClick={() => open(b.id)} aria-label={`编辑 ${b.title}`}>
                <Icon name="edit" size={15} />
                编辑
              </button>
              <button
                className="icon-button destructive"
                aria-label={`删除 ${b.title}`}
                title="删除小说"
                onClick={() => void remove(b.id)}
              >
                <Icon name="trash" />
              </button>
            </div>
          </article>
        ))}
        {!books.length && (
          <div className="empty">
            <span className="book-mark">
              <Icon name={query ? 'search' : 'book'} size={23} />
            </span>
            <h2>{!view ? '正在读取书库…' : query ? '没有匹配的小说' : '还没有小说'}</h2>
            <p>{query ? '试试更短的小说名或作者关键词。' : '新建一本小说，开始整理故事和章节。'}</p>
          </div>
        )}
      </section>
      <footer className="library-foot">
        <span className="library-storage muted">
          <Icon name="folder" size={15} /> 作品以 Markdown 保存在本机
        </span>
        {!!view?.diagnostics.length && (
          <button className="text-button muted" onClick={() => setDiagnosticsOpen(true)}>
            书库读取提示 ({view.diagnostics.length})
          </button>
        )}
        {pageCount > 1 && (
          <nav aria-label="书库分页" className="library-pagination">
            <button disabled={page === 0} onClick={() => showPage(page - 1)}>
              上一页
            </button>
            <span aria-live="polite" className="muted">
              第 {page + 1} / {pageCount} 页
            </span>
            <button disabled={page + 1 === pageCount} onClick={() => showPage(page + 1)}>
              下一页
            </button>
          </nav>
        )}
      </footer>
      {diagnosticsOpen && (
        <Dialog title="书库读取提示" kicker="个人书库" close={() => setDiagnosticsOpen(false)}>
          <div className="diagnostics">
            {view?.diagnostics.map((message, index) => (
              <p key={index}>{message}</p>
            ))}
          </div>
        </Dialog>
      )}
      {create && (
        <Dialog
          title="新建小说"
          kicker="个人书库"
          close={() => {
            if (!busy) {
              setCreate(false);
              setError('');
            }
          }}
        >
          <form onSubmit={submit} className="form-grid">
            <label className="wide">
              小说名 <span className="required">*</span>
              <input name="title" required autoFocus placeholder="例如：潮汐之后" />
            </label>
            <label className="wide">
              简介 <span className="required">*</span>
              <textarea name="summary" required rows={4} placeholder="这个故事从哪里开始？" />
            </label>
            <label>
              题材 <span className="muted">· 选填</span>
              <input name="genre" placeholder="例如：科幻" />
            </label>
            <label>
              文风 <span className="muted">· 选填</span>
              <input name="style" placeholder="例如：简练、克制" />
            </label>
            <div className="wide">
              <ErrorText text={error} />
            </div>
            <footer className="wide dialog-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setCreate(false);
                  setError('');
                }}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                <Icon name="plus" />
                创建小说
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </div>
  );
}
