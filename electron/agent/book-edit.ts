import type { DocRef, Manuscript } from '../../shared/contracts.js';
import { chapterPlacementFingerprint, docKey, validateFields } from '../documents.js';
import { ToolFailure } from './loop.js';
import { chapterOrder } from './chapter-intent.js';
import { hasStoryDescription } from './story-notes.js';
import {
  assetTarget,
  passageTarget,
  confirmedEdit,
  currentEditRevisions,
  targetRevisions,
  type EditPlan,
  type EditAsset,
  type EditPassage,
  type EditCommit,
} from './edit-proposal.js';
import type { RunContext } from './runs.js';
import type { AssetInput } from './story-assets.js';
import type { ChapterInsertion } from './chapter-insertion.js';

const outlineKey = 'outline/outline';

/** Validate proposed identities against the current book. Proposed new cards may refer to one another. */
export function checkBookEditPlan(plan: EditPlan, documents: Manuscript[]) {
  const byKey = new Map(documents.map((doc) => [docKey(doc), doc]));
  const planned = new Set(plan.assets.filter((a) => a.action === 'create').map(assetTarget));
  const exists = (type: 'subject' | 'clue', id: string) =>
    byKey.has(`${type}/${id}`) || planned.has(`${type}/${id}`);
  const order = (id?: string) => byKey.get(`chapter/${id}`)?.fields.order ?? -1;
  for (const asset of plan.assets) {
    const key = assetTarget(asset);
    const existing = byKey.get(key);
    if (asset.action === 'create' ? !!existing : !existing)
      throw new ToolFailure('conflict', `方案的 ${key} 已存在或不存在，请核对当前作品。`);
    if (asset.action === 'fill' && existing && hasStoryDescription(existing.body))
      throw new ToolFailure('conflict', `方案的 ${key} 已有说明，不能用补空覆盖。`);
    if (asset.fields) validateFields(asset.kind, asset.fields, '');
    if (asset.relatedSubjectIds?.some((id) => !byKey.has(`subject/${id}`)))
      throw new ToolFailure('invalid_references', '方案的关联主体必须是已保存且不同的旧主体。');
    if (asset.kind === 'clue' && asset.action === 'create') {
      const f = asset.fields!;
      if (
        order(f.setupChapterId) < 1 ||
        order(f.setupChapterId) >= order(f.payoffChapterId) ||
        !f.subjectIds?.length ||
        f.subjectIds.some((id) => !exists('subject', id))
      )
        throw new ToolFailure('invalid_references', '新伏笔须关联实际主体及顺序正确的埋设、回收章。');
    }
  }
  for (const p of plan.passages) {
    if (
      !byKey.get(`chapter/${p.chapterId}`)?.body.trim() ||
      !byKey.has(outlineKey) ||
      p.subjectIds?.some((id) => !exists('subject', id)) ||
      p.clueIds?.some((id) => !exists('clue', id))
    )
      throw new ToolFailure(
        'invalid_references',
        `方案中的 ${p.chapterId}、资料或大纲不存在，不能作为插入目标。`,
      );
  }
  const setups = plan.passages.filter((p) => p.stage === 'setup'),
    reveals = plan.passages.filter((p) => p.stage === 'reveal');
  if (setups.some((a) => reveals.some((b) => order(a.chapterId) >= order(b.chapterId))))
    throw new ToolFailure('invalid_options', '方案的迹象必须安排在实际登场之前。');
}

