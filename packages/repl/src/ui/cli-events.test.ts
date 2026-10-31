import { afterEach, expect, it, vi } from 'vitest';
import { createCliEvents } from './cli-events.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('shows approximate tokens for legacy thinking and cumulative identified tool input', async () => {
  vi.useFakeTimers();
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const events = createCliEvents(false);
  const last = () => String(write.mock.calls.at(-1)?.[0]);
  try {
    events.onThinkingDelta?.('12345678');
    await vi.advanceTimersByTimeAsync(80);
    expect(last()).toContain('Thinking... (~2 tokens)');
    events.onToolInputDelta?.('read', '1234', { toolId: 'one' });
    events.onToolInputDelta?.('read', '5678', { toolId: 'one' });
    await vi.advanceTimersByTimeAsync(80);
    expect(last()).toContain('Receiving read... (~2 tokens)');
    events.onToolInputDelta?.('read', '1234', { toolId: 'two' });
    await vi.advanceTimersByTimeAsync(80);
    expect(last()).toContain('Receiving read... (~1 tokens)');
    events.onStreamEnd?.();
    events.onToolInputDelta?.('read', '1234', { toolId: 'one' });
    await vi.advanceTimersByTimeAsync(80);
    expect(last()).toContain('Receiving read... (~1 tokens)');
  } finally { events.onError?.(new Error('fixture complete')); }
});

it('resets legacy counts on request replacement and ignores late or child deltas', async () => {
  vi.useFakeTimers();
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const events = createCliEvents(false);
  try {
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'first', mode: 'append' });
    events.onToolInputDelta?.('read', '12345678', { providerRequestId: 'first', toolId: 'same' });
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'retry', mode: 'replace' });
    events.onToolInputDelta?.('read', '1234', { providerRequestId: 'retry', toolId: 'same' });
    events.onToolInputDelta?.('read', 'stale', { providerRequestId: 'first', toolId: 'same' });
    events.onToolInputDelta?.('read', 'child', { providerRequestId: 'retry', toolId: 'same', contextKind: 'child', childAgentId: 'child' });
    await vi.advanceTimersByTimeAsync(80);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain('Receiving read... (~1 tokens)');
  } finally { events.onError?.(new Error('fixture complete')); }
});

it('keeps request counters separate when an older event adapter omits segment events', async () => {
  vi.useFakeTimers();
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const events = createCliEvents(false);
  try {
    events.onToolInputDelta?.('read', '12345678', { providerRequestId: 'first', toolId: 'same' });
    events.onToolInputDelta?.('read', '1234', { providerRequestId: 'retry', toolId: 'same' });
    await vi.advanceTimersByTimeAsync(80);
    expect(String(write.mock.calls.at(-1)?.[0])).toContain('Receiving read... (~1 tokens)');
  } finally { events.onError?.(new Error('fixture complete')); }
});
