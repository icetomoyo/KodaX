import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { toolBash } from './bash.js';
import { getGovernedMemoryShellWriteDenial } from '../permissions/permission.js';

let root = '', home = '', target = '';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bash-memory-'));
  home = path.join(root, '.kodax'); setAgentConfigHome(home);
  target = path.join(home, 'memory-scopes', 'a'.repeat(64), 'project', 'b'.repeat(64), 'retain.md');
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'retained-memory');
});
afterEach(async () => { vi.unstubAllEnvs(); setAgentConfigHome(undefined); if (root) await fs.rm(root, { recursive: true, force: true }); });

it.runIf(process.platform === 'win32')('protects direct Memory targets using Windows home aliases without blocking their copy source', () => {
  vi.stubEnv('USERPROFILE', root);
  const suffix = path.relative(root, target);
  for (const alias of ['%USERPROFILE%', '$env:USERPROFILE', '$HOME']) {
    const destination = `${alias}\\${suffix}`;
    expect(getGovernedMemoryShellWriteDenial(`echo changed>"${destination}"`, root, home)).toContain('memory tool you were given');
    expect(getGovernedMemoryShellWriteDenial(`copy "${destination}" "${path.join(root, 'copy.md')}"`, root, home)).toBeUndefined();
  }
});

it('retains destructive target roles through nested shell wrappers without treating ordinary directory creation as removal', () => {
  for (const command of [
    `cmd /c 'rmdir /s /q "${home}"'`,
    `sh -c 'rm -rf "${path.join(home, 'projects')}"'`,
  ]) expect(getGovernedMemoryShellWriteDenial(command, root, home)).toContain('memory tool you were given');
  expect(getGovernedMemoryShellWriteDenial(`mkdir "${path.join(home, 'projects', 'new')}" && rm "${path.join(root, 'unrelated.txt')}"`, root, home)).toBeUndefined();
});

it.each(['direct', 'unavailable', 'denied'] as const)('retains governed Memory before %s Host execution authorization', async route => {
  const authorize = vi.fn(async () => true);
  const result = await toolBash({ command: `echo changed>"${target}"`, timeout: 5 }, {
    backups: new Map(), configHome: home, executionCwd: root,
    resolveShellPermissionMode: () => route === 'direct' ? 'full-access' : 'auto',
    authorizeShellHostExecution: authorize,
    ...(route === 'direct' ? {} : { shellSandbox: { prepare: async () => {
      if (route === 'unavailable') throw new Error('fixture unavailable');
      return undefined;
    } } }),
  });
  expect(result).toContain('memory tool you were given');
  expect(await fs.readFile(target, 'utf8')).toBe('retained-memory');
  expect(authorize).not.toHaveBeenCalled();
});

it('tracks direct relative writes after cd without blocking Memory copy sources', async () => {
  const cd = process.platform === 'win32' ? 'cd /d' : 'cd';
  const result = await toolBash({ command: `${cd} "${path.dirname(target)}" && echo changed>retain.md`, timeout: 5 }, {
    backups: new Map(), configHome: home, executionCwd: root, resolveShellPermissionMode: () => 'full-access', authorizeShellHostExecution: async () => true,
  });
  expect(result).toContain('memory tool you were given');
  expect(await fs.readFile(target, 'utf8')).toBe('retained-memory');
  const copy = process.platform === 'win32' ? 'copy /Y' : 'cp';
  const destination = path.join(root, 'read-copy.md');
  const read = await toolBash({ command: `${copy} "${target}" "${destination}"`, timeout: 5 }, {
    backups: new Map(), configHome: home, executionCwd: root, resolveShellPermissionMode: () => 'full-access', authorizeShellHostExecution: async () => true,
  });
  expect(read).not.toContain('memory tool you were given');
  expect(await fs.readFile(destination, 'utf8')).toBe('retained-memory');
});

it('allows ordinary project writes and cd out of Memory while protecting aliases and destructive ancestors', async () => {
  const context = { backups: new Map<string, string>(), configHome: home, executionCwd: root,
    resolveShellPermissionMode: () => 'full-access' as const, authorizeShellHostExecution: async () => true };
  const alias = path.join(root, 'memory-alias');
  await fs.symlink(path.dirname(target), alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const command of [
    `echo changed>"${path.join(alias, 'retain.md')}"`,
    process.platform === 'win32' ? `rmdir /s /q "${path.join(home, 'memory-scopes')}"` : `rm -rf "${path.join(home, 'memory-scopes')}"`,
  ]) {
    expect(await toolBash({ command, timeout: 5 }, context)).toContain('memory tool you were given');
    expect(await fs.readFile(target, 'utf8')).toBe('retained-memory');
  }
  const ordinary = path.join(home, 'projects', 'fixture', 'scratch');
  await fs.mkdir(ordinary, { recursive: true });
  const cd = process.platform === 'win32' ? 'cd /d' : 'cd';
  const result = await toolBash({ command: `${cd} "${ordinary}" && echo allowed>notes.txt`, timeout: 5 },
    { ...context, executionCwd: path.dirname(target) });
  expect(result).not.toContain('memory tool you were given');
  expect(await fs.readFile(path.join(ordinary, 'notes.txt'), 'utf8')).toContain('allowed');
});
