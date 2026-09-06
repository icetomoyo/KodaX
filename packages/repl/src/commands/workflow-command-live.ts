import chalk from 'chalk';
import {
  isFinalWorkflowProcessStatus,
  type WorkflowEvent,
  type WorkflowMeta,
  type WorkflowProcessEvent,
  type WorkflowProcessSnapshot,
  type WorkflowProcessSource,
  type WorkflowRunState,
} from '@kodax-ai/agent';
import type {
  generateWorkflowFromOptions,
  ManagedWorkflowRun,
} from '@kodax-ai/coding';

import { workflowLiveSnapshotFromProcess } from '../ui/view-models/workflow-live.js';
import type { CommandCallbacks, WorkflowHostControl } from './types.js';
import {
  createWorkflowAgentDigestLimiter,
  formatArtifactResult,
  formatFinalEventSummary,
  formatResult,
  formatWorkflowCompletionAnswer,
  formatWorkflowEvent,
  formatWorkflowFailureAction,
  replaceWorkflowResultTruncationMarker,
  totalSpawnedFromProcess,
  renderWorkflowEvent,
  workflowEventStatus,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
} from './workflow-command-helpers.js';

type WorkflowRunMessageCallback = NonNullable<CommandCallbacks['onWorkflowRunMessage']>;
type WorkflowRunUpdateCallback = NonNullable<CommandCallbacks['onWorkflowRunUpdate']>;

function isWorkflowHarnessFailure(error: Error, totalSpawned: number | undefined): boolean {
  if (totalSpawned !== 0) return false;
  return error.name === 'WorkflowScriptExecutionError' ||
    /restricted workflow script|workflow generation source|workflow command .* must|unsupported workflow command/i.test(error.message);
}

function formatWorkflowFailedMessage(input: {
  readonly runId: string;
  readonly error: Error;
  readonly canRerun: boolean;
  readonly totalSpawned?: number;
  readonly partialResultText?: string;
  readonly locale?: WorkflowRunLocale;
}): string {
  const action = formatWorkflowFailureAction(input.runId, input.canRerun);
  const partialResultText = input.partialResultText
    ? replaceWorkflowResultTruncationMarker(
        input.partialResultText,
        input.runId,
        input.locale ?? 'en',
      )
    : undefined;
  const partialLines = partialResultText
    ? ['', 'Partial results before failure:', partialResultText]
    : [];
  if (!isWorkflowHarnessFailure(input.error, input.totalSpawned)) {
    return [
      `Workflow failed (${input.runId}): ${input.error.message}`,
      ...partialLines,
      action,
    ].join('\n');
  }
  return [
    `Workflow harness failed before launching child agents (${input.runId}): ${input.error.message}`,
    'This points to an invalid generated workflow script or saved capsule, not a failed child-agent task.',
    ...partialLines,
    action,
  ].join('\n');
}

function formatWorkflowFailurePartialResult(
  state: WorkflowRunState,
  locale: WorkflowRunLocale,
  options: { readonly full?: boolean },
): string | undefined {
  return formatArtifactResult(state.artifacts, locale, options)
    ?? formatFinalEventSummary(state.events, options);
}

function readWorkflowEventUsageTokens(data: Record<string, unknown> | undefined): number {
  const usage = data?.usage;
  if (typeof usage !== 'object' || usage === null) return 0;
  const record = usage as Record<string, unknown>;
  const totalTokens = record.totalTokens;
  if (typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0) {
    return totalTokens;
  }
  const inputTokens = record.inputTokens;
  const outputTokens = record.outputTokens;
  const input = typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens > 0
    ? inputTokens
    : 0;
  const output = typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0
    ? outputTokens
    : 0;
  return input + output;
}

