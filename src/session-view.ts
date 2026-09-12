import { createHash, randomUUID } from 'node:crypto';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { redactScopedProviderCredential } from '@kodax-ai/llm';
import type { KodaXMessage, KodaXSessionUiHistoryItem, KodaXSessionData } from '@kodax-ai/agent';
import { createOutputSegmentProjection, reduceOutputSegmentProjection } from '@kodax-ai/coding';
import type { KodaXEvents, KodaXOutputSegmentProjection, KodaXActivityEventMeta } from '@kodax-ai/coding';
import { createRetryHistoryItem, buildManagedLiveEventDrafts, restoreHistoryItemsFromSession,
  childActivityId, childActivityLabel, childActivitySource, truncateChildActivityDetail, suppressesChurnOverToolAction,
  toolActivityDetail, formatManagedTaskBreadcrumb } from '@kodax-ai/repl';
import type { ClientObservation, ClientObserveOptions, ClientObservationStatus, ClientContextBudget, ClientSessionView, ClientSessionActivity, ClientViewItem, ClientItemReadOptions, ClientItemContent } from '@kodax-ai/coding/client-contract';
import { createSessionNoticeEvents } from './session-view-notices.js';

interface ObservedSession {
  view?: ClientSessionView;
  loading?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  dirty: boolean;
  historyDirty: boolean;
  generation: number;
  readonly listeners: Map<(view: ClientSessionView) => void, (status: ClientObservationStatus) => void>;
  items: ClientViewItem[];
  readonly segments: Map<string, KodaXOutputSegmentProjection>;
  history: readonly ClientViewItem[];
  readonly runIds: Set<string>;
  persistRequested: boolean;
  persisting?: Promise<void>;
  activity?: ClientSessionActivity;
  costReport?: NonNullable<KodaXEvents['getCostReport']>;
}

/** The current display, coalesced at the REPL's existing 80 ms cadence. */
export class SessionViewOwner {
  private readonly sessions = new Map<string, ObservedSession>();

  constructor(
    private readonly read: (sessionId: string, includeHistory: boolean, previous: ClientSessionView | undefined,
      liveItems: readonly ClientViewItem[]) => Promise<ClientSessionView>,
    private readonly save: (sessionId: string, runIds: readonly string[], items: readonly ClientViewItem[]) => Promise<void>,
  ) {}

