/**
 * Contract test for CAP-046: duplicate user message detection
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-046-duplicate-user-message-detection
 *
 * Test obligations:
 * - CAP-DUPLICATE-MSG-001: no double-push when initialMessages tail equals prompt
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/auto-resume.ts (extracted from
 * agent.ts:1503-1511 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER session loading; BEFORE first turn.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import type { KodaXMessage } from '@kodax/ai';
import { describe, expect, it } from 'vitest';

import {
  appendPromptIfNotDuplicate,
  extractComparableUserMessageText,
  extractPromptComparableText,
} from '../middleware/auto-resume.js';

describe('CAP-046: duplicate user message detection contract', () => {
  it('CAP-DUPLICATE-MSG-001a: when transcript tail is a user message with the same canonical text as prompt, the prompt is NOT re-appended', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Refactor the auth middleware' },
    ];
    const result = appendPromptIfNotDuplicate(messages, 'Refactor the auth middleware', undefined);
    expect(result).toBe(messages); // identity — no clone when no append
    expect(result).toHaveLength(1);
  });

  it('CAP-DUPLICATE-MSG-001b: when transcript tail differs from prompt, the prompt IS appended as a new user message (returns new array, original untouched)', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'previous turn' },
    ];
    const result = appendPromptIfNotDuplicate(messages, 'next turn', undefined);
    expect(result).not.toBe(messages); // new array
    expect(messages).toHaveLength(1); // input untouched
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ role: 'user', content: 'next turn' });
  });

  it('CAP-DUPLICATE-MSG-001c: when transcript tail is an assistant message, even with text equal to prompt, the prompt IS appended (compare ignores non-user messages)', () => {
    const messages: KodaXMessage[] = [
      { role: 'assistant', content: 'sounds like a plan' },
    ];
    const result = appendPromptIfNotDuplicate(messages, 'sounds like a plan', undefined);
    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe('user');
  });

  it('CAP-DUPLICATE-MSG-001d: empty transcript → prompt is appended unconditionally', () => {
    const result = appendPromptIfNotDuplicate([], 'first prompt', undefined);
    expect(result).toEqual([{ role: 'user', content: 'first prompt' }]);
  });

  it('CAP-DUPLICATE-MSG-CANON-001: extractPromptComparableText extracts joined text from content blocks (multimodal-safe canonicalisation)', () => {
    const blockContent: KodaXMessage['content'] = [
      { type: 'text', text: 'first line' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } },
      { type: 'text', text: 'second line' },
    ] as never;

    expect(extractPromptComparableText(blockContent)).toBe('first line\nsecond line');
    expect(extractPromptComparableText('plain string')).toBe('plain string');
  });

  it('CAP-DUPLICATE-MSG-CANON-002: extractComparableUserMessageText returns undefined for non-user roles and undefined input', () => {
    expect(extractComparableUserMessageText(undefined)).toBeUndefined();
    expect(extractComparableUserMessageText({ role: 'assistant', content: 'x' })).toBeUndefined();
    expect(
      extractComparableUserMessageText({ role: 'user', content: 'hello' }),
    ).toBe('hello');
  });

  it('CAP-DUPLICATE-MSG-CANON-003: multimodal user message — comparable text is the joined text-block content (image blocks ignored, so prompt re-push is skipped if text portion matches)', () => {
    // Real-world: REPL re-feeds the same prompt + same image, the user
    // message content is multimodal but the text portion is what matters
    // for duplicate detection.
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'review this screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } },
        ] as never,
      },
    ];
    const result = appendPromptIfNotDuplicate(messages, 'review this screenshot', undefined);
    expect(result).toBe(messages); // duplicate detected — no append
  });
});
