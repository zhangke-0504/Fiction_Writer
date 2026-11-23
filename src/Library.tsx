import { useEffect, useState, type FormEvent } from 'react';
import type { LibraryView } from '../shared/contracts';
import { api } from './bridge';
import { Dialog, ErrorText, Icon, errorMessage, norm } from './ui';
export function Library({ refresh, open }: { refresh: number; open: (id: string) => void }) {
  const [view, setView] = useState<LibraryView>(),
    [query, setQuery] = useState(''),
    [create, setCreate] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const sync = async () => setView(await api.request<LibraryView>('library.list'));
  useEffect(() => {
    let active = true;
    void api.request<LibraryView>('library.list').then(
      (v) => {
        if (active) setView(v);
      },
      (e) => {
        if (active) setError(errorMessage(e));
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
      await api.request('book.create', Object.fromEntries(form));
      await sync();
      setCreate(false);
      setQuery('');
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
  const books =
    view?.books.filter((b) =>
      [b.title, b.author ?? ''].some((text) => norm(text).includes(norm(query))),
    ) ?? [];
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
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {!create && <ErrorText text={error} />}
      <section className="library-list surface" aria-label="个人书库">
        {books.map((b) => (
          <article key={b.id} className="book-row">
            <div className="book-mark">
              <Icon name="book" size={21} />
            </div>
            <div className="book-info">
              <button className="text-button book-title" onClick={() => open(b.id)}>
                {b.title}
              </button>
              <p className="book-summary">{b.summary}</p>
              {(b.author || b.genre) && (
                <small className="muted">{[b.author, b.genre].filter(Boolean).join(' · ')}</small>
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
      {!!view?.diagnostics.length && (
        <details className="diagnostics">
          <summary>书库读取提示 ({view.diagnostics.length})</summary>
          {view.diagnostics.map((d) => (
            <p key={d}>{d}</p>
          ))}
        </details>
      )}
      <p className="library-foot muted">
        <Icon name="folder" size={15} /> 作品以 Markdown 保存在本机
      </p>
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
