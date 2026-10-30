import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';
import type { KodaXAssistantBlock, KodaXGenerationSource } from '../types.js';
import { KodaXProviderError } from '../errors.js';

/** Shared strict terminal output parser for foreground and durable background Responses. */
export function parseResponsesOutput(response: OpenAIResponse, source: KodaXGenerationSource,
  acceptsNamespace: (namespace?: string) => boolean = () => true): KodaXAssistantBlock[] {
  const protocolError = (message: string) => new KodaXProviderError(message, source.provider,
    { failureCode: 'response_stream_error', stage: 'response_stream', retryable: false });
  if (!Array.isArray(response.output)) throw protocolError('Responses returned no output array.');
  const blocks: KodaXAssistantBlock[] = [];
  const calls = new Set<string>();
  for (const item of response.output) {
    if (!item || typeof item !== 'object') throw protocolError('Responses returned an invalid output item.');
    if (item.type === 'message') {
      if (item.status !== 'completed' || !Array.isArray(item.content)) throw protocolError('Responses returned an unfinished message.');
      for (const part of item.content) {
        if (!part || (part.type !== 'output_text' && part.type !== 'refusal')) throw protocolError('Responses returned unknown message content.');
        const text = part.type === 'output_text' ? part.text : part.refusal;
        if (typeof text !== 'string') throw protocolError('Responses returned invalid message text.');
        blocks.push({ type: 'text', text });
      }
    } else if (item.type === 'reasoning') {
      if ((item.status && item.status !== 'completed') || typeof item.id !== 'string' || !item.id || !Array.isArray(item.summary)
        || item.summary.some(part => !part || part.type !== 'summary_text' || typeof part.text !== 'string')
        || (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== 'string')) throw protocolError('Responses returned unfinished reasoning or invalid metadata.');
      blocks.push({ type: 'thinking', thinking: item.summary.map(part => part.text).join('\n'),
        responsesReasoning: { source, id: item.id, summary: item.summary, encrypted_content: item.encrypted_content } });
    } else if (item.type === 'function_call') {
      if ((item.status && item.status !== 'completed') || typeof item.call_id !== 'string' || !item.call_id.trim()
        || typeof item.name !== 'string' || !item.name.trim() || typeof item.arguments !== 'string' || calls.has(item.call_id)
        || (item.namespace !== undefined && typeof item.namespace !== 'string') || !acceptsNamespace(item.namespace)) {
        throw protocolError('Responses returned an unfinished or duplicate function call.');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(item.arguments); }
      catch { throw protocolError('Responses returned invalid final function arguments.'); }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw protocolError('Responses function arguments must be a JSON object.');
      }
      calls.add(item.call_id);
      blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parsed as Record<string, unknown> });
    } else {
      throw protocolError(`Unsupported Responses output item: ${item.type}`);
    }
  }
  return blocks;
}
