import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './bridge';
import { ErrorText, Icon, errorDetails, norm } from './ui';
import type { ActiveChapter } from './Workspace';
import type { Effort, ModelProfile, RuntimeView, Session, StartRun } from '../shared/contracts';
const statuses = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
};
const roles = { user: '你', assistant: 'Agent', tool: '工具', status: '状态' };
const basename = (path: string) => path.split(/[\\/]/).at(-1) || path;
function DiagnosticId({ id }: { id?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [id]);
  if (!id) return null;
  return (
    <p className="muted diagnostic-id">
      <code aria-label="诊断编号">{id}</code>
      <button
        type="button"
        className="text-button"
        onClick={() => {
          void navigator.clipboard.writeText(id).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? '已复制' : '复制诊断编号'}
      </button>
    </p>
  );
}
export function Harness({
  open,
  close,
  view,
  bookId,
  chapter,
  profiles,
  settings,
  backendError,
}: {
  open: boolean;
  close: () => void;
  view: RuntimeView;
  bookId: string;
  chapter?: ActiveChapter;
  profiles: ModelProfile[];
  settings: () => void;
  backendError?: string;
}) {
  const [selectedId, select] = useState(''),
    [list, setList] = useState(true),
    [query, setQuery] = useState('');
  const [prompt, setPrompt] = useState(''),
    [profileId, setProfile] = useState(''),
    [effort, setEffort] = useState<Effort>('high');
  const [attachments, setAttachments] = useState<string[]>([]),
    [error, setError] = useState(''),
    [failureId, setFailureId] = useState<string>(),
    [busy, setBusy] = useState(false);
  const feed = useRef<HTMLDivElement>(null),
    sticky = useRef(true);
  const sessions = view.sessions.filter((s) => s.session.bookId === bookId);
  const current = sessions.find((s) => s.session.id === selectedId);
  const rows = sessions
    .sort((a, b) => b.session.updated.localeCompare(a.session.updated))
    .filter((s) => norm(`${s.session.label} ${s.session.cwd}`).includes(norm(query)));
  const running = current?.run?.status === 'running',
    profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const hasChapter = !!chapter && chapter.bookId === bookId;
  useEffect(() => {
    if (open && !list && sticky.current && feed.current)
      feed.current.scrollTop = feed.current.scrollHeight;
  }, [open, list, current]);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setFailureId(undefined);
    try {
      await work();
    } catch (e) {
      const failure = errorDetails(e);
      setError(failure.message);
      setFailureId(failure.requestId);
    } finally {
      setBusy(false);
    }
  }
  function selectSession(id: string) {
    select(id);
    setList(false);
    setError('');
    setFailureId(undefined);
    setAttachments([]);
    sticky.current = true;
  }
  async function create() {
    await perform(async () => {
      const created = await api.request<Session>('session.create', { bookId });
      selectSession(created.id);
    });
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!current || !profile || busy || running || !prompt.trim()) return;
    await perform(async () => {
      const args: StartRun = {
        id: current.session.id,
        profileId: profile.id,
        prompt: prompt.trim(),
        effort,
        attachments: [...attachments],
        chapterId: hasChapter ? chapter.chapterId : undefined,
      };
      await api.request('session.start', args);
      setPrompt('');
      setAttachments([]);
      sticky.current = true;
    });
  }
  const remove = (id: string) =>
    perform(async () => {
      await api.request('session.delete', { id });
      if (selectedId === id) {
        select('');
        setList(true);
        setAttachments([]);
      }
    });
  const showList = list || !current;
  const progress = current?.run?.progress;
  return (
    <aside className="harness" aria-label="Harness 面板" hidden={!open}>
      <header className="harness-header">
        <div>
          <p className="eyebrow">本地协作</p>
          <h2>Harness</h2>
        </div>
        <div className="actions">
          <button
            className="icon-button"
            title="Session 历史"
            aria-label="Session 历史"
            aria-pressed={showList}
            onClick={() => {
              if (current) setList(!list);
              else setList(true);
            }}
          >
            <Icon name="outline" />
          </button>
          <button
            className="icon-button"
            title="新建会话"
            aria-label="新建会话"
            onClick={() => void create()}
            disabled={busy}
          >
            <Icon name="plus" />
          </button>
          <button className="icon-button" title="关闭 Harness" aria-label="关闭 Harness" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      {showList ? (
        <section className="session-list">
          <h3>Session 历史</h3>
          <label className="search-box">
            <Icon name="search" />
            <input
              aria-label="查找会话"
              placeholder="按名称或目录查找"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="session-actions">
            <button className="primary" onClick={() => void create()} disabled={busy}>
              <Icon name="plus" size={15} />
              当前小说会话
            </button>
          </div>
          {rows.map(({ session, run }) => (
            <div className="session-row" key={session.id}>
              <button className="session-link text-button" onClick={() => selectSession(session.id)}>
                <strong>{session.label}</strong>
                <small title={session.cwd}>
                  {session.missing ? '工作区不可用' : run ? statuses[run.status] : basename(session.cwd)}
                </small>
              </button>
              <button
                className="icon-button destructive"
                aria-label={`删除会话 ${session.label}`}
                onClick={() => void remove(session.id)}
                disabled={busy}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
          {!rows.length && (
            <div className="empty-mini">{query ? '没有匹配的会话' : '这本小说还没有会话。'}</div>
          )}
          <ErrorText text={error || backendError} />
          <DiagnosticId id={failureId} />
        </section>
      ) : (
        <>
          <div className="session-context">
            <div>
              <strong>{current.session.label}</strong>
              <small title={current.session.cwd}>
                <Icon name="folder" size={13} />
                {current.session.cwd}
              </small>
            </div>
            <button
              className="icon-button destructive"
              aria-label={`删除会话 ${current.session.label}`}
              onClick={() => void remove(current.session.id)}
              disabled={busy}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
          <div
            className="chat-feed"
            ref={feed}
            onScroll={(e) => {
              const node = e.currentTarget;
              sticky.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
            }}
            aria-label="对话消息"
          >
            {current.messages.map((line, i) => (
              <article className={`chat-line ${line.role}`} key={i}>
                <strong>{roles[line.role]}</strong>
                <p>{line.text}</p>
              </article>
            ))}
            {current.streaming && (
              <article className="chat-line assistant">
                <strong>Agent</strong>
                <p>{current.streaming}</p>
              </article>
            )}
            {!current.messages.length && (
              <div className="chat-empty">
                <span className="book-mark">
                  <Icon name="spark" size={21} />
                </span>
                <h3>和作品一起思考</h3>
                <p>直接说你想做什么：讨论故事、维护资料、写一章或写整本。</p>
              </div>
            )}
            {progress && (
              <div className="writing-progress">
                <strong>{progress.step}</strong>
                <span>
                  {progress.done} / {progress.total}
                </span>
                {progress.message && <p>{progress.message}</p>}
              </div>
            )}
            {current.run && (
              <p className={`run-status ${running ? 'running' : ''}`} role="status">
                {statuses[current.run.status]}
                {current.run.effort === 'default' ? ' · 使用模型默认思考设置' : ''}
                {current.run.error ? `：${current.run.error}` : ''}
              </p>
            )}
          </div>
          <form className="composer" onSubmit={(e) => void send(e)}>
            <ErrorText text={error || backendError} />
            <DiagnosticId
              id={
                failureId ??
                (current.run?.status === 'failed' || current.run?.status === 'interrupted'
                  ? current.run.id
                  : undefined)
              }
            />
            {!profile && (
              <p className="composer-note">
                尚未配置模型。
                <button type="button" className="text-button" onClick={settings}>
                  前往设置
                </button>
              </p>
            )}
            {current.session.missing && <p className="notice">工作区已删除或不可用，历史仍可查看。</p>}
            {!!attachments.length && (
              <div className="attachment-list">
                {attachments.map((path) => (
                  <button
                    type="button"
                    title={path}
                    className="attachment"
                    key={path}
                    onClick={() => setAttachments((a) => a.filter((f) => f !== path))}
                  >
                    {basename(path)} <Icon name="close" size={13} />
                  </button>
                ))}
              </div>
            )}
            <textarea
              aria-label="给 Agent 的消息"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="和 Agent 讨论当前作品…"
            />
            <div className="composer-options">
              <button
                type="button"
                className="icon-button"
                aria-label="添加参考文件"
                title="添加参考文件"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const paths = await api.request<string[]>('picker.files');
                    setAttachments((a) => [...new Set([...a, ...paths])]);
                  })
                }
              >
                <Icon name="attach" />
              </button>
              <select
                aria-label="模型"
                value={profile?.id ?? ''}
                onChange={(e) => setProfile(e.target.value)}
              >
                {!profiles.length && <option value="">无模型</option>}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="思考等级"
                value={effort}
                onChange={(e) => setEffort(e.target.value as Effort)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              {running ? (
                <button
                  type="button"
                  onClick={() =>
                    void perform(async () => {
                      await api.request('session.stop', { id: current.session.id });
                    })
                  }
                  disabled={busy}
                >
                  停止
                </button>
              ) : (
                <button
                  className="primary send"
                  type="submit"
                  aria-label="发送"
                  disabled={!profile || busy || !!current.session.missing || !prompt.trim()}
                >
                  <Icon name="send" size={16} />
                  发送
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
