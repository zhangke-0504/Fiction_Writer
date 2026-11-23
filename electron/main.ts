import { app, BrowserWindow, dialog, ipcMain, safeStorage, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RpcResponse } from '../shared/rpc.js';

const here = dirname(fileURLToPath(import.meta.url));
const isTest = !app.isPackaged && process.env.FW_E2E === '1';
const testRoot = isTest ? process.env.FW_TEST_ROOT : undefined;
if (testRoot) {
  const chromiumState = join(testRoot, 'electron-user-data');
  mkdirSync(chromiumState, { recursive: true });
  app.setPath('userData', chromiumState);
}
let node: UtilityProcess | undefined;
let window: BrowserWindow | undefined;
let serial = 0;
let quitting = false,
  stopped = false;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }
>();

function push(event: unknown) {
  if (window && !window.isDestroyed()) window.webContents.send('fw:push', event);
}
function startNode() {
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
  child.on(
    'message',
    (message: RpcResponse | { event: unknown } | { secretTicket: number; cipher: string }) => {
      if ('secretTicket' in message) {
        void safeStorage.decryptStringAsync(Buffer.from(message.cipher, 'base64')).then(
          (value) => child.postMessage({ secretTicket: message.secretTicket, key: value.result }),
          () =>
            child.postMessage({
              secretTicket: message.secretTicket,
              error: '无法解密 API Key，请在设置中重新填写',
            }),
        );
        return;
      }
      if ('event' in message) {
        push(message.event);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(message.id);
      if ('error' in message) request.reject(new Error(message.error));
      else request.resolve(message.result);
    },
  );
  child.on('exit', () => {
    if (node !== child) return;
    node = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('后台进程已退出'));
    }
    pending.clear();
    if (!quitting) {
      node = startNode();
      push({ type: 'backend-reset' });
    }
  });
  return child;
}
function request(method: string, args: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const id = ++serial;
    if (!node) {
      reject(new Error('后台不可用'));
      return;
    }
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('后台请求超时'));
    }, 90_000);
    pending.set(id, { resolve, reject, timeout });
    node.postMessage({ id, method, args });
  });
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 760,
    minHeight: 540,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#f7f6f3',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('focus', () => push({ type: 'focus' }));
  win.on('closed', () => {
    if (window === win) window = undefined;
  });
  window = win;
  void win.loadFile(join(here, '../../dist/index.html'));
}
if (!testRoot && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(() => {
    node = startNode();
    ipcMain.handle('fw:request', async (event, method: string, args: unknown) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        typeof method !== 'string'
      )
        throw new Error('无效请求');
      if (method === 'picker.directory' || method === 'picker.files') {
        const current = window;
        if (!current) return [];
        return dialog
          .showOpenDialog(current, {
            properties:
              method === 'picker.directory' ? ['openDirectory'] : ['openFile', 'multiSelections'],
          })
          .then((result) => (result.canceled ? [] : result.filePaths));
      }
      if (method === 'shutdown') throw new Error('无效请求');
      if (method === 'profiles.save') {
        const { id, name, model, baseUrl, protocol, apiKey } = args as Record<
          string,
          string | undefined
        >;
        const key = apiKey?.trim();
        let cipher: string | undefined;
        if (key) {
          if (key.length > 8192 || /[\r\n]/.test(key)) throw new Error('API Key 格式无效');
          if (
            !(await safeStorage.isAsyncEncryptionAvailable()) ||
            (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
          )
            throw new Error('当前系统安全存储不可用');
          try {
            cipher = (await safeStorage.encryptStringAsync(key)).toString('base64');
          } catch {
            throw new Error('无法加密 API Key');
          }
        }
        return request(method, { id, name, model, baseUrl, protocol, cipher });
      }
      return request(method, args);
    });
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (stopped || !node) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    const deadline = new Promise((resolve) => setTimeout(resolve, 9000).unref());
    void Promise.race([request('shutdown', undefined), deadline])
      .catch(() => undefined)
      .finally(() => {
        stopped = true;
        node?.kill();
        app.quit();
      });
  });
}
