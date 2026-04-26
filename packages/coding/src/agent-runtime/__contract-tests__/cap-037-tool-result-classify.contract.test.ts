/**
 * Contract test for CAP-037: tool result error/cancellation classification
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-037-tool-result-errorcancellation-classification
 *
 * Test obligations:
 * - CAP-TOOL-RESULT-CLASSIFY-001: error and cancelled content strings classified correctly
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-result-classify.ts (extracted from
 * agent.ts:773-779 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: in tool-result post-processing chain.
 *
 * Active here:
 *   - `isToolResultErrorContent` regex `^\[(?:Tool Error|Cancelled|Blocked|Error)\]`
 *     — case-sensitive, anchored at content start.
 *   - `isCancelledToolResultContent` exact prefix match against
 *     `CANCELLED_TOOL_RESULT_PREFIX` (`[Cancelled]`) — narrower than the
 *     error predicate.
 *
 * Both predicates are case-sensitive and must NOT match when the prefix
 * appears mid-string — these contracts are gates for downstream policy
 * decisions and false positives could mis-route success outcomes.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import { CANCELLED_TOOL_RESULT_PREFIX } from '../../constants.js';
import {
  isCancelledToolResultContent,
  isToolResultErrorContent,
} from '../tool-result-classify.js';

describe('CAP-037: isToolResultErrorContent — error/cancel/block prefix detection', () => {
  it('CAP-TOOL-RESULT-CLASSIFY-001a: each of the four error prefixes → true', () => {
    expect(isToolResultErrorContent('[Tool Error] edit: missing anchor')).toBe(true);
    expect(isToolResultErrorContent('[Cancelled] user aborted')).toBe(true);
    expect(isToolResultErrorContent('[Blocked] permission denied')).toBe(true);
    expect(isToolResultErrorContent('[Error] something')).toBe(true);
  });

  it('CAP-TOOL-RESULT-CLASSIFY-001b: success / non-prefixed content → false', () => {
    expect(isToolResultErrorContent('ok')).toBe(false);
    expect(isToolResultErrorContent('')).toBe(false);
    expect(isToolResultErrorContent('file written successfully')).toBe(false);
  });

  it('CAP-TOOL-RESULT-CLASSIFY-001c: prefix must be at content start (anchored regex) — embedded prefix → false', () => {
    expect(isToolResultErrorContent('successful: [Tool Error] would-be')).toBe(false);
    expect(isToolResultErrorContent(' [Tool Error] leading-space')).toBe(false);
  });

  it('CAP-TOOL-RESULT-CLASSIFY-001d: regex is case-sensitive — lowercased prefix → false', () => {
    expect(isToolResultErrorContent('[tool error] lower-case')).toBe(false);
    expect(isToolResultErrorContent('[cancelled] lower-case')).toBe(false);
  });
});

describe('CAP-037: isCancelledToolResultContent — narrow cancel predicate', () => {
  it('CAP-TOOL-RESULT-CLASSIFY-001e: content starting with CANCELLED_TOOL_RESULT_PREFIX → true (predicate is bound to the constant, not a literal)', () => {
    expect(isCancelledToolResultContent(`${CANCELLED_TOOL_RESULT_PREFIX} user aborted`)).toBe(true);
    expect(isCancelledToolResultContent(CANCELLED_TOOL_RESULT_PREFIX)).toBe(true);
  });

  it('CAP-TOOL-RESULT-CLASSIFY-001f: other error prefixes → false (cancellation is narrower than error)', () => {
    expect(isCancelledToolResultContent('[Tool Error] something')).toBe(false);
    expect(isCancelledToolResultContent('[Blocked] something')).toBe(false);
    expect(isCancelledToolResultContent('[Error] something')).toBe(false);
  });

  it('CAP-TOOL-RESULT-CLASSIFY-001g: success / non-prefixed → false', () => {
    expect(isCancelledToolResultContent('ok')).toBe(false);
    expect(isCancelledToolResultContent('')).toBe(false);
  });
});
