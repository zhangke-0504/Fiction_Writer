import type { Manuscript } from '../../shared/contracts.js';

const digits = '零一二三四五六七八九';
export function chapterOrder(target: string) {
  const found = target.match(/^第\s*([\d零一二三四五六七八九十两]+)\s*章$/u)?.[1];
  if (!found) return Number(/^chapter\s+(\d+)$/i.exec(target)?.[1]);
  if (/^\d+$/.test(found)) return Number(found);
  const number = found.replaceAll('两', '二');
  if (number.length === 1 && number !== '十') return digits.indexOf(number);
  if (!/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(number)) return NaN;
  const [tens, ones] = number.split('十');
  return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
}

/** Destructive rewrite is authorized by the author's direct current command, not a tool argument. */
export function rewriteTarget(prompt: string, chapters: Manuscript[], selected?: string) {
  const source = prompt.normalize('NFKC').trim();
  const clause = /^([^\n，,。!！?？;；]+)([\n，,。!！?？;；]|$)/u.exec(source);
  if (
    !clause ||
    ['?', '？'].includes(clause[2]) ||
    /(?:不要|别|无需|禁止|不许|不得|不能|不必|避免)[^\n，。；!?]{0,24}(?:重写|重新写|覆盖)|\b(?:do not|don't|never)\s+rewrite\b/iu.test(
      source,
    )
  )
    return undefined;
  const request = clause[1].trim().replace(/^(?:(?:请帮我|请你|请|帮我|麻烦你)\s*|please\s+)/iu, '');
  const raw =
    /^(?:从头\s*)?(?:重写|重新写)\s*(.+)$/u.exec(request)?.[1] ??
    /^(?:把|将)\s*(.+?)\s*(?:从头\s*)?(?:重写|重新写)$/u.exec(request)?.[1] ??
    /^rewrite\s+(.+)$/iu.exec(request)?.[1];
  if (!raw) return undefined;
  const target = raw
    .trim()
    .replace(/(?:的)?(?:正文|全文)\s*$/u, '')
    .trim()
    .replace(/^[「『《“"']|[」』》”"']$/gu, '');
  if (/^(?:本章|当前章(?:节)?|选中章(?:节)?|这[一]?章)$/u.test(target)) return selected;
  const order = chapterOrder(target);
  const matches = chapters.filter((doc) =>
    Number.isInteger(order) && order > 0
      ? doc.fields.order === order
      : doc.id === target || doc.fields.title === target,
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

/** Use the earliest referenced chapter if ambiguous, so recall cannot add later prose. */
export function memoryChapterTarget(prompt: string, chapters: Manuscript[], selected?: string) {
  const text = prompt.normalize('NFKC');
  const orders = new Set(
    [...text.matchAll(/第\s*[\d零一二三四五六七八九十两]+\s*章|\bchapter\s+\d+\b/giu)].map(([value]) =>
      chapterOrder(value),
    ),
  );
  return (
    chapters.find(
      (chapter) =>
        orders.has(chapter.fields.order ?? -1) ||
        (chapter.fields.title &&
          chapter.fields.title.length >= 3 &&
          text.includes(chapter.fields.title.normalize('NFKC'))),
    )?.id ?? selected
  );
}

/** A request for actual entry into an existing story can authorize an addition, never a replacement. */
export function wantsPassageAddition(prompt: string) {
  const text = prompt.normalize('NFKC').trim();
  if (/(?:新增|另加|插入|添加|增设|补写)\s*(?:一|1)?\s*(?:个)?章(?:节)?|插章/u.test(text)) return false;
  if (
    /^(?:(?:请|帮我|麻烦)\s*)?(?:先|只|仅)?(?:讨论|分析|聊聊|设想|假设|想想|考虑|给我建议)/u.test(
      text,
    ) ||
    /[?？]\s*$/u.test(text)
  )
    return false;
  if (
    /(?:只|仅)(?:需|要)?(?:做|改|补|写|生成|整理)?\s*(?:资料|大纲|设定|说明)|(?:不要|别|禁止|无需|不许|不得|不必|不)[^。；;，,\n]{0,16}(?:改(?:动|写)?(?:任何|任何一)?(?:章节|正文)|改任何一章|动(?:任何)?(?:章节|正文)|写(?:入)?正文|插入正文|登场|出场|露面|现身)/u.test(
      text,
    )
  )
    return false;
  return (
    /新增|增加|加入|加上|加一个|添加|插入|补写|补一段|增补/u.test(text) &&
    /登场|出场|露面|现身|插入|正文|场景|(?:第[^，。\n]{1,7}章|本章|当前章)[^，。\n]{0,12}(?:加入|一段)/u.test(
      text,
    )
  );
}

export function wantsStagedAntagonist(prompt: string) {
  const source = prompt.normalize('NFKC');
  return (
    wantsPassageAddition(source) &&
    /(?:新增|增加|加入|添加|加一个)[^，,。；;\n]{0,65}反派/u.test(source) &&
    /(?:中期|中段)[^。；;\n]{0,50}(?:迹象|暗线|伏笔|线索)/u.test(source) &&
    /(?:后期|后段)[^。；;\n]{0,40}(?:登场|出场|露面|现身)/u.test(source)
  );
}

export function chapterStage(chapters: Manuscript[], target: string) {
  const index = chapters
    .slice()
    .sort((a, b) => (a.fields.order ?? 0) - (b.fields.order ?? 0))
    .findIndex(({ id }) => id === target);
  if (index < Math.floor(chapters.length / 3)) return;
  return index < Math.ceil((chapters.length * 2) / 3) ? 'setup' : 'reveal';
}

export function passageTargetAllowed(
  prompt: string,
  chapters: Manuscript[],
  target: string,
  selected?: string,
) {
  if (!wantsPassageAddition(prompt)) return false;
  const source = prompt.normalize('NFKC');
  const direct = [
    ...source.matchAll(/第\s*[\d零一二三四五六七八九十两]+\s*章|\bchapter\s+\d+\b/giu),
  ].map(([text]) => chapterOrder(text));
  if (direct.length)
    return (
      new Set(direct).size === 1 &&
      chapters.some(({ id, fields }) => id === target && fields.order === direct[0])
    );
  if (/本章|当前章|这一章|选中章/u.test(source)) return target === selected;
  const named = chapters.filter(
    ({ fields }) =>
      fields.title && fields.title.length > 2 && source.includes(fields.title.normalize('NFKC')),
  );
  if (named.length) return named.length === 1 && named[0].id === target;
  const stage = chapterStage(chapters, target);
  if (wantsStagedAntagonist(source)) return stage !== undefined;
  if (/中期|中段|故事中间/u.test(source)) return stage === 'setup';
  return false;
}

export function minimumExistingSubjects(prompt: string) {
  if (!wantsPassageAddition(prompt)) return 0;
  const count =
    /(?:至少\s*)?([\d一二三四五六七八九十两]+)\s*(?:个|位|项)\s*(?:以上)?\s*(?:不同的?)?\s*(?:已有|既有|现有|人物(?=主体))\s*(?:主体|人物|角色)/u.exec(
      prompt.normalize('NFKC'),
    )?.[1];
  return count ? chapterOrder(`第${count}章`) || 0 : 0;
}

/** Only the current author's directive (not prior dialogue, proposed plans, or file contents) can narrow a patch. */
export function blocksProsePatch(prompt: string) {
  const text = prompt.normalize('NFKC');
  return /(?:不要|别|禁止|不许|不得|不能|无需|不必|不)\s*(?:再|擅自|自动|直接|自行)?\s*(?:动(?:笔|稿|正文|任何章)|写入|修(?:改|订|稿|正|补)|改(?:稿|动|写|正文|章|第|本章|这一章)|纠正|更正|勘误)|(?:仅|只)(?:需要|需|要)?\s*(?:讨论|分析|查看|阅读|检查|审阅|汇报|报告|列出|续写|插入|增补)|do not (?:edit|patch|modify|change|correct)\b/iu.test(
    text,
  );
}

const chapterRef =
  /^(第\s*[\d零一二三四五六七八九十两]+\s*章|chapter\s+\d+|本章|这[一]?章|当前章(?:节)?|选中章(?:节)?)/iu;
const quoted = /“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"]+)"/gu;

export function prosePatchIntent(prompt: string, chapters: Manuscript[], selected?: string) {
  // Mask quoted text for intent parsing (the exact values remain available for literal scope checks).
  const literals: string[] = [];
  const masked = prompt
    .replace(quoted, (...match) => {
      literals.push(match.slice(1, 5).find((value) => typeof value === 'string')!);
      return '\uE000' + (literals.length - 1) + '\uE001';
    })
    .normalize('NFKC')
    .trim();
  if (blocksProsePatch(masked) || /[?]\s*$/u.test(masked) || rewriteTarget(masked, chapters, selected))
    return;
  const command = masked
    .split(/(?:[，,。；;！!?]|\r?\n)/u, 1)[0]
    .replace(/^(?:(?:请帮我|请你|请|帮我|麻烦你|只|仅)\s*)+/u, '');
  const action =
    /^(?:定点|局部)?(?:修改|修正|修一下|修复|纠正|更正|勘误|改正|改一下|改|替换|删掉|删除|去掉)\s*/u;
  const conversion = /(?:替换|更正|修改|纠正|修正|改)(?:成|为|作|得)|改一下|修正|删掉|删除/u;
  let subject: string,
    commandText = command;
  if (/^(?:把|将)\s*/u.test(command)) {
    subject = command.replace(/^(?:把|将)\s*/u, '').split(conversion, 1)[0];
    if (!conversion.test(command)) return;
  } else if (/^在\s*/u.test(command)) {
    subject = command.replace(/^在\s*/u, '');
  } else if (action.test(command)) subject = command.replace(action, '');
  else return;
  const ref = chapterRef.exec(subject)?.[1];
  const labeled = (value: string) =>
    subject.startsWith(value) && /^(?:$|[的里中\s:：\uE000])/u.test(subject.slice(value.length));
  const marker = /^\uE000(\d+)\uE001/u.exec(subject);
  const names = chapters.filter(({ id, fields }) =>
    ref
      ? /^第|^chapter\s/i.test(ref)
        ? fields.order === chapterOrder(ref)
        : id === selected
      : labeled(id) ||
        (!!fields.title &&
          (labeled(fields.title.normalize('NFKC')) ||
            (marker && literals[Number(marker[1])] === fields.title))),
  );
  if (names.length !== 1) return;
  const target = names[0];
  const targetLength =
    ref?.length ??
    (marker
      ? marker[0].length
      : labeled(target.id)
        ? target.id.length
        : target.fields.title!.normalize('NFKC').length);
  const focus = subject
    .slice(targetLength)
    .replace(/^[\s的里中:：]+/u, '')
    .trim();
  if (
    !focus ||
    /^(?:正文|全文|章节|内容|全部|整章|这一章|所有内容)$/u.test(focus) ||
    /^(?:和|及|以及|、|还有)\s*(?:第\s*[\d零一二三四五六七八九十两]+\s*章|ch(?:apter)?[-_ ]?\d+)/iu.test(
      focus,
    )
  )
    return;
  if (/^(?:在)/u.test(command)) {
    if (!/^(?:把|将)/u.test(focus) && !action.test(focus)) return;
    if (/^(?:把|将)/u.test(focus) && !conversion.test(focus)) return;
    commandText = focus;
  }
  const literalEdits = [...focus.matchAll(/\uE000(\d+)\uE001/gu)];
  const from = literalEdits[0] && literals[Number(literalEdits[0][1])];
  const pair =
    from &&
    new RegExp(
      '\\uE000' +
        literalEdits[0][1] +
        '\\uE001\\s*(?:改成|改为|改作|替换为|替换成|更正为)\\s*\\uE000(\\d+)\\uE001',
      'u',
    ).exec(commandText);
  const exact =
    from && pair && commandText.endsWith(pair[0]) && masked.replace(/[。！!]$/u, '').endsWith(pair[0])
      ? { quote: from, replacement: literals[Number(pair[1])] }
      : undefined;
  return { chapterId: target.id, exact };
}
