import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { KodaXBaseProvider } from '@kodax-ai/coding';

const { recordRejectedEffortMock } = vi.hoisted(() => ({
  recordRejectedEffortMock: vi.fn(),
}));

vi.mock('@kodax-ai/agent', async () => {
  const actual = await vi.importActual<typeof import('@kodax-ai/agent')>('@kodax-ai/agent');
  return {
    ...actual,
    recordRejectedEffort: (...args: unknown[]) => recordRejectedEffortMock(...args),
  };
});

import { probeProviderReasoningEfforts } from './capability-probe.js';

// A fake provider whose stream() fires onReasoningEffortRejected for the
// efforts listed in `rejects`, and throws for the efforts in `errors`.
function fakeProvider(rejects: string[], errors: string[] = []): KodaXBaseProvider {
  return {
    getModel: () => 'm',
    stream: vi.fn(async (_messages, _tools, _system, reasoning, streamOptions) => {
      const effort = (reasoning as { effort?: string })?.effort ?? '';
      if (errors.includes(effort)) {
        throw new Error(`boom-${effort}`);
      }
      if (rejects.includes(effort)) {
        streamOptions?.onReasoningEffortRejected?.({ provider: 'p', model: 'm', effort });
      }
      return {} as unknown;
    }),
  } as unknown as KodaXBaseProvider;
}

describe('probeProviderReasoningEfforts', () => {
  it('persists the actual scoped rejection even when single-attempt probing throws after the callback', async () => {
    const provider = fakeProvider([]);
    vi.mocked(provider.stream).mockImplementationOnce(async (_messages, _tools, _system, _reasoning, options) => {
      options?.onReasoningEffortRejected?.({ provider: 'p', model: 'm', effort: '*', cacheScope: 'account-scope' });
      throw new Error('hard parameter rejection');
    });
    const result = await probeProviderReasoningEfforts({ provider: 'p', model: 'm', efforts: ['high'], resolve: () => provider, now: () => 'T0' });
    expect(result[0]).toMatchObject({ effort: 'high', status: 'rejected' });
    expect(recordRejectedEffortMock).toHaveBeenCalledExactlyOnceWith('p', 'm', '*', 'probed', 'T0', undefined, 'account-scope');
    expect(vi.mocked(provider.stream).mock.calls[0]?.[4]?.singleAttempt).toBe(true);
  });
  beforeEach(() => {
    recordRejectedEffortMock.mockReset();
  });

  it('classifies accepted / rejected efforts and records rejections as probed', async () => {
    const provider = fakeProvider(['max', 'xhigh']);
    const results = await probeProviderReasoningEfforts({
      provider: 'zhipu-coding',
      model: 'glm-5.2',
      efforts: ['low', 'high', 'xhigh', 'max'],
      resolve: () => provider,
      now: () => 'T0',
    });

    expect(results).toEqual([
      { effort: 'low', status: 'accepted' },
      { effort: 'high', status: 'accepted' },
      { effort: 'xhigh', status: 'rejected' },
      { effort: 'max', status: 'rejected' },
    ]);
    expect(recordRejectedEffortMock).toHaveBeenCalledWith('zhipu-coding', 'glm-5.2', 'xhigh', 'probed', 'T0', undefined);
    expect(recordRejectedEffortMock).toHaveBeenCalledWith('zhipu-coding', 'glm-5.2', 'max', 'probed', 'T0', undefined);
    expect(recordRejectedEffortMock).toHaveBeenCalledTimes(2);
  });

  it('reports a per-effort error without recording it', async () => {
    const provider = fakeProvider([], ['high']);
    const results = await probeProviderReasoningEfforts({
      provider: 'p',
      model: undefined,
      efforts: ['high'],
      resolve: () => provider,
      now: () => 'T0',
    });
    expect(results[0]).toMatchObject({ effort: 'high', status: 'error', error: 'boom-high' });
    expect(recordRejectedEffortMock).not.toHaveBeenCalled();
  });

  it('stops early when the abort signal is already set', async () => {
    const provider = fakeProvider([]);
    const controller = new AbortController();
    controller.abort();
    const results = await probeProviderReasoningEfforts({
      provider: 'p',
      efforts: ['low', 'high'],
      resolve: () => provider,
      now: () => 'T0',
      signal: controller.signal,
    });
    expect(results).toEqual([]);
  });
});
