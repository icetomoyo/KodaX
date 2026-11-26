/**
 * Mechanical classification for the skill learning value eval. Diagnostics only: the
 * decision comes from the blinded review of every `review` cell and every pair whose
 * verdicts differ (docs/designs/skill-learning-value-eval.md).
 *
 * Patterns run over each tool call serialized on its own (`{"name":...,"input":...}`),
 * never over free text.
 */
import type { ModelOutput, ModelToolCall } from '../feature-308-baseline/oracles.js';
import type { Checkpoint, ValueCase } from './cases.js';
import type { StoredWorld } from './inputs.js';

export type DiscoveryClass = 'load' | 'step' | 'pitfall' | 'other';
export type CheckpointClass = 'pass' | 'fail' | 'review';

const serialize = (call: ModelToolCall): string => JSON.stringify({ name: call.name, input: call.input });

function input(call: ModelToolCall): Readonly<Record<string, unknown>> {
  return typeof call.input === 'object' && call.input !== null ? call.input as Record<string, unknown> : {};
}

/** A `skill` call naming a stored skill, or a `read` of a note session 1 wrote. */
export function loadsStored(call: ModelToolCall, world: Pick<StoredWorld, 'notes' | 'skills'>): boolean {
  if (call.name === 'skill') {
    const name = String(input(call).skill ?? '').replace(/^\/?(?:skill:)?/, '').trim();
    return world.skills.some((skill) => skill.name === name);
  }
  if (call.name === 'read') {
    const target = String(input(call).path ?? '').replace(/\\/g, '/');
    return world.notes.some((note) => target.endsWith(`/${note.id}.md`));
  }
  return false;
}

export function classifyDiscovery(item: ValueCase, world: Pick<StoredWorld, 'notes' | 'skills'>, output: ModelOutput): DiscoveryClass {
  const calls = output.toolCalls;
  if (calls.some((call) => item.anyPitfall.test(serialize(call)))) return 'pitfall';
  if (calls.some((call) => loadsStored(call, world))) return 'load';
  if (calls.some((call) => item.firstStep.test(serialize(call)))) return 'step';
  return 'other';
}

export function classifyCheckpoint(checkpoint: Checkpoint, output: ModelOutput): CheckpointClass {
  const calls = output.toolCalls.map(serialize);
  if (calls.some((call) => checkpoint.pitfall.test(call))) return 'fail';
  if (calls.some((call) => checkpoint.expect.test(call))) return 'pass';
  return 'review';
}

/** Which checkpoint facts made it into what the arm stored (the artifact session 2 loads). */
export function storedFacts(item: ValueCase, world: Pick<StoredWorld, 'notes' | 'skills'>): readonly boolean[] {
  const text = world.skills.length > 0
    ? JSON.stringify(world.skills[0])
    : world.notes.map((note) => `${note.description}\n${note.body}`).join('\n');
  return item.facts.map((fact) => fact.test(text));
}
