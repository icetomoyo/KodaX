import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Runner } from '@kodax-ai/agent';
import { getToolExecutionOverride } from '../../../agent-runtime/permission-gate.js';
import { registerTool } from '../../../tools/registry.js';
import { createTodoStore } from '../../todo-store.js';
import type { KodaXEvents, KodaXToolExecutionContext } from '../../../types.js';
import { buildRunnerAgentChain } from './agent-chain.js';
import type { ManagedTaskBudgetController } from './budget.js';

it('charges read errors and successful recovery once through native and bridge entries', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bridge-budget-'));
  try {
    await fs.writeFile(path.join(workspace, 'evidence.txt'), 'verified fixture evidence\n');
    const results: unknown[][] = [];
    const spent: number[] = [];
    for (const bridged of [false, true]) {
      const budget: ManagedTaskBudgetController = {
        totalBudget: 100, spentBudget: 0, currentHarness: 'H2_PLAN_EXECUTE_EVAL',
      };
      const agent = buildRunnerAgentChain({ backups: new Map(), executionCwd: workspace },
        undefined, budget).worker;
      const tool = agent.tools?.find(t => t.name === (bridged ? 'tool_call' : 'read'));
      if (!tool) throw new Error('Required executable tool is missing');
      const observed = [];
      for (const file of ['missing.txt', 'evidence.txt']) {
        const target = { path: file };
        const input = bridged ? { name: 'read', input: target } : target;
        const original = structuredClone(input);
        const result = await tool.execute(input, { agent, toolCallId: file });
        observed.push({ content: result.content, isError: result.isError === true });
        expect(input).toEqual(original);
      }
      results.push(observed);
      spent.push(budget.spentBudget);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.[0]).toMatchObject({ isError: true });
    expect(results[0]?.[1]).toMatchObject({ isError: false });
    expect(JSON.stringify(results[0]?.[1])).toContain('verified fixture evidence');
    expect(spent).toEqual([2, 2]);
  } finally {
    if (path.dirname(workspace) !== path.resolve(os.tmpdir()) || !path.basename(workspace).startsWith('kodax-bridge-budget-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
});

it('charges Todo role overrides once and preserves their state transitions', async () => {
  for (const bridged of [false, true]) {
    const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0 };
    const store = createTodoStore();
    const agent = buildRunnerAgentChain({ backups: new Map(), todoStore: store }, undefined, budget).worker;
    for (const [name, input] of [
      ['todo_create', { subject: 'Verify the implementation' }],
      ['todo_update', { id: 'todo_1', status: 'completed' }],
    ] as const) {
      const tool = agent.tools!.find(t => t.name === (bridged ? 'tool_call' : name))!;
      const result = await tool.execute(bridged ? { name, input } : input, { agent, toolCallId: name });
      expect(JSON.parse(String(result.content))).toMatchObject({ ok: true });
    }
    expect(store.getAll()).toMatchObject([{ id: 'todo_1', status: 'completed' }]);
    expect(budget.spentBudget).toBe(2);
  }
});

it('keeps one charge and one capability dispatch for run-scoped Host tools', async () => {
  const results: unknown[] = [];
  for (const bridged of [false, true]) {
    const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0 };
    let dispatched = 0;
    const context: KodaXToolExecutionContext = {
      backups: new Map(),
      extensionRuntime: {
        listRunTools: () => [{ name: 'host_budget_probe', description: 'Offline Host fixture.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
          capabilityId: 'host:budget:probe', sideEffect: 'readonly', planModeAllowed: true }],
        executeCapability: async (provider, capability, input) => {
          expect([provider, capability, input]).toEqual(['mcp', 'host:budget:probe', { value: 'evidence' }]);
          dispatched++;
          return { kind: 'tool', content: 'Host evidence' };
        },
      },
    };
    const agent = buildRunnerAgentChain(context, undefined, budget).worker;
    const tool = agent.tools!.find(t => t.name === (bridged ? 'tool_call' : 'host_budget_probe'))!;
    const result = await tool.execute(bridged ? { name: 'host_budget_probe', input: { value: 'evidence' } } : { value: 'evidence' },
      { agent, toolCallId: 'host-budget' });
    results.push(result.content);
    expect(dispatched).toBe(1);
    expect(budget.spentBudget).toBe(1);
  }
  expect(results[0]).toEqual(results[1]);
  expect(JSON.stringify(results)).toContain('Host evidence');
});