export function emitWorkflowRunMessage(
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  event: Parameters<WorkflowRunMessageCallback>[0],
): void {
  if (callbacks.onWorkflowRunMessage) {
    callbacks.onWorkflowRunMessage(event);
    return;
  }
  if (event.type === 'error') {
    console.log(chalk.red(`\n${event.text}\n`));
    return;
  }
  if (event.type === 'success') {
    console.log(chalk.green(`\n${event.text}\n`));
    return;
  }
  if (event.type === 'event') {
    console.log(chalk.dim(event.text));
    return;
  }
  if (event.type === 'assistant') {
    console.log(`\n${event.text}\n`);
    return;
  }
  console.log(chalk.dim(`\n${event.text}\n`));
}

export function workflowEventSink(
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  live?: WorkflowLiveUpdateEmitter,
  options: {
    readonly presentation?: WorkflowRunPresentation;
    readonly locale?: WorkflowRunLocale;
    readonly runId?: string;
  } = {},
): (event: WorkflowEvent) => void {
  const digest = options.presentation === 'agentic'
    ? createWorkflowAgentDigestLimiter(options.runId ?? 'current')
    : undefined;
  let terminal = false;
  return (event) => {
    if (
      terminal &&
      (event.type === 'agent_completed' ||
        event.type === 'agent_unverified' ||
        event.type === 'agent_failed' ||
        event.type === 'agent_summary_updated')
    ) {
      return;
    }
    live?.onEvent(event);
    const text = formatWorkflowEvent(event);
    if (callbacks.onWorkflowRunMessage) {
      if (text) {
        emitWorkflowRunMessage(callbacks, { type: 'event', text });
      }
      if (digest) {
        const summary = digest(event, options.locale ?? 'en');
        if (summary) {
          emitWorkflowRunMessage(callbacks, {
            type: 'assistant',
            text: summary,
            final: false,
          });
        }
      }
      if (
        event.type === 'workflow_completed' ||
        event.type === 'workflow_failed' ||
        event.type === 'workflow_stopped'
      ) {
        terminal = true;
      }
      return;
    }
    if (
      event.type === 'workflow_completed' ||
      event.type === 'workflow_failed' ||
      event.type === 'workflow_stopped'
    ) {
      terminal = true;
    }
    if (!text) return;
    renderWorkflowEvent(event);
  };
}

export interface WorkflowLiveUpdateEmitter {
  onEvent(event: WorkflowEvent): void;
  onProcessEvent(event: WorkflowProcessEvent): void;
  complete(status: 'completed' | 'failed' | 'stopped', message?: string): void;
  running(message?: string): void;
}

