/**
 * Contract test for CAP-073: assistant content empty guard (Kimi 400 protection)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-073-assistant-content-empty-guard-kimi-400-protection
 *
 * Test obligations:
 * - CAP-EMPTY-CONTENT-GUARD-001: zero-text + zero-visible-tool yields '...' placeholder
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/assistant-message-builder.ts (extracted
 * from agent.ts:1064-1070 — pre-FEATURE_100 baseline — during FEATURE_100 P3.3a)
 *
 * Time-ordering constraint: BEFORE pushing assistant message into history.
 *
 * Active here:
 *   - empty array → single-element [{ type: 'text', text: '...' }]
 *   - non-empty array → reference-equal pass-through (no allocation)
 *   - placeholder text is exactly '...' (3 dots) — load-bearing for the
 *     "assistant continued silently" UX read; longer placeholders would
 *     pollute the visible transcript
 *
 * STATUS: ACTIVE since FEATURE_100 P3.3a.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXContentBlock } from '@kodax/ai';

import {
  guardEmptyAssistantContent,
  EMPTY_ASSISTANT_CONTENT_PLACEHOLDER,
} from '../assistant-message-builder.js';

describe('CAP-073: guardEmptyAssistantContent', () => {
  it('CAP-EMPTY-CONTENT-GUARD-001a: empty array → single-element placeholder array', () => {
    const result = guardEmptyAssistantContent([]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: '...' });
  });

  it('CAP-EMPTY-CONTENT-GUARD-001b: non-empty array → reference-equal pass-through (hot-path: no allocation)', () => {
    const content: KodaXContentBlock[] = [
      { type: 'text', text: 'hello' } as KodaXContentBlock,
    ];
    const result = guardEmptyAssistantContent(content);
    expect(result).toBe(content); // reference-equal — load-bearing for hot-path perf
  });

  it('CAP-EMPTY-CONTENT-GUARD-001c: placeholder is the exported constant (single source of truth)', () => {
    const result = guardEmptyAssistantContent([]);
    expect(result[0]).toBe(EMPTY_ASSISTANT_CONTENT_PLACEHOLDER);
  });

  it('CAP-EMPTY-CONTENT-GUARD-001d: placeholder text is exactly "..." (3 ASCII dots, not unicode ellipsis)', () => {
    expect(EMPTY_ASSISTANT_CONTENT_PLACEHOLDER).toEqual({ type: 'text', text: '...' });
    // The 3-character ASCII string is intentional — a unicode ellipsis (…)
    // would be a single code point and would change byte-level diffs of
    // serialised history.
    expect((EMPTY_ASSISTANT_CONTENT_PLACEHOLDER as { text: string }).text.length).toBe(3);
  });

  it('CAP-EMPTY-CONTENT-GUARD-001e: a single-element non-empty array passes through (boundary check)', () => {
    const content: KodaXContentBlock[] = [
      { type: 'tool_use', id: 'x', name: 't', input: {} } as unknown as KodaXContentBlock,
    ];
    const result = guardEmptyAssistantContent(content);
    expect(result).toBe(content);
  });
});
