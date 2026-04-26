/**
 * Contract test for CAP-009: buildPromptMessageContent multimodal images
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-009-buildpromptmessagecontent-multimodal-images
 *
 * Test obligations:
 * - CAP-MULTIMODAL-001: pasted/dragged images reach the entry user message as multimodal content blocks
 *
 * Risk: HIGH_RISK_PARITY — `runner-driven.ts:4345-4357` parity-restore evidence:
 * "Legacy agent.ts:1500 applies this at the single SA entry message"
 *
 * Verified location: agent.ts:1263 (single SA entry-message build site
 * after FEATURE_100 P2 line shifts; see also runner-driven.ts:3480).
 *
 * STATUS: ACTIVE since FEATURE_100 P2. The function moved from
 * `input-artifacts.ts` to `agent-runtime/prompt-content.ts`; this contract
 * pins the (text-only → string, text+image → block array) branch.
 */

import { describe, expect, it } from 'vitest';
import type { KodaXInputArtifact } from '@kodax/coding';

import { buildPromptMessageContent } from '../prompt-content.js';

describe('CAP-009: buildPromptMessageContent multimodal contract', () => {
  it('CAP-MULTIMODAL-001a: text-only prompt with no input artifacts returns the prompt as a plain string', () => {
    const result = buildPromptMessageContent('hello world');
    expect(result).toBe('hello world');
  });

  it('CAP-MULTIMODAL-001b: text-only prompt with empty input artifacts array returns the prompt as a plain string', () => {
    const result = buildPromptMessageContent('hello world', []);
    expect(result).toBe('hello world');
  });

  it('CAP-MULTIMODAL-001c: prompt + 1 image artifact returns [text, image] block array', () => {
    const artifacts: KodaXInputArtifact[] = [
      { kind: 'image', path: '/tmp/screenshot.png', mediaType: 'image/png', source: 'user-inline' },
    ];
    const result = buildPromptMessageContent('analyze this', artifacts);
    expect(result).toEqual([
      { type: 'text', text: 'analyze this' },
      { type: 'image', path: '/tmp/screenshot.png', mediaType: 'image/png' },
    ]);
  });

  it('CAP-MULTIMODAL-001d: prompt + multiple image artifacts produces text block + one image block per artifact, in order', () => {
    const artifacts: KodaXInputArtifact[] = [
      { kind: 'image', path: '/tmp/a.png', mediaType: 'image/png', source: 'user-inline' },
      { kind: 'image', path: '/tmp/b.jpg', mediaType: 'image/jpeg', source: 'user-inline' },
    ];
    const result = buildPromptMessageContent('compare', artifacts);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { type: 'text', text: 'compare' },
      { type: 'image', path: '/tmp/a.png', mediaType: 'image/png' },
      { type: 'image', path: '/tmp/b.jpg', mediaType: 'image/jpeg' },
    ]);
  });

  it('CAP-MULTIMODAL-001e: non-image artifact kinds are silently skipped (forward-compat)', () => {
    // Forward-compat: KodaXInputArtifact's `kind` is currently only 'image',
    // but the implementation uses flatMap with a kind check so adding new
    // artifact kinds in the future doesn't accidentally pass through as
    // unknown content blocks. Enforce that contract.
    const artifacts: KodaXInputArtifact[] = [
      { kind: 'image', path: '/tmp/a.png', mediaType: 'image/png', source: 'user-inline' },
      // simulate a future non-image artifact kind
      { kind: 'audio', path: '/tmp/b.mp3', source: 'user-inline' } as unknown as KodaXInputArtifact,
    ];
    const result = buildPromptMessageContent('mixed', artifacts);
    expect(result).toEqual([
      { type: 'text', text: 'mixed' },
      { type: 'image', path: '/tmp/a.png', mediaType: 'image/png' },
    ]);
  });
});
