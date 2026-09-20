/**
 * JSONL event handler for non-interactive CLI mode.
 *
 * stdout carries newline-delimited JSON events only.
 * stderr carries structured error diagnostics.
 */

import type {
  KodaXActivityEventMeta,
  KodaXContextTokenSnapshot,
  KodaXEvents,
  KodaXLiveEventMeta,
  KodaXManagedTaskStatusEvent,
  KodaXRepoIntelligenceTraceEvent,
  KodaXSidecarMessageEvent,
  KodaXShellSandboxObservation,
  KodaXTokenUsage,
  KodaXTurnCompletedEvent,
  KodaXTurnFailedEvent,
  KodaXTurnStartedEvent,
  WorkflowEventCorrelation,
} from '@kodax-ai/coding';

type JsonWritable = Pick<NodeJS.WritableStream, 'write'>;

export interface JsonEventOutputOptions {
  stdout?: JsonWritable;
  stderr?: JsonWritable;
}

type JsonEvent =
  | ({ type: 'session.start'; provider: string; sessionId: string } & JsonLiveMeta)
  | ({ type: 'turn.started' } & KodaXTurnStartedEvent)
  | ({ type: 'turn.completed' } & KodaXTurnCompletedEvent)
  | ({ type: 'turn.failed' } & KodaXTurnFailedEvent)
  | ({ type: 'iteration.start'; iter: number; maxIter: number } & JsonActivityMeta)
  | ({
      type: 'iteration.end';
      iter: number;
      maxIter: number;
      tokenCount: number;
      tokenSource: 'api' | 'estimate';
      usage?: KodaXTokenUsage;
      contextTokenSnapshot?: KodaXContextTokenSnapshot;
      scope?: 'parent' | 'worker';
    } & JsonLiveMeta)
  | ({ type: 'text.delta'; text: string } & JsonActivityMeta)
  | ({ type: 'output.notice'; code: 'model_refused'; providerRequestId?: string } & JsonActivityMeta)
  | ({ type: 'thinking.delta'; text: string } & JsonActivityMeta)
  | ({ type: 'thinking.end'; thinking: string } & JsonActivityMeta)
  | ({
      type: 'tool.start';
      id: string;
      name: string;
      input?: Record<string, unknown>;
    } & JsonActivityMeta)
  | ({
      type: 'tool.input.delta';
      toolName: string;
      partialJson: string;
      toolId?: string;
    } & JsonActivityMeta)
  | ({
      type: 'tool.result';
      id: string;
      name: string;
      content: string;
    } & JsonActivityMeta)
  | ({
      type: 'tool.sandbox';
      id: string;
      observation: KodaXShellSandboxObservation;
    } & JsonActivityMeta)
  | ({ type: 'stream.end' } & JsonActivityMeta)
  | ({ type: 'compact.start' } & JsonActivityMeta)
  | ({ type: 'compact.finish'; estimatedTokens: number } & JsonActivityMeta)
  | ({ type: 'compact.stats'; tokensBefore: number; tokensAfter: number } & JsonLiveMeta)
  | ({ type: 'compact.end' } & JsonActivityMeta)
  | ({ type: 'retry'; reason: string; attempt: number; maxAttempts: number } & JsonActivityMeta)
  | ({
      type: 'provider.recovery';
      stage: string;
      reasonCode: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      nextAt: number;
      recoveryAction: string;
      fallbackUsed: boolean;
    } & JsonActivityMeta)
  | ({ type: 'provider.rate_limit'; attempt: number; maxRetries: number; delayMs: number } & JsonActivityMeta)
  | ({
      type: 'repo_intelligence.trace';
      stage: KodaXRepoIntelligenceTraceEvent['stage'];
      summary: string;
      capability?: KodaXRepoIntelligenceTraceEvent['capability'];
      trace?: KodaXRepoIntelligenceTraceEvent['trace'];
    } & JsonLiveMeta)
  | ({
      type: 'sidecar.message';
      source: KodaXSidecarMessageEvent['source'];
      verdict: KodaXSidecarMessageEvent['verdict'];
      recipient: KodaXSidecarMessageEvent['recipient'];
      delivery: KodaXSidecarMessageEvent['delivery'];
      content: string;
      suggestedFix?: string;
      trace?: string;
    } & JsonLiveMeta)
  | ({
      type: 'tool.progress';
      id: string;
      message: string;
    } & JsonActivityMeta)
  | ({
      type: 'managed_task.status';
      agentMode: KodaXManagedTaskStatusEvent['agentMode'];
      harnessProfile: KodaXManagedTaskStatusEvent['harnessProfile'];
      phase?: KodaXManagedTaskStatusEvent['phase'];
      activeWorkerId?: string;
      activeWorkerTitle?: string;
      childFanoutClass?: KodaXManagedTaskStatusEvent['childFanoutClass'];
      childFanoutCount?: number;
      currentRound?: number;
      maxRounds?: number;
      note?: string;
      detailNote?: string;
      globalWorkBudget?: number;
      budgetUsage?: number;
      budgetApprovalRequired?: boolean;
    } & JsonLiveMeta)
  | ({
      type: 'scout.suspicious_completion';
      confidence: 'uncertain';
      signals: readonly string[];
      sessionId?: string;
      lastTextPreview?: string;
    } & JsonLiveMeta)
  | ({ type: 'complete' } & JsonActivityMeta);

