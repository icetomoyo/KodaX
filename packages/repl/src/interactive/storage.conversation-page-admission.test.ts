import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileSessionStorage } from './storage.js';

describe('Conversation page metadata admission', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(content: string) {
    const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-page-admission-'));
    roots.push(sessionsDir);
    const sessionId = 'metadata-boundary';
    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeFile(filePath, content, 'utf8');
    return { sessionsDir, sessionId, filePath };
  }

  it.each(['\n', '\r\n', ''])('preserves UTF-8 split across chunks with terminator %j', async (terminator) => {
    const prefix = '{"_type":"meta","runtimeInfo":{"surface":"repl","profileId":"';
    // Put the first byte of an emoji at the very end of the first 64 KiB chunk.
    const profileId = `${'x'.repeat(65536 - Buffer.byteLength(prefix) - 1)}🙂配置`;
    const metadata = `${prefix}${profileId}"}}`;
    const source = metadata + terminator + (terminator ? 'invalid transcript body\n'.repeat(10_000) : '');
    const { sessionsDir, sessionId, filePath } = await fixture(source);

    for (let startup = 0; startup < 2; startup += 1) {
      const storage = new FileSessionStorage({ sessionsDir });
      await expect(storage.readConversationPageBoundary(sessionId)).resolves.toMatchObject({
        admission: { surface: 'repl', profileId },
      });
    }
    expect(await readFile(filePath, 'utf8')).toBe(source);
  });

  it.each(['', '\n', '{"_type":"meta",', `{"_type":"meta","title":"${'x'.repeat(150_000)}`])(
    'rejects empty or malformed metadata (%#)', async (source) => {
      const { sessionsDir, sessionId } = await fixture(source);
      const storage = new FileSessionStorage({ sessionsDir });
      await expect(storage.readConversationPageBoundary(sessionId)).rejects.toMatchObject({
        code: 'data_corrupt',
      });
    },
  );

  it('accepts a complete metadata record exactly 64 KiB long at EOF', async () => {
    const prefix = '{"_type":"meta","title":"';
    const suffix = '","runtimeInfo":{"surface":"repl"}}';
    const metadata = prefix + 'x'.repeat(65536 - prefix.length - suffix.length) + suffix;
    const { sessionsDir, sessionId } = await fixture(metadata);
    await expect(new FileSessionStorage({ sessionsDir }).readConversationPageBoundary(sessionId))
      .resolves.toMatchObject({ admission: { surface: 'repl' } });
  });
});
