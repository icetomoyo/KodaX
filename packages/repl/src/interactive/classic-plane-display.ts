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
  ClientObservationStatus,
  ClientSessionActivity,
} from '@kodax-ai/coding/client-contract';
import { createHash, type Hash } from 'node:crypto';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { readClientItemRange } from '@kodax-ai/coding';
import {
  answerClientPlaneInteraction,
  viewRunsActive,
  type ClientPlaneDialogSurface,
  type InkClientPlane,
} from '../ui/client-plane.js';

type WriteLine = (line: string) => void;
type ReadItem = (id: string, options: ClientItemReadOptions) => Promise<ClientItemContent | null>;

async function readClassicItemRange(readItem: ReadItem | undefined, id: string, offset: number,
  end: number, part: 'text' | 'input' = 'text', captured?: ClientViewItem): Promise<string> {
  if (!readItem) throw new Error('Complete console output is unavailable.');
  return readClientItemRange(offset => readItem(id, { offset, part }), id,
    { offset, length: end, ...(captured ? { version: captured } : {}) });
}

const THINKING_PREVIEW_LENGTH = 100;

function thinkingPreview(text: string): string {
  const singleLine = text.replace(/\n/g, ' ');
  return singleLine.length > THINKING_PREVIEW_LENGTH
    ? `${singleLine.slice(0, THINKING_PREVIEW_LENGTH)}...`
    : singleLine;
}

function assistantDigest(text: string): Hash {
  // Page offsets and deltas use UTF-16 code units; preserve split surrogate
  // pairs exactly when a provider splits one character across two deltas.
  return createHash('sha256').update(text, 'utf16le');
}

/**
 * Pure differ; the tests drive it directly. `write` receives one formatted
 * line per change (`kind:text`), the caller owns chalk styling.
 */
