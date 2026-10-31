import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { FrozenInput } from './first-turn-eval-support.js';
import { prepareActivationCapacityPair } from './contract-activation-capacity.js';

it('uses a real full controller and adapter-projected capacity without changing shared refusal facts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-activation-capacity-'));
  vi.stubGlobal('fetch', () => { throw new Error('Offline capacity fixture must not access the network'); });
  const tools = ['todo_create', 'todo_update', 'todo_list', 'spawn_agent', 'list_agents', 'followup_task', 'send_message', 'wait_agent', 'agent_output', 'interrupt_agent', 'read', 'grep', 'glob', 'tool_search', 'tool_call', 'skill']
    .map(name => ({ name, description: 'Fixture contract', input_schema: { type: 'object' as const, properties: {} } }));
  const base: FrozenInput = { system: 'Retained actual root system stand-in\nWorking Directory: <OLD>', tools, messages: [] };
  try {
    const pair = await prepareActivationCapacityPair(root, base, { ...base, system: 'Candidate actual root system stand-in\nWorking Directory: <OLD>' });
    expect(pair.facts.snapshot).toMatchObject({ activeNonRootTurns: 3, maxConcurrentThreads: 4 });
    expect(pair.facts.inspectChild).toMatchObject({ path: '/root/inspect-child', capabilities: { filesystem: 'read' } });
    expect(JSON.parse(pair.facts.denial)).toMatchObject({ ok: false, error: { code: 'agent_limit_reached', activeNonRootTurns: 3 } });
    expect(pair.baseline.messages.slice(1)).toEqual(pair.candidate.messages.slice(1));
    expect(pair.baseline.messages[0]!.content).toContain('At this prompt snapshot, 3 non-root turns are active and 0 child start slots are available');
    expect(pair.candidate.messages[0]!.content).toContain('Snapshot: 3 active non-root turns; 0 child start slots available');
    expect(pair.candidate.messages[0]!.content).toContain('emit at most 0 `spawn_agent` calls');
    expect(pair.candidate.messages[0]!.content).not.toContain('At this prompt snapshot');
    expect(pair.baseline.system).toContain(`Working Directory: ${pair.facts.workspace}`); expect(pair.candidate.system).toContain('Candidate actual');
    expect(pair.candidate.system).toContain(`Working Directory: ${pair.facts.workspace}`);
    expect(pair.candidate.tools).toEqual(base.tools);
    expect(new Set(pair.facts.adapterToolNames)).toEqual(new Set(base.tools.map(tool => tool.name)));
    expect(pair.scope).toContain('capture-derived');
    expect(pair.externalModelCalls).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-activation-capacity-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});
