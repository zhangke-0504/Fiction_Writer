import type { Effort, ToolResult } from '../../shared/contracts.js';
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  args: string;
}
export interface AssistantTurn {
  role: 'assistant';
  text: string;
  calls: ToolCall[];
  native?: unknown;
}
export type Turn =
  { role: 'user'; text: string } | AssistantTurn | { role: 'tool'; id: string; result: ToolResult };
export interface ModelRequest {
  system: string;
  history: Turn[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal: AbortSignal;
  onText: (text: string) => void;
}
export interface ModelProvider {
  effort: Effort | 'default';
  turn(input: ModelRequest): Promise<AssistantTurn>;
}
