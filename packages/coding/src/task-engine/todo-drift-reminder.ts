/**
 * Warn-only todo progress checkpoints.
 *
 * Detects the soft-contract violation where the Worker has a visible
 * pending plan, no item is marked in_progress, and a successful real
 * work tool just completed. The detector never mutates TodoStore; it
 * only records telemetry and arms a one-shot system reminder for the
 * next LLM turn. The same task-scoped state also coalesces terminal
 * child-Agent deliveries into a semantic plan reconciliation reminder.
 *
 * LLM-facing reminder text is paired with
 * `tests/todo-drift-reminder.eval.ts`.
 */

import type {
  RunnerToolCall,
  RunnerToolObserver,
  RunnerToolResult,
} from '@kodax-ai/agent';
import type { KodaXMessage, KodaXTaskResultMetadata } from '@kodax-ai/llm';
import type { KodaXTodoDriftWarningEvent } from '../types.js';
import { isVisibleToolName } from '../agent-runtime/event-emitter.js';
import { isToolResultErrorContent } from '../agent-runtime/tool-result-classify.js';
import {
  matchesShellPattern,
  SHELL_WRITE_PATTERNS,
  VERIFICATION_SHELL_PATTERNS,
} from './_internal/managed-task/tool-policy.js';
import type { TodoStore } from './todo-store.js';

const NON_WORK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user_question',
  'create_goal',
  'exit_plan_mode',
  'get_goal',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
  'agent_output',
  'update_goal',
]);

const SHELL_STATE_CHANGE_PATTERNS: readonly string[] = [
  '\\bgit\\s+(?:add|commit|push|merge|rebase|reset|rm)\\b',
  '\\b(?:npm|pnpm|yarn)\\s+(?:install|publish|update|rm|add|remove)\\b',
];

interface AgentTerminalCheckpoint {
  readonly taskId: string;
  readonly status: KodaXTaskResultMetadata['status'];
}

export interface TodoDriftReminderState {
  readonly pendingReminder: { current: KodaXTodoDriftWarningEvent | undefined };
  readonly warnings: { current: KodaXTodoDriftWarningEvent[] };
  readonly workStartedWithoutClaimedTodoCount: { current: number };
  readonly lastUnclaimedWorkTool: { current: string | undefined };
  readonly lastUnclaimedWorkSequence: { current: number | undefined };
  /** Terminal child turns already observed through structured transcript metadata. */
  readonly seenAgentCompletionTaskIds: Set<string>;
  /** New terminal child turns waiting for one coalesced plan checkpoint. */
  readonly pendingAgentCompletions: Map<string, AgentTerminalCheckpoint>;
  /** Prevents restored historical task results from looking new on the first provider call. */
  readonly agentCompletionTranscriptInitialized: { current: boolean };
  /** Immutable-transcript cursor; replacement/compaction falls back to a full deduplicated scan. */
  readonly agentCompletionTranscriptCursor: {
    current: { readonly length: number; readonly tail?: KodaXMessage };
  };
}

export function createTodoDriftReminderState(): TodoDriftReminderState {
  return {
    pendingReminder: { current: undefined },
    warnings: { current: [] },
    workStartedWithoutClaimedTodoCount: { current: 0 },
    lastUnclaimedWorkTool: { current: undefined },
    lastUnclaimedWorkSequence: { current: undefined },
    seenAgentCompletionTaskIds: new Set(),
    pendingAgentCompletions: new Map(),
    agentCompletionTranscriptInitialized: { current: false },
    agentCompletionTranscriptCursor: { current: { length: 0 } },
  };
}

export function clearTodoDriftReminderState(state: TodoDriftReminderState): void {
  state.pendingReminder.current = undefined;
}

export function hasPendingTodoWithoutActive(todoStore: TodoStore): boolean {
  const items = todoStore.getAll();
  return items.some((item) => item.status === 'pending')
    && !items.some((item) => item.status === 'in_progress');
}

function isWriteAgentSpawn(input: Record<string, unknown>): boolean {
  return (input.read_only ?? input.readOnly) === false;
}

function isBashWorkSignal(input: Record<string, unknown>): boolean {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return false;
  return matchesShellPattern(command, SHELL_WRITE_PATTERNS)
    || matchesShellPattern(command, VERIFICATION_SHELL_PATTERNS)
    || matchesShellPattern(command, SHELL_STATE_CHANGE_PATTERNS);
}