export function createClassicPlaneDisplayDiffer(write: WriteLine, readItem?: ReadItem) {
  let baselined = false;
  const printedText = new Map<string, number>();
  // Keep only the Host's bounded preview. textRevision identifies changes to
  // an omitted prefix without rereading the complete response on every delta.
  const assistantSnapshots = new Map<string, ClientViewItem>();
  const assistantDigests = new Map<string, Hash>();
  const printedSidecarStates = new Map<string, string>();
  const sidecarState = (item: ClientViewItem): string => JSON.stringify([item.sidecar?.verdict, item.sidecar?.delivery]);
  const printedToolStages = new Set<string>();
  let streamingRequest: string | undefined;
  let compactingRunId: string | undefined;
  const printedStreamingPhases = new Set<string>();

  const printOnce = (item: ClientViewItem, line: string): void => {
    write(line);
    printedText.set(item.id, item.text.length);
  };

  return async (items: readonly ClientViewItem[], activity?: ClientSessionActivity): Promise<void> => {
    if (activity?.compacting && compactingRunId !== activity.runId) write('info:[KodaX] Compacting context...');
    compactingRunId = activity?.compacting ? activity.runId : undefined;
    const streaming = activity?.streaming;
    const request = streaming ? JSON.stringify([activity.runId, streaming.providerRequestId]) : undefined;
    if (request !== streamingRequest) {
      streamingRequest = request;
      printedStreamingPhases.clear();
    }
    if (streaming) {
      const phase = JSON.stringify([streaming.kind,
        streaming.kind === 'thinking' ? streaming.itemId : streaming.callId ?? streaming.toolName]);
      if (!printedStreamingPhases.has(phase)) {
        printedStreamingPhases.add(phase);
        const label = streaming.kind === 'thinking' ? 'Thinking' : `Receiving ${streaming.toolName}`;
        const count = streaming.charCount === undefined ? '' : ` (${streaming.charCount} chars received so far)`;
        write(`info:${label}${count}`);
      }
    }
    if (!baselined) {
      baselined = true;
      for (const item of items) {
        printedText.set(item.id, item.totalTextLength ?? item.text.length);
        if (item.type === 'assistant') {
          assistantSnapshots.set(item.id, item);
          if (!item.textOffset) assistantDigests.set(item.id, assistantDigest(item.text));
        }
        if (item.type === 'sidecar') printedSidecarStates.set(item.id, sidecarState(item));
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
      if (!liveIds.has(id)) {
        printedText.delete(id); printedSidecarStates.delete(id);
        assistantSnapshots.delete(id); assistantDigests.delete(id);
      }
    }
    for (const stage of printedToolStages) {
      const id = stage.slice(0, stage.lastIndexOf(':'));
      if (!liveIds.has(id)) printedToolStages.delete(stage);
    }
    for (const item of items) {
      if (item.type === 'assistant') {
        const previous = printedText.get(item.id) ?? 0;
        const end = item.totalTextLength ?? item.text.length;
        const start = item.textOffset ?? 0;
        const snapshot = assistantSnapshots.get(item.id);
        const overlapStart = Math.max(start, snapshot?.textOffset ?? 0);
        const overlapEnd = Math.min(end, previous);
        const revised = snapshot !== undefined && ((item.textRevision ?? 0) !== (snapshot.textRevision ?? 0)
          || end < previous || (overlapEnd > overlapStart
          && item.text.slice(overlapStart - start, overlapEnd - start)
            !== snapshot.text.slice(overlapStart - (snapshot.textOffset ?? 0), overlapEnd - (snapshot.textOffset ?? 0))));
        const boundedHandoff = start > 0 && snapshot !== undefined && item.outputState !== snapshot.outputState;
        if (revised || boundedHandoff) {
          const text = start > 0 ? await readClassicItemRange(readItem, item.id, 0, end, 'text', item) : item.text;
          const digest = assistantDigests.get(item.id);
          const samePrefix = end >= previous && digest !== undefined
            && assistantDigest(text.slice(0, previous)).digest('hex') === digest.copy().digest('hex');
          if (!samePrefix) write(`assistant:\n[Updated response]\n${text}`);
          else if (end > previous) write(`assistant:${text.slice(previous)}`);
          assistantDigests.set(item.id, assistantDigest(text));
          printedText.set(item.id, end);
        } else if (end > previous) {
          const text = previous < start
            ? await readClassicItemRange(readItem, item.id, previous, end, 'text', item)
            : item.text.slice(previous - start);
          write(`assistant:${text}`);
          const digest = assistantDigests.get(item.id) ?? (previous === 0 ? assistantDigest('') : undefined);
          if (digest) { digest.update(text, 'utf16le'); assistantDigests.set(item.id, digest); }
          printedText.set(item.id, end);
        }
        assistantSnapshots.set(item.id, item);
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
      if (item.type === 'sidecar') {
        const classificationState = sidecarState(item);
        if (printedSidecarStates.get(item.id) === classificationState) continue;
        const classification = item.sidecar?.delivery === 'budget-exhausted' ? 'budget exhausted' : item.sidecar?.verdict;
        printOnce(item, `sidecar:Sidecar Verifier${classification ? ` — ${classification}` : ''}\n${item.text}`);
        printedSidecarStates.set(item.id, classificationState);
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
    onStatus?: (status: ClientObservationStatus) => void;
    differ?: ReturnType<typeof createClassicPlaneDisplayDiffer>;
    displayQueue?: { pending: Promise<void> };
    isCurrent?: () => boolean;
  } = {},
): Promise<() => void> {
  let closed = false;
  const isCurrent = (): boolean => !closed && (options.isCurrent?.() ?? true);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const differ = options.differ ?? createClassicPlaneDisplayDiffer(line => { if (!closed) write(line); },
    (id, readOptions) => plane.readItem(sessionId, id, readOptions));
  const handledInteractions = new Map<string, AbortController>();
  const closeDialogs = (): void => {
    for (const controller of handledInteractions.values()) controller.abort();
    handledInteractions.clear();
  };
  let dialogChain: Promise<void> = Promise.resolve();
  const displayQueue = options.displayQueue ?? { pending: Promise.resolve() };
  const observation = await plane.observe(sessionId, (view: ClientSessionView) => {
    if (!isCurrent()) return;
    options.onView?.(view);
    displayQueue.pending = displayQueue.pending.then(() => !isCurrent() ? undefined : differ(view.items,
      viewRunsActive(view) === view.activity?.runId ? view.activity : undefined)).catch((error: unknown) => {
      const message = `Console output read failed: ${error instanceof Error ? error.message : String(error)}`;
      emitKodaXDiagnostic({ source: 'repl:classic-display', level: 'warn', message });
      if (isCurrent()) options.onNotice?.(message);
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
        .then(() => isCurrent() ? answerClientPlaneInteraction(plane, interaction, dialogs, controller.signal) : false)
        .then((accepted) => {
          if (accepted || controller.signal.aborted) return;
          handledInteractions.delete(interaction.requestId);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || !isCurrent()) return;
          handledInteractions.delete(interaction.requestId);
          options.onNotice?.(
            `Answer delivery failed (${error instanceof Error ? error.message : String(error)}); the question re-opens or resolves Host-side.`,
          );
        });
    }
  }, { onStatus: status => {
    if (!isCurrent()) return;
    options.onStatus?.(status);
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
