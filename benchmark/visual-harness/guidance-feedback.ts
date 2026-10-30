/** Controlled visual probe: preserve frozen contracts and use the production SDK for feedback. */
import { isDeepStrictEqual } from 'node:util';
import type { KodaXMessage, KodaXToolDefinition, KodaXToolResultContentItem } from '@kodax-ai/llm';
import { parseToolInputWithSalvage } from '@kodax-ai/llm';
import { createCustomProvider } from '../../packages/llm/src/providers/custom-provider.js';
import type { ProposedMessage } from './task-cell.js';

export function useInspectionContract(request: Record<string, unknown>, definition: KodaXToolDefinition): Record<string, unknown> {
  const next = structuredClone(request);
  if (!Array.isArray(next.tools) || definition.name !== 'visual_inspect') throw new Error('Inspection contract required.');
  const tools = next.tools as { function?: { name?: string; description?: string; parameters?: unknown } }[];
  const matches = tools.filter(tool => tool.function?.name === definition.name);
  const target = matches[0]?.function;
  if (matches.length !== 1 || !target || !isDeepStrictEqual(target.parameters, definition.input_schema)) {
    throw new Error('Frozen inspection schema mismatch.');
  }
  target.description = definition.description;
  return next;
}

export async function appendToolFeedback(request: Record<string, unknown>, reply: ProposedMessage,
  results: readonly { id: string; content: string | readonly KodaXToolResultContentItem[]; isError?: boolean }[]): Promise<Record<string, unknown>> {
  if (!Array.isArray(request.messages) || !reply.tool_calls?.length
    || results.length !== reply.tool_calls.length || results.some((result, index) => result.id !== reply.tool_calls![index]!.id)) {
    throw new Error('Every proposed tool occurrence requires its ordered real result.');
  }
  const messages: KodaXMessage[] = [{ role: 'assistant', content: [
    ...(reply.content ? [{ type: 'text' as const, text: reply.content }] : []),
    ...reply.tool_calls.map(tool => ({ type: 'tool_use' as const, id: tool.id, name: tool.function.name,
      input: parseToolInputWithSalvage(tool.function.arguments) })),
  ] }, { role: 'user', content: results.map(result => ({ type: 'tool_result' as const,
    tool_use_id: result.id, content: typeof result.content === 'string' ? result.content : [...result.content], is_error: result.isError })) }];
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.KODAX_VISUAL_SERIALIZATION_KEY;
  const captures: Record<string, unknown>[] = [];
  try {
    process.env.KODAX_VISUAL_SERIALIZATION_KEY = 'offline-serialization-only';
    globalThis.fetch = async (source, init) => {
      const url = typeof source === 'string' ? source : source instanceof URL ? source.href : source.url;
      if (!url.startsWith('https://visual-serialization.invalid/')) throw new Error('Unregistered serialization HTTP.');
      const body = typeof init?.body === 'string' ? init.body : source instanceof Request ? await source.text() : '';
      captures.push(JSON.parse(body) as Record<string, unknown>);
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'serialized' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const provider = createCustomProvider({ name: 'visual-feedback-serialization', protocol: 'openai',
      model: 'kimi-for-coding', baseUrl: 'https://visual-serialization.invalid/v1', apiKeyEnv: 'KODAX_VISUAL_SERIALIZATION_KEY', imageInput: true, reasoning: 'none' });
    await provider.stream(messages, [], '', false);
    const captured = captures[0];
    if (captures.length !== 1 || !Array.isArray(captured?.messages)) throw new Error('Production feedback serialization failed.');
    return { ...structuredClone(request), messages: [...structuredClone(request.messages),
      ...captured.messages.filter((message: { role?: string }) => message.role !== 'system')] };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.KODAX_VISUAL_SERIALIZATION_KEY;
    else process.env.KODAX_VISUAL_SERIALIZATION_KEY = previousKey;
  }
}
