/**
 * Contract test for CAP-072: incomplete tool call retry chain
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-072-incomplete-tool-call-retry-chain
 *
 * Test obligations:
 * - CAP-INCOMPLETE-TOOL-001: first retry has gentle "be concise" prompt
 * - CAP-INCOMPLETE-TOOL-002: subsequent retries escalate to critical warning
 * - CAP-INCOMPLETE-TOOL-003: max-retries skip-execute fills error tool_results for incomplete ids
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/incomplete-tool-retry.ts (extracted
 * from agent.ts:1233-1285 — pre-FEATURE_100 baseline — during FEATURE_100 P3.3b)
 *
 * Time-ordering constraint: AFTER stream return; BEFORE tool dispatch; counter resets on
 * successful turn (no incomplete blocks).
 *
 * Active here:
 *   - retry path: pop assistant, push synthetic _synthetic:true user message
 *   - retry-1 prompt is the gentle "be concise" tone
 *   - retry-2+ escalates to "⚠️ CRITICAL"
 *   - maxed-out path: emit tool:result + onToolResult per missing-param tool,
 *     push error tool_results block, reset counter
 *   - no-incomplete: counter resets to 0
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3b.
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../../types.js';
import type { KodaXMessage, KodaXToolUseBlock } from '@kodax/ai';

import { checkAndRetryIncompleteTools } from '../incomplete-tool-retry.js';
import { KODAX_MAX_INCOMPLETE_RETRIES } from '../../constants.js';
import type { ExtensionEventEmitter } from '../stream-handler-wiring.js';

function makeSnapshot(label: string): KodaXContextTokenSnapshot {
  return {
    currentTokens: 100,
    source: 'estimated',
    usage: undefined,
    _label: label,
  } as unknown as KodaXContextTokenSnapshot;
}

function fakeEmitter(): ExtensionEventEmitter {
  return vi.fn().mockResolvedValue(undefined) as unknown as ExtensionEventEmitter;
}

function completeTool(id: string): KodaXToolUseBlock {
  return {
    id,
    name: 'read',
    type: 'tool_use',
    input: { path: '/tmp/file.txt' },
  } as unknown as KodaXToolUseBlock;
}

function incompleteWriteTool(id: string): KodaXToolUseBlock {
  // 'write' tool requires `content` — leaving it undefined makes it
  // incomplete per checkIncompleteToolCalls.
  return {
    id,
    name: 'write',
    type: 'tool_use',
    input: { file_path: '/tmp/file.txt' },
  } as unknown as KodaXToolUseBlock;
}

describe('CAP-072: checkAndRetryIncompleteTools — no incomplete', () => {
  it('CAP-INCOMPLETE-TOOL-NOOP: zero incomplete tools → outcome no_incomplete, counter reset to 0', async () => {
    const messages: KodaXMessage[] = [];
    const completed = makeSnapshot('completed');
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [completeTool('id-1')],
      events: {} as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: 2,
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: completed,
    });
    expect(result.outcome).toBe('no_incomplete');
    expect(result.nextIncompleteRetryCount).toBe(0); // load-bearing reset
    expect(result.nextContextTokenSnapshot).toBe(completed);
    expect(messages).toHaveLength(0); // no mutation on no_incomplete
  });
});

describe('CAP-072: checkAndRetryIncompleteTools — under cap (retry path)', () => {
  it('CAP-INCOMPLETE-TOOL-001: retry count 1 → gentle "be concise" prompt with _synthetic flag', async () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const onRetry = vi.fn();
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [incompleteWriteTool('id-1')],
      events: { onRetry } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: 0,
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('retry');
    expect(result.nextIncompleteRetryCount).toBe(1);
    expect(messages).toHaveLength(1); // popped assistant + pushed synthetic user
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!._synthetic).toBe(true);
    const content = messages[0]!.content as string;
    expect(content).toMatch(/truncated/i);
    expect(content).toMatch(/under 50 lines/);
    expect(content).not.toMatch(/CRITICAL/);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('CAP-INCOMPLETE-TOOL-002: retry count >= 2 → escalated CRITICAL prompt with size limits', async () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [incompleteWriteTool('id-1')],
      events: { onRetry: vi.fn() } as unknown as KodaXEvents,
      emitActiveExtensionEvent: fakeEmitter(),
      messages,
      incompleteRetryCount: 1, // next retry is 2
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('retry');
    const content = messages[0]!.content as string;
    expect(content).toMatch(/CRITICAL/);
    expect(content).toMatch(/task will FAIL/);
  });
});

describe('CAP-072: checkAndRetryIncompleteTools — at cap (maxed-out path)', () => {
  it('CAP-INCOMPLETE-TOOL-003: at cap → outcome maxed_out, push error tool_results, reset counter, emit per missing-param tool', async () => {
    const messages: KodaXMessage[] = [{ role: 'assistant', content: [] }];
    const onRetry = vi.fn();
    const onToolResult = vi.fn();
    const emit = fakeEmitter();
    const result = await checkAndRetryIncompleteTools({
      toolBlocks: [incompleteWriteTool('tool-1')],
      events: { onRetry, onToolResult } as unknown as KodaXEvents,
      emitActiveExtensionEvent: emit,
      messages,
      incompleteRetryCount: KODAX_MAX_INCOMPLETE_RETRIES, // next attempt = cap+1
      preAssistantTokenSnapshot: makeSnapshot('pre'),
      completedTurnTokenSnapshot: makeSnapshot('completed'),
    });
    expect(result.outcome).toBe('maxed_out');
    expect(result.nextIncompleteRetryCount).toBe(0); // counter reset

    // Error tool_results pushed (assistant NOT popped — different from retry path).
    expect(messages.length).toBe(2);
    expect(messages[1]!.role).toBe('user');

    expect(onToolResult).toHaveBeenCalledOnce();
    const toolResultArg = onToolResult.mock.calls[0]![0] as { id: string; content: string };
    expect(toolResultArg.id).toBe('tool-1');
    expect(toolResultArg.content).toMatch(/Skipped due to missing required parameters/);
    expect(emit).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]![0]).toMatch(/Max retries exceeded/);
  });
});
