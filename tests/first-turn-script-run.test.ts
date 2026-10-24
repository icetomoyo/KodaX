import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { FileSessionStorage } from '../packages/repl/src/interactive/storage.js';
import { runScriptInvocation } from '../packages/coding/src/agent-runtime/script/run.js';
import type { KodaXOptions } from '../packages/coding/src/types.js';
import { assertTrustedTextMutationPolicy } from '../packages/coding/src/trusted-text-mutation.js';
import { createTrustedTextMutationHost } from '../src/windows-text-transaction.js';

const limits = { timeoutMs: 5000, memoryBytes: 16 * 1024 * 1024, maxCalls: 8, maxTransferBytes: 128 * 1024 };
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-script-run-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-script-run-'));
  directories.push(root);
  vi.stubEnv('KODAX_HOME', root);
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions'), configHome: root, cwd: root });
  const options: KodaXOptions = { provider: 'unconfigured-provider', lsp: false,
    session: { id: 'script-session', storage, resume: true },
    context: { executionCwd: root, gitRoot: root, runtimeRunId: 'script-run-one' } };
  await writeFile(path.join(root, 'value.txt'), 'before');
  return { root, storage, options };
}

it('durably owns partial effects and resumes evidence without replaying a previous Script cell', async () => {
  const { root, storage, options } = await fixture();
  const first = await runScriptInvocation(options, `await tools.edit({path:'value.txt',old_string:'before',new_string:'after'}); throw new Error('later failure');`, limits);
  expect(first.success).toBe(false);
  expect(first.scriptCell).toMatchObject({ status: 'failed', receipts: [{ name: 'edit' }] });
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('after');
  const reloaded = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions'), configHome: root, cwd: root });
  const saved = await reloaded.load('script-session');
  expect(saved?.extensionRecords?.filter(record => record.extensionId === 'kodax.script').map(record => record.type))
    .toEqual(['cell.started', 'call.started', 'call.settled', 'cell.settled']);
  expect(JSON.stringify(saved?.extensionRecords)).toContain('script-run-one');
  const permission = vi.fn(async () => true);
  const next = await runScriptInvocation({ ...options, session: { ...options.session, storage: reloaded },
    context: { ...options.context, runtimeRunId: 'script-run-two' }, events: { beforeToolExecute: permission } },
  "return await tools.read({path:'value.txt'});", limits);
  expect(next.success).toBe(true);
  expect(permission.mock.calls).toHaveLength(1);
  expect(next.scriptCell.receipts[0]?.result.content).toContain('after');
  expect((await storage.load('script-session'))?.extensionRecords?.filter(record => record.type === 'cell.settled')).toHaveLength(2);
  expect((await storage.load('script-session'))?.extensionRecords?.at(-1)?.data)
    .toMatchObject({ data: { value: { content: expect.stringContaining('after') } } });
});

it('uses the production trusted write host, retains path refusal and persists partial creation without replay', async () => {
  const { root, storage, options } = await fixture();
  vi.stubEnv('NODE_ENV', 'production');
  const host = createTrustedTextMutationHost(() => [root], target => assertTrustedTextMutationPolicy(target, root));
  const snapshot = vi.spyOn(host, 'snapshot');
  const commit = vi.spyOn(host, 'commit');
  const outside = path.join(path.dirname(root), path.basename(root) + '-outside.txt');
  const input = { path: outside, content: 'must not escape' };
  const original = structuredClone(input);
  const bound = { ...options, context: { ...options.context, trustedTextMutationHost: host } };
  const result = await runScriptInvocation(bound, `
    const rejected = await tools.write(${JSON.stringify(input)});
    if (!rejected.isError) throw new Error('Expected host path refusal');
    const created = await tools.write({path:'created/note.txt',content:'retained'});
    if (created.isError) throw new Error(created.content);
    throw new Error('later script failure');
  `, limits);
  expect(result.scriptCell).toMatchObject({ status: 'failed', error: expect.stringContaining('later script failure') });
  expect(result.scriptCell.receipts.map(receipt => receipt.result.isError)).toEqual([true, false]);
  expect(result.scriptCell.receipts[0]?.input).toEqual(original);
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(commit).toHaveBeenCalledTimes(1);
  await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(root, 'created/note.txt'), 'utf8')).toBe('retained');
  const saved = await storage.load('script-session');
  expect(saved?.extensionRecords?.filter(record => record.type === 'call.settled')).toHaveLength(2);
  expect(saved?.extensionRecords?.filter(record => record.type === 'call.settled').at(-1)?.data)
    .toMatchObject({ data: { name: 'write', input: { path: 'created/note.txt', content: 'retained' }, result: { isError: false } } });
  const recovered = await runScriptInvocation(bound, "return await tools.read({path:'created/note.txt'});", limits);
  expect(recovered.success).toBe(true);
  expect(recovered.scriptCell.receipts).toHaveLength(1);
  expect(recovered.scriptCell.receipts[0]?.result.content).toContain('retained');
  expect(commit).toHaveBeenCalledTimes(1);
});