  private state(sessionId: string): ObservedSession {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { dirty: true, historyDirty: true, generation: 0, listeners: new Map(), items: [], history: [], segments: new Map(), runIds: new Set(), persistRequested: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  events(sessionId: string, runId: string, costReport: NonNullable<KodaXEvents['getCostReport']> = { current: null }, inputSource?: () => string | undefined): KodaXEvents {
    const state = this.state(sessionId);
    state.costReport = costReport;
    state.runIds.add(runId);
    let segmentInputId: string | undefined;
    const isPrimary = (meta?: KodaXActivityEventMeta) =>
      meta?.contextKind !== 'child' && !meta?.childAgentId
      && !meta?.workflowCorrelation?.workflowRunId && !meta?.workflowCorrelation?.childAgentId;
    const upsert = (item: ClientViewItem, source?: { inputId: string | undefined }): void => {
      // Capture safe display facts while the exact credential scope is active;
      // the later coalesced view/checkpoint runs after that scope may expire.
      const index = state.items.findIndex((current) => current.id === item.id);
      const afterInputId = index >= 0 ? state.items[index]!.afterInputId : source ? source.inputId : inputSource?.();
      item = redactScopedProviderCredential({ ...item, afterInputId });
      if (index < 0) state.items.push(item);
      else state.items[index] = { ...item, timestamp: state.items[index]!.timestamp };
      this.changed(sessionId);
    };
    const delta = (kind: 'assistant' | 'thinking', text: string, meta?: KodaXActivityEventMeta): void => {
      if (!isPrimary(meta)) { childActivity(kind, text, meta); return; }
      if (!meta?.providerRequestId) return;
      const current = state.segments.get(runId) ?? createOutputSegmentProjection();
      const reduced = reduceOutputSegmentProjection(current, { type: `${kind}.delta`, providerRequestId: meta.providerRequestId, text });
      if (!reduced.accepted || !reduced.state.active) return;
      state.segments.set(runId, reduced.state);
      upsert({ id: `${runId}:${meta.providerRequestId}:${kind}`, type: kind,
        text: reduced.state.active[kind === 'assistant' ? 'assistantText' : 'thinkingText'], timestamp: Date.now() }, { inputId: segmentInputId });
    };
    const notices = createSessionNoticeEvents(sessionId, (notice) => {
        upsert({ ...notice, id: `${runId}:${notice.id ?? randomUUID()}`, timestamp: Date.now() });
        this.checkpoint(sessionId);
      });
    const activity = (update: Omit<Partial<ClientSessionActivity>, 'runId'>): void => {
      state.activity = { ...(state.activity?.runId === runId ? state.activity : {}), runId, ...redactScopedProviderCredential(update) };
      this.changed(sessionId);
    };
    const childActivity = createChildActivityUpdater(activity);
    return {
      getCostReport: costReport,
      ...notices,
      ...sessionActivityEvents(activity, notices),
      onOutputSegmentStart: (segment, meta) => {
        if (!isPrimary(meta)) return;
        const current = state.segments.get(runId) ?? createOutputSegmentProjection();
        if (current.active?.providerRequestId !== segment.providerRequestId) segmentInputId = inputSource?.();
        if (segment.mode === 'replace' && current.active?.responseId === segment.responseId
          && current.active.providerRequestId !== segment.providerRequestId) {
          const replaced = `${runId}:${current.active.providerRequestId}:`;
          const retain = (item: ClientViewItem) => item.id !== `${replaced}assistant` && item.id !== `${replaced}thinking`;
          state.items = state.items.filter(retain);
          state.history = state.history.filter(retain);
          state.generation += 1;
          state.historyDirty = true;
          this.checkpoint(sessionId);
        }
        state.segments.set(runId, reduceOutputSegmentProjection(current, { type: 'segment.started', ...segment }).state);
        this.changed(sessionId);
      },
      onTextDelta: (text, meta) => delta('assistant', text, meta),
      onThinkingDelta: (text, meta) => delta('thinking', text, meta),
      onThinkingEnd: (text, meta) => {
        if (!isPrimary(meta)) return;
        const current = state.segments.get(runId);
        if (!current?.active || (meta?.providerRequestId && current.active.providerRequestId !== meta.providerRequestId)) return;
        state.segments.set(runId, { ...current, active: { ...current.active, thinkingText: text } });
        upsert({ id: `${runId}:${current.active.providerRequestId}:thinking`, type: 'thinking', text, timestamp: Date.now() }, { inputId: segmentInputId });
      },
      onToolUseStart: (tool, meta) => {
        if (!isPrimary(meta)) { childActivity('tool', toolActivityDetail(tool.name, tool.input), meta); return; }
        const timestamp = Date.now();
        upsert({ id: `${runId}:tool:${tool.id}`, type: 'tool', text: '', timestamp,
          tool: { callId: tool.id, name: tool.name, status: 'running', startedAt: timestamp,
            ...(tool.input ? { inputText: JSON.stringify(tool.input) } : {}) } });
      },
      onToolProgress: (update, meta) => {
        if (!isPrimary(meta)) return;
        const item = state.items.find((item) => item.id === `${runId}:tool:${update.id}`);
        if (item?.tool) upsert({ ...item, tool: { ...item.tool, progress: update.message } });
      },
      onToolResult: (result, meta) => {
        if (!isPrimary(meta)) return;
        const previous = state.items.find((item) => item.id === `${runId}:tool:${result.id}`);
        const status = result.toolResult?.metadata?.cancelled === true ? 'cancelled'
          : result.toolResult ? (result.toolResult.is_error === true ? 'error' : 'success')
          : /^\[(?:Tool Error|Error)\]/.test(result.content) ? 'error'
          : /^\[(?:Cancelled|Blocked)\]/.test(result.content) ? 'cancelled' : 'success';
        upsert({ id: `${runId}:tool:${result.id}`, type: 'tool', text: result.content, timestamp: Date.now(),
          tool: { ...previous?.tool, callId: result.id, name: result.name, status, endedAt: Date.now(), progress: undefined } });
        this.checkpoint(sessionId);
      },
      onSidecarMessage: (event) => {
        upsert({ id: `${runId}:sidecar:${randomUUID()}`, type: 'sidecar', timestamp: Date.now(),
          text: event.suggestedFix ? `${event.content}\nSuggested fix: ${event.suggestedFix}` : event.content,
          icon: event.delivery === 'budget-exhausted' ? 'budget-exhausted' : event.verdict });
        this.checkpoint(sessionId);
      },
      onManagedTaskStatus: (status) => {
        activity({ managedTask: { phase: status.phase, workerId: status.activeWorkerId, workerTitle: status.activeWorkerTitle,
          harnessProfile: status.harnessProfile, globalWorkBudget: status.globalWorkBudget,
          budgetUsage: status.budgetUsage, budgetApprovalRequired: status.budgetApprovalRequired,
          breadcrumb: formatManagedTaskBreadcrumb(status), expandedBreadcrumb: formatManagedTaskBreadcrumb(status, { expanded: true }),
          round: status.currentRound, maximumRounds: status.maxRounds, idleWaiting: status.idleWaiting === true,
          pendingChildren: status.idleWaitingPendingCount, fanoutCount: status.childFanoutCount } });
        for (const draft of buildManagedLiveEventDrafts(status)) {
          // Temporary managed progress belongs to activity, as in the original
          // REPL. Only explicit retained events belong to conversation history.
          if (!draft.persistToHistory) continue;
          const item = draft.item;
          if (item.type === 'tool_group') continue;
          const id = `${runId}:${item.id}`;
          upsert({ id, type: item.type, text: item.text, timestamp: item.timestamp,
            ...('icon' in item ? { icon: item.icon } : {}), ...('compactText' in item ? { compactText: item.compactText } : {}) });
        }
        this.changed(sessionId);
        this.checkpoint(sessionId);
      },
      onRetry: (reason, attempt, maxAttempts, meta) => {
        if (!isPrimary(meta)) return;
        upsert({ ...createRetryHistoryItem(reason, attempt, maxAttempts), id: `${runId}:retry:${randomUUID()}`, timestamp: Date.now() });
        this.checkpoint(sessionId);
      },
      onChildActivityEnd: (meta) => { childActivity('stream', '', meta, true); },
    };
  }

  checkpoint(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.runIds.size === 0) return;
    state.persistRequested = true;
    if (state.persisting) return;
    state.persisting = Promise.resolve().then(async () => {
      while (state.persistRequested) {
        state.persistRequested = false;
        await this.save(sessionId, [...state.runIds], state.items);
      }
    }).finally(() => { state.persisting = undefined; });
    void state.persisting.catch((error: unknown) => {
      emitKodaXDiagnostic({ source: 'session.view', level: 'error', message: 'Unable to persist Session display history.', detail: error });
    });
  }

  changed(sessionId: string, historyChanged = false): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.dirty = true;
    state.historyDirty ||= historyChanged;
    if (state.timer || state.loading || state.listeners.size === 0) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.refresh(sessionId, state).catch((error: unknown) => {
        emitKodaXDiagnostic({ source: 'session.view', level: 'error', message: 'Unable to refresh the current Session view.', detail: error });
      });
    }, 80);
    state.timer.unref();
  }

  configurationChanged(): void {
    for (const sessionId of this.sessions.keys()) this.changed(sessionId);
  }

  /** Branch changes discard the old live projection, retaining observers. */
  resetHistory(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.generation += 1;
    state.items = [];
    state.history = [];
    state.segments.clear();
    state.runIds.clear();
    state.activity = undefined;
    state.costReport = undefined;
    state.view = undefined;
    this.changed(sessionId, true);
  }

  async observe(sessionId: string, listener: (view: ClientSessionView) => void, options: ClientObserveOptions = {}): Promise<ClientObservation> {
    const state = this.state(sessionId);
    await this.refresh(sessionId, state);
    if (!state.view) throw new Error('Session view was not available.');
    // No await separates registering from capturing the latest state.
    listener(structuredClone(state.view));
    let lastState: ClientObservationStatus['state'] | undefined;
    const report = (status: ClientObservationStatus): void => {
      if (lastState === status.state) return;
      lastState = status.state;
      try { options.onStatus?.(status); }
      catch (error: unknown) {
        emitKodaXDiagnostic({ source: 'session.view', level: 'warn', message: 'Session observation status listener failed.', detail: error });
      }
    };
    state.listeners.set(listener, report);
    report({ state: 'live' });
    if (state.dirty) this.changed(sessionId);
    return { close: () => {
      if (state.listeners.delete(listener)) report({ state: 'closed', reason: 'client' });
    } };
  }

  async readItem(sessionId: string, itemId: string, options: ClientItemReadOptions = {}): Promise<ClientItemContent | null> {
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Item offset must be a non-negative integer.');
    const state = this.state(sessionId);
    if (!state.view || state.historyDirty) await this.refresh(sessionId, state);
    const item = state.items.find((item) => item.id === itemId) ?? state.history.find((item) => item.id === itemId);
    if (!item) return null;
    const content = options.part === 'input' ? item.tool?.inputText ?? '' : item.text;
    const text = content.slice(offset, offset + 64 * 1024);
    const nextOffset = offset + text.length;
    return { id: item.id, text, offset, totalLength: content.length, ...(nextOffset < content.length ? { nextOffset } : {}) };
  }

  async close(): Promise<void> {
    const checkpoints = await Promise.allSettled([...this.sessions.values()].map((state) => state.persisting));
    for (const state of this.sessions.values()) {
      if (state.timer) clearTimeout(state.timer);
      for (const report of state.listeners.values()) report({ state: 'closed', reason: 'unavailable' });
      state.listeners.clear();
    }
    this.sessions.clear();
    const failures = checkpoints.filter(result => result.status === 'rejected').map(result => result.reason as unknown);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Session display checkpoints failed during close.');
  }

  async flush(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    while (state?.persisting) await state.persisting;
  }

  release(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state?.timer) clearTimeout(state.timer);
    if (state) for (const report of state.listeners.values()) report({ state: 'closed', reason: 'unavailable' });
    state?.listeners.clear();
    this.sessions.delete(sessionId);
  }

  private refresh(sessionId: string, state: ObservedSession): Promise<void> {
    if (state.loading) return state.loading;
    state.dirty = false;
    const includeHistory = state.view === undefined || state.historyDirty;
    state.historyDirty = false;
    const generation = state.generation;
    const read = () => this.read(sessionId, includeHistory, state.view, state.items);
    // A replacement checkpoint retires prior output on disk. A fresh history
    // read must wait for that write, just as an invalidated read does below.
    const pendingRead = includeHistory && state.persisting ? this.flush(sessionId).then(read) : read();
    const loading = pendingRead.then((view) => {
      if (generation !== state.generation) return;
      if (includeHistory) state.history = view.items;
      const items = mergeSessionViewItems(state.history, state.items);
      const costReport = state.costReport?.current?.();
      state.view = { ...view, ...(state.activity ? { activity: { ...state.activity, ...(costReport ? { costReport } : {}) } } : {}), items: boundedViewItems(items) };
      for (const [listener, report] of state.listeners) {
        try { listener(structuredClone(state.view)); report({ state: 'live' }); }
        catch (error: unknown) {
          state.listeners.delete(listener);
          report({ state: 'closed', reason: 'unavailable' });
          emitKodaXDiagnostic({ source: 'session.view', level: 'warn', message: 'Session view observer failed and was detached.', detail: error });
        }
      }
    }).catch((error: unknown) => {
      state.historyDirty ||= includeHistory;
      for (const report of state.listeners.values()) report({ state: 'interrupted' });
      throw error;
    }).finally(() => {
      state.loading = undefined;
      if (state.dirty && generation === state.generation) this.changed(sessionId);
    }).then(async () => {
      if (generation !== state.generation) {
        await this.flush(sessionId);
        return this.refresh(sessionId, state);
      }
    });
    state.loading = loading;
    return loading;
  }
}

