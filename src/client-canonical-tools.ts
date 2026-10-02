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
export function canonicalToolKey(callId: string, outputId?: string): string {
  return JSON.stringify([outputId ?? null, callId]);
}

export function canonicalTools(messages: readonly KodaXMessage[]): ReadonlyMap<string, ClientViewItem> {
  const tools = new Map<string, ClientViewItem>();
  const pending = new Map<string, string>();
  for (const message of messages) {
    const time = message.timestamp === undefined ? NaN : Date.parse(message.timestamp);
    const timestamp = Number.isFinite(time) && time >= 0 ? time : undefined;
    if (message.role === 'assistant') pending.clear();
    for (const block of typeof message.content === 'string' ? [] : message.content) {
      if (block.type === 'tool_use') {
        const key = canonicalToolKey(block.id, message.outputId);
        tools.set(key, { id: message.outputId ? `output:${message.outputId}:tool:${block.id}` : `tool:${block.id}`, type: 'tool',
          text: '[Cancelled] Tool execution did not complete before the session ended.',
          tool: { assistantOutputId: message.outputId, callId: block.id, name: block.name, status: resultStatus(undefined),
            inputText: JSON.stringify(block.input), startedAt: timestamp } });
        pending.set(block.id, key);
      } else if (block.type === 'tool_result') {
        const key = pending.get(block.tool_use_id);
        const item = key === undefined ? undefined : tools.get(key);
        if (!item?.tool || key === undefined) continue;
        tools.set(key, { ...item, text: toolResultText(block.content), tool: { ...item.tool,
          status: resultStatus(block), endedAt: timestamp } });
        pending.delete(block.tool_use_id);
      }
    }
  }
  return tools;
}
