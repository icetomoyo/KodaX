/**
 * FEATURE_308 Phase 4 — 100-episode hygiene simulation (Layer 1, no model call).
 *
 * A stub judge plays the reflection model: it writes, repeats, guesses and
 * corroborates from what the user said, through the real gate, host guards,
 * cursor and organizer. The questions are about the store, not the model:
 * does it stay bounded, does dedup work, and does an unchanged world cost no
 * judge call.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { KodaXMessage } from '@kodax-ai/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { estimateTokens, INDEX_TOKEN_BUDGET } from './index-builder.js';
import { organizeStore, STALE_AFTER_DAYS } from './organizer.js';
import type { ReflectionOpInput } from './reflection-op.js';
import { reflectSession, type ReflectionJudge } from './reflect-session.js';
import { createNoteStore } from './store.js';

type Episode =
  | { readonly kind: 'lesson' | 'repeat'; readonly n: number }
  | { readonly kind: 'guess' | 'confirm'; readonly n: number }
  | { readonly kind: 'quiet'; readonly n: number };

const lessonLine = (n: number): string => `Always run tool-${n} before task-${n}, that is the rule here.`;
const confirmLine = (n: number): string => `Yes, module ${n} really is the slow one.`;

function messagesOf(episode: Episode): KodaXMessage[] {
  const talk = (text: string): KodaXMessage[] => [
    { role: 'user', content: text },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
    { role: 'user', content: 'Thanks, carry on.' },
  ];
  switch (episode.kind) {
    case 'lesson':
    case 'repeat': return talk(lessonLine(episode.n));
    case 'guess': return talk(`Please look into module ${episode.n}.`);
    case 'confirm': return talk(confirmLine(episode.n));
    case 'quiet': return [{ role: 'user', content: `What is ${episode.n} plus one?` }];
  }
}

function schedule(): Episode[] {
  const spread = <T,>(items: T[]): T[] => items.map((item, index) => ({ item, key: (index * 7) % items.length })).sort((a, b) => a.key - b.key).map((entry) => entry.item);
  const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);
  return [
    ...spread<Episode>([...range(40).map((n) => ({ kind: 'lesson' as const, n })), ...range(15).map((n) => ({ kind: 'quiet' as const, n }))]),
    ...spread<Episode>([...range(20).map((n) => ({ kind: 'repeat' as const, n })), ...range(15).map((n) => ({ kind: 'guess' as const, n }))]),
    ...range(10).map((n) => ({ kind: 'confirm' as const, n })),
  ];
}

describe('100-episode hygiene simulation', () => {
  let dir: string;
  const episodes = schedule();

  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f306-hygiene-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  function harness() {
    const stores = { project: createNoteStore(path.join(dir, 'project'), 'project'), user: createNoteStore(path.join(dir, 'user'), 'user') };
    const seen: { calls: number; lastNotes: readonly { id: string; status: string }[] } = { calls: 0, lastNotes: [] };
    const judge: ReflectionJudge = async ({ evidence, notes }) => {
      seen.calls += 1;
      seen.lastNotes = notes;
      const first = evidence.segments.find((segment) => segment.source === 'user')!.text;
      const lesson = /^Always run tool-(\d+)/.exec(first);
      const guess = /module (\d+)\.$/.exec(first);
      const confirm = /^Yes, module (\d+)/.exec(first);
      const ops: ReflectionOpInput[] = [];
      if (lesson !== null) {
        const n = lesson[1]!;
        const repeated = notes.some((note) => note.id === `lesson-${n}`);
        ops.push({ operation: 'write', id: repeated ? `lesson-${n}-again` : `lesson-${n}`, type: 'feedback', description: `Always run tool-${n} before task-${n}`, body: 'The user stated this rule.', quote: lessonLine(Number(n)) });
      } else if (guess !== null) {
        ops.push({ operation: 'write', id: `guess-${guess[1]}`, type: 'project', description: `Module ${guess[1]} is slow`, why: 'The agent saw a slow run while working on it.', body: 'Not confirmed by the user.' });
      } else if (confirm !== null) {
        ops.push({ operation: 'corroborate', id: `guess-${confirm[1]}`, quote: confirmLine(Number(confirm[1])) });
      }
      return ops;
    };
    return { stores, seen, judge };
  }

  async function sweep(stores: ReturnType<typeof harness>['stores'], judge: ReflectionJudge, now: () => Date) {
    const skipped = { alreadyReflected: 0, noSignal: 0 };
    for (const [index, episode] of episodes.entries()) {
      const result = await reflectSession({ sessionId: `s${index}`, messages: messagesOf(episode), stores, cursorRoot: path.join(dir, 'project'), judge, now, dailyCap: 1000 });
      if (result.status === 'skipped') skipped[result.reason === 'no-signal' ? 'noSignal' : 'alreadyReflected'] += 1;
      if ((index + 1) % 10 === 0) {
        await organizeStore(stores.project, now());
        const index_ = await fs.readFile(path.join(dir, 'project', 'MEMORY.md'), 'utf8').catch(() => '');
        expect(estimateTokens(index_)).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET);
      }
    }
    return skipped;
  }

  it('calls the judge only for sessions with a signal, and never again for a session it already handled', async () => {
    const { stores, seen, judge } = harness();
    const now = () => new Date();
    const first = await sweep(stores, judge, now);
    expect(episodes).toHaveLength(100);
    expect(first).toEqual({ alreadyReflected: 0, noSignal: 15 });
    expect(seen.calls).toBe(85);

    const second = await sweep(stores, judge, now);
    expect(second).toEqual({ alreadyReflected: 85, noSignal: 15 });
    expect(seen.calls).toBe(85);
  });

  it('collapses repeated lessons, keeps the list free of duplicates, and shows the judge no archived note', async () => {
    const { stores, seen, judge } = harness();
    await sweep(stores, judge, () => new Date());
    await organizeStore(stores.project);
    const notes = await stores.project.list();
    const live = notes.filter((note) => note.status !== 'archived');
    const descriptions = live.map((note) => note.description.toLowerCase());
    expect(new Set(descriptions).size).toBe(descriptions.length);
    expect(notes.filter((note) => note.id.endsWith('-again') && note.status === 'archived')).toHaveLength(20);
    expect(live.filter((note) => note.id.startsWith('lesson-'))).toHaveLength(40);
    expect(live.filter((note) => note.id.startsWith('guess-') && note.status === 'active')).toHaveLength(10);
    expect(live.filter((note) => note.id.startsWith('guess-') && note.status === 'candidate')).toHaveLength(5);
    expect(seen.lastNotes.some((note) => note.status === 'archived')).toBe(false);
  });

  it('retires the guesses nobody confirmed after the stale period and keeps everything the user stated', async () => {
    const { stores, judge } = harness();
    await sweep(stores, judge, () => new Date());
    const later = new Date(Date.now() + (STALE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000);
    const report = await organizeStore(stores.project, later);
    expect(report.stale).toHaveLength(5);
    const live = (await stores.project.list()).filter((note) => note.status !== 'archived');
    expect(live).toHaveLength(50);
    expect(live.every((note) => note.source === 'user')).toBe(true);
    const index = await fs.readFile(path.join(dir, 'project', 'MEMORY.md'), 'utf8');
    expect(index.split('\n').filter((line) => line.startsWith('- [')).length).toBe(50);
    expect(estimateTokens(index)).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET);
  });
});
