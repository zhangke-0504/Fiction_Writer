import { app, BrowserWindow, dialog, ipcMain, safeStorage, utilityProcess } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DesktopReply, Push, RpcResponse } from '../shared/rpc.js';
import {
  isDiagnosticMethod,
  type DiagnosticEvent,
  type DiagnosticFields,
} from '../shared/diagnostics.js';
import { DailyDiagnosticWriter } from './diagnostics/daily.js';
import { DiagnosticFailure, classified, elapsed, responseDiagnostic } from './diagnostics/trace.js';

const here = dirname(fileURLToPath(import.meta.url));
const isTest = !app.isPackaged && process.env.FW_E2E === '1';
const testRoot = isTest ? process.env.FW_TEST_ROOT : undefined;
const hiddenTestWindow = !!testRoot && process.env.FW_E2E_SHOW_WINDOW !== '1';
if (testRoot) {
  const chromiumState = join(testRoot, 'electron-user-data');
  mkdirSync(chromiumState, { recursive: true });
  app.setPath('userData', chromiumState);
}
let node: UtilityProcess | undefined;
let window: BrowserWindow | undefined;
let logger: DailyDiagnosticWriter | undefined;
let workerId: string | undefined, rendererId: string | undefined;
let journalSeq = 0;
let previousWorker: { id: string; journalSeq: number } | undefined;
const published = new Map<number, { changeId: string; workspaceRef?: string }>();
let serial = 0;
let quitting = false,
  stopped = false;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }
