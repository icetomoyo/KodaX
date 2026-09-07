/**
 * FEATURE_298 T35 — runtime-event → KodaXEvents forwarders and the one-shot
 * progress adapter. Purely non-persistent: these feed the CLI's JSON/text
 * output formatters from live daemon events; nothing here journals, replays,
 * or serves normal UI rendering (the session view owns that).
 */
import type { KodaXEvents, KodaXOptions } from '@kodax-ai/coding';
import type { KodaXRuntime, RuntimeEvent } from './sdk-runtime.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function forwardDaemonStreamEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
  toolInputs: Map<string, Record<string, unknown>>,
): boolean {
  const meta = payload.meta as Parameters<
    NonNullable<KodaXEvents['onTextDelta']>
  >[1];
  if (event.type === 'assistant.delta' && typeof payload.text === 'string') {
    events?.onTextDelta?.(payload.text, meta);
  } else if (
    event.type === 'thinking.delta' &&
    typeof payload.text === 'string'
  ) {
    events?.onThinkingDelta?.(payload.text, meta);
  } else if (
    event.type === 'thinking.finished' &&
    typeof payload.thinking === 'string'
  ) {
    events?.onThinkingEnd?.(payload.thinking, meta);
  } else if (event.type === 'tool.started' && isRecord(payload.tool)) {
    const tool = payload.tool as Parameters<
      NonNullable<KodaXEvents['onToolUseStart']>
    >[0];
    if (typeof tool.id === 'string' && isRecord(tool.input))
      toolInputs.set(tool.id, tool.input);
    events?.onToolUseStart?.(
      tool,
      payload.meta as Parameters<NonNullable<KodaXEvents['onToolUseStart']>>[1],
    );
  } else if (event.type === 'tool.progress') {
    forwardDaemonToolProgress(events, payload);
  } else if (event.type === 'tool.sandbox' && isRecord(payload.update)) {
    events?.onToolSandboxObservation?.(
      payload.update as Parameters<
        NonNullable<KodaXEvents['onToolSandboxObservation']>
      >[0],
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onToolSandboxObservation']>
      >[1],
    );
  } else if (event.type === 'tool.finished' && isRecord(payload.result)) {
    const result = payload.result as Parameters<
      NonNullable<KodaXEvents['onToolResult']>
    >[0];
    if (typeof result.id === 'string') toolInputs.delete(result.id);
    events?.onToolResult?.(
      result,
      payload.meta as Parameters<NonNullable<KodaXEvents['onToolResult']>>[1],
    );
  } else {
    return false;
  }
  return true;
}

function forwardDaemonToolProgress(
  events: KodaXOptions['events'],
  payload: Record<string, unknown>,
): void {
  if (isRecord(payload.update)) {
    events?.onToolProgress?.(
      payload.update as Parameters<
        NonNullable<KodaXEvents['onToolProgress']>
      >[0],
      payload.meta as Parameters<NonNullable<KodaXEvents['onToolProgress']>>[1],
    );
  } else if (
    typeof payload.toolName === 'string' &&
    typeof payload.partialJson === 'string'
  ) {
    events?.onToolInputDelta?.(
      payload.toolName,
      payload.partialJson,
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onToolInputDelta']>
      >[2],
    );
  }
}

function forwardDaemonLifecycleEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
): boolean {
  if (event.type === 'session.loaded') {
    events?.onSessionStart?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onSessionStart']>
      >[0],
    );
  } else if (event.type === 'turn.started') {
    events?.onTurnStarted?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onTurnStarted']>
      >[0],
    );
  } else if (event.type === 'turn.completed') {
    events?.onTurnCompleted?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onTurnCompleted']>
      >[0],
    );
  } else if (event.type === 'turn.failed') {
    events?.onTurnFailed?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onTurnFailed']>
      >[0],
    );
  } else if (event.type === 'run.progress') {
    forwardDaemonRunProgress(events, payload);
  } else if (event.type.startsWith('context.compaction.')) {
    forwardDaemonCompactionEvent(events, event, payload);
  } else if (event.type === 'child_activity.finished') {
    events?.onChildActivityEnd?.(
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onChildActivityEnd']>
      >[0],
    );
  } else {
    return false;
  }
  return true;
}

