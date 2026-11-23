export interface RpcRequest {
  id: number;
  method: string;
  args: unknown;
}
export type RpcResponse = { id: number; result: unknown } | { id: number; error: string };
export interface Push {
  type: string;
  [key: string]: unknown;
}
export interface DesktopBridge {
  request<T>(method: string, args?: unknown): Promise<T>;
  subscribe(listener: (event: Push) => void): () => void;
}
