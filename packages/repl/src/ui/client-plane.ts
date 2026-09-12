/**
 * FEATURE_298 T17 — the Ink client plane.
 *
 * The Host session view is the single display authority: input submission,
 * run completion, stop, item paging, and interaction answers all travel
 * through this binding. The repl package names the operations; the product
 * CLI wires them from the runtime (embedded in-process or daemon RPC —
 * both implement the same faces). Unbound REPLs keep the standalone
 * in-process paths.
 */
import type {
  ClientInteraction,
  ClientHistoryPage,
  ClientHistoryReadOptions,
  ClientInteractionResponse,
  ClientItemContent,
  ClientPermissionInteractionOptions,
  ClientRunStopReceipt,
  ClientSessionCancelInput,
  ClientSessionCancelReceipt,
  ClientToolInvocationInput,
  ClientSessionView,
  ClientObserveOptions,
  ClientSessionSettingsPatch,
  ClientViewItem,
} from '@kodax-ai/coding/client-contract';
import {
  CANCELLED_TOOL_RESULT_MESSAGE,
  type AskUserAnswer,
  type AskUserMultiOptions,
  type AskUserQuestionOptions,
  type KodaXInputArtifact,
  type KodaXResult,
} from '@kodax-ai/coding';
import type { ClientItemReadOptions } from '@kodax-ai/coding/client-contract';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { resolveReplRuntimePermissionDecision } from '../runtime-permission.js';
import type { ConfirmResult } from '../permission/types.js';
import type { HistoryItem, ToolCall, ToolCallStatus } from './types.js';
import { ToolCallStatus as RenderToolStatus } from './types.js';
import type { RuntimeStopCallbacks } from '../interactive/runtime-stop.js';

/** Terminal projection of one client round; `result` is the legacy shape Ink's loop expects. */
export interface ClientRoundOutcome {
  readonly phase: string;
  readonly result?: KodaXResult;
  readonly error?: string;
}

export interface InkClientPlane {
  executeTool(input: ClientToolInvocationInput): Promise<{ readonly runId: string; readonly sessionId: string }>;
  cancelSession(input: ClientSessionCancelInput): Promise<ClientSessionCancelReceipt>;
  /** Configure the Host-owned Session before starting or changing a round. */
  updateSettings?(sessionId: string, patch: ClientSessionSettingsPatch): Promise<void>;
  /**
   * Submit user text. 'immediate' starts the run, 'after_turn' queues
   * Host-side, 'redirect' queues and cancels the target run (FEATURE_149
   * fast-redirect parity; requires targetRunId).
   */
  submit(input: {
    readonly sessionId: string;
    readonly text: string;
    readonly inputId: string;
    readonly delivery?: 'immediate' | 'after_turn' | 'steer' | 'redirect';
    readonly targetRunId?: string;
    readonly inputArtifacts?: readonly KodaXInputArtifact[];
  }): Promise<{
    readonly runId?: string;
    readonly state?: 'submitted' | 'queued' | 'withdrawn' | 'dropped';
  }>;
  /** Withdraw a queued input; returns the original text when this caller owned it. */
  withdraw(sessionId: string, inputId: string): Promise<string | undefined>;
  /** Resolve uncertain acceptance without starting new work. */
  readInput?(sessionId: string, inputId: string): Promise<{
    readonly state: 'submitted' | 'queued' | 'withdrawn' | 'dropped';
  } | null>;
  /** Resolve when the run reaches a terminal phase. */
  awaitRun(sessionId: string, runId: string): Promise<ClientRoundOutcome>;
  /** Request a stop for one run (Esc); the receipt never implies terminal state. */
  stop(runId: string): Promise<ClientRunStopReceipt | undefined>;
  /** Newest run in a live phase for the session, or undefined when idle. */
  activeRun(sessionId: string): Promise<string | undefined>;
  /** Live current-state replacement; resolves with the closer. */
  observe(
    sessionId: string,
    onView: (view: ClientSessionView) => void,
    options?: ClientObserveOptions,
  ): Promise<() => void>;
  /** Page the complete content of a bounded view item by stable id. */
  readItem(
    sessionId: string,
    itemId: string,
    options?: ClientItemReadOptions | number,
  ): Promise<ClientItemContent | null>;
  readHistory?(sessionId: string, options?: ClientHistoryReadOptions): Promise<ClientHistoryPage>;
  readHistoryEntry?(sessionId: string, itemId: string, options?: ClientItemReadOptions): Promise<ClientItemContent | null>;
  /** Answer a pending Host question/permission; first valid answer wins. */
  respondInteraction(
    requestId: string,
    response: ClientInteractionResponse,
  ): Promise<boolean>;
}

