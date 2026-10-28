import { expect, it } from 'vitest';
import { collectModelToolCalls } from './shared-contract-trace-metrics.js';

it('counts hidden control tools from provider outputs rather than UI events or repeated history', () => {
  const todo = { type: 'tool_use' as const, id: 'todo-call', name: 'todo_create', input: { subject: 'Verify' } };
  const calls = [
    { index: 0, kind: 'root' as const, result: { toolBlocks: [todo] } },
    { index: 1, kind: 'auxiliary' as const, result: { toolBlocks: [
      { type: 'tool_use' as const, id: 'judge', name: 'report_stall_judgment', input: {} },
    ] } },
    { index: 2, kind: 'root' as const, input: { messages: [{ content: [todo] }] }, result: { toolBlocks: [] } },
    { index: 3, kind: 'child' as const, error: 'cancelled' },
  ];
  expect(collectModelToolCalls(calls)).toEqual([
    { requestIndex: 0, kind: 'root', tool: todo },
    { requestIndex: 1, kind: 'auxiliary', tool: calls[1]!.result!.toolBlocks[0] },
  ]);
});

it('records each proposed call, including repeated ids, without claiming execution', () => {
  const tool = { type: 'tool_use' as const, id: 'same-id', name: 'bash', input: { command: 'denied command' } };
  const observed = collectModelToolCalls([
    { index: 0, kind: 'root', result: { toolBlocks: [tool] } },
    { index: 1, kind: 'root', result: { toolBlocks: [tool] } },
  ]);
  expect(observed.map(item => item.requestIndex)).toEqual([0, 1]);
  expect(observed).toHaveLength(2);
});
