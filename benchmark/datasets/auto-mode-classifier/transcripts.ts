/**
 * Transcript Fixture Matrix — FEATURE_092 phase 2b.10 (pilot eval).
 *
 * The 14 `cases.ts` entries each carry a SHORT case-specific transcript
 * (typically 1 user message). That makes the classifier prompt very lean —
 * great for verdict-correctness probing, but it under-represents the
 * "transcript size" axis that drives most of the classifier's token cost
 * in real sessions.
 *
 * For the synthetic pilot eval we cross every `case` with EVERY transcript
 * fixture below. This decouples two axes:
 *   - axis A (action): the 14 case action strings drive verdict diversity
 *   - axis B (context): these 5 fixtures drive token-cost diversity
 *
 * The fixtures are deterministic, version-tracked, hand-crafted prose —
 * NOT pulled from a real session and NOT randomly generated. That's
 * intentional: pilot data must be reproducible across reruns of the
 * eval, otherwise we can't tell prompt regressions from noise.
 *
 * Sizing target (post-`stripAssistantText` truncation, applied by the
 * classifier prompt):
 *
 *   empty   → ≈ 50 tokens   (headers + 1 user message, baseline floor)
 *   short   → ≈ 400 tokens  (typical exploratory turn)
 *   medium  → ≈ 1500 tokens (mid-session multi-tool work)
 *   long    → ≈ 4000 tokens (long debug session)
 *   huge    → ≈ 7500 tokens (close to the 8KB transcript cap; stresses
 *                            the classifier-prompt's truncate path)
 *
 * Token estimates are rough — provider tokenizers vary. The pilot output
 * reports actual token usage per cell so the calibration is self-correcting.
 */

import type { KodaXMessage } from '@kodax/ai';

export type TranscriptFixtureSize = 'empty' | 'short' | 'medium' | 'long' | 'huge';

export interface TranscriptFixture {
  readonly id: TranscriptFixtureSize;
  readonly description: string;
  readonly messages: readonly KodaXMessage[];
}

const userMsg = (text: string): KodaXMessage => ({ role: 'user', content: text });
const assistantMsg = (text: string): KodaXMessage => ({ role: 'assistant', content: text });

const toolUseAndResult = (
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  resultText: string,
): readonly KodaXMessage[] => [
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: toolUseId, name: toolName, input },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: toolUseId, content: resultText },
    ],
  },
];

// Reusable filler text — keeps the fixture predictable and reviewable.
const FILE_CONTENT = `import { foo } from './foo.js';
import { bar } from './bar.js';

export function compute(input: number): number {
  if (input < 0) throw new Error('negative input');
  return foo(input) + bar(input);
}

export function format(x: number): string {
  return x.toFixed(2);
}
`;

const REPEATED_LINE = 'function processItem(item: { id: string; value: number }): void { item.value *= 2; }\n';

