import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import { extractTitleFromMessages } from './session.js';

describe('session title extraction', () => {
  it('uses visible text blocks from structured user messages', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'thinking', thinking: 'plan silently' },
          { type: 'text', text: 'Review auth flow' },
          { type: 'text', text: 'and tighten tests' },
        ],
      },
    ];

    expect(extractTitleFromMessages(messages)).toBe('Review auth flow and tighten tests');
  });

  it('falls back when the first user message has no visible text', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ignored' }],
      },
    ];

    expect(extractTitleFromMessages(messages)).toBe('Untitled Session');
  });

  it('normalizes whitespace before truncating long titles', () => {
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: '  line one\n\nline two '.repeat(8),
      },
    ];

    expect(extractTitleFromMessages(messages)).toBe(
      'line one line two line one line two line one line ...'
    );
  });
});
