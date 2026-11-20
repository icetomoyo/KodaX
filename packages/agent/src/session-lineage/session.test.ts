import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import {
  extractTitleFromMessages,
  generateSessionId,
  generateSessionIdSync,
} from './session.js';

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

describe('session ID generation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('generates unique UUIDv7 IDs while wall-clock time is frozen', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:34:56.789Z'));

    const ids = Array.from({ length: 1_000 }, () => generateSessionIdSync());

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
  });

  it('leads with the creation time in milliseconds so ids sort by creation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:34:56.789Z'));
    const earlier = generateSessionIdSync();
    vi.setSystemTime(new Date('2026-07-31T12:34:56.790Z'));
    const later = generateSessionIdSync();

    expect(parseInt(earlier.replace(/-/g, '').slice(0, 12), 16)).toBe(Date.parse('2026-07-31T12:34:56.789Z'));
    expect(earlier < later).toBe(true);
  });

  it('preserves the public async wrapper over the shared generator', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:34:56.789Z'));

    const ids = await Promise.all(
      Array.from({ length: 1_000 }, () => generateSessionId()),
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
  });
});
