import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('releases caller async context after image validation has settled', async () => {
  const validator = new URL('./image-validation.ts', import.meta.url).href;
  const fixture = new URL('../../../tests/fixtures/images/valid-png.png', import.meta.url).href;
  const script = `
    (async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const { readFile } = await import('node:fs/promises');
    const { setImmediate } = await import('node:timers/promises');
    const { validateImageBytes } = await import(${JSON.stringify(validator)});
    const storage = new AsyncLocalStorage();
    const bytes = await readFile(new URL(${JSON.stringify(fixture)}));
    let reference;
    await (async () => {
      const context = { request: 'completed caller context' };
      reference = new WeakRef(context);
      await storage.run(context, async () => {
        const result = await validateImageBytes(bytes);
        if (result.status !== 'valid') throw new Error('Expected valid image');
      });
    })();
    for (let i = 0; i < 10; i++) { await setImmediate(); global.gc(); }
    if (reference.deref()) throw new Error('Completed validation retains caller async context');
    const repeated = await validateImageBytes(bytes);
    if (repeated.status !== 'valid') throw new Error('Cached verdict changed');
    process.stdout.write('released');
    })().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--expose-gc', '--import', 'tsx', '-e', script],
    { timeout: 20_000, windowsHide: true });
  expect(stdout).toBe('released');
});
