import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  BookView,
  LibraryView,
  Manuscript,
  ModelProfile,
  Protocol,
  RuntimeView,
  Session,
} from '../../shared/contracts.js';
import { isOfficialDeepSeek } from '../../electron/agent/provider-capabilities.js';
import { readDiagnostics } from './diagnostic-files.js';

const title = '黄灯侠';
const summary = '基于DC漫画七灯军团里的黄灯来写的故事';
const whole =
  '根据设定编写10章内容。每章正文约50个汉字，写成一个有情节推进的微型场景，不要写成梗概。' +
  '整书只建3个人物主体和1条有埋设与回收的伏笔，不建物品、地点等额外主体。大纲每章一句，人物卡和伏笔说明各保持简短。';
const entry =
  '增加一个跟2个以上人物主体有关联的反派吧，然后剧情中期增加一些该反派的线索，到了后期才抛头露面。你看看要怎么改，想好之后直接改就行，不需要找我确认';
const followUp = '解决未清理的问题';
const maxWholeRuns = 12; // At most ten chapter advances and two no-progress attempts.
const runWaitMinutes = Number(process.env.FW_LIVE_RUN_WAIT_MINUTES ?? 20);
if (!Number.isSafeInteger(runWaitMinutes) || runWaitMinutes <= 0)
  throw new Error('FW_LIVE_RUN_WAIT_MINUTES must be a positive whole number');
const runWaitMs = runWaitMinutes * 60_000;
const configPath = process.env.FW_LIVE_PROFILE_FILE;
const profileName = process.env.FW_LIVE_PROFILE_NAME;
const { FW_LIVE_API_KEY: apiKey, ...appEnvironment } = process.env;
const liveBase = process.env.FW_LIVE_BASE_URL;
const liveModel = process.env.FW_LIVE_MODEL;
const liveProtocol = process.env.FW_LIVE_PROTOCOL as Protocol | undefined;
const supplied = !!(apiKey && liveBase && liveModel && liveProtocol);
const rpc = <T>(page: Page, method: string, args?: unknown) =>
  page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);