export function createWorkflowLiveUpdateEmitter(
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunUpdate'>,
  runId: string,
  meta: WorkflowMeta,
  locale: WorkflowRunLocale = 'en',
): WorkflowLiveUpdateEmitter {
  const startedAt = Date.now();
  const activeAgents = new Map<string, string>();
  let phase: string | undefined;
  let totalSpawned = 0;
  let completedAgents = 0;
  let failedAgents = 0;
  let stoppedAgents = 0;
  let tokenBudgetSpent = 0;
  let terminal = false;
  const phases = meta.phases ?? [];
  const tokenBudgetTotal = meta.tokenBudget !== undefined && Number.isFinite(meta.tokenBudget)
    ? meta.tokenBudget
    : undefined;

  const emit = (
    status: Parameters<WorkflowRunUpdateCallback>[0]['status'],
    message?: string,
  ): void => {
    const phaseOffset = phase === undefined ? -1 : phases.indexOf(phase);
    const phaseIndex = phaseOffset >= 0 ? phaseOffset + 1 : undefined;
    const phaseTotal = phases.length > 0 ? phases.length : undefined;
    callbacks.onWorkflowRunUpdate?.({
      runId,
      workflow: meta.name,
      status,
      ...(phase !== undefined ? { phase } : {}),
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(phaseTotal !== undefined ? { phaseTotal } : {}),
      startedAt,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      activeAgents: [...activeAgents.values()],
      totalSpawned,
      ...(meta.plannedAgents !== undefined ? { plannedAgents: meta.plannedAgents } : {}),
      ...(meta.maxAgents !== undefined ? { agentCap: meta.maxAgents } : {}),
      tokenBudgetSpent,
      ...(tokenBudgetTotal !== undefined ? { tokenBudgetTotal } : {}),
      completedAgents,
      failedAgents,
      stoppedAgents,
      ...(message !== undefined ? { message } : {}),
      locale,
    });
  };

  return {
    running: (message) => {
      if (!terminal) emit('running', message);
    },
    onProcessEvent: (event) => {
      if (terminal && event.type !== 'workflow_finished') return;
      const status = event.snapshot.status;
      if (
        event.type === 'workflow_finished'
        || status === 'completed'
        || status === 'failed'
        || status === 'cancelled'
      ) {
        terminal = true;
      }
      const message = event.type === 'workflow_updated' ? event.message : undefined;
      callbacks.onWorkflowRunUpdate?.(workflowLiveSnapshotFromProcess(
        event.snapshot,
        message === undefined ? { locale } : { locale, message },
      ));
    },
    onEvent: (event) => {
      if (terminal) return;
      switch (event.type) {
        case 'phase_started': {
          const name = event.data?.name;
          phase = typeof name === 'string' ? name : phase;
          emit('running');
          break;
        }
        case 'agent_spawned': {
          const taskId = typeof event.data?.taskId === 'string'
            ? event.data.taskId
            : `task-${totalSpawned + 1}`;
          const name = typeof event.data?.name === 'string' ? event.data.name : taskId;
          activeAgents.set(taskId, name);
          totalSpawned += 1;
          emit('running');
          break;
        }
        case 'agent_completed': {
          const taskId = typeof event.data?.taskId === 'string' ? event.data.taskId : undefined;
          if (taskId) activeAgents.delete(taskId);
          tokenBudgetSpent += readWorkflowEventUsageTokens(event.data);
          const status = workflowEventStatus(event);
          if (status === 'failed') {
            failedAgents += 1;
          } else {
            completedAgents += 1;
          }
          emit('running');
          break;
        }
        case 'agent_unverified': {
          const taskId = typeof event.data?.taskId === 'string' ? event.data.taskId : undefined;
          if (taskId) activeAgents.delete(taskId);
          tokenBudgetSpent += readWorkflowEventUsageTokens(event.data);
          completedAgents += 1;
          emit('running');
          break;
        }
        case 'agent_failed': {
          const taskId = typeof event.data?.taskId === 'string' ? event.data.taskId : undefined;
          if (taskId) activeAgents.delete(taskId);
          tokenBudgetSpent += readWorkflowEventUsageTokens(event.data);
          failedAgents += 1;
          emit('running');
          break;
        }
        case 'agent_stopped': {
          const taskId = typeof event.data?.taskId === 'string' ? event.data.taskId : undefined;
          if (taskId) activeAgents.delete(taskId);
          tokenBudgetSpent += readWorkflowEventUsageTokens(event.data);
          stoppedAgents += 1;
          emit('running');
          break;
        }
        case 'synthesis_completed': {
          emit('running', 'synthesis complete');
          break;
        }
        default:
          break;
      }
    },
    complete: (status, message) => {
      if (terminal) return;
      terminal = true;
      emit(status, message);
    },
  };
}

