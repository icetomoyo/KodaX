import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// ZIP64 directory with a compressed-size sentinel but no required 0x0001
// extra field. Before fflate 0.8.3, scanning for that field never terminates.
function malformedZip64(extra: Buffer): Buffer {
  const directorySize = 46 + extra.length;
  const archive = Buffer.alloc(directorySize + 56 + 20 + 22);
  archive.writeUInt32LE(0x02014b50, 0);
  archive.writeUInt32LE(0xffffffff, 20);
  archive.writeUInt16LE(extra.length, 30);
  extra.copy(archive, 46);

  const zip64End = directorySize;
  archive.writeUInt32LE(0x06064b50, zip64End);
  archive.writeBigUInt64LE(44n, zip64End + 4);
  archive.writeBigUInt64LE(1n, zip64End + 24);
  archive.writeBigUInt64LE(1n, zip64End + 32);
  archive.writeBigUInt64LE(BigInt(directorySize), zip64End + 40);
  const locator = zip64End + 56;
  archive.writeUInt32LE(0x07064b50, locator);
  archive.writeBigUInt64LE(BigInt(zip64End), locator + 8);
  archive.writeUInt32LE(1, locator + 16);
  const end = locator + 20;
  archive.writeUInt32LE(0x06054b50, end);
  archive.writeUInt16LE(0xffff, end + 8);
  archive.writeUInt16LE(0xffff, end + 10);
  archive.writeUInt32LE(0xffffffff, end + 12);
  archive.writeUInt32LE(0xffffffff, end + 16);
  return archive;
}

describe('skill archive ZIP64 validation', () => {
  it.each([
    { label: 'absent extra field', extra: Buffer.alloc(0) },
    { label: 'unrelated extra field', extra: Buffer.from([2, 0, 0, 0]) },
  ])('rejects $label without hanging the installer', ({ extra }) => {
    const installer = new URL('./builtin/skill-creator/scripts/install-skill.js', import.meta.url);
    // A subprocess timeout also keeps a regressed synchronous parser from
    // hanging the Vitest worker itself.
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { readSkillPackageBuffer } from ${JSON.stringify(installer.href)};
       readSkillPackageBuffer(Buffer.from(process.argv[1], 'base64'));`,
      malformedZip64(extra).toString('base64'),
    ], { encoding: 'utf8', timeout: 5_000, windowsHide: true });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid zip data');
  });
});
