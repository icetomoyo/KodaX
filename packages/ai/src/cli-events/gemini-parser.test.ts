import { describe, expect, it } from 'vitest';
import { GeminiCLIExecutor } from './gemini-parser.js';
import type { CLIEvent, CLIExecutionOptions } from './types.js';

class ExposedGeminiCLIExecutor extends GeminiCLIExecutor {
  buildArgsForTest(options: CLIExecutionOptions): string[] {
    return this.buildArgs(options);
  }

  parseLineForTest(line: string): CLIEvent | null {
    return this.parseLine(line);
  }
}

describe('GeminiCLIExecutor', () => {
  it('builds fresh and resume argument lists correctly', () => {
    const executor = new ExposedGeminiCLIExecutor({ model: 'gemini-test' });

    expect(executor.buildArgsForTest({ prompt: 'ship it' })).toEqual([
      '-m',
      'gemini-test',
      '-p',
      'ship it',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'continue', sessionId: 'session-1' })).toEqual([
      '-m',
      'gemini-test',
      '-r',
      'session-1',
      'continue',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
    ]);

    expect(executor.buildArgsForTest({ prompt: 'switch', model: 'gemini-2.5-flash' })).toEqual([
      '-m',
      'gemini-2.5-flash',
      '-p',
      'switch',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
    ]);
  });

  it('parses init, message, tool, result, and error events', () => {
    const executor = new ExposedGeminiCLIExecutor({ model: 'gemini-test' });

    expect(
      executor.parseLineForTest('{"type":"init","timestamp":"2026-03-23T00:00:00.000Z","session_id":"session-1","model":"gemini-2.5-pro"}'),
    ).toEqual({
      type: 'session_start',
      timestamp: Date.parse('2026-03-23T00:00:00.000Z'),
      sessionId: 'session-1',
      model: 'gemini-2.5-pro',
      raw: {
        type: 'init',
        timestamp: '2026-03-23T00:00:00.000Z',
        session_id: 'session-1',
        model: 'gemini-2.5-pro',
      },
    });

    expect(
      executor.parseLineForTest('{"type":"message","role":"assistant","content":"hello","delta":true}'),
    ).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: 'hello',
      delta: true,
    });

    expect(
      executor.parseLineForTest('{"type":"tool_use","tool_name":"read","tool_id":"tool-1","parameters":{"file":"README.md"}}'),
    ).toMatchObject({
      type: 'tool_use',
      toolId: 'tool-1',
      toolName: 'read',
      parameters: { file: 'README.md' },
    });

    expect(
      executor.parseLineForTest('{"type":"tool_result","tool_id":"tool-1","status":"failure","output":"denied"}'),
    ).toMatchObject({
      type: 'tool_result',
      toolId: 'tool-1',
      status: 'error',
      output: 'denied',
    });

    expect(
      executor.parseLineForTest('{"type":"result","status":"success","stats":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}'),
    ).toMatchObject({
      type: 'complete',
      status: 'success',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });

    expect(
      executor.parseLineForTest('{"type":"error","message":"boom"}'),
    ).toMatchObject({
      type: 'error',
      errorType: 'error',
      message: 'boom',
    });
  });

  it('returns null for non-JSON and unsupported records', () => {
    const executor = new ExposedGeminiCLIExecutor();

    expect(executor.parseLineForTest('not json')).toBeNull();
    expect(executor.parseLineForTest('{"type":"unsupported"}')).toBeNull();
    expect(executor.parseLineForTest('{')).toBeNull();
  });
});
