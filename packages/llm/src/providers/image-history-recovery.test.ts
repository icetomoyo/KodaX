import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '../types.js';
import { createCustomProvider } from './custom-provider.js';

const noFrame = Buffer.from('ffd8ffe000104a46494600010100000100010000ffe10008457869660000ffd9', 'hex');
let directory: string | undefined;
afterEach(async () => {
  if (directory) {
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const protocol of ['anthropic', 'openai'] as const) {
  for (const method of ['complete', 'stream'] as const) {
    it(`${protocol}/${method} isolates only an invalid historical image and recovers when its file is repaired`, async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-recovery-'));
      const badPath = path.join(directory, 'header.jpg');
      const goodPath = path.join(directory, 'good.png');
      const png = await new Jimp({ width: 160, height: 46, color: 0x2266ccff }).getBuffer('image/png');
      await writeFile(badPath, noFrame);
      await writeFile(goodPath, png);
      const messages: KodaXMessage[] = [
        { role: 'user', content: 'Inspect header then update the quote.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'read_header', name: 'read', input: { path: badPath } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_header', is_error: true, content: [
          { type: 'text', text: 'Original tool explanation.' },
          { type: 'image', path: badPath, mediaType: 'image/jpeg' },
          { type: 'image', path: goodPath, mediaType: 'image/png' },
        ] }] },
        { role: 'user', content: [{ type: 'text', text: 'Continue: total 60000.' },
          { type: 'image', path: badPath, mediaType: 'image/jpeg' }] },
      ];
      const original = structuredClone(messages);
      const provider = createCustomProvider({ name: 'image-recovery', protocol, model: 'vision',
        baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED', imageInput: true });
      const create = vi.fn(async (_request: { messages: unknown[] }) => method === 'stream'
        ? (async function* () { yield protocol === 'anthropic' ? { type: 'message_stop' }
          : { choices: [{ delta: {}, finish_reason: 'stop' }] }; })()
        : protocol === 'anthropic' ? { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }
          : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
      Reflect.set(provider, '_client', protocol === 'anthropic' ? { messages: { create } }
        : { chat: { completions: { create } } });
      await provider[method](messages, [], 'system');
      const wire = JSON.stringify(create.mock.calls[0]![0]);
      expect(wire).not.toContain(noFrame.toString('base64'));
      expect(wire).toContain('cannot be decoded');
      expect(wire).toContain(Buffer.from(png).toString('base64'));
      expect(wire).toContain('Original tool explanation.');
      expect(wire).toContain('Continue: total 60000.');
      expect(wire).toContain('read_header');
      if (protocol === 'anthropic') expect(wire).toContain('"is_error":true');
      expect(messages).toEqual(original);
      expect(await readFile(badPath)).toEqual(noFrame);

      // An old JPEG path can be repaired with PNG bytes. Neither stale MIME nor negative cache survives.
      await writeFile(badPath, png);
      await provider[method](messages, [], 'system');
      const repairedWire = JSON.stringify(create.mock.calls[1]![0]);
      expect(repairedWire).not.toContain('cannot be decoded');
      expect(repairedWire).not.toContain('image/jpeg');
      expect(repairedWire).toContain('image/png');
      expect(messages).toEqual(original);
    });
  }
}
