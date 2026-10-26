import { expect, it } from 'vitest';
import { assertToolsOnlyPair, assertSemanticReview, isPilotCell } from './managed-tool-contract.eval.js';
import type { FrozenInput } from './first-turn-eval-support.js';

const original: FrozenInput = { system: 'Complete unchanged Worker', messages: [{ role: 'user', content: 'Task' }],
  tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: {
    description: { type: 'string', description: 'A business field named description' },
  }, required: ['description'] } }] };

it('admits annotation-only changes but rejects altered Worker, history, business fields or required parameters', () => {
  const next = structuredClone(original);
  next.tools[0]!.description = 'Read';
  next.tools[0]!.input_schema.properties.description = { type: 'string', description: 'Purpose' };
  expect(() => assertToolsOnlyPair(original, next)).not.toThrow();
  expect(() => assertToolsOnlyPair(original, { ...next, system: 'Compressed Worker' })).toThrow();
  expect(() => assertToolsOnlyPair(original, { ...next, messages: [] })).toThrow();
  const removed = structuredClone(next);
  delete removed.tools[0]!.input_schema.properties.description;
  expect(() => assertToolsOnlyPair(original, removed)).toThrow();
  const required = structuredClone(next);
  required.tools[0]!.input_schema.required = [];
  expect(() => assertToolsOnlyPair(original, required)).toThrow();
  const changedType = structuredClone(next);
  changedType.tools[0]!.input_schema.properties.description = { type: 'boolean' };
  expect(() => assertToolsOnlyPair(original, changedType)).toThrow();
  expect(() => assertToolsOnlyPair(original, { ...next, tools: [] })).toThrow();
  expect(() => assertToolsOnlyPair(original, original)).toThrow();
});

it('preserves literal business data inside schema defaults', () => {
  const base = structuredClone(original);
  base.tools[0]!.input_schema.properties.description = { type: 'object', default: { description: 'original value' } };
  const next = structuredClone(base);
  next.tools[0]!.description = 'Shorter';
  expect(() => assertToolsOnlyPair(base, next)).not.toThrow();
  next.tools[0]!.input_schema.properties.description = { type: 'object', default: { description: 'changed value' } };
  expect(() => assertToolsOnlyPair(base, next)).toThrow();
});

it('requires a complete independent semantic review before continuation or reveal', () => {
  const pairs = [{ route: 'kimi', caseId: 'collaboration' }, { route: 'glm', caseId: 'interaction' }];
  const review = { reviewer: 'main-session', allowRemaining: true, judgments: pairs.map(pair => ({ ...pair, preferred: 'tie', reason: 'Both retain the required next action and scope.' })) };
  expect(() => assertSemanticReview(review, pairs, true)).not.toThrow();
  expect(() => assertSemanticReview({ ...review, judgments: review.judgments.slice(0, 1) }, pairs, true)).toThrow();
  expect(() => assertSemanticReview({ ...review, judgments: [review.judgments[0], review.judgments[0]] }, pairs, true)).toThrow();
  expect(() => assertSemanticReview({ ...review, reviewer: 'regex' }, pairs, true)).toThrow();
  expect(() => assertSemanticReview({ ...review, allowRemaining: undefined }, pairs, true)).toThrow();
});

it('keeps exactly the pre-registered four-cell pilot and eight remaining cells', () => {
  const cells = ['glm', 'kimi', 'deepseek'].flatMap(route => ['collaboration', 'closure']
    .flatMap(caseId => ['A', 'B'].map(arm => ({ route, caseId, arm }))));
  expect(cells.filter(isPilotCell)).toHaveLength(4);
  expect(cells.filter(cell => !isPilotCell(cell))).toHaveLength(8);
});
