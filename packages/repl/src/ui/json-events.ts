/**
 * JSONL event handler for non-interactive CLI mode.
 *
 * stdout carries newline-delimited JSON events only.
 * stderr carries structured error diagnostics.
 */

import type {
  KodaXContextTokenSnapshot,
  KodaXEvents,
  KodaXRepoIntelligenceTraceEvent,
  KodaXTokenUsage,
} from '@kodax/coding';

type JsonWritable = Pick<NodeJS.WritableStream, 'write'>;

export interface JsonEventOutputOptions {
  stdout?: JsonWritable;
  stderr?: JsonWritable;
}

type JsonEvent =
  | { type: 'session.start'; provider: string; sessionId: string }
  | { type: 'iteration.start'; iter: number; maxIter: number }
  | {
      type: 'iteration.end';
      iter: number;
      maxIter: number;
      tokenCount: number;
      tokenSource: 'api' | 'estimate';
      usage?: KodaXTokenUsage;
      contextTokenSnapshot?: KodaXContextTokenSnapshot;
    }
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'thinking.end'; thinking: string }
  | { type: 'tool.start'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool.input.delta'; toolName: string; partialJson: string; toolId?: string }
  | { type: 'tool.result'; id: string; name: string; content: string }
  | { type: 'stream.end' }
  | { type: 'compact.start' }
  | { type: 'compact.finish'; estimatedTokens: number }
  | { type: 'compact.stats'; tokensBefore: number; tokensAfter: number }
  | { type: 'compact.end' }
  | { type: 'retry'; reason: string; attempt: number; maxAttempts: number }
  | {
      type: 'provider.recovery';
      stage: string;
      reasonCode: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      nextAt: number;
      recoveryAction: string;
      fallbackUsed: boolean;
    }
  | { type: 'provider.rate_limit'; attempt: number; maxRetries: number; delayMs: number }
  | {
      type: 'repo_intelligence.trace';
      stage: KodaXRepoIntelligenceTraceEvent['stage'];
      summary: string;
      capability?: KodaXRepoIntelligenceTraceEvent['capability'];
      trace?: KodaXRepoIntelligenceTraceEvent['trace'];
    }
  | { type: 'complete' };

type JsonErrorEvent = {
  type: 'error';
  name: string;
  message: string;
  stack?: string;
};

function writeJsonLine(stream: JsonWritable, value: JsonEvent | JsonErrorEvent): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function serializeError(error: Error): JsonErrorEvent {
  return {
    type: 'error',
    name: error.name,
    message: error.message,
    stack: error.stack,
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
      });
    },

    onIterationStart: (iter, maxIter) => {
      writeJsonLine(stdout, { type: 'iteration.start', iter, maxIter });
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
      });
    },

    onTextDelta: (text) => {
      writeJsonLine(stdout, { type: 'text.delta', text });
    },

    onThinkingDelta: (text) => {
      writeJsonLine(stdout, { type: 'thinking.delta', text });
    },

    onThinkingEnd: (thinking) => {
      writeJsonLine(stdout, { type: 'thinking.end', thinking });
    },

    onToolUseStart: (tool) => {
      writeJsonLine(stdout, {
        type: 'tool.start',
        id: tool.id,
        name: tool.name,
        input: tool.input,
      });
    },

    onToolInputDelta: (toolName, partialJson, meta) => {
      writeJsonLine(stdout, {
        type: 'tool.input.delta',
        toolName,
        partialJson,
        toolId: meta?.toolId,
      });
    },

    onToolResult: (result) => {
      writeJsonLine(stdout, {
        type: 'tool.result',
        id: result.id,
        name: result.name,
        content: result.content,
      });
    },

    onStreamEnd: () => {
      writeJsonLine(stdout, { type: 'stream.end' });
    },

    onCompactStart: () => {
      writeJsonLine(stdout, { type: 'compact.start' });
    },

    onCompact: (estimatedTokens) => {
      writeJsonLine(stdout, {
        type: 'compact.finish',
        estimatedTokens,
      });
    },

    onCompactStats: (info) => {
      writeJsonLine(stdout, {
        type: 'compact.stats',
        tokensBefore: info.tokensBefore,
        tokensAfter: info.tokensAfter,
      });
    },

    onCompactEnd: () => {
      writeJsonLine(stdout, { type: 'compact.end' });
    },

    onRetry: (reason, attempt, maxAttempts) => {
      writeJsonLine(stdout, {
        type: 'retry',
        reason,
        attempt,
        maxAttempts,
      });
    },

    onProviderRateLimit: (attempt, maxRetries, delayMs) => {
      writeJsonLine(stdout, {
        type: 'provider.rate_limit',
        attempt,
        maxRetries,
        delayMs,
      });
    },

    onRepoIntelligenceTrace: (event) => {
      writeJsonLine(stdout, {
        type: 'repo_intelligence.trace',
        stage: event.stage,
        summary: event.summary,
        capability: event.capability,
        trace: event.trace,
      });
    },

    onComplete: () => {
      writeJsonLine(stdout, { type: 'complete' });
    },

    onError: (error) => {
      writeJsonLine(stderr, serializeError(error));
    },
  };
}
