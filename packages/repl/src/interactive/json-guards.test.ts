import { describe, expect, it } from 'vitest';

import { isKodaXMessage, isKodaXSessionUiHistoryItem } from './json-guards.js';

describe('session JSON guards', () => {
  it('accepts every persisted multimodal tool-result content variant', () => {
    expect(isKodaXMessage({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-image',
        content: [
          { type: 'text', text: 'Screenshot captured.' },
          { type: 'image', path: 'C:/tmp/screenshot.png', mediaType: 'image/png' },
        ],
        metadata: { source: 'read' },
      }],
    })).toBe(true);
  });

  it('accepts persisted cache-boundary blocks', () => {
    expect(isKodaXMessage({
      role: 'system',
      content: [
        { type: 'text', text: 'Stable system prefix.' },
        { type: 'cache-boundary', hint: 'system' },
      ],
    })).toBe(true);
  });

  it('accepts only the explicit presentation-only provenance value', () => {
    expect(isKodaXSessionUiHistoryItem({
      type: 'assistant',
      text: 'Visible failed-turn summary.',
      presentationOnly: true,
    })).toBe(true);
    expect(isKodaXSessionUiHistoryItem({
      type: 'assistant',
      text: 'Invalid provenance.',
      presentationOnly: false,
    })).toBe(false);
  });
});
