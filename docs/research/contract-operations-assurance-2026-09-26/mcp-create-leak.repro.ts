// Audit reproduction at 6e5d6298. To rerun, copy to src/audit-mcp-create-leak.test.ts,
// run npx vitest run src/audit-mcp-create-leak.test.ts --maxWorkers=1 --minWorkers=1,
// then remove that temporary test. This evidence copy is not a default test input.
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import { createKodaXRuntime } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

it('audit: failed per-session MCP persistence retains a live child until Host closes', async () => {
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
    expect(() => process.kill(pid, 0)).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(() => process.kill(pid, 0)).not.toThrow();
  } finally {
    await runtime.close();
    if (pid) await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