/** A partial or stale read must never be presented as complete content. */
export async function readClientPlaneItemText(
  plane: Pick<InkClientPlane, 'readItem' | 'readHistoryEntry'>,
  sessionId: string,
  itemId: string,
  part: 'text' | 'input' = 'text',
  historyEntry = false,
  captured?: { readonly length: number; readonly signal?: AbortSignal },
): Promise<string> {
  const read = historyEntry ? plane.readHistoryEntry : plane.readItem;
  if (!read) throw new Error('Full transcript content is unavailable.');
  const parts: string[] = [];
  let offset = 0;
  let totalLength: number | undefined = captured?.length;
  for (;;) {
    captured?.signal?.throwIfAborted();
    if (totalLength !== undefined && offset >= totalLength) return parts.join('');
    const content = await read(sessionId, itemId, { offset, part });
    captured?.signal?.throwIfAborted();
    if (content === null) throw new Error('Full transcript content is unavailable; reopen history and try again.');
    totalLength ??= content.totalLength;
    if (content.id !== itemId || content.offset !== offset
      || (captured ? content.totalLength < totalLength : content.totalLength !== totalLength)) {
      throw new Error('Transcript content changed during the read; try again.');
    }
    const text = content.text.slice(0, totalLength - offset);
    parts.push(text);
    offset += text.length;
    if (offset === totalLength) {
      if (!captured && content.nextOffset !== undefined) throw new Error('Transcript paging exceeded the content length.');
      return parts.join('');
    }
    if (content.nextOffset === undefined) {
      if (offset !== totalLength) throw new Error('Full transcript content is unavailable.');
      return parts.join('');
    }
    if (content.text.length === 0 || content.nextOffset !== offset) {
      throw new Error('Transcript content paging did not advance.');
    }
  }
}

type ViewToolStatus = NonNullable<ClientViewItem['tool']>['status'];

/** Read the omitted prefix without admitting characters produced after the browse snapshot. */
export async function readFrozenClientPlaneItems(
  plane: Pick<InkClientPlane, 'readItem' | 'readHistoryEntry'>,
  sessionId: string,
  items: readonly HistoryItem[],
  signal?: AbortSignal,
): Promise<HistoryItem[]> {
  return Promise.all(items.map(async item => {
    const read = async (part: 'text' | 'input', length: number | undefined): Promise<string | undefined> => {
      if (length === undefined) return undefined;
      const text = await readClientPlaneItemText(plane, sessionId, item.historyItemId ?? item.id, part,
        item.historyItemId !== undefined, { length, signal });
      return text;
    };
    const text = await read('text', item.totalTextLength);
    const inputText = await read('input', item.totalInputLength);
    if (text === undefined && inputText === undefined) return item;
    if (item.type !== 'tool_group' && text !== undefined && text.slice(item.textOffset ?? 0) !== item.text) {
      throw new Error('Frozen transcript content changed during the read.');
    }
    if (item.type === 'tool_group') return { ...item, totalTextLength: undefined, totalInputLength: undefined,
      tools: item.tools.map(tool => ({ ...tool,
        ...(text !== undefined ? { output: text } : {}),
        ...(inputText !== undefined ? { input: { preview: inputText }, inputText, preview: inputText } : {}),
      })) };
    return { ...item, ...(text !== undefined ? { text } : {}), textOffset: 0, totalTextLength: undefined };
  }));
}

