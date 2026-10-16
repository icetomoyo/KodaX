import { expect, it } from 'vitest';
import { Runner } from '@kodax-ai/agent';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import { registerTool } from '../packages/coding/src/tools/index.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/runner-driven.js';
import { runToolDispatch } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';

it.each(['direct', 'managed'] as const)('serializes native and bridged shell targets in request order on the %s executor', async executor => {
  const order: string[] = [];
  const unregister = registerTool({
    name: 'bash', description: 'In-memory scheduling fixture; never starts a shell.',
    input_schema: { type: 'object', properties: { command: { type: 'string' } } }, sideEffect: 'mutates-shell',
    toClassifierInput: input => String((input as { command?: string }).command),
    handler: async input => {
      const command = String(input.command);
      order.push(`start:${command}`);
      await new Promise<void>(resolve => setImmediate(resolve));
      order.push(`done:${command}`);
      return command;
    },
  });
  const calls: KodaXToolUseBlock[] = [
    { type: 'tool_use', id: 'b1', name: 'tool_call', input: { name: 'bash', input: { command: 'one' } } },
    { type: 'tool_use', id: 'b2', name: 'bash', input: { command: 'two' } },
    { type: 'tool_use', id: 'b3', name: 'tool_call', input: { tool_name: 'bash', arguments: { command: 'three' } } },
  ];
  const ctx = { backups: new Map<string, string>() };
  try {
    if (executor === 'direct') {
      const result = await runToolDispatch({ toolBlocks: calls, ctx, events: {},
        runtimeSessionState: buildRuntimeSessionState({ activeTools: ['bash', 'tool_call'], modelSelection: {} }),
        activeToolNames: ['bash', 'tool_call'] });
      expect([...result.keys()].sort()).toEqual(['b1', 'b2', 'b3']);
    } else {
      let round = 0;
      const result = await Runner.run(buildRunnerAgentChain(ctx).worker, 'Run the three fixture operations.', {
        tracer: null,
        llm: async () => round++ === 0
          ? { text: '', toolCalls: calls }
          : { text: 'Done.' },
      });
      expect(result.output).toBe('Done.');
    }
    expect(order).toEqual(['start:one', 'done:one', 'start:two', 'done:two', 'start:three', 'done:three']);
  } finally { unregister(); }
});
