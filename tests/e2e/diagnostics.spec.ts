import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ModelProfile, RuntimeView, Session } from '../../shared/contracts';
import type { ReportableUiEvents } from '../../shared/diagnostics';
import { diagnosticText, readDiagnostics } from './diagnostic-files';

const launch = (root: string, extra: NodeJS.ProcessEnv = {}) =>
  electron.launch({ args: ['.'], env: { ...process.env, FW_E2E: '1', FW_TEST_ROOT: root, ...extra } });

test('same-day Electron boots append to both daily files and observe backend restart', async ({}, info) => {
  const root = info.outputPath('app');
  for (let i = 0; i < 2; i++) {
    const app = await launch(root);
    try {
      const page = await app.firstWindow();
      await expect(page.getByRole('heading', { name: '书库', exact: true })).toBeVisible();
      await expect
        .poll(
          async () =>
            (await readDiagnostics(root, 'frontend')).filter((e) => e.event === 'ui.ready').length,
        )
        .toBe(i + 1);
      if (i === 1) {
        await expect(page.evaluate(() => window.fw.request('test.crash'))).rejects.toThrow(
          '后台进程已退出',
        );
        await expect
          .poll(
            async () =>
              (await readDiagnostics(root, 'backend')).filter((e) => e.event === 'worker.ready').length,
          )
          .toBe(3);
      }
    } finally {
      await app.close();
    }
  }
  const backend = await readDiagnostics(root, 'backend'),
    frontend = await readDiagnostics(root, 'frontend');
  const boots = backend.filter((e) => e.event === 'app.started');
  expect(boots).toHaveLength(2);
  expect(new Set(boots.map((e) => e.bootId)).size).toBe(2);
  expect(frontend.filter((e) => e.event === 'ui.ready').map((e) => e.bootId)).toEqual(
    boots.map((e) => e.bootId),
  );
  expect(backend.filter((e) => e.event === 'app.stopped')).toHaveLength(2);
  for (const ready of frontend.filter((e) => e.event === 'ui.ready'))
    expect(
      backend.some(
        (e) =>
          e.event === 'window.started' &&
          e.fields.rendererId === ready.fields.rendererId &&
          e.bootId === ready.bootId,
      ),
    ).toBe(true);
  const crash = backend.find((e) => e.event === 'worker.exited' && e.fields.code === 23)!;
  expect(crash.fields.expected).toBe(false);
  const second = backend.filter((e) => e.bootId === boots[1].bootId && e.event === 'worker.ready');
  expect(new Set(second.map((e) => e.fields.workerId)).size).toBe(2);
});

test('an unready renderer is not reported as healthy', async ({}, info) => {
  const root = info.outputPath('app'),
    app = await launch(root, { FW_E2E_FAIL_LOAD: '1' });
  try {
    await app.firstWindow();
    await expect
      .poll(async () =>
        (await readDiagnostics(root, 'backend')).some((e) => e.event === 'window.load_failed'),
      )
      .toBe(true);
  } finally {
    await app.close();
  }
  expect((await readDiagnostics(root, 'frontend')).some((e) => e.event === 'ui.ready')).toBe(false);
});

test('book-change receipts cannot invent or borrow a different publication', async ({}, info) => {
  type Receipt = ReportableUiEvents['ui.book_change_received'];
  const root = info.outputPath('app'),
    app = await launch(root);
  let actual: Receipt;
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '书库', exact: true })).toBeVisible();
    actual = await page.evaluate(async () => {
      const { workerId } = await window.fw.request<RuntimeView>('runtime.snapshot');
      const forged = (fields: Record<string, unknown>) =>
        window.fw.diagnostic('ui.book_change_received', fields as never);
      forged({});
      forged({ journalSeq: 0, workerId });
      let observed!: (receipt: Receipt) => void;
      const published = new Promise<Receipt>((resolve) => {
        observed = resolve;
      });
      const off = window.fw.subscribe((push) => {
        if (
          push.type === 'book-change' &&
          Array.isArray(push.documents) &&
          typeof push.seq === 'number' &&
          typeof push.changeId === 'string' &&
          typeof push.workerId === 'string' &&
          typeof push.bookId === 'string'
        )
          observed({
            journalSeq: push.seq,
            changeId: push.changeId,
            workerId: push.workerId,
            workspaceRef: push.bookId,
          });
      });
      try {
        await window.fw.request('book.create', { title: '通知关联夹具', summary: '本地合成摘要' });
        const receipt = await published;
        forged({ ...receipt, workerId: undefined });
        forged({ ...receipt, changeId: undefined });
        forged({ ...receipt, changeId: crypto.randomUUID() });
        forged({ ...receipt, workerId: crypto.randomUUID() });
        forged({ ...receipt, journalSeq: String(receipt.journalSeq) });
        forged({ ...receipt, workspaceRef: 'not-the-published-workspace' });
        return receipt;
      } finally {
        off();
      }
    });
    await expect(page.getByRole('button', { name: '编辑 通知关联夹具' })).toBeVisible();
  } finally {
    await app.close();
  }
  const frontend = await readDiagnostics(root, 'frontend'),
    backend = await readDiagnostics(root, 'backend');
  const receipts = frontend.filter((e) => e.event === 'ui.book_change_received');
  const notices = backend.filter((e) => e.event === 'workspace.notified');
  const matched = receipts.filter((e) => e.fields.changeId === actual.changeId);
  expect(matched).toHaveLength(1);
  expect(matched[0].fields).toMatchObject({ journalSeq: actual.journalSeq, workerId: actual.workerId });
  for (const row of receipts) {
    const { journalSeq, workerId, changeId, workspaceRef } = row.fields;
    expect(
      notices.some(
        (e) =>
          e.fields.journalSeq === journalSeq &&
          e.fields.workerId === workerId &&
          e.fields.changeId === changeId &&
          e.fields.workspaceRef === workspaceRef,
      ),
    ).toBe(true);
  }
});

