import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { render as renderOwnedTui } from './tui.js';
import {
  SessionPicker,
  buildSessionPickerPage,
  filterSessionPickerItems,
  runSessionPicker,
  type SessionPickerItem,
} from './SessionPicker.js';
import { formatSessionTimestamp } from '../session/session-recency.js';

const sessions: SessionPickerItem[] = [
  {
    id: 'session-alpha-12345678',
    title: 'Review runtime persistence',
    msgCount: 8,
    surface: 'repl',
    createdAt: '2026-07-11T03:00:00.000Z',
  },
  {
    id: 'session-beta-12345678',
    title: 'Fix ACP storage isolation',
    msgCount: 4,
    surface: 'acp',
    createdAt: '2026-07-11T02:00:00.000Z',
  },
  {
    id: 'session-gamma-12345678',
    title: 'Document SDK pagination',
    msgCount: 6,
    surface: 'cli',
    createdAt: '2026-07-11T01:00:00.000Z',
  },
];

class MockInput extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
  }
}

class MockOutput extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 40;
  readonly chunks: string[] = [];

  write(value: string | Uint8Array): boolean {
    this.chunks.push(String(value));
    return true;
  }
}

describe('SessionPicker', () => {
  it('searches incrementally across title, id, and surface using all query tokens', () => {
    expect(filterSessionPickerItems(sessions, 'storage acp').map((session) => session.id))
      .toEqual(['session-beta-12345678']);
    expect(filterSessionPickerItems(sessions, 'gamma').map((session) => session.id))
      .toEqual(['session-gamma-12345678']);
  });

  it('keeps the selected row visible while paging', () => {
    expect(buildSessionPickerPage(sessions, 2, 2)).toMatchObject({
      pageStart: 2,
      pageIndex: 1,
      pageCount: 2,
      selectedIndex: 2,
      items: [sessions[2]],
    });
  });

  it('renders search, navigation, paging, and completion hints', () => {
    const { lastFrame } = render(
      <SessionPicker
        sessions={sessions}
        onSelect={vi.fn()}
        onSelectionError={vi.fn()}
        onCancel={vi.fn()}
        pageSize={2}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Resume a session');
    expect(frame).toContain('Search:');
    expect(frame).toContain('PgUp/PgDn');
    expect(frame).toContain('Tab complete');
    expect(frame).toContain('Page 1/2');
    expect(frame).toContain('Selected ID: session-alpha-12345678');
  });

  it('renders session timestamps in the local timezone', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      const { lastFrame } = render(
        <SessionPicker
          sessions={[{
            id: 'local-time-session',
            title: 'Local time',
            msgCount: 1,
            createdAt: '2026-07-29T03:36:34.235Z',
          }]}
          onSelect={vi.fn()}
          onSelectionError={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(lastFrame()).toContain('2026-07-29 11:36');
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('formats list times in local time because session ids no longer carry a readable date', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      expect(formatSessionTimestamp('2026-07-29T03:36:34.235Z')).toBe('2026-07-29 11:36');
      expect(formatSessionTimestamp(undefined)).toBe('unknown time');
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it('shortens ids by their random tail, which differs between sessions created together', () => {
    const sessions = ['019a9256-3c7e-7b21-8f4d-6a2e9c1b5d03', '019a9256-41f0-7c88-a1d2-77e0b3f4c9a1']
      .map((id, index) => ({ id, title: `Session ${index}`, msgCount: 1 }));
    const { lastFrame } = render(
      <SessionPicker sessions={sessions} onSelect={vi.fn()} onSelectionError={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(lastFrame()).toContain('· 9c1b5d03');
    expect(lastFrame()).toContain('· b3f4c9a1');
  });

  it('selects and exits through the owned TUI input lifecycle', async () => {
    const stdin = new MockInput();
    const stdout = new MockOutput();
    const stderr = new MockOutput();
    const onSelect = vi.fn();
    const instance = renderOwnedTui(
      <SessionPicker
        sessions={sessions}
        onSelect={onSelect}
        onSelectionError={vi.fn()}
        onCancel={vi.fn()}
        pageSize={2}
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );

    try {
      stdin.emit('data', Buffer.from('\r'));
      await instance.waitUntilExit();
      expect(onSelect).toHaveBeenCalledWith(sessions[0]);
      expect(stdin.isRaw).toBe(false);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it('shows a loading transition and retains input ownership during async selection', async () => {
    const stdin = new MockInput();
    const stdout = new MockOutput();
    const stderr = new MockOutput();
    let finishSelection: (() => void) | undefined;
    const onSelect = vi.fn(() => new Promise<void>((resolve) => {
      finishSelection = resolve;
    }));
    const instance = renderOwnedTui(
      <SessionPicker
        sessions={sessions}
        onSelect={onSelect}
        onSelectionError={vi.fn()}
        onCancel={vi.fn()}
        pageSize={2}
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        // The renderer suppresses dynamic stdout frames under is-in-ci unless
        // debug output is requested; this assertion intentionally inspects one.
        debug: true,
      },
    );

    try {
      let exited = false;
      const exitPromise = instance.waitUntilExit().then(() => { exited = true; });
      stdin.emit('data', Buffer.from('\r'));

      await vi.waitFor(
        () => expect(stdout.chunks.join('')).toContain('Loading selected session'),
        { timeout: 2_000 },
      );
      expect(onSelect).toHaveBeenCalledWith(sessions[0]);
      expect(exited).toBe(false);
      expect(stdin.isRaw).toBe(true);

      finishSelection?.();
      await exitPromise;
      expect(stdin.isRaw).toBe(false);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it('cancels and exits on Ctrl+C through the owned TUI input lifecycle', async () => {
    const stdin = new MockInput();
    const stdout = new MockOutput();
    const stderr = new MockOutput();
    const onCancel = vi.fn();
    const instance = renderOwnedTui(
      <SessionPicker
        sessions={sessions}
        onSelect={vi.fn()}
        onSelectionError={vi.fn()}
        onCancel={onCancel}
        pageSize={2}
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
      },
    );

    try {
      stdin.emit('data', Buffer.from('\x03'));
      expect(onCancel).toHaveBeenCalledTimes(1);
      await instance.waitUntilExit();
      expect(stdin.isRaw).toBe(false);
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it('rejects the searchable picker when stdin/stdout are not interactive', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      await expect(runSessionPicker(sessions)).rejects.toThrow(
        'requires an interactive terminal',
      );
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    }
  });
});