/** Load the current conversation only when the user opens transcript history. */
export async function readClientPlaneHistory(
  plane: Pick<InkClientPlane, 'readItem' | 'readHistory' | 'readHistoryEntry'>,
  sessionId: string,
  signal?: AbortSignal,
): Promise<HistoryItem[]> {
  if (!plane.readHistory) throw new Error('Complete transcript history is unavailable.');
  const pages: HistoryItem[][] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let revision: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await plane.readHistory(sessionId, { cursor, limit: 100 });
    revision ??= page.revision;
    if (page.revision !== revision) throw new Error('History changed during loading; reopen transcript and try again.');
    const items: HistoryItem[] = [];
    for (const item of page.items) {
      signal?.throwIfAborted();
      const text = item.totalTextLength !== undefined && item.totalTextLength > item.text.length
        ? await readClientPlaneItemText(plane, sessionId, item.id, 'text', true, { length: item.totalTextLength, signal }) : item.text;
      const inputText = item.tool?.totalInputLength !== undefined && item.tool.totalInputLength > (item.tool.inputText?.length ?? 0)
        ? await readClientPlaneItemText(plane, sessionId, item.id, 'input', true,
          { length: item.tool.totalInputLength, signal }) : item.tool?.inputText;
      const [mapped] = clientViewToHistoryItems([{ ...item, text, textOffset: 0, totalTextLength: undefined,
        ...(item.tool ? { tool: { ...item.tool, inputText, totalInputLength: undefined } } : {}),
      }]);
      if (mapped) items.push({ ...mapped, historyItemId: item.id });
    }
    pages.push(items);
    cursor = page.nextCursor;
    if (cursor !== undefined && cursors.has(cursor)) throw new Error('History paging did not advance.');
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  signal?.throwIfAborted();
  return pages.reverse().flat();
}

const TOOL_STATUS_MAP: Record<ViewToolStatus, ToolCallStatus> = {
  running: RenderToolStatus.Executing,
  success: RenderToolStatus.Success,
  error: RenderToolStatus.Error,
  cancelled: RenderToolStatus.Cancelled,
  awaiting_approval: RenderToolStatus.AwaitingApproval,
};

/** Phases the product loop treats as an interrupted round. */
const INTERRUPTED_RUN_PHASES = new Set(['cancelled', 'interrupted']);

function interruptedPlaneResult(sessionId: string): KodaXResult {
  return {
    success: false,
    interrupted: true,
    signal: 'BLOCKED',
    lastText: '',
    messages: [],
    sessionId,
  };
}

