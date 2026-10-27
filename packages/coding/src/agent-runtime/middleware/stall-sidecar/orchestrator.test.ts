import { describe, it, expect } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXStreamResult,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import { KodaXBaseProvider } from '@kodax-ai/llm';
import { createStallDetector } from '../../../multi-instance/stall-detector.js';
import { createStallOrchestrator } from './orchestrator.js';
import { createStallSidecarToolObserver } from './index.js';
import {
  REPORT_TOOL,
  SIDECAR_SYSTEM_PROMPT,
} from './prompts.js';

const FAKE_REPORT_TOOL: KodaXToolDefinition = REPORT_TOOL;

it('does not spend a delayed read-loop intervention on an unrelated plan creation', async () => {
  let judged!: () => void;
  const verdictReady = new Promise<void>(resolve => { judged = resolve; });
  const handle = createStallSidecarToolObserver({
    detector: createStallDetector({ disabled: false }),
    provider: new CannedSidecarProvider({ isStuck: true, nudge: 'Stop the repeated inspection and edit the source.' }),
    onVerdict: () => judged(),
  });
  const repeated = { id: 'read', name: 'read', input: { path: 'src/recovery.js' } };
  for (let i = 0; i < 3; i++) await handle.observer.onToolCall?.({ ...repeated, id: `read-${i}` });
  await verdictReady;
  expect(await handle.observer.beforeTool?.({ id: 'plan', name: 'todo_create', input: { subject: 'Implement the remaining repair' } })).toBe(true);
  expect(await handle.observer.beforeTool?.({ id: 'other', name: 'read', input: { path: 'another-file.js' } })).toBe(true);
  // Planning does not disable the existing loop intervention if inspection resumes.
  expect(await handle.observer.beforeTool?.(repeated)).toBe('Stop the repeated inspection and edit the source.');
  expect(await handle.observer.beforeTool?.(repeated)).toBe(true);
});

it('keeps repository-family interventions relevant while allowing the repair boundary', async () => {
  let judged!: () => void;
  const ready = new Promise<void>(resolve => { judged = resolve; });
  const handle = createStallSidecarToolObserver({
    detector: createStallDetector({ disabled: false, probeFamilyThreshold: 3 }),
    provider: new CannedSidecarProvider({ isStuck: true, nudge: 'Stop broad inspection.' }),
    onVerdict: () => judged(),
  });
  for (const file of ['a', 'b', 'c']) await handle.observer.onToolCall?.({ id: file, name: 'read', input: { path: file } });
  await ready;
  expect(await handle.observer.beforeTool?.({ id: 'plan', name: 'todo_create', input: { subject: 'Repair' } })).toBe(true);
  expect(await handle.observer.beforeTool?.({ id: 'grep', name: 'grep', input: { pattern: 'another broad query' } })).toBe('Stop broad inspection.');
});

it('drops an in-flight inspection verdict after an existing progress boundary', async () => {
  const provider = new DeferredSidecarProvider();
  const orch = createStallOrchestrator({ detector: createStallDetector({ disabled: false }), provider,
    systemPrompt: SIDECAR_SYSTEM_PROMPT, reportTool: FAKE_REPORT_TOOL });
  const repeated = { id: 'read', name: 'read', input: { path: 'source.js' } };
  for (let i = 0; i < 3; i++) orch.recordToolUse({ ...repeated, id: `r${i}` });
  orch.recordToolUse({ id: 'repair', name: 'edit', input: { path: 'source.js', edits: [] } });
  provider.resolve('Inspection before the edit was stuck.');
  await Promise.all(orch.debug.pendingSidecarPromises());
  expect(orch.debug.hasPendingNudge()).toBe(false);
});

it('does not mistake another identical stalled edit for progress', async () => {
  const provider = new DeferredSidecarProvider();
  const orch = createStallOrchestrator({ detector: createStallDetector({ disabled: false }), provider,
    systemPrompt: SIDECAR_SYSTEM_PROMPT, reportTool: FAKE_REPORT_TOOL });
  const repeated = { id: 'edit', name: 'edit', input: { path: 'source.js', edits: [] } };
  for (let i = 0; i < 4; i++) orch.recordToolUse({ ...repeated, id: `e${i}` });
  provider.resolve('Reread the current file before retrying this edit.');
  await Promise.all(orch.debug.pendingSidecarPromises());
  expect(orch.consumePendingNudge(repeated)).toBe('Reread the current file before retrying this edit.');
});

