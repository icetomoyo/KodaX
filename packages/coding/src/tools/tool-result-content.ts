import type { ToolResult } from './types.js';

/** Text projection for classification, telemetry and display; never model delivery. */
export function toolResultText(content: ToolResult): string {
  return typeof content === 'string'
    ? content
    : content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}
