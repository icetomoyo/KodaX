/**
 * Contract test for CAP-088: tool evidence summarizer (for auto-reroute input)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-088-tool-evidence-summarizer-for-auto-reroute-input
 *
 * Test obligations:
 * - CAP-TOOL-EVIDENCE-001: deduplicates identical lines
 * - CAP-TOOL-EVIDENCE-002: truncates at 220 chars per item
 * - CAP-TOOL-EVIDENCE-003: caps at 5 lines
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/middleware/judges.ts (extracted from
 * agent.ts:3125-3152 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER tool dispatch + post-result processing
 * (CAP-077 / CAP-078); BEFORE post-tool judge gate (CAP-018).
 *
 * Active here:
 *   - dedup via `new Set()` of formatted lines
 *   - truncation at 220 chars (217 chars + `...` suffix)
 *   - 5-line cap via `.slice(0, 5)`
 *   - whitespace canonicalization via `replace(/\s+/g, ' ')`
 *   - the `looksLikeToolRuntimeEvidence` filter delegating to
 *     `looksLikeActionableRuntimeEvidence` (markers like `[tool error]`,
 *     `traceback`, `exception`, `exit: 1`, etc.)
 *   - non-string content skipped
 *   - tool-name lookup via toolBlocks (defaults to `'tool'` if id missing)
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXToolResultBlock } from '../../types.js';
import {
  looksLikeToolRuntimeEvidence,
  summarizeToolEvidence,
} from '../middleware/judges.js';

function evidenceResult(
  toolUseId: string,
  content: string | unknown,
): KodaXToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: content as string,
  };
}

describe('CAP-088: looksLikeToolRuntimeEvidence — delegate gate', () => {
  it('CAP-TOOL-EVIDENCE-GATE-1: actionable runtime markers (e.g. `[Tool Error]`, `traceback`, `exit: 1`) → true', () => {
    expect(looksLikeToolRuntimeEvidence('[Tool Error] read: not found')).toBe(true);
    expect(looksLikeToolRuntimeEvidence('Traceback (most recent call last):')).toBe(true);
    expect(looksLikeToolRuntimeEvidence('exit: 1')).toBe(true);
    expect(looksLikeToolRuntimeEvidence('assertion failed: x === y')).toBe(true);
  });

  it('CAP-TOOL-EVIDENCE-GATE-2: plain success output → false', () => {
    expect(looksLikeToolRuntimeEvidence('file contents OK')).toBe(false);
    expect(looksLikeToolRuntimeEvidence('')).toBe(false);
  });
});

describe('CAP-088: summarizeToolEvidence — truncation + dedup + cap', () => {
  it('CAP-TOOL-EVIDENCE-001: identical evidence lines from multiple tool results are deduplicated by Set', () => {
    // Two tool calls produce the same content → dedup keeps one line.
    const result = summarizeToolEvidence(
      [
        { id: 't1', name: 'bash' },
        { id: 't2', name: 'bash' },
      ],
      [
        evidenceResult('t1', 'Traceback (most recent call last):\n  File "a.py"'),
        evidenceResult('t2', 'Traceback (most recent call last):\n  File "a.py"'),
      ],
    );

    // After whitespace collapsing, both lines become identical → 1 line.
    expect(result.split('\n')).toHaveLength(1);
    expect(result).toContain('bash:');
  });

  it('CAP-TOOL-EVIDENCE-002: a tool result content longer than 220 chars is truncated at 217 + `...`', () => {
    const longContent = '[Tool Error] read: ' + 'x'.repeat(500);
    const result = summarizeToolEvidence(
      [{ id: 't1', name: 'read' }],
      [evidenceResult('t1', longContent)],
    );

    // Format: `- {toolName}: {truncated}` where truncated is 217 chars
    // followed by `...`. Total line content (after `- read: `): 220.
    // The line ends with `...`.
    expect(result.endsWith('...')).toBe(true);
    const colonIdx = result.indexOf(': ');
    const summaryContent = result.slice(colonIdx + 2);
    expect(summaryContent.length).toBe(220);
  });

  it('CAP-TOOL-EVIDENCE-002c: content exactly 220 chars is NOT truncated (gate is strict `> 220`)', () => {
    // Off-by-one canary: if the gate ever drifts to `>= 220`, this test fails.
    const prefix = '[Tool Error] bash: ';
    const exactContent = prefix + 'x'.repeat(220 - prefix.length);
    expect(exactContent.length).toBe(220);
    const result = summarizeToolEvidence(
      [{ id: 't1', name: 'bash' }],
      [evidenceResult('t1', exactContent)],
    );
    expect(result.endsWith('...')).toBe(false);
    const summaryContent = result.slice(result.indexOf(': ') + 2);
    expect(summaryContent.length).toBe(220);
  });

  it('CAP-TOOL-EVIDENCE-002b: content shorter than 220 chars is NOT truncated', () => {
    const result = summarizeToolEvidence(
      [{ id: 't1', name: 'read' }],
      [evidenceResult('t1', '[Tool Error] read: short message')],
    );
    expect(result.endsWith('...')).toBe(false);
    expect(result).toContain('short message');
  });

  it('CAP-TOOL-EVIDENCE-003: with 8 tool results passing the gate, output is capped at 5 lines', () => {
    const blocks = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      name: `tool${i}`,
    }));
    const results = Array.from({ length: 8 }, (_, i) =>
      evidenceResult(`t${i}`, `[Tool Error] tool${i}: distinct error message ${i}`),
    );

    const result = summarizeToolEvidence(blocks, results);
    expect(result.split('\n')).toHaveLength(5);
  });
});

describe('CAP-088: summarizeToolEvidence — gating + tool-name lookup', () => {
  it('CAP-TOOL-EVIDENCE-FILTER-1: results that fail the runtime-evidence gate are excluded', () => {
    const result = summarizeToolEvidence(
      [
        { id: 't1', name: 'read' },
        { id: 't2', name: 'bash' },
      ],
      [
        evidenceResult('t1', 'plain success output'),
        evidenceResult('t2', '[Tool Error] bash: command failed'),
      ],
    );

    expect(result.split('\n')).toHaveLength(1);
    expect(result).toContain('bash:');
    expect(result).not.toContain('read:');
  });

  it('CAP-TOOL-EVIDENCE-NON-STRING: non-string content (multimodal blocks) is skipped without throwing', () => {
    const result = summarizeToolEvidence(
      [{ id: 't1', name: 'read' }],
      [evidenceResult('t1', [{ type: 'image' }])],
    );
    expect(result).toBe('');
  });

  it('CAP-TOOL-EVIDENCE-MISSING-NAME: a tool result with no matching toolBlocks entry uses default `tool` name', () => {
    const result = summarizeToolEvidence(
      [], // no toolBlocks at all
      [evidenceResult('t-orphan', '[Tool Error] orphan: failure')],
    );
    expect(result).toContain('- tool:');
  });

  it('CAP-TOOL-EVIDENCE-WHITESPACE: multi-line / multi-space content is collapsed to single spaces before evaluation', () => {
    const result = summarizeToolEvidence(
      [{ id: 't1', name: 'bash' }],
      [evidenceResult('t1', '[Tool Error]\n   bash:\n\nmultiple\nspaces')],
    );

    // No newlines / extra spaces in the summarized line content.
    expect(result.includes('\n  ')).toBe(false);
    expect(result).toContain('[Tool Error] bash:');
  });
});
