import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './bridge';
import { HarnessMarkdown } from './HarnessMarkdown';
import { ErrorText, Icon, errorDetails, norm } from './ui';
import type { ActiveChapter } from './Workspace';
import type {
  ChatLine,
  Effort,
  ModelProfile,
  RunInfo,
  RuntimeView,
  Session,
  StartRun,
  TaskOutcome,
} from '../shared/contracts';
const statuses = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
};
const taskOutcomes: Record<TaskOutcome, string> = {
  fulfilled: '已完成',
  no_write_needed: '已满足，无需写入',
  partial: '部分完成',
  incomplete: '未完成',
  cancelled: statuses.cancelled,
  interrupted: statuses.interrupted,
};
const roles = { user: '你', assistant: 'Agent', tool: '工具', status: '状态' };
const basename = (path: string) => path.split(/[\\/]/).at(-1) || path;

function runStatusLabel(run: RunInfo) {
  if (run.status === 'completed' && run.taskOutcome) return taskOutcomes[run.taskOutcome];
  return statuses[run.status];
}

function runStatusText(run: RunInfo) {
  let text = runStatusLabel(run);
  if (run.effort === 'default') text += ' · 使用模型默认思考设置';
  if (run.error) text += `：${run.error}`;
  if (run.status === 'running') return text;

  const { whole, local } = run.progress ?? {};
  const remaining = local?.remaining?.map(({ operation, id, part }) =>
    [operation, id, part].filter(Boolean).join('/'),
  );
  if (local?.omitted) remaining?.push(`另有 ${local.omitted} 项`);

  return [
    text,
    run.status === 'failed' && run.taskOutcome && `本轮交付${taskOutcomes[run.taskOutcome]}`,
    whole?.complete && '整书已齐',
    whole?.message && !whole.complete && !run.error?.includes(whole.message) && whole.message,
    whole && local?.remaining?.length === 0 && local.omitted === 0 && '局部事项已满足',
    remaining?.length && `待核对或提交：${remaining.join('、')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function ChatMessage({ line }: { line: ChatLine }) {
  return (
    <article className={`chat-line ${line.role}`}>
      <strong>{roles[line.role]}</strong>
      {line.role === 'assistant' ? (
        <HarnessMarkdown text={line.text} />
      ) : (
        <p className="chat-body">{line.text}</p>
      )}
    </article>
  );
}

function ToolActivity({ lines }: { lines: ChatLine[] }) {
  const pending = new Map<string, number>();
  let calls = 0;
  let unsuccessful = 0;
  let other = 0;
  // Saved tool rows contain display text only. Keep every row and count recognizable calls by name.
  for (const { text } of lines) {
    const start = /^运行 (.+)$/.exec(text);
    if (start) {
      const name = start[1];
      pending.set(name, (pending.get(name) ?? 0) + 1);
      calls++;
      continue;
    }
    const end = /^(.+) · (已完成|未完成)$/.exec(text);
    if (!end) {
      other++;
      continue;
    }
    const [, name, outcome] = end;
    const count = pending.get(name) ?? 0;
    if (count) pending.set(name, count - 1);
    else calls++;
    if (outcome === '未完成') unsuccessful++;
  }
  const unresolved = [...pending.values()].reduce((sum, count) => sum + count, 0);

  return (
    <details className="tool-activity">
      <summary>
        <strong>工具活动</strong>
        {calls > 0 && ` · ${calls} 次调用`}
        {other > 0 && ` · ${other} 条记录`}
        {unsuccessful > 0 && <span className="tool-activity-warning"> · {unsuccessful} 项未完成</span>}
        {unresolved > 0 && ` · ${unresolved} 项无结果`}
      </summary>
      <div className="tool-activity-details">
        {lines.map((line, i) => (
          <ChatMessage key={i} line={line} />
        ))}
      </div>
    </details>
  );
}

function ChatTranscript({ messages }: { messages: ChatLine[] }) {
  const entries: ReactNode[] = [];
  let i = 0;
  while (i < messages.length) {
    const start = i;
    const line = messages[i++];
    if (line.role === 'tool') {
      while (messages[i]?.role === 'tool') i++;
      entries.push(<ToolActivity key={start} lines={messages.slice(start, i)} />);
    } else {
      entries.push(<ChatMessage key={start} line={line} />);
    }
  }
  return entries;
}

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
type Conversation = 'new' | { id: string; pending?: Session };

export function Harness({
  open,
  close,
  view,
  ready,
  bookId,
  chapter,
  profiles,
  settings,
  backendError,
}: {
  open: boolean;
  close: () => void;
  view: RuntimeView;
  ready: boolean;
  bookId: string;
  chapter?: ActiveChapter;
  profiles: ModelProfile[];
  settings: () => void;
  backendError?: string;
}) {
  const [conversation, setConversation] = useState<Conversation>(),
    [historyOpen, setHistoryOpen] = useState(false),
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
  const submitting = useRef(false);
  const composing = useRef(false);
  const composerHint = useId();
  const sessions = view.sessions.filter((s) => s.session.bookId === bookId);
  const selection = typeof conversation === 'object' ? conversation : undefined;
  const current = sessions.find((s) => s.session.id === selection?.id);
  const session = current?.session ?? selection?.pending;
  const showList = historyOpen || (!session && conversation !== 'new' && sessions.length > 0);
  const search = norm(query);
  const rows = sessions
    .sort((a, b) => b.session.updated.localeCompare(a.session.updated))
    .filter((s) => norm(s.session.label).includes(search));
  const run = current?.run,
    running = run?.status === 'running',
    profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const hasChapter = !!chapter && chapter.bookId === bookId;
  const canSend = !!(
    ready &&
    !showList &&
    profile &&
    !session?.missing &&
    !busy &&
    !running &&
    prompt.trim()
  );
  useEffect(() => {
    if (current && selection?.pending) setConversation({ id: current.session.id });
  }, [current, selection]);
  useEffect(() => {
    if (!open && ready && !session && !sessions.length) setHistoryOpen(false);
  }, [open, ready, session, sessions.length]);
  useEffect(() => {
    if (open && ready && !showList && sticky.current && feed.current)
      feed.current.scrollTop = feed.current.scrollHeight;
  }, [open, ready, showList, current]);
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
  function openConversation(next: Conversation) {
    setConversation(next);
    setHistoryOpen(false);
    setError('');
    setFailureId(undefined);
    setAttachments([]);
    sticky.current = true;
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!canSend || !profile || submitting.current) return;
    const options: Omit<StartRun, 'id'> = {
      profileId: profile.id,
      prompt: prompt.trim(),
      effort,
      attachments: [...attachments],
      chapterId: hasChapter ? chapter.chapterId : undefined,
    };
    submitting.current = true;
    try {
      await perform(async () => {
        let target = session;
        if (!target) {
          setConversation('new');
          target = await api.request<Session>('session.create', { bookId });
          setConversation({ id: target.id, pending: target });
        }
        await api.request('session.start', { ...options, id: target.id });
        setPrompt('');
        setAttachments([]);
        sticky.current = true;
      });
    } finally {
      submitting.current = false;
    }
  }
  const remove = (id: string) =>
    perform(async () => {
      await api.request('session.delete', { id });
      if (selection?.id === id) {
        setConversation(undefined);
        setHistoryOpen(true);
        setAttachments([]);
      }
    });
  return (
    <aside className="harness" aria-label="AI 面板" hidden={!open}>
      <header className="harness-header">
        <div className="actions">
          <button
            className="icon-button"
            title="Session 历史"
            aria-label="Session 历史"
            aria-pressed={ready && showList}
            disabled={!ready || busy}
            onClick={() => setHistoryOpen(!showList)}
          >
            <Icon name="outline" />
          </button>
          <button
            className="icon-button"
            title="新建会话"
            aria-label="新建会话"
            onClick={() => {
              setPrompt('');
              openConversation('new');
            }}
            disabled={!ready || busy}
          >
            <Icon name="plus" />
          </button>
          <button className="icon-button" title="关闭 AI 侧栏" aria-label="关闭 AI 侧栏" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
      </header>
      {!ready ? (
        <div className="session-list">
          {backendError ? (
            <ErrorText text={backendError} />
          ) : (
            <p className="muted" role="status">
              正在加载会话…
            </p>
          )}
        </div>
      ) : showList ? (
        <section className="session-list scroll-region" aria-label="会话列表" tabIndex={0}>
          <h3>Session 历史</h3>
          <label className="search-box">
            <Icon name="search" />
            <input
              aria-label="查找会话"
              placeholder="按会话名称查找"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {rows.map(({ session, run }) => (
            <div className="session-row" key={session.id}>
              <button
                className="session-link text-button"
                onClick={() => openConversation({ id: session.id })}
              >
                <strong>{session.label}</strong>
                <small title={session.cwd}>
                  {session.missing ? '工作区不可用' : run ? runStatusLabel(run) : basename(session.cwd)}
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
            <div className="empty-mini">
              {sessions.length ? '没有匹配的会话' : '这本小说还没有会话。'}
            </div>
          )}
          <ErrorText text={error || backendError} />
          <DiagnosticId id={failureId} />
        </section>
      ) : (
        <>
          <div className="session-context">
            <div>
              <strong>{session?.label ?? '新会话'}</strong>
              {session && (
                <small title={session.cwd}>
                  <Icon name="folder" size={13} />
                  {session.cwd}
                </small>
              )}
            </div>
            {session && (
              <button
                className="icon-button destructive"
                aria-label={`删除会话 ${session.label}`}
                onClick={() => void remove(session.id)}
                disabled={busy}
              >
                <Icon name="trash" size={15} />
              </button>
            )}
          </div>
          <div
            className="chat-feed scroll-region"
            ref={feed}
            onScroll={(e) => {
              const node = e.currentTarget;
              sticky.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
            }}
            aria-label="对话消息"
            role="region"
            tabIndex={0}
          >
            {current && <ChatTranscript key={current.session.id} messages={current.messages} />}
            {current?.streaming && <ChatMessage line={{ role: 'assistant', text: current.streaming }} />}
            {!current?.messages.length && (
              <div className="chat-empty">
                <span className="book-mark">
                  <Icon name="spark" size={21} />
                </span>
                <h3>和作品一起思考</h3>
                <p>直接说你想做什么：讨论故事、维护资料、写一章或写整本。</p>
              </div>
            )}
            {run && (
              <p className={`run-status ${running ? 'running' : ''}`} role="status">
                {runStatusText(run)}
              </p>
            )}
          </div>
          <form className="composer" onSubmit={(e) => void send(e)}>
            <div className="composer-details scroll-region">
              <ErrorText text={error || backendError} />
              <DiagnosticId
                id={
                  failureId ??
                  (run?.status === 'failed' || run?.status === 'interrupted' ? run.id : undefined)
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
              {session?.missing && <p className="notice">工作区已删除或不可用，历史仍可查看。</p>}
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
            </div>
            <textarea
              aria-label="给 Agent 的消息"
              aria-describedby={composerHint}
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onBlur={() => {
                composing.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
                if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                  return;
                e.preventDefault();
                if (!e.repeat && canSend && !submitting.current) e.currentTarget.form?.requestSubmit();
              }}
              placeholder="和 Agent 讨论当前作品…"
            />
            <small id={composerHint} className="muted">
              Enter 发送 · Shift+Enter 换行
            </small>
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
              {running && session ? (
                <button
                  type="button"
                  onClick={() =>
                    void perform(async () => {
                      await api.request('session.stop', { id: session.id });
                    })
                  }
                  disabled={busy}
                >
                  停止
                </button>
              ) : (
                <button className="primary send" type="submit" aria-label="发送" disabled={!canSend}>
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
