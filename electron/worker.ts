import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { RpcRequest } from '../shared/rpc.js';
import type { Change, DocRef, Manuscript, StartRun } from '../shared/contracts.js';
import { WorkspaceService } from './workspace.js';
import { Journal } from './journal.js';
import { RunManager } from './agent/runs.js';
import { Gate, ScriptedProvider } from './agent/scripted.js';
import { draftChapter } from './agent/draft.js';
import { ProfileStore } from './agent/profiles.js';
import { createProvider, checkProvider } from './agent/provider.js';
import { FileTools } from './agent/files.js';
import { runAgent } from './agent/loop.js';
import type { Turn } from './agent/model.js';
import { applySkill, loadSkills } from './agent/skills.js';
import { NovelTools } from './agent/novel-tools.js';
import { WorkflowStore } from './agent/workflow.js';
import {
  diagnosticScope,
  isDiagnosticMethod,
  type DiagnosticFields,
  type ReportDiagnostic,
} from '../shared/diagnostics.js';
import {
  classified,
  DiagnosticFailure,
  elapsed,
  responseDiagnostic,
  safeReporter,
} from './diagnostics/trace.js';
const port = process.parentPort;
if (!port) throw new Error('Missing Electron parent port');
const [libraryRoot, stateRoot, mode, skillsPath] = process.argv.slice(2);
if (!libraryRoot || !stateRoot || !skillsPath) throw new Error('Missing worker roots');
const test = mode === 'test';
function post(message: unknown) {
  port!.postMessage(message);
}
const diagnostic: ReportDiagnostic = safeReporter((event, fields) =>
  post({ diagnostic: { event, fields } }),
);
const journal = new Journal((event) => post({ event }));
const workspace = new WorkspaceService({
  libraryRoot,
  onChange: (bookId, documents, changeId) =>
    journal.emit({ type: 'book-change', bookId, documents, changeId }),
});
const workflows = new WorkflowStore(
  stateRoot,
  (bookId) => journal.emit({ type: 'runtime-change', bookId }),
  diagnostic,
);
const runs = new RunManager(stateRoot, journal, (bookId) => workflows.progress(bookId), diagnostic);
let secretTicket = 0;
const pendingSecrets = new Map<
  number,
  {
    resolve: (key: string) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function decrypt(cipher: string, requestId?: string) {
  const ticket = ++secretTicket;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSecrets.delete(ticket);
      reject(new DiagnosticFailure('credential_unavailable', '无法读取系统凭据'));
    }, 6000);
    pendingSecrets.set(ticket, { resolve, reject, timer });
    post({ secretTicket: ticket, cipher, requestId });
  });
}
const profiles = new ProfileStore(stateRoot, decrypt);
function invalidate(reason: 'watcher' | 'command', bookId?: string, report = diagnostic) {
  const changeId = randomUUID();
  const journalSeq = journal.emit({ type: 'book-change', bookId, changeId });
  report('workspace.notified', { journalSeq, changeId, workspaceRef: bookId, reason });
}
const files = new FileTools(workspace, stateRoot, (report) => invalidate('command', undefined, report));
let closeWatcher: (() => void) | undefined;
const ready = Promise.all([workspace.init(), runs.init(), workflows.init()]).then(() => {
  closeWatcher = workspace.watchExternal((bookId) => invalidate('watcher', bookId));
  diagnostic('worker.ready', { pid: process.pid });
});
void ready.catch(() => diagnostic('worker.initialization_failed', { reason: 'initialization_failed' }));
const profileInit = profiles.init().then(
  () => undefined,
  (error) => error as Error,
);
async function ensureProfiles() {
  const error = await profileInit;
  if (error) throw error;
}

