import type { CapabilityResult } from '@kodax-ai/llm';
import type { ToolResult } from './types.js';

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined;
  return JSON.stringify(value);
}

/** Keep provider content and structuredContent distinct at model-facing adapters. */
export function renderCapabilityToolResult(
  result: CapabilityResult,
  render: (content: string | undefined) => string,
): ToolResult {
  const errorPrefix = (result.isError ?? result.metadata?.isError) === true ? '[Tool Error] ' : '';
  const structured = stringifyValue(result.structuredContent);
  if (result.content !== undefined && typeof result.content !== 'string') {
    return [
      { type: 'text', text: `${errorPrefix}${render(undefined)}` },
      ...result.content,
      ...(structured ? [{ type: 'text' as const, text: `Structured content:\n${structured}` }] : []),
    ];
  }
  const content = stringifyValue(result.content);
  const combined = content && structured && content !== structured
    ? `${content}\n\nStructured content:\n${structured}` : content ?? structured;
  return `${errorPrefix}${render(combined)}`;
}
