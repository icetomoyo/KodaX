import type { CapabilityResult } from '@kodax-ai/llm';
import { types } from 'node:util';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { ToolResult } from './types.js';
import type { KodaXJsonValue, KodaXToolExecutionContext, ToolResultProjection } from '../types.js';

/** Unknown embedder values must not silently become lossy JSON program data. */
function isJsonDto(value: unknown, ancestors = new Set<object>()): value is KodaXJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (array && Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return false;
  ancestors.add(value);
  const valid = keys.every(key => {
    if (array && key === 'length') return true;
    if (typeof key !== 'string' || (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.enumerable && 'value' in descriptor && isJsonDto(descriptor.value, ancestors);
  });
  ancestors.delete(value);
  return valid;
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined;
  return JSON.stringify(value);
}

/** Keep provider content and structuredContent distinct at model-facing adapters. */
export function renderCapabilityToolResult(
  result: CapabilityResult,
  render: (content: string | undefined) => string,
  ctx?: KodaXToolExecutionContext,
): ToolResult {
  const errorPrefix = (result.isError ?? result.metadata?.isError) === true ? '[Tool Error] ' : '';
  const structured = stringifyValue(result.structuredContent);
  let output: ToolResult;
  if (result.content !== undefined && typeof result.content !== 'string') {
    output = [
      { type: 'text', text: `${errorPrefix}${render(undefined)}` },
      ...result.content,
      ...(structured ? [{ type: 'text' as const, text: `Structured content:\n${structured}` }] : []),
    ];
  } else {
    const content = stringifyValue(result.content);
    const combined = content && structured && content !== structured
      ? `${content}\n\nStructured content:\n${structured}` : content ?? structured;
    output = `${errorPrefix}${render(combined)}`;
  }
  if (ctx?.toolCallId && ctx.recordToolResultProjection) {
    const snapshot = <T>(read: () => T): T | undefined => {
      try { return read(); }
      catch (error) {
        if (!(error instanceof RangeError) && !(error instanceof Error && error.name === 'DataCloneError')) throw error;
        emitKodaXDiagnostic({ source: 'coding:tool-result-projection', level: 'warn',
          message: `Optional tool projection is unavailable (${error.name}); original tool evidence is retained.` });
        return undefined;
      }
    };
    const sourceContent = snapshot(() => {
      const content = result.content;
      return typeof content === 'string' ? content
        : content !== undefined && isJsonDto(content) ? structuredClone(content) : undefined;
    });
    const data = snapshot(() => isJsonDto(result.structuredContent)
      ? { kind: 'json' as const, value: structuredClone(result.structuredContent) } : undefined);
    const projection: ToolResultProjection | undefined = sourceContent !== undefined || data !== undefined
      ? snapshot(() => ({
        content: typeof output === 'string' ? output : structuredClone(output),
        ...(sourceContent !== undefined ? { sourceContent } : {}),
        ...(data ? { data } : {}),
      })) : undefined;
    // Listener failures can enforce durability and must never be downgraded.
    if (projection) ctx.recordToolResultProjection(ctx.toolCallId, projection);
  }
  return output;
}