test('a rejected Harness submission displays an ID that correlates both files, without saving raw input', async ({}, info) => {
  const root = info.outputPath('app'),
    app = await launch(root);
  try {
    const page = await app.firstWindow();
    const fixture = {
      credential: 'SYNTHETIC_KEY_NOT_FOR_DIAGNOSTICS',
      prompt: 'SYNTHETIC_PROMPT_NOT_FOR_DIAGNOSTICS',
      attachment: join(root, 'PRIVATE_MISSING_REFERENCE_NAME.md'),
    };
    const id = await page.evaluate(
      async () =>
        (await window.fw.request<{ id: string }>('book.create', { title: '日志夹具', summary: '摘要' }))
          .id,
    );
    await page.evaluate(
      async (apiKey) =>
        window.fw.request('profiles.save', {
          name: 'fixture-private-label',
          model: 'fixture',
          baseUrl: 'http://127.0.0.1:9',
          protocol: 'chat',
          apiKey,
        }),
      fixture.credential,
    );
    await page.getByRole('button', { name: '编辑 日志夹具' }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await expect(page.getByLabel('给 Agent 的消息')).toBeVisible();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, fixture.attachment);
    await page.getByRole('button', { name: '添加参考文件' }).click();
    await page.getByLabel('给 Agent 的消息').fill(fixture.prompt);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const reference = page.getByLabel('诊断编号');
    await expect(reference).toHaveText(/^[a-f0-9-]{36}$/);
    const requestId = await reference.textContent();
    await page.evaluate(() => {
      window.fw.diagnostic('ui.ready', { runId: '00000000-0000-4000-8000-000000000000' } as never);
    });
    await expect
      .poll(async () =>
        (await readDiagnostics(root, 'backend')).some(
          (e) =>
            e.event === 'run.rejected' &&
            e.fields.requestId === requestId &&
            e.fields.reason === 'attachment_invalid',
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        (await readDiagnostics(root, 'frontend')).some(
          (e) =>
            e.event === 'ui.operation.finished' &&
            e.fields.requestId === requestId &&
            e.fields.outcome === 'failed',
        ),
      )
      .toBe(true);
    const front = await readDiagnostics(root, 'frontend'),
      back = await readDiagnostics(root, 'backend');
    expect(front.filter((e) => e.event === 'ui.ready')).toHaveLength(1);
    expect(back.some((e) => e.event === 'run.started' && e.fields.requestId === requestId)).toBe(false);
    for (const secret of [
      ...Object.values(fixture),
      'fixture-private-label',
      'PRIVATE_MISSING_REFERENCE_NAME',
      '日志夹具',
      id,
    ])
      expect(JSON.stringify([front, back])).not.toContain(secret);
  } finally {
    await app.close();
  }
});

test('local diaries reconstruct concurrent runs and actual tool decisions without sensitive values', async ({}, info) => {
  const root = info.outputPath('app');
  const marker = {
    key: 'PRIVATE_KEY_FICTION_FIXTURE',
    prompt: 'PRIVATE_AGENT_PROMPT_FIXTURE',
    prose: 'PRIVATE_MANUSCRIPT_FIXTURE',
    reference: 'PRIVATE_REFERENCE_CONTENT_FIXTURE',
    arg: 'PRIVATE_TOOL_ARGUMENT_FIXTURE',
    result: 'PRIVATE_TOOL_RESULT_FIXTURE',
    command: 'PRIVATE_COMMAND_TEXT_FIXTURE',
    stdout: 'PRIVATE_SHELL_OUTPUT_FIXTURE',
    reasoning: 'PRIVATE_REASONING_FIXTURE',
    file: 'PRIVATE_PATH_FIXTURE.md',
    error: 'PRIVATE_EXCEPTION_FIXTURE',
    nativeCall: 'PRIVATE_NATIVE_ID_FIXTURE',
    unknownTool: 'PRIVATE_UNKNOWN_TOOL_FIXTURE',
    profileLabel: 'PRIVATE_PROFILE_LABEL_FIXTURE',
    basePath: 'PRIVATE_ENDPOINT_ROUTE_FIXTURE',
    model: 'PRIVATE_MODEL_ID_FIXTURE',
  };
  const cwd = info.outputPath('code'),
    reference = info.outputPath('reference.md');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, marker.file), marker.result);
  await writeFile(reference, marker.reference);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acceptedKey = false,
    sawAgentInput = false,
    sawReadOutput = false,
    sawShellOutput = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    acceptedKey ||= req.headers.authorization === `Bearer ${marker.key}`;
    const body = JSON.parse(raw);
    const messages = body.messages as { role: string; content: string }[];
    if (messages.at(-1)?.content === 'fail only this Run') {
      res.writeHead(401);
      res.end(marker.error);
      return;
    }
    const reply = (delta: object, finish_reason: string) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    const discovered = body.tools?.some(
      (tool: { function: { name: string } }) => tool.function.name === 'read_file',
    );
    const discoveryResult =
      messages.at(-1)?.role === 'tool' && messages.at(-1)?.content.includes('candidates');
    if (messages.at(-1)?.role === 'tool' && !discoveryResult) {
      sawReadOutput = messages.some((m) => m.role === 'tool' && m.content.includes(marker.result));
      sawShellOutput = messages.some((m) => m.role === 'tool' && m.content.includes(marker.stdout));
      reply({ content: 'fixture finished' }, 'stop');
      return;
    }
    sawAgentInput =
      raw.includes(marker.prompt) &&
      raw.includes(marker.reference) &&
      raw.includes(reference.split(/[\\/]/).at(-1)!);
    await hold;
    if (!discovered) {
      reply(
        {
          tool_calls: [
            {
              index: 0,
              id: 'discover-fixture-tools',
              function: {
                name: 'tool_search',
                arguments: JSON.stringify({ query: 'read_file run_command' }),
              },
            },
          ],
        },
        'tool_calls',
      );
      return;
    }
    const command =
      process.platform === 'win32'
        ? `# ${marker.command}\nWrite-Output '${marker.stdout}'; exit 7`
        : `# ${marker.command}\nprintf '%s' '${marker.stdout}'; exit 7`;
    const representations: [string, string][] = [
      ['read_file', JSON.stringify({ path: marker.file })],
      ['read_file', `{"path":"${marker.arg}`],
      ['read_file', JSON.stringify({ unexpected: marker.arg })],
      [marker.unknownTool, JSON.stringify({ path: marker.file })],
      ['read_file', JSON.stringify({ path: `${marker.error}.md` })],
      ['run_command', JSON.stringify({ command })],
      [
        'run_command',
        JSON.stringify({
          command: process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20',
          timeoutMs: 900,
        }),
      ],
    ];
    reply(
      {
        reasoning_content: marker.reasoning,
        tool_calls: representations.map(([name, args], index) => ({
          index,
          id: `${marker.nativeCall}_${index}`,
          function: { name, arguments: args },
        })),
      },
      'tool_calls',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const app = await launch(root);
  let runId: string, failedId: string;
  try {
    const page = await app.firstWindow();
    const call = <T>(method: string, args?: unknown) =>
      page.evaluate(([m, a]) => window.fw.request<T>(m, a), [method, args] as const);
    const port = (server.address() as import('node:net').AddressInfo).port;
    const profile = await call<ModelProfile>('profiles.save', {
      name: marker.profileLabel,
      model: marker.model,
      baseUrl: `http://127.0.0.1:${port}/${marker.basePath}`,
      protocol: 'chat',
      apiKey: marker.key,
    });
    await call('book.create', { title: '日志正文夹具', summary: marker.prose });
    const session = await call<Session>('session.create', { cwd });
    ({ runId } = await call<{ runId: string }>('session.start', {
      id: session.id,
      profileId: profile.id,
      prompt: marker.prompt,
      attachments: [reference],
    }));
    await expect.poll(() => sawAgentInput).toBe(true);
    await page.getByRole('button', { name: '编辑 日志正文夹具' }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await page.getByLabel('给 Agent 的消息').fill('fail only this Run');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const referenceTag = page.getByLabel('诊断编号');
    await expect(referenceTag).toHaveText(/^[a-f0-9-]{36}$/);
    failedId = (await referenceTag.textContent())!;
    expect(failedId).not.toBe(runId);
    await page.evaluate(
      (secret) =>
        window.dispatchEvent(new ErrorEvent('error', { message: secret, error: new Error(secret) })),
      marker.error,
    );
    release();
    await expect
      .poll(
        async () =>
          (await readDiagnostics(root, 'backend')).find(
            (e) => e.event === 'run.finished' && e.fields.runId === runId,
          )?.fields.outcome,
        { timeout: 15_000 },
      )
      .toBe('ok');
  } finally {
    release();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect([acceptedKey, sawAgentInput, sawReadOutput, sawShellOutput]).toEqual([true, true, true, true]);
  const [front, back] = await Promise.all([
    readDiagnostics(root, 'frontend'),
    readDiagnostics(root, 'backend'),
  ]);
  for (const stream of ['frontend', 'backend'] as const) {
    const raw = await diagnosticText(root, stream);
    for (const privateValue of Object.values(marker)) expect(raw).not.toContain(privateValue);
  }
  expect(front.some((e) => e.event === 'ui.error' && e.fields.reason === 'exception')).toBe(true);
  const first = back.filter((e) => e.fields.runId === runId),
    failed = back.filter((e) => e.fields.runId === failedId);
  const firstStart = first.find((e) => e.event === 'run.started')!,
    failedStart = failed.find((e) => e.event === 'run.started')!;
  expect(firstStart.logSeq).toBeLessThan(failedStart.logSeq);
  expect(failedStart.logSeq).toBeLessThan(first.find((e) => e.event === 'run.finished')!.logSeq);
  expect(failedStart.fields.workspaceRef).not.toBe(firstStart.fields.workspaceRef);
  expect(failedStart.fields.sessionRef).not.toBe(firstStart.fields.sessionRef);
  for (const started of [firstStart, failedStart]) {
    const { requestId, runId, workspaceRef, sessionRef } = started.fields;
    expect(
      front.some(
        (e) =>
          e.event === 'ui.operation.finished' &&
          e.fields.requestId === requestId &&
          e.fields.runId === runId,
      ),
    ).toBe(true);
    const scoped = back.filter((e) => e.fields.runId === runId && e.event.startsWith('model.'));
    expect(scoped.length).toBeGreaterThan(0);
    for (const e of scoped) expect(e.fields).toMatchObject({ workspaceRef, sessionRef, requestId });
  }
  expect(failed.find((e) => e.event === 'model.finished')?.fields).toMatchObject({
    outcome: 'failed',
    httpStatus: 401,
    reason: 'auth',
  });
  expect(failed.find((e) => e.event === 'run.finished')?.fields).toMatchObject({
    outcome: 'failed',
    reason: 'auth',
  });
  expect(first.filter((e) => e.event === 'loop.round.finished').map((e) => e.fields.reason)).toEqual([
    'continue_tools',
    'continue_tools',
    'complete',
  ]);
  const startedTwice = first.filter((e) => e.event === 'model.started');
  expect(startedTwice).toHaveLength(3);
  const callPath = (id: string) =>
    first.filter((e) => e.fields.callId === id && /^tool\.(?!file)/.test(e.event));
  const finishedRead = first.find(
    (e) => e.event === 'tool.finished' && e.fields.tool === 'read_file' && e.fields.outcome === 'ok',
  )!;
  expect(callPath(finishedRead.fields.callId).map((e) => e.event)).toEqual([
    'tool.requested',
    'tool.validated',
    'tool.started',
    'tool.finished',
    'tool.result_ready',
    'tool.result_sent',
  ]);
  for (const reason of ['invalid_json', 'invalid_arguments', 'unknown_tool']) {
    const rejected = first.find((e) => e.event === 'tool.rejected' && e.fields.reason === reason)!;
    expect(rejected).toBeDefined();
    // Reconstruct this path from the diary only, including the span that sent the rejection back.
    const rows = callPath(rejected.fields.callId);
    expect(rows.map((e) => e.event)).toEqual([
      'tool.requested',
      'tool.rejected',
      'tool.result_ready',
      'tool.result_sent',
    ]);
    expect(rows.at(-1)!.fields).toMatchObject({ spanId: startedTwice[2].fields.spanId, nextTurn: 3 });
    expect(rows[2].fields.outcome).toBe('failed');
  }
  expect(
    first.find((e) => e.event === 'tool.finished' && e.fields.reason === 'command_failed')?.fields,
  ).toMatchObject({ outcome: 'failed', exitCode: 7, transportOk: true });
  expect(
    first.find((e) => e.event === 'tool.finished' && e.fields.reason === 'command_timeout')?.fields,
  ).toMatchObject({ outcome: 'timeout', timedOut: true, termination: 'confirmed', transportOk: true });
});
