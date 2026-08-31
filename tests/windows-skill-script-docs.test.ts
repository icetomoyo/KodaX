import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8');
}

describe('isolated Skill Script platform documentation', () => {
  it('marks the protocol-9 route POSIX-only and Windows unavailable', () => {
    for (const relativePath of [
      'README.md',
      'public_docs/sdk/embedder-guide.md',
      'CHANGELOG.md',
    ]) {
      const source = read(relativePath);
      expect(source, relativePath).toMatch(/protocol 9[\s\S]{0,160}POSIX-only/u);
      expect(source, relativePath).toMatch(/POSIX-only[\s\S]{0,160}Windows[\s\S]{0,40}unavailable/u);
      expect(source, relativePath).toMatch(/per-command `denyRead`/u);
    }

    const chineseReadme = read('README_CN.md');
    expect(chineseReadme).toMatch(/native protocol 9[\s\S]{0,160}仅支持 POSIX/u);
    expect(chineseReadme).toMatch(/Windows 不可用/u);
    expect(chineseReadme).toContain('每命令 `denyRead`');
  });
});