function mergeSessionViewItems(history: readonly ClientViewItem[], live: readonly ClientViewItem[]): ClientViewItem[] {
  const items = [...history];
  let nextPosition = items.length;
  // Canonical entries own their positions. Unsaved text keeps its live order
  // relative to the next saved tool/notice, or follows history when none exists.
  for (const item of [...live].reverse()) {
    const position = items.findIndex(candidate => candidate.id === item.id);
    if (position >= 0) {
      items[position] = item;
      nextPosition = position;
    } else {
      const sourceIndex = item.afterInputId === undefined ? -1
        : items.findIndex(candidate => candidate.type === 'user' && candidate.inputId === item.afterInputId);
      if (sourceIndex >= 0) {
        const nextInput = items.findIndex((candidate, index) => index > sourceIndex && candidate.type === 'user');
        nextPosition = Math.min(Math.max(nextPosition, sourceIndex + 1), nextInput < 0 ? items.length : nextInput);
      }
      items.splice(nextPosition, 0, item);
    }
  }
  return items;
}

function createChildActivityUpdater(update: (patch: Omit<Partial<ClientSessionActivity>, 'runId'>) => void) {
  type Child = NonNullable<ClientSessionActivity['children']>[number];
  const children = new Map<string, Child>();
  return (kind: Child['kind'], text: string, meta?: KodaXActivityEventMeta, completed = false): void => {
    if (!meta) return;
    const id = childActivityId(meta);
    const previous = children.get(id);
    if (!completed && suppressesChurnOverToolAction(previous?.kind, kind)) return;
    if (completed) children.delete(id);
    else children.set(id, redactScopedProviderCredential({ id, kind, label: childActivityLabel(meta), source: childActivitySource(meta),
      detail: truncateChildActivityDetail(text), startedAt: previous?.startedAt ?? Date.now(), status: 'running' as const }));
    update({ children: [...children.values()] });
  };
}

