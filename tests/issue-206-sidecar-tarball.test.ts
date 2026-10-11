import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const scratchDirs: string[] = [];

function run(
  command: string,
  args: readonly string[],
): Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  const result = spawnSync(command, args, {
    cwd: resolve('.'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function runNpm(args: readonly string[]) {
  const configuredNpmCli = process.env.npm_execpath?.trim();
  if (configuredNpmCli && existsSync(configuredNpmCli)) {
    return run(process.execPath, [configuredNpmCli, ...args]);
  }
  if (process.platform === 'win32') {
    const npmCli = join(
      dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    if (existsSync(npmCli)) {
      return run(process.execPath, [npmCli, ...args]);
    }
  }
  return run('npm', args);
}

describe('Issue 206 publish tarball regression', () => {
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packs current visual-review assets without the retired completion judge', {
    timeout: 180_000,
  }, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'kodax-i206-tarball-'));
    scratchDirs.push(scratch);
    const packed = runNpm([
      'pack',
      '--json',
      '--pack-destination',
      scratch,
    ]);

    expect(packed.status, packed.error || packed.stderr || packed.stdout).toBe(0);
    const parsed: unknown = JSON.parse(packed.stdout);
    const rows: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const filename = typeof row === 'object'
      && row !== null
      && 'filename' in row
      ? row.filename
      : undefined;
    expect(filename).toBeTypeOf('string');

    const tarball = typeof filename === 'string' && isAbsolute(filename)
      ? filename
      : join(scratch, typeof filename === 'string' ? filename : '');
    const audited = run(process.execPath, [
      resolve('scripts/audit-runtime-tarball.mjs'),
      tarball,
    ]);

    expect(audited.status, audited.error || audited.stderr || audited.stdout).toBe(0);
    expect(audited.stdout).toContain('Runtime tarball audit passed');
  });
});
