import { describe, it, expect } from 'vitest';
import { interpolateVariables } from './variable-interpolation.js';
import type { HookEventContext } from './types.js';

describe('interpolateVariables', () => {
  const baseContext: HookEventContext = {
    eventType: 'PreToolUse',
    toolName: 'test-tool',
    sessionId: 'session-123',
    workingDir: '/home/user',
  };

  it('replaces $TOOL_NAME with tool name', () => {
    const result = interpolateVariables('Tool: $TOOL_NAME', baseContext);
    expect(result).toBe('Tool: test-tool');
  });

  it('replaces $TOOL_INPUT with JSON stringified input', () => {
    const context = { ...baseContext, toolInput: { file: 'test.txt', action: 'read' } };
    const result = interpolateVariables('Input: $TOOL_INPUT', context);
    expect(result).toContain('file');
    expect(result).toContain('test.txt');
  });

  it('replaces $TOOL_OUTPUT with tool output', () => {
    const context = { ...baseContext, toolOutput: 'output content' };
    const result = interpolateVariables('Output: $TOOL_OUTPUT', context);
    expect(result).toBe('Output: output content');
  });

  it('replaces $SESSION_ID with session id', () => {
    const result = interpolateVariables('Session: $SESSION_ID', baseContext);
    expect(result).toBe('Session: session-123');
  });

  it('replaces $WORKING_DIR with working directory', () => {
    const result = interpolateVariables('Dir: $WORKING_DIR', baseContext);
    expect(result).toBe('Dir: /home/user');
  });

  it('replaces $EVENT_TYPE with event type', () => {
    const result = interpolateVariables('Event: $EVENT_TYPE', baseContext);
    expect(result).toBe('Event: PreToolUse');
  });

  it('replaces $FILE_PATH with file_path from tool input', () => {
    const context = { ...baseContext, toolInput: { file_path: '/path/to/file.txt' } };
    const result = interpolateVariables('File: $FILE_PATH', context);
    expect(result).toBe('File: /path/to/file.txt');
  });

  it('replaces $FILE_PATH with path from tool input if file_path not present', () => {
    const context = { ...baseContext, toolInput: { path: '/alternate/path.txt' } };
    const result = interpolateVariables('File: $FILE_PATH', context);
    expect(result).toBe('File: /alternate/path.txt');
  });

  it('returns empty string for missing $FILE_PATH', () => {
    const result = interpolateVariables('File: $FILE_PATH', baseContext);
    expect(result).toBe('File: ');
  });

  it('leaves unknown variables as-is', () => {
    const result = interpolateVariables('Unknown: $UNKNOWN_VAR', baseContext);
    expect(result).toBe('Unknown: $UNKNOWN_VAR');
  });

  it('handles empty context values gracefully', () => {
    const emptyContext: HookEventContext = { eventType: 'SessionStart' };
    const result = interpolateVariables('Name: $TOOL_NAME Session: $SESSION_ID', emptyContext);
    expect(result).toBe('Name:  Session: ');
  });

  it('replaces multiple occurrences of same variable', () => {
    const result = interpolateVariables('$TOOL_NAME called from $TOOL_NAME', baseContext);
    expect(result).toBe('test-tool called from test-tool');
  });

  it('handles mixed variables in complex string', () => {
    const context = { ...baseContext, toolInput: { file_path: '/tmp/test.js' } };
    const result = interpolateVariables(
      'Tool $TOOL_NAME on file $FILE_PATH in session $SESSION_ID',
      context,
    );
    expect(result).toBe('Tool test-tool on file /tmp/test.js in session session-123');
  });
});