function sessionActivityEvents(
  update: (patch: Omit<Partial<ClientSessionActivity>, 'runId'>) => void,
  notices: KodaXEvents,
): KodaXEvents {
  let contextBudget: ClientContextBudget | undefined;
  return {
    onContextBudgetSnapshot: (info) => {
      if (!info.compactionBudget || !info.provider || !info.model) return;
      const scope = info.contextKind === 'child' ? 'worker' : 'parent';
      const { reservedResponseTokens, reservedMemoryTokens, ...compaction } = info.compactionBudget;
      contextBudget = { scope, provider: info.provider, model: info.model, contextId: info.contextId,
        contextWindow: info.contextWindow, reservedResponseTokens, reservedMemoryTokens,
        compaction: { enabled: true, ...compaction } };
      update({ contextBudget,
        context: { scope, tokenCount: info.usedTokens - info.tokenBreakdown.reservedResponse, tokenSource: 'estimate' } });
    },
    onTodoUpdate: (items) => update({ todos: items.map(({ id, subject, status, description, owner, note, activeForm }) =>
      ({ id, subject, status, description, owner, note, activeForm })) }),
    onIterationStart: (current, maximum) => update({ iteration: { current, maximum } }),
    onIterationEnd: (info) => {
      const scope = info.contextKind === 'child' || info.scope === 'worker' ? 'worker' : 'parent';
      if (contextBudget?.scope !== scope || (info.contextId !== undefined && contextBudget.contextId !== info.contextId)) contextBudget = undefined;
      update({
        contextBudget,
        iteration: { current: info.iter, maximum: info.maxIter },
        context: { tokenCount: info.tokenCount, tokenSource: info.tokenSource, scope },
        ...(scope === 'parent' ? { parentContextTokens: info.tokenCount } : {}),
        ...(info.usage ? { usage: {
          inputTokens: info.usage.inputTokens, outputTokens: info.usage.outputTokens, totalTokens: info.usage.totalTokens,
          cacheReadTokens: info.usage.cachedReadTokens, cacheWriteTokens: info.usage.cachedWriteTokens,
          thoughtTokens: info.usage.thoughtTokens,
        } } : {}),
      });
    },
    onCompactStart: () => update({ compacting: true }),
    onCompactStats: (info) => {
      notices.onCompactStats?.(info);
      const scope = info.contextKind === 'child' ? 'worker' : 'parent';
      if (contextBudget?.scope !== scope || (info.contextId !== undefined && contextBudget.contextId !== info.contextId)) contextBudget = undefined;
      update({ contextBudget, context: { tokenCount: info.tokensAfter, tokenSource: 'estimate', scope },
        ...(scope === 'parent' ? { parentContextTokens: info.tokensAfter } : {}) });
    },
    onCompact: (tokens, meta) => { notices.onCompact?.(tokens, meta); update({ compacting: false }); },
    onCompactEnd: (meta, result) => { notices.onCompactEnd?.(meta, result); update({ compacting: false }); },
  };
}

