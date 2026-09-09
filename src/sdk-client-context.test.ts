import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createSessionManager } from '@kodax-ai/repl';
import { estimateTokens, type KodaXMessage } from '@kodax-ai/agent';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { createKodaXRuntime } from './sdk-runtime.js';

it('observes canonical parent context before any Run and after reopening an AMA session', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-context-view-'));
  const sessionsDir = path.join(homeDir, 'sessions');
  const messages: KodaXMessage[] = [{ role: 'user', content: 'Review the saved project implementation.' },
    { role: 'assistant', content: 'The implementation has been reviewed and the results are saved.' }];
  const manager = createSessionManager({ sessionsDir, configHome: path.join(homeDir, '.kodax') });
  await manager.storage.save('ama-saved', { messages, title: 'Completed AMA', gitRoot: homeDir });
  const runtime = await createKodaXRuntime({ homeDir, sessionsDir });
  try {
    const fresh = await runtime.sessions.create({ projectPath: homeDir });
    const observed: ClientSessionView[] = [];
    const freshObservation = await runtime.sessions.observeView(fresh.id, view => observed.push(view));
    expect(observed.at(-1)?.parentContextTokens).toBe(0);
    freshObservation.close();
    const resumed = await runtime.sessions.observeView('ama-saved', view => observed.push(view));
    expect(observed.at(-1)?.parentContextTokens).toBe(estimateTokens(messages));
    expect(observed.at(-1)?.parentContextTokens).toBeGreaterThan(0);
    expect(observed.at(-1)?.activity).toBeUndefined();
    resumed.close();
  } finally {
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
