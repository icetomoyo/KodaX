import type { KodaXGenerationSource, KodaXMessage } from '../types.js';
import { KODAX_INTERRUPTED_TOOL_RESULT_MARKER } from '../constants.js';

export function sameCloudSource(a: KodaXGenerationSource, b: KodaXGenerationSource): boolean {
  return a.provider === b.provider && a.api === b.api && a.model === b.model && a.baseUrl === b.baseUrl && a.credentialScope === b.credentialScope;
}
/** Repair receipts, never arguments or execution. Input history is immutable. */
export function repairCloudToolHistory(messages: readonly KodaXMessage[]): KodaXMessage[] {
  const result: KodaXMessage[] = [];
  const pending = new Set<string>();
  const seen = new Set<string>();
  const settle = () => {
    if (pending.size) result.push({ role: 'user', content: [...pending].map(id => ({ type: 'tool_result', tool_use_id: id,
      content: `${KODAX_INTERRUPTED_TOOL_RESULT_MARKER} Tool execution was interrupted; no result is available.`, is_error: true })) });
    pending.clear();
  };
  for (const message of messages) {
    if (typeof message.content === 'string') { settle(); result.push(message); continue; }
    if (message.role === 'assistant') {
      settle();
      for (const block of message.content) if (block.type === 'tool_use') {
        if (!block.id || seen.has(block.id)) throw new Error('Cloud history has an empty or duplicate tool call ID.');
        pending.add(block.id); seen.add(block.id);
      }
      result.push(message);
    } else {
      const receipts = message.content.filter(b => b.type === 'tool_result').filter(b => pending.delete(b.tool_use_id));
      if (receipts.length) result.push({ ...message, content: receipts });
      const content = message.content.filter(b => b.type !== 'tool_result');
      if (content.length) { settle(); result.push({ ...message, content }); }
    }
  }
  settle();
  return result;
}
