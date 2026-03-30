import { describe, expect, it, vi } from 'vitest';
import { CodexCLIExecutor } from './codex-parser.js';
import type { CLIEvent, CLIExecutionOptions } from './types.js';

class ExposedCodexCLIExecutor extends CodexCLIExecutor {
  buildArgsForTest(options: CLIExecutionOptions): string[] {
    return this.buildArgs(options);
  }

  parseLineForTest(line: string): CLIEvent | null {
    return this.parseLine(line);
  }
}

describe('CodexCLIExecutor', () => {
  it('builds fresh and resume argument lists correctly', () => {
    const executor = new ExposedCodexCLIExecutor({ model: 'gpt-5.4' });

    expect(executor.buildArgsForTest({ prompt: 'ship it' })).toEqual([
      'exec',
      '--json',
      '--full-auto',
      'ship it',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'continue', sessionId: 'thread-1' })).toEqual([
      'exec',
      'resume',
      'thread-1',
      'continue',
      '--json',
      '--full-auto',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'ship it', model: 'gpt-5.4' })).toEqual([
      'exec',
      '--json',
      '--full-auto',
      '-m',
      'gpt-5.4',
      'ship it',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'continue', sessionId: 'thread-1', model: 'gpt-5.4' })).toEqual([
      'exec',
      'resume',
      'thread-1',
      '-m',
      'gpt-5.4',
      'continue',
      '--json',
      '--full-auto',
    ]);
  });

  it('parses Codex thread, message, tool, completion, and failure events', () => {
    const executor = new ExposedCodexCLIExecutor();
    vi.spyOn(Date, 'now').mockReturnValue(1234);

    expect(
      executor.parseLineForTest('{"type":"thread.started","thread_id":"thread-1"}'),
    ).toEqual({
      type: 'session_start',
      timestamp: 1234,
      sessionId: 'thread-1',
      model: 'gpt-5.4',
      raw: { type: 'thread.started', thread_id: 'thread-1' },
    });

    expect(
      executor.parseLineForTest('{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"hello"}}'),
    ).toEqual({
      type: 'message',
      timestamp: 1234,
      role: 'assistant',
      content: 'hello',
      raw: {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'hello' },
      },
    });

    expect(
      executor.parseLineForTest('{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"dir"}}'),
    ).toEqual({
      type: 'tool_use',
      timestamp: 1234,
      toolId: 'cmd-1',
      toolName: 'Bash',
      parameters: { command: 'dir' },
      raw: {
        type: 'item.completed',
        item: { id: 'cmd-1', type: 'command_execution', command: 'dir' },
      },
    });

    expect(
      executor.parseLineForTest('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":4}}'),
    ).toEqual({
      type: 'complete',
      timestamp: 1234,
      status: 'success',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      raw: {
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      },
    });

    expect(
      executor.parseLineForTest('{"type":"turn.failed","message":"boom"}'),
    ).toEqual({
      type: 'error',
      timestamp: 1234,
      errorType: 'turn.failed',
      message: 'boom',
      raw: { type: 'turn.failed', message: 'boom' },
    });
  });

  it('returns null for non-JSON and unsupported records', () => {
    const executor = new ExposedCodexCLIExecutor();

    expect(executor.parseLineForTest('not json')).toBeNull();
    expect(executor.parseLineForTest('{"type":"unknown"}')).toBeNull();
    expect(executor.parseLineForTest('{')).toBeNull();
  });
});
