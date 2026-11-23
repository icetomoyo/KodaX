/**
 * Print mode's live output, read from the v2 Session view the way the REPL
 * reads it. Each view says what every item holds now; this reports what is new
 * since the view before through the CLI's progress callbacks: the reply as it
 * grows, the model's thinking, and each tool call with its progress and result.
 * Items the first view already held came before this invocation and are left
 * out, as a settled item does not say which Run made it. A view carries only
 * the end of a long text, so the part in between is read from the Host before
 * anything after it.
 */
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { KodaXEvents } from '@kodax-ai/coding';

import type { KodaXHostClient } from './host-protocol/host-client.js';
import type { LocalSessionView, LocalViewItem } from './host-protocol/view.js';
import { createItemReader } from './repl-host/item-reader.js';

/** What was reported of one item. */
interface Reported {
  /** UTF-16 units of the item's text already reported. */
  length: number;
  /** The text reported so far, kept for thinking, whose end reports it whole. */
  text: string;
  started: boolean;
  settled: boolean;
  progress?: string;
}

export interface OneShotProgress {
  /** Takes the newest view. Views that come while one is being reported replace each other. */
  view(view: LocalSessionView): void;
  /** Waits until the newest view is reported. */
  settled(): Promise<void>;
}

/** The whole input of a tool call, when the view carries all of it and it is an object. */
function toolInput(item: LocalViewItem): Record<string, unknown> | undefined {
  const text = item.tool?.inputText;
  if (text === undefined || item.tool?.inputTotal !== undefined) return undefined;
  try {
    const input: unknown = JSON.parse(text);
    return typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  } catch {
    // Input the model is still writing is not JSON yet; the call is reported without it.
    return undefined;
  }
}

export function createOneShotProgress(
  client: KodaXHostClient<'local'>,
  sessionId: string,
  events: KodaXEvents | undefined,
): OneShotProgress {
  const reader = createItemReader(client);
  const reported = new Map<string, Reported>();
  let earlier: ReadonlySet<string> | undefined;
  let latest: LocalSessionView | undefined;
  let announced = false;
  let pending = false;
  let drain = Promise.resolve();

  /** The item's text from `from` on, reading from the Host what the view left out. */
  async function textFrom(item: LocalViewItem, from: number): Promise<string> {
    const start = item.textTotal === undefined ? 0 : item.textTotal - item.text.length;
    if (start <= from) return item.text.slice(from - start);
    let missing = '';
    let offset = from;
    while (offset < start) {
      const page = await reader.read(sessionId, item.id, { offset });
      const part = page.text.slice(0, start - offset);
      if (part.length === 0) break;
      missing += part;
      offset += part.length;
    }
    return missing + item.text;
  }

  async function reportItem(item: LocalViewItem): Promise<void> {
    const seen = reported.get(item.id) ?? { length: 0, text: '', started: false, settled: false };
    reported.set(item.id, seen);
    if (seen.settled) return;
    const settled = item.state === 'settled';
    if (item.tool !== undefined) {
      const { callId: id, name } = item.tool;
      if (!seen.started) {
        seen.started = true;
        const input = toolInput(item);
        events?.onToolUseStart?.({ id, name, ...(input !== undefined ? { input } : {}) });
      }
      if (item.tool.progress !== undefined && item.tool.progress !== seen.progress) {
        seen.progress = item.tool.progress;
        events?.onToolProgress?.({ id, message: item.tool.progress });
      }
      if (settled) {
        seen.settled = true;
        events?.onToolResult?.({ id, name, content: await textFrom(item, 0) });
      }
      return;
    }
    if (item.type !== 'assistant' && item.type !== 'thinking') return;
    const added = await textFrom(item, seen.length);
    seen.length += added.length;
    if (added.length > 0) {
      if (item.type === 'assistant') events?.onTextDelta?.(added);
      else {
        seen.text += added;
        events?.onThinkingDelta?.(added);
      }
    }
    if (!settled) return;
    seen.settled = true;
    if (item.type === 'assistant') events?.onStreamEnd?.();
    else events?.onThinkingEnd?.(seen.text);
  }

  async function report(view: LocalSessionView): Promise<void> {
    if (!announced) {
      announced = true;
      events?.onSessionStart?.({ provider: view.settings.provider ?? '', sessionId });
    }
    for (const item of view.items) {
      if (earlier?.has(item.id) !== true) await reportItem(item);
    }
  }

  async function reportLatest(): Promise<void> {
    while (pending) {
      pending = false;
      const view = latest;
      if (view === undefined) continue;
      try {
        await report(view);
      } catch (error: unknown) {
        // The output stays incomplete, and the Run goes on: say so instead of dropping it.
        emitKodaXDiagnostic({ source: 'kodax.one-shot', level: 'warn',
          message: 'Part of the live output could not be shown.', detail: error });
        events?.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  const schedule = (): void => {
    if (pending) return;
    pending = true;
    drain = drain.then(reportLatest);
  };

  return {
    view(view) {
      earlier ??= new Set(view.items.map(item => item.id));
      latest = view;
      schedule();
    },
    settled: () => drain,
  };
}
