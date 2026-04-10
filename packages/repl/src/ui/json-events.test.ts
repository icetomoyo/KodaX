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
  it('serializes lifecycle events to stdout as JSONL', () => {
    const stdout = createWritable();
    const stderr = createWritable();
    const events = createJsonEvents({ stdout: stdout.stream, stderr: stderr.stream });

    events.onSessionStart?.({ provider: 'openai', sessionId: 'session-123' });
    events.onIterationStart?.(1, 5);
    events.onTextDelta?.('hello');
    events.onToolUseStart?.({ id: 'tool-1', name: 'read', input: { path: 'README.md' } });
    events.onToolInputDelta?.('read', '{"path":"README.md"}', { toolId: 'tool-1' });
    events.onToolResult?.({ id: 'tool-1', name: 'read', content: 'file contents' });
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
      summary: 'stage=preturn | mode=premium-native/premium/native/ok',
      capability: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        level: 'enhanced',
        status: 'ok',
        warnings: [],
      },
      trace: {
        mode: 'premium-native',
        engine: 'premium',
        bridge: 'native',
        triggeredAt: '2026-04-01T00:00:00.000Z',
        source: 'premium',
        daemonLatencyMs: 12,
      },
    });
    events.onIterationEnd?.({
      iter: 1,
      maxIter: 5,
      tokenCount: 42,
      tokenSource: 'estimate',
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
      },
      {
        type: 'tool.input.delta',
        toolName: 'read',
        partialJson: '{"path":"README.md"}',
        toolId: 'tool-1',
      },
      {
        type: 'tool.result',
        id: 'tool-1',
        name: 'read',
        content: 'file contents',
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
        summary: 'stage=preturn | mode=premium-native/premium/native/ok',
        capability: {
          mode: 'premium-native',
          engine: 'premium',
          bridge: 'native',
          level: 'enhanced',
          status: 'ok',
          warnings: [],
        },
        trace: {
          mode: 'premium-native',
          engine: 'premium',
          bridge: 'native',
          triggeredAt: '2026-04-01T00:00:00.000Z',
          source: 'premium',
          daemonLatencyMs: 12,
        },
      },
      {
        type: 'iteration.end',
        iter: 1,
        maxIter: 5,
        tokenCount: 42,
        tokenSource: 'estimate',
      },
      { type: 'complete' },
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
