import { createHash } from 'node:crypto';
import { parser } from '@lezer/markdown';
import { parse as yaml, stringify } from 'yaml';
import type { DocRef, DocType, Fields, Manuscript } from '../shared/contracts.js';

export const itemFolders = { subject: 'subjects', clue: 'foreshadowing', chapter: 'chapters' } as const;
export const kinds = ['character', 'item', 'scene'];
export const maxDocBytes = 2_000_000;
export const isId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
export const docKey = (doc: DocRef) => `${doc.type}/${doc.id}`;
export const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code = 'workspace_error',
  ) {
    super(message);
  }
}
export function validateFields(type: DocType, fields: Fields, body: string) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || typeof body !== 'string')
    throw new WorkspaceError('文档格式无效', 'validation');
  if (Buffer.byteLength(body) > maxDocBytes) throw new WorkspaceError('文档超过 2 MB', 'validation');
  const required = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 500)
      throw new WorkspaceError(`${name}必须是有效的非空文本`, 'validation');
  };
  const optional = (value: unknown, name: string) => {
    if (value !== undefined && typeof value !== 'string')
      throw new WorkspaceError(`${name}必须是文本`, 'validation');
  };
  const ids = (value: unknown, name: string) => {
    if (value !== undefined && (!Array.isArray(value) || value.length > 5000 || !value.every(isId)))
      throw new WorkspaceError(`${name}必须是有效 ID 列表`, 'validation');
  };
  if (type === 'book') {
    required(fields.title, '小说名');
    if (!body.trim()) throw new WorkspaceError('简介不能为空', 'validation');
    optional(fields.author, '作者');
    optional(fields.genre, '题材');
    optional(fields.style, '文风');
  }
  if (type === 'subject') {
    required(fields.name, '主体名称');
    if (!kinds.includes(fields.kind ?? ''))
      throw new WorkspaceError('主体类型须为人物、物品或场景', 'validation');
  }
  if (type === 'chapter') {
    required(fields.title, '章节名');
    if (!Number.isSafeInteger(fields.order) || fields.order! < 1)
      throw new WorkspaceError('章节顺序必须是正整数', 'validation');
    ids(fields.beatIds, '情节点');
  }
  if (type === 'clue') {
    required(fields.title, '伏笔名称');
    ids(fields.subjectIds, '关联主体');
    for (const key of ['setupChapterId', 'payoffChapterId', 'setupBeatId', 'payoffBeatId'] as const)
      if (fields[key] !== undefined && !isId(fields[key]))
        throw new WorkspaceError(`无效关联：${key}`, 'validation');
    if ((fields.setupChapterId && fields.setupBeatId) || (fields.payoffChapterId && fields.payoffBeatId))
      throw new WorkspaceError('埋设或回收点不能同时关联章节和待绑定情节点', 'validation');
  }
}
export function parseDocument(ref: DocRef, bytes: Uint8Array): Manuscript {
  if (bytes.byteLength > maxDocBytes + 24_000) throw new WorkspaceError('文档超过大小限制');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    revision = digest(bytes);
  if (ref.type === 'outline') return { ...ref, fields: {}, body: text, revision };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new WorkspaceError('缺少或未闭合的 YAML frontmatter', 'invalid_frontmatter');
  let fields: Fields;
  try {
    fields = yaml(match[1]) as Fields;
  } catch {
    throw new WorkspaceError('无法解析 YAML frontmatter', 'invalid_frontmatter');
  }
  const body = match[2];
  validateFields(ref.type, fields, body);
  if (fields.id !== undefined && fields.id !== ref.id)
    throw new WorkspaceError('元数据 ID 与文件身份不同', 'invalid_frontmatter');
  return { ...ref, fields: { ...fields, id: ref.id }, body, revision };
}
export function renderDocument(ref: DocRef, fields: Fields, body: string) {
  validateFields(ref.type, fields, body);
  if (ref.type === 'outline') return body;
  if (fields.id !== undefined && fields.id !== ref.id)
    throw new WorkspaceError('不能通过写入改变文档身份');
  return `---\n${stringify({ ...fields, id: ref.id }).trimEnd()}\n---\n${body}`;
}