export function observeManagedWorkflowDone(
  managed: ManagedWorkflowRun,
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  runId: string,
  live?: WorkflowLiveUpdateEmitter,
  options: {
    readonly canRerun?: boolean;
    readonly presentation?: WorkflowRunPresentation;
    readonly locale?: WorkflowRunLocale;
  } = {},
): void {
  void managed.done.then((outcome) => {
    if (outcome.kind === 'failed') {
      if (managed.getSnapshot?.()?.status === 'stopped') {
        live?.complete('stopped', 'Workflow stopped by user.');
        return;
      }
      const locale = options.locale ?? 'en';
      const resultOptions = { full: options.presentation === 'agentic' };
      const partialResultText = formatWorkflowFailurePartialResult(
        outcome.state,
        locale,
        resultOptions,
      );
      const failureText = formatWorkflowFailedMessage({
        runId,
        error: outcome.error,
        canRerun: options.canRerun === true,
        totalSpawned: outcome.state.totalSpawned,
        ...(partialResultText !== undefined ? { partialResultText } : {}),
        locale,
      });
      live?.complete('failed', outcome.error.message);
      emitWorkflowRunMessage(callbacks, {
        type: 'error',
        text: options.presentation === 'agentic' && partialResultText !== undefined
          ? formatWorkflowFailedMessage({
              runId,
              error: outcome.error,
              canRerun: options.canRerun === true,
              totalSpawned: outcome.state.totalSpawned,
              locale,
            })
          : failureText,
      });
      if (options.presentation === 'agentic' && partialResultText !== undefined) {
        emitWorkflowRunMessage(callbacks, {
          type: 'assistant',
          text: failureText,
          final: true,
        });
      }
      return;
    }
    if (outcome.kind === 'completed') {
      const locale = options.locale ?? 'en';
      const resultOptions = { full: options.presentation === 'agentic' };
      const directResultText = formatResult(outcome.result, resultOptions)
        ?? formatArtifactResult(outcome.state.artifacts, locale, resultOptions);
      const fallbackResultText = directResultText === undefined
        ? formatFinalEventSummary(outcome.state.events, resultOptions)
        : undefined;
      const resultText = directResultText ?? fallbackResultText;
      live?.complete('completed', resultText ? 'completed with result' : 'completed');
      if (options.presentation === 'agentic') {
        emitWorkflowRunMessage(callbacks, {
          type: 'assistant',
          text: formatWorkflowCompletionAnswer({
            runId,
            totalSpawned: outcome.state.totalSpawned,
            ...(resultText !== undefined ? { resultText } : {}),
            ...(directResultText === undefined && fallbackResultText !== undefined
              ? { isFallbackPreview: true }
              : {}),
            locale,
          }),
          final: true,
        });
        return;
      }
      emitWorkflowRunMessage(callbacks, {
        type: 'success',
        text: [
          `Workflow completed (${outcome.state.totalSpawned} agents, run ${runId}).`,
          `Use /workflow show ${runId} for the event timeline.`,
        ].join('\n'),
      });
      if (resultText) {
        emitWorkflowRunMessage(callbacks, {
          type: 'info',
          text: `Workflow result:\n${resultText}`,
        });
      }
    }
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (managed.getSnapshot?.()?.status === 'stopped') {
      live?.complete('stopped', 'Workflow stopped by user.');
      return;
    }
    live?.complete('failed', message);
    emitWorkflowRunMessage(callbacks, {
      type: 'error',
      text: formatWorkflowFailedMessage({
        runId,
        error: error instanceof Error ? error : new Error(message),
        canRerun: options.canRerun === true,
      }),
    });
  });
}

/**
 * FEATURE_298 T22 — done-observation for a Host-minted run. There is no local
 * `managed.done` promise: the run lives in the Host manager, so completion
 * arrives as `workflow_finished` process events. The Host may also finish the
 * run before the subscription attaches (start resolves after the run begins),
 * so a one-shot terminal poll backstops the event stream.
 */
