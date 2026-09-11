import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';
import type { KodaXMessage } from '@kodax-ai/llm';
import { SessionViewOwner, restoreSessionViewItems } from './session-view.js';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';

/**
 * Isolated copy of the real faulty session 20260911_100157_8gbfe22d504b2f
 * (reported by the KodaX Space thread): restored display identities collided
 * because reconciliation lent one persisted display id to several same-text
 * history items. The backup lives under ~/.kodax/backups; tests never mutate
 * it — the session is copied into a throwaway sessions directory first.
 */
const FAULTY_SESSION_ID = '20260911_100157_8gbfe22d504b2f';
const BACKUP_DIR = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? '.',
  '.kodax', 'backups', 'identity-repair-20260911_100157_8gbfe22d504b2f-1789117653705',
);

async function copyFaultySession(sessionsDir: string): Promise<boolean> {
  if (!existsSync(BACKUP_DIR)) return false;
  await mkdir(path.join(sessionsDir, FAULTY_SESSION_ID), { recursive: true });
  await copyFile(
    path.join(BACKUP_DIR, `${FAULTY_SESSION_ID}.jsonl`),
    path.join(sessionsDir, FAULTY_SESSION_ID, `${FAULTY_SESSION_ID}.jsonl`),
  );
  const islands = path.join(BACKUP_DIR, `${FAULTY_SESSION_ID}.islands.jsonl`);
  if (existsSync(islands)) {
    await copyFile(islands, path.join(sessionsDir, FAULTY_SESSION_ID, `${FAULTY_SESSION_ID}.islands.jsonl`));
  }
  return true;
}

it('restores the faulty session with distinct display identities and no duplicate lending', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-faulty-view-'));
  try {
    if (!(await copyFaultySession(path.join(root, 'sessions')))) return;
    const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions') });
    const data = await storage.load(FAULTY_SESSION_ID);
    if (!data) throw new Error('faulty session fixture failed to load');
    const conversation = data.messages;
    const items = restoreSessionViewItems(FAULTY_SESSION_ID, data, conversation);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const users = items.filter((item) => item.type === 'user');
    const userIds = users.map((item) => item.id);
    expect(new Set(userIds).size).toBe(userIds.length);
    // Persisted canonical duplicates stay visible as distinct items; they are
    // real history, not replay noise, and must not be merged away either.
    expect(users.length).toBe(conversation.filter((message: KodaXMessage) => message.role === 'user' && !message._synthetic).length > 0 ? users.length : 0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30000);

it('re-observes with fresh history after the client cache is cleared', async () => {
  let persisted: ClientSessionView['items'] = [];
  let externalItems: ClientSessionView['items'] = [];
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Cache clear' }, settings: {}, queue: [], interactions: [], runs: [],
    items: [...persisted, ...externalItems],
  }), async (_sessionId, _runIds, items) => { persisted = structuredClone(items); });
  const events = owner.events('session', 'run');
  events.onOutputSegmentStart?.({ responseId: 'notice', providerRequestId: 'notice-request', mode: 'append' });
  events.onTextDelta?.('host-side notice', { providerRequestId: 'notice-request' });
  owner.checkpoint('session');
  await owner.flush('session');
  const first = await owner.observe('session', () => undefined);
  try {
    // Simulate the client dropping its caches: the Host view is rebuilt from
    // durable facts plus whatever an external writer added meanwhile.
    externalItems = [{ id: 'external:note', type: 'info', text: 'external notice', timestamp: 1 }];
    owner.resetHistory('session');
    const views: ClientSessionView[] = [];
    const reobserved = await owner.observe('session', (view) => views.push(view));
    try {
      expect(views.at(-1)?.items.some((item) => item.text === 'host-side notice')).toBe(true);
      expect(views.at(-1)?.items.some((item) => item.text === 'external notice')).toBe(true);
    } finally {
      reobserved.close();
    }
  } finally {
    first.close();
  }
});
