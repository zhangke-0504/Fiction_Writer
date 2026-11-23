import type { Effort, ToolResult } from '../../shared/contracts.js';
import type { ReportDiagnostic } from '../../shared/diagnostics.js';
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
  /** A prose-only subrequest may use the endpoint's documented direct generation option. */
  directProse?: boolean;
  signal: AbortSignal;
  onText: (text: string) => void;
  diagnostic?: ReportDiagnostic;
  spanId?: string;
  /** Once the request body has been handed to fetch, not a remote acknowledgement. */
  onDispatch?: (spanId: string) => void;
}
export interface ModelProvider {
  effort: Effort | 'default';
  extendedOutputTokens?: number;
  turn(input: ModelRequest): Promise<AssistantTurn>;
}
