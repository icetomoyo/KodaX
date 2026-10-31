import '@kodax-ai/coding';
import { expect, it } from 'vitest';
import { createRuntimeDaemonReverseBridge } from './runtime-daemon/reverse-bridge.js';
import { createExecutionProfile, executionProfileAllowsTool, hostToolMetadata } from './execution-profile.js';
import { isToolDiscoverable } from '../packages/coding/src/tools/tool-search.js';
import { toolMcpCall } from '../packages/coding/src/tools/mcp-call.js';
import { registerTool, getRegisteredToolDefinition, getAllRegisteredTools } from '@kodax-ai/coding';
import { resolveWorkMode } from '../packages/coding/src/work-mode.js';
import type { KodaXToolExecutionContext } from '@kodax-ai/coding';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KodaXExtensionRuntime } from '../packages/coding/src/extensions/runtime.js';
import { withHostInvocation } from '../packages/coding/src/agent-runtime/host-invocation.js';

it('baseline: persona alone retains generic Agent mutation tools under explicit intersection', () => {
  const profile = createExecutionProfile({ agentProfile: { id: 'partner' } });
  for (const name of ['bash', 'write', 'edit', 'spawn_agent']) expect(executionProfileAllowsTool(profile, { ...getRegisteredToolDefinition(name)!, planModeAllowed: getRegisteredToolDefinition(name)!.planModeAllowed === true })).toBe(true);
  expect(resolveWorkMode({ workMode: 'agent', context: { agentProfile: { id: 'partner' }, workModePolicy: 'intersect' } })).toBe('agent');
});

it('root profile: denying a lease tool must also deny its MCP alias', async () => {
  const dispatched: string[] = [];
  const bridge = createRuntimeDaemonReverseBridge(notification => {
    const params = notification.params as { invocationId: string; toolName: string };
    dispatched.push(params.toolName);
    bridge.completeHostTool({ invocationId: params.invocationId, result: { content: 'PROBE_EXECUTED' } });
  });
  try {
    const lease = bridge.registerHostTools({ leaseId: 'audit-root', tools: [
      { name: 'audit_denied', description: 'Denied tool', inputSchema: { type: 'object' }, sideEffect: 'non_idempotent' },
    ] });
    const profile = createExecutionProfile({ agentProfile: { id: 'partner' }, toolVisibilityPolicy: tool => tool.name !== 'audit_denied' }, [...getAllRegisteredTools().map(tool => ({ ...tool, planModeAllowed: tool.planModeAllowed === true })), ...lease.tools.map(hostToolMetadata)]);
    const runtime = bridge.createHostToolRuntime({ leaseId: lease.id, sessionId: 's', runId: 'r' });
    const ctx = { extensionRuntime: runtime, workMode: 'agent', toolVisibilityPolicy: tool => executionProfileAllowsTool(profile, tool) } as KodaXToolExecutionContext;
    expect(isToolDiscoverable('audit_denied', ctx)).toBe(false);
    expect(isToolDiscoverable('mcp_call', ctx)).toBe(true);
    const result = await toolMcpCall({ id: 'host:audit-root:audit_denied', args: {} }, ctx);
    expect({ dispatched, result }).toMatchObject({ dispatched: [] });
  } finally { bridge.close(); }
});

it('Actor ceiling: an explicitly allowed lease tool must remain callable', async () => {
  const dispatched: string[] = [];
  const bridge = createRuntimeDaemonReverseBridge(notification => {
    const params = notification.params as { invocationId: string; toolName: string };
    dispatched.push(params.toolName);
    bridge.completeHostTool({ invocationId: params.invocationId, result: { content: 'PROBE_EXECUTED' } });
  });
  try {
    bridge.registerHostTools({ leaseId: 'audit-actor', tools: [
      { name: 'audit_allowed', description: 'Allowed tool', inputSchema: { type: 'object' }, sideEffect: 'none' },
      { name: 'audit_denied', description: 'Denied tool', inputSchema: { type: 'object' }, sideEffect: 'none' },
    ] });
    const runtime = bridge.createHostToolRuntime({ leaseId: 'audit-actor', sessionId: 's', runId: 'r', allowedTools: ['audit_allowed'] });
    expect(runtime.listRunTools?.('mcp')?.map(tool => tool.name)).toEqual(['audit_allowed']);
    await expect(runtime.executeCapability('mcp', 'host:audit-actor:audit_allowed', {})).resolves.toMatchObject({ content: 'PROBE_EXECUTED' });
    expect(dispatched).toEqual(['audit_allowed']);
    await expect(runtime.executeCapability('mcp', 'host:audit-actor:audit_denied', {})).rejects.toThrow('not bound');
    bridge.revokeHostTools('audit-actor');
    expect(runtime.listRunTools?.('mcp')).toEqual([]);
    await expect(runtime.executeCapability('mcp', 'host:audit-actor:audit_allowed', {})).rejects.toThrow('revoked');
    expect(dispatched).toEqual(['audit_allowed']);
  } finally { bridge.close(); }
});

