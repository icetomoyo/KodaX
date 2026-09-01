import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

const tuiMocks = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock('../tui/renderer-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../tui/renderer-runtime.js')>(),
  render: tuiMocks.render,
}));

vi.mock('../tui/runtime.js', () => ({
  resolveInteractiveSurfacePreference: () => 'ink',
}));

import { runSessionPicker, type SessionPickerItem } from './SessionPicker.js';

describe('runSessionPicker', () => {
  it('keeps the picker mounted while preparing the selected session', async () => {
    const session: SessionPickerItem = {
      id: 'session-one',
      title: 'First session',
      msgCount: 2,
    };
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    let resolveExit: (() => void) | undefined;
    const waitUntilExit = vi.fn(() => new Promise<void>((resolve) => {
      resolveExit = resolve;
    }));
    const unmount = vi.fn();
    const cleanup = vi.fn();
    tuiMocks.render.mockReturnValue({ waitUntilExit, unmount, cleanup });
    let finishPreparation: (() => void) | undefined;
    const prepareSelection = vi.fn(() => new Promise<void>((resolve) => {
      finishPreparation = resolve;
    }));

    try {
      const resultPromise = runSessionPicker([session], { prepareSelection });
      const rendered = tuiMocks.render.mock.calls[0]?.[0] as React.ReactElement<{
        onSelect: (selected: SessionPickerItem) => Promise<void>;
      }>;
      const renderOptions = tuiMocks.render.mock.calls[0]?.[1] as {
        preserveRawModeOnUnmount?: () => boolean;
      };
      const selectionPromise = rendered.props.onSelect(session);

      await Promise.resolve();
      expect(prepareSelection).toHaveBeenCalledWith(session);
      expect(renderOptions.preserveRawModeOnUnmount?.()).toBe(false);
      expect(unmount).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();

      finishPreparation?.();
      await selectionPromise;
      expect(renderOptions.preserveRawModeOnUnmount?.()).toBe(true);
      resolveExit?.();

      await expect(resultPromise).resolves.toBe(session);
      expect(tuiMocks.render).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
        }),
      );
      expect(unmount).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      tuiMocks.render.mockReset();
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    }
  });

  it('rethrows selection preparation failures after terminal cleanup', async () => {
    const session: SessionPickerItem = {
      id: 'session-failing',
      title: 'Failing session',
      msgCount: 1,
    };
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    let resolveExit: (() => void) | undefined;
    const unmount = vi.fn();
    const cleanup = vi.fn();
    tuiMocks.render.mockReturnValue({
      waitUntilExit: () => new Promise<void>((resolve) => { resolveExit = resolve; }),
      unmount,
      cleanup,
    });
    const failure = new Error('CLI preload failed');

    try {
      const resultPromise = runSessionPicker([session], {
        prepareSelection: async () => { throw failure; },
      });
      const rendered = tuiMocks.render.mock.calls[0]?.[0] as React.ReactElement<{
        onSelect: (selected: SessionPickerItem) => Promise<void>;
        onSelectionError: (error: unknown) => void;
      }>;
      const renderOptions = tuiMocks.render.mock.calls[0]?.[1] as {
        preserveRawModeOnUnmount?: () => boolean;
      };
      await rendered.props.onSelect(session).catch(rendered.props.onSelectionError);
      expect(renderOptions.preserveRawModeOnUnmount?.()).toBe(false);
      resolveExit?.();

      await expect(resultPromise).rejects.toBe(failure);
      expect(unmount).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      tuiMocks.render.mockReset();
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    }
  });
});
