import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bind: vi.fn((options: object) => ({ ...options, bound: true })),
  classic: vi.fn(async () => undefined),
  ink: vi.fn(async () => undefined),
}));

vi.mock('@kodax-ai/repl', () => ({
  runInteractiveMode: mocks.classic,
  runInkInteractiveMode: mocks.ink,
}));

vi.mock('./trusted-coding-entry.js', () => ({
  withTrustedTextMutationHost: mocks.bind,
}));

import { runInkInteractiveMode, runInteractiveMode } from './trusted-repl-entry.js';

describe('KodaX-owned REPL entries', () => {
  beforeEach(() => {
    mocks.bind.mockClear();
    mocks.classic.mockClear();
    mocks.ink.mockClear();
  });

  it.each([
    ['classic', runInteractiveMode, mocks.classic],
    ['ink', runInkInteractiveMode, mocks.ink],
  ] as const)('binds trusted text authority for the %s REPL', async (_name, run, target) => {
    const options = { provider: 'test' };

    await run(options);

    expect(mocks.bind).toHaveBeenCalledWith(options);
    expect(target).toHaveBeenCalledWith({ provider: 'test', bound: true });
  });
});
