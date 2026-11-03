import { expect, it } from 'vitest';
import { parseExecutionBindingSnapshot } from './execution-binding-snapshot.js';

it('rejects corrupt, non-JSON or oversized recovery bindings without throwing', () => {
  const businessBinding = { id: 'expert', revision: 'r1' };
  for (const value of [null, {}, { businessBinding, defaultSkill: null },
    { businessBinding: { ...businessBinding, data: { number: Infinity } } },
    { businessBinding: { ...businessBinding, data: { secret: 'x'.repeat(16_384) } } }]) {
    expect(parseExecutionBindingSnapshot(value)).toBeUndefined();
  }
  const input = { businessBinding: { ...businessBinding, data: { enabled: true } }, defaultSkill: { name: 'method' } };
  const parsed = parseExecutionBindingSnapshot(input);
  expect(parsed).toEqual(input);
  input.businessBinding.data.enabled = false;
  expect(parsed?.businessBinding.data?.enabled).toBe(true);
});