// Restrictions can narrow a displayed plan, never authorize a target that was not shown.
function narrowPlan(plan: EditPlan, replies: string[], documents: Manuscript[]): EditPlan {
  let { assets, passages } = plan;
  const dropProse =
    /(?:不要|不|别|禁止|不必|无需)\s*(?:再)?\s*(?:写(?:入)?|动|改(?:写|动)?|插入)\s*(?:任何|这些|现有)?\s*(?:的)?(?:章节|正文)|(?:只|仅)\s*(?:需|要|先)?\s*(?:做|改|补|写|生成|整理)\s*(?:资料|设定|主体|伏笔|说明)/u;
  const dropAsset = (word: string) =>
    new RegExp(
      `(?:不要|别|不|无需|不必)\\s*(?:添加|新增|新建|修改|改|创建|生成|写|动|补)\\s*(?:任何)?\\s*${word}`,
      'u',
    );
  for (const raw of replies) {
    const text = raw.normalize('NFKC');
    if (
      dropProse.test(text) ||
      /(?:不要|别|不|无需|不必)\s*(?:修改|改|更新|动|写)\s*(?:原|现有)?大纲/u.test(text)
    )
      passages = [];
    if (dropAsset('(?:主体|角色|人物|反派)').test(text))
      assets = assets.filter((a) => a.kind !== 'subject');
    if (dropAsset('(?:伏笔|线索)').test(text)) assets = assets.filter((a) => a.kind !== 'clue');
    const onlyKind =
      /(?:只|仅)(?:先|要|需)?\s*(?:新增|新建|生成|添加|补|修改|改|做|写)\s*(?:这些|该|这份)?\s*(主体|角色|人物|反派|伏笔|线索)/u.exec(
        text,
      )?.[1];
    if (onlyKind) {
      assets = assets.filter((a) => a.kind === (/伏笔|线索/u.test(onlyKind) ? 'clue' : 'subject'));
      passages = [];
    }
    const only = [
      ...text.matchAll(
        /(?:只|仅)(?:先|要)?(?:改|写|插入|增补|处理)\s*(第\s*[\d零一二三四五六七八九十两]+\s*章)/gu,
      ),
    ].map((m) => chapterOrder(m[1]));
    const forbidden = [
      ...text.matchAll(
        /(?:别|不要|不|禁止)(?:改|写|碰|动)\s*(第\s*[\d零一二三四五六七八九十两]+\s*章)/gu,
      ),
    ].map((m) => chapterOrder(m[1]));
    if (only.length) assets = [];
    if (only.length || forbidden.length)
      passages = passages.filter((p) => {
        const order =
          documents.find((d) => d.type === 'chapter' && d.id === p.chapterId)?.fields.order ?? -1;
        return (!only.length || only.includes(order)) && !forbidden.includes(order);
      });
  }
  return { ...plan, assets, passages };
}

