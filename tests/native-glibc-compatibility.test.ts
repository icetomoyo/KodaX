import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeElfFixture(versions: readonly string[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'kodax-glibc-gate-'));
  temporaryDirectories.push(directory);
  const artifact = path.join(directory, 'kodax-text-transaction.node');
  writeFileSync(artifact, Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from(`\0${versions.join('\0')}\0`, 'ascii'),
  ]));
  return artifact;
}

describe('Linux native glibc compatibility gate', () => {
  it('accepts a 2.28 authority and rejects one that needs a newer glibc', () => {
    const script = path.resolve('scripts/check-native-glibc.mjs');
    const compatible = spawnSync(
      process.execPath,
      [script, '--max', '2.28', writeElfFixture(['GLIBC_2.17', 'GLIBC_2.28'])],
      { encoding: 'utf8' },
    );
    const incompatible = spawnSync(
      process.execPath,
      [script, '--max', '2.28', writeElfFixture(['GLIBC_2.28', 'GLIBC_2.34'])],
      { encoding: 'utf8' },
    );

    expect(compatible).toMatchObject({ status: 0, stderr: '' });
    expect(compatible.stdout).toContain('maximum required GLIBC_2.28');
    expect(incompatible.status).toBe(1);
    expect(incompatible.stderr).toContain('requires GLIBC_2.34; maximum supported is GLIBC_2.28');
  });
});
