import type { DesktopBridge } from '../shared/rpc';
declare global {
  interface Window {
    fw: DesktopBridge;
  }
}
export const api = window.fw;
