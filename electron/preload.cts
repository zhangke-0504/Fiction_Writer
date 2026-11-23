import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopReply, Push } from '../shared/rpc.js';
const bridge: DesktopBridge = {
  async request<T>(method: string, args?: unknown) {
    const reply: DesktopReply = await ipcRenderer.invoke('fw:request', method, args);
    if ('error' in reply)
      throw new Error(reply.requestId ? `[fw-request:${reply.requestId}] ${reply.error}` : reply.error);
    return reply.result as T;
  },
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, data: Push) => listener(data);
    ipcRenderer.on('fw:push', handler);
    return () => {
      ipcRenderer.removeListener('fw:push', handler);
    };
  },
  diagnostic(event, fields) {
    try {
      ipcRenderer.send('fw:diagnostic', { event, fields });
    } catch {
      /* Diagnostic delivery is best-effort. */
    }
  },
};
contextBridge.exposeInMainWorld('fw', bridge);
