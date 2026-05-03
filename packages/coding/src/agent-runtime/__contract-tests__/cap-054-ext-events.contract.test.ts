/**
 * Contract test for CAP-054: extension event lifecycle (emitActiveExtensionEvent)
 *
 * Test obligations:
 * - CAP-EXT-EVENTS-001: `session:start` fires exactly once per
 *   Runner frame entry (before the first turn)
 * - CAP-EXT-EVENTS-002: `turn:start` / `turn:end` pair for each turn
 * - CAP-EXT-EVENTS-003: text:delta / thinking:delta / thinking:end
 *   bridged from the provider stream (assert presence of *at least one*
 *   `text:delta` to keep the test robust against thinking-block-free
 *   providers)
 * - CAP-EXT-EVENTS-004: `complete` fires on the terminal path
 *
 * Risk: MEDIUM (extension contract — third-party extensions depend on
 * event names + arg shapes)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/run-substrate.ts (multiple emit
 * sites — session:start, turn:start, text:delta, turn:end, complete).
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6t.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
} from '@kodax/ai';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax/ai';

import { runKodaX } from '../../agent.js';
import { createExtensionRuntime } from '../../extensions/index.js';
import { setActiveExtensionRuntime } from '../../extensions/runtime.js';

const PROVIDER_NAME = 'cap-054-test-provider';
const API_KEY_ENV = 'CAP_054_TEST_PROVIDER_API_KEY';

class CaptureProvider extends KodaXBaseProvider {
  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'capture-model',
    supportsThinking: false,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    streamOptions?: KodaXProviderStreamOptions,
    _signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    // Drive at least one text:delta callback so CAP-EXT-EVENTS-003 has
    // a delta to assert against. Provider stream callbacks must run
    // synchronously (or at least flush) before the result resolves.
    streamOptions?.onTextDelta?.('hello world');
    return {
      textBlocks: [{ type: 'text', text: 'hello world' }],
      toolBlocks: [],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    };
  }
}

// Issue 128: contract tests drive runKodaX end-to-end and flake at 5000ms
// default under heavy parallel vitest load. Bump per-suite to 15s.
describe('CAP-054: extension event lifecycle contract', { timeout: 15_000 }, () => {
  let runtime: ReturnType<typeof createExtensionRuntime>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let emitSpy: any;

  beforeEach(() => {
    process.env[API_KEY_ENV] = 'test-key';
    runtime = createExtensionRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitSpy = vi.spyOn(runtime as any, 'emit');
    setActiveExtensionRuntime(runtime);
    registerModelProvider(PROVIDER_NAME, () => new CaptureProvider());
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
    emitSpy.mockRestore();
    setActiveExtensionRuntime(null);
  });

  function eventNames(): string[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return emitSpy.mock.calls.map((call: any[]) => String(call[0]));
  }

  it('CAP-EXT-EVENTS-001: session:start fires exactly once per runKodaX call (before any turn:start)', async () => {
    await runKodaX(
      { provider: PROVIDER_NAME, model: 'capture-model' },
      'do thing',
    );
    const names = eventNames();
    const sessionStartCount = names.filter((n) => n === 'session:start').length;
    expect(sessionStartCount).toBe(1);
    // session:start precedes turn:start
    const sessionIdx = names.indexOf('session:start');
    const turnStartIdx = names.indexOf('turn:start');
    if (turnStartIdx >= 0) {
      expect(sessionIdx).toBeLessThan(turnStartIdx);
    }
  });

  it('CAP-EXT-EVENTS-002: turn:start and turn:end are paired (N turns → N start + N end)', async () => {
    await runKodaX(
      { provider: PROVIDER_NAME, model: 'capture-model' },
      'do thing',
    );
    const names = eventNames();
    const startCount = names.filter((n) => n === 'turn:start').length;
    const endCount = names.filter((n) => n === 'turn:end').length;
    // CaptureProvider returns text-only with no tool calls → exactly
    // 1 turn (single iteration before terminal). The pairing invariant
    // is what matters; the count is also asserted.
    expect(startCount).toBe(endCount);
    expect(startCount).toBeGreaterThanOrEqual(1);
  });

  it('CAP-EXT-EVENTS-003: text:delta is bridged from the provider stream callback to the extension runtime', async () => {
    await runKodaX(
      { provider: PROVIDER_NAME, model: 'capture-model' },
      'do thing',
    );
    const names = eventNames();
    expect(names).toContain('text:delta');
  });

  it('CAP-EXT-EVENTS-004: complete fires on the success terminal path', async () => {
    const result = await runKodaX(
      { provider: PROVIDER_NAME, model: 'capture-model' },
      'do thing',
    );
    expect(result.success).toBe(true);
    const names = eventNames();
    expect(names).toContain('complete');
    // complete is the LAST event in the timeline (terminal).
    expect(names[names.length - 1]).toBe('complete');
  });
});
