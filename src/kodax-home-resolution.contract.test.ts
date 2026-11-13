import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const ENV_READ = /process\.env\.KODAX_HOME|process\.env\[\s*['"]KODAX_HOME['"]\s*\]/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(target);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

describe('KODAX_HOME resolution contract', () => {
  it('is read only through resolveKodaXHome so every layer agrees on the data root', () => {
    const roots = [
      path.join(repoRoot, 'src'),
      ...readdirSync(path.join(repoRoot, 'packages')).map((name) => path.join(repoRoot, 'packages', name, 'src')),
    ].filter((root) => existsSync(root));
    const readers = roots
      .flatMap(sourceFiles)
      .filter((file) => ENV_READ.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file));
    expect(readers).toEqual([]);
  });
});
