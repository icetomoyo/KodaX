/**
 * Contract test for CAP-032: structured tool error code extraction
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-032-structured-tool-error-code-extraction
 *
 * Test obligations:
 * - CAP-TOOL-ERROR-CODE-001: structured error envelope in tool result yields machine-readable code
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-result-classify.ts (extracted from
 * agent.ts:897-900 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER tool result; BEFORE error-routed policy
 * decisions (edit recovery, post-tool judge). The retry-decision middleware
 * reads `runtimeSessionState.lastToolErrorCode` which is populated from
 * this extractor in `updateToolOutcomeTracking`.
 *
 * Active here: regex envelope `^\[Tool Error\]\s+<name>:\s+(<CODE>):` —
 * the second `:` is mandatory, the code is `[A-Z_]+` only (lowercase /
 * mixed / digit-bearing codes intentionally do NOT match), and content
 * is `.trim()`-ed before matching.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import { extractStructuredToolErrorCode } from '../tool-result-classify.js';

describe('CAP-032: extractStructuredToolErrorCode contract', () => {
  it('CAP-TOOL-ERROR-CODE-001a: well-formed structured envelope → returns the [A-Z_]+ code', () => {
    expect(extractStructuredToolErrorCode('[Tool Error] edit: ANCHOR_NOT_FOUND: anchor missing')).toBe(
      'ANCHOR_NOT_FOUND',
    );
    expect(extractStructuredToolErrorCode('[Tool Error] read: FILE_NOT_FOUND: x.ts missing')).toBe(
      'FILE_NOT_FOUND',
    );
  });

  it('CAP-TOOL-ERROR-CODE-001b: leading/trailing whitespace tolerated (content is trimmed)', () => {
    expect(extractStructuredToolErrorCode('   [Tool Error] edit: PERMISSION_DENIED: nope\n')).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('CAP-TOOL-ERROR-CODE-001c: unstructured error / non-error content → undefined', () => {
    expect(extractStructuredToolErrorCode('[Tool Error] edit: anchor missing')).toBeUndefined();
    expect(extractStructuredToolErrorCode('[Cancelled] user aborted')).toBeUndefined();
    expect(extractStructuredToolErrorCode('regular tool output')).toBeUndefined();
    expect(extractStructuredToolErrorCode('')).toBeUndefined();
  });

  it('CAP-TOOL-ERROR-CODE-001d: code is anchored to `[A-Z_]+` only — lowercase / digits do NOT match', () => {
    expect(extractStructuredToolErrorCode('[Tool Error] edit: not_upper: nope')).toBeUndefined();
    expect(extractStructuredToolErrorCode('[Tool Error] edit: HAS9DIGIT: nope')).toBeUndefined();
  });
});
