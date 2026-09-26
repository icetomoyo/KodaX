import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import { createKodaXRuntime } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

it('releases the private MCP child when Session sidecar persistence fails', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-audit-mcp-leak-'));
  const fixture = await createMcpTestServerFixture(homeDir);
  const marker = path.join(homeDir, 'pid.txt');
  await writeFile(fixture.scriptPath, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n${await readFile(fixture.scriptPath, 'utf8')}`);
  const runtime = await createKodaXRuntime({ homeDir, mode: 'embedded' });
  const client = toKodaXProductClient(runtime);
  let pid = 0;
  try {
    const runtimeDir = path.join(homeDir, '.kodax', 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, 'session-mcp'), 'blocked directory');
    await expect(client.sessions.create({ sessionId: 'audit-mcp-leak', projectPath: homeDir, mcpServers: fixture.servers })).rejects.toMatchObject({ code: 'EEXIST' });
    pid = Number(await readFile(marker, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await expect(client.sessions.read('audit-mcp-leak')).rejects.toThrow();
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 1000 }).toBe(false);
  } finally {
    await runtime.close();
    if (pid) await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

it.each(['save-failure', 'existing-sidecar', 'cleanup-failure', 'post-rename-cleanup'] as const)('rolls back only owned MCP resources: %s', async failure => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-rollback-'));
  const fixture = await createMcpTestServerFixture(homeDir);
  const marker = path.join(homeDir, 'pid.txt');
  await writeFile(fixture.scriptPath, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n${await readFile(fixture.scriptPath, 'utf8')}`);
  const runtime = await createKodaXRuntime({ homeDir, mode: 'embedded' });
  const client = toKodaXProductClient(runtime);
  const sidecar = path.join(homeDir, '.kodax', 'runtime', 'session-mcp', 'rollback.json');
  let pid = 0;
  try {
    await mkdir(path.dirname(sidecar), { recursive: true });
    if (failure === 'existing-sidecar') await writeFile(sidecar, 'owned by an earlier attempt');
    else vi.spyOn(FileSessionStorage.prototype, 'save').mockRejectedValue(new Error('injected Session save failure'));
    if (failure === 'cleanup-failure' || failure === 'post-rename-cleanup') {
      const remove = fs.rmSync;
      vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        if (failure === 'cleanup-failure' && target === sidecar) throw new Error('injected sidecar cleanup failure');
        if (failure === 'post-rename-cleanup' && typeof target === 'string' && target.startsWith(`${sidecar}.`) && target.endsWith('.tmp')) throw new Error('injected redundant cleanup failure');
        remove(target, options);
      });
    }
    const creating = client.sessions.create({ sessionId: 'rollback', projectPath: homeDir, mcpServers: fixture.servers });
    if (failure === 'cleanup-failure') await expect(creating).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'injected Session save failure' }), expect.objectContaining({ message: 'injected sidecar cleanup failure' })],
    });
    else await expect(creating).rejects.toThrow(failure === 'existing-sidecar' ? 'Session MCP configuration already exists' : 'injected Session save failure');
    pid = Number(await readFile(marker, 'utf8'));
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 1000 }).toBe(false);
    if (failure === 'existing-sidecar') expect(await readFile(sidecar, 'utf8')).toBe('owned by an earlier attempt');
    else if (failure === 'save-failure' || failure === 'post-rename-cleanup') await expect(readFile(sidecar)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.restoreAllMocks();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
