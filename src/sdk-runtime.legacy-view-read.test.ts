import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';

it('reads bounded legacy thinking from the observed view without treating its ID as a history reference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-legacy-view-'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const sessionsDir = path.join(root, 'sessions');
  const body = 'legacy reasoning '.repeat(700);
  const storage = new FileSessionStorage({ sessionsDir, configHome: path.join(root, '.kodax') });
  await storage.save('legacy-session', {
    title: 'Legacy session', gitRoot: root,
    messages: [{ role: 'user', content: 'Old question' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: body }, { type: 'text', text: 'Old answer' }] }],
  });
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir });
  let view: ClientSessionView | undefined;
  try {
    const observation = await runtime.sessions.observeView('legacy-session', next => { view = next; });
    try {
      const item = view!.items.find(candidate => candidate.type === 'thinking')!;
      expect(item.totalTextLength).toBe(body.length);
      expect(item.text.length).toBeLessThan(body.length);
      expect(await runtime.sessions.readViewItem('legacy-session', item.id)).toMatchObject({
        id: item.id, text: body, offset: 0, totalLength: body.length,
      });
      const page = await runtime.sessions.readHistory('legacy-session');
      const reference = page!.items[0]!.id;
      expect(await runtime.sessions.readViewItem('legacy-session', reference)).toEqual(
        await runtime.sessions.readHistoryEntry('legacy-session', reference),
      );
    } finally { observation.close(); }
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
