import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('the browser SDK entry', () => {
  it('bundles for a browser from the protocol client alone, without Node or the schema library', async () => {
    const result = await build({
      entryPoints: ['src/sdk-browser.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs).toContain('src/host-protocol/remote-host.ts');
    expect(inputs.filter(input => input !== 'src/sdk-browser.ts' && !input.startsWith('src/host-protocol/'))).toEqual([]);
  });

  it('offers what a page needs to talk to its Host', async () => {
    const sdk = await import('./sdk-browser.js');
    expect(Object.keys(sdk).sort()).toEqual(['HostProtocolError', 'connectKodaXHost', 'createRequestId']);
  });
});
