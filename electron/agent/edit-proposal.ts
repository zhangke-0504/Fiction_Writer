import type { ChatLine, Fields, Session } from '../../shared/contracts.js';
import { isId } from '../documents.js';
import type { AssetAction, AssetKind } from './writing-request.js';

export const maxEditTargets = 12;
export type EditAsset = {
  kind: AssetKind;
  action: AssetAction;
  id: string;
  fields?: Fields;
  relatedSubjectIds?: string[];
};
export type EditPassage = {
  id: string;
  chapterId: string;
  stage: 'setup' | 'reveal' | 'addition';
  note: string;
  subjectIds?: string[];
  clueIds?: string[];
};
export type EditPlan = { summary: string; assets: EditAsset[]; passages: EditPassage[] };
export type EditBasis = { placement: string; existingAssets: Record<string, string> };
export type EditProposal = {
  id: string;
  sessionId: string;
  bookId: string;
  authorLine: number;
  proposalLine: number;
  plan: EditPlan;
  basis: EditBasis;
};
export type InsertedScene = {
  offset: number;
  size: number;
  fragmentOffset: number;
  length: number;
  digest: string;
};
export type EditCommit = {
  target: string;
  revisions: Record<string, string>;
  anchor?: string;
  scene?: InsertedScene & { assets: string[] };
  synced?: Record<string, string>;
};
export type BookEdit = { proposal: EditProposal; commits: EditCommit[] };

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/u.test(v);
const ids = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= maxEditTargets && v.every(isId) && new Set(v).size === v.length;
const nonempty = (v: unknown, limit: number): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= limit;
const stageName = { setup: '迹象／埋设', reveal: '登场／揭示', addition: '增补' };
const actionName = { create: '新建', fill: '补空', update: '更新' };
const nounName = { subject: '主体', clue: '伏笔' };
export const assetTarget = ({ kind, id }: EditAsset) => `${kind}/${id}`;
export const passageTarget = ({ id }: EditPassage) => `passage/${id}`;

export function readEditPlan(raw: unknown): EditPlan | undefined {
  if (
    !record(raw) ||
    !nonempty(raw.summary, 800) ||
    !Array.isArray(raw.assets) ||
    !Array.isArray(raw.passages)
  )
    return undefined;
  const { assets, passages } = raw;
  if (assets.length + passages.length < 1 || assets.length + passages.length > maxEditTargets) return;
  const cleanAssets: EditAsset[] = [];
  for (const asset of assets) {
    if (
      !record(asset) ||
      (asset.kind !== 'subject' && asset.kind !== 'clue') ||
      !isId(asset.id) ||
      (asset.action !== 'create' && asset.action !== 'fill' && asset.action !== 'update')
    )
      return;
    const { kind, action, id } = asset;
    let fields: Fields | undefined;
    if (action === 'create') {
      if (!record(asset.fields)) return;
      const f = asset.fields;
      if (kind === 'subject') {
        if (
          !nonempty(f.name, 160) ||
          (f.kind !== 'character' && f.kind !== 'scene' && f.kind !== 'item')
        )
          return;
        fields = { name: f.name.trim(), kind: f.kind };
      } else {
        if (
          !nonempty(f.title, 160) ||
          !ids(f.subjectIds) ||
          !isId(f.setupChapterId) ||
          !isId(f.payoffChapterId)
        )
          return;
        fields = {
          title: f.title.trim(),
          subjectIds: f.subjectIds,
          setupChapterId: f.setupChapterId,
          payoffChapterId: f.payoffChapterId,
        };
      }
    } else if (asset.fields !== undefined) return;
    if (
      asset.relatedSubjectIds !== undefined &&
      (kind !== 'subject' || action !== 'create' || !ids(asset.relatedSubjectIds))
    )
      return;
    cleanAssets.push({
      kind,
      action,
      id,
      fields,
      ...(asset.relatedSubjectIds && { relatedSubjectIds: asset.relatedSubjectIds as string[] }),
    });
  }
  if (new Set(cleanAssets.map(assetTarget)).size !== cleanAssets.length) return;
  const cleanPassages: EditPassage[] = [];
  for (const passage of passages) {
    if (
      !record(passage) ||
      !isId(passage.id) ||
      !isId(passage.chapterId) ||
      !nonempty(passage.note, 360) ||
      (passage.stage !== 'setup' && passage.stage !== 'reveal' && passage.stage !== 'addition') ||
      (passage.subjectIds !== undefined && !ids(passage.subjectIds)) ||
      (passage.clueIds !== undefined && !ids(passage.clueIds))
    )
      return;
    cleanPassages.push({
      id: passage.id,
      chapterId: passage.chapterId,
      stage: passage.stage,
      note: passage.note.trim(),
      subjectIds: passage.subjectIds as string[] | undefined,
      clueIds: passage.clueIds as string[] | undefined,
    });
  }
  if (new Set(cleanPassages.map(passageTarget)).size !== cleanPassages.length) return;
  return { summary: raw.summary.trim(), assets: cleanAssets, passages: cleanPassages };
}

