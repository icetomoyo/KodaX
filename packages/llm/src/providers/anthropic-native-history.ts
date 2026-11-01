import { createHash } from 'node:crypto';
import type { KodaXAnthropicHistory, KodaXAssistantBlock, KodaXGenerationSource, KodaXInputTransformation, KodaXMessage } from '../types.js';

type WireMessage = Record<string, unknown>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fragmentDigest(fragment: Omit<KodaXAnthropicHistory, 'id'>): string { return digest(fragment); }
function withoutMarker<T>(value: T): T {
  if (!record(value)) return value;
  const result = { ...value }; delete result.cache_control; return result as T;
}
const withoutTopMarkers = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutMarker) : value;
function projectTopMarkers(baseline: unknown, desired: unknown): unknown {
  const blocks = withoutTopMarkers(baseline);
  const marker = Array.isArray(desired) ? desired.filter(record).find(block => record(block.cache_control))?.cache_control : undefined;
  if (!marker) return blocks;
  if (Array.isArray(blocks) && blocks.length && record(blocks.at(-1))) return [...blocks.slice(0, -1), { ...blocks.at(-1), cache_control: clone(marker) }];
  return typeof blocks === 'string' && blocks ? [{ type: 'text', text: blocks, cache_control: clone(marker) }] : blocks;
}
/** Cache breakpoints are excluded from thinking binding. Never traverse tool arguments/schema data. */
function withoutMessageMarkers(messages: readonly WireMessage[]): WireMessage[] {
  const content = (blocks: unknown[]): unknown[] => blocks.map(value => {
    if (!record(value)) return value;
    const block = withoutMarker(value);
    if (block.type === 'tool_result' && Array.isArray(block.content)) block.content = content(block.content);
    if (block.type === 'tool_addition' && record(block.tool) && record(block.tool.definition)) {
      block.tool = { ...block.tool, definition: withoutMarker(block.tool.definition) };
    }
    return block;
  });
  return messages.map(message => ({ ...message, ...(Array.isArray(message.content) ? { content: content(message.content) } : {}) }));
}
function canonical(message: KodaXMessage): unknown { return { role: message.role, content: message.content }; }
function outputDigest(content: KodaXMessage['content']): string {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  // The consumer may add its well-formed empty marker to an otherwise invisible native response.
  return digest(blocks.filter(block => block.type !== 'text' || block.text !== ''));
}
/** Guards own the committed content. Never persist a raw response they intentionally changed. */
export function retainAnthropicNativeHistory(history: KodaXAnthropicHistory | undefined, content: KodaXMessage['content']): KodaXAnthropicHistory | undefined {
  return history?.outputDigest === outputDigest(content) ? history : undefined;
}
function applyTransformations(messages: WireMessage[], transformations: readonly KodaXInputTransformation[]): void {
  const removed = new Map<number, Set<number>>();
  for (const transformation of transformations) {
    if (transformation.type !== 'thinking_dropped') continue;
    const match = /^messages\.(\d+)\.content\.(\d+)$/.exec(transformation.path);
    if (!match) continue;
    const message = Number(match[1]), block = Number(match[2]);
    const indices = removed.get(message) ?? new Set<number>(); indices.add(block); removed.set(message, indices);
  }
  for (const [index, removedBlocks] of removed) {
    const message = messages[index];
    if (!Array.isArray(message?.content)) continue;
    message.content = message.content.filter((block: unknown, blockIndex: number) =>
      !removedBlocks.has(blockIndex) || !record(block) || !['thinking', 'redacted_thinking'].includes(String(block.type)));
  }
}
export interface RestoredAnthropicHistory {
  start: number; parent: string; baseline: NonNullable<KodaXAnthropicHistory['baseline']>;
  messages: WireMessage[]; requested: KodaXAnthropicHistory['requested'];
}