it('charges a throwing extension once and preserves its real error', async () => {
  const unregister = registerTool({ name: 'budget_failure_probe', description: 'Offline failure fixture.',
    input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly',
    handler: async () => { throw new Error('Actual extension failure'); } });
  try {
    for (const bridged of [false, true]) {
      const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0 };
      const agent = buildRunnerAgentChain({ backups: new Map() }, undefined, budget).worker;
      const tool = agent.tools!.find(t => t.name === (bridged ? 'tool_call' : 'budget_failure_probe'))!;
      const result = await tool.execute(bridged ? { name: 'budget_failure_probe', input: {} } : {}, { agent, toolCallId: 'failure' });
      expect(result).toMatchObject({ isError: true, content: '[Tool Error] budget_failure_probe: Actual extension failure' });
      expect(budget.spentBudget).toBe(1);
    }
  } finally { unregister(); }
});

it.each([{}, { name: 'tool_call', input: {} }, { name: 'read', input: [] }, { name: 'inactive_budget_tool', input: {} }])(
  'still charges one malformed/unavailable bridge attempt: %j', async input => {
    const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0 };
    const agent = buildRunnerAgentChain({ backups: new Map() }, undefined, budget).worker;
    const result = await agent.tools!.find(t => t.name === 'tool_call')!.execute(input, { agent, toolCallId: 'invalid' });
    expect(result.isError).toBe(true);
    expect(budget.spentBudget).toBe(1);
  });

it.each([false, true])('keeps permission denial free of target work and permits later recovery (bridge=%s)', async bridged => {
  let executions = 0;
  const unregister = registerTool({ name: 'permission_budget_probe', description: 'Offline permission fixture.',
    input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly',
    handler: async () => { executions++; return 'Recovered evidence'; } });
  try {
    let permissions = 0;
    const events: KodaXEvents = { beforeToolExecute: async name => name !== 'permission_budget_probe' || permissions++ > 0
      ? true : '[Tool Error] permission denied' };
    const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0 };
    const agent = buildRunnerAgentChain({ backups: new Map() }, undefined, budget, undefined, undefined, events).worker;
    let round = 0;
    const result = await Runner.run(agent, 'Recover after a refused operation.', {
      tracer: null,
      toolObserver: { beforeTool: async call => (await getToolExecutionOverride(events, call.name, call.input, call.id)) ?? true },
      llm: async messages => {
        if (round === 1) {
          expect(JSON.stringify(messages)).toContain('permission denied');
          expect(budget.spentBudget).toBe(0);
        }
        return round++ < 2 ? { text: '', toolCalls: [{ id: 'attempt-' + round,
          name: bridged ? 'tool_call' : 'permission_budget_probe',
          input: bridged ? { name: 'permission_budget_probe', input: {} } : {} }] } : { text: 'Recovered evidence.' };
      },
    });
    expect(result.output).toBe('Recovered evidence.');
    expect(permissions).toBe(2);
    expect(executions).toBe(1);
    expect(budget.spentBudget).toBe(1);
  } finally { unregister(); }
});

it('does not charge or execute a target cancelled while permission is pending', async () => {
  const abort = new AbortController();
  const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0 };
  const events: KodaXEvents = { beforeToolExecute: async () => { abort.abort(); return true; } };
  const agent = buildRunnerAgentChain({ backups: new Map() }, undefined, budget, undefined, undefined, events).worker;
  await expect(agent.tools!.find(t => t.name === 'tool_call')!.execute({ name: 'todo_create', input: { subject: 'Never execute' } },
    { agent, toolCallId: 'cancelled', abortSignal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(budget.spentBudget).toBe(0);
});
