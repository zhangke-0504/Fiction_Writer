import {
  diagnosticScope,
  noDiagnostic,
  requestIdPattern,
  type ReportDiagnostic,
} from '../../shared/diagnostics.js';
import { classified, DiagnosticFailure, elapsed, safeReporter } from '../diagnostics/trace.js';
import { applySkill } from './skills.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Change, DocRef, Fields, Manuscript, WorkProgress } from '../../shared/contracts.js';
import { digest, docKey, isId, renderDocument, storyBeats } from '../documents.js';
import type { WorkspaceService } from '../workspace.js';
import { draftChapter } from './draft.js';
import type { RunContext } from './runs.js';
import type { ModelProvider } from './model.js';
import type { WritingSkills } from './skills.js';

const phases = [
  '确定全书大纲',
  '生成主体',
  '生成伏笔',
  '生成目录并绑定伏笔',
  '逐章生成正文',
  '全书生成完成',
];
const phaseTags = ['outline', 'subjects', 'clues', 'catalog', 'chapters', 'finished'] as const;
type Phase = (typeof phaseTags)[number];
// A book UUID is assigned at creation. This fingerprint identifies its checkpoint slot across boots,
// without persisting another key or making ordinary user-named paths linkable across boots.
const jobRef = (bookId: string) =>
  requestIdPattern.test(bookId)
    ? digest(`fiction-writer/checkpoint\0${bookId}`).slice(0, 16)
    : undefined;
const chapterRef = (id: string) => docKey({ type: 'chapter', id });
const workflowTrace = (ctx: RunContext) => safeReporter(ctx.diagnostic ?? noDiagnostic);
const workflowOutcome = (reason: string) =>
  reason === 'cancelled'
    ? 'cancelled'
    : reason === 'checkpoint_conflict' || reason === 'conflict'
      ? 'conflict'
      : 'failed';
async function stage(
  ctx: RunContext,
  phase: Phase,
  work: (ctx: RunContext) => Promise<string | undefined>,
  documentRef?: string,
) {
  const report = diagnosticScope(workflowTrace(ctx), { spanId: randomUUID(), phase, documentRef });
  const started = performance.now();
  report('workflow.stage.started');
  try {
    const reason = await work({ ...ctx, diagnostic: report });
    report('workflow.stage.finished', {
      outcome: reason ? 'skipped' : 'ok',
      reason,
      elapsedMs: elapsed(started),
    });
  } catch (error) {
    const reason = classified(error, ctx.signal);
    report('workflow.stage.finished', {
      outcome: workflowOutcome(reason),
      reason,
      elapsedMs: elapsed(started),
    });
    throw error;
  }
}
type Write = Extract<Change, { fields: Fields }>;
type PlanRow = DocRef & { before: string | null; after: string };
interface Plan {
  rows: PlanRow[];
  chapter?: string;
}
interface Checkpoint {
  version: 1;
  bookId: string;
  phase: number;
  direction?: string;
  known: Record<string, string>;
  chapters: string[];
  handled: string[];
  plan?: Plan;
  progress: WorkProgress;
}
class CheckpointConflict extends DiagnosticFailure {
  constructor(message: string) {
    super('checkpoint_conflict', message);
  }
}
function documentList(docs: Manuscript[]) {
  return docs.map((d) => ({
    type: d.type,
    id: d.id,
    ...d.fields,
    ...(d.type !== 'chapter' ? { body: d.body.slice(0, d.type === 'outline' ? 20_000 : 1500) } : {}),
  }));
}
function summary(checkpoint: Checkpoint, status?: Partial<WorkProgress>): WorkProgress {
  const drafted = checkpoint.handled.length,
    count = checkpoint.chapters.length;
  return {
    step: phases[checkpoint.phase],
    done: Math.min(checkpoint.phase, 4) + drafted,
    total: 4 + count,
    complete: checkpoint.phase === 5,
    ...status,
  };
}
const stamp = (docs: Manuscript[]) => Object.fromEntries(docs.map((d) => [docKey(d), d.revision]));
const selected = (docs: Manuscript[], type: Manuscript['type']) => docs.filter((d) => d.type === type);
const docId = (row: Record<string, unknown>) => {
  if (!isId(row.id)) throw new Error('模型产物缺少有效的稳定 ID');
  return row.id;
};
function JSONRows(text: string, name: string): Record<string, unknown>[] {
  let data: unknown;
  try {
    data = JSON.parse(text.trim().replace(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i, '$1'));
  } catch {
    throw new Error(`模型未输出有效的 ${name} JSON`);
  }
  const parsed =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)[name]
      : undefined;
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.length > 80 ||
    parsed.some((d) => !d || typeof d !== 'object' || Array.isArray(d))
  )
    throw new Error(`${name} 需要 1–80 项有效数据`);
  return parsed;
}
function bodyOf(row: Record<string, unknown>) {
  if (typeof row.body !== 'string' || !row.body.trim()) throw new Error('模型产物缺少资料说明');
  return row.body;
}