async function startSession(args: StartRun, report: ReportDiagnostic, requestId?: string) {
  const { id, profileId, action = 'chat', chapterId, attachments, effort = 'high' } = args;
  const view = runs.get(id);
  await ensureProfiles();
  if (!profileId) throw new DiagnosticFailure('profile_missing', '请选择已保存的模型配置');
  if (
    !['low', 'medium', 'high'].includes(effort) ||
    !['chat', 'draft', 'append', 'replace', 'novel'].includes(action)
  )
    throw new DiagnosticFailure('invalid_options', '运行选项无效');
  if (view.session.missing || !(await stat(view.session.cwd).catch(() => undefined))?.isDirectory())
    throw new DiagnosticFailure('unavailable', '工作区已不存在');
  if (view.session.bookId)
    await workspace.readDocument(view.session.bookId, { type: 'book', id: view.session.bookId });
  const prompt = args.prompt?.trim() ?? '';
  if ((action === 'chat' && !prompt) || prompt.length > 24_000)
    throw new DiagnosticFailure('input_validation', '请输入任务，且不超过 24,000 字符');
  const [{ profile, key }, references] = await Promise.all([
    profiles.resolve(profileId, requestId),
    files.attachments(attachments).catch((error) => {
      throw new DiagnosticFailure(
        'attachment_invalid',
        error instanceof Error ? error.message : '无法读取附件',
      );
    }),
  ]);
  const provider = createProvider(profile, key, effort);
  const skills = view.session.bookId
    ? await loadSkills(
        skillsPath,
        diagnosticScope(report, { workspaceRef: view.session.bookId, sessionRef: view.session.id }),
      )
    : undefined;
  const referenceContext = references.length
    ? `用户附加的参考文件（文本数据）：\n${JSON.stringify(references)}`
    : '';
  let request = [prompt, referenceContext].filter(Boolean).join('\n\n');
  let previous: Turn[] = view.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-12)
    .map((m) =>
      m.role === 'user'
        ? { role: 'user', text: m.text.slice(0, 16_000) }
        : { role: 'assistant', text: m.text.slice(0, 16_000), calls: [] },
    );
  if (profile.protocol === 'chat' && /^deepseek-v4-/.test(profile.model) && previous.length) {
    request = `会话上下文（前几轮的文本记录，不含工具状态）：\n${JSON.stringify(previous)}\n\n本轮：\n${request}`;
    previous = [];
  }
  const label =
    prompt ||
    { chat: '对话', draft: '生成本章', append: '续写本章', replace: '重写本章', novel: '生成全书' }[
      action
    ];
  if (action === 'novel' && !view.session.bookId)
    throw new DiagnosticFailure('invalid_options', '整书生成需要绑定一部小说');
  if (action !== 'chat' && action !== 'novel' && (!chapterId || !view.session.bookId))
    throw new DiagnosticFailure('invalid_options', '请在此会话绑定的小说中选择章节');
  return runs.start(
    id,
    label,
    async (ctx) => {
      if (action === 'novel') {
        await workflows.run(
          workspace,
          ctx,
          provider,
          skills!,
          prompt,
          args.restartWorkflow === true,
          referenceContext,
        );
        await ctx.line({ role: 'assistant', text: '全书生成完成。已经写过的章节保持原样。' });
        return;
      }
      if (action !== 'chat') {
        await draftChapter(workspace, ctx, provider, chapterId!, action, request, {
          skill: skills?.chapter,
        });
        await ctx.line({ role: 'assistant', text: '章节已保存。' });
        return;
      }
      let system =
        '你是 Fiction Writer 的本地 Agent。遵循用户任务，只在当前选定的工作目录内工作。需要修改时使用工具，不能仅声称已经完成。工具出错时说明或修正。';
      let tools = files.tools();
      if (ctx.session.bookId && chapterId) system += `\n本轮开始时作者选中的章节 ID：${chapterId}。`;
      if (ctx.session.bookId && skills) {
        system += `\n当前目录是小说作品。用专用工具读和改故事，不要询问不必要的确认。\n故事一致性规则：\n${skills.consistency}`;
        tools = [
          ...tools.filter((tool) => ['list_files', 'search_text', 'read_file'].includes(tool.name)),
          ...new NovelTools(workspace, ctx.session.bookId, provider, skills).tools(),
        ];
      }
      await runAgent(
        ctx,
        provider,
        system,
        previous,
        request,
        tools,
        undefined,
        skills && ((report) => applySkill(report, 'story-consistency', skills.consistency, 'agent')),
      );
    },
    provider.effort,
    report,
    action,
  );
}
const gates = new Map<string, Gate>();
async function createSession(bookId?: string, cwd?: string, report = diagnostic) {
  if (bookId) {
    const book = await workspace.readDocument(bookId, { type: 'book', id: bookId });
    return runs.create(
      { cwd: await realpath(workspace.bookRoot(bookId)), bookId },
      book.fields.title ?? '小说',
      report,
    );
  }
  if (!cwd || !(await stat(cwd)).isDirectory()) throw new Error('请选择工作目录');
  return runs.create(
    { cwd: await realpath(cwd) },
    cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd,
    report,
  );
}
async function handle(
  method: string,
  args: any,
  report: ReportDiagnostic,
  requestId?: string,
): Promise<unknown> {
  await ready;
  switch (method) {
    case 'ping':
      return { pid: process.pid, libraryRoot };
    case 'library.list':
      return workspace.listBooks();
    case 'book.create':
      return workspace.createBook(args, report);
    case 'book.read':
      return workspace.readBook(args.bookId);
    case 'book.doc.read':
      return workspace.readDocument(args.bookId, args.doc as DocRef);
    case 'book.doc.write':
      return workspace.writeDocument(args.bookId, args.doc as Manuscript, undefined, report);
    case 'book.changes.write':
      return workspace.writeChanges(args.bookId, args.changes as Change[], undefined, [], report);
    case 'book.doc.delete':
      return workspace.deleteDocument(args.bookId, args.doc as DocRef, undefined, report);
    case 'book.delete': {
      await runs.removeTarget(
        await realpath(workspace.bookRoot(args.bookId)),
        () => workspace.deleteBook(args.bookId, report),
        report,
      );
      await workflows.remove(args.bookId);
      return;
    }
    case 'runtime.snapshot':
      return runs.snapshot();
    case 'runtime.after':
      return journal.after(args.cursor);
    case 'session.create':
      return createSession(args?.bookId, args?.cwd, report);
    case 'session.start':
      try {
        return await startSession(args, report, requestId);
      } catch (error) {
        const action = args?.action ?? 'chat';
        report('run.rejected', {
          action: ['chat', 'draft', 'append', 'replace', 'novel'].includes(action) ? action : undefined,
          reason: classified(error),
        });
        throw error;
      }
    case 'profiles.list':
      await ensureProfiles();
      return profiles.list();
    case 'profiles.save': {
      await ensureProfiles();
      const profile = await profiles.save(args);
      journal.emit({ type: 'profiles-change' });
      return profile;
    }
    case 'profiles.check': {
      await ensureProfiles();
      const { profile, key } = await profiles.resolve(args.id, requestId);
      return checkProvider(profile, key, AbortSignal.timeout(58_000), report);
    }
    case 'session.stop':
      return runs.stop(args.id, report);
    case 'session.delete':
      return runs.remove(args.id, report);
    case 'shutdown':
      closeWatcher?.();
      return runs.stopAll();
    case 'test.crash': {
      if (!test) throw new Error('仅在 E2E 模式可用');
      process.exit(23);
    }
    case 'test.start': {
      if (!test) throw new Error('仅在 E2E 模式可用');
      const { bookId, chapterId, addSubject = true } = args;
      const session = await createSession(bookId);
      const gate = new Gate(),
        finish = new Gate();
      gates.set(`${session.id}:next`, gate);
      gates.set(`${session.id}:finish`, finish);
      const { runId } = runs.start(
        session.id,
        '测试章节续写',
        async (ctx) => {
          try {
            if (addSubject) {
              const report = await workspace.writeChanges(
                bookId,
                [
                  {
                    type: 'subject',
                    id: 'tidal-key',
                    expect: null,
                    fields: { name: '潮汐钥匙', kind: 'item' },
                    body: '等待潮水退去时出现。',
                  },
                ],
                ctx.signal,
                [],
                ctx.diagnostic,
              );
              if (report.error) throw new Error(report.error);
            }
            const provider = new ScriptedProvider([
              async ({ onText, signal }) => {
                onText('海面亮了。');
                await gate.wait(signal);
                onText('潮水开始退却。');
                await finish.wait(signal);
                if (args.fail) throw new Error('测试模型中断');
                return { role: 'assistant', text: '海面亮了。潮水开始退却。', calls: [] };
              },
            ]);
            await draftChapter(workspace, ctx, provider, chapterId, 'append', '续写一个潮汐场景');
          } finally {
            gates.delete(`${session.id}:next`);
            gates.delete(`${session.id}:finish`);
          }
        },
        'high',
      );
      return { sessionId: session.id, runId };
    }
    case 'test.release': {
      if (!test) throw new Error('仅在 E2E 模式可用');
      gates.get(`${args.sessionId}:${args.step}`)?.release();
      return true;
    }
    default:
      throw new Error(`未知请求：${method}`);
  }
}
port.on(
  'message',
  async ({ data }: { data: RpcRequest | { secretTicket: number; key?: string; error?: string } }) => {
    if ('secretTicket' in data) {
      const pending = pendingSecrets.get(data.secretTicket);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingSecrets.delete(data.secretTicket);
      if (data.key) pending.resolve(data.key);
      else
        pending.reject(
          new DiagnosticFailure('credential_unavailable', data.error || '无法解密 API Key'),
        );
      return;
    }
    const tracked = isDiagnosticMethod(data.method),
      started = performance.now();
    const report = diagnosticScope(diagnostic, { requestId: data.requestId });
    if (tracked) report('ipc.worker.started', { method: data.method });
    let outcome = 'ok',
      reason: string | undefined;
    let responseFields: DiagnosticFields = {};
    try {
      const result = await handle(data.method, data.args, report, data.requestId);
      if (tracked) responseFields = responseDiagnostic(data.method, result);
      post({ id: data.id, result });
    } catch (error) {
      outcome = 'failed';
      reason = classified(error);
      post({ id: data.id, error: error instanceof Error ? error.message : '后台请求失败', reason });
    } finally {
      if (tracked)
        report('ipc.worker.finished', {
          method: data.method,
          outcome,
          reason,
          ...responseFields,
          elapsedMs: elapsed(started),
        });
    }
  },
);