>();
const report = (event: string, fields?: DiagnosticFields) => logger?.accept('main', { event, fields });
function validSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame;
}
function push(event: Push) {
  if (window && !window.isDestroyed()) window.webContents.send('fw:push', event);
}
function startNode() {
  const currentId = randomUUID();
  if (workerId) previousWorker = { id: workerId, journalSeq };
  workerId = currentId;
  journalSeq = 0;
  published.clear();
  const child = utilityProcess.fork(
    join(here, 'worker.js'),
    [
      testRoot ? join(testRoot, 'library') : join(app.getPath('documents'), 'Fiction_Writer', 'library'),
      testRoot ? join(testRoot, 'state') : app.getPath('userData'),
      isTest ? 'test' : 'production',
      join(app.getAppPath(), 'skills'),
    ],
    { serviceName: 'Fiction Writer Background' },
  );
  child.on('spawn', () => report('worker.spawned', { workerId: currentId, pid: child.pid }));
  child.on(
    'message',
    (
      message:
        | RpcResponse
        | { event: Push }
        | { diagnostic: DiagnosticEvent }
        | { secretTicket: number; cipher: string; requestId?: string },
    ) => {
      if (node !== child || !message || typeof message !== 'object') return;
      if ('diagnostic' in message) {
        const diagnostic = message.diagnostic;
        logger?.accept('worker', {
          ...diagnostic,
          fields: { ...diagnostic.fields, workerId: currentId },
        });
        return;
      }
      if ('secretTicket' in message) {
        void safeStorage.decryptStringAsync(Buffer.from(message.cipher, 'base64')).then(
          (value) => {
            report('credential.finished', {
              requestId: message.requestId,
              operation: 'decrypt',
              outcome: 'ok',
              workerId: currentId,
            });
            if (node === child)
              child.postMessage({ secretTicket: message.secretTicket, key: value.result });
          },
          () => {
            report('credential.finished', {
              requestId: message.requestId,
              operation: 'decrypt',
              outcome: 'failed',
              reason: 'credential_unavailable',
              workerId: currentId,
            });
            if (node === child)
              child.postMessage({
                secretTicket: message.secretTicket,
                error: '无法解密 API Key，请在设置中重新填写',
              });
          },
        );
        return;
      }
      if ('event' in message) {
        const item = message.event;
        if (typeof item.seq === 'number') {
          journalSeq = item.seq;
          if (item.type === 'book-change' && typeof item.changeId === 'string')
            published.set(item.seq, {
              changeId: item.changeId,
              workspaceRef: typeof item.bookId === 'string' ? item.bookId : undefined,
            });
          while (published.size > 512) published.delete(published.keys().next().value!);
        }
        push({ ...item, workerId: currentId });
        return;
      }
      const current = pending.get(message.id);
      if (!current) return;
      clearTimeout(current.timeout);
      pending.delete(message.id);
      if ('error' in message)
        current.reject(new DiagnosticFailure(message.reason ?? 'unknown', message.error));
      else current.resolve(message.result);
    },
  );
  child.on('exit', (code) => {
    if (node !== child) return;
    report('worker.exited', {
      workerId: currentId,
      code,
      expected: quitting,
      pending: pending.size,
      reason: quitting ? 'application_exit' : 'backend_exit',
    });
    node = undefined;
    for (const current of pending.values()) {
      clearTimeout(current.timeout);
      current.reject(new DiagnosticFailure('backend_exit', '后台进程已退出'));
    }
    pending.clear();
    if (!quitting) {
      report('worker.restarting', { workerId: currentId, reason: 'backend_exit' });
      node = startNode();
      push({ type: 'backend-reset', workerId });
    }
  });
  return child;
}
function request(method: string, args: unknown, requestId?: string) {
  return new Promise<unknown>((resolve, reject) => {
    const id = ++serial;
    if (!node) {
      reject(new DiagnosticFailure('unavailable', '后台不可用'));
      return;
    }
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new DiagnosticFailure('timeout', '后台请求超时'));
    }, 90_000);
    pending.set(id, { resolve, reject, timeout });
    try {
      node.postMessage({ id, method, args, requestId });
    } catch (error) {
      clearTimeout(timeout);
      pending.delete(id);
      reject(error);
    }
  });
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 760,
    minHeight: 540,
    show: !hiddenTestWindow,
    autoHideMenuBar: true,
    backgroundColor: '#f7f6f3',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Playwright still drives the actual renderer while the test window is hidden.
      backgroundThrottling: !hiddenTestWindow,
    },
  });
  rendererId = undefined;
  const startRenderer = () => {
    rendererId = randomUUID();
    report('window.started', { rendererId });
  };
  let loadFailed = false;
  const reportLoad = (code?: number, reason = 'load_failed') => {
    if (loadFailed) return;
    loadFailed = true;
    if (!rendererId) startRenderer();
    report('window.load_failed', { rendererId, code, reason });
  };
  win.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) {
      startRenderer();
      loadFailed = false;
    }
  });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) reportLoad(code);
  });
  win.webContents.on('preload-error', () => reportLoad(undefined, 'preload_error'));
  win.webContents.on('render-process-gone', (_event, details) =>
    report('window.renderer_gone', { rendererId, code: details.exitCode, reason: details.reason }),
  );
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('focus', () => push({ type: 'focus' }));
  win.on('closed', () => {
    if (window === win) {
      report('window.closed', { rendererId });
      window = undefined;
    }
  });
  window = win;
  const page = testRoot && process.env.FW_E2E_FAIL_LOAD === '1' ? 'missing-fixture.html' : 'index.html';
  void win.loadFile(join(here, '../../dist', page)).catch(() => reportLoad());
}
async function invoke(method: string, args: unknown, requestId?: string) {
  if (method === 'picker.directory' || method === 'picker.files') {
    if (!window) return [];
    return dialog
      .showOpenDialog(window, {
        properties: method === 'picker.directory' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      })
      .then((result) => (result.canceled ? [] : result.filePaths));
  }
  if (method === 'shutdown') throw new DiagnosticFailure('invalid_request', '无效请求');
  if (method === 'profiles.save') {
    const { id, name, model, baseUrl, protocol, providerId, apiKey } = args as Record<string, string | undefined>;
    const key = apiKey?.trim();
    let cipher: string | undefined;
    if (key) {
      if (key.length > 8192 || /[\r\n]/.test(key))
        throw new DiagnosticFailure('input_validation', 'API Key 格式无效');
      try {
        if (
          !(await safeStorage.isAsyncEncryptionAvailable()) ||
          (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
        )
          throw new DiagnosticFailure('credential_unavailable', '当前系统安全存储不可用');
        cipher = (await safeStorage.encryptStringAsync(key)).toString('base64');
        report('credential.finished', { requestId, operation: 'encrypt', outcome: 'ok' });
      } catch (error) {
        report('credential.finished', {
          requestId,
          operation: 'encrypt',
          outcome: 'failed',
          reason: 'credential_unavailable',
        });
        if (error instanceof DiagnosticFailure) throw error;
        throw new DiagnosticFailure('credential_unavailable', '无法加密 API Key');
      }
    }
    return request(method, { id, name, model, baseUrl, protocol, providerId, cipher }, requestId);
  }
  if (method === 'runtime.snapshot') {
    const selectedWorker = workerId;
    const snapshot = await request(method, args, requestId);
    return { ...(snapshot as object), workerId: selectedWorker };
  }
  return request(method, args, requestId);
}
if (!testRoot && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window && !hiddenTestWindow) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(() => {
    logger = new DailyDiagnosticWriter(join(app.getPath('userData'), 'logs'));
    report('app.started', { version: app.getVersion(), pid: process.pid });
    process.on('uncaughtExceptionMonitor', () => {
      report('app.fatal', { reason: 'exception' });
    });
    ipcMain.on('fw:diagnostic', (event, input: unknown) => {
      if (!validSender(event) || !input || typeof input !== 'object') return;
      const { event: name, fields } = input as DiagnosticEvent;
      let visibleSeq = journalSeq;
      if (fields?.workerId !== undefined && fields.workerId !== workerId) {
        // A read superseded by a backend restart still has an outcome in the previous epoch.
        if (!previousWorker || fields.workerId !== previousWorker.id || name !== 'ui.reload.finished')
          return;
        visibleSeq = previousWorker.journalSeq;
      }
      if (typeof fields?.journalSeq === 'number' && fields.journalSeq > visibleSeq) return;
      if (name === 'ui.book_change_received') {
        const seq = fields?.journalSeq;
        if (
          typeof seq !== 'number' ||
          !Number.isSafeInteger(seq) ||
          seq < 1 ||
          fields?.workerId !== workerId
        )
          return;
        const sent = published.get(seq);
        if (!sent || fields?.changeId !== sent.changeId || fields?.workspaceRef !== sent.workspaceRef)
          return;
      }
      logger?.accept('renderer', input, true, rendererId);
    });
    ipcMain.handle('fw:request', async (event, method: string, args: unknown): Promise<DesktopReply> => {
      if (!validSender(event) || typeof method !== 'string') return { error: '无效请求' };
      const tracked = isDiagnosticMethod(method),
        requestId = tracked ? randomUUID() : undefined;
      const t0 = performance.now(),
        fields = { requestId, method, rendererId };
      if (tracked) {
        logger?.accept('renderer', { event: 'ui.operation.started', fields });
        report('ipc.started', fields);
      }
      let outcome = 'ok',
        reason: string | undefined;
      let responseFields: DiagnosticFields = {};
      try {
        const result = await invoke(method, args, requestId);
        if (tracked) responseFields = responseDiagnostic(method, result);
        return { result };
      } catch (error) {
        reason = classified(error);
        outcome = reason === 'timeout' ? 'timeout' : 'failed';
        return { error: error instanceof Error ? error.message : '后台请求失败', requestId };
      } finally {
        if (tracked) {
          const end = { ...fields, outcome, reason, ...responseFields, elapsedMs: elapsed(t0) };
          report('ipc.finished', end);
          logger?.accept('renderer', { event: 'ui.operation.finished', fields: end });
        }
      }
    });
    node = startNode();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (stopped || !logger) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    report('app.stopping', { reason: 'application_exit' });
    if (window) report('window.closing', { rendererId, reason: 'application_exit' });
    const deadline = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 9000).unref(),
    );
    void Promise.race([
      node
        ? request('shutdown', undefined, randomUUID())
            .then(() => 'ok')
            .catch(() => 'failed')
        : Promise.resolve('ok'),
      deadline,
    ])
      .then(async (outcome) => {
        const child = node;
        if (child) {
          const exiting = new Promise<void>((resolve) => child.once('exit', () => resolve()));
          child.kill();
          await Promise.race([
            exiting,
            new Promise<void>((resolve) => setTimeout(resolve, 200).unref()),
          ]);
        }
        report('app.stopped', { outcome, reason: 'application_exit' });
        await logger?.close();
      })
      .finally(() => {
        stopped = true;
        app.quit();
      });
  });
}
