import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyInfo } from '../types.js';
import { DEFAULT_SHORTCUTS } from './defaultShortcuts.js';
import { ShortcutsRegistry } from './ShortcutsRegistry.js';

function createKey(overrides: Partial<KeyInfo>): KeyInfo {
  return {
    name: '',
    sequence: '',
    ctrl: false,
    meta: false,
    shift: false,
    insertable: false,
    ...overrides,
  };
}

describe('ShortcutsRegistry', () => {
  beforeEach(() => {
    ShortcutsRegistry.resetInstance();
  });

  it('preserves registered handlers when defaults are re-registered during rerender', () => {
    const registry = ShortcutsRegistry.getInstance();
    const handler = vi.fn(() => true);

    registry.registerAll(DEFAULT_SHORTCUTS);
    registry.setHandler('toggleParallelMode', handler);

    registry.registerAll(DEFAULT_SHORTCUTS);

    const handled = registry.executeShortcut(
      createKey({ name: 'p', sequence: '\u0010', ctrl: true }),
      'input',
    );

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });
});
