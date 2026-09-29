import {
  createOutputSegmentProjection,
  reduceOutputSegmentProjection,
  type KodaXInterruptedRunOperation,
  type KodaXInterruptedRunReply,
  type KodaXOutputSegmentMode,
  type KodaXOutputSegmentProjection,
} from '@kodax-ai/coding';

import type { RuntimeEvent } from './sdk-runtime.js';

const MAX_FIELD_CHARS = 120;
const TARGET_INPUT_KEYS = ['path', 'file_path', 'command', 'url', 'query', 'pattern'] as const;

type MutableOperation = { -readonly [K in keyof KodaXInterruptedRunOperation]: KodaXInterruptedRunOperation[K] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundField(text: string): string | undefined {
  const firstLine = text.trim().split('\n', 1)[0]?.trim() ?? '';
  if (firstLine.length === 0) return undefined;
  return firstLine.length <= MAX_FIELD_CHARS
    ? firstLine
    : `${firstLine.slice(0, MAX_FIELD_CHARS - 1)}…`;
}

function describeToolInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const preferred = TARGET_INPUT_KEYS
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string');
  const fallback = Object.values(input).find((value): value is string => typeof value === 'string');
  const target = preferred ?? fallback;
  return target === undefined ? undefined : boundField(target);
}

function startedOperation(payload: unknown, turnId: string | undefined): MutableOperation | undefined {
  const tool = isRecord(payload) ? payload.tool : undefined;
  if (!isRecord(tool) || typeof tool.id !== 'string' || typeof tool.name !== 'string') return undefined;
  const target = describeToolInput(tool.input);
  return {
    toolUseId: tool.id,
    ...(turnId !== undefined ? { turnId } : {}),
    name: tool.name,
    ...(target !== undefined ? { target } : {}),
  };
}

function invocationKey(turnId: string | undefined, toolUseId: string): string {
  return JSON.stringify([turnId ?? null, toolUseId]);
}

function finishedResult(payload: unknown): { readonly id: string; readonly content: string } | undefined {
  const result = isRecord(payload) ? payload.result : undefined;
  if (!isRecord(result) || typeof result.id !== 'string' || typeof result.content !== 'string') return undefined;
  return { id: result.id, content: result.content };
}

// A reply's tail carries its latest status, so long replies keep their end.
const MAX_REPLY_CHARS = 1_200;
const MAX_REPLIES = 6;

/** Child actor output is mirrored live into the root journal; it is not the root Run's reply. */
function isLiveMirror(payload: Record<string, unknown>): boolean {
  return isRecord(payload.meta) && payload.meta.liveOnly === true;
}

function segmentStart(payload: unknown): { readonly responseId: string; readonly providerRequestId: string; readonly mode: KodaXOutputSegmentMode } | undefined {
  if (!isRecord(payload) || isLiveMirror(payload)) return undefined;
  if (typeof payload.responseId !== 'string' || typeof payload.providerRequestId !== 'string') return undefined;
  if (payload.mode !== 'append' && payload.mode !== 'replace') return undefined;
  return { responseId: payload.responseId, providerRequestId: payload.providerRequestId, mode: payload.mode };
}

function textDelta(payload: unknown): { readonly providerRequestId: string; readonly text: string } | undefined {
  if (!isRecord(payload) || isLiveMirror(payload)) return undefined;
  if (typeof payload.text !== 'string' || typeof payload.providerRequestId !== 'string') return undefined;
  return { providerRequestId: payload.providerRequestId, text: payload.text };
}

function boundedReply(turnId: string, text: string): KodaXInterruptedRunReply | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const truncated = trimmed.length > MAX_REPLY_CHARS;
  return { turnId, text: truncated ? trimmed.slice(-MAX_REPLY_CHARS).trimStart() : trimmed, truncated };
}

function projectionReplies(turnId: string, projection: KodaXOutputSegmentProjection): KodaXInterruptedRunReply[] {
  const segments = projection.active ? [...projection.retained, projection.active] : projection.retained;
  return segments.flatMap((segment) => boundedReply(turnId, segment.assistantText) ?? []);
}

