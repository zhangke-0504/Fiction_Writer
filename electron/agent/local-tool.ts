import type { Session, ToolResult } from '../../shared/contracts.js';
import type { ReportDiagnostic } from '../../shared/diagnostics.js';
import { DiagnosticFailure } from '../diagnostics/trace.js';
import type { ToolSpec } from './model.js';
import type { RunContext } from './runs.js';

export interface ReadToolContext {
  session: Pick<Session, 'cwd' | 'bookId'>;
  signal: AbortSignal;
  diagnostic?: ReportDiagnostic;
}

export interface LocalTool<Context extends ReadToolContext = RunContext> extends ToolSpec {
  execute: (args: Record<string, any>, ctx: Context) => Promise<unknown>;
  isWholeSkillResult?: (result: ToolResult) => boolean;
  onResultSent?: (result: ToolResult, report: ReportDiagnostic) => void;
}

/** A domain failure can carry a bounded tool result, without forwarding it to diagnostics. */
export class ToolFailure extends DiagnosticFailure {
  constructor(
    reason: string,
    message: string,
    readonly value?: unknown,
  ) {
    super(reason, message);
  }
}

export const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const str = (description?: string, maxLength = 200_000) => ({
  type: 'string',
  minLength: 1,
  maxLength,
  ...(description && { description }),
});
