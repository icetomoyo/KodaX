/**
 * FEATURE_298 T18 — console display for plane-bound classic rounds.
 *
 * Classic has no React tree; its display authority in plane mode is the
 * live Host session view. This differ prints, per view push: new items
 * once, assistant suffixes as the trailing item streams, and tool
 * lifecycle lines per stage. The first (baseline) view only primes the
 * tracking so restored history does not reprint.
 */
import type {
  ClientSessionView,
  ClientViewItem,
  ClientItemContent,
  ClientItemReadOptions,
} from '@kodax-ai/coding/client-contract';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import {
  answerClientPlaneInteraction,
  type ClientPlaneDialogSurface,
  type InkClientPlane,
} from '../ui/client-plane.js';

type WriteLine = (line: string) => void;
type ReadItem = (id: string, options: ClientItemReadOptions) => Promise<ClientItemContent | null>;

async function readClassicItemRange(readItem: ReadItem | undefined, id: string, offset: number,
  end: number, part: 'text' | 'input' = 'text'): Promise<string> {
  if (!readItem) throw new Error('Complete console output is unavailable.');
  const parts: string[] = [];
  while (offset < end) {
    const chunk = await readItem(id, { offset, part });
    if (!chunk || chunk.id !== id || chunk.offset !== offset || chunk.text.length === 0) {
      throw new Error(`Console output ${id} is incomplete; open session history to retry.`);
    }
    const text = chunk.text.slice(0, end - offset);
    parts.push(text);
    offset += text.length;
  }
  return parts.join('');
}

const THINKING_PREVIEW_LENGTH = 100;

function thinkingPreview(text: string): string {
  const singleLine = text.replace(/\n/g, ' ');
  return singleLine.length > THINKING_PREVIEW_LENGTH
    ? `${singleLine.slice(0, THINKING_PREVIEW_LENGTH)}...`
    : singleLine;
}

/**
 * Pure differ; the tests drive it directly. `write` receives one formatted
 * line per change (`kind:text`), the caller owns chalk styling.
 */
export function createClassicPlaneDisplayDiffer(write: WriteLine, readItem?: ReadItem) {
  let baselined = false;
  const printedText = new Map<string, number>();
  const printedToolStages = new Set<string>();

  const printOnce = (item: ClientViewItem, line: string): void => {
    write(line);
    printedText.set(item.id, item.text.length);
  };

  return async (items: readonly ClientViewItem[]): Promise<void> => {
    if (!baselined) {
      baselined = true;
      for (const item of items) {
        printedText.set(item.id, item.totalTextLength ?? item.text.length);
        if (item.type === 'tool') {
          printedToolStages.add(`${item.id}:start`);
          if (item.tool !== undefined && item.tool.status !== 'running'
            && item.tool.status !== 'awaiting_approval') {
            printedToolStages.add(`${item.id}:done`);
          }
        }
      }
      return;
    }
    const liveIds = new Set(items.map((item) => item.id));
    for (const id of printedText.keys()) {
      if (!liveIds.has(id)) printedText.delete(id);
    }
    for (const stage of printedToolStages) {
      const id = stage.slice(0, stage.lastIndexOf(':'));
      if (!liveIds.has(id)) printedToolStages.delete(stage);
    }
    for (const item of items) {
      if (item.type === 'assistant') {
        const previous = printedText.get(item.id) ?? 0;
        const end = item.totalTextLength ?? item.text.length;
        if (end > previous) {
          const start = item.textOffset ?? 0;
          const text = previous < start
            ? await readClassicItemRange(readItem, item.id, previous, end)
            : item.text.slice(previous - start);
          write(`assistant:${text}`);
          printedText.set(item.id, end);
        }
        continue;
      }
      if (item.type === 'tool' && item.tool) {
        // awaiting_approval stays live: the permission dialog comes from
        // view.interactions, not from this printer.
        if (item.tool.status === 'running' || item.tool.status === 'awaiting_approval') {
          if (!printedToolStages.has(`${item.id}:start`)) {
            const input = item.tool.totalInputLength !== undefined
              ? await readClassicItemRange(readItem, item.id, 0, item.tool.totalInputLength, 'input') : item.tool.inputText ?? '';
            printedToolStages.add(`${item.id}:start`);
            printOnce(item, `tool:▶ ${item.tool.name} ${input}`.trimEnd());
          }
          continue;
        }
        printedToolStages.add(`${item.id}:start`);
        if (!printedToolStages.has(`${item.id}:done`)) {
          const output = item.totalTextLength !== undefined
            ? await readClassicItemRange(readItem, item.id, 0, item.totalTextLength) : item.text;
          printedToolStages.add(`${item.id}:done`);
          const mark = item.tool.status === 'error' ? '✗'
            : item.tool.status === 'cancelled' ? '•' : '✓';
          printOnce(item, `tool:${mark} ${item.tool.name} ${output}`.trimEnd());
        }
        continue;
      }
      if (printedText.has(item.id)) continue;
      if (item.type === 'thinking') {
        printOnce(item, `thinking:[Thinking] ${thinkingPreview(item.text)}`);
        continue;
      }
      if (item.type === 'user') {
        // The readline echo already showed the user's input.
        printedText.set(item.id, item.text.length);
        continue;
      }
      printOnce(item, `${item.type}:${item.text}`);
    }
  };
}

