import type { Manuscript } from '../../shared/contracts.js';
import { diagnosticScope } from '../../shared/diagnostics.js';
import { isId } from '../documents.js';
import { assetPatchFields, sameAssetPatch, type AssetPatch } from './asset-patch.js';
import { inputEstimate, planModelBudget } from './context-budget.js';
import { object, str, ToolFailure, type LocalTool } from './loop.js';
import type { ModelProvider, Turn } from './model.js';
import type { RunContext } from './runs.js';
import { observedCommit } from './tool-receipts.js';

const operations = [
  'chapter.patch',
  'chapter.cleanup',
  'chapter.insert',
  'chapter.draft',
  'chapter.append',
  'chapter.replace',
  'subject.create',
  'subject.fill',
  'subject.update',
  'clue.create',
  'clue.fill',
  'clue.update',
  'outline.write',
  'chapter.catalog',
  'novel.register',
  'novel.resume',
] as const;
export type ScopeOperation = (typeof operations)[number];
type ScopeTarget = { operation: ScopeOperation; id: string; part?: string; assetPatch?: AssetPatch };
export type ScopeItem = ScopeTarget & {
  purpose: string;
  count?: number;
  relatedMinimum?: number;
  currentEvidence?: { revision: string; quote: string };
  assetPending?: true;
  stage?: 'setup' | 'reveal' | 'addition';
};
const scopeKey = (operation: ScopeOperation, id: string, part?: string) =>
  part === undefined ? `${operation}/${id}` : `${operation}/${id}/${part}`;
const verdict = {
  name: 'check_book_scope',
  description: '返回该批具体动作是否严格属于当前作者允许的执行范围。',
  schema: object({ allowed: { type: 'boolean' } }),
};

/** Ephemeral, host-owned projection of permission for concrete writing actions in one Run. */
export class BookTaskScope {
  private readonly written = new Set<string>();
  private readonly latest = new Map<string, string>();
  private readonly assetPatchRevisions = new Map<string, string>();
  private readonly approved = new Map<
    string,
    ScopeItem & { source?: string; sourceAuthorLine?: number }
  >();
  constructor(
    private readonly owner: RunContext,
    private readonly author: string,
    private readonly model: ModelProvider,
  ) {}

  private inRun(ctx: RunContext) {
    return (
      this.owner.id === ctx.id &&
      this.owner.authorLine === ctx.authorLine &&
      this.owner.session.id === ctx.session.id &&
      this.owner.session.bookId === ctx.session.bookId
    );
  }

  get items() {
    return [...this.approved.values()];
  }
  get whole() {
    const id = this.owner.session.bookId;
    if (!id) return;
    return this.allows('novel.resume', id, this.owner) ?? this.allows('novel.register', id, this.owner);
  }
  item(operation: ScopeOperation, id: string, part?: string) {
    return this.approved.get(scopeKey(operation, id, part));
  }
  allows(operation: ScopeOperation, id: string, ctx: RunContext, part?: string) {
    const task = this.inRun(ctx) ? this.item(operation, id, part) : undefined;
    return task?.currentEvidence || task?.assetPatch || task?.assetPending ? undefined : task;
  }
  allowsAssetPatch(operation: ScopeOperation, id: string, ctx: RunContext, patch: AssetPatch) {
    const task = this.inRun(ctx) ? this.item(operation, id) : undefined;
    return task?.assetPatch && sameAssetPatch(task.assetPatch, patch) ? task : undefined;
  }
  private patchParts(id: string) {
    return this.items.filter(
      (item) => item.operation === 'chapter.patch' && item.id === id && item.part,
    );
  }

  patchTargets(id: string, edits: readonly { part?: string }[], ctx: RunContext): ScopeTarget[] {
    const parts = this.patchParts(id);
    if (!parts.length && edits.every(({ part }) => part === undefined))
      return [{ operation: 'chapter.patch', id }];
    const targets: ScopeTarget[] = [];
    for (const { part } of edits) {
      if (!part || !this.allows('chapter.patch', id, ctx, part))
        throw new ToolFailure('patch_scope', '请用 edits[].part 指明这处补丁对应的已登记子目标。', {
          chapterId: id,
          parts: parts.map(({ part, purpose }) => ({ part, purpose })),
        });
      if (!targets.some((target) => target.part === part))
        targets.push({ operation: 'chapter.patch', id, part });
    }
    return targets;
  }

