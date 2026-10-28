import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import type { KodaXMessage, KodaXToolResultBlock } from '@kodax-ai/llm';
import { resolveToolBridgeTarget } from './tools/tool-bridge.js';

type Content = KodaXToolResultBlock['content'];

// Native image identity owns its Run-admitted bytes in the Provider cache.
const copyContent = (content: Content): Content => typeof content === 'string' ? content
  : content.map(item => item.type === 'image' ? item : { ...item });

/** Run-owned snapshots of authorized results, never a filesystem read capability. */
export function createToolResultRecovery(cwd: string) {
  const originals = new Map<string, { original: Content; previews: Content[] }>();
  const unreadable = new Set<string>();
  const key = (candidate: string) => {
    if (candidate.startsWith('kodax-transient://')) return candidate;
    const absolute = resolve(cwd, candidate);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const denyRead = (name: string, input: Record<string, unknown>) => {
    if (name !== 'read' || typeof input.path !== 'string') return;
    const path = key(input.path);
    if (originals.has(path)) unreadable.add(path);
  };
  return {
    capture(path: string, original: Content, preview: Content): void {
      if (original === preview) return;
      const pathKey = key(path);
      let entry = originals.get(pathKey);
      if (!entry) {
        entry = { original: copyContent(original), previews: [] };
        originals.set(pathKey, entry);
      } else if (Array.isArray(original) && typeof entry.original === 'string') {
        // Multimodal delivery adds the original inline images after text sizing.
        entry.original = copyContent(original);
      }
      if (!entry.previews.some(value => isDeepStrictEqual(value, preview))) {
        entry.previews.push(structuredClone(preview));
      }
    },
    denyRead,
    observeResult(call: { id: string; name: string; input?: Record<string, unknown> }, failed: boolean): void {
      if (!failed) return;
      const bridge = resolveToolBridgeTarget(call);
      const concrete = bridge?.ok ? bridge.call : call;
      denyRead(concrete.name, concrete.input ?? {});
    },
    project(messages: readonly KodaXMessage[]): KodaXMessage[] {
      if (unreadable.size === 0) return [...messages];
      return messages.map(message => {
        if (!Array.isArray(message.content)) return message;
        let changed = false;
        const content = message.content.map(block => {
          if (block.type !== 'tool_result' || typeof block.metadata?.outputPath !== 'string') return block;
          const path = key(block.metadata.outputPath);
          const entry = originals.get(path);
          if (!unreadable.has(path) || !entry?.previews.some(value => isDeepStrictEqual(value, block.content))) return block;
          changed = true;
          return { ...block, content: copyContent(entry.original), metadata: { ...block.metadata, truncated: false } };
        });
        return changed ? { ...message, content } : message;
      });
    },
    available: () => unreadable.size === 0,
    clear(): void { originals.clear(); unreadable.clear(); },
  };
}

export type ToolResultRecovery = ReturnType<typeof createToolResultRecovery>;
