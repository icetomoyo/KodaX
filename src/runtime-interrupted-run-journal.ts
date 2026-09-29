import type { KodaXInterruptedRunOperation } from '@kodax-ai/coding';

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

function startedOperation(payload: unknown): MutableOperation | undefined {
  const tool = isRecord(payload) ? payload.tool : undefined;
  if (!isRecord(tool) || typeof tool.id !== 'string' || typeof tool.name !== 'string') return undefined;
  const target = describeToolInput(tool.input);
  return { toolUseId: tool.id, name: tool.name, ...(target !== undefined ? { target } : {}) };
}

function finishedResult(payload: unknown): { readonly id: string; readonly content: string } | undefined {
  const result = isRecord(payload) ? payload.result : undefined;
  if (!isRecord(result) || typeof result.id !== 'string' || typeof result.content !== 'string') return undefined;
  return { id: result.id, content: result.content };
}

// Candidates are replayed from disk, so only the most recent few are read;
// the managed renderer further drops any whose turn is off the active path.
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
 * journal order. A started tool without a journaled result keeps no
 * `result`, which the recovery record reports as an unknown outcome.
 */
export function deriveInterruptedRunOperations(
  events: readonly RuntimeEvent[],
): KodaXInterruptedRunOperation[] {
  const byId = new Map<string, MutableOperation>();
  for (const event of events) {
    if (event.type === 'tool.started') {
      const operation = startedOperation(event.payload);
      if (operation !== undefined && !byId.has(operation.toolUseId)) byId.set(operation.toolUseId, operation);
    } else if (event.type === 'tool.finished') {
      const result = finishedResult(event.payload);
      const operation = result === undefined ? undefined : byId.get(result.id);
      if (operation !== undefined && result !== undefined) {
        operation.result = boundField(result.content) ?? '(empty result)';
      }
    }
  }
  return [...byId.values()];
}