function forwardDaemonRunProgress(
  events: KodaXOptions['events'],
  payload: Record<string, unknown>,
): void {
  if (payload.kind === 'stream_end') {
    events?.onStreamEnd?.(
      payload.meta as Parameters<NonNullable<KodaXEvents['onStreamEnd']>>[0],
    );
  } else if (
    payload.kind === 'iteration_start' &&
    typeof payload.iter === 'number' &&
    typeof payload.maxIter === 'number'
  ) {
    events?.onIterationStart?.(
      payload.iter,
      payload.maxIter,
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onIterationStart']>
      >[2],
    );
  } else if (payload.kind === 'iteration_end' && isRecord(payload.info)) {
    events?.onIterationEnd?.(
      payload.info as Parameters<NonNullable<KodaXEvents['onIterationEnd']>>[0],
    );
  } else if (
    payload.kind === 'mid_turn_user_messages' &&
    Array.isArray(payload.contents)
  ) {
    events?.onMidTurnUserMessages?.(
      payload.contents.filter(
        (item): item is string => typeof item === 'string',
      ),
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onMidTurnUserMessages']>
      >[1],
    );
  } else if (
    payload.kind === 'managed_task_status' &&
    isRecord(payload.status)
  ) {
    events?.onManagedTaskStatus?.(
      payload.status as unknown as Parameters<
        NonNullable<KodaXEvents['onManagedTaskStatus']>
      >[0],
    );
  } else if (payload.kind === 'complete') {
    events?.onComplete?.(
      payload.meta as Parameters<NonNullable<KodaXEvents['onComplete']>>[0],
    );
  }
}

export function forwardDaemonCompactionEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
): void {
  const meta = payload.meta as Parameters<
    NonNullable<KodaXEvents['onCompactStart']>
  >[0];
  if (event.type === 'context.compaction.started') {
    events?.onCompactStart?.(meta);
  } else if (
    event.type === 'context.compaction.finished' &&
    typeof payload.tokensAfter === 'number'
  ) {
    if (payload.committed === true) {
      events?.onCompact?.(payload.tokensAfter, meta);
    }
    events?.onContextCompactionFinished?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onContextCompactionFinished']>
      >[0],
    );
  } else if (event.type === 'context.compaction.stats') {
    events?.onCompactStats?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onCompactStats']>
      >[0],
    );
  } else if (event.type === 'context.compaction.ended') {
    const { meta: _meta, ...result } = payload;
    events?.onCompactEnd?.(
      meta,
      (typeof result.outcome === 'string'
        ? result
        : undefined) as Parameters<
          NonNullable<KodaXEvents['onCompactEnd']>
        >[1],
    );
  } else if (event.type === 'context.compaction.skipped') {
    events?.onContextCompactionSkipped?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onContextCompactionSkipped']>
      >[0],
    );
  }
}

function forwardDaemonDiagnosticEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
): void {
  if (event.type === 'provider.retry') {
    forwardDaemonRetryEvent(events, payload);
  } else if (event.type === 'provider.recovery') {
    forwardDaemonRecoveryEvent(events, payload);
  } else if (event.type === 'repo_intelligence.trace') {
    events?.onRepoIntelligenceTrace?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onRepoIntelligenceTrace']>
      >[0],
    );
  } else if (event.type === 'context.budget.snapshot') {
    events?.onContextBudgetSnapshot?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onContextBudgetSnapshot']>
      >[0],
    );
  } else if (event.type === 'provider.cache.diagnostics') {
    events?.onPromptCacheDiagnostics?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onPromptCacheDiagnostics']>
      >[0],
    );
  } else if (event.type === 'tool.exposure.planned') {
    events?.onToolExposurePlanned?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onToolExposurePlanned']>
      >[0],
    );
  } else if (event.type === 'sidecar.message') {
    events?.onSidecarMessage?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onSidecarMessage']>
      >[0],
    );
  } else if (event.type === 'todo.updated' && Array.isArray(payload.items)) {
    events?.onTodoUpdate?.(
      payload.items as Parameters<NonNullable<KodaXEvents['onTodoUpdate']>>[0],
      payload.meta as Parameters<NonNullable<KodaXEvents['onTodoUpdate']>>[1],
    );
  } else if (event.type === 'todo.warning') {
    events?.onTodoDriftWarning?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onTodoDriftWarning']>
      >[0],
    );
  } else if (event.type === 'config.effective') {
    events?.onEffectiveConfig?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onEffectiveConfig']>
      >[0],
    );
  } else if (event.type.startsWith('workflow.')) {
    events?.onWorkflowProcessEvent?.(
      event.payload as Parameters<
        NonNullable<KodaXEvents['onWorkflowProcessEvent']>
      >[0],
    );
  } else if (
    event.type === 'runtime.warning' &&
    typeof payload.message === 'string'
  ) {
    events?.onError?.(new Error(payload.message));
  }
}