/** Validate canonical anchors and account/model scope before trusting any persisted wire bytes. */
export function restoreAnthropicNativeHistory(messages: readonly KodaXMessage[], source: KodaXGenerationSource): RestoredAnthropicHistory | undefined {
  let restored: RestoredAnthropicHistory | undefined;
  const prefix = createHash('sha256');
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const fragment = message.nativeHistory;
    if (message.role === 'assistant' && fragment) {
      const { id, ...body } = fragment;
      const valid = fragment.version === 1 && id === fragmentDigest(body) && digest(fragment.source) === digest(source)
        && fragment.inputDigest === prefix.copy().digest('hex') && fragment.outputDigest === outputDigest(message.content)
        && Array.isArray(fragment.append) && fragment.append.every(record) && Array.isArray(fragment.output) && fragment.output.every(record)
        && record(fragment.requested) && (fragment.baseline !== undefined || fragment.parent === restored?.parent);
      if (!valid) restored = undefined;
      else {
        const baseline = fragment.baseline ?? restored?.baseline;
        if (baseline) {
          const wire = fragment.baseline ? [] : restored!.messages;
          wire.push(...clone(fragment.append));
          applyTransformations(wire, fragment.transformations ?? []);
          wire.push({ role: 'assistant', content: clone(fragment.output) });
          restored = { start: index + 1, parent: id, baseline: clone(baseline), messages: wire, requested: clone(fragment.requested) };
        }
      }
    }
    prefix.update(JSON.stringify(canonical(message))); prefix.update('\n');
  }
  return restored;
}

function toolsInHistory(history: RestoredAnthropicHistory): Map<string, Record<string, unknown>> {
  const tools = new Map<string, Record<string, unknown>>();
  for (const tool of Array.isArray(history.baseline.tools) ? history.baseline.tools : []) {
    if (record(tool) && typeof tool.name === 'string') tools.set(tool.name, tool);
  }
  for (const message of history.messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!record(block) || !record(block.tool)) continue;
      if (block.type === 'tool_removal' && typeof block.tool.name === 'string') tools.delete(block.tool.name);
      if (block.type === 'tool_addition' && record(block.tool.definition) && typeof block.tool.definition.name === 'string') tools.set(block.tool.definition.name, block.tool.definition);
    }
  }
  return tools;
}