/** Checkpoints store only phase, stable IDs and fingerprints, never a copy of a manuscript. */
export class WorkflowStore {
  private readonly values = new Map<string, Checkpoint>();
  private readonly folder: string;
  constructor(
    root: string,
    private readonly onChange: (bookId: string) => void = () => {},
    private readonly diagnostic: ReportDiagnostic = noDiagnostic,
  ) {
    this.folder = join(root, 'workflows');
  }
  async init() {
    await mkdir(this.folder, { recursive: true });
    for (const file of await readdir(this.folder)) {
      const id = file.endsWith('.json') ? file.slice(0, -5) : undefined;
      if (!isId(id)) continue;
      const trace = diagnosticScope(safeReporter(this.diagnostic), {
        workspaceRef: id,
        jobRef: jobRef(id),
        lane: 'workflow',
      });
      try {
        const record: Checkpoint = JSON.parse(await readFile(join(this.folder, file), 'utf8'));
        if (
          record.version !== 1 ||
          record.bookId !== id ||
          !Number.isInteger(record.phase) ||
          record.phase < 0 ||
          record.phase > 5 ||
          (record.direction !== undefined && typeof record.direction !== 'string') ||
          !record.known ||
          !Array.isArray(record.handled) ||
          !Array.isArray(record.chapters)
        )
          throw new Error();
        this.values.set(id, record);
        trace('workflow.checkpoint', {
          operation: 'open',
          phase: phaseTags[record.phase],
          outcome: 'ok',
          done: summary(record).done,
          total: summary(record).total,
        });
      } catch {
        trace('workflow.checkpoint', {
          operation: 'open',
          outcome: 'failed',
          reason: 'checkpoint_invalid',
        });
        this.values.set(id, {
          version: 1,
          bookId: id,
          phase: 0,
          known: {},
          handled: [],
          chapters: [],
          progress: {
            step: '检查点不可读',
            done: 0,
            total: 4,
            blocked: true,
            message: '检查点不可读，可显式按现稿另开计划。',
          },
        });
      }
    }
  }
  progress(bookId?: string) {
    const value = bookId ? this.values.get(bookId)?.progress : undefined;
    return value ? { ...value } : undefined;
  }
  async remove(bookId: string) {
    if (!isId(bookId)) throw new Error('无效作品 ID');
    await unlink(join(this.folder, `${bookId}.json`)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.values.delete(bookId);
    this.onChange(bookId);
  }
  private async save(state: Checkpoint, ctx: RunContext, status?: Partial<WorkProgress>) {
    const report = workflowTrace(ctx),
      started = performance.now();
    state.progress = summary(state, status);
    const name = join(this.folder, `${state.bookId}.json`),
      temp = name + `.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
      await rename(temp, name);
    } catch (error) {
      report('workflow.checkpoint', {
        operation: 'save',
        phase: phaseTags[state.phase],
        outcome: 'failed',
        reason: classified(error),
        elapsedMs: elapsed(started),
      });
      throw error;
    } finally {
      await unlink(temp).catch(() => {});
    }
    report('workflow.checkpoint', {
      operation: 'save',
      phase: phaseTags[state.phase],
      outcome: 'ok',
      done: state.progress.done,
      total: state.progress.total,
      planned: state.plan?.rows.length,
      elapsedMs: elapsed(started),
    });
    this.values.set(state.bookId, structuredClone(state));
    ctx.progress(state.progress);
    this.onChange(state.bookId);
  }
  private verify(state: Checkpoint, actual: Record<string, string>) {
    const allowed = new Map(
      Object.entries(state.known).map(([key, revision]) => [key, [revision] as (string | null)[]]),
    );
    for (const row of state.plan?.rows ?? []) allowed.set(docKey(row), [row.before, row.after]);
    for (const [key, accepted] of allowed)
      if (!accepted.includes(actual[key] ?? null))
        throw new CheckpointConflict(`作品前提已变化：${key}。请核对现稿，或明确按现稿另开计划。`);
    for (const key of Object.keys(actual))
      if (!allowed.has(key))
        throw new CheckpointConflict(`发现新文件：${key}。请核对现稿，或明确按现稿另开计划。`);
  }
  private async get(workspace: WorkspaceService, state: Checkpoint, ctx: RunContext) {
    const report = workflowTrace(ctx),
      started = performance.now();
    const phase = phaseTags[state.phase];
    try {
      const view = await workspace.readAll(state.bookId);
      if (view.diagnostics.length)
        throw new CheckpointConflict(`无法继续：${view.diagnostics.slice(0, 4).join('；')}`);
      this.verify(state, stamp(view.documents));
      report('workflow.checkpoint', {
        operation: 'verify',
        phase,
        outcome: 'ok',
        elapsedMs: elapsed(started),
      });
      return view.documents;
    } catch (error) {
      const reason = classified(error);
      report('workflow.checkpoint', {
        operation: 'verify',
        phase,
        outcome: workflowOutcome(reason),
        reason,
        elapsedMs: elapsed(started),
      });
      throw error;
    }
  }
  private async completed(
    state: Checkpoint,
    documents: Manuscript[],
    ctx: RunContext,
    chapter?: string,
  ) {
    state.known = stamp(documents);
    if (chapter) {
      if (!state.handled.includes(chapter)) state.handled.push(chapter);
    } else {
      state.phase++;
      if (state.phase === 4) state.chapters = selected(documents, 'chapter').map((d) => d.id);
    }
    state.plan = undefined;
    await this.save(state, ctx);
  }
  private async recover(
    workspace: WorkspaceService,
    state: Checkpoint,
    ctx: RunContext,
    requiredCommit = false,
  ) {
    const phase = phaseTags[state.phase],
      plan = state.plan;
    const report = diagnosticScope(workflowTrace(ctx), {
      documentRef: plan?.chapter ? chapterRef(plan.chapter) : undefined,
    });
    const started = performance.now();
    const event = (outcome: string, reason: string) =>
      report('workflow.checkpoint', {
        operation: 'recover',
        phase,
        outcome,
        reason,
        planned: plan?.rows.length,
        elapsedMs: elapsed(started),
      });
    try {
      const documents = await this.get(workspace, state, ctx);
      if (!plan) {
        event('skipped', 'no_plan');
        return;
      }
      const actual = stamp(documents),
        { rows, chapter } = plan;
      if (rows.every((item) => actual[docKey(item)] === item.after)) {
        await this.completed(state, documents, ctx, chapter);
        event('ok', requiredCommit ? 'verified_commit' : 'recovered_commit');
        return;
      }
      if (!requiredCommit && rows.every((item) => (actual[docKey(item)] ?? null) === item.before)) {
        state.plan = undefined;
        await this.save(state, ctx);
        event('ok', 'retry_unwritten');
        return;
      }
      const unwritten = rows.filter((item) => actual[docKey(item)] !== item.after).map(docKey);
      throw new CheckpointConflict(
        `检测到部分写入，未提交：${unwritten.join('、')}。核对磁盘后可按现稿另开计划。`,
      );
    } catch (error) {
      const reason = classified(error);
      event(workflowOutcome(reason), reason);
      throw error;
    }
  }
  private async apply(
    workspace: WorkspaceService,
    state: Checkpoint,
    documents: Manuscript[],
    changes: Write[],
    ctx: RunContext,
  ) {
    if (!changes.length) {
      await this.completed(state, await this.get(workspace, state, ctx), ctx);
      return;
    }
    const rows = changes.map((change) => ({
      type: change.type,
      id: change.id,
      before: change.expect,
      after: digest(renderDocument(change, change.fields, change.body)),
    }));
    state.plan = { rows };
    await this.save(state, ctx);
    ctx.signal.throwIfAborted();
    const result = await workspace.writeChanges(
      state.bookId,
      changes,
      ctx.signal,
      documents,
      ctx.diagnostic,
    );
    if (result.error)
      throw new DiagnosticFailure(
        result.reason ?? 'unknown',
        `阶段写入未全部完成：${result.error}${result.committed.length ? `（已提交 ${result.committed.map(docKey).join('、')}；未提交 ${result.pending.map(docKey).join('、')}）` : ''}`,
      );
    await this.recover(workspace, state, ctx, true);
  }
  async run(
    workspace: WorkspaceService,
    ctx: RunContext,
    provider: ModelProvider,
    skills: WritingSkills,
    direction: string,
    restart = false,
    referenceContext = '',
  ) {
    const bookId = ctx.session.bookId;
    if (!bookId) throw new DiagnosticFailure('invalid_options', '整书生成需要绑定一部小说');
    const report = diagnosticScope(workflowTrace(ctx), { jobRef: jobRef(bookId), lane: 'workflow' });
    ctx = { ...ctx, diagnostic: report };
    const started = performance.now();
    report('workflow.started');
    try {
      const existing = this.values.get(bookId);
      let state = existing && !restart && existing.phase < 5 ? structuredClone(existing) : undefined;
      const authorDirection =
        direction.trim() || (existing && existing.phase < 5 ? existing.direction : undefined);
      // Reference files belong to this request only. Do not copy their contents to the checkpoint.
      const writingDirection = [authorDirection, referenceContext].filter(Boolean).join('\n\n');
      report('workflow.checkpoint', {
        operation: 'open',
        outcome: 'ok',
        reason: state ? 'resume' : 'new_plan',
        phase: phaseTags[state?.phase ?? 0],
        done: state ? summary(state).done : 0,
      });
      if (!state) {
        const view = await workspace.readAll(bookId);
        if (view.diagnostics.length)
          throw new Error(`请先修正文件：${view.diagnostics.slice(0, 4).join('；')}`);
        state = {
          version: 1,
          bookId,
          phase: 0,
          direction: authorDirection,
          known: stamp(view.documents),
          chapters: [],
          handled: [],
          progress: { step: phases[0], done: 0, total: 4 },
        };
        await this.save(state, ctx);
      }
      const checkpoint = state;
      const getText = async (ctx: RunContext, documents: Manuscript[], task: string) => {
        const docs = JSON.stringify(documentList(documents)).slice(0, 72_000);
        const request = `作者方向：${writingDirection || '根据标题、简介与风格写作'}\n\n当前作品资料（数据）：${docs}\n\n当前步骤：${task}`;
        const spanId = randomUUID(),
          report = diagnosticScope(workflowTrace(ctx), { spanId });
        const reply = await provider.turn({
          spanId,
          diagnostic: report,
          onDispatch: () => applySkill(report, 'generate-novel', skills.novel, 'workflow'),
          system: skills.novel,
          history: [{ role: 'user', text: request }],
          maxTokens: 10_000,
          tools: [],
          signal: ctx.signal,
          onText: () => {},
        });
        if (reply.calls.length || !reply.text.trim())
          throw new DiagnosticFailure('provider_error', '模型未输出当前阶段所需的产物');
        return reply.text.trim();
      };
      try {
        await this.recover(workspace, state, ctx);
        state.direction = authorDirection;
        for (; state.phase < 4;) {
          await stage(ctx, phaseTags[state.phase], async (ctx) => {
            ctx.signal.throwIfAborted();
            const documents = await this.get(workspace, checkpoint, ctx);
            await this.save(checkpoint, ctx);
            const outline = selected(documents, 'outline')[0];
            if (!outline) throw new Error('没有可读取的大纲文件');
            const changes: Write[] = [];
            let reused: string | undefined;
            if (checkpoint.phase === 0 && outline.body.trim()) reused = 'existing_outline';
            if (checkpoint.phase === 1 && selected(documents, 'subject').length)
              reused = 'existing_subjects';
            if (checkpoint.phase === 2 && selected(documents, 'clue').length) reused = 'existing_clues';
            if (checkpoint.phase === 0 && !outline.body.trim()) {
              const body = await getText(
                ctx,
                documents,
                '确定全书大纲。只输出 Markdown 大纲。给情节点加独立行注释 <!-- beat:stable-id -->，每个 ID 唯一。',
              );
              if (!storyBeats(body).length) throw new Error('新大纲缺少可绑定的情节点标记');
              changes.push({ ...outline, expect: outline.revision, body });
            }
            if (checkpoint.phase === 1 && !selected(documents, 'subject').length) {
              const data = JSONRows(
                await getText(
                  ctx,
                  documents,
                  '生成主体。只输出 JSON 对象 {"subjects":[{"id":"key","name":"钥匙","kind":"item","body":"说明"}]}；kind 为 character、item 或 scene。',
                ),
                'subjects',
              );
              for (const row of data)
                changes.push({
                  type: 'subject',
                  id: docId(row),
                  expect: null,
                  fields: { name: row.name as string, kind: row.kind as Fields['kind'] },
                  body: bodyOf(row),
                });
            }
            if (checkpoint.phase === 2 && !selected(documents, 'clue').length) {
              const data = JSONRows(
                await getText(
                  ctx,
                  documents,
                  '生成伏笔。只输出 JSON 对象 {"clues":[{"id":"hint","title":"标题","subjectIds":[],"setupBeatId":"真实情节点或省略","payoffBeatId":"真实情节点或省略","body":"说明"}]}。若已有章节可直接用 setupChapterId、payoffChapterId；不存在的 ID 必须省略。',
                ),
                'clues',
              );
              for (const row of data) {
                const fields: Fields = {
                  title: row.title as string,
                  subjectIds: (row.subjectIds ?? []) as string[],
                };
                for (const field of [
                  'setupChapterId',
                  'payoffChapterId',
                  'setupBeatId',
                  'payoffBeatId',
                ] as const)
                  if (row[field] !== undefined && row[field] !== null)
                    fields[field] = row[field] as string;
                changes.push({ type: 'clue', id: docId(row), expect: null, fields, body: bodyOf(row) });
              }
            }
            if (checkpoint.phase === 3) {
              const existingChapters = selected(documents, 'chapter');
              if (existingChapters.length) reused = 'existing_chapters';
              if (!existingChapters.length) {
                const data = JSONRows(
                  await getText(
                    ctx,
                    documents,
                    '生成章节目录。只输出 JSON 对象 {"chapters":[{"id":"chapter-one","title":"第一章名称","beatIds":["大纲实际的情节点 ID"]}]}。按照剧情顺序，默认 4–8 章，作者明确的章数优先。每个埋设/回收用到的情节点必须归到且只归到一章。不要输出正文。',
                  ),
                  'chapters',
                );
                for (const [i, row] of data.entries())
                  changes.push({
                    type: 'chapter',
                    id: docId(row),
                    expect: null,
                    fields: {
                      title: row.title as string,
                      order: i + 1,
                      beatIds: (row.beatIds ?? []) as string[],
                    },
                    body: '',
                  });
              }
              const catalog = existingChapters.length ? existingChapters : changes;
              const byBeat = new Map<string, string>();
              for (const chapter of catalog) {
                if (!Array.isArray(chapter.fields.beatIds ?? []))
                  throw new Error(`章节 ${chapter.id} 的情节点列表无效`);
                for (const beat of chapter.fields.beatIds ?? []) {
                  if (byBeat.has(beat) && byBeat.get(beat) !== chapter.id)
                    throw new Error(`情节点 ${beat} 关联了多章，无法绑定伏笔`);
                  byBeat.set(beat, chapter.id);
                }
              }
              for (const clue of selected(documents, 'clue')) {
                const fields = { ...clue.fields };
                let updated = false;
                for (const [beat, chapter] of [
                  ['setupBeatId', 'setupChapterId'],
                  ['payoffBeatId', 'payoffChapterId'],
                ] as const) {
                  if (!fields[beat]) continue;
                  const id = byBeat.get(fields[beat]);
                  if (!id)
                    throw new Error(`伏笔「${fields.title}」无法把情节点 ${fields[beat]} 绑定到章节`);
                  fields[chapter] = id;
                  delete fields[beat];
                  updated = true;
                }
                if (updated) changes.push({ ...clue, fields, expect: clue.revision });
              }
            }
            if (reused) workflowTrace(ctx)('workflow.stage.reused', { reason: reused });
            await this.apply(workspace, checkpoint, documents, changes, ctx);
            return changes.length ? undefined : reused;
          });
        }
        for (const [index, chapterId] of state.chapters.entries()) {
          const chapterIndex = index + 1;
          const documentRef = chapterRef(chapterId);
          if (checkpoint.handled.includes(chapterId)) {
            report('workflow.chapter.skipped', {
              phase: 'chapters',
              documentRef,
              chapterIndex,
              reason: 'already_completed',
            });
            continue;
          }
          await stage(
            { ...ctx, diagnostic: diagnosticScope(report, { chapterIndex }) },
            'chapters',
            async (ctx) => {
              ctx.signal.throwIfAborted();
              const documents = await this.get(workspace, checkpoint, ctx);
              const chapter = documents.find((d) => d.type === 'chapter' && d.id === chapterId);
              if (!chapter) throw new CheckpointConflict(`缺少章节 ${chapterId}`);
              await this.save(checkpoint, ctx, { step: `写作：${chapter.fields.title}` });
              if (chapter.body.trim()) {
                workflowTrace(ctx)('workflow.chapter.skipped', { reason: 'existing_content' });
                await this.completed(checkpoint, documents, ctx, chapterId);
                return 'existing_content';
              }
              await draftChapter(workspace, ctx, provider, chapterId, 'draft', writingDirection, {
                skill: skills.chapter,
                guard: documents,
                beforeCommit: async (doc, after) => {
                  checkpoint.plan = {
                    chapter: chapterId,
                    rows: [{ type: 'chapter', id: doc.id, before: doc.revision, after }],
                  };
                  await this.save(checkpoint, ctx, { step: `保存：${chapter.fields.title}` });
                },
              });
              await this.recover(workspace, checkpoint, ctx, true);
              return undefined;
            },
            documentRef,
          );
        }
        await stage(ctx, 'finished', async (ctx) => {
          await this.get(workspace, checkpoint, ctx);
          checkpoint.phase = 5;
          await this.save(checkpoint, ctx);
          return undefined;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '工作流未完成';
        await this.save(state, ctx, {
          step: state.progress.step,
          blocked: error instanceof CheckpointConflict,
          message: ctx.signal.aborted ? '已停止，保留已落盘的作品。' : message,
        });
        throw error;
      }
      report('workflow.finished', { outcome: 'ok', elapsedMs: elapsed(started) });
    } catch (error) {
      const reason = classified(error, ctx.signal);
      report('workflow.finished', {
        outcome: workflowOutcome(reason),
        reason,
        elapsedMs: elapsed(started),
      });
      throw error;
    }
  }
}