function boundedViewItems(items: readonly ClientViewItem[]): ClientViewItem[] {
  // Bound the complete replacement, including escaped Unicode and tool inputs.
  // The original content stays in the Session owner for readItem/copy.
  const window = items.slice(-150);
  const previewSize = (text: string | undefined): number => Math.min(text?.length ?? 0, 256);
  // Reserve a readable preview for every retained field before giving the tail
  // the remaining capacity. Otherwise long outputs erase earlier query/body/input.
  let reserved = window.reduce((sum, item) => sum + previewSize(item.text) + previewSize(item.tool?.inputText), 0);
  let remaining = 128 * 1024;
  const result: ClientViewItem[] = [];
  for (const item of window.reverse()) {
    reserved -= previewSize(item.text);
    const count = Math.min(item.text.length, 8192, remaining - reserved);
    let offset = item.text.length - count;
    if (offset > 0 && /[\uDC00-\uDFFF]/u.test(item.text.charAt(offset))) offset += 1;
    const text = item.text.slice(offset);
    remaining -= text.length;
    const input = item.tool?.inputText;
    reserved -= previewSize(input);
    const inputText = input?.slice(0, Math.min(8192, remaining - reserved));
    remaining -= inputText?.length ?? 0;
    result.push({ ...item, text,
      ...(offset > 0 ? { textOffset: offset, totalTextLength: item.text.length } : {}),
      ...(item.tool ? { tool: { ...item.tool, inputText,
        ...(input !== undefined && inputText?.length !== input.length ? { totalInputLength: input.length } : {}) } } : {}) });
  }
  return result.reverse();
}

