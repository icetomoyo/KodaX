import type { FrozenInput } from './first-turn-eval-support.js';

const original = 'Verify the requested result using actual tests, readback and other evidence; confidence is insufficient.';
/** Explicit experimental replacement, not a new phase, tool, default or domain-specific hint. */
export function withFocusedVerification(input: FrozenInput): FrozenInput {
  if (input.system.split(original).length !== 2) throw new Error('Expected one current candidate verification rule');
  return { ...input, system: input.system.replace(original,
    `${original} Derive focused checks from the changed behavior and its required preconditions, including relevant failure and uncertainty cases. Extend the planned verification rather than adding a separate review phase or blanket test sweep; report only what observed evidence establishes.`) };
}
