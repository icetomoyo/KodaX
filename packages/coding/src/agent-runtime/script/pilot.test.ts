import { expect, it } from 'vitest';
import { createScriptPilot } from './pilot.js';
import { buildRuntimeSessionState } from '../runtime-session-state.js';
import { markRegistryManagedAgent } from '../../tools/model-tool-definition.js';
import { markOrdinaryRootToolContract } from '../../tools/managed-tool-contract.js';
import { getToolDefinition, registerTool } from '../../tools/registry.js';
import type { KodaXToolExecutionContext } from '../../types.js';

it('shares canonical leaf text before serialization only for an explicitly supplied ordinary root', () => {
  const ctx: KodaXToolExecutionContext = { backups: new Map() };
  const activeToolNames = ['glob', 'bash'];
  const dispatch = { ctx, activeToolNames, events: {},
    runtimeSessionState: buildRuntimeSessionState({ activeTools: activeToolNames, modelSelection: {} }) };
  const budget = { totalBudget: 4, spentBudget: 0, currentHarness: 'H0_DIRECT' as const };
  const root = markRegistryManagedAgent({ name: 'worker', instructions: '',
    tools: activeToolNames.map(name => getToolDefinition(name)!) }, ctx);
  markOrdinaryRootToolContract(root);
  const baseline = createScriptPilot(dispatch, budget).tools;
  const projected = createScriptPilot(dispatch, budget, root).tools;
  expect(projected.find(tool => tool.name === 'glob')!.description).toBe('Find file paths by glob.');
  expect(baseline.find(tool => tool.name === 'glob')!.description).toBe(getToolDefinition('glob')!.description);
  const shell = projected.find(tool => tool.name === 'bash')!;
  expect(shell.description).toContain('Foreground commands only');
  expect(shell.description).not.toContain('Long commands: run_in_background');
  expect(shell.description).toContain('recoverable artifact preview');
  expect(shell.input_schema.properties.run_in_background).toEqual({ type: 'boolean', const: false, description: 'Must be false in this Script pilot.' });
  expect(getToolDefinition('bash')!.input_schema.properties.run_in_background).not.toHaveProperty('const');
  expect(budget.spentBudget).toBe(0);
  for (const context of [{ ...ctx, currentAgentId: 'child' }, { ...ctx, toolVisibilityPolicy: () => true }]) {
    expect(createScriptPilot({ ...dispatch, ctx: context }, budget, root).tools).toEqual(baseline);
  }
  const unmarked = markRegistryManagedAgent({ ...root }, ctx);
  expect(createScriptPilot(dispatch, budget, unmarked).tools).toEqual(baseline);
  const override = markRegistryManagedAgent({ ...root,
    tools: root.tools!.map(tool => tool.name === 'glob' ? { ...tool, description: 'Host-specific glob contract' } : tool) }, ctx);
  markOrdinaryRootToolContract(override);
  expect(createScriptPilot(dispatch, budget, override).tools.find(tool => tool.name === 'glob'))
    .toEqual(baseline.find(tool => tool.name === 'glob'));
  const unregister = registerTool({ ...getToolDefinition('glob')!, description: 'Host-defined glob', handler: async () => 'host' }, { source: { kind: 'extension' } });
  try { expect(createScriptPilot(dispatch, budget, root).tools.map(tool => tool.name)).toEqual(['bash']); }
  finally { unregister(); }
});