  instruction(operation: ScopeOperation, id: string, targets?: readonly ScopeTarget[]) {
    const items = (targets ?? [{ operation, id }]).flatMap((target) => {
      const item = this.item(target.operation, target.id, target.part);
      return item ? [item] : [];
    });
    return items.length
      ? [
          this.author,
          ...new Set(
            items.flatMap(({ source }) => (source ? [`本轮指向的同会话内容：\n${source}`] : [])),
          ),
          ...items.map(({ purpose }) => `本次仅处理：${purpose}`),
        ]
          .filter(Boolean)
          .join('\n\n')
      : this.author;
  }

  track(ctx: RunContext, targets: readonly ScopeTarget[]): RunContext {
    return {
      ...ctx,
      diagnostic: (event, fields) => {
        if (event === 'workspace.document.committed') {
          const commit = observedCommit(fields);
          if (commit?.operation === 'write' && commit.revision) {
            const document = `${commit.type}/${commit.id}`;
            const previous = this.latest.get(document);
            // A different starting revision breaks the chain of previously tracked writes.
            if (previous && previous !== fields?.expectedRevision) {
              this.latest.delete(document);
              for (const item of this.items) {
                if (item.id !== commit.id || !item.operation.startsWith(`${commit.type}.`)) continue;
                const key = scopeKey(item.operation, item.id, item.part);
                this.written.delete(key);
                this.assetPatchRevisions.delete(key);
              }
            }
            for (const { operation, id, part, assetPatch } of targets) {
              if (id !== commit.id || !operation.startsWith(`${commit.type}.`)) continue;
              const key = scopeKey(operation, id, part);
              if (assetPatch) {
                if (
                  fields?.expectedRevision !== assetPatch.revision ||
                  !this.allowsAssetPatch(operation, id, ctx, assetPatch)
                )
                  continue;
                this.assetPatchRevisions.set(key, commit.revision);
              } else if (!this.allows(operation, id, ctx, part)) continue;
              this.latest.set(document, commit.revision);
              this.written.add(key);
              if (part)
                ctx.diagnostic?.('chapter.patch.part', {
                  documentRef: `chapter/${id}`,
                  partRef: part,
                  revision: commit.revision,
                  outcome: 'ok',
                });
            }
          }
        }
        ctx.diagnostic?.(event, fields);
      },
    };
  }

  summarize(documents: Manuscript[]) {
    const byKey = new Map(documents.map((doc) => [`${doc.type}/${doc.id}`, doc.revision]));
    const expected = this.items.filter(
      ({ operation, id, part }) =>
        !operation.startsWith('novel.') &&
        !(operation === 'chapter.patch' && !part && this.patchParts(id).length) &&
        !(
          operation === 'chapter.catalog' &&
          (this.item('chapter.insert', id) || this.patchParts(id).length)
        ),
    );
    const remaining = expected.filter(
      ({ operation, id, part, currentEvidence, assetPatch, assetPending }) => {
        const key = `${operation.split('.')[0]}/${id}`;
        const target = scopeKey(operation, id, part);
        if (assetPending) return true;
        if (currentEvidence?.revision === byKey.get(key) && currentEvidence) return false;
        if (assetPatch) {
          const saved = this.assetPatchRevisions.get(target);
          return !saved || saved !== byKey.get(key);
        }
        return (
          !this.written.has(target) || !this.latest.has(key) || this.latest.get(key) !== byKey.get(key)
        );
      },
    );
    return {
      total: expected.length,
      done: expected.length - remaining.length,
      remaining,
      noWrite: expected.every(
        ({ operation, id, part }) => !this.written.has(scopeKey(operation, id, part)),
      ),
    };
  }

