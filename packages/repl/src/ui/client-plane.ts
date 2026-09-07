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
  ClientInteractionResponse,
  ClientItemContent,
  ClientPermissionInteractionOptions,
  ClientRunStopReceipt,
  ClientSessionView,
  ClientViewItem,
} from '@kodax-ai/coding/client-contract';
import {
  CANCELLED_TOOL_RESULT_MESSAGE,
  type AskUserAnswer,
  type AskUserMultiOptions,
  type AskUserQuestionOptions,
  type KodaXResult,
} from '@kodax-ai/coding';
import { resolveReplRuntimePermissionDecision } from '../runtime-permission.js';
import type { ConfirmResult } from '../permission/types.js';
import type { HistoryItem, ToolCall, ToolCallStatus } from './types.js';
import { ToolCallStatus as RenderToolStatus } from './types.js';

/** Terminal projection of one client round; `result` is the legacy shape Ink's loop expects. */
export interface ClientRoundOutcome {
  readonly phase: string;
  readonly result?: KodaXResult;
  readonly error?: string;
}

export interface InkClientPlane {
  /** Submit user text; immediate delivery starts the run (runId when known). */
  submit(input: {
    readonly sessionId: string;
    readonly text: string;
    readonly inputId: string;
  }): Promise<{ readonly runId?: string }>;
  /** Withdraw a queued input; returns the original text when this caller owned it. */
  withdraw(sessionId: string, inputId: string): Promise<string | undefined>;
  /** Resolve when the run reaches a terminal phase. */
  awaitRun(sessionId: string, runId: string): Promise<ClientRoundOutcome>;
  /** Request a stop for one run (Esc); the receipt never implies terminal state. */
  stop(runId: string): Promise<ClientRunStopReceipt | undefined>;
  /** Live current-state replacement; resolves with the closer. */
  observe(
    sessionId: string,
    onView: (view: ClientSessionView) => void,
  ): Promise<() => void>;
  /** Page the complete content of a bounded view item by stable id. */
  readItem(
    sessionId: string,
    itemId: string,
    offset?: number,
  ): Promise<ClientItemContent | null>;
  /** Answer a pending Host question/permission; first valid answer wins. */
  respondInteraction(
    requestId: string,
    response: ClientInteractionResponse,
  ): Promise<boolean>;
}

type ViewToolStatus = NonNullable<ClientViewItem['tool']>['status'];

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

/**
 * FEATURE_298 T17 — run one round over the client plane: submit the input,
 * keep the Esc abort translated into a Host stop request, and project the
 * terminal run result back into the legacy shape the Ink loop expects.
 */
export async function runClientPlaneRound(input: {
  readonly plane: InkClientPlane;
  readonly sessionId: string;
  readonly prompt: string;
  readonly abortSignal?: AbortSignal;
}): Promise<KodaXResult> {
  const inputId = `ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const accepted = await input.plane.submit({
    sessionId: input.sessionId,
    text: input.prompt,
    inputId,
  });
  if (accepted.runId === undefined) {
    throw new Error(
      'The Host queued the input instead of starting the run; retry when the session is idle.',
    );
  }
  const runId = accepted.runId;
  let stopRequested = false;
  const stop = (): void => {
    stopRequested = true;
    void input.plane.stop(runId).catch(() => undefined);
  };
  input.abortSignal?.addEventListener('abort', stop, { once: true });
  try {
    const outcome = await input.plane.awaitRun(input.sessionId, runId);
    if (outcome.result !== undefined) return outcome.result;
    if (INTERRUPTED_RUN_PHASES.has(outcome.phase)) {
      return interruptedPlaneResult(input.sessionId);
    }
    throw new Error(outcome.error ?? `Run ${runId} ended in phase '${outcome.phase}' without a result.`);
  } finally {
    input.abortSignal?.removeEventListener('abort', stop);
    void stopRequested;
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

/** Active run id from the view's run list, or undefined when idle. */
export function viewRunsActive(
  view: Pick<ClientSessionView, 'runs'>,
): string | undefined {
  for (const run of view.runs) {
    if (LIVE_RUN_PHASES.has(run.phase)) return run.runId;
  }
  return undefined;
}

/** Map the Host's display items onto the Ink render model (types align by design). */
export function clientViewToHistoryItems(
  items: readonly ClientViewItem[],
  options: { readonly activeRunId?: string } = {},
): HistoryItem[] {
  return items.map((item) => {
    const base = {
      id: item.id,
      timestamp: item.timestamp ?? 0,
      isSessionUiOnly: true,
    };
    if (item.type === 'tool' && item.tool) {
      const tool: ToolCall = {
        id: item.tool.callId,
        name: item.tool.name,
        status: TOOL_STATUS_MAP[item.tool.status],
        ...(item.tool.inputText !== undefined ? { preview: item.tool.inputText } : {}),
        ...(item.text.length > 0 ? { output: item.text } : {}),
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
        ...(options.activeRunId !== undefined ? { isStreaming: true } : {}),
      };
    }
    const textKind = item.type as Exclude<
      ClientViewItem['type'],
      'tool' | 'assistant'
    >;
    const common = {
      ...base,
      type: textKind,
      text: item.text,
      ...(item.compactText !== undefined ? { compactText: item.compactText } : {}),
      ...(item.icon !== undefined ? { icon: item.icon } : {}),
    };
    if (item.type === 'event' || item.type === 'info') return common;
    if (item.type === 'hint') return common;
    if (item.type === 'sidecar') return common;
    return common;
  });
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
  return plane.respondInteraction(interaction.requestId, response);
}