it('profile snapshot: a newly available readonly Host tool should still satisfy the original readonly policy', () => {
  const policy = (tool: { sideEffect: string }) => tool.sideEffect === 'readonly';
  const dispose = registerTool({ name: 'audit_host_readonly', description: 'Host-only readonly extension',
    input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly', planModeAllowed: true,
    toClassifierInput: input => JSON.stringify(input), handler: async () => 'PROBE_READ' });
  try {
    const profile = createExecutionProfile({ agentProfile: { id: 'partner' }, toolVisibilityPolicy: policy }, getAllRegisteredTools().map(tool => ({ ...tool, planModeAllowed: tool.planModeAllowed === true })));
    expect(policy(getRegisteredToolDefinition('audit_host_readonly')!)).toBe(true);
    expect(isToolDiscoverable('audit_host_readonly', { workMode: 'agent', toolVisibilityPolicy: tool => executionProfileAllowsTool(profile, tool) })).toBe(true);
  } finally { dispose(); }
});

it('profile snapshot: a changed implementation must be checked against the original metadata policy', () => {
  const disposeRead = registerTool({ name: 'audit_changed_tool', description: 'Readonly implementation',
    input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly', planModeAllowed: true,
    toClassifierInput: input => JSON.stringify(input), handler: async () => 'PROBE_READ' });
  const profile = createExecutionProfile({ agentProfile: { id: 'partner' }, toolVisibilityPolicy: tool => tool.sideEffect === 'readonly' }, getAllRegisteredTools().map(tool => ({ ...tool, planModeAllowed: tool.planModeAllowed === true })));
  disposeRead();
  const disposeWrite = registerTool({ name: 'audit_changed_tool', description: 'Mutating implementation',
    input_schema: { type: 'object', properties: {} }, sideEffect: 'mutates-fs', planModeAllowed: false,
    toClassifierInput: input => JSON.stringify(input), handler: async () => 'PROBE_WRITE' });
  try {
    expect(getRegisteredToolDefinition('audit_changed_tool')?.sideEffect).toBe('mutates-fs');
    expect(isToolDiscoverable('audit_changed_tool', { workMode: 'agent', toolVisibilityPolicy: tool => executionProfileAllowsTool(profile, tool) })).toBe(false);
  } finally { disposeWrite(); }
});

it('identity differential: opaque profileId spelling should not create an extra execution requirement', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-identity-audit-'));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'anthropic' });
  try {
    const client = toKodaXProductClient(runtime);
    const observations: Record<string, string> = {};
    for (const profileId of ['research-persona', 'research-partner']) {
      const session = await client.sessions.create({ surface: 'code', profileId, projectPath: homeDir });
      await client.sessions.updateSettings(session.id, { workMode: 'agent', permissionMode: 'full-access' });
      try {
        const accepted = await client.runs.startTool({ sessionId: session.id, inputId: 'probe', rawInput: 'Read policy metadata',
          name: 'tool_search', input: { query: 'select:read' } });
        observations[profileId] = (await client.runs.await(accepted.runId)).phase;
      } catch (error) { observations[profileId] = error instanceof Error ? error.message : String(error); }
    }
    expect(observations).toEqual({ 'research-persona': 'completed', 'research-partner': 'completed' });
  } finally { await runtime.close(); await rm(homeDir, { recursive: true, force: true }); }
});

it('explicit invocation reports the hydrated runtime ceiling instead of initialization defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kodax-profile-hydrate-'));
  const runtime = new KodaXExtensionRuntime();
  try {
    const file = join(directory, 'hydrate.mjs');
    await writeFile(file, "export default api => { api.hook('session:hydrate', () => api.runtime.setActiveTools(['read'])); };\n");
    await runtime.loadExtension(file);
    let scope: readonly string[] | undefined;
    await withHostInvocation({ provider: 'fixture', extensionRuntime: runtime, context: { executionCwd: directory },
      events: { onEffectiveConfig: config => { scope = config.toolScope; } } }, 'Inspect', async host => {
      expect(host.state.activeTools).toEqual(['read']);
      expect(scope).toEqual(['read']);
    });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
