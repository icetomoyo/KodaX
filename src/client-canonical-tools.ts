import type { KodaXMessage, KodaXToolResultBlock } from '@kodax-ai/agent';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';

/** Textual tool content is never a display preview. Offsets use JS UTF-16 units. */
export function toolResultText(content: KodaXToolResultBlock['content']): string {
  return typeof content === 'string' ? content
    : content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
}

function resultStatus(result: KodaXToolResultBlock | undefined): NonNullable<ClientViewItem['tool']>['status'] {
  if (!result) return 'cancelled';
  if (result.metadata?.cancelled === true) return 'cancelled';
  const text = toolResultText(result.content).trimStart();
  // Only old records without an explicit cancellation fact need this fallback.
  if (result.metadata?.cancelled === undefined && result.is_error !== false && /^\[(?:Cancelled|Blocked)\]/u.test(text)) return 'cancelled';
  if (result.is_error !== undefined) return result.is_error ? 'error' : 'success';
  return /^(?:Error:|\[Error\])/u.test(text) ? 'error' : 'success';
}

/** Shared canonical facts for view, history, and full item reads. */
export function canonicalTools(messages: readonly KodaXMessage[]): ReadonlyMap<string, ClientViewItem> {
  const blocks = messages.flatMap(message => typeof message.content === 'string' ? [] : message.content);
  const results = new Map(blocks.flatMap(block => block.type === 'tool_result' ? [[block.tool_use_id, block] as const] : []));
  const times = new Map(messages.flatMap(message => {
    const time = message.timestamp === undefined ? NaN : Date.parse(message.timestamp);
    if (!Number.isFinite(time) || time < 0 || typeof message.content === 'string') return [];
    return message.content.flatMap((block): [string, number][] => block.type === 'tool_use' ? [[`start:${block.id}`, time]]
      : block.type === 'tool_result' ? [[`end:${block.tool_use_id}`, time]] : []);
  }));
  return new Map(blocks.flatMap((block): [string, ClientViewItem][] => {
    if (block.type !== 'tool_use') return [];
    const result = results.get(block.id);
    return [[block.id, { id: `tool:${block.id}`, type: 'tool',
      text: result ? toolResultText(result.content) : '[Cancelled] Tool execution did not complete before the session ended.',
      tool: { callId: block.id, name: block.name, status: resultStatus(result), inputText: JSON.stringify(block.input),
        startedAt: times.get(`start:${block.id}`), endedAt: times.get(`end:${block.id}`) } }]];
  }));
}
