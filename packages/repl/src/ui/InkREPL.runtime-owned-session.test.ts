import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSessionLineage,
  getSessionLineagePath,
  type KodaXMessage,
  type KodaXSessionLineage,
  type KodaXSessionUiHistoryItem,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isTranscriptlessRuntimeResult,
  persistRuntimeOwnedHostSession,
} from './InkREPL.js';
import { FileSessionStorage } from '../interactive/storage.js';
import type { SessionData } from './utils/session-storage.js';

const tempRoots: string[] = [];
const sessionId = 'runtime-owned-host-session';

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function round(n: number, turnId?: string): KodaXMessage[] {
  const turn = turnId === undefined ? {} : { turnId };
  return [
    { role: 'user', content: `run ${n}`, ...turn },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tool-${n}`, name: 'bash', input: { step: n } }],
      ...turn,
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: 'ok' }],
      ...turn,
    },
    { role: 'assistant', content: `done ${n}`, ...turn },
  ];
}

async function createSharedSession() {
  const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-owned-'));
  tempRoots.push(sessionsDir);
  return {
    sessionsDir,
    host: new FileSessionStorage({ sessionsDir, cwd: sessionsDir }),
    runtime: new FileSessionStorage({ sessionsDir, cwd: sessionsDir }),
    base: { title: 'Runtime owned', gitRoot: sessionsDir },
  };
}

/** Replays one Runtime Run's own boundary saves: start, each commit, terminal. */
async function runRuntimeRound(
  runtime: FileSessionStorage,
  base: Pick<SessionData, 'title' | 'gitRoot'>,
  history: readonly KodaXMessage[],
  n: number,
): Promise<KodaXMessage[]> {
  const committed = round(n, `turn-${n}`);
  for (let count = 1; count <= committed.length; count += 1) {
    await runtime.save(sessionId, { ...base, messages: [...history, ...committed.slice(0, count)] });
  }
  const result = [...history, ...round(n)];
  await runtime.save(sessionId, { ...base, messages: result });
  return result;
}

function branchShape(lineage: KodaXSessionLineage) {
  const childCounts = new Map<string, number>();
  for (const entry of lineage.entries) {
    if (entry.parentId) childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
  }
  return {
    forks: [...childCounts.values()].filter((count) => count > 1).length,
    activePathLength: getSessionLineagePath(lineage).length,
    entryCount: lineage.entries.length,
  };
}

describe('persistRuntimeOwnedHostSession', () => {
  it('keeps one Runtime-owned branch across rounds and the exit save', async () => {
    const { sessionsDir, host, runtime, base } = await createSharedSession();
    let messages: KodaXMessage[] = [];
    let lineage: KodaXSessionLineage | undefined;
    const uiHistory: KodaXSessionUiHistoryItem[] = [];

    for (let n = 1; n <= 3; n += 1) {
      messages = await runRuntimeRound(runtime, base, messages, n);
      const runtimeLeaf = (await runtime.getLineage(sessionId))?.activeEntryId;
      // Round end reconciles over the host copy, which mints its own entry ids.
      lineage = createSessionLineage([...messages], lineage);
      uiHistory.push({ type: 'user', text: `run ${n}` }, { type: 'assistant', text: `done ${n}` });
      lineage = await persistRuntimeOwnedHostSession(host, sessionId, {
        ...base,
        messages,
        lineage,
        uiHistory: [...uiHistory],
      }) ?? lineage;
      expect(lineage.activeEntryId).toBe(runtimeLeaf);
    }
    await persistRuntimeOwnedHostSession(host, sessionId, {
      ...base,
      messages,
      lineage,
      uiHistory: [...uiHistory],
    });

    const persisted = await new FileSessionStorage({ sessionsDir, cwd: sessionsDir }).load(sessionId);
    expect(branchShape(persisted!.lineage!)).toEqual({ forks: 0, activePathLength: 12, entryCount: 12 });
    expect(persisted?.messages.map((message) => message.content))
      .toEqual(messages.map((message) => message.content));
    expect(persisted?.uiHistory).toEqual(uiHistory);
  });

  it('appends host-only messages below the Runtime leaf', async () => {
    const { host, runtime, base } = await createSharedSession();
    const messages = await runRuntimeRound(runtime, base, [], 1);
    const runtimeLeaf = (await runtime.getLineage(sessionId))?.activeEntryId;

    const lineage = await persistRuntimeOwnedHostSession(host, sessionId, {
      ...base,
      messages: [...messages, { role: 'assistant', content: 'workflow summary' }],
    });

    const appended = lineage?.entries.find((entry) => entry.id === lineage.activeEntryId);
    expect(appended?.parentId).toBe(runtimeLeaf);
    expect(branchShape(lineage!).forks).toBe(0);
  });

  it('keeps an in-flight Runtime boundary when the host snapshot lags behind', async () => {
    const { host, runtime, base } = await createSharedSession();
    const messages = await runRuntimeRound(runtime, base, [], 1);
    const staleHostLineage = createSessionLineage([...messages]);
    await runtime.save(sessionId, { ...base, messages: [...messages, round(2, 'turn-2')[0]!] });
    const inFlightLeaf = (await runtime.getLineage(sessionId))?.activeEntryId;

    const lagging = await persistRuntimeOwnedHostSession(host, sessionId, {
      ...base,
      messages,
      lineage: staleHostLineage,
    });
    // A Run cancelled before it published a result hands the host no messages.
    const empty = await persistRuntimeOwnedHostSession(host, sessionId, {
      ...base,
      messages: [],
      uiHistory: [{ type: 'info', text: '[Interrupted]' }],
    });

    expect(lagging?.activeEntryId).toBe(inFlightLeaf);
    expect(empty?.activeEntryId).toBe(inFlightLeaf);
  });

  it('never forwards the host lineage and tolerates storage without read-back', async () => {
    const saved: SessionData[] = [];
    const messages: KodaXMessage[] = [{ role: 'user', content: 'hello' }];

    const lineage = await persistRuntimeOwnedHostSession(
      { save: async (_id, data) => { saved.push(data); } },
      sessionId,
      { title: 't', gitRoot: '', messages, lineage: createSessionLineage(messages) },
    );

    expect(lineage).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(saved[0], 'lineage')).toBe(false);
  });
});

describe('isTranscriptlessRuntimeResult', () => {
  const cancelled = { interrupted: true, messages: [] as KodaXMessage[] };

  it('flags a Runtime Run cancelled before it published a result', () => {
    expect(isTranscriptlessRuntimeResult(true, cancelled)).toBe(true);
  });

  it('keeps every published or host-run result authoritative', () => {
    expect(isTranscriptlessRuntimeResult(false, cancelled)).toBe(false);
    expect(isTranscriptlessRuntimeResult(true, { messages: [] })).toBe(false);
    expect(isTranscriptlessRuntimeResult(true, {
      interrupted: true,
      messages: round(1),
    })).toBe(false);
  });
});
