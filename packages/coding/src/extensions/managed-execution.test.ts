import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createExtensionRuntime } from './runtime.js';
import { executeToolCall } from '../agent-runtime/tool-dispatch.js';
import { buildRuntimeSessionState } from '../agent-runtime/runtime-session-state.js';

describe('managed extension execution', () => {
  it('joins unawaited nested tool cleanup after the Run is cancelled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-extension-drain-'));
    const runtime = createExtensionRuntime();
    const file = path.join(directory, 'drain.mjs');
    await writeFile(file, `export default api => {
      api.registerTool({ name: 'managed_wait', description: 'wait', sideEffect: 'readonly',
        input_schema: { type: 'object', properties: {} }, handler: async (_input, ctx) => {
          ctx.reportToolProgress('started');
          await new Promise(resolve => ctx.abortSignal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true }));
          ctx.reportToolProgress('cleaned');
          return '[Cancelled] stopped';
        } });
      api.registerTool({ name: 'managed_launch', description: 'launch', sideEffect: 'readonly',
        input_schema: { type: 'object', properties: {} }, handler: async () => {
          void api.getExecutionScope().invokeTool('managed_wait', {});
          return 'launched';
        } });
    }`);
    try {
      await runtime.loadExtension(file);
      const controller = new AbortController();
      const reportToolProgress = vi.fn();
      let settled = false;
      const result = executeToolCall({}, { id: 'launch', name: 'managed_launch', input: {} },
        { backups: new Map(), sessionId: 's', runtimeRunId: 'r', extensionRuntime: runtime,
          abortSignal: controller.signal, reportToolProgress },
        buildRuntimeSessionState({ activeTools: ['managed_launch', 'managed_wait'] }),
        ['managed_launch', 'managed_wait'], controller.signal).then((value) => { settled = true; return value; });
      await vi.waitFor(() => expect(reportToolProgress).toHaveBeenCalledWith('started'));
      expect(settled).toBe(false);
      controller.abort();
      expect(settled).toBe(false);
      await expect(result).resolves.toBe('launched');
      expect(reportToolProgress).toHaveBeenLastCalledWith('cleaned');
    } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  it('binds command and capability handlers to the same admitted invocation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-managed-contributions-'));
    const runtime = createExtensionRuntime();
    const extensionPath = path.join(directory, 'managed.mjs');
    await writeFile(extensionPath, `export default api => {
      api.registerCommand({ name: 'probe-command', description: 'probe', handler: async (_args, ctx) => {
        if (!ctx.extensionExecution || api.getExecutionScope() !== ctx.extensionExecution) throw new Error('missing command scope');
        return { message: ctx.extensionExecution.runId };
      }});
      api.registerCapabilityProvider({ id: 'managed-provider', kinds: ['tool'], execute: async (_id, _input, scope) => {
        if (!scope || api.getExecutionScope() !== scope) throw new Error('missing capability scope');
        return { kind: 'tool', content: await scope.invokeTool('write', { path: 'denied', content: 'x' }) };
      }});
      api.registerTool({ name: 'contribution_probe', description: 'probe', sideEffect: 'readonly',
        input_schema: { type: 'object', properties: {} }, handler: async (_input, ctx) => {
          const command = await ctx.extensionRuntime.getCommand('probe-command').handler([], {
            workingDirectory: ctx.executionCwd, extensionExecution: ctx.extensionExecution });
          const capability = await ctx.extensionRuntime.executeCapability('managed-provider', 'effect', {});
          return JSON.stringify({ command: command.message, capability: capability.content });
        } });
    }`);
    try {
      await runtime.loadExtension(extensionPath);
      const result = await executeToolCall({ beforeToolExecute: async (name) => name === 'write' ? '[Blocked] explicit rule' : undefined },
        { id: 'contribution-1', name: 'contribution_probe', input: {} },
        { backups: new Map(), sessionId: 'session-b', runtimeRunId: 'run-b', extensionRuntime: runtime },
        buildRuntimeSessionState({ activeTools: ['contribution_probe', 'write'] }), ['contribution_probe', 'write']);
      expect(JSON.parse(String(result))).toEqual({ command: 'run-b', capability: '[Blocked] explicit rule' });
    } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  it('loads a real extension and routes nested effects through the calling Run permission gate', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-managed-extension-'));
    const runtime = createExtensionRuntime();
    const extensionPath = path.join(directory, 'managed.mjs');
    await writeFile(extensionPath, `export default api => {
      if (api.getExecutionScope() !== undefined) throw new Error('activation has no Run');
      api.registerTool({ name: 'managed_probe', description: 'probe', sideEffect: 'readonly',
        input_schema: { type: 'object', properties: {} }, handler: async (_input, ctx) => {
          const scope = api.getExecutionScope();
          if (scope !== ctx.extensionExecution) throw new Error('scope mismatch');
          scope.reportProgress({ message: 'checking', data: { step: 1 } });
          const result = await scope.invokeTool('write', { path: 'blocked.txt', content: 'forbidden' });
          return JSON.stringify({ sessionId: scope.sessionId, runId: scope.runId,
            invocationId: scope.invocationId, extensionId: scope.extensionId, result });
        } });
    }`);
    try {
      await runtime.loadExtension(extensionPath);
      const onToolBefore = vi.fn(async (name: string) => name === 'write' ? '[Blocked] explicit user rule' : undefined);
      const reportToolProgress = vi.fn();
      const controller = new AbortController();
      const result = await executeToolCall({ beforeToolExecute: onToolBefore }, { id: 'invocation-1', name: 'managed_probe', input: {} },
        { backups: new Map(), sessionId: 'session-a', runtimeRunId: 'run-a', executionCwd: directory,
          abortSignal: controller.signal, extensionRuntime: runtime, reportToolProgress },
        buildRuntimeSessionState({ activeTools: ['managed_probe', 'write'] }), ['managed_probe', 'write'], controller.signal);
      expect(JSON.parse(String(result))).toMatchObject({ sessionId: 'session-a', runId: 'run-a',
        invocationId: 'invocation-1', result: '[Blocked] explicit user rule' });
      expect(onToolBefore).toHaveBeenCalledWith('write', expect.objectContaining({ path: 'blocked.txt' }), expect.anything());
      expect(reportToolProgress).toHaveBeenCalled();
    } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});