// Explicit opt-in: real billing / network and a compatible encrypted local profile. Nothing is sent
// to a provider unless both options are present. The app decrypts with its normal OS safeStorage.
test('real-provider Yellow Lantern: ten chapters, scoped antagonist addition and conditional follow-up', async ({}, info) => {
  test.skip(
    !(configPath && profileName) && !supplied,
    'provide a live API key with model/base URL/protocol, or a compatible encrypted profile',
  );
  test.setTimeout((maxWholeRuns + 2) * runWaitMs + 60_000);
  const root = info.outputPath('isolated-app');
  const state = join(root, 'state');
  const isolatedProfile = join(state, 'profiles.json');
  let profileId: string | undefined;
  let copied = false;
  if (!supplied) {
    const stored: unknown = JSON.parse(await readFile(configPath!, 'utf8'));
    if (!Array.isArray(stored))
      throw new Error('The configured live profile file is not a profile list');
    const profiles = stored.filter((profile) => profile?.name === profileName);
    if (
      profiles.length !== 1 ||
      typeof profiles[0].cipher !== 'string' ||
      typeof profiles[0].id !== 'string'
    )
      throw new Error('Choose one unique encrypted profile by name');
    profileId = profiles[0].id;
    await mkdir(state, { recursive: true });
    await writeFile(isolatedProfile, JSON.stringify(profiles), { flag: 'wx', mode: 0o600 });
    copied = true;
  }
  try {
    const app = await electron.launch({
      args: ['.'],
      env: { ...appEnvironment, FW_E2E: '1', FW_TEST_ROOT: root, FW_E2E_SHOW_WINDOW: '0' },
    });
    try {
      const page = await app.firstWindow();
      if (supplied) {
        const profile = await rpc<ModelProfile>(page, 'profiles.save', {
          name: 'live-acceptance',
          apiKey,
          baseUrl: liveBase,
          model: liveModel,
          protocol: liveProtocol,
          providerId: isOfficialDeepSeek({ baseUrl: liveBase, protocol: liveProtocol })
            ? 'deepseek'
            : 'custom',
        });
        if (profile.providerId === 'deepseek')
          expect(profile.capabilities?.source).not.toBe('generic-fallback');
        profileId = profile.id;
      }
      const ping = await rpc<{ libraryRoot: string }>(page, 'ping');
      const library = await realpath(ping.libraryRoot);
      expect(library).toBe(await realpath(join(root, 'library')));
      for (const existing of (await rpc<LibraryView>(page, 'library.list')).books.filter(
        (book) => book.title === title,
      )) {
        const actual = await realpath(join(library, existing.id));
        const underneath = relative(library, actual);
        if (
          !underneath ||
          underneath.startsWith('..' + sep) ||
          underneath === '..' ||
          isAbsolute(underneath)
        )
          throw new Error('Refusing to delete outside the live test library');
        await rpc(page, 'book.delete', { bookId: existing.id });
      }
      const { id: bookId } = await rpc<{ id: string }>(page, 'book.create', { title, summary });
      const session = await rpc<Session>(page, 'session.create', { bookId });
      const view = async () =>
        (await rpc<RuntimeView>(page, 'runtime.snapshot', { bookId })).sessions.find(
          ({ session: item }) => item.id === session.id,
        );
      const submit = async (prompt: string) => {
        const { runId } = await rpc<{ runId: string }>(page, 'session.start', {
          id: session.id,
          profileId,
          prompt,
          effort: 'high',
        });
        await expect
          .poll(
            async () =>
              (await readDiagnostics(root, 'backend')).some(
                ({ event, fields }) => event === 'run.finished' && fields.runId === runId,
              ),
            { timeout: runWaitMs, intervals: [300, 1200, 2200] },
          )
          .toBe(true);
        return (await view())!.run!;
      };
      const disk = async () => {
        const index = await rpc<BookView>(page, 'book.read', { bookId });
        expect(index.diagnostics).toEqual([]);
        const docs: Manuscript[] = [];
        for (const { type, id } of index.documents)
          docs.push(await rpc<Manuscript>(page, 'book.doc.read', { bookId, doc: { type, id } }));
        return docs;
      };
      const chapters = (docs: Manuscript[]) =>
        docs
          .filter((doc) => doc.type === 'chapter')
          .sort((a, b) => (a.fields.order ?? 0) - (b.fields.order ?? 0));
      let initial = await submit(whole);
      let original = await disk();
      let stalled = 0;
      const wholeRuns = [initial.id];
      const savedCount = (docs: Manuscript[]) => chapters(docs).filter(({ body }) => body.trim()).length;
      while (!initial.progress?.complete && wholeRuns.length < maxWholeRuns && stalled < 2) {
        const rows = (await readDiagnostics(root, 'backend')).filter(
          ({ fields }) => fields.runId === initial.id,
        );
        const recoverable = rows.some(
          ({ event, fields }) =>
            (event === 'model.finished' || event === 'run.finished') &&
            ['output_limit', 'incomplete_stream', 'timeout'].includes(fields.reason),
        );
        if (!recoverable && initial.taskOutcome !== 'partial') break;
        const before = chapters(original);
        initial = await submit('继续');
        wholeRuns.push(initial.id);
        const next = await disk();
        const after = chapters(next);
        for (const doc of before.filter(({ body }) => body.trim()))
          expect(after.find(({ id }) => id === doc.id)?.revision).toBe(doc.revision);
        stalled = savedCount(next) > savedCount(original) ? 0 : stalled + 1;
        original = next;
      }
      const wholeRows = (await readDiagnostics(root, 'backend')).filter(({ fields }) =>
        wholeRuns.includes(fields.runId),
      );
      const draftRequests = wholeRows.filter(
        ({ event, fields }) => event === 'model.budget_dispatched' && fields.lane === 'draft',
      );
      expect(draftRequests.length, 'no chapter requests were dispatched').toBeGreaterThanOrEqual(10);
      expect([...new Set(draftRequests.map(({ fields }) => fields.purpose))]).toEqual(['long-writing']);
      expect(initial.status, initial.error).toBe('completed');
      expect(initial.progress?.complete).toBe(true);
      // Preserve the pre-addition revisions for semantic inspection even if a later stage fails.
      await writeFile(
        join(root, 'whole-baseline.json'),
        JSON.stringify({ wholeRuns, documents: original }, null, 2),
        { flag: 'wx' },
      );
      expect(chapters(original)).toHaveLength(10);
      for (const doc of chapters(original)) {
        const length = Array.from(doc.body.replace(/\s/gu, '')).length;
        expect(length, `${doc.id} has no prose`).toBeGreaterThan(0);
        expect(length, `${doc.id} exceeds the short-draft fixture guard`).toBeLessThanOrEqual(100);
      }
      expect(original.find(({ type }) => type === 'outline')?.body.trim()).toBeTruthy();
      const subjects = original.filter(({ type }) => type === 'subject');
      expect(subjects).toHaveLength(3);
      expect(subjects.every(({ fields, body }) => fields.kind === 'character' && body.trim())).toBe(
        true,
      );
      const clues = original.filter(({ type }) => type === 'clue');
      expect(clues).toHaveLength(1);
      const [{ body, fields }] = clues;
      expect(body.trim()).toBeTruthy();
      expect(fields.setupChapterId).toBeTruthy();
      expect(fields.payoffChapterId).toBeTruthy();
      const added = await submit(entry);
      let after = await disk();
      const editRuns = [added.id];
      const changedChapters = (docs: Manuscript[]) =>
        chapters(docs).filter(
          (doc) => chapters(original).find(({ id }) => id === doc.id)?.revision !== doc.revision,
        );
      const oldIds = new Set(original.filter(({ type }) => type === 'subject').map(({ id }) => id));
      const newActors = (docs: Manuscript[]) =>
        docs.filter(
          ({ type, id, fields }) => type === 'subject' && !oldIds.has(id) && fields.kind === 'character',
        );
      const linksOldSubjects = (doc: Manuscript) =>
        [...oldIds].filter((id) => doc.body.includes(`subjects/${id}.md`)).length >= 2;
      const follow =
        added.status !== 'completed' ||
        added.taskOutcome === 'partial' ||
        added.taskOutcome === 'incomplete' ||
        changedChapters(after).length < 2 ||
        !newActors(after).some(linksOldSubjects) ||
        process.env.FW_LIVE_HAS_REMAINING === '1';
      if (follow) {
        const settled = await submit(followUp);
        editRuns.push(settled.id);
        after = await disk();
        expect(settled.status, settled.error).toBe('completed');
        expect(['fulfilled', 'no_write_needed']).toContain(settled.taskOutcome);
      }
      await writeFile(
        join(root, 'edit-readback.json'),
        JSON.stringify({ editRuns, followedUp: follow, documents: after }, null, 2),
        { flag: 'wx' },
      );
      const rows = await readDiagnostics(root, 'backend');
      let sawScope = false;
      for (const runId of editRuns) {
        const trace = rows.filter(({ fields }) => fields.runId === runId);
        const firstRequest = trace.find(
          ({ event, fields }) => event === 'model.budget_dispatched' && fields.lane === 'agent',
        );
        expect(firstRequest).toBeDefined();
        const scope = trace.find(
          ({ event, fields }) => event === 'writing.task_scope' && fields.outcome === 'ok',
        );
        if (scope) {
          expect(scope.logSeq).toBeGreaterThan(firstRequest!.logSeq);
          sawScope = true;
        }
        for (const recall of trace.filter(({ event }) => event === 'memory.recall.finished')) {
          expect(recall.logSeq).toBeGreaterThan(firstRequest!.logSeq);
          if (recall.fields.trigger === 'agent') {
            expect(
              trace.some(
                ({ event, fields, logSeq }) =>
                  event === 'tool.started' &&
                  fields.tool === 'book_memory_recall' &&
                  logSeq < recall.logSeq,
              ),
            ).toBe(true);
          }
        }
      }
      expect(
        rows.some(({ event, fields }) => event === 'tool.discovery' && editRuns.includes(fields.runId)),
      ).toBe(true);
      expect(sawScope, 'no writing scope was successfully registered in either edit Run').toBe(true);
      expect(newActors(after).some(linksOldSubjects), added.error).toBe(true);
      expect(chapters(after).map(({ id }) => id)).toEqual(chapters(original).map(({ id }) => id));
      expect(changedChapters(after).length, added.error).toBeGreaterThan(1);
      // Inspect these isolated files as well for narrative placement, actual reveal and resolved items;
      // the structured assertions alone do not establish prose semantics.
    } finally {
      await app.close();
    }
  } finally {
    if (copied || supplied)
      await unlink(isolatedProfile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
});
