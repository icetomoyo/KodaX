import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
