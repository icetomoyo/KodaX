import { createHash } from 'node:crypto';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { KodaXMessage, KodaXToolDefinition } from '../types.js';
import { KodaXProviderError } from '../errors.js';

/** Transport names never replace canonical tool identity or grant execution authority. */
export function anthropicToolNames(messages: readonly KodaXMessage[], tools: KodaXToolDefinition[], provider: string) {
  const names = new Set(tools.map(tool => tool.name));
  for (const message of messages) if (Array.isArray(message.content)) {
    for (const block of message.content) if (block.type === 'tool_use') names.add(block.name);
  }
  const encoded = new Map<string, string>();
  const decoded = new Map<string, string>();
  for (const name of names) {
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && !name.startsWith('kdx_')) continue;
    // Reserving this prefix also encodes a legitimate name that equals another tool's alias.
    const wire = `kdx_${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 15)}_${createHash('sha256').update(name).digest('base64url')}`;
    if (decoded.has(wire) && decoded.get(wire) !== name) throw new KodaXProviderError('Tool transport names collide.', provider,
      { failureCode: 'request_build_failed', stage: 'request_build', retryable: false });
    encoded.set(name, wire); decoded.set(wire, name);
  }
  const toWire = (name: string) => encoded.get(name) ?? name;
  const fromWire = (name: string) => decoded.get(name) ?? name;
  return {
    toWire, fromWire,
    forced(name: string): string {
      if (!tools.some(tool => tool.name === name)) throw new KodaXProviderError('Forced tool is absent from canonical tool definitions.', provider,
        { failureCode: 'request_build_failed', stage: 'request_build', retryable: false });
      return toWire(name);
    },
    tools: encoded.size ? tools.map(tool => encoded.has(tool.name) ? { ...tool, name: toWire(tool.name) } : tool) : tools,
    project(input: MessageParam[]): MessageParam[] {
      if (!encoded.size) return input;
      return input.map(message => typeof message.content === 'string'
        || !message.content.some(block => block.type === 'tool_use' && encoded.has(block.name)) ? message : { ...message,
        content: message.content.map(block => block.type === 'tool_use' && encoded.has(block.name)
          ? { ...block, name: toWire(block.name) } : block) });
    },
  };
}
