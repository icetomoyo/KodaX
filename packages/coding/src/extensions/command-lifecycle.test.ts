import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createExtensionRuntime } from './runtime.js';
import { runToolInvocation } from '../agent-runtime/tool-invocation.js';

it('revokes command and managed tool together and restores the previous same-name registration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-command-lifecycle-'));
  const runtime = createExtensionRuntime();
  const file = path.join(directory, 'commands.mjs');
  try {
    await writeFile(file, `export default api => {
      const disposers = ['old', 'new'].map(message => api.registerCommand({ name: 'layered', description: 'layered', handler: async () => ({ message }) }));
      api.registerTool({ name: 'unregister_command', description: 'unregister', sideEffect: 'readonly',
        input_schema: { type: 'object', properties: {} }, handler: async () => { disposers.pop()?.(); return 'removed'; } });
    }`);
    await runtime.loadExtension(file);
    const invoke = (name: string) => runToolInvocation({ provider: 'unconfigured-provider', extensionRuntime: runtime,
      context: { executionCwd: directory } }, { name, input: {} });
    expect((await invoke('extension_command__layered')).lastText).toBe('{"message":"new"}');
    await invoke('unregister_command');
    expect(runtime.getCommand('layered')).toBeDefined();
    expect((await invoke('extension_command__layered')).lastText).toBe('{"message":"old"}');
    await invoke('unregister_command');
    expect(runtime.getCommand('layered')).toBeUndefined();
    expect((await invoke('extension_command__layered')).success).toBe(false);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});