it('clears a queued inspection verdict when a repair is dispatched', async () => {
  const orch = createStallOrchestrator({ detector: createStallDetector({ disabled: false }),
    provider: new CannedSidecarProvider({ isStuck: true, nudge: 'Stop inspection.' }),
    systemPrompt: SIDECAR_SYSTEM_PROMPT, reportTool: FAKE_REPORT_TOOL });
  const read = { id: 'read', name: 'read', input: { path: 'a.ts' } };
  for (let i = 0; i < 3; i++) orch.recordToolUse({ ...read, id: `r${i}` });
  await Promise.all(orch.debug.pendingSidecarPromises());
  const repair = { id: 'write', name: 'write', input: { path: 'a.ts', content: 'fixed' } };
  expect(orch.consumePendingNudge(repair)).toBeUndefined();
  orch.recordToolUse(repair);
  expect(orch.consumePendingNudge(read)).toBeUndefined();
});

class CannedSidecarProvider extends KodaXBaseProvider {
  readonly name = 'canned-sidecar';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'CANNED_SIDECAR',
    model: 'canned',
    supportsThinking: false,
    contextWindow: 100000,
  };

  public captured: { messages: KodaXMessage[]; system: string }[] = [];

  constructor(
    private readonly verdict: { isStuck: boolean; nudge?: string; suggestedTool?: string },
  ) {
    super();
  }

  async stream(
    messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    system: string,
    _thinking?: boolean,
    _opts?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    this.captured.push({ messages, system });
    const block: KodaXToolUseBlock = {
      type: 'tool_use',
      id: 'tu_v',
      name: 'report_stall_judgment',
      input: {
        isStuck: this.verdict.isStuck,
        reason: 'canned',
        suggestedTool: this.verdict.suggestedTool ?? '',
        nudge: this.verdict.nudge ?? '',
      },
    };
    return {
      textBlocks: [],
      toolBlocks: [block],
      thinkingBlocks: [],
    };
  }
}

class DeferredSidecarProvider extends KodaXBaseProvider {
  readonly name = 'deferred-sidecar';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'DEFERRED_SIDECAR',
    model: 'deferred',
    supportsThinking: false,
    contextWindow: 100000,
  };

  public captured = 0;
  private resolveStream?: (result: KodaXStreamResult) => void;

  async stream(): Promise<KodaXStreamResult> {
    this.captured += 1;
    return new Promise<KodaXStreamResult>((resolve) => {
      this.resolveStream = resolve;
    });
  }

  resolve(nudge: string): void {
    this.resolveStream?.({
      textBlocks: [],
      thinkingBlocks: [],
      toolBlocks: [{
        type: 'tool_use',
        id: 'tu_deferred',
        name: 'report_stall_judgment',
        input: { isStuck: true, reason: 'canned', suggestedTool: '', nudge },
      }],
    });
  }
}

async function flushMicrotasks(): Promise<void> {
  // The orchestrator stores the sidecar promise in pendingPromises;
  // tests can await all of them via `Promise.all(debug.pendingSidecarPromises())`.
  await Promise.resolve();
  await Promise.resolve();
}

