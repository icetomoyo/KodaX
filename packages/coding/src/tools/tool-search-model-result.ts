import { isDeepStrictEqual } from 'node:util';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { countTokens } from '../tokenizer.js';

function projectHelp(text: string, contracts: ReadonlyMap<string, KodaXToolDefinition['input_schema']>): string {
  return text.split('\n').map(line => {
    const match = /^<function>(.+)<\/function>$/.exec(line);
    if (!match) return line;
    let parsed: unknown;
    try { parsed = JSON.parse(match[1]!); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return line; // Unrecognized evidence stays verbatim, including truncated JSON.
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return line;
    const definition = parsed as Record<string, unknown>;
    if (Object.keys(definition).length !== 3 || typeof definition.name !== 'string'
      || typeof definition.description !== 'string' || !contracts.has(definition.name)
      || !isDeepStrictEqual(definition.parameters, contracts.get(definition.name))) return line;
    const compact = `<function>${JSON.stringify({ description: definition.description, name: definition.name })}</function>`
      + '\nParameters are already in the current tool contracts.';
    return countTokens(compact) < countTokens(line) ? compact : line;
  }).join('\n');
}

/** Request view only. Recompute after fitting/recovery; SDK and durable receipts stay complete. */
export function projectToolSearchResultParameters(
  messages: readonly KodaXMessage[],
  disclosed: readonly KodaXToolDefinition[],
): KodaXMessage[] {
  const calls = new Map<string, { name: string; count: number }>();
  const results = new Map<string, number>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use') {
        calls.set(block.id, { name: block.name, count: (calls.get(block.id)?.count ?? 0) + 1 });
      } else if (message.role === 'user' && block.type === 'tool_result') {
        results.set(block.tool_use_id, (results.get(block.tool_use_id) ?? 0) + 1);
      }
    }
  }
  const contracts = new Map(disclosed.map(tool => [tool.name, tool.input_schema]));
  // Ambiguous namespaces cannot prove which parameter contract the model has.
  for (const tool of disclosed) {
    if (!isDeepStrictEqual(tool.input_schema, contracts.get(tool.name))) contracts.delete(tool.name);
  }
  const observed = new Set<string>();
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.name === 'tool_search') observed.add(block.id);
      }
      return message;
    }
    if (message.role !== 'user') return message;
    const content = message.content.map(block => {
      if (block.type !== 'tool_result' || block.is_error || !observed.has(block.tool_use_id)
        || calls.get(block.tool_use_id)?.count !== 1 || results.get(block.tool_use_id) !== 1) return block;
      const projected = typeof block.content === 'string' ? projectHelp(block.content, contracts)
        : block.content.map(item => item.type === 'text' ? { ...item, text: projectHelp(item.text, contracts) } : item);
      return { ...block, content: projected };
    });
    return { ...message, content };
  });
}
