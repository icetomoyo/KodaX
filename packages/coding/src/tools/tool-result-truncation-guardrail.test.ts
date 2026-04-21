/**
 * Adapter tests — FEATURE_085 (v0.7.26).
 *
 * Verifies that the ToolGuardrail wrapper around `applyToolResultGuardrail`
 * preserves the byte-exact truncation behaviour of the legacy path:
 *   - When content fits the policy, returns allow (no rewrite)
 *   - When content exceeds the policy, returns rewrite with the same
 *     truncated content the legacy function would produce
 *   - Passes through error results without inspection
 */

import { describe, expect, it } from 'vitest';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME,
  createToolResultTruncationGuardrail,
} from './tool-result-truncation-guardrail.js';
import { applyToolResultGuardrail } from './tool-result-policy.js';

function makeCtx(): KodaXToolExecutionContext {
  return {
    gitRoot: '/tmp/kodax-test-guardrail',
    executionCwd: '/tmp/kodax-test-guardrail',
    events: {},
    kodax: { eventListeners: [], emitRunLog: () => undefined },
  } as unknown as KodaXToolExecutionContext;
}

describe('tool-result-truncation-guardrail adapter', () => {
  it('is a ToolGuardrail with the expected name', () => {
    const g = createToolResultTruncationGuardrail(makeCtx());
    expect(g.kind).toBe('tool');
    expect(g.name).toBe(TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME);
    expect(typeof g.afterTool).toBe('function');
    expect(g.beforeTool).toBeUndefined();
  });

  it('allows short content through without rewrite', async () => {
    const g = createToolResultTruncationGuardrail(makeCtx());
    const verdict = await g.afterTool!(
      { id: 'c1', name: 'read', input: {} },
      { content: 'short output' },
      { agent: { name: 't', instructions: '' } },
    );
    expect(verdict.action).toBe('allow');
  });

  it('rewrites content when exceeding tool policy (byte-equivalent to legacy modulo spill-file noise)', async () => {
    const ctx = makeCtx();
    // `bash` policy: 600 lines / 32KB tail. Generate 1000 numbered lines.
    const big = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n');
    const legacyResult = await applyToolResultGuardrail('bash', big, ctx);
    expect(legacyResult.truncated).toBe(true);

    const g = createToolResultTruncationGuardrail(makeCtx());
    const verdict = await g.afterTool!(
      { id: 'c1', name: 'bash', input: {} },
      { content: big },
      { agent: { name: 't', instructions: '' } },
    );
    expect(verdict.action).toBe('rewrite');
    if (verdict.action === 'rewrite') {
      const payload = verdict.payload as { content: string };
      // Mask the spill-file noise (timestamp + random suffix in filename) so
      // the byte-comparison targets the truncated payload proper. Any change
      // to the truncation algorithm would still be caught.
      const mask = (s: string): string =>
        s.replace(/Full output saved to: [^.]+\.kodax[^\s]+\.txt\./g, 'Full output saved to: <PATH>.');
      expect(mask(payload.content)).toBe(mask(legacyResult.content));
    }
  });

  it('skips inspection when the tool result is an error', async () => {
    const g = createToolResultTruncationGuardrail(makeCtx());
    const verdict = await g.afterTool!(
      { id: 'c1', name: 'read', input: {} },
      { content: 'any length of content here '.repeat(5000), isError: true },
      { agent: { name: 't', instructions: '' } },
    );
    expect(verdict.action).toBe('allow');
  });
});