export function observeHostWorkflowDone(
  hostControl: WorkflowHostControl,
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  runId: string,
  live?: WorkflowLiveUpdateEmitter,
  options: {
    readonly canRerun?: boolean;
    readonly presentation?: WorkflowRunPresentation;
    readonly locale?: WorkflowRunLocale;
  } = {},
): void {
  const locale = options.locale ?? 'en';
  let done = false;
  let subscriptionRef: { close(): void } | undefined;
  const finish = (snapshot: WorkflowProcessSnapshot): void => {
    subscriptionRef?.close();
    const totalSpawned = totalSpawnedFromProcess(snapshot);
    if (snapshot.status === 'cancelled') {
      live?.complete('stopped', 'Workflow stopped by user.');
      return;
    }
    if (snapshot.status === 'failed') {
      const errorText = snapshot.error ?? 'Workflow failed.';
      live?.complete('failed', errorText);
      emitWorkflowRunMessage(callbacks, {
        type: 'error',
        text: formatWorkflowFailedMessage({
          runId,
          error: new Error(errorText),
          canRerun: options.canRerun === true,
          totalSpawned,
          locale,
        }),
      });
      return;
    }
    if (snapshot.status !== 'completed') return;
    // Result parity with the local done path: resultSummary first, then the
    // artifact preview (snapshot artifacts carry run-dir paths), then the
    // last process message.
    const artifactText = snapshot.artifacts !== undefined && snapshot.artifacts.length > 0
      ? formatArtifactResult(snapshot.artifacts, locale, { full: options.presentation === 'agentic' })
      : undefined;
    const resultText = snapshot.resultSummary ?? artifactText ?? snapshot.latestMessage;
    live?.complete('completed', resultText !== undefined ? 'completed with result' : 'completed');
    if (options.presentation === 'agentic') {
      emitWorkflowRunMessage(callbacks, {
        type: 'assistant',
        text: formatWorkflowCompletionAnswer({
          runId,
          totalSpawned,
          ...(resultText !== undefined ? { resultText } : {}),
          locale,
        }),
        final: true,
      });
      return;
    }
    emitWorkflowRunMessage(callbacks, {
      type: 'success',
      text: [
        `Workflow completed (${totalSpawned} agents, run ${runId}).`,
        `Use /workflow show ${runId} for the event timeline.`,
      ].join('\n'),
    });
    if (resultText !== undefined) {
      emitWorkflowRunMessage(callbacks, {
        type: 'info',
        text: `Workflow result:\n${resultText}`,
      });
    }
  };
  const subscription = hostControl.subscribe({ runId }, (event) => {
    if (event.snapshot.runId !== runId) return;
    live?.onProcessEvent(event);
    if (event.type === 'workflow_finished' && !done) {
      done = true;
      finish(event.snapshot);
    }
  });
  subscriptionRef = subscription;
  if (done) {
    // The Host dispatched a synchronous workflow_finished during subscribe(),
    // before subscriptionRef was assigned; close what finish() could not.
    subscription.close();
  }
  void (async () => {
    const snapshot = await hostControl.get(runId);
    if (done || snapshot === undefined || snapshot.runId !== runId) return;
    if (!isFinalWorkflowProcessStatus(snapshot.status)) return;
    done = true;
    finish(snapshot);
  })().catch((error: unknown) => {
    if (done) return;
    emitWorkflowRunMessage(callbacks, {
      type: 'error',
      text: `Workflow completion watch failed (run ${runId}): ${error instanceof Error ? error.message : String(error)}`,
    });
  });
}

export type GeneratedWorkflowApprovalMode = 'required' | 'silent';
export type GeneratedWorkflowStartOutcome = 'started' | 'declined' | 'cancelled' | 'failed';
export type WorkflowBuilderStage =
  | 'started'
  | 'generating'
  | 'validating'
  | 'ready'
  | 'declined'
  | 'cancelled'
  | 'failed'
  | 'launched';

export interface WorkflowBuilderEvent {
  readonly stage: WorkflowBuilderStage;
  readonly message: string;
}

type GenerateWorkflowForRequest = typeof generateWorkflowFromOptions;

export interface StartGeneratedWorkflowFromRequestOptions {
  readonly request: string;
  readonly builtin?: {
    readonly name: string;
    readonly args: unknown;
  };
  readonly callbacks: Pick<
    CommandCallbacks,
    | 'createKodaXOptions'
    | 'confirm'
    | 'readline'
    | 'onWorkflowRunMessage'
    | 'onWorkflowRunUpdate'
    | 'workflows'
  >;
  readonly approval: GeneratedWorkflowApprovalMode;
  readonly presentation?: WorkflowRunPresentation;
  readonly sourceLabel?: string;
  readonly processSource?: WorkflowProcessSource;
  readonly generateWorkflow?: GenerateWorkflowForRequest;
  readonly onBuilderEvent?: (event: WorkflowBuilderEvent) => void;
}