function forwardDaemonRetryEvent(
  events: KodaXOptions['events'],
  payload: Record<string, unknown>,
): void {
  if (isRecord(payload.retryAfter)) {
    events?.onRetryAfter?.(
      payload.retryAfter as Parameters<
        NonNullable<KodaXEvents['onRetryAfter']>
      >[0],
      payload.meta as Parameters<NonNullable<KodaXEvents['onRetryAfter']>>[1],
    );
  } else if (
    payload.reason === 'rate_limit' &&
    typeof payload.attempt === 'number' &&
    typeof payload.maxAttempts === 'number' &&
    typeof payload.delayMs === 'number'
  ) {
    events?.onProviderRateLimit?.(
      payload.attempt,
      payload.maxAttempts,
      payload.delayMs,
    );
  } else if (
    typeof payload.reason === 'string' &&
    typeof payload.attempt === 'number' &&
    typeof payload.maxAttempts === 'number'
  ) {
    events?.onRetry?.(payload.reason, payload.attempt, payload.maxAttempts);
  }
}

function forwardDaemonRecoveryEvent(
  events: KodaXOptions['events'],
  payload: Record<string, unknown>,
): void {
  if (payload.kind === 'reasoning_effort_rejected' && isRecord(payload.event)) {
    events?.onReasoningEffortRejected?.(
      payload.event as Parameters<
        NonNullable<KodaXEvents['onReasoningEffortRejected']>
      >[0],
    );
  } else if (isRecord(payload.event)) {
    events?.onProviderRecovery?.(
      payload.event as unknown as Parameters<
        NonNullable<KodaXEvents['onProviderRecovery']>
      >[0],
      payload.meta as Parameters<
        NonNullable<KodaXEvents['onProviderRecovery']>
      >[1],
    );
  }
}

export interface RunProgressAdapter {
  /** Begin forwarding; events for other runs buffered before this are dropped. */
  setRunId(runId: string): void;
  close(): void;
}

/** Stream → lifecycle → diagnostic; one pass over a single runtime event. */
export function forwardRunProgressEvent(
  events: KodaXOptions['events'],
  event: RuntimeEvent,
  payload: Record<string, unknown>,
  toolInputs: Map<string, Record<string, unknown>>,
): void {
  if (forwardDaemonStreamEvent(events, event, payload, toolInputs)) return;
  if (forwardDaemonLifecycleEvent(events, event, payload)) return;
  forwardDaemonDiagnosticEvent(events, event, payload);
}

/**
 * Forward one run's live runtime events into the CLI output formatters.
 * Permission requests are deliberately not handled: one-shot runs use the
 * runtime permission broker, so there is no client answer to give.
 */
export function attachRunProgressAdapter(
  runtime: KodaXRuntime,
  input: {
    readonly sessionId: string;
    readonly events: KodaXOptions['events'];
  },
): RunProgressAdapter {
  const toolInputs = new Map<string, Record<string, unknown>>();
  let activeRunId: string | undefined;
  const buffered: RuntimeEvent[] = [];
  const dispatch = (event: RuntimeEvent): void => {
    const payload = isRecord(event.payload) ? event.payload : {};
    forwardRunProgressEvent(input.events, event, payload, toolInputs);
  };
  const subscription = runtime.events.subscribe(
    { sessionId: input.sessionId },
    (event) => {
      if (activeRunId === undefined) {
        buffered.push(event);
      } else if (event.runId === activeRunId) {
        dispatch(event);
      }
    },
  );
  return {
    setRunId(runId) {
      activeRunId = runId;
      for (const event of buffered.splice(0)) {
        if (event.runId === runId) dispatch(event);
      }
    },
    close() {
      subscription.close();
    },
  };
}
