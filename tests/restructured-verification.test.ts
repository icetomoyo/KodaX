import { expect, it } from 'vitest';
import { withFocusedVerification } from './restructured-verification.js';
import type { FrozenInput } from './first-turn-eval-support.js';

it('changes only the existing verification sentence, retaining the exact task and executable tools', () => {
  const input: FrozenInput = { system: 'Before\nVerify the requested result using actual tests, readback and other evidence; confidence is insufficient.\nAfter',
    messages: [{ role: 'user', content: 'Repair the cache expiry behavior.' }], tools: [] };
  const result = withFocusedVerification(input);
  expect(result.messages).toBe(input.messages);
  expect(result.tools).toBe(input.tools);
  expect(result.system).toContain('required preconditions');
  expect(result.system).toContain('rather than adding a separate review phase');
  expect(result.system).toContain('Before\n');
  expect(result.system).toContain('\nAfter');
  expect(result.system).not.toMatch(/startedAt|cleanup|pid|restart|cache|oracle/);
  expect(() => withFocusedVerification({ ...input, system: 'Host-specific verification' })).toThrow();
  expect(() => withFocusedVerification({ ...input, system: input.system + input.system })).toThrow();
});
