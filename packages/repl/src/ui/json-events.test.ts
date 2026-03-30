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