it.each(['edit', 'write'])('waits for an admitted leaf on Run cancellation, persists receipts and admits no later %s', async nextTool => {
  const { root, storage, options } = await fixture();
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let finished = false;
  const operation = runScriptInvocation({ ...options, abortSignal: controller.signal,
    events: { beforeToolExecute: async name => {
      if (name === 'read') { entered(); await gate; }
      return true;
    } } }, "await tools.read({path:'value.txt'}); " + (nextTool === 'write'
    ? "await tools.write({path:'value.txt',content:'bad'});"
    : "await tools.edit({path:'value.txt',old_string:'before',new_string:'bad'});"), limits)
    .then(result => { finished = true; return result; });
  try {
    await ready;
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(finished).toBe(false);
    release();
    const result = await operation;
    expect(result).toMatchObject({ success: false, interrupted: true, scriptCell: { status: 'cancelled' } });
    expect(result.scriptCell.receipts).toHaveLength(1);
    expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('before');
    expect((await storage.load('script-session'))?.extensionRecords?.at(-1)?.data)
      .toMatchObject({ runId: 'script-run-one', data: { status: 'cancelled' } });
  } finally { release(); await operation; }
});

it('stops after receipt persistence fails, retaining the partial effect and refusing the next queued write', async () => {
  const { root, storage, options } = await fixture();
  const save = storage.save.bind(storage);
  let rejected = false;
  vi.spyOn(storage, 'save').mockImplementation(async (id, data) => {
    if (!rejected && data.extensionRecords?.at(-1)?.type === 'call.settled') {
      rejected = true;
      throw new Error('Fixture disk failure');
    }
    return save(id, data);
  });
  const result = await runScriptInvocation(options, `await tools.edit({path:'value.txt',old_string:'before',new_string:'after'});
    await tools.edit({path:'value.txt',old_string:'after',new_string:'must not execute'});`, limits);
  expect(result.scriptCell).toMatchObject({ status: 'failed', error: expect.stringContaining('Fixture disk failure') });
  expect(result.scriptCell.receipts).toHaveLength(1);
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('after');
  expect((await storage.load('script-session'))?.extensionRecords?.at(-1)?.data).toMatchObject({ data: { status: 'failed' } });
});

it('refuses effects without durable storage, or if the initial boundary cannot be saved', async () => {
  const { root, storage, options } = await fixture();
  const code = "await tools.edit({path:'value.txt',old_string:'before',new_string:'bad'});";
  await expect(runScriptInvocation({ ...options, session: undefined }, code, limits)).rejects.toThrow('canonical Session storage');
  await expect(runScriptInvocation({ ...options, session: { ...options.session, persistedByHost: true } }, code, limits)).rejects.toThrow('canonical Session storage');
  vi.spyOn(storage, 'save').mockRejectedValue(new Error('Fixture storage unavailable'));
  await expect(runScriptInvocation(options, code, limits)).rejects.toThrow('Fixture storage unavailable');
  expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('before');
});

