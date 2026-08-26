import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./windows-text-transaction.js', () => ({
  probeTrustedTextNativeBinding: () => ({ ready: true, protocol: 4 }),
}));

import { runDoctor } from './kodax_doctor.js';

describe('kodax doctor trusted text diagnostic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an explicitly requested native binding load and protocol check', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      output.push(String(value));
    });

    await runDoctor('test', true, { nativeText: true });

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      version: 'test',
      trustedTextNative: { ready: true, protocol: 4 },
    });
  });

  it('does not load or report native state during the default read-only doctor', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      output.push(String(value));
    });

    await runDoctor('test', true);

    expect(JSON.parse(output[0]!)).not.toHaveProperty('trustedTextNative');
  });
});
