import type { ReportableUiEvents, UiEventName } from './diagnostics.js';
export interface RpcRequest {
  id: number;
  method: string;
  args: unknown;
  requestId?: string;
}
export type RpcResponse =
  { id: number; result: unknown } | { id: number; error: string; reason?: string };
export type DesktopReply = { result: unknown } | { error: string; requestId?: string };
export interface Push {
  type: string;
  [key: string]: unknown;
}
export interface DesktopBridge {
  request<T>(method: string, args?: unknown): Promise<T>;
  subscribe(listener: (event: Push) => void): () => void;
  diagnostic<E extends UiEventName>(event: E, fields: ReportableUiEvents[E]): void;
}
