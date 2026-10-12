import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { toolBash } from '../tools/bash.js';
import type { KodaXToolExecutionContext } from '../types.js';
import type { ExtensionExecutionScope } from './execution-contract.js';
import { executeManagedProcess } from './managed-process.js';

const directories: string[] = [];
afterEach(async () => {
  setAgentConfigHome(undefined);
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture(signal = new AbortController().signal) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-argv 中文 '));
  directories.push(directory); setAgentConfigHome(directory);
  const decisions: unknown[] = [];
  const ctx: KodaXToolExecutionContext = { backups: new Map(), executionCwd: directory, abortSignal: signal,
    resolveShellPermissionMode: () => 'full-access',
    authorizeShellHostExecution: async request => { decisions.push(request); return true; } };
  const scope: ExtensionExecutionScope = { version: 1, sessionId: 's', runId: 'r', invocationId: 'i',
    extensionId: 'test', signal, reportProgress: () => undefined,
    invokeTool: async (name, input) => { expect(name).toBe('bash'); return toolBash(input, ctx); } };
  return { scope, decisions, directory, ctx };
}
describe('checked fixed process execution', () => {
  it('preserves literal argv through the normal host authorization boundary', async () => {
    const { scope, decisions } = await fixture();
    const args = ['中文 空格', '$HOME', '$(echo unsafe)', 'a;b&c', '"quoted"', String.fromCharCode(96) + 'literal' + String.fromCharCode(96)];
    const result = await executeManagedProcess(scope, { executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], timeoutSeconds: 10 });
    expect(result).toContain(JSON.stringify(args));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args] });
  });
  it('isolates overlapping invocation bindings and freezes caller argv', async () => {
    const { scope, decisions } = await fixture();
    const args = ['-e', 'setTimeout(()=>process.stdout.write("FIRST"),50)'];
    const first = executeManagedProcess(scope, { executable: process.execPath, args });
    args[1] = 'process.stdout.write("MUTATED")';
    const second = executeManagedProcess(scope, { executable: process.execPath, args: ['-e', 'process.stdout.write("SECOND")'] });
    const results = await Promise.all([first, second]);
    expect(results[0]).toContain('\nFIRST'); expect(results[0]).not.toContain('MUTATED');
    expect(results[1]).toContain('\nSECOND'); expect(decisions).toHaveLength(2);
  });
  it('routes fixed executable and args through the existing sandbox, with no host decision', async () => {
    const { scope, decisions, ctx } = await fixture();
    ctx.resolveShellPermissionMode = () => 'accept-edits';
    const prepare = vi.fn(async (input: { executable?: string; args?: string[]; env: NodeJS.ProcessEnv }) => ({
      executable: input.executable!, args: input.args!, env: input.env, cleanup: async () => undefined,
    }));
    ctx.shellSandbox = { prepare } as unknown as KodaXToolExecutionContext['shellSandbox'];
    const output = await executeManagedProcess(scope, { executable: process.execPath, args: ['-e', 'process.stdout.write("SANDBOX")'] });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ executable: process.execPath, args: ['-e', 'process.stdout.write("SANDBOX")'], fallbackToNormalExecution: false }));
    expect(output).toContain('\nSANDBOX'); expect(output).not.toContain('[Unknown]'); expect(decisions).toHaveLength(0);
  });
  it('does not spawn after host denial or cancellation', async () => {
    const controller = new AbortController(); const { scope, ctx } = await fixture(controller.signal);
    ctx.authorizeShellHostExecution = async () => false;
    const input = { executable: process.execPath, args: ['-e', 'process.stdout.write("NEVER")'] };
    expect(await executeManagedProcess(scope, input)).not.toContain('\nNEVER');
    controller.abort(); expect(await executeManagedProcess(scope, input)).toContain('[Cancelled]');
  });
  it('rejects changed descriptors and invalid process authority', async () => {
    const { scope, ctx } = await fixture();
    const changed = { ...scope, invokeTool: async (_name: string, input: Record<string, unknown>) => toolBash({ ...input, command: 'echo bypass' }, ctx) };
    await expect(executeManagedProcess(changed, { executable: process.execPath, args: [] })).rejects.toThrow(/descriptor/);
    expect(() => executeManagedProcess(scope, { executable: 'node', args: [] })).toThrow(/absolute/);
    expect(() => executeManagedProcess(scope, { executable: process.execPath, args: ['\0'] })).toThrow(/arguments/);
    expect(() => executeManagedProcess(scope, { executable: process.execPath, args: [], timeoutSeconds: 601 })).toThrow(/timeout/);
  });
  it('settles cancellation of an in-flight fixed process through Bash', async () => {
    const controller = new AbortController(); const { scope, directory } = await fixture(controller.signal);
    const marker = path.join(directory, 'started');
    const pending = executeManagedProcess(scope, { executable: process.execPath, args: ['-e',
      'require("node:fs").writeFileSync(process.argv[1],"started");setInterval(()=>{},1000)', marker] });
    for (let step = 0; step < 100; step++) {
      try { await fs.access(marker); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await fs.access(marker); controller.abort();
    expect(await pending).toMatch(/cancel|abort/i);
  });
});
