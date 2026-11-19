import { describe, expect, it } from 'vitest';
import { runKodaX } from './agent.js';
import { runManagedTask } from './task-engine.js';

// Both entries reject before any provider or Session work, so no fixture is needed.
describe('context.prompt entry admission', () => {
  it('rejects a spec on the direct engine', async () => {
    await expect(runKodaX({ provider: 'anthropic', context: { prompt: { kodaxGuidance: 'omit' } } }, 'hi'))
      .rejects.toMatchObject({ code: 'prompt_spec_requires_managed_run' });
  });

  it('rejects a malformed spec on a managed Run', async () => {
    const prompt = { context: [{ key: 'a', kind: 'system', text: 'x' }] } as never;
    await expect(runManagedTask({ provider: 'anthropic', context: { prompt } }, 'hi'))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });
});
