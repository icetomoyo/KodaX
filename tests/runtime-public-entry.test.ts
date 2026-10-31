import { describe, expect, it } from 'vitest';
import * as runtime from '@kodax-ai/kodax/runtime';
import * as root from '../src/index.js';

describe('published Runtime ownership boundary', () => {
  it.each([['runtime', runtime], ['root', root]] as const)(
    '%s exposes connections without an in-process owner constructor or mode switches',
    (_name, entry) => {
      for (const name of ['createKodaXHostRuntime', 'acquireKodaXInlineOwner',
        'setKodaXRuntimeOwnerMode', 'enableKodaXDaemonOwner']) {
        expect(entry).not.toHaveProperty(name);
      }
      expect(entry.createKodaXRuntime).toBeTypeOf('function');
      expect(entry.connectKodaXRuntime).toBeTypeOf('function');
    },
  );
});