function restorePersistedViewItems(history: readonly KodaXSessionUiHistoryItem[] | undefined): ClientViewItem[] {
  return (history ?? []).flatMap((item, index): ClientViewItem[] => {
    if (item.type === 'tool_group') return item.tools.map((tool) => ({
      id: item.id ?? `tool:${tool.id}`, type: 'tool' as const, text: tool.output ?? tool.error ?? '', timestamp: item.timestamp,
      ...(item.afterInputId ? { afterInputId: item.afterInputId } : {}),
      tool: { callId: tool.id, name: tool.name, status: tool.status, inputText: tool.preview,
        startedAt: tool.startTime, endedAt: tool.endTime },
    }));
    return [{ id: item.id ?? `legacy:${index}:${item.timestamp ?? 0}`, type: item.type as ClientViewItem['type'],
      text: item.text, ...(item.inputId !== undefined ? { inputId: item.inputId } : {}),
      ...(item.afterInputId ? { afterInputId: item.afterInputId } : {}),
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
      ...(item.icon !== undefined ? { icon: item.icon } : {}), ...(item.compactText !== undefined ? { compactText: item.compactText } : {}) }];
  });
}

/**
 * The conversation messages are the canonical history source (they include
 * pre-compaction entries resolved from lineage); the storage tail is the
 * fallback when the conversation page is unavailable.
 */
