import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createSecretReadlineSurface } from './secret-input.js';

it('keeps TTY secret bytes and readline history hidden while retaining normal output', async () => {
  const input = new PassThrough(), output = new PassThrough(), frames: string[] = [];
  output.on('data', (chunk: Buffer) => frames.push(chunk.toString()));
  const surface = createSecretReadlineSurface(output), rl = createInterface({ input, output: surface.output, terminal: true, historySize: 100 });
  try {
    const answer = surface.read(rl, 'API key');
    let callbacks = 0; surface.output.write('must-hide', () => { callbacks++; }); surface.output.write('must-hide-too', 'utf8', () => { callbacks++; });
    expect(callbacks).toBe(2); expect(frames.join('')).not.toContain('must-hide');
    input.write('hidden-fixture-key\r');
    expect(await answer).toBe('hidden-fixture-key'); expect(frames.join('')).not.toContain('hidden-fixture-key');
    expect(Reflect.get(rl, 'history')).not.toContain('hidden-fixture-key');
    surface.output.write('normal-output'); expect(frames.join('')).toContain('normal-output');
    const cancelled = surface.read(rl, 'Another key'); rl.emit('SIGINT'); expect(await cancelled).toBeUndefined();
    const next = surface.read(rl, 'Retry key'); input.write('next-fixture\r'); expect(await next).toBe('next-fixture');
    expect(frames.join('')).not.toContain('next-fixture');
    rl.close(); expect(await surface.read(rl, 'Closed input')).toBeUndefined();
  } finally { rl.close(); }
});
