import { expect, it } from 'vitest';
import { validateSmokeCapture, projectNaturalSmokeInput, assertReusedL2SourceChange } from './shared-contract-natural-smoke.eval.js';
import { buildScriptModelDescription } from '../packages/coding/src/agent-runtime/script/model.js';
import type { FrozenInput } from './first-turn-eval-support.js';

const input: FrozenInput = { system: 'Host instructions', messages: [{ role: 'user', content: 'Fix the reported symptom.' }], tools: [] };
const leaf = { name: 'read', description: 'Read the file.', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } } };
const entry = { name: 'script_exec', description: buildScriptModelDescription([leaf]), input_schema: { type: 'object' as const, properties: { code: { type: 'string' } } } };
const capture = () => ({ externalCalls: 0, checkpoints: ['agent', 'coding', 'script'].flatMap(mode => ['symptom-repair', 'verification-followup'].map(id => ({
  id: `${mode}-${id}`, input: { ...input, tools: mode === 'script' ? [entry] : [] },
  ...(mode === 'script' ? { scriptContracts: { entry, leaves: [leaf] } } : {}),
}))) });

it('requires exactly six capture checkpoints and intact structured Script teaching', () => {
  expect(validateSmokeCapture(capture()).checkpoints).toHaveLength(6);
  const missing = capture(); missing.checkpoints.pop();
  expect(() => validateSmokeCapture(missing)).toThrow(/six/);
  const changed = capture();
  changed.checkpoints[4]!.scriptContracts!.leaves = [{ ...leaf, description: 'Stale contract' }];
  expect(() => validateSmokeCapture(changed)).toThrow(/Script/);
  expect(() => validateSmokeCapture({ ...capture(), externalCalls: 1 })).toThrow(/offline/);
});

it('leaves child and auxiliary requests unchanged and refuses mismatched root Script contracts before dispatch', () => {
  for (const kind of ['child', 'auxiliary'] as const) expect(projectNaturalSmokeInput(input, kind, 'script')).toBe(input);
  expect(() => projectNaturalSmokeInput(input, 'root', 'script')).toThrow(/Script/);
  const scripted = { ...input, tools: [entry] };
  expect(() => projectNaturalSmokeInput(scripted, 'root', 'agent')).toThrow(/mode/);
  expect(() => projectNaturalSmokeInput(scripted, 'root', 'coding')).toThrow(/mode/);
  expect(() => projectNaturalSmokeInput(scripted, 'root', 'script', { entry: { ...entry, description: 'modified' }, leaves: [leaf] })).toThrow(/Script/);
  expect(() => projectNaturalSmokeInput(input, 'root', 'agent')).toThrow(/project/);
});

it('allows only explicitly reviewed evaluation-only source deltas when reusing historical L2 evidence', () => {
  const change = { source: 'tests/shared-contract-natural-runtime.ts', before: 'old', after: 'new', reason: 'Exact Windows separator parity; offline regression only.' };
  expect(() => assertReusedL2SourceChange(change.source, 'old', 'new', [change])).not.toThrow();
  expect(() => assertReusedL2SourceChange(change.source, 'old', 'changed-again', [change])).toThrow();
  expect(() => assertReusedL2SourceChange(change.source, 'old', 'new', [])).toThrow();
  const production = { ...change, source: 'packages/coding/src/task-engine/runner-driven.ts' };
  expect(() => assertReusedL2SourceChange(production.source, 'old', 'new', [production])).toThrow();
  const prompt = { ...change, source: 'tests/restructured-worker-contract.ts' };
  expect(() => assertReusedL2SourceChange(prompt.source, 'old', 'new', [prompt])).toThrow();
});
