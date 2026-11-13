import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultSkillsDir } from '../packages/agent/src/capabilities/skills/builtin/skill-creator/scripts/utils.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const ENV_READ = /process\.env\.KODAX_HOME|process\.env\[\s*['"]KODAX_HOME['"]\s*\]/;
const SOURCE = /\.(?:tsx?|m?js)$/;
const NOT_SOURCE = /\.(?:test|spec)\.(?:tsx?|m?js)$|\.d\.ts$/;
/**
 * The skill-creator scripts run as plain Node programs without the agent package,
 * so they mirror resolveKodaXHome; the test below holds them to it.
 */
const MIRRORS = ['packages/agent/src/capabilities/skills/builtin/skill-creator/scripts/utils.js'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(target);
    return SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name) ? [target] : [];
  });
}

describe('KODAX_HOME resolution contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is read only through resolveKodaXHome so every layer agrees on the data root', () => {
    const roots = [
      path.join(repoRoot, 'src'),
      ...readdirSync(path.join(repoRoot, 'packages')).map((name) => path.join(repoRoot, 'packages', name, 'src')),
    ].filter((root) => existsSync(root));
    const readers = roots
      .flatMap(sourceFiles)
      .filter((file) => ENV_READ.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'));
    expect(readers).toEqual(MIRRORS);
  });

  it('is mirrored by the skill-creator scripts', () => {
    const home = path.join(os.tmpdir(), 'kodax-home-contract');
    vi.stubEnv('KODAX_HOME', home);
    expect(getDefaultSkillsDir()).toBe(path.join(home, 'skills'));
    vi.stubEnv('KODAX_HOME', 'relative-home');
    expect(getDefaultSkillsDir()).toBe(path.join(os.homedir(), '.kodax', 'skills'));
  });
});
