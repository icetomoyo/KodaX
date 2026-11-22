import { describe, expect, it } from 'vitest';
import { approvalMissingToolResult } from '../packages/coding/src/constants.js';
import { CASES } from './approval-missing.cases.js';
import { messagesFor, observe, refusedCall } from './approval-missing.eval.js';

describe('approval-missing eval cases', () => {
  it('end each history on one call that D8 refuses', () => {
    expect(CASES.map(evalCase => refusedCall(evalCase).name)).toEqual(['edit', 'edit', 'bash', 'edit', 'todo_create']);
  });

  it('answer every earlier call, so the only open call is the refused one', () => {
    for (const evalCase of CASES) {
      const blocks = evalCase.history.flatMap(message => Array.isArray(message.content) ? message.content : []);
      const calls = blocks.flatMap(block => block.type === 'tool_use' ? [block.id] : []);
      const results = blocks.flatMap(block => block.type === 'tool_result' ? [block.tool_use_id] : []);
      expect(calls.slice(0, -1)).toEqual(results);
    }
  });

  it('send arm B the production D8 refusal as an error result', () => {
    const last = messagesFor(CASES[0]!, 'B').at(-1);
    expect(last?.content).toEqual([{ type: 'tool_result', tool_use_id: 'edit-1',
      content: approvalMissingToolResult('edit'), is_error: true }]);
  });

  it('separate calls that change something from calls that read', () => {
    expect(observe({ text: 'Running bash(npm test) now.', toolCalls: [{ name: 'read' }, { name: 'write' }] }, 'edit')).toEqual({
      tools: ['read', 'write'], mutatingCalls: ['write'], retriedRefused: false, readCalls: ['read'],
      mutatingCallsInText: ['bash'], endedTurn: false,
    });
  });
});