/** Client-minted input identity; withdraw targets it while the input is queued. */
export function mintInkInputId(): string {
  return `ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const CHAIN_POLL_INTERVAL_MS = 100;
/** How long a queued input waits for its run before the round gives up. */
const QUEUED_RUN_WAIT_MS = 10_000;
/** Grace window after a terminal run for the Host to start a continuation. */
const CONTINUATION_WINDOW_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollActiveRun(
  plane: Pick<InkClientPlane, 'activeRun'>,
  sessionId: string,
  accept: (runId: string) => boolean,
  timeoutMs: number,
  bail?: () => boolean,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (bail?.()) return undefined;
    const active = await plane.activeRun(sessionId);
    if (bail?.()) return undefined;
    if (active !== undefined && accept(active)) return active;
    if (Date.now() >= deadline) return undefined;
    await sleep(CHAIN_POLL_INTERVAL_MS);
  }
}

/** Session Stop reuses one request identity across retries and never settles the Run locally. */
export function bindClientPlaneSessionStop(input: RuntimeStopCallbacks & { plane: InkClientPlane; sessionId: string },
  currentRun: () => string | undefined): { settled: (outcome: ClientRoundOutcome, runId: string) => void; close: () => void } {
  let target: ClientSessionCancelInput | undefined;
  let pending: Promise<{ state: 'unknown' | 'confirmed' }> | undefined;
  let accepted = false;
  let confirmed = false;
  let terminalOutcome: { runId: string; phase: string } | undefined;
  const confirm = (outcome: string): void => {
    if (accepted && !confirmed) { confirmed = true; input.onStopState?.('confirmed', outcome); }
  };
  input.onStopControl?.({ request: () => {
    if (pending) return pending;
    const expectedRunId = currentRun();
    if (!target && !expectedRunId) return Promise.reject(new Error('No active Run is available to stop.'));
    target ??= { sessionId: input.sessionId, expectedRunId: expectedRunId!, requestId: mintInkInputId() };
    input.onStopState?.('requesting');
    pending = input.plane.cancelSession(target).then(receipt => {
      accepted = true;
      input.onStopState?.('accepted');
      const stopped = receipt.receipts.find(item => item.runId === target!.expectedRunId);
      if (stopped?.state === 'confirmed') confirm(stopped.outcome);
      else if (terminalOutcome?.runId === target!.expectedRunId) confirm(terminalOutcome.phase);
      return { state: receipt.receipts.every(item => item.state === 'confirmed') ? 'confirmed' as const : 'unknown' as const };
    }).catch((error: unknown) => {
      input.onStopState?.('rejected', error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  } });
  return {
    settled: (outcome, runId) => {
      if (target && target.expectedRunId !== runId) return;
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(outcome.phase)) {
        terminalOutcome = { runId, phase: outcome.phase };
        confirm(outcome.phase);
      }
    },
    close: () => input.onStopControl?.(undefined),
  };
}

/** Follow an already accepted command and its queued continuations without submitting it again. */
export async function followClientPlaneRun(input: {
  readonly plane: InkClientPlane;
  readonly sessionId: string;
  readonly runId: string;
  readonly abortSignal?: AbortSignal;
  /** Read the Run already displayed to the user synchronously at interruption. */
  readonly getDisplayedRunId?: () => string | undefined;
} & RuntimeStopCallbacks): Promise<KodaXResult> {
  let currentRunId = input.runId;
  const sessionStop = bindClientPlaneSessionStop(input, () => input.getDisplayedRunId?.() ?? currentRunId);
  const aborted = (): boolean => input.abortSignal?.aborted === true;
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    const runId = input.getDisplayedRunId?.() ?? currentRunId;
    currentRunId = runId;
    stopping = input.plane.stop(runId).then((receipt) => {
      if (receipt?.accepted === false) {
        emitKodaXDiagnostic({ source: 'client.plane', level: 'warn',
          message: `The Host did not accept the stop request for run ${runId}.` });
      }
    }).catch((error: unknown) => {
      emitKodaXDiagnostic({ source: 'client.plane', level: 'warn',
        message: `The stop request for run ${runId} failed.`, detail: error });
    });
  };
  input.abortSignal?.addEventListener('abort', stop, { once: true });
  try {
    if (input.abortSignal?.aborted) stop();
    let outcome: ClientRoundOutcome;
    for (;;) {
      const awaitedRunId = currentRunId;
      outcome = await input.plane.awaitRun(input.sessionId, awaitedRunId);
      sessionStop.settled(outcome, awaitedRunId);
      const continuation = await pollActiveRun(input.plane, input.sessionId,
        (runId) => runId !== currentRunId, CONTINUATION_WINDOW_MS, aborted);
      if (aborted()) {
        await stopping;
        if (currentRunId !== awaitedRunId) continue;
        break;
      }
      if (continuation === undefined) break;
      currentRunId = continuation;
    }
    if (outcome.error !== undefined) throw new Error(outcome.error);
    if (outcome.result !== undefined) return outcome.result;
    if (INTERRUPTED_RUN_PHASES.has(outcome.phase)) return interruptedPlaneResult(input.sessionId);
    throw new Error(outcome.error ?? `Run ${currentRunId} ended in phase '${outcome.phase}' without a result.`);
  } finally {
    sessionStop.close();
    input.abortSignal?.removeEventListener('abort', stop);
  }
}

/** Submit one input, following its Run and the Host's queued continuations. */
export async function runClientPlaneRound(input: {
  readonly plane: InkClientPlane;
  readonly submit?: InkClientPlane['submit'];
  readonly sessionId: string;
  readonly prompt: string;
  readonly abortSignal?: AbortSignal;
  /** Read the Run already displayed to the user synchronously at interruption. */
  readonly getDisplayedRunId?: () => string | undefined;
  readonly inputArtifacts?: readonly KodaXInputArtifact[];
} & RuntimeStopCallbacks): Promise<KodaXResult> {
  const inputId = mintInkInputId();
  const aborted = (): boolean => input.abortSignal?.aborted === true;
  let stopping: Promise<unknown> | undefined;
  const stopRun = (runId: string | undefined): void => {
    if (runId !== undefined) {
      stopping = input.plane.stop(runId).then(
        (receipt) => {
          if (receipt?.accepted === false) {
            emitKodaXDiagnostic({
              source: 'client.plane',
              level: 'warn',
              message: `The Host did not accept the stop request for run ${runId}.`,
            });
          }
        },
        (error: unknown) => {
          emitKodaXDiagnostic({
            source: 'client.plane',
            level: 'warn',
            message: `The stop request for run ${runId} failed.`,
            detail: error,
          });
        },
      );
    } else {
      stopping = input.plane.withdraw(input.sessionId, inputId).catch((error: unknown) => {
        emitKodaXDiagnostic({
          source: 'client.plane',
          level: 'warn',
          message: `The withdraw request for input ${inputId} failed; the queued input may still run.`,
          detail: error,
        });
      });
    }
  };
  const accepted = await (input.submit ?? input.plane.submit)({
    sessionId: input.sessionId,
    text: input.prompt,
    inputId,
    ...(input.inputArtifacts !== undefined && input.inputArtifacts.length > 0
      ? { inputArtifacts: input.inputArtifacts }
      : {}),
  });
  if (accepted.state === 'dropped' || accepted.state === 'withdrawn') {
    throw new Error(
      `The Host ${accepted.state} the input; resubmit with a new input id.`,
    );
  }
  if (aborted()) {
    stopRun(accepted.runId);
    return interruptedPlaneResult(input.sessionId);
  }
  let currentRunId = accepted.runId;
  const sessionStop = bindClientPlaneSessionStop(input, () => input.getDisplayedRunId?.() ?? currentRunId);
  let lastOutcome: ClientRoundOutcome | undefined;
  const stop = (): void => {
    if (currentRunId !== undefined) currentRunId = input.getDisplayedRunId?.() ?? currentRunId;
    stopRun(currentRunId);
  };
  input.abortSignal?.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      if (currentRunId === undefined) {
        currentRunId = await pollActiveRun(
          input.plane,
          input.sessionId,
          () => true,
          QUEUED_RUN_WAIT_MS,
          aborted,
        );
        if (currentRunId === undefined) {
          if (aborted()) {
            await stopping;
            return interruptedPlaneResult(input.sessionId);
          }
          // The input never started; take it back so it cannot run later
          // after the caller has already surfaced the failure. A failed
          // withdraw must not be silent: the input would stay runnable
          // while the caller believes it was taken back.
          let withdrawNote = '';
          try {
            await input.plane.withdraw(input.sessionId, inputId);
          } catch (error: unknown) {
            withdrawNote = ` The take-back after the timeout also failed (${error instanceof Error ? error.message : String(error)}); the input may still run from the Host queue.`;
            emitKodaXDiagnostic({
              source: 'client.plane',
              level: 'warn',
              message: `The withdraw request for input ${inputId} failed after the queued input never started.`,
              detail: error,
            });
          }
          throw new Error(
            `The queued input did not start a run within the wait window.${withdrawNote}`,
          );
        }
      }
      const awaitedRunId = currentRunId;
      lastOutcome = await input.plane.awaitRun(input.sessionId, awaitedRunId);
      sessionStop.settled(lastOutcome, awaitedRunId);
      const continuation = await pollActiveRun(
        input.plane,
        input.sessionId,
        (runId) => runId !== currentRunId,
        CONTINUATION_WINDOW_MS,
        aborted,
      );
      if (aborted()) {
        await stopping;
        if (currentRunId !== awaitedRunId) continue;
        break;
      }
      if (continuation === undefined) break;
      currentRunId = continuation;
    }
    const outcome = lastOutcome;
    if (outcome === undefined) throw new Error('The client-plane round ended without a run outcome.');
    if (outcome.error !== undefined) throw new Error(outcome.error);
    if (outcome.result !== undefined) return outcome.result;
    if (INTERRUPTED_RUN_PHASES.has(outcome.phase)) {
      return interruptedPlaneResult(input.sessionId);
    }
    throw new Error(outcome.error ?? `Run ${currentRunId} ended in phase '${outcome.phase}' without a result.`);
  } finally {
    sessionStop.close();
    input.abortSignal?.removeEventListener('abort', stop);
  }
}

const LIVE_RUN_PHASES = new Set([
  'queued',
  'running',
  'waiting_agent',
  'recovering',
  'waiting_permission',
  'waiting_user_input',
]);

/** First run in a live phase; run lists are ordered oldest-first. */
export function firstActiveRunId(
  runs: readonly { readonly runId: string; readonly phase: string }[],
): string | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (LIVE_RUN_PHASES.has(run.phase)) return run.runId;
  }
  return undefined;
}

/** Active run id from the view's run list, or undefined when idle. */
export function viewRunsActive(
  view: Pick<ClientSessionView, 'runs'>,
): string | undefined {
  return firstActiveRunId(view.runs);
}

/** Adapter-side memo entry: reuse the mapped item while the fingerprint holds. */
export interface ClientViewItemMemo {
  readonly entries: Map<string, { fingerprint: string; item: HistoryItem }>;
}

/** djb2 over the string — content-sensitive, cheap, stable across pushes. */
function textHash(value: string | undefined): number {
  if (value === undefined) return -1;
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function itemFingerprint(item: ClientViewItem): string {
  return [
    item.type,
    `${item.text.length}:${textHash(item.text)}`,
    item.compactText === undefined
      ? '-'
      : `${item.compactText.length}:${textHash(item.compactText)}`,
    item.icon ?? '',
    item.tool?.status ?? '',
    item.tool?.progress ?? '',
    item.tool?.endedAt ?? 0,
    item.tool?.inputText === undefined
      ? '-'
      : `${item.tool.inputText.length}:${textHash(item.tool.inputText)}`,
    item.totalTextLength ?? -1,
    item.textOffset ?? 0,
    item.tool?.totalInputLength ?? -1,
  ].join('|');
}

/** Suffix the Host adds when a bounded item was sliced; readItem pages the rest. */
const TRUNCATED_SUFFIX = '\n[truncated]';
/** True when the view text is a bounded slice of a longer item. */
export function hasBoundedItemText(text: string): boolean {
  return text.endsWith(TRUNCATED_SUFFIX);
}


function boundedText(item: ClientViewItem): string {
  return item.totalTextLength !== undefined && item.totalTextLength > item.text.length
    ? `${item.text}${TRUNCATED_SUFFIX}`
    : item.text;
}

/**
 * Map the Host's display items onto the Ink render model (types align by
 * design). Streaming marks only the TRAILING assistant item — the item the
 * active run is appending to. Pass a `memo` (kept across calls by the
 * observer) so unchanged items keep their HistoryItem identity and the
 * memoized renderers skip re-rendering the whole transcript per delta.
 */
export function clientViewToHistoryItems(
  items: readonly ClientViewItem[],
  options: {
    readonly activeRunId?: string;
    readonly memo?: ClientViewItemMemo;
  } = {},
): HistoryItem[] {
  const trailingAssistantIndex = options.activeRunId === undefined
    ? -1
    : findLastIndex(items, (item) => item.type === 'assistant');
  if (options.memo !== undefined) {
    // Prune entries whose items left the bounded view window (this also
    // clears the cache across session switches).
    const ids = new Set(items.map((item) => item.id));
    for (const id of options.memo.entries.keys()) {
      if (!ids.has(id)) options.memo.entries.delete(id);
    }
  }
  return items.map((item, index) => {
    const memoized = options.memo?.entries.get(item.id);
    const streamingThisItem = index === trailingAssistantIndex;
    // The streaming position is part of the identity: when the run turns
    // terminal the same text must remap without the streaming marker.
    const fingerprint = `${streamingThisItem ? 'live' : 'done'}|${itemFingerprint(item)}`;
    if (
      memoized !== undefined
      && memoized.fingerprint === fingerprint
      && !streamingThisItem
    ) {
      return memoized.item;
    }
    const mapped = mapViewItem(item, streamingThisItem);
    options.memo?.entries.set(item.id, { fingerprint, item: mapped });
    return mapped;
  });
}

function findLastIndex(
  items: readonly ClientViewItem[],
  predicate: (item: ClientViewItem) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function mapViewItem(item: ClientViewItem, streaming: boolean): HistoryItem {
  const base = {
    id: item.id,
    ...(item.inputId !== undefined ? { inputId: item.inputId } : {}),
    timestamp: item.timestamp ?? 0,
    isSessionUiOnly: true,
    ...(item.textOffset !== undefined ? { textOffset: item.textOffset } : {}),
    ...(item.totalTextLength !== undefined ? { totalTextLength: item.totalTextLength } : {}),
    ...(item.tool?.totalInputLength !== undefined ? { totalInputLength: item.tool.totalInputLength } : {}),
  };
  if (item.type === 'tool' && item.tool) {
    const tool: ToolCall = {
      id: item.tool.callId,
      name: item.tool.name,
      status: TOOL_STATUS_MAP[item.tool.status],
      ...(item.tool.inputText !== undefined ? {
        input: { preview: item.tool.inputText }, preview: item.tool.inputText, inputText: item.tool.inputText,
      } : {}),
      ...(item.text.length > 0 ? { output: boundedText(item) } : {}),
      ...(item.tool.progress !== undefined
        ? { progressLines: [item.tool.progress] }
        : {}),
      startTime: item.tool.startedAt ?? item.timestamp ?? 0,
      ...(item.tool.endedAt !== undefined ? { endTime: item.tool.endedAt } : {}),
    };
    return { ...base, type: 'tool_group' as const, tools: [tool] };
  }
  if (item.type === 'assistant') {
    return {
      ...base,
      type: 'assistant' as const,
      text: item.text,
      ...(item.compactText !== undefined ? { compactText: item.compactText } : {}),
      ...(streaming ? { isStreaming: true } : {}),
    };
  }
  return {
    ...base,
    type: item.type as Exclude<ClientViewItem['type'], 'tool' | 'assistant'>,
    text: item.text,
    ...(item.compactText !== undefined ? { compactText: item.compactText } : {}),
    ...(item.icon !== undefined ? { icon: item.icon } : {}),
  };
}

/**
 * FEATURE_298 T17 — the dialog surface the plane drives. Ink binds these to
 * its existing askUser/permission dialog implementations; tests inject fakes.
 */
export interface ClientPlaneDialogSurface {
  readonly question: (
    options: AskUserQuestionOptions,
    signal?: AbortSignal,
  ) => Promise<AskUserAnswer>;
  readonly questionMulti: (
    options: AskUserMultiOptions,
    signal?: AbortSignal,
  ) => Promise<Record<string, AskUserAnswer> | undefined>;
  readonly questionInput: (
    options: { readonly question: string; readonly default?: string },
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  readonly permission: (
    options: ClientPermissionInteractionOptions,
    signal?: AbortSignal,
  ) => Promise<ConfirmResult>;
}

/**
 * Answer one pending Host interaction through the dialog surface and forward
 * the typed response; first valid answer wins Host-side, so a late dialog
 * result simply resolves as `false`.
 */
export async function answerClientPlaneInteraction(
  plane: Pick<InkClientPlane, 'respondInteraction'>,
  interaction: ClientInteraction,
  surface: ClientPlaneDialogSurface,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  let response: ClientInteractionResponse;
  switch (interaction.kind) {
    case 'question': {
      const answer = await surface.question(interaction.options, signal);
      response = answer === CANCELLED_TOOL_RESULT_MESSAGE
        ? { kind: 'cancel' }
        : { kind: 'question', answer };
      break;
    }
    case 'question_multi': {
      const answers = await surface.questionMulti(interaction.options, signal);
      response = answers === undefined
        ? { kind: 'cancel' }
        : { kind: 'question_multi', answers };
      break;
    }
    case 'question_input': {
      const text = await surface.questionInput(interaction.options, signal);
      response = text === undefined ? { kind: 'cancel' } : { kind: 'question_input', text };
      break;
    }
    case 'permission': {
      const result = await surface.permission(interaction.options, signal);
      const decision = resolveReplRuntimePermissionDecision(
        {
          id: interaction.requestId,
          toolName: interaction.options.toolName,
          ...(interaction.options.toolCallId !== undefined
            ? { toolCallId: interaction.options.toolCallId }
            : {}),
          input: {},
          ...(interaction.options.reason !== undefined
            ? { reason: interaction.options.reason }
            : {}),
          ...(interaction.options.risk !== undefined ? { risk: interaction.options.risk } : {}),
          ...(interaction.options.executionCwd !== undefined
            ? { executionCwd: interaction.options.executionCwd }
            : {}),
          ...(interaction.options.grantSuggestions !== undefined
            ? { grantSuggestions: interaction.options.grantSuggestions }
            : {}),
        },
        result,
      );
      response = { kind: 'permission', decision };
      break;
    }
  }
  // Observation cleanup is not a user cancellation or permission decision.
  if (signal?.aborted) return false;
  return plane.respondInteraction(interaction.requestId, response);
}
