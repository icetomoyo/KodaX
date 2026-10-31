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

it.each(['chat-completions', 'responses'] as const)('preserves user intent and rejection learning across recreated %s providers during non-streaming recovery', async (api) => {
  cacheHome = mkdtempSync(join(tmpdir(), 'kodax-reasoning-fallback-'));
  setAgentConfigHome(cacheHome);
  resetCapabilityCacheMemoForTesting();
  vi.stubEnv('RECOVERY_TEST_KEY', 'test-key');
  const sent: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const effort = api === 'responses' ? (body.reasoning as { effort?: string } | undefined)?.effort : body.reasoning_effort;
    sent.push(effort);
    return effort === 'max'
      ? Response.json({ error: { message: `Invalid ${api === 'responses' ? 'reasoning.effort' : 'reasoning_effort'} value` } }, { status: 400 })
      : Response.json(api === 'responses' ? { id: 'r', status: 'completed', output: [] }
        : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  }));
  const onReasoningResolved = vi.fn();
  const onReasoningEffortRejected = vi.fn();
  const onOutputSegmentStart = vi.fn();
  for (let turn = 0; turn < 2; turn++) {
    const provider = createCustomProvider({ name: 'recovery-test', protocol: 'openai', api,
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
  const scope = onReasoningEffortRejected.mock.calls[0]?.[0].cacheScope as string | undefined;
  expect(getCachedRejectedEfforts('recovery-test', 'model', undefined, scope)).toEqual(['max']);
  if (api === 'responses') expect(scope).toMatch(/^[a-f0-9]{64}$/);
  expect(onReasoningEffortRejected).toHaveBeenCalledOnce();
  expect(onReasoningResolved).toHaveBeenCalledTimes(2);
  expect(onReasoningEffortRejected.mock.calls[0]?.[0].providerRequestId)
    .toBe(onOutputSegmentStart.mock.calls[0]?.[0].providerRequestId);
  expect(onReasoningResolved.mock.calls.map(([event]) => event.providerRequestId))
    .toEqual(onOutputSegmentStart.mock.calls.map(([segment]) => segment.providerRequestId));
  expect(onReasoningResolved.mock.calls[1]?.[0]).toMatchObject({ requestedEffort: 'max', sentEffort: 'xhigh',
    verified: false, fallbacks: [{ effort: 'max', reason: 'cached-rejection' }] });
});