/**
 * Reconstruct the assistant text each provider call streamed, in journal
 * order. The output-segment projection drops text that a retry replaced, and
 * each response's segments are attributed to the turn that streamed them.
 * Text without an owning started segment is ignored, as is child actor
 * output mirrored live. Thinking is never kept.
 */
export function deriveInterruptedRunReplies(
  events: readonly RuntimeEvent[],
): KodaXInterruptedRunReply[] {
  const replies: KodaXInterruptedRunReply[] = [];
  let projection = createOutputSegmentProjection();
  let responseId: string | undefined;
  for (const event of events) {
    if (event.type === 'output.segment.started') {
      const start = segmentStart(event.payload);
      if (start === undefined) continue;
      if (responseId !== undefined && start.responseId !== responseId) {
        replies.push(...projectionReplies(responseId, projection));
        projection = createOutputSegmentProjection();
      }
      responseId = start.responseId;
      projection = reduceOutputSegmentProjection(projection, { type: 'segment.started', ...start }).state;
    } else if (event.type === 'assistant.delta') {
      const text = textDelta(event.payload);
      if (text !== undefined) projection = reduceOutputSegmentProjection(projection, { type: 'assistant.delta', ...text }).state;
    }
  }
  if (responseId !== undefined) replies.push(...projectionReplies(responseId, projection));
  return replies.slice(-MAX_REPLIES);
}

// Candidates are replayed from disk, so only the most recent few are read;
// the renderer further drops any whose turn is off the active path.
const MAX_INTERRUPTED_RUN_CANDIDATES = 5;

export interface InterruptedRunCandidate {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly sessionOrder: number;
  readonly terminal?: { readonly kind: string; readonly code: string };
}

/**
 * Earlier Runs of the same Session that ended without completing. Their
 * journals may hold operations that never reached formal history.
 */
export function selectInterruptedRunCandidates<T extends InterruptedRunCandidate>(
  runs: Iterable<T>,
  current: { readonly runId: string; readonly sessionId: string },
): Array<T & { readonly turnId: string; readonly terminal: NonNullable<T['terminal']> }> {
  return [...runs]
    .filter((run): run is T & { readonly turnId: string; readonly terminal: NonNullable<T['terminal']> } =>
      run.sessionId === current.sessionId
      && run.runId !== current.runId
      && run.turnId !== undefined
      && run.terminal !== undefined
      && run.terminal.kind !== 'completed')
    .sort((left, right) => left.sessionOrder - right.sessionOrder)
    .slice(-MAX_INTERRUPTED_RUN_CANDIDATES);
}

/**
 * Reconstruct the tool operations of one Run from its event journal, in
 * journal order. Provider call ids repeat across turns, so each start opens
 * its own invocation and a result closes only the open invocation with the
 * same id in the same turn. A started tool without a journaled result keeps
 * no `result`, which the recovery record reports as an unknown outcome.
 */
export function deriveInterruptedRunOperations(
  events: readonly RuntimeEvent[],
): KodaXInterruptedRunOperation[] {
  const operations: MutableOperation[] = [];
  const open = new Map<string, MutableOperation>();
  for (const event of events) {
    if (event.type === 'tool.started') {
      const operation = startedOperation(event.payload, event.turnId);
      // A repeated start of a still-open invocation is the same call announced again.
      if (operation === undefined || open.has(invocationKey(operation.turnId, operation.toolUseId))) continue;
      open.set(invocationKey(operation.turnId, operation.toolUseId), operation);
      operations.push(operation);
    } else if (event.type === 'tool.finished') {
      const result = finishedResult(event.payload);
      const key = result === undefined ? undefined : invocationKey(event.turnId, result.id);
      const operation = key === undefined ? undefined : open.get(key);
      if (operation === undefined || result === undefined || key === undefined) continue;
      operation.result = boundField(result.content) ?? '(empty result)';
      open.delete(key);
    }
  }
  return operations;
}
