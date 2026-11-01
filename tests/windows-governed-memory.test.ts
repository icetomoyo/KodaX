import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { toolBash } from '@kodax-ai/coding';
import { createAsrtShellSandbox, doctorSandboxRuntime } from '../src/sandbox-runtime.js';

// Reuse an already provisioned backend. Never repair shared users, ACLs or
// setup markers from this regression; CI provisions its own runner separately.
it.runIf(process.platform === 'win32' && process.env.KODAX_REAL_WINDOWS_MEMORY === '1')(
  'enforces governed Memory writes through the real Windows OS sandbox', async () => {
    const doctor = await doctorSandboxRuntime({ refresh: true });
    expect(doctor.ready, doctor.diagnostics.join('\n')).toBe(true);
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'kodax-memory-os-'));
    const home = path.join(root, '.kodax');
    const scoped = path.join(home, 'memory-scopes', 'a'.repeat(64), 'project', 'b'.repeat(64), 'retain.md');
    const legacy = path.join(home, 'projects', 'fixture', 'memory', 'retain.md');
    try {
      for (const file of [scoped, legacy]) {
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'retained-memory');
      }
      setAgentConfigHome(home);
      const program = path.join(root, 'probe.cjs');
      await fs.writeFile(program, `const fs = require('node:fs');
const paths = ${JSON.stringify([scoped, legacy])};
for (const file of paths) {
  if (fs.readFileSync(file, 'utf8') !== 'retained-memory') throw Error('Memory read failed');
  let denied = false;
  try { fs.writeFileSync(file, 'forbidden'); } catch (error) { if (!['EACCES','EPERM'].includes(error.code)) throw error; denied = true; }
  if (!denied) throw Error('Memory write escaped OS mask');
}
fs.writeFileSync(${JSON.stringify(path.join(root, 'normal.txt'))}, 'allowed');
process.stdout.write('MEMORY_OS_BOUNDARY_VERIFIED');`);
      const observations: string[] = [];
      const result = await toolBash({ command: `"${process.execPath}" "${program}"`, timeout: 30 }, {
        backups: new Map(), executionCwd: root, configHome: home, toolCallId: 'memory-os-boundary',
        resolveShellPermissionMode: () => 'auto',
        shellSandbox: createAsrtShellSandbox({ workspaceRoot: root, shouldSandbox: () => true }),
        reportToolSandboxObservation: observation => { observations.push(JSON.stringify(observation)); },
        authorizeShellHostExecution: async () => { throw new Error(`OS regression must never fall back to Host execution. ${observations.join('\n')}`); },
      });
      expect(result).toContain('MEMORY_OS_BOUNDARY_VERIFIED');
      for (const file of [scoped, legacy]) expect(await fs.readFile(file, 'utf8')).toBe('retained-memory');
      expect(await fs.readFile(path.join(root, 'normal.txt'), 'utf8')).toBe('allowed');
    } finally { setAgentConfigHome(undefined); await fs.rm(root, { recursive: true, force: true }); }
  }, 60_000,
);