function itemType(folder: string): DocType | undefined {
  return Object.entries(itemFolders).find(([, name]) => name === folder)?.[0] as DocType | undefined;
}
export function storyLinks(body: string) {
  const links: { ref: DocRef; from: number; to: number; label: string }[] = [];
  parser.parse(body).iterate({
    enter: (node) => {
      if (node.name !== 'Link') return;
      const url = node.node.getChild('URL'),
        marks = node.node.getChildren('LinkMark');
      if (!url || !marks[1]) return;
      const match =
        /^(?:\.\.\/|\.\/)?(subjects|foreshadowing|chapters)\/([A-Za-z0-9_-]+)\.md(?:#[^\s]*)?$/.exec(
          body.slice(url.from, url.to),
        );
      if (!match || !isId(match[2])) return;
      links.push({
        ref: { type: itemType(match[1])!, id: match[2] },
        from: node.from,
        to: node.to,
        label: body.slice(node.from + 1, marks[1].from),
      });
    },
  });
  return links;
}
export function storyBeats(body: string) {
  const ids: string[] = [];
  parser.parse(body).iterate({
    enter: (node) => {
      if (node.name !== 'CommentBlock' && node.name !== 'Comment') return;
      const match = /^<!--\s*beat:([A-Za-z0-9_-]+)\s*-->\s*$/.exec(body.slice(node.from, node.to));
      if (match && isId(match[1])) ids.push(match[1]);
    },
  });
  return ids;
}
function itemRefs(doc: Pick<Manuscript, 'type' | 'fields' | 'body'>) {
  const refs = storyLinks(doc.body).map((link) => docKey(link.ref));
  if (doc.type === 'clue') {
    for (const id of doc.fields.subjectIds ?? []) refs.push(`subject/${id}`);
    for (const id of [doc.fields.setupChapterId, doc.fields.payoffChapterId])
      if (id) refs.push(`chapter/${id}`);
    for (const id of [doc.fields.setupBeatId, doc.fields.payoffBeatId]) if (id) refs.push(`beat/${id}`);
  }
  if (doc.type === 'chapter') for (const id of doc.fields.beatIds ?? []) refs.push(`beat/${id}`);
  return refs;
}
export function referenceErrors(
  doc: Pick<Manuscript, 'type' | 'fields' | 'body'>,
  targetKeys: ReadonlySet<string>,
  beats: string[],
) {
  const allowed = new Set([...targetKeys, ...beats.map((id) => `beat/${id}`)]);
  return [...new Set(itemRefs(doc).filter((key) => !allowed.has(key)))];
}
export function unlinkRemoved(
  doc: Manuscript,
  removed: ReadonlySet<string>,
  removedBeats: ReadonlySet<string>,
) {
  const fields = { ...doc.fields };
  let body = doc.body;
  if (removed.size) {
    for (const link of storyLinks(body)
      .filter((link) => removed.has(docKey(link.ref)))
      .sort((a, b) => b.from - a.from))
      body = body.slice(0, link.from) + link.label + body.slice(link.to);
    if (doc.type === 'clue') {
      if (fields.subjectIds)
        fields.subjectIds = fields.subjectIds.filter((id) => !removed.has(`subject/${id}`));
      if (fields.setupChapterId && removed.has(`chapter/${fields.setupChapterId}`))
        delete fields.setupChapterId;
      if (fields.payoffChapterId && removed.has(`chapter/${fields.payoffChapterId}`))
        delete fields.payoffChapterId;
    }
  }
  if (removedBeats.size) {
    if (doc.type === 'clue') {
      if (fields.setupBeatId && removedBeats.has(fields.setupBeatId)) delete fields.setupBeatId;
      if (fields.payoffBeatId && removedBeats.has(fields.payoffBeatId)) delete fields.payoffBeatId;
    }
    if (doc.type === 'chapter' && fields.beatIds)
      fields.beatIds = fields.beatIds.filter((id) => !removedBeats.has(id));
  }
  return {
    body,
    fields,
    changed: body !== doc.body || JSON.stringify(fields) !== JSON.stringify(doc.fields),
  };
}
