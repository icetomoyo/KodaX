import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider } from '@kodax-ai/llm';
import { getCachedRejectedEfforts, resetCapabilityCacheMemoForTesting, setAgentConfigHome } from '@kodax-ai/agent';
import { executeNonStreamingFallback } from './non-streaming-fallback.js';
import { BoundaryTrackerSession } from './boundary-tracker-session.js';

let cacheHome: string | undefined;
afterEach(() => {
  resetCapabilityCacheMemoForTesting();
  setAgentConfigHome(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (cacheHome) rmSync(cacheHome, { recursive: true, force: true });
  cacheHome = undefined;
});

it('preserves user intent and rejection learning across recreated providers during non-streaming recovery', async () => {
  cacheHome = mkdtempSync(join(tmpdir(), 'kodax-reasoning-fallback-'));
  setAgentConfigHome(cacheHome);
  resetCapabilityCacheMemoForTesting();
  vi.stubEnv('RECOVERY_TEST_KEY', 'test-key');
  const sent: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push(body.reasoning_effort);
    return body.reasoning_effort === 'max'
      ? Response.json({ error: { message: 'Invalid reasoning_effort value' } }, { status: 400 })
      : Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  }));
  const onReasoningResolved = vi.fn();
  const onReasoningEffortRejected = vi.fn();
  const onOutputSegmentStart = vi.fn();
  for (let turn = 0; turn < 2; turn++) {
    const provider = createCustomProvider({ name: 'recovery-test', protocol: 'openai',
      model: 'model', baseUrl: 'https://recovery.test/v1', apiKeyEnv: 'RECOVERY_TEST_KEY' });
    const outcome = await executeNonStreamingFallback({ streamProvider: provider,
      events: { onReasoningResolved, onReasoningEffortRejected, onOutputSegmentStart },
      providerMessages: [{ role: 'user', content: 'hello' }], activeToolDefinitions: [],
      effectiveSystemPrompt: '', effectiveProviderReasoning: { effort: 'max' },
      callerAbortSignal: undefined, modelOverride: undefined, hardTimeoutMs: 10_000,
      boundarySession: new BoundaryTrackerSession(), emitActiveExtensionEvent: vi.fn(),
      providerName: provider.name, attempt: 1, responseId: `turn-${turn}`, clearStreamTimers: vi.fn(),
    });
    expect(outcome.ok).toBe(true);
  }
  expect(sent).toEqual(['max', 'xhigh', 'xhigh']);
  expect(getCachedRejectedEfforts('recovery-test', 'model')).toEqual(['max']);
  expect(onReasoningEffortRejected).toHaveBeenCalledOnce();
  expect(onReasoningResolved).toHaveBeenCalledTimes(2);
  expect(onReasoningEffortRejected.mock.calls[0]?.[0].providerRequestId)
    .toBe(onOutputSegmentStart.mock.calls[0]?.[0].providerRequestId);
  expect(onReasoningResolved.mock.calls.map(([event]) => event.providerRequestId))
    .toEqual(onOutputSegmentStart.mock.calls.map(([segment]) => segment.providerRequestId));
  expect(onReasoningResolved.mock.calls[1]?.[0]).toMatchObject({ requestedEffort: 'max', sentEffort: 'xhigh',
    verified: false, fallbacks: [{ effort: 'max', reason: 'cached-rejection' }] });
});