/**
 * Subscribe the console differ (and, when dialogs are provided, the
 * interaction answerer) to the live session view; resolves with the stop
 * function. Dialog answering is serialized - one readline dialog at a
 * time - and a late answer to a remotely-resolved interaction simply
 * resolves as not accepted.
 */
export async function attachClassicPlaneDisplay(
  plane: Pick<InkClientPlane, 'observe' | 'readItem' | 'respondInteraction'>,
  sessionId: string,
  options: {
    write?: WriteLine;
    dialogs?: ClientPlaneDialogSurface;
    onNotice?: (text: string) => void;
    onView?: (view: ClientSessionView) => void;
  } = {},
): Promise<() => void> {
  let closed = false;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const differ = createClassicPlaneDisplayDiffer(line => { if (!closed) write(line); },
    (id, readOptions) => plane.readItem(sessionId, id, readOptions));
  const handledInteractions = new Map<string, AbortController>();
  const closeDialogs = (): void => {
    for (const controller of handledInteractions.values()) controller.abort();
    handledInteractions.clear();
  };
  let dialogChain: Promise<void> = Promise.resolve();
  let displayChain: Promise<void> = Promise.resolve();
  const observation = await plane.observe(sessionId, (view: ClientSessionView) => {
    if (closed) return;
    options.onView?.(view);
    displayChain = displayChain.then(() => closed ? undefined : differ(view.items)).catch((error: unknown) => {
      const message = `Console output read failed: ${error instanceof Error ? error.message : String(error)}`;
      emitKodaXDiagnostic({ source: 'repl:classic-display', level: 'warn', message });
      if (!closed) options.onNotice?.(message);
    });
    const dialogs = options.dialogs;
    if (dialogs === undefined) return;
    const pendingIds = new Set(view.interactions.map(interaction => interaction.requestId));
    for (const [requestId, controller] of handledInteractions) {
      if (pendingIds.has(requestId)) continue;
      controller.abort();
      handledInteractions.delete(requestId);
    }
    for (const interaction of view.interactions) {
      if (handledInteractions.has(interaction.requestId)) continue;
      const controller = new AbortController();
      handledInteractions.set(interaction.requestId, controller);
      dialogChain = dialogChain
        .then(() => answerClientPlaneInteraction(plane, interaction, dialogs, controller.signal))
        .then((accepted) => {
          if (accepted || controller.signal.aborted) return;
          handledInteractions.delete(interaction.requestId);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          handledInteractions.delete(interaction.requestId);
          options.onNotice?.(
            `Answer delivery failed (${error instanceof Error ? error.message : String(error)}); the question re-opens or resolves Host-side.`,
          );
        });
    }
  }, { onStatus: status => {
    if (closed || status.state !== 'closed') return;
    closed = true;
    closeDialogs();
    if (status.reason === 'unavailable') {
      options.onNotice?.('Session observation is unavailable; reconnect to receive output and Host questions.');
    }
  } });
  return () => {
    closed = true;
    closeDialogs();
    observation();
  };
}