export function readEditBasis(raw: unknown, plan: EditPlan): EditBasis | undefined {
  if (!record(raw) || !hash(raw.placement) || !record(raw.existingAssets)) return;
  const expected = new Set(plan.assets.filter((asset) => asset.action !== 'create').map(assetTarget));
  const rows = Object.entries(raw.existingAssets);
  if (
    rows.length !== expected.size ||
    !rows.every(([key, revision]) => expected.has(key) && hash(revision))
  )
    return;
  return {
    placement: raw.placement,
    existingAssets: Object.fromEntries(rows) as Record<string, string>,
  };
}

export function renderEditProposal(plan: EditPlan) {
  return [
    '本次建议的修改范围（尚未写入作品）：',
    plan.summary,
    ...plan.assets.map((a) => {
      const f = a.fields;
      const refs = a.relatedSubjectIds ?? f?.subjectIds;
      const timing = f?.setupChapterId
        ? `；${f.setupChapterId} 埋设，${f.payoffChapterId} 计划回收`
        : '';
      return `- ${actionName[a.action]}${nounName[a.kind]} ${f?.name ?? f?.title ?? a.id}（${a.id}）${refs?.length ? `；关联 ${refs.join('、')}` : ''}${timing}`;
    }),
    ...plan.passages.map((p) => `- ${p.chapterId}：${stageName[p.stage]}，${p.note}；同步该章大纲。`),
  ].join('\n');
}

export function readEditProposal(
  value: unknown,
  session: Session,
  lines: readonly ChatLine[],
): EditProposal | undefined {
  if (
    !record(value) ||
    !uuid(value.id) ||
    value.sessionId !== session.id ||
    !session.bookId ||
    value.bookId !== session.bookId ||
    typeof value.authorLine !== 'number' ||
    !Number.isSafeInteger(value.authorLine) ||
    value.authorLine < 0 ||
    typeof value.proposalLine !== 'number' ||
    !Number.isSafeInteger(value.proposalLine) ||
    value.proposalLine <= value.authorLine
  )
    return;
  const plan = readEditPlan(value.plan);
  const basis = plan && readEditBasis(value.basis, plan);
  if (
    !plan ||
    !basis ||
    lines[value.authorLine]?.role !== 'user' ||
    lines[value.proposalLine]?.role !== 'assistant' ||
    lines[value.proposalLine].text !== renderEditProposal(plan) ||
    lines.slice(value.authorLine + 1, value.proposalLine).some((line) => line.role === 'user')
  )
    return;
  return {
    id: value.id,
    sessionId: session.id,
    bookId: session.bookId,
    authorLine: value.authorLine,
    proposalLine: value.proposalLine,
    plan,
    basis,
  };
}

export function readEditCommit(value: unknown, plan: EditPlan): EditCommit | undefined {
  if (!record(value) || typeof value.target !== 'string' || !record(value.revisions)) return;
  const asset = plan.assets.find((a) => assetTarget(a) === value.target);
  const passage = plan.passages.find((p) => passageTarget(p) === value.target);
  if (!asset && !passage) return;
  const allowed = asset ? [assetTarget(asset)] : [`chapter/${passage!.chapterId}`, 'outline/outline'];
  const revisions = Object.entries(value.revisions);
  if (
    !revisions.length ||
    !revisions.every(([key, rev]) => allowed.includes(key) && hash(rev)) ||
    (passage && !hash(value.anchor)) ||
    (asset && value.anchor !== undefined)
  )
    return;
  let scene: EditCommit['scene'];
  if (value.scene !== undefined) {
    const v = value.scene;
    const number = (n: unknown, min: number, max: number): n is number =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
    const created = new Set(plan.assets.filter((a) => a.action === 'create').map(assetTarget));
    if (
      !passage ||
      !hash(value.revisions[`chapter/${passage.chapterId}`]) ||
      !record(v) ||
      !number(v.offset, 0, 2_000_000) ||
      !number(v.size, 1, 2210) ||
      !number(v.fragmentOffset, 0, 4) ||
      !number(v.length, 1, 2200) ||
      v.fragmentOffset + v.length > v.size ||
      !hash(v.digest) ||
      !Array.isArray(v.assets) ||
      !v.assets.length ||
      v.assets.length > maxEditTargets ||
      !v.assets.every((key) => typeof key === 'string' && created.has(key)) ||
      new Set(v.assets).size !== v.assets.length
    )
      return;
    scene = {
      offset: v.offset,
      size: v.size,
      fragmentOffset: v.fragmentOffset,
      length: v.length,
      digest: v.digest,
      assets: v.assets,
    };
  }
  let synced: EditCommit['synced'];
  if (value.synced !== undefined) {
    if (asset?.action !== 'create' || !record(value.synced)) return;
    const sources = Object.entries(value.synced);
    if (
      !sources.length ||
      sources.length > maxEditTargets ||
      !sources.every(([key, rev]) => hash(rev) && plan.passages.some((p) => passageTarget(p) === key))
    )
      return;
    synced = Object.fromEntries(sources) as Record<string, string>;
  }
  return {
    target: value.target,
    revisions: Object.fromEntries(revisions) as Record<string, string>,
    anchor: value.anchor as string | undefined,
    ...(scene && { scene }),
    ...(synced && { synced }),
  };
}