export class ConfirmedBookEdit {
  readonly plan: EditPlan;
  private readonly edit: NonNullable<ReturnType<typeof confirmedEdit>>;
  constructor(edit: NonNullable<ReturnType<typeof confirmedEdit>>, docs: Manuscript[]) {
    this.edit = edit;
    this.plan = narrowPlan(edit.proposal.plan, edit.replies, docs);
  }
  get commits(): readonly EditCommit[] {
    return this.edit.commits;
  }
  get hasTargets() {
    return this.plan.assets.length + this.plan.passages.length > 0;
  }
  get total() {
    return this.plan.assets.length + this.plan.passages.length;
  }
  private matches(docs: Manuscript[], keys: string[]) {
    const revisions = currentEditRevisions(this.edit);
    return keys.every((key) => docs.some((d) => docKey(d) === key && d.revision === revisions[key]));
  }
  verifySharedDocuments(docs: Manuscript[], keys: string[]) {
    const revisions = currentEditRevisions(this.edit);
    if (
      !this.matches(
        docs,
        keys.filter((key) => revisions[key]),
      )
    )
      throw new ToolFailure(
        'conflict',
        '方案已提交过的正文或大纲随后改变；请核对现稿，不会自动重写或重复插入。',
      );
  }
  verifyRecorded(docs: Manuscript[], target: string) {
    const recorded = targetRevisions(this.edit, target);
    if (!this.matches(docs, Object.keys(recorded)))
      throw new ToolFailure('conflict', `${target} 的已提交版本已变，请重新核对现稿；不会重复写入。`);
    return recorded;
  }
  verifyPlacement(docs: Manuscript[]) {
    if (
      this.edit.proposal.plan.passages.length &&
      chapterPlacementFingerprint(docs) !== this.edit.proposal.basis.placement
    )
      throw new ToolFailure('conflict', '拟修改章节的顺序或已有正文状态与确认时不同，请核对方案位置。');
  }
  assets(input: AssetInput, docs: Manuscript[]) {
    this.verifyPlacement(docs);
    const selected = input.targets.map(({ id }) => {
      const item = this.plan.assets.find(
        (a) => a.kind === input.kind && a.action === input.action && a.id === id,
      );
      if (!item)
        throw new ToolFailure(
          'invalid_options',
          `资产 ${input.kind}/${id} 不在本轮确认方案的执行范围。`,
        );
      return item;
    });
    const reused: Array<DocRef & { revision: string }> = [];
    const pending: EditAsset[] = [];
    for (const item of selected) {
      const saved = this.verifyRecorded(docs, assetTarget(item))[assetTarget(item)];
      if (saved) reused.push({ type: item.kind, id: item.id, revision: saved });
      else {
        if (
          item.action !== 'create' &&
          docs.find((d) => docKey(d) === assetTarget(item))?.revision !==
            this.edit.proposal.basis.existingAssets[assetTarget(item)]
        )
          throw new ToolFailure(
            'conflict',
            `${assetTarget(item)} 在提案后已被修改，请核对修改范围；不会覆盖新版本。`,
          );
        pending.push(item);
      }
    }
    return { selected, reused, pending };
  }
  passage(chapterId: string, preferred?: string) {
    const matches = this.plan.passages.filter(
      (p) => p.chapterId === chapterId && (!preferred || p.id === preferred),
    );
    if (matches.length !== 1)
      throw new ToolFailure(
        'insert_not_authorized',
        '此章不在本轮确认范围，或有多个位置；请用方案中准确的 insertion.targetId。',
      );
    return matches[0];
  }
  anchorFor(target: string) {
    return this.edit.commits.find((c) => c.target === target)?.anchor;
  }
  getAnchors() {
    return this.edit.commits.flatMap((c) => (c.anchor ? [c.anchor] : []));
  }
  async record(ctx: RunContext, commit: EditCommit) {
    this.edit.commits.push(commit);
    if (!ctx.recordEditCommit)
      throw new ToolFailure(
        'io_failure',
        '作品已写入，但无法持久记录修改回执；先核对现稿，不要重试插入。',
      );
    await ctx.recordEditCommit(this.edit.proposal.id, commit);
  }
  remaining(docs: Manuscript[]) {
    return [
      ...this.plan.assets.map((asset) => ({ target: assetTarget(asset), refs: [assetTarget(asset)] })),
      ...this.plan.passages.map((p) => ({
        target: passageTarget(p),
        refs: [`chapter/${p.chapterId}`, outlineKey],
      })),
    ]
      .filter(({ target, refs }) => {
        const recorded = targetRevisions(this.edit, target);
        return !refs.every((ref) => recorded[ref]) || !this.matches(docs, refs);
      })
      .map(({ target }) => target);
  }
  linked(p: EditPassage, docs: Manuscript[]) {
    // The visible plan may omit per-passage arrays when it introduces only one related arc.
    const subjectIds =
      p.subjectIds ??
      this.edit.proposal.plan.assets.filter((a) => a.kind === 'subject').map((a) => a.id);
    const clueIds =
      p.clueIds ?? this.edit.proposal.plan.assets.filter((a) => a.kind === 'clue').map((a) => a.id);
    const missing = [
      ...subjectIds.map((id) => `subject/${id}`),
      ...clueIds.map((id) => `clue/${id}`),
    ].filter((key) => !docs.some((doc) => docKey(doc) === key && hasStoryDescription(doc.body)));
    if (missing.length)
      throw new ToolFailure('context_required', '该处方案所需资料尚未写入，请先处理本轮范围内的缺项。', {
        missing,
      });
    return { subjectIds, clueIds };
  }
  outline(p: EditPassage, value: NonNullable<ChapterInsertion['outline']>, docs: Manuscript[]) {
    const links = this.linked(p, docs);
    // Keep the chapter addition tied to the same subjects and clue as its prose.
    const urls = [
      ...links.subjectIds.map((id) => `subjects/${id}.md`),
      ...links.clueIds.map((id) => `foreshadowing/${id}.md`),
    ];
    const addition = [
      value.addition.trim(),
      ...urls
        .filter((url) => !value.addition.includes(url))
        .map((url) => `[${url.split('/')[1].slice(0, -3)}](${url})`),
    ].join(' ');
    return { ...value, addition };
  }
}
