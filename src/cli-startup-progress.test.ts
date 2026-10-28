import { afterEach, describe, expect, it, vi } from 'vitest';

import { cliStartupProgressMessage, createCliStartupProgress, isInteractiveCliStartup } from './cli-startup-progress.js';
import type { ClientStartupProgress } from '@kodax-ai/coding/client-contract';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CLI startup progress', () => {
  it('requires an interactive terminal and a startup route before enabling terminal feedback', () => {
    const streams = [process.stdin, process.stdout, process.stderr];
    const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    try {
      for (const stream of streams) Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
      for (const args of [[], ['-c'], ['--continue'], ['-r', 'session-id'], ['--resume', 'session-id']]) {
        expect(isInteractiveCliStartup(args)).toBe(true);
      }
      for (const args of [['--help'], ['--version'], ['-r'], ['--print', 'prompt'], ['-c', '--print']]) {
        expect(isInteractiveCliStartup(args)).toBe(false);
      }
      for (const stream of streams) {
        Object.defineProperty(stream, 'isTTY', { value: false, configurable: true });
        expect(isInteractiveCliStartup([])).toBe(false);
        Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
      }
    } finally {
      streams.forEach((stream, index) => {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else Reflect.deleteProperty(stream, 'isTTY');
      });
    }
  });
  it('renders shared startup facts and explains each real waiting reason', () => {
    const cases: readonly [ClientStartupProgress, string][] = [
      [{ stage: 'checking' }, 'Checking KodaX'],
      [{ stage: 'starting' }, 'Starting KodaX'],
      [{ stage: 'upgrading' }, 'Updating KodaX'],
      [{ stage: 'connecting' }, 'Connecting to KodaX'],
      [{ stage: 'ready' }, 'Connected to KodaX'],
      [{ stage: 'waiting', reason: 'connected_clients' }, 'Waiting for other clients to disconnect'],
      [{ stage: 'waiting', reason: 'host_starting' }, 'Waiting for KodaX to start'],
      [{ stage: 'waiting', reason: 'host_stopping' }, 'Waiting for previous KodaX to exit'],
      [{ stage: 'initializing', phase: 'modules' }, 'Loading KodaX modules'],
      [{ stage: 'initializing', phase: 'extensions' }, 'Loading extensions'],
      [{ stage: 'initializing', phase: 'runtime' }, 'Initializing KodaX runtime'],
      [{ stage: 'initializing', phase: 'recovery' }, 'Recovering previous tasks'],
      [{ stage: 'initializing', phase: 'mcp' }, 'Initializing MCP integrations'],
      [{ stage: 'initializing', phase: 'sessions' }, 'Restoring session resources'],
      [{ stage: 'initializing', phase: 'a2a' }, 'Initializing Agent connections'],
      [{ stage: 'initializing', phase: 'listener' }, 'Opening KodaX connection'],
    ];
    for (const [event, message] of cases) expect(cliStartupProgressMessage(event)).toBe(message);
  });
  it('paints immediately, advances with elapsed time, and switches startup phases', async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const progress = createCliStartupProgress('Starting KodaX');
    try {
      expect(write).toHaveBeenCalledWith(expect.stringContaining('Starting KodaX (0s)'));
      await vi.advanceTimersByTimeAsync(1_080);
      expect(write.mock.calls.at(-1)?.[0]).toContain('(1s)');
      expect(write.mock.calls[0]?.[0]).not.toBe(write.mock.calls[1]?.[0]);
      progress.update('Loading session');
      expect(write.mock.calls.at(-1)?.[0]).toContain('Loading session (1s)');
    } finally {
      progress.stop();
    }
  });

  it('clears the indicator before terminal handoff and never paints again after stopping', async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const progress = createCliStartupProgress('Starting KodaX');
    progress.stop();
    const calls = write.mock.calls.length;
    expect(write.mock.calls.at(-1)?.[0]).toBe('\r\u001B[2K');
    await vi.advanceTimersByTimeAsync(1_000);
    progress.update('Loading session');
    progress.stop();
    expect(write).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});