type JsonErrorEvent = {
  type: 'error';
  name: string;
  message: string;
  stack?: string;
} & JsonActivityMeta;

type JsonActivityMeta = {
  sessionId?: string;
  seq?: number;
  turnId?: string;
  deliveryId?: string;
  timestamp?: string;
  workflowCorrelation?: WorkflowEventCorrelation;
  childAgentId?: string;
  childAgentName?: string;
  parentToolId?: string;
  liveOnly?: boolean;
};

type JsonLiveMeta = Partial<KodaXLiveEventMeta>;

function activityMetaFields(meta?: KodaXActivityEventMeta): JsonActivityMeta {
  return {
    ...(meta?.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    ...(meta?.seq !== undefined ? { seq: meta.seq } : {}),
    ...(meta?.turnId !== undefined ? { turnId: meta.turnId } : {}),
    ...(meta?.deliveryId !== undefined ? { deliveryId: meta.deliveryId } : {}),
    ...(meta?.timestamp !== undefined ? { timestamp: meta.timestamp } : {}),
    ...(meta?.workflowCorrelation !== undefined ? { workflowCorrelation: meta.workflowCorrelation } : {}),
    ...(meta?.childAgentId !== undefined ? { childAgentId: meta.childAgentId } : {}),
    ...(meta?.childAgentName !== undefined ? { childAgentName: meta.childAgentName } : {}),
    ...(meta?.parentToolId !== undefined ? { parentToolId: meta.parentToolId } : {}),
    ...(meta?.liveOnly !== undefined ? { liveOnly: meta.liveOnly } : {}),
  };
}

function liveMetaFields(meta: Partial<KodaXLiveEventMeta>): JsonLiveMeta {
  return {
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    ...(meta.seq !== undefined ? { seq: meta.seq } : {}),
    ...(meta.turnId !== undefined ? { turnId: meta.turnId } : {}),
    ...(meta.deliveryId !== undefined ? { deliveryId: meta.deliveryId } : {}),
    ...(meta.timestamp !== undefined ? { timestamp: meta.timestamp } : {}),
  };
}

function writeJsonLine(stream: JsonWritable, value: JsonEvent | JsonErrorEvent): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function serializeError(error: Error, meta?: KodaXActivityEventMeta): JsonErrorEvent {
  return {
    type: 'error',
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...activityMetaFields(meta),
  };
}

export function createJsonEvents(options: JsonEventOutputOptions = {}): KodaXEvents {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  return {
    onSessionStart: (info) => {
      writeJsonLine(stdout, {
        type: 'session.start',
        provider: info.provider,
        sessionId: info.sessionId,
        ...liveMetaFields(info),
      });
    },

    onTurnStarted: (event) => {
      writeJsonLine(stdout, { type: 'turn.started', ...event });
    },

    onTurnCompleted: (event) => {
      writeJsonLine(stdout, { type: 'turn.completed', ...event });
    },

    onTurnFailed: (event) => {
      writeJsonLine(stdout, { type: 'turn.failed', ...event });
    },

    onIterationStart: (iter, maxIter, meta) => {
      writeJsonLine(stdout, {
        type: 'iteration.start',
        iter,
        maxIter,
        ...activityMetaFields(meta),
      });
    },

    onIterationEnd: (info) => {
      writeJsonLine(stdout, {
        type: 'iteration.end',
        iter: info.iter,
        maxIter: info.maxIter,
        tokenCount: info.tokenCount,
        tokenSource: info.tokenSource,
        usage: info.usage,
        contextTokenSnapshot: info.contextTokenSnapshot,
        ...(info.scope !== undefined ? { scope: info.scope } : {}),
        ...liveMetaFields(info),
      });
    },

    onTextDelta: (text, meta) => {
      writeJsonLine(stdout, { type: 'text.delta', text, ...activityMetaFields(meta) });
    },

    onThinkingDelta: (text, meta) => {
      writeJsonLine(stdout, { type: 'thinking.delta', text, ...activityMetaFields(meta) });
    },

    onThinkingEnd: (thinking, meta) => {
      writeJsonLine(stdout, { type: 'thinking.end', thinking, ...activityMetaFields(meta) });
    },

    onToolUseStart: (tool, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.start',
        id: tool.id,
        name: tool.name,
        input: tool.input,
        ...activityMetaFields(meta),
      });
    },

    onToolInputDelta: (toolName, partialJson, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.input.delta',
        toolName,
        partialJson,
        toolId: meta?.toolId,
        ...activityMetaFields(meta),
      });
    },

    onToolResult: (result, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.result',
        id: result.id,
        name: result.name,
        content: result.content,
        ...activityMetaFields(meta),
      });
    },

    onStreamEnd: (meta) => {
      writeJsonLine(stdout, { type: 'stream.end', ...activityMetaFields(meta) });
    },

    onCompactStart: (meta) => {
      writeJsonLine(stdout, { type: 'compact.start', ...activityMetaFields(meta) });
    },

    onCompact: (estimatedTokens, meta) => {
      writeJsonLine(stdout, {
        type: 'compact.finish',
        estimatedTokens,
        ...activityMetaFields(meta),
      });
    },

    onCompactStats: (info) => {
      writeJsonLine(stdout, {
        type: 'compact.stats',
        tokensBefore: info.tokensBefore,
        tokensAfter: info.tokensAfter,
        ...liveMetaFields(info),
      });
    },

    onCompactEnd: (meta) => {
      writeJsonLine(stdout, { type: 'compact.end', ...activityMetaFields(meta) });
    },

    onOutputNotice: (notice, meta) => {
      writeJsonLine(stdout, { type: 'output.notice', ...notice, ...activityMetaFields(meta),
        ...(meta?.providerRequestId ? { providerRequestId: meta.providerRequestId } : {}) });
    },
    onRetry: (reason, attempt, maxAttempts, meta) => {
      writeJsonLine(stdout, {
        type: 'retry',
        reason,
        attempt,
        maxAttempts,
        ...activityMetaFields(meta),
      });
    },

    onProviderRecovery: (event, meta) => {
      writeJsonLine(stdout, {
        type: 'provider.recovery',
        stage: event.stage,
        reasonCode: event.errorClass,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        nextAt: Date.now() + event.delayMs,
        recoveryAction: event.recoveryAction,
        fallbackUsed: event.fallbackUsed,
        ...activityMetaFields(meta),
      });
    },

    onProviderRateLimit: (attempt, maxRetries, delayMs, meta) => {
      writeJsonLine(stdout, {
        type: 'provider.rate_limit',
        attempt,
        maxRetries,
        delayMs,
        ...activityMetaFields(meta),
      });
    },

    onRepoIntelligenceTrace: (event) => {
      writeJsonLine(stdout, {
        type: 'repo_intelligence.trace',
        stage: event.stage,
        summary: event.summary,
        capability: event.capability,
        trace: event.trace,
        ...liveMetaFields(event),
      });
    },

    onSidecarMessage: (event) => {
      writeJsonLine(stdout, {
        type: 'sidecar.message',
        source: event.source,
        verdict: event.verdict,
        recipient: event.recipient,
        delivery: event.delivery,
        content: event.content,
        ...(event.suggestedFix !== undefined ? { suggestedFix: event.suggestedFix } : {}),
        ...(event.trace !== undefined ? { trace: event.trace } : {}),
        ...liveMetaFields(event),
      });
    },

    onToolProgress: (update, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.progress',
        id: update.id,
        message: update.message,
        ...activityMetaFields(meta),
      });
    },

    onToolSandboxObservation: (update, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.sandbox',
        id: update.id,
        observation: update.observation,
        ...activityMetaFields(meta),
      });
    },

    onManagedTaskStatus: (status) => {
      writeJsonLine(stdout, {
        type: 'managed_task.status',
        agentMode: status.agentMode,
        harnessProfile: status.harnessProfile,
        phase: status.phase,
        activeWorkerId: status.activeWorkerId,
        activeWorkerTitle: status.activeWorkerTitle,
        childFanoutClass: status.childFanoutClass,
        childFanoutCount: status.childFanoutCount,
        currentRound: status.currentRound,
        maxRounds: status.maxRounds,
        note: status.note,
        detailNote: status.detailNote,
        globalWorkBudget: status.globalWorkBudget,
        budgetUsage: status.budgetUsage,
        budgetApprovalRequired: status.budgetApprovalRequired,
        ...liveMetaFields(status),
      });
    },

    onScoutSuspiciousCompletion: (payload) => {
      writeJsonLine(stdout, {
        type: 'scout.suspicious_completion',
        confidence: payload.confidence,
        signals: payload.signals,
        sessionId: payload.sessionId,
        lastTextPreview: payload.lastTextPreview,
        ...liveMetaFields(payload),
      });
    },

    onComplete: (meta) => {
      writeJsonLine(stdout, { type: 'complete', ...activityMetaFields(meta) });
    },

    onError: (error, meta) => {
      writeJsonLine(stderr, serializeError(error, meta));
    },
  };
}
