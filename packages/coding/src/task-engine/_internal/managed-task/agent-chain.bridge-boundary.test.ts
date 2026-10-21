import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildRunnerAgentChain } from './agent-chain.js';
import type { ManagedTaskBudgetController } from './budget.js';

it('preserves read errors and recovery but records the existing native/bridge work-budget difference', async () => {
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
    // Observation, not approval to hide schemas: bridge and target both charge.
    expect(spent).toEqual([2, 4]);
  } finally {
    if (path.dirname(workspace) !== path.resolve(os.tmpdir()) || !path.basename(workspace).startsWith('kodax-bridge-budget-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
});
