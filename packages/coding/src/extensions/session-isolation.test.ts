import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { combineExtensionRuntimes, createExtensionRuntime, withExtensionRuntimeContext } from './runtime.js';
import { executeTool } from '../tools/registry.js';
import { buildRuntimeSessionState } from '../agent-runtime/runtime-session-state.js';
import { createExtensionRuntimeSessionController } from '../agent-runtime/middleware/extension-queue.js';

describe('extension Session isolation', () => {
  it.each([false, true])('pins before admission and drains disposal (combined=%s)', async (combined) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-extension-admission-'));
    const runtime = createExtensionRuntime();
    const secondary = createExtensionRuntime();
    const host = combined ? combineExtensionRuntimes(runtime, secondary) : runtime;
    const file = path.join(directory, 'admission.mjs');
    const source = (version: string) => `export default api => {
      let disposed = false;
      api.registerTool({ name: 'admission_probe', description: 'probe', sideEffect: 'readonly',
        input_schema: { type: 'object', properties: {} }, handler: async () => {
          if (disposed) throw new Error('disposed during admission'); return '${version}';
        } });
      return () => { api.runtime.getActiveTools(); disposed = true; };
    }`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      await writeFile(file, source('old'));
      await runtime.loadExtension(file);
      const run = withExtensionRuntimeContext(async () => {
        await gate;
        const unbind = runtime.bindController(createExtensionRuntimeSessionController(buildRuntimeSessionState({ activeTools: ['admission_probe'] })));
        try { return await executeTool('admission_probe', {}, { backups: new Map() }); }
        finally { unbind(); }
      }, host);
      await writeFile(file, source('new'));
      await runtime.loadExtension(file);
      let disposed = false;
      const disposal = runtime.dispose().then(() => { disposed = true; });
      await Promise.resolve();
      expect(disposed).toBe(false);
      release();
      await expect(run).resolves.toBe('old');
      await disposal;
    } finally { release(); await runtime.dispose(); await secondary.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  it('selects same-name tool contributions from the admitted Runtime instance', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-tools-'));
    const first = createExtensionRuntime(); const second = createExtensionRuntime();
    try {
      for (const [name, runtime] of [['first', first], ['second', second]] as const) {
        const file = path.join(directory, `${name}.mjs`);
        await writeFile(file, `export default api => api.registerTool({ name: 'instance_probe', description: 'probe',
          sideEffect: 'readonly', input_schema: { type: 'object', properties: {} }, handler: async () => '${name}' });`);
        await runtime.loadExtension(file);
      }
      await expect(withExtensionRuntimeContext(() => executeTool('instance_probe', {}, { backups: new Map() }), first)).resolves.toBe('first');
      await expect(withExtensionRuntimeContext(() => executeTool('instance_probe', {}, { backups: new Map() }), second)).resolves.toBe('second');
      await expect(withExtensionRuntimeContext(() => executeTool('instance_probe', {}, { backups: new Map() }), null))
        .resolves.toContain('[Tool Error] Unknown tool: instance_probe');
    } finally { await first.dispose(); await second.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps concurrent Session state separate and pins active tools through reload', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-extension-isolation-'));
    const runtime = createExtensionRuntime();
    const file = path.join(directory, 'isolated.mjs');
    const source = (version: string) => `export default api => {
      let disposed = false;
      api.runtime.setModelSelection({ model: '${version}' });
      api.on('text:delta', () => api.runtime.setSessionState('events',
        (api.runtime.getSessionState('events') ?? 0) + 1));
      api.registerTool({ name: 'isolated_probe', description: 'probe', sideEffect: 'readonly',
        input_schema: { type: 'object', properties: {} }, handler: async (input) => {
          if (disposed) throw new Error('disposed while active');
          api.runtime.setSessionState('value', input.value);
          await input.wait;
          return '${version}:' + api.runtime.getSessionState('value');
        } });
      return () => { disposed = true; };
    }`;
    let releaseA!: () => void;
    let releaseB!: () => void;
    const waitA = new Promise<void>((resolve) => { releaseA = resolve; });
    const waitB = new Promise<void>((resolve) => { releaseB = resolve; });
    const stateA = buildRuntimeSessionState({ activeTools: ['isolated_probe'] });
    const stateB = buildRuntimeSessionState({ activeTools: ['isolated_probe'] });
    try {
      await writeFile(file, source('old'));
      await runtime.loadExtension(file);
      const first = withExtensionRuntimeContext(async () => {
        const release = runtime.bindController(createExtensionRuntimeSessionController(stateA));
        try {
          const result = await executeTool('isolated_probe', { value: 'A', wait: waitA }, { backups: new Map() });
          const afterReload = await executeTool('isolated_probe', { value: 'A2' }, { backups: new Map() });
          return [result, afterReload];
        } finally { release(); }
      }, runtime);
      const second = withExtensionRuntimeContext(async () => {
        const release = runtime.bindController(createExtensionRuntimeSessionController(stateB));
        try { return await executeTool('isolated_probe', { value: 'B', wait: waitB }, { backups: new Map() }); }
        finally { release(); }
      }, runtime);
      await writeFile(file, source('new'));
      await runtime.loadExtension(file);
      releaseB();
      await expect(second).resolves.toBe('old:B');
      releaseA();
      await expect(first).resolves.toEqual(['old:A', 'old:A2']);
      expect(runtime.getDefaults().modelSelection.model).toBe('new');
      await withExtensionRuntimeContext(async () => {
        const release = runtime.bindController(createExtensionRuntimeSessionController(stateB));
        try {
          await runtime.emit('text:delta', { text: 'one event' });
          const values = [...stateB.extensionState.values()];
          expect(values[0]?.get('events')).toBe(1);
          await expect(executeTool('isolated_probe', { value: 'new' }, { backups: new Map() })).resolves.toBe('new:new');
        }
        finally { release(); }
      }, runtime);
      await runtime.dispose();
      expect(runtime.getDefaults().modelSelection).toEqual({});
    } finally { releaseA(); releaseB(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});