/** Called after wire conversion of ONLY new canonical messages. No credentials or authority are stored. */
export function prepareAnthropicNativeHistory<T extends Record<string, unknown>>(
  messages: readonly KodaXMessage[], source: KodaXGenerationSource, history: RestoredAnthropicHistory | undefined, request: T,
  rejectedEfforts: readonly string[] = [],
  resetLineage = false,
) {
  const nextEffort = record(request.output_config) && typeof request.output_config.effort === 'string' ? request.output_config.effort : undefined;
  const rejected = (value: unknown): boolean => typeof value === 'string' && (rejectedEfforts.includes('*') || rejectedEfforts.includes(value));
  const resetControls = history && (resetLineage || rejected(history.baseline.effort) || history.messages.some(message => record(message.output_config) && rejected(message.output_config.effort)));
  if (resetControls && history) {
    // The previous bytes remain in canonical audit history. Rebuild the wire lineage once,
    // retaining admitted attachments/tool receipts but removing obsolete signed reasoning and controls.
    history = { ...history, baseline: { ...history.baseline, effort: nextEffort },
      requested: { ...history.requested, effort: nextEffort },
      messages: history.messages.map(message => {
        const wire = { ...message }; delete wire.output_config;
        if (message.role === 'assistant' && Array.isArray(message.content)) {
          const content = message.content.flatMap((block: unknown) => record(block) && block.type === 'thinking'
            ? typeof block.thinking === 'string' && block.thinking ? [{ type: 'text', text: `<prior_reasoning>\n${block.thinking}\n</prior_reasoning>` }] : []
            : record(block) && block.type === 'redacted_thinking' ? [] : [block]);
          wire.content = content.length ? content : [{ type: 'text', text: '...' }];
        }
        return wire;
      }) };
  }
  const output = record(request.output_config) ? request.output_config : {};
  const effort = typeof output.effort === 'string' ? output.effort : undefined;
  const requested = { system: digest(withoutTopMarkers(request.system)), tools: digest(withoutTopMarkers(request.tools ?? [])), ...(effort ? { effort } : {}),
    thinkingMode: record(request.thinking) && typeof request.thinking.type === 'string' ? request.thinking.type : 'adaptive' };
  const freshBaseline = { system: clone(request.system), tools: clone(request.tools), ...(effort ? { effort } : {}) };
  const append = clone(Array.isArray(request.messages) ? request.messages as WireMessage[] : []);
  const transformed = clone(request);
  if (history) {
    const changes: Record<string, unknown>[] = [];
    if (requested.tools !== history.requested.tools) {
      const previous = toolsInHistory(history);
      const desired = new Map((Array.isArray(request.tools) ? request.tools : [])
        .filter((tool): tool is Record<string, unknown> => record(tool) && typeof tool.name === 'string')
        .map(tool => [tool.name as string, tool]));
      for (const name of previous.keys()) if (!desired.has(name)) changes.push({ type: 'tool_removal', tool: { type: 'tool_reference', name } });
      for (const [name, tool] of desired) if (digest(withoutMarker(previous.get(name))) !== digest(withoutMarker(tool))) changes.push({ type: 'tool_addition', tool: { type: 'tool_definition', definition: tool } });
    }
    if (requested.system !== history.requested.system) {
      const text = typeof request.system === 'string' ? request.system : Array.isArray(request.system)
        ? request.system.filter(record).map(block => typeof block.text === 'string' ? block.text : '').join('\n\n') : '';
      changes.push({ type: 'text', text: `Use this complete base instruction set from this point onward, replacing earlier base instruction sets:\n\n${text || '(No base instructions.)'}` });
    }
    const effortChanged = effort !== undefined && effort !== history.requested.effort;
    if (changes.length || effortChanged) {
      const lastRole = [...history.messages, ...append].filter(message => message.role !== 'system').at(-1)?.role;
      if (changes.length && lastRole !== 'user') throw new Error('Native system/tool changes require a user turn with all tool results first.');
      append.push({ role: 'system', content: changes, ...(effortChanged ? { output_config: { effort: effort ?? 'medium' } } : {}) });
    }
    Object.assign(transformed, { system: projectTopMarkers(history.baseline.system, request.system), tools: projectTopMarkers(history.baseline.tools, request.tools),
      messages: [...withoutMessageMarkers(history.messages), ...append],
      ...(history.baseline.effort ? { output_config: { ...output, effort: history.baseline.effort } } : {}) });
    if (!history.baseline.effort && record(transformed.output_config)) delete transformed.output_config.effort;
  }
  const prefix = createHash('sha256');
  for (const message of messages) { prefix.update(JSON.stringify(canonical(message))); prefix.update('\n'); }
  const inputDigest = prefix.digest('hex');
  return {
    request: transformed,
    finish(actual: T, canonicalOutput: readonly KodaXAssistantBlock[], nativeOutput: readonly Record<string, unknown>[], transformations?: KodaXInputTransformation[]): KodaXAnthropicHistory {
      const actualMessages = Array.isArray(actual.messages) ? actual.messages as WireMessage[] : [];
      // A payload hook is trusted to transform input, but cannot silently inherit an edited prefix.
      const inherited = !resetControls && history && digest(withoutMessageMarkers(actualMessages.slice(0, history.messages.length))) === digest(withoutMessageMarkers(history.messages))
        && digest(withoutTopMarkers(actual.system)) === digest(withoutTopMarkers(history.baseline.system))
        && digest(withoutTopMarkers(actual.tools)) === digest(withoutTopMarkers(history.baseline.tools));
      const body: Omit<KodaXAnthropicHistory, 'id'> = { version: 1, source, inputDigest, outputDigest: outputDigest([...canonicalOutput]),
        ...(inherited && history ? { parent: history.parent } : { baseline: clone({ ...freshBaseline, system: actual.system, tools: actual.tools }) }),
        append: clone(inherited && history ? actualMessages.slice(history.messages.length) : actualMessages), output: clone([...nativeOutput]), requested,
        ...(transformations?.length ? { transformations: clone(transformations) } : {}) };
      return { ...body, id: fragmentDigest(body) };
    },
  };
}