export function restoreSessionViewItems(
  sessionId: string,
  data: KodaXSessionData | null | undefined,
  conversation?: readonly KodaXMessage[] | null,
  liveItems: readonly ClientViewItem[] = [],
): ClientViewItem[] {
  if (!data) return [];
  const historyMessages = conversation && conversation.length > 0 ? conversation : data.messages.slice(-30);
  const toolResults = new Map(historyMessages.flatMap(message => typeof message.content === 'string' ? []
    : message.content.filter(block => block.type === 'tool_result').map(block => [block.tool_use_id, block] as const)));
  const lastAssistant = [...historyMessages].reverse().find(message => message.role === 'assistant');
  const savedOutputTime = lastAssistant?.timestamp ? Date.parse(lastAssistant.timestamp) : NaN;
  // A live response can equal an earlier answer before it has been saved.
  // Only finalized output may lend its display identity to canonical history.
  const savedLiveItems = liveItems.filter(item => item.type !== 'assistant' && item.type !== 'thinking'
    || (item.timestamp !== undefined && item.timestamp <= savedOutputTime));
  // A canonical save can precede the display checkpoint. Reuse the current
  // display identities during reconciliation instead of showing both versions.
  const liveIds = new Set(liveItems.map(item => item.id));
  const uiHistory = [...(data.uiHistory ?? []).filter(item => !item.id || !liveIds.has(item.id)),
    ...persistSessionViewItems(savedLiveItems)];
  const persisted = restorePersistedViewItems(uiHistory);
  // Display-identity reconciliation is identity-first: an accepted input
  // joins its persisted display item by inputId only, so same-text inputs
  // can never borrow one identity. Legacy items without identity may
  // borrow a text/time lookalike, but each persisted item is lent at most
  // once — leftovers mint fresh derived identities.
  const consumed = new Set<ClientViewItem>();
  const persistedByInputId = new Map<string, ClientViewItem>();
  for (const candidate of persisted) {
    if (candidate.inputId !== undefined && !persistedByInputId.has(candidate.inputId)) {
      persistedByInputId.set(candidate.inputId, candidate);
    }
  }
  const findLegacyDisplayMatch = (item: { type: ClientViewItem['type']; text: string; timestamp?: number }): ClientViewItem | undefined => {
    for (const candidate of persisted) {
      if (consumed.has(candidate)) continue;
      if (candidate.type === item.type && candidate.text === item.text && candidate.timestamp === item.timestamp) {
        consumed.add(candidate);
        return candidate;
      }
    }
    return undefined;
  };
  const occurrences = new Map<string, number>();
  const restored = restoreHistoryItemsFromSession({ messages: historyMessages, uiHistory });
  const items = restored.flatMap((item): ClientViewItem[] => {
    if (item.type === 'tool_group') return item.tools.map((tool) => {
      const previous = persisted.find((candidate) => candidate.tool?.callId === tool.id);
      const result = toolResults.get(tool.id);
      // Older sessions encoded cancellation in text alongside is_error=true.
      const legacyCancellation = result?.metadata?.cancelled === undefined && result?.is_error !== false
        && typeof result?.content === 'string' && /^\[(?:Cancelled|Blocked)\]/.test(result.content);
      const status = result?.metadata?.cancelled === true || legacyCancellation ? 'cancelled'
        : result?.is_error !== undefined ? (result.is_error ? 'error' : 'success')
        : previous?.tool?.status ?? (tool.status === 'success' || tool.status === 'error' ? tool.status : 'cancelled');
      return previous ? { ...previous, tool: previous.tool ? { ...previous.tool, status } : undefined }
        : { id: `tool:${tool.id}`, type: 'tool', text: String(tool.output ?? tool.error ?? ''), timestamp: item.timestamp,
        tool: { callId: tool.id, name: tool.name,
          status,
          inputText: JSON.stringify(tool.input), startedAt: tool.startTime, endedAt: tool.endTime } };
    });
    let previous: ClientViewItem | undefined;
    if (item.inputId !== undefined) {
      const identified = persistedByInputId.get(item.inputId);
      if (identified !== undefined && !consumed.has(identified)) {
        consumed.add(identified);
        previous = identified;
      }
    } else {
      previous = findLegacyDisplayMatch(item);
    }
    if (previous) return [{ ...previous, ...(item.inputId !== undefined ? { inputId: item.inputId } : {}) }];
    const fingerprint = createHash('sha256').update(`${item.type}\0${item.text}\0${item.timestamp ?? ''}`).digest('hex');
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    return [{ id: `${sessionId}:history:${fingerprint}:${occurrence}`, type: item.type, text: item.text,
      ...(item.inputId !== undefined ? { inputId: item.inputId } : {}),
      ...('icon' in item ? { icon: item.icon } : {}), ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}) }];
  });
  for (const entry of data.lineage?.entries ?? []) {
    if (entry.type === 'client_notice') items.push({ id: entry.id, type: 'info', text: entry.content, timestamp: Date.parse(entry.timestamp) });
  }
  return items.slice(-150);
}

export function persistSessionViewItems(items: readonly ClientViewItem[]): KodaXSessionUiHistoryItem[] {
  return items.flatMap((item): KodaXSessionUiHistoryItem[] => {
    if (item.type !== 'tool') return [{ ...item, type: item.type, presentationOnly: true }];
    if (!item.tool) return [];
    return [{ id: item.id, type: 'tool_group', timestamp: item.timestamp, afterInputId: item.afterInputId, tools: [{
      id: item.tool.callId, name: item.tool.name, status: item.tool.status === 'running' ? 'cancelled' : item.tool.status,
      output: item.text, preview: item.tool.inputText, startTime: item.tool.startedAt, endTime: item.tool.endedAt,
    }] }];
  });
}
