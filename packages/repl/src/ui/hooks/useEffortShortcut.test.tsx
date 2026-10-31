import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommandResultData } from '../../commands/types.js';
import { ClipboardToastSurface } from '../components/ClipboardToastSurface.js';
import { useEffortShortcut } from './useEffortShortcut.js';

const views: ReturnType<typeof render>[] = [];
afterEach(() => { for (const view of views.splice(0)) view.unmount(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function setup(selectNext: (signal: AbortSignal) => Promise<CommandResultData | undefined>) {
  const report = vi.fn(async (_message: string) => undefined);
  let api: ReturnType<typeof useEffortShortcut>;
  function Surface({ session = 'session' }) {
    api = useEffortShortcut(selectNext, report, session);
    return <><Text>draft remains</Text><ClipboardToastSurface {...api.notice} /></>;
  }
  const view = render(<Surface />);
  views.push(view);
  return { get api() { return api!; }, report, view, Surface };
}

it('shows successful effort selection briefly without writing a transcript receipt', async () => {
  const host = setup(async () => ({ success: true, message: 'Effort: high' }));
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.useFakeTimers();
  await host.api.cycle();
  expect(host.report).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(host.view.lastFrame()).toContain('✓ Effort: high'));
  await vi.advanceTimersByTimeAsync(2100);
  await vi.waitFor(() => expect(host.view.lastFrame()).toBe('draft remains'));
});

it('animates while saving, waits beyond two seconds, then starts the success timeout', async () => {
  const pending = deferred<CommandResultData>();
  const host = setup(() => pending.promise);
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.useFakeTimers();
  const change = host.api.cycle();
  try {
    await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Updating effort…'));
    const frame = host.view.lastFrame();
    expect(frame).not.toContain('✓');
    await vi.advanceTimersByTimeAsync(160);
    await vi.waitFor(() => expect(host.view.lastFrame()).not.toBe(frame));
    await vi.advanceTimersByTimeAsync(3000);
    expect(host.view.lastFrame()).toContain('Updating effort…');
    pending.resolve({ success: true, message: 'Effort: high' });
    await change;
    await vi.waitFor(() => expect(host.view.lastFrame()).toContain('✓ Effort: high'));
    expect(host.report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2100);
    await vi.waitFor(() => expect(host.view.lastFrame()).toBe('draft remains'));
  } finally { pending.resolve({ success: true }); await change; }
});

it('serializes rapid key presses and shows only the latest completed selection', async () => {
  const first = deferred<void>();
  const applied: string[] = [];
  const select = vi.fn(async () => {
    if (!applied.length) await first.promise;
    const effort = ['low', 'medium', 'high'][applied.length]!;
    applied.push(effort);
    return { success: true, message: `Effort: ${effort}` };
  });
  const host = setup(select);
  await new Promise(resolve => setTimeout(resolve, 0));
  const changes = [host.api.cycle(), host.api.cycle(), host.api.cycle()];
  try {
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    expect(applied).toEqual([]);
    first.resolve();
    await Promise.all(changes);
    expect(applied).toEqual(['low', 'medium', 'high']);
    await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Effort: high'));
    expect(host.report).not.toHaveBeenCalled();
  } finally { first.resolve(); await Promise.all(changes); }
});

it.each(['result', 'throw'] as const)('retains a detailed %s failure and accepts the next shortcut', async failure => {
  let attempts = 0;
  const host = setup(async () => {
    if (++attempts > 1) return { success: true, message: 'Effort: high' };
    if (failure === 'throw') throw new Error('Host unavailable');
    return { success: false, message: 'Host default saved; Session apply failed: disk unavailable' };
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  await host.api.cycle();
  expect(host.report).toHaveBeenCalledTimes(1);
  expect(host.report.mock.calls[0]![0]).toContain(failure === 'throw' ? 'Host unavailable' : 'Session apply failed: disk unavailable');
  await host.api.cycle();
  await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Effort: high'));
  expect(host.report).toHaveBeenCalledTimes(1);
});

it('does not leave a progress toast when the model has no effort cycle', async () => {
  const host = setup(async () => undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  await host.api.cycle();
  await vi.waitFor(() => expect(host.view.lastFrame()).toBe('draft remains'));
  expect(host.report).not.toHaveBeenCalled();
});

it('gives the latest success a complete two-second display', async () => {
  let count = 0;
  const host = setup(async () => ({ success: true, message: `Effort: ${++count === 1 ? 'high' : 'max'}` }));
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.useFakeTimers();
  await host.api.cycle();
  await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Effort: high'));
  await vi.advanceTimersByTimeAsync(1500);
  await host.api.cycle();
  await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Effort: max'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(host.view.lastFrame()).toContain('Effort: max');
  await vi.advanceTimersByTimeAsync(1100);
  await vi.waitFor(() => expect(host.view.lastFrame()).toBe('draft remains'));
});

it.each(['unmount', 'session', 'closing'] as const)('discards queued changes and late feedback after %s', async mode => {
  const old = deferred<CommandResultData>();
  const signals: AbortSignal[] = [];
  const select = vi.fn(async (signal: AbortSignal) => {
    signals.push(signal);
    return signals.length === 1 ? old.promise : { success: true, message: 'Effort: max' };
  });
  const host = setup(select);
  await new Promise(resolve => setTimeout(resolve, 0));
  const changes = [host.api.cycle(), host.api.cycle()];
  try {
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    if (mode === 'unmount') host.view.unmount();
    else if (mode === 'session') host.view.rerender(<host.Surface session="other" />);
    else { host.api.cancel(); await host.api.cycle(); }
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    if (mode === 'session') {
      await host.api.cycle();
      await vi.waitFor(() => expect(host.view.lastFrame()).toContain('Effort: max'));
    }
    old.resolve({ success: false, message: 'Old Session failed' });
    await Promise.all(changes);
    expect(select).toHaveBeenCalledTimes(mode === 'session' ? 2 : 1);
    expect(host.report).not.toHaveBeenCalled();
    if (mode === 'session') expect(host.view.lastFrame()).toContain('Effort: max');
  } finally { old.resolve({ success: true }); await Promise.all(changes); }
});