it('validates cell limits before accepting or persisting its source', async () => {
  const { options, storage } = await fixture();
  const save = vi.spyOn(storage, 'save');
  await expect(runScriptInvocation(options, 'return 42;', { ...limits, maxCalls: 0 })).rejects.toThrow('positive safe integers');
  await expect(runScriptInvocation(options, 'return 42;', { ...limits, maxTransferBytes: 1 })).rejects.toThrow('source exceeds');
  expect(save).not.toHaveBeenCalled();
});

it('uses the existing Run work budget instead of creating a second allowance', async () => {
  const { options } = await fixture();
  const budget = { totalBudget: 2, spentBudget: 1, currentHarness: 'H0_DIRECT' as const };
  const started = vi.fn();
  const result = await runScriptInvocation({ ...options, context: { ...options.context, managedWorkBudget: budget },
    events: { onToolExecutionStart: started } },
  "await tools.read({path:'value.txt'}); return await tools.read({path:'value.txt'});", limits);
  expect(started).toHaveBeenCalledTimes(1);
  expect(budget.spentBudget).toBe(2);
  expect(result.success).toBe(false);
  expect(result.scriptCell.receipts[1]?.result.content).toContain('budget exhausted');
});

it.each([0, 7])('preserves actual shell exit %i in the durable Run outcome', async exitCode => {
  const { options, storage } = await fixture();
  const result = await runScriptInvocation({ ...options, context: { ...options.context,
    resolveShellPermissionMode: () => 'full-access', authorizeShellHostExecution: async () => true } },
  `return await tools.bash({command:'node -e "process.exit(${exitCode})"'});`, limits);
  expect(result.success).toBe(exitCode === 0);
  expect(result.scriptCell.receipts[0]?.result.content).toContain(`Exit: ${exitCode}`);
  expect(result.scriptCell.receipts[0]?.result.metadata).toMatchObject({ shellExecutionOutcome: { success: exitCode === 0 } });
  const saved = await storage.load('script-session');
  expect(saved?.extensionRecords?.find(record => record.type === 'call.settled')?.data)
    .toMatchObject({ data: { result: { metadata: { shellExecutionOutcome: { success: exitCode === 0 } } } } });
});

it('reloads receipts after abrupt host termination without treating an unfinished cell as a replay queue', async () => {
  const { root, storage, options } = await fixture();
  const source = `import {runScriptInvocation} from ${JSON.stringify(new URL('../packages/coding/src/agent-runtime/script/run.ts', import.meta.url).href)};
    import {FileSessionStorage} from ${JSON.stringify(new URL('../packages/repl/src/interactive/storage.ts', import.meta.url).href)};
    const root=${JSON.stringify(root)};
    await runScriptInvocation({provider:'unconfigured-provider',lsp:false,
      session:{id:'script-session',storage:new FileSessionStorage({sessionsDir:root+'/sessions',configHome:root,cwd:root})},
      context:{executionCwd:root,gitRoot:root,runtimeRunId:'crashed-run'},
      events:{beforeToolExecute:async(name)=>{if(name==='read'){process.stdout.write('RECEIPT_DURABLE');await new Promise(()=>{});}return true;}}},
      "await tools.edit({path:'value.txt',old_string:'before',new_string:'after'}); await tools.read({path:'value.txt'});", ${JSON.stringify({ ...limits, timeoutMs: 30_000 })});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
  const exit = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Child did not reach durable boundary: ${stderr}`)), 20_000);
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('RECEIPT_DURABLE')) { clearTimeout(timer); resolve(); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Unexpected child exit: ${stderr}`)); });
    });
    child.kill();
    await exit;
    const saved = await storage.load('script-session');
    expect(saved?.extensionRecords?.map(record => record.type)).toEqual(['cell.started', 'call.started', 'call.settled', 'call.started']);
    expect(await readFile(path.join(root, 'value.txt'), 'utf8')).toBe('after');
    const next = await runScriptInvocation(options, "return await tools.read({path:'value.txt'});", limits);
    expect(next.success).toBe(true);
    expect(next.scriptCell.receipts).toHaveLength(1);
    expect((await storage.load('script-session'))?.extensionRecords?.filter(record => record.type === 'call.settled')).toHaveLength(2);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; }
}, 35_000);