describe('FEATURE_178 (v0.7.42): createStallOrchestrator', () => {
  describe('no-stall path — sidecar never invoked', () => {
    it('does not fire sidecar on the first two tool calls (no stall signal)', async () => {
      const detector = createStallDetector({ disabled: false });
      const provider = new CannedSidecarProvider({ isStuck: true, nudge: 'n' });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      const fired1 = orch.recordToolUse({ name: 'read', id: 't1', input: { path: 'a.ts' } });
      const fired2 = orch.recordToolUse({ name: 'read', id: 't2', input: { path: 'a.ts' } });
      expect(fired1).toBe(false);
      expect(fired2).toBe(false);
      // Sidecar wasn't invoked — captured is empty.
      expect(provider.captured).toHaveLength(0);
    });
  });

  describe('stall path — sidecar invoked, verdict consumed', () => {
    it('fires sidecar on 3rd identical call; isStuck=true → nudge queued', async () => {
      const detector = createStallDetector({ disabled: false });
      const provider = new CannedSidecarProvider({
        isStuck: true,
        nudge: 'Call interrupt_agent and report.',
      });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      orch.recordToolUse({ name: 'read', id: 't1', input: { path: 'a.ts' } });
      orch.recordToolUse({ name: 'read', id: 't2', input: { path: 'a.ts' } });
      const fired3 = orch.recordToolUse({ name: 'read', id: 't3', input: { path: 'a.ts' } });
      expect(fired3).toBe(true);

      // Drain the fire-and-forget sidecar promise.
      await Promise.all(orch.debug.pendingSidecarPromises());
      await flushMicrotasks();

      expect(provider.captured).toHaveLength(1);
      const userMsg = provider.captured[0].messages[0];
      expect(userMsg.role).toBe('user');
      expect(typeof userMsg.content).toBe('string');
      // Envelope is the prefix of the user message.
      expect(userMsg.content as string).toContain('[Stall detector signal]');
      // Transcript renders the tool_use turns.
      expect(userMsg.content as string).toContain('=== MAIN AGENT TRANSCRIPT');

      // Nudge is queued for consumption.
      expect(orch.debug.hasPendingNudge()).toBe(true);
      const consumed = orch.consumePendingNudge({ name: 'read', input: { path: 'a.ts' } });
      expect(consumed).toBe('Call interrupt_agent and report.');
      // Consuming clears the ref.
      expect(orch.debug.hasPendingNudge()).toBe(false);
      expect(orch.consumePendingNudge({ name: 'read', input: { path: 'a.ts' } })).toBeUndefined();
    });

    it('fires sidecar but isStuck=false → no nudge queued', async () => {
      const detector = createStallDetector({ disabled: false });
      const provider = new CannedSidecarProvider({ isStuck: false });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      orch.recordToolUse({ name: 'read', id: 't1', input: { path: 'a.ts' } });
      orch.recordToolUse({ name: 'read', id: 't2', input: { path: 'a.ts' } });
      orch.recordToolUse({ name: 'read', id: 't3', input: { path: 'a.ts' } });

      await Promise.all(orch.debug.pendingSidecarPromises());
      await flushMicrotasks();

      expect(provider.captured).toHaveLength(1);
      expect(orch.debug.hasPendingNudge()).toBe(false);
      expect(orch.consumePendingNudge({ name: 'read', input: { path: 'a.ts' } })).toBeUndefined();
    });
  });

  describe('transcript buffer', () => {
    it('records tool_use AND tool_result into the transcript', () => {
      const detector = createStallDetector({ disabled: false });
      const provider = new CannedSidecarProvider({ isStuck: false });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      expect(orch.debug.transcriptSize()).toBe(0);
      orch.recordToolUse({ name: 'read', id: 't1', input: { path: 'a.ts' } });
      expect(orch.debug.transcriptSize()).toBe(1);
      orch.recordToolResult({ id: 't1' }, 'file contents here');
      expect(orch.debug.transcriptSize()).toBe(2);
    });

    it('truncates the transcript at the window size (16)', () => {
      const detector = createStallDetector({ disabled: false });
      const provider = new CannedSidecarProvider({ isStuck: false });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      // 20 turns = 40 messages — overflow the 16-msg window.
      for (let i = 0; i < 20; i++) {
        orch.recordToolUse({ name: 't', id: `t${i}`, input: { i } });
        orch.recordToolResult({ id: `t${i}` }, `result ${i}`);
      }
      expect(orch.debug.transcriptSize()).toBe(16);
    });

    it('includes the transcript in the sidecar prompt when stall fires', async () => {
      const detector = createStallDetector({ disabled: false });
      const provider = new CannedSidecarProvider({ isStuck: true, nudge: 'x' });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      orch.recordToolUse({ name: 'read', id: 't1', input: { path: 'a.ts' } });
      orch.recordToolResult({ id: 't1' }, 'first read content');
      orch.recordToolUse({ name: 'read', id: 't2', input: { path: 'a.ts' } });
      orch.recordToolResult({ id: 't2' }, 'second read content');
      orch.recordToolUse({ name: 'read', id: 't3', input: { path: 'a.ts' } });

      await Promise.all(orch.debug.pendingSidecarPromises());
      await flushMicrotasks();

      expect(provider.captured).toHaveLength(1);
      const userMsg = provider.captured[0].messages[0].content as string;
      expect(userMsg).toContain('tool_use: read');
      expect(userMsg).toContain('first read content');
      expect(userMsg).toContain('second read content');
    });
  });

  describe('verdict callback', () => {
    it('fires onVerdict with the signal + verdict on every stall sidecar call', async () => {
      const captured: { signal: unknown; verdict: unknown }[] = [];
      const detector = createStallDetector({ disabled: false });
      const provider = new CannedSidecarProvider({ isStuck: true, nudge: 'n' });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
        onVerdict: (signal, verdict) => captured.push({ signal, verdict }),
      });

      orch.recordToolUse({ name: 'read', id: 't1', input: { path: 'a.ts' } });
      orch.recordToolUse({ name: 'read', id: 't2', input: { path: 'a.ts' } });
      orch.recordToolUse({ name: 'read', id: 't3', input: { path: 'a.ts' } });

      await Promise.all(orch.debug.pendingSidecarPromises());
      await flushMicrotasks();

      expect(captured).toHaveLength(1);
      const entry = captured[0];
      const sig = entry.signal as { kind: string; envelope?: string };
      const ver = entry.verdict as { isStuck: boolean; trace: string };
      expect(sig.kind).toBe('stall');
      expect(sig.envelope).toContain('[Stall detector signal]');
      expect(ver.isStuck).toBe(true);
      expect(ver.trace).toBe('sidecar_ok');
    });
  });

  describe('reset() — compaction post-hook companion', () => {
    it('drops transcript + pending nudge', async () => {
      const detector = createStallDetector({ disabled: false });
      const provider = new CannedSidecarProvider({ isStuck: true, nudge: 'n' });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      orch.recordToolUse({ name: 'read', id: 't1', input: { path: 'a.ts' } });
      orch.recordToolUse({ name: 'read', id: 't2', input: { path: 'a.ts' } });
      orch.recordToolUse({ name: 'read', id: 't3', input: { path: 'a.ts' } });
      await Promise.all(orch.debug.pendingSidecarPromises());
      await flushMicrotasks();
      expect(orch.debug.hasPendingNudge()).toBe(true);
      expect(orch.debug.transcriptSize()).toBeGreaterThan(0);

      orch.reset();
      expect(orch.debug.hasPendingNudge()).toBe(false);
      expect(orch.debug.transcriptSize()).toBe(0);
    });

    it('suppresses concurrent sidecars and ignores a pre-reset verdict', async () => {
      const detector = createStallDetector({ disabled: false });
      const provider = new DeferredSidecarProvider();
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      orch.recordToolUse({ name: 'read', id: 't1', input: { path: 'a.ts' } });
      orch.recordToolUse({ name: 'read', id: 't2', input: { path: 'a.ts' } });
      expect(orch.recordToolUse({ name: 'read', id: 't3', input: { path: 'a.ts' } }))
        .toBe(true);
      expect(orch.recordToolUse({ name: 'read', id: 't4', input: { path: 'a.ts' } }))
        .toBe(true);
      expect(provider.captured).toBe(1);

      orch.reset();
      provider.resolve('stale nudge');
      await Promise.all(orch.debug.pendingSidecarPromises());
      await flushMicrotasks();

      expect(orch.debug.hasPendingNudge()).toBe(false);
    });
  });

  describe('killswitch — detector disabled means no sidecar fires', () => {
    it('skips sidecar invocation when detector is disabled', async () => {
      const detector = createStallDetector({ disabled: true });
      const provider = new CannedSidecarProvider({ isStuck: true, nudge: 'n' });
      const orch = createStallOrchestrator({
        detector,
        provider,
        systemPrompt: SIDECAR_SYSTEM_PROMPT,
        reportTool: FAKE_REPORT_TOOL,
      });

      for (let i = 0; i < 5; i++) {
        orch.recordToolUse({ name: 'read', id: `t${i}`, input: { path: 'a.ts' } });
      }
      await flushMicrotasks();
      // Detector is a no-op shim → never fires stall → sidecar never called.
      expect(provider.captured).toHaveLength(0);
      expect(orch.debug.hasPendingNudge()).toBe(false);
    });
  });
});
