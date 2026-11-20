import { describe, expect, it } from 'vitest';
import { runLeafAgent } from './agent.js';
import { runKodaX, runManagedTask } from './task-engine.js';

// Every case rejects before any provider or Session work, so no fixture is needed.
describe('context.prompt entry admission', () => {
  it('rejects a spec on the leaf executor', async () => {
    await expect(runLeafAgent({ provider: 'anthropic', context: { prompt: { kodaxGuidance: 'omit' } } }, 'hi'))
      .rejects.toMatchObject({ code: 'prompt_spec_requires_managed_run' });
  });

  it.each([['runKodaX', runKodaX], ['runManagedTask', runManagedTask]] as const)(
    'validates the spec on the managed root entry %s',
    async (_name, run) => {
      const prompt = { context: [{ key: 'a', kind: 'system', text: 'x' }] } as never;
      await expect(run({ provider: 'anthropic', context: { prompt } }, 'hi'))
        .rejects.toMatchObject({ code: 'invalid_params' });
    },
  );
});