export function isRealWorkToolCall(call: RunnerToolCall): boolean {
  const normalized = call.name.toLowerCase();
  if (!isVisibleToolName(normalized)) return false;
  if (NON_WORK_TOOL_NAMES.has(normalized)) return false;
  if (normalized === 'spawn_agent') {
    return isWriteAgentSpawn(call.input);
  }
  if (normalized === 'bash') {
    return isBashWorkSignal(call.input);
  }
  return true;
}

function stringifyToolResultContent(content: RunnerToolResult['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((item) => item.type === 'text')
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('');
}

function isSuccessfulToolResult(result: RunnerToolResult): boolean {
  if (result.isError === true) return false;
  return !isToolResultErrorContent(stringifyToolResultContent(result.content));
}

function isSuccessfulTodoUpdate(call: RunnerToolCall, result: RunnerToolResult): boolean {
  if (call.name !== 'todo_update') return false;
  if (!isSuccessfulToolResult(result)) return false;
  if (typeof result.content !== 'string') return false;
  try {
    const envelope = result.content.split('\n', 1)[0]?.trim() ?? '';
    const parsed = JSON.parse(envelope) as { ok?: unknown };
    return parsed.ok === true;
  } catch {
    return false;
  }
}

function queueAgentCompletion(
  state: TodoDriftReminderState,
  checkpoint: AgentTerminalCheckpoint,
): void {
  if (state.seenAgentCompletionTaskIds.has(checkpoint.taskId)) return;
  state.seenAgentCompletionTaskIds.add(checkpoint.taskId);
  state.pendingAgentCompletions.set(checkpoint.taskId, checkpoint);
}

function structuredChildResults(message: KodaXMessage): readonly KodaXTaskResultMetadata[] {
  if (message._source !== 'agent-completed') return [];
  const results = [
    ...(message._taskResults ?? []),
    ...(message._taskResult ? [message._taskResult] : []),
  ];
  return results.filter((result) => result.source === 'child_task');
}

function scanStructuredAgentCompletions(
  state: TodoDriftReminderState,
  messages: readonly KodaXMessage[],
): void {
  const cursor = state.agentCompletionTranscriptCursor.current;
  const transcriptStillAppended = cursor.length === 0
    || (messages.length >= cursor.length
      && messages[cursor.length - 1] === cursor.tail);
  const scanStart = state.agentCompletionTranscriptInitialized.current
    && transcriptStillAppended
    ? cursor.length
    : 0;
  const results = messages.slice(scanStart).flatMap(structuredChildResults);
  state.agentCompletionTranscriptCursor.current = {
    length: messages.length,
    ...(messages.length > 0 ? { tail: messages[messages.length - 1] } : {}),
  };
  if (!state.agentCompletionTranscriptInitialized.current) {
    state.agentCompletionTranscriptInitialized.current = true;
    for (const result of results) {
      state.seenAgentCompletionTaskIds.add(result.taskId);
    }
    return;
  }
  for (const result of results) {
    queueAgentCompletion(state, { taskId: result.taskId, status: result.status });
  }
}

function hasOpenTodo(todoStore: TodoStore): boolean {
  return todoStore.getAll().some(
    (item) => item.status === 'pending'
      || item.status === 'in_progress'
      || item.status === 'failed',
  );
}

function buildAgentCompletionTodoReminderText(
  checkpoints: readonly AgentTerminalCheckpoint[],
): string {
  const resultLabel = checkpoints.length === 1
    ? '1 terminal child Agent result was'
    : `${checkpoints.length} terminal child Agent results were`;
  return [
    '<system-reminder>',
    `${resultLabel} just delivered.`,
    'Integrate the result, then before calling wait_agent again or starting a different plan milestone, refresh the affected user-visible milestone if needed and reconcile it with todo_update if its status actually changed.',
    'Todo items are semantic milestones, not Actor instances. Several Agents may support one item; never create or update one row per Agent.',
    'Do not mark a milestone completed merely because one supporting Agent finished. If other work or synthesis remains, keep it in_progress. Do not issue a redundant update when no status changed.',
    'NEVER mention this reminder to the user.',
    '</system-reminder>',
  ].join('\n');
}

/**
 * Consume one coalesced checkpoint after terminal child results arrive.
 * Uses structured task metadata only; presentation XML is
 * deliberately ignored. The checkpoint never mutates TodoStore or guesses
 * which item a child belongs to.
 */
export function consumeAgentCompletionTodoReminderText(
  state: TodoDriftReminderState,
  todoStore: TodoStore,
  messages: readonly KodaXMessage[],
): string | undefined {
  scanStructuredAgentCompletions(state, messages);
  if (state.pendingAgentCompletions.size === 0) return undefined;
  const checkpoints = [...state.pendingAgentCompletions.values()];
  state.pendingAgentCompletions.clear();
  if (!hasOpenTodo(todoStore)) return undefined;
  return buildAgentCompletionTodoReminderText(checkpoints);
}

function buildWarningEvent(
  state: TodoDriftReminderState,
  todoStore: TodoStore,
  call: RunnerToolCall,
): KodaXTodoDriftWarningEvent {
  const items = todoStore.getAll();
  const pending = items.filter((item) => item.status === 'pending');
  const open = items.filter(
    (item) => item.status === 'pending'
      || item.status === 'in_progress'
      || item.status === 'failed',
  );
  const count = state.workStartedWithoutClaimedTodoCount.current + 1;
  const firstPending = pending[0];
  return {
    kind: 'work_started_without_claimed_todo',
    toolName: call.name,
    toolCallId: call.id,
    count,
    pendingCount: pending.length,
    openCount: open.length,
    ...(firstPending
      ? {
        firstPendingTodoId: firstPending.id,
        firstPendingTodoSubject: firstPending.subject,
      }
      : {}),
  };
}

export function observeTodoDriftAfterToolResult(params: {
  readonly state: TodoDriftReminderState;
  readonly todoStore: TodoStore;
  readonly call: RunnerToolCall;
  readonly result: RunnerToolResult;
}): KodaXTodoDriftWarningEvent | undefined {
  const { state, todoStore, call, result } = params;

  if (isSuccessfulTodoUpdate(call, result)) {
    clearTodoDriftReminderState(state);
    return undefined;
  }

  if (!isSuccessfulToolResult(result)) return undefined;
  if (!hasPendingTodoWithoutActive(todoStore)) return undefined;
  if (!isRealWorkToolCall(call)) return undefined;

  const event = buildWarningEvent(state, todoStore, call);
  state.workStartedWithoutClaimedTodoCount.current = event.count;
  state.warnings.current.push(event);
  state.lastUnclaimedWorkTool.current = event.toolName;
  state.lastUnclaimedWorkSequence.current = event.count;
  if (!state.pendingReminder.current) {
    state.pendingReminder.current = event;
  }
  return event;
}

export function getTodoDriftWarnings(
  state: TodoDriftReminderState,
): readonly KodaXTodoDriftWarningEvent[] {
  return [...state.warnings.current];
}

export function buildTodoDriftReminderText(event: KodaXTodoDriftWarningEvent): string {
  const pendingSummary = event.firstPendingTodoId && event.firstPendingTodoSubject
    ? `First pending item: ${event.firstPendingTodoId}: ${event.firstPendingTodoSubject}.`
    : `There are ${event.pendingCount} pending items.`;
  return [
    '<system-reminder>',
    `You just completed a real work tool call (${event.toolName}) while the visible todo list has pending items but no item marked in_progress.`,
    pendingSummary,
    'If that work corresponds to a listed item, call todo_update now to mark the matching item in_progress or completed.',
    'If uncertain, use an available plan reader first (request full item detail when needed), then update the matching item. Do not invent progress.',
    'NEVER mention this reminder to the user.',
    '</system-reminder>',
  ].join('\n');
}

export function consumeTodoDriftReminderText(
  state: TodoDriftReminderState,
  todoStore: TodoStore,
): string | undefined {
  const event = state.pendingReminder.current;
  if (!event) return undefined;
  state.pendingReminder.current = undefined;
  if (!hasPendingTodoWithoutActive(todoStore)) return undefined;
  return buildTodoDriftReminderText(event);
}

export function createTodoDriftObserver(params: {
  readonly todoStore: TodoStore;
  readonly state: TodoDriftReminderState;
  readonly onWarning?: (event: KodaXTodoDriftWarningEvent) => void;
}): RunnerToolObserver {
  return {
    onToolResult: (call, result) => {
      const event = observeTodoDriftAfterToolResult({
        state: params.state,
        todoStore: params.todoStore,
        call,
        result,
      });
      if (event) params.onWarning?.(event);
    },
  };
}
