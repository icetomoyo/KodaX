import { describe, expect, it } from 'vitest';
import { createJsonEvents } from './json-events.js';

function createWritable() {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    readLines() {
      const content = chunks.join('');
      if (!content) {
        return [];
      }

      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

describe('createJsonEvents', () => {
  it('emits refusal as a control notice without adding an assistant delta', () => {
    const stdout = createWritable();
    const events = createJsonEvents({ stdout: stdout.stream, stderr: createWritable().stream });
    events.onOutputNotice?.({ code: 'model_refused' }, { providerRequestId: 'request' });
    expect(stdout.readLines()).toEqual([{ type: 'output.notice', code: 'model_refused', providerRequestId: 'request' }]);
  });
  it('serializes lifecycle events to stdout as JSONL', () => {
    const stdout = createWritable();
    const stderr = createWritable();
    const events = createJsonEvents({ stdout: stdout.stream, stderr: stderr.stream });
    const workflowCorrelation = {
      workflowRunId: 'run-1',
      childAgentId: 'child-1',
      itemId: 'agent:child-1',
    };

    events.onSessionStart?.({ provider: 'openai', sessionId: 'session-123' });
    events.onIterationStart?.(1, 5);
    events.onTextDelta?.('hello');
    events.onToolUseStart?.(
      { id: 'tool-1', name: 'read', input: { path: 'README.md' } },
      { toolId: 'tool-1', workflowCorrelation },
    );
    events.onToolInputDelta?.('read', '{"path":"README.md"}', {
      toolId: 'tool-1',
      workflowCorrelation,
    });
    events.onToolResult?.(
      { id: 'tool-1', name: 'read', content: 'file contents' },
      { toolId: 'tool-1', workflowCorrelation },
    );
    events.onToolProgress?.(
      { id: 'tool-1', message: 'reading README.md' },
      {
        toolId: 'tool-1',
        workflowCorrelation,
      },
    );
    events.onToolSandboxObservation?.(
      {
        id: 'tool-1',
        observation: {
          version: 1,
          state: 'fallback',
          reason: 'not_ready',
          execution: 'normal_permission_policy',
        },
      },
      {
        toolId: 'tool-1',
        workflowCorrelation,
      },
    );
    events.onProviderRecovery?.({
      stage: 'mid_stream_text',
      errorClass: 'stream_idle_timeout',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 5000,
      recoveryAction: 'stable_boundary_retry',
      ladderStep: 2,
      fallbackUsed: false,
    });
    events.onRepoIntelligenceTrace?.({
      stage: 'preturn',
      summary: 'stage=preturn | mode=full/full/ok',
      capability: {
        mode: 'full',
        engine: 'full',
        level: 'enhanced',
        status: 'ok',
        warnings: [],
      },
      trace: {
        mode: 'full',
        engine: 'full',
        triggeredAt: '2026-04-01T00:00:00.000Z',
        source: 'full',
      },
    });
    events.onSidecarMessage?.({
      source: 'sidecar-verifier',
      verdict: 'revise',
      recipient: 'main-agent',
      delivery: 'synthetic-user-message',
      content: 'Run the missing regression test.',
      suggestedFix: 'npm test -- foo.test.ts',
      trace: 'verifier_ok',
    });
    events.onIterationEnd?.({
      iter: 1,
      maxIter: 5,
      tokenCount: 42,
      tokenSource: 'estimate',
      scope: 'worker',
    });
    events.onComplete?.();

    expect(stdout.readLines()).toEqual([
      { type: 'session.start', provider: 'openai', sessionId: 'session-123' },
      { type: 'iteration.start', iter: 1, maxIter: 5 },
      { type: 'text.delta', text: 'hello' },
      {
        type: 'tool.start',
        id: 'tool-1',
        name: 'read',
        input: { path: 'README.md' },
        workflowCorrelation,
      },
      {
        type: 'tool.input.delta',
        toolName: 'read',
        partialJson: '{"path":"README.md"}',
        toolId: 'tool-1',
        workflowCorrelation,
      },
      {
        type: 'tool.result',
        id: 'tool-1',
        name: 'read',
        content: 'file contents',
        workflowCorrelation,
      },
      {
        type: 'tool.progress',
        id: 'tool-1',
        message: 'reading README.md',
        workflowCorrelation,
      },
      {
        type: 'tool.sandbox',
        id: 'tool-1',
        observation: {
          version: 1,
          state: 'fallback',
          reason: 'not_ready',
          execution: 'normal_permission_policy',
        },
        workflowCorrelation,
      },
      {
        type: 'provider.recovery',
        stage: 'mid_stream_text',
        reasonCode: 'stream_idle_timeout',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 5000,
        nextAt: expect.any(Number),
        recoveryAction: 'stable_boundary_retry',
        fallbackUsed: false,
      },
      {
        type: 'repo_intelligence.trace',
        stage: 'preturn',
        summary: 'stage=preturn | mode=full/full/ok',
        capability: {
          mode: 'full',
          engine: 'full',
          level: 'enhanced',
          status: 'ok',
          warnings: [],
        },
        trace: {
          mode: 'full',
          engine: 'full',
          triggeredAt: '2026-04-01T00:00:00.000Z',
          source: 'full',
        },
      },
      {
        type: 'sidecar.message',
        source: 'sidecar-verifier',
        verdict: 'revise',
        recipient: 'main-agent',
        delivery: 'synthetic-user-message',
        content: 'Run the missing regression test.',
        suggestedFix: 'npm test -- foo.test.ts',
        trace: 'verifier_ok',
      },
      {
        type: 'iteration.end',
        iter: 1,
        maxIter: 5,
        tokenCount: 42,
        tokenSource: 'estimate',
        scope: 'worker',
      },
      { type: 'complete' },
    ]);
    expect(stderr.readLines()).toEqual([]);
  });

  it('preserves the JSON-safe zero sentinel for an unbounded managed run', () => {
    const stdout = createWritable();
    const events = createJsonEvents({ stdout: stdout.stream });

    events.onIterationStart?.(65, 0);
    events.onIterationEnd?.({
      iter: 65,
      maxIter: 0,
      tokenCount: 42,
      tokenSource: 'estimate',
    });

    expect(stdout.readLines()).toEqual([
      { type: 'iteration.start', iter: 65, maxIter: 0 },
      {
        type: 'iteration.end',
        iter: 65,
        maxIter: 0,
        tokenCount: 42,
        tokenSource: 'estimate',
      },
    ]);
  });

  it('serializes child activity metadata for live telemetry callbacks', () => {
    const stdout = createWritable();
    const stderr = createWritable();
    const events = createJsonEvents({ stdout: stdout.stream, stderr: stderr.stream });
    const workflowCorrelation = {
      workflowRunId: 'run-1',
      childAgentId: 'child-1',
      itemId: 'agent:child-1',
    };
    const meta = {
      workflowCorrelation,
      childAgentId: 'child-1',
      childAgentName: 'diff-explorer',
      liveOnly: true,
    };

    events.onTextDelta?.('child text', meta);
    events.onThinkingDelta?.('child thinking', meta);
    events.onThinkingEnd?.('final thinking', meta);
    events.onStreamEnd?.(meta);

    expect(stdout.readLines()).toEqual([
      {
        type: 'text.delta',
        text: 'child text',
        workflowCorrelation,
        childAgentId: 'child-1',
        childAgentName: 'diff-explorer',
        liveOnly: true,
      },
      {
        type: 'thinking.delta',
        text: 'child thinking',
        workflowCorrelation,
        childAgentId: 'child-1',
        childAgentName: 'diff-explorer',
        liveOnly: true,
      },
      {
        type: 'thinking.end',
        thinking: 'final thinking',
        workflowCorrelation,
        childAgentId: 'child-1',
        childAgentName: 'diff-explorer',
        liveOnly: true,
      },
      {
        type: 'stream.end',
        workflowCorrelation,
        childAgentId: 'child-1',
        childAgentName: 'diff-explorer',
        liveOnly: true,
      },
    ]);
    expect(stderr.readLines()).toEqual([]);
  });

  it('serializes live turn attribution and explicit turn boundaries', () => {
    const stdout = createWritable();
    const stderr = createWritable();
    const events = createJsonEvents({ stdout: stdout.stream, stderr: stderr.stream });

    events.onSessionStart?.({
      provider: 'openai',
      sessionId: 'session-123',
      seq: 1,
      turnId: 'turn-1',
      deliveryId: 'delivery-1',
      timestamp: '2026-07-04T00:00:00.000Z',
    });
    events.onTurnStarted?.({
      sessionId: 'session-123',
      seq: 2,
      turnId: 'turn-1',
      deliveryId: 'delivery-1',
      timestamp: '2026-07-04T00:00:00.000Z',
      deliveryKind: 'initial',
    });
    events.onTextDelta?.('hello', {
      sessionId: 'session-123',
      seq: 3,
      turnId: 'turn-1',
      deliveryId: 'delivery-1',
      timestamp: '2026-07-04T00:00:01.000Z',
    });
    events.onTurnCompleted?.({
      sessionId: 'session-123',
      seq: 4,
      turnId: 'turn-1',
      deliveryId: 'delivery-1',
      timestamp: '2026-07-04T00:00:02.000Z',
      status: 'completed',
    });

    expect(stdout.readLines()).toEqual([
      {
        type: 'session.start',
        provider: 'openai',
        sessionId: 'session-123',
        seq: 1,
        turnId: 'turn-1',
        deliveryId: 'delivery-1',
        timestamp: '2026-07-04T00:00:00.000Z',
      },
      {
        type: 'turn.started',
        sessionId: 'session-123',
        seq: 2,
        turnId: 'turn-1',
        deliveryId: 'delivery-1',
        timestamp: '2026-07-04T00:00:00.000Z',
        deliveryKind: 'initial',
      },
      {
        type: 'text.delta',
        text: 'hello',
        sessionId: 'session-123',
        seq: 3,
        turnId: 'turn-1',
        deliveryId: 'delivery-1',
        timestamp: '2026-07-04T00:00:01.000Z',
      },
      {
        type: 'turn.completed',
        sessionId: 'session-123',
        seq: 4,
        turnId: 'turn-1',
        deliveryId: 'delivery-1',
        timestamp: '2026-07-04T00:00:02.000Z',
        status: 'completed',
      },
    ]);
    expect(stderr.readLines()).toEqual([]);
  });

  it('writes structured errors to stderr', () => {
    const stdout = createWritable();
    const stderr = createWritable();
    const events = createJsonEvents({ stdout: stdout.stream, stderr: stderr.stream });

    events.onError?.(new Error('boom'));

    expect(stdout.readLines()).toEqual([]);
    expect(stderr.readLines()).toEqual([
      expect.objectContaining({
        type: 'error',
        name: 'Error',
        message: 'boom',
      }),
    ]);
  });
});