  tool(load: () => Promise<Manuscript[]>): LocalTool {
    return {
      name: 'book_task_scope',
      description:
        '按本轮作者实际要求为写作动作登记最小范围。只读或仅提案不用登记。承接同会话待办时用 sourceQuote 引用可见回复并逐项登记仍未满足的结果。主体／伏笔短文修订用 subject.update／clue.update 的 assetPatch 登记当前 revision、已回读的唯一 quote 和确切 replacement，再用 book_patch_asset 提交；不能定位且无全文更新授权时用 assetPending: true 保留待办，不写。仅开放式更新登记不带 assetPatch 的更新。同章复合补丁分别登记每处 part，例如删除旧段与补入新位置；后续 edits[].part 使用相同标识。依据现稿填写真实文档 ID。只补一章、增补场景或续办局部事项用对应局部动作。整书交付（含未限定指定章节或追加范围的完整多章创作）登记 novel.register（完整章数），明确续接原整书登记 novel.resume（有效记录），然后用 book_get_context.novelGoal 激活；不要逐章代替整书。',
      schema: object(
        {
          sourceQuote: str(
            '仅当指向同会话上文时：局部待办用可见回复短句；补登记未保存的整书目标可引用原作者要求的短句；已有整书记录可直接续接',
            400,
          ),
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: object(
              {
                operation: { type: 'string', enum: [...operations] },
                id: str('对应文档的稳定 ID；novel.register/resume 用作品 ID', 128),
                part: str('仅 chapter.patch；同章可独立核对的短标识，如 remove-old 或 add-new。', 64),
                purpose: str('本动作的最小目标及不应扩大之处', 500),
                count: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 100,
                  description: '仅 novel.register：作者要求的完整章数，不是剩余空白章数',
                },
                assetPatch: {
                  ...object(assetPatchFields),
                  description:
                    '仅 subject.update／clue.update：绑定一处确切的当前短文修订；不用全文更新',
                },
                assetPending: {
                  type: 'boolean',
                  enum: [true],
                  description:
                    '仅 subject.update／clue.update：尚不能安全写入的已知待办，不授权任何写入',
                },
                currentEvidence: object({
                  revision: str('当前读回的版本', 64),
                  quote: str('证明该事项已经完成且无需写入的原文', 400),
                }),
                relatedMinimum: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 12,
                  description: '仅 subject.create：作者要求的不同既有主体关联数',
                },
                stage: {
                  type: 'string',
                  enum: ['setup', 'reveal', 'addition'],
                  description:
                    '仅 chapter.insert：场景的剧情作用，按作品而非章序。不是新建资料或改大纲的前提',
                },
              },
              ['operation', 'id', 'purpose'],
            ),
          },
        },
        ['items'],
      ),
      execute: async ({ items, sourceQuote }, ctx) => this.accept(items, sourceQuote, await load(), ctx),
    };
  }

  private async accept(
    items: ScopeItem[],
    sourceQuote: string | undefined,
    docs: Manuscript[],
    ctx: RunContext,
  ) {
    ctx.signal.throwIfAborted();
    if (!this.inRun(ctx) || !ctx.session.bookId || ctx.authorLine === undefined || !this.author.trim())
      throw new ToolFailure('invalid_options', '写作动作必须绑定本轮作者消息和作品。');
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > 20 ||
      this.approved.size + items.length > 160
    )
      throw new ToolFailure('invalid_arguments', '写作范围应包含有界的明确操作。');
    const keys = new Set<string>();
    const facts = items.map((item) => {
      if (
        !item ||
        !operations.includes(item.operation) ||
        !isId(item.id) ||
        !item.purpose?.trim() ||
        item.purpose.length > 500
      )
        throw new ToolFailure('invalid_arguments', '写作范围项缺少有效的动作、目标或目的。');
      const [type, verb] = item.operation.split('.');
      if (
        item.part !== undefined &&
        (item.operation !== 'chapter.patch' || !isId(item.part) || item.part.length > 64)
      )
        throw new ToolFailure('invalid_arguments', 'part 只能用于章节补丁，且须是短标识。');
      const key = scopeKey(item.operation, item.id, item.part);
      if (keys.has(key)) throw new ToolFailure('invalid_arguments', '同一批范围不能重复动作和目标。');
      keys.add(key);
      const doc = docs.find((d) => d.type === type && d.id === item.id);
      if (
        type === 'novel' &&
        (item.id !== ctx.session.bookId || (verb === 'resume' && !ctx.continuation))
      )
        throw new ToolFailure('invalid_options', '整书动作不匹配当前作品或没有可续接记录。');
      if (type !== 'novel' && !doc && !['create', 'write', 'catalog'].includes(verb))
        throw new ToolFailure('missing', '写作范围指定的文档不存在。');
      if (
        (item.assetPatch !== undefined || item.assetPending !== undefined) &&
        ((item.operation !== 'subject.update' && item.operation !== 'clue.update') ||
          item.currentEvidence !== undefined ||
          (item.assetPatch !== undefined && item.assetPending !== undefined))
      )
        throw new ToolFailure(
          'invalid_arguments',
          '资料定点补丁、只待办或已满足证据须分别登记，定点和只待办仅用于资料更新。',
        );
      if (item.assetPatch && item.assetPatch.revision !== doc?.revision)
        throw new ToolFailure('conflict', '资料已改版；请回读当前短文后重新登记，不重用旧补丁。');
      if (
        item.relatedMinimum !== undefined &&
        (item.operation !== 'subject.create' ||
          !Number.isSafeInteger(item.relatedMinimum) ||
          item.relatedMinimum < 1 ||
          item.relatedMinimum > 12)
      )
        throw new ToolFailure('invalid_arguments', '关联数量只能用于有效的新主体动作。');
      if (
        item.currentEvidence &&
        (!doc ||
          doc.revision !== item.currentEvidence.revision ||
          item.currentEvidence.quote.length < 8 ||
          !doc.body.includes(item.currentEvidence.quote))
      )
        throw new ToolFailure('conflict', '无法在当前稿件复核已满足事项的版本或原文。');
      if (item.stage && item.operation !== 'chapter.insert')
        throw new ToolFailure('invalid_arguments', '剧情角色只能用于具体插入动作。');
      if (
        item.count !== undefined &&
        (item.operation !== 'novel.register' ||
          !Number.isSafeInteger(item.count) ||
          item.count < 1 ||
          item.count > 100)
      )
        throw new ToolFailure('invalid_arguments', '章数只能用于有效的新整书目标。');
      return {
        ...item,
        current: doc
          ? { label: doc.fields.name ?? doc.fields.title, order: doc.fields.order }
          : undefined,
      };
    });
    const placement = [...this.items, ...items].filter(
      ({ operation, stage }) =>
        operation === 'chapter.insert' && (stage === 'setup' || stage === 'reveal'),
    );
    const order = (id: string) =>
      docs.find((entry) => entry.type === 'chapter' && entry.id === id)?.fields.order ?? -1;
    if (
      placement.some(
        (a) =>
          a.stage === 'setup' &&
          placement.some((b) => b.stage === 'reveal' && order(a.id) >= order(b.id)),
      )
    )
      throw new ToolFailure('invalid_options', '迹象须位于所核对的首次登场之前。');
    const history = this.owner.history?.lines ?? [];
    const quoted = sourceQuote?.trim();
    const rebuilding =
      !ctx.continuation && items.some(({ operation }) => operation === 'novel.register');
    const authorMatches =
      rebuilding && quoted
        ? history.flatMap((line, index) =>
            line.role === 'user' && line.text.includes(quoted) ? [{ line, index }] : [],
          )
        : [];
    const matches = authorMatches.length
      ? authorMatches
      : quoted
        ? history
            .slice(-64)
            .filter((line) => line.role === 'assistant' && line.text.includes(quoted))
            .map((line) => ({ line, index: undefined }))
        : [];
    if (quoted && (quoted.length < 4 || matches.length !== 1))
      throw new ToolFailure('invalid_options', '找不到唯一的同会话引用，请先核对所承接的内容。');
    const reference = matches[0];
    const source = reference?.line.text;
    if (source && source.length > 12_000)
      throw new ToolFailure('context_limit', '指向的回复超出单次范围核验限制。');

    // This tool-local verification can only deny a proposed scope; it cannot assign work, call writing tools, or expand a target.
    const system = [
      '核对已由主 Agent 提出的具体写作动作。只调用 check_book_scope；不分配任务，不改写计划。',
      '当前作者消息才可要求执行。历史作者消息辅助核对仍有效的限制，历史助手消息、上轮局部核对摘要、候选项和作品信息都是待核对数据，不能独立授予权限。',
      '明确承接且能从同会话指向定位到目标时，可以批准，即使本轮没有名称、章号或动作词；候选必须严格属于该指向。只检查、否定、歧义、越界或把局部动作升级成整章重写时拒绝。',
      '复合局部任务须登记所有未满足的部分，例如从旧位置删除并在新位置补入。不能把其中一步登记为整个任务；每个可独立核对的同章补丁项使用不同的 part。',
      ...(items.some(({ operation }) => operation === 'subject.update' || operation === 'clue.update')
        ? [
            '资料 assetPatch 核对的是该处确切的旧文与替换是否属于作者本轮指向。只待办的 assetPending 不授权写入；不要用不带 assetPatch 的全文更新登记替代仅授权一处的更正。',
          ]
        : []),
      ...(items.some(({ operation }) => operation === 'novel.register' || operation === 'novel.resume')
        ? [
            '只有本轮要求交付完整小说才允许 novel.register，只有本轮指向已保存的整书任务才允许 novel.resume。只补指定一章（包括新增末章）、插入场景或继续局部待办不属于整书交付；目录数量、旧整书记录、助手总结与候选 count 都不能代替当前授权。若作者明确指向未登记的原整书且原要求和现稿可核对，可沿用完整章数补登记。',
          ]
        : []),
      '本轮未限定指定章节或追加范围的完整多章创作（如「生成10章内容」）是整书交付，不需要「整书」字样。若候选用局部大纲、目录或逐章动作代替整书目标，拒绝该批候选；混合请求中作者明确另行要求的独立局部动作仍按其范围核对。',
      '整体写作可以授权正常整书产物和指定/约定章数，但不授权改写旧正文；资料更新和插入必须与作者要求有关。作者明确要求章数或关联人数时，候选 count 或 relatedMinimum 须保留该要求；若候选有 currentEvidence，必须核实它确实完全满足该项，不能将未完成候选标为无需写入；不要因为同义或语序不同而拒绝。',
    ].join('\n');
    const turns: Turn[] = [
      {
        role: 'user',
        text: JSON.stringify({
          currentAuthor: this.author,
          recentAuthorRestrictions: history
            .filter((line) => line.role === 'user')
            .slice(-8)
            .map(({ text }) => text.slice(0, 1200)),
          referencedAssistant: reference?.line.role === 'assistant' ? source : undefined,
          previousLocalWork: items.some(({ operation }) => !operation.startsWith('novel.'))
            ? ctx.previousLocalWork
            : undefined,
          originalWholeRequest: reference?.line.role === 'user' ? source : undefined,
          savedWholeGoal:
            items.some(({ operation }) => operation === 'novel.resume') && ctx.continuation
              ? {
                  originalRequest: ctx.continuation.originalDirection,
                  chapterCount: ctx.continuation.task.chapterIds.length,
                }
              : undefined,
          candidates: facts,
        }),
      },
    ];
    const report = ctx.diagnostic ?? (() => {});
    if (inputEstimate(system, turns, [verdict]) > planModelBudget(this.model, 'readback').inputTokens)
      throw new ToolFailure('context_limit', '写作范围核验超过上下文限额，请缩小。');
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(40_000)]);
    let allowed = false;
    const answer = await this.model.turn({
      system,
      history: turns,
      tools: [verdict],
      signal,
      onText() {},
      diagnostic: diagnosticScope(report, { lane: 'readback' }),
      budgetPurpose: 'readback',
      directToolResult: true,
    });
    ctx.signal.throwIfAborted();
    if (!signal.aborted && answer.calls.length === 1 && answer.calls[0].name === verdict.name) {
      try {
        const decision = JSON.parse(answer.calls[0].args);
        allowed = decision?.allowed === true && Object.keys(decision).length === 1;
      } catch {
        /* Malformed verification never authorizes any candidate. */
      }
    }
    report('writing.task_scope', {
      count: items.length,
      outcome: allowed ? 'ok' : 'failed',
      reason: allowed ? undefined : 'invalid_options',
    });
    if (!allowed)
      throw new ToolFailure('invalid_options', '不能核实这些动作属于本轮作者允许的范围；没有写入。');
    for (const item of items) {
      const key = scopeKey(item.operation, item.id, item.part);
      const prior = this.approved.get(key);
      if (
        !sameAssetPatch(prior?.assetPatch, item.assetPatch) ||
        prior?.assetPending !== item.assetPending
      ) {
        this.written.delete(key);
        this.assetPatchRevisions.delete(key);
      }
      this.approved.set(key, {
        ...item,
        source: source || undefined,
        sourceAuthorLine: item.operation === 'novel.register' ? reference?.index : undefined,
      });
    }
    const whole = items.find(
      ({ operation }) => operation === 'novel.register' || operation === 'novel.resume',
    );
    return {
      targets: items.map(({ operation, id, part, assetPatch, assetPending }) => ({
        operation,
        id,
        part,
        ...(assetPatch && { assetMode: 'patch' }),
        ...(assetPending && { assetMode: 'pending' }),
      })),
      ...(whole && {
        next:
          '若尚未送达，先加载 generate-novel；用 book_get_context.novelGoal.' +
          (whole.operation === 'novel.resume' ? 'resume' : 'register') +
          ' 激活完整整书目标，再写章。',
      }),
    };
  }
}