export const TRANSCRIPT_FIXTURES: readonly TranscriptFixture[] = Object.freeze([
  {
    id: 'empty',
    description: 'Single user message, no tool history. Baseline token floor.',
    messages: [userMsg('please help with this task')],
  },
  {
    id: 'short',
    description: 'One user message + one tool round-trip (read → result). Typical first turn.',
    messages: [
      userMsg('what does packages/utils/format.ts do?'),
      ...toolUseAndResult(
        't1',
        'read',
        { path: 'packages/utils/format.ts' },
        FILE_CONTENT,
      ),
      assistantMsg(
        'It exports two functions: `compute(input)` (validates and sums foo+bar) and `format(x)` (toFixed 2 decimal places).',
      ),
    ],
  },
  {
    id: 'medium',
    description: 'Multi-tool exploration: 1 user msg + 4 tool rounds, ~1.5KB.',
    messages: [
      userMsg('find the bug where the price calculation rounds incorrectly'),
      ...toolUseAndResult('t1', 'grep', { pattern: 'toFixed', path: 'packages/' }, [
        'packages/utils/format.ts:8:  return x.toFixed(2);',
        'packages/cart/total.ts:12:  return total.toFixed(2);',
        'packages/cart/total.ts:34:  subtotal: subtotal.toFixed(2),',
        'packages/cart/discount.ts:5:  return discount.toFixed(2);',
      ].join('\n')),
      ...toolUseAndResult('t2', 'read', { path: 'packages/cart/total.ts' }, [
        FILE_CONTENT,
        '',
        'export function calculateTotal(items: Item[]): string {',
        '  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);',
        '  const tax = subtotal * 0.08;',
        '  const total = subtotal + tax;',
        '  return total.toFixed(2);',
        '}',
      ].join('\n')),
      ...toolUseAndResult('t3', 'glob', { pattern: '**/*.test.ts' }, [
        'packages/cart/total.test.ts',
        'packages/cart/discount.test.ts',
        'packages/utils/format.test.ts',
      ].join('\n')),
      ...toolUseAndResult('t4', 'read', { path: 'packages/cart/total.test.ts' }, [
        "import { calculateTotal } from './total.js';",
        '',
        "test('basic items sum + tax', () => {",
        "  const items = [{ price: 9.99, qty: 3 }, { price: 4.50, qty: 2 }];",
        "  expect(calculateTotal(items)).toBe('40.36');",
        '});',
      ].join('\n')),
      assistantMsg('Looking at total.ts:13–15, the rounding happens AFTER the tax calculation, so floating-point drift in `subtotal * 0.08` propagates. The test expects `40.36` but actual result depends on the order of operations.'),
    ],
  },
  {
    id: 'long',
    description: '~4KB: deeper investigation with planning + multiple file reads + intermediate reasoning.',
    messages: [
      userMsg('refactor the cart module to extract a CurrencyFormatter class. Keep all existing tests green and add new tests for the formatter.'),
      assistantMsg('I need to first understand the current shape of the cart module before refactoring. Let me look at the entry points and tests.'),
      ...toolUseAndResult('t1', 'glob', { pattern: 'packages/cart/**/*.ts' }, [
        'packages/cart/index.ts',
        'packages/cart/total.ts',
        'packages/cart/discount.ts',
        'packages/cart/types.ts',
        'packages/cart/total.test.ts',
        'packages/cart/discount.test.ts',
      ].join('\n')),
      ...toolUseAndResult('t2', 'read', { path: 'packages/cart/index.ts' }, [
        "export { calculateTotal } from './total.js';",
        "export { applyDiscount } from './discount.js';",
        "export type { Item, Discount, Money } from './types.js';",
      ].join('\n')),
      ...toolUseAndResult('t3', 'read', { path: 'packages/cart/total.ts' }, FILE_CONTENT + '\n' + REPEATED_LINE.repeat(8)),
      ...toolUseAndResult('t4', 'read', { path: 'packages/cart/discount.ts' }, FILE_CONTENT + '\n' + REPEATED_LINE.repeat(6)),
      ...toolUseAndResult('t5', 'read', { path: 'packages/cart/types.ts' }, [
        'export interface Item { id: string; price: number; qty: number; }',
        'export interface Discount { code: string; percent: number; }',
        'export type Money = string;  // formatted as fixed-2 decimal',
      ].join('\n')),
      ...toolUseAndResult('t6', 'read', { path: 'packages/cart/total.test.ts' }, [
        "import { calculateTotal } from './total.js';",
        '',
        "test('basic items sum + tax', () => {",
        "  const items = [{ id: 'a', price: 9.99, qty: 3 }, { id: 'b', price: 4.50, qty: 2 }];",
        "  expect(calculateTotal(items)).toBe('40.36');",
        '});',
        '',
        "test('empty cart returns 0.00', () => {",
        "  expect(calculateTotal([])).toBe('0.00');",
        '});',
        '',
        "test('rejects negative qty', () => {",
        "  const items = [{ id: 'a', price: 5, qty: -1 }];",
        "  expect(() => calculateTotal(items)).toThrow();",
        '});',
      ].join('\n')),
      assistantMsg(`Plan:

1. Create \`packages/cart/currency-formatter.ts\` exporting class \`CurrencyFormatter\`
   with one method \`format(amount: number): Money\`. The fixed-2 logic moves there.
2. Update \`total.ts\` to inject a \`CurrencyFormatter\` instance and call
   \`formatter.format(total)\` instead of \`total.toFixed(2)\`.
3. Update \`discount.ts\` similarly.
4. Add \`packages/cart/currency-formatter.test.ts\` with 6 unit tests covering
   basic formatting, rounding edge cases, and zero handling.
5. Run all 3 cart test files to confirm green.

Now writing the formatter.`),
    ],
  },
  {
    id: 'huge',
    description: '~7.5KB: simulates a long-running session right before compaction trigger.',
    messages: [
      userMsg('we are debugging a memory leak in the agent loop. Need to trace where references are being held.'),
      assistantMsg('Investigation plan: 1) survey the runner loop for retained closures, 2) check turnState lifecycle, 3) look at event listeners that may not be unsubscribed.'),
      ...toolUseAndResult('t1', 'grep', { pattern: 'turnState', path: 'packages/coding/' }, [
        'packages/coding/src/agent-runtime/run-substrate.ts:380:  const turnState = {',
        'packages/coding/src/agent-runtime/run-substrate.ts:401:  await applyMiddleware(turnState);',
        'packages/coding/src/agent-runtime/run-substrate.ts:558:  return turnState;',
        'packages/coding/src/agent-runtime/turn-context.ts:42:  function buildTurnContext(turnState) {',
        'packages/coding/src/agent-runtime/turn-context.ts:88:  return turnState.costTracker;',
      ].join('\n') + '\n' + REPEATED_LINE.repeat(20)),
      ...toolUseAndResult('t2', 'read', { path: 'packages/coding/src/agent-runtime/run-substrate.ts', offset: 370, limit: 200 }, FILE_CONTENT + '\n' + REPEATED_LINE.repeat(40)),
      assistantMsg('I see — turnState is created per turn but the substrate executor closure captures it by reference. If a middleware retains a reference to turnState beyond the turn lifetime, GC can\'t reclaim. Let me check the middleware list.'),
      ...toolUseAndResult('t3', 'read', { path: 'packages/coding/src/agent-runtime/middleware/index.ts' }, FILE_CONTENT + '\n' + REPEATED_LINE.repeat(30)),
      ...toolUseAndResult('t4', 'grep', { pattern: 'addEventListener|removeEventListener', path: 'packages/coding/' }, [
        'packages/coding/src/agent-runtime/run-substrate.ts:412:  abortSignal.addEventListener("abort", onAbort);',
        'packages/coding/src/agent-runtime/run-substrate.ts:892:  abortSignal.removeEventListener("abort", onAbort);',
        'packages/coding/src/agent-runtime/middleware/session-snapshot.ts:78:  signal.addEventListener("abort", () => clearTimeout(t));',
      ].join('\n') + '\n' + REPEATED_LINE.repeat(15)),
      assistantMsg('session-snapshot.ts:78 looks suspicious — addEventListener with no removeEventListener counterpart. The abort handler captures `t` (the timeout) AND the closure scope, so even after abort it retains references. Let me confirm by reading the file.'),
      ...toolUseAndResult('t5', 'read', { path: 'packages/coding/src/agent-runtime/middleware/session-snapshot.ts' }, FILE_CONTENT + '\n' + REPEATED_LINE.repeat(50)),
      assistantMsg('Confirmed. Lines 70–95 register an abort listener that captures the entire middleware closure including turnState. Need to: (a) use { once: true } so the listener auto-unbinds, (b) explicitly clear the timeout in the listener, (c) call removeEventListener after the snapshot completes.'),
      ...toolUseAndResult('t6', 'read', { path: 'packages/coding/src/agent-runtime/middleware/session-snapshot.test.ts' }, FILE_CONTENT + '\n' + REPEATED_LINE.repeat(35)),
      ...toolUseAndResult('t7', 'glob', { pattern: 'packages/coding/src/**/middleware/*.ts' }, [
        'packages/coding/src/agent-runtime/middleware/index.ts',
        'packages/coding/src/agent-runtime/middleware/repo-intelligence.ts',
        'packages/coding/src/agent-runtime/middleware/session-snapshot.ts',
        'packages/coding/src/agent-runtime/middleware/transcript-prep.ts',
        'packages/coding/src/agent-runtime/middleware/cost-attribution.ts',
      ].join('\n')),
      ...toolUseAndResult('t8', 'grep', { pattern: 'addEventListener', path: 'packages/coding/src/agent-runtime/middleware/' }, [
        'packages/coding/src/agent-runtime/middleware/session-snapshot.ts:78:  signal.addEventListener("abort", () => clearTimeout(t));',
        'packages/coding/src/agent-runtime/middleware/repo-intelligence.ts:142:  signal.addEventListener("abort", abortHandler);',
      ].join('\n') + '\n' + REPEATED_LINE.repeat(20)),
      ...toolUseAndResult('t9', 'read', { path: 'packages/coding/src/agent-runtime/middleware/repo-intelligence.ts' }, FILE_CONTENT + '\n' + REPEATED_LINE.repeat(45)),
      assistantMsg('repo-intelligence.ts has the proper paired removeEventListener at line 167 — that one\'s clean. Only session-snapshot.ts has the leak.'),
    ],
  },
]);