export function proposalOnly(prompt: string) {
  const p = prompt.normalize('NFKC').trim();
  if (
    /(?:只|仅)(?:需|要)?\s*(?:先\s*)?(?:看(?:看)?|讨论|给出?|列出)\s*(?:修改)?(?:方案|建议|思路)/u.test(
      p,
    )
  )
    return true;
  if (
    /(?:先|暂时|这次)?(?:不要|别|无需|不必|不)(?:执行(?:该|此|这个)?方案|执行|写入|提交修改|(?:修改|改)(?:作品|原稿|稿件)|改稿)(?=$|[。,.!！,，；;\s])/u.test(
      p,
    )
  )
    return true;
  // Looking at the manuscript to decide *how* to edit is not a request for approval.
  if (
    /(?:^|[，,。；;！!\n]|(?:想|考虑)好(?:之|以)?后)\s*(?:请|你)?\s*(?:就)?直接\s*(?:改(?:吧|就行|即可|[。！!，,；;]|$)|修改|执行|动手)/u.test(
      p,
    )
  )
    return false;
  return (
    /^(?:(?:请|麻烦|帮我|你|先|只|仅)\s*)*(?:讨论|聊聊|想想|给我建议|先看方案|看看(?:要|该|怎么|如何)|分析(?:一下)?(?:要|怎么|哪些))/u.test(
      p,
    ) ||
    /[。；;\n]\s*(?:请|你|先|帮我|麻烦)*\s*(?:看看|分析(?:一下)?|说说|列出)\s*(?:要|需要|该|可以|怎么|如何|哪些)/u.test(
      p,
    )
  );
}

export function approvesEdit(prompt: string) {
  const p = prompt
    .normalize('NFKC')
    .trim()
    .replace(/^(?:(?:嗯+|好的?|可以|行|同意)[,，。！!\s]+)+/u, '');
  return (
    /^(?:(?:请|就)\s*)*(?:按|照|依照|按照)(?:这个|该|刚才的?|上面(?:的)?|上一(?:份|轮的?))(?:修改)?(?:方案|安排|建议)?\s*(?:来)?(?:修改|改|做|执行|处理)|^我允许你所有操作|^(?:我不是说了[^？?\n]{0,40}[？?]\s*)?(?:请\s*)?(?:就\s*)?直接\s*(?:改|修改|执行)(?:吧|就行|即可)?(?:[,，]\s*(?:没啥问题|没问题|不用确认|不需要确认))?[。！!\s]*$/u.test(
      p,
    ) && !/[?？]\s*$/u.test(p)
  );
}

export const continuesEdit = (prompt: string) =>
  /^(?:请\s*)?(?:继续(?:执行|修改|做|完成)?|按(?:原|这个|上一份)方案继续)(?:[。！!\s]*|[,，;；].*)$/u.test(
    prompt.normalize('NFKC').trim(),
  );

/** Only an unbroken chain of actual author replies may refer to the displayed proposal. */
export function confirmedEdit(saved: BookEdit | undefined, lines: readonly ChatLine[], prompt: string) {
  if (!saved || proposalOnly(prompt) || (!approvesEdit(prompt) && !continuesEdit(prompt))) return;
  const replies = lines
    .slice(saved.proposal.proposalLine + 1)
    .filter((line) => line.role === 'user')
    .map((line) => line.text);
  if (
    (!replies.length && !approvesEdit(prompt)) ||
    (replies.length &&
      (!approvesEdit(replies[0]) ||
        replies.some((s) => proposalOnly(s) || (!approvesEdit(s) && !continuesEdit(s)))))
  )
    return;
  return { ...saved, replies: [...replies, prompt] };
}

export function targetRevisions(edit: BookEdit, target: string) {
  return Object.assign(
    {},
    ...edit.commits.filter((r) => r.target === target).map((r) => r.revisions),
  ) as Record<string, string>;
}
export function currentEditRevisions(edit: BookEdit) {
  return Object.assign({}, ...edit.commits.map((r) => r.revisions)) as Record<string, string>;
}
