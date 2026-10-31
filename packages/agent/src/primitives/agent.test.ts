import { expect, it } from 'vitest';
import { createAgent } from './agent.js';

it('normalizes legacy Agent reasoning at admission without mutating the caller declaration', () => {
  const reasoning = { default: 'balanced' as const, max: 'deep' as const };
  const agent = createAgent({ name: 'legacy', instructions: '', reasoning });
  expect(agent.reasoning).toEqual({ default: 'medium', max: 'high' });
  expect(reasoning).toEqual({ default: 'balanced', max: 'deep' });
});
