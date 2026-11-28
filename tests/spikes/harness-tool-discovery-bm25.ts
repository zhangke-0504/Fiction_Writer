import type { LocalTool } from '../../electron/agent/local-tool.js';
import { parseToolQuery } from '../../electron/agent/tool-discovery.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const k1 = 1.2;
const b = 0.75;
const relativeCutoff = 0.35;

export function bm25Terms(input: string) {
  const text = input
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ');
  const words = [...segmenter.segment(text)]
    .filter(({ isWordLike }) => isWordLike)
    .map(({ segment }) => segment);
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let i = 1; i < chars.length; i++) words.push(`bi:${chars[i - 1]}${chars[i]}`);
  }
  return words;
}

function indexField(text: string) {
  const terms = bm25Terms(text);
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return { length: terms.length, counts };
}

export function rankBm25(query: string, tools: LocalTool[]) {
  const { ids, text } = parseToolQuery(query, new Set(tools.map(({ name }) => name)));
  const words = [...new Set(bm25Terms(text))];
  if (!words.length || ids.length >= 6 || !tools.length) return ids.slice(0, 6);

  const documents = tools.map((tool) => ({
    name: tool.name,
    fields: [
      { text: tool.name, weight: 3 },
      { text: tool.discovery?.aliases?.join(' ') ?? '', weight: 3 },
      { text: tool.discovery?.purpose ?? '', weight: 2 },
      { text: Object.keys(tool.schema.properties ?? {}).join(' '), weight: 0.5 },
    ].map(({ text, weight }) => ({ ...indexField(text), weight })),
  }));
  const meanLengths = documents[0].fields.map((_, i) =>
    Math.max(documents.reduce((sum, { fields }) => sum + fields[i].length, 0) / documents.length, 1),
  );
  const terms = words.map((word) => {
    const frequency = documents.filter(({ fields }) =>
      fields.some(({ counts }) => counts.has(word)),
    ).length;
    const idf = Math.log1p((documents.length - frequency + 0.5) / (frequency + 0.5));
    return { word, idf: word.startsWith('bi:') ? idf * 0.35 : idf };
  });
  const matches = documents
    .filter(({ name }) => !ids.includes(name))
    .map(({ name, fields }) => ({
      name,
      score: terms.reduce((score, { word, idf }) => {
        const signal = fields.reduce((sum, { counts, length, weight }, i) => {
          const norm = 1 - b + (b * length) / meanLengths[i];
          return sum + (weight * (counts.get(word) ?? 0)) / norm;
        }, 0);
        return score + (idf * ((k1 + 1) * signal)) / (k1 + signal);
      }, 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const floor = (matches[0]?.score ?? 0) * relativeCutoff;
  return [...ids, ...matches.filter(({ score }) => score >= floor).map(({ name }) => name)].slice(0, 6);
}
