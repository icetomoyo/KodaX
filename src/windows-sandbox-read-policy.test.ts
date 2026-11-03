import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { windowsSandboxAclExclusions, windowsSandboxAclRoots } from './windows-sandbox-read-policy.js';

const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('preserves ordinary home tools while excluding SSH and its included identity paths from grants', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodax-ssh-policy-'));
  fixtures.push(home);
  for (const name of ['.ssh', '.keys', '.included', 'tools', '.AWS']) mkdirSync(path.join(home, name));
  writeFileSync(path.join(home, '.ssh', 'config'), 'Include ~/.included/*\nIdentityFile "~/.keys/my key"\n');
  writeFileSync(path.join(home, '.included', 'host'), 'IdentityFile ~/.other-key\n');
  writeFileSync(path.join(home, '.other-key'), 'fixture');
  writeFileSync(path.join(home, '.gitconfig'), '[user]\n');
  const excluded = windowsSandboxAclExclusions(home);
  const roots = windowsSandboxAclRoots([home, path.join(home, '.ssh', 'config')], home, excluded);
  expect(roots.sort()).toEqual([path.join(home, '.gitconfig'), path.join(home, 'tools')].sort());
});

it.skipIf(process.platform !== 'win32')('excludes a not-yet-created SSH identity through a short-name home', () => {
  const longHome = mkdtempSync(path.join(os.tmpdir(), 'kodax-ssh-short-home-'));
  fixtures.push(longHome);
  const short = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${longHome}") do @echo %~sI`],
    { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  expect(short.status).toBe(0);
  const home = short.stdout.trim();
  for (const name of ['.ssh', '.keys', 'tools']) mkdirSync(path.join(home, name));
  writeFileSync(path.join(home, '.ssh', 'config'), 'IdentityFile "~/.keys/future key"\n');
  const roots = windowsSandboxAclRoots([home], home, windowsSandboxAclExclusions(home));
  expect(roots).toEqual([path.join(home, 'tools')]);
});
