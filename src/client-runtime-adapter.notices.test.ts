import { expect, it } from 'vitest';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import type { KodaXRuntime } from './sdk-runtime.js';

it('rejects a notice that the Host did not save instead of acknowledging success', async () => {
  // Older Hosts return null for a failed notice write; no command may be retried.
  const runtime = { sessions: { appendNotice: async () => null } } as unknown as KodaXRuntime;
  const client = toKodaXProductClient(runtime);
  await expect(client.sessions.appendNotice('session', { content: 'Model switched' }))
    .rejects.toThrow('Host did not save the Session notice');
});
