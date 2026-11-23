import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, Push } from '../shared/rpc.js';
const bridge: DesktopBridge = {
  request: (method, args) => ipcRenderer.invoke('fw:request', method, args),
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, data: Push) => listener(data);
    ipcRenderer.on('fw:push', handler);
    return () => {
      ipcRenderer.removeListener('fw:push', handler);
    };
  },
};
contextBridge.exposeInMainWorld('fw', bridge);
