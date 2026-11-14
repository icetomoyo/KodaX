/**
 * Layer 1 ($0) checks on the note-line experiment: every session reaches the
 * reflection job, held-out sessions never state their lesson in the user's
 * words, the two arms differ only in the two changed texts, and the
 * diagnostics score hand-written good and bad responses the way the case intends.
 */
import { buildEvidence, shouldReflect } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { replayReflectCalls } from '../feature-308-reflect/inputs.js';
import { NOTELINE_CASES, type NoteLineCase } from './cases.js';
import { NOTELINE_ARM_A_SHA256, NOTELINE_CASES_SHA256, assertCasesPinned } from './experiment-contract.js';
import { buildNoteLineInput } from './inputs.js';
import { scoreNoteLineCell } from './oracles.js';
import { buildArmInputs, checkArms, plannedCells } from './runner.js';

const byId = (id: string): NoteLineCase => NOTELINE_CASES.find((item) => item.id === id)!;

const userText = (item: NoteLineCase): string =>
  buildEvidence(item.messages).segments.filter((segment) => segment.source === 'user').map((segment) => segment.text).join('\n').toLowerCase();

const write = (id: string, description: string) => ({ name: REFLECT_TOOL_NAME, input: { operation: 'write', id, type: 'project', description, why: 'seen in the session' } });

async function score(id: string, calls: readonly { name: string; input: unknown }[]) {
  const item = byId(id);
  const output = { text: '', toolCalls: calls };
  return scoreNoteLineCell(item, output, await replayReflectCalls(item, `l1-${calls.length}`, calls));
}

describe('feature-308 note-line cases', () => {
  it('has unique ids and the pinned case hash', () => {
    expect(new Set(NOTELINE_CASES.map((item) => item.id)).size).toBe(NOTELINE_CASES.length);
    expect(NOTELINE_CASES_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertCasesPinned()).not.toThrow();
  });

  for (const item of NOTELINE_CASES.filter((entry) => entry.source !== 'reflect')) {
    it(`${item.id} reaches the reflection job`, () => {
      expect(shouldReflect(item.messages)).toBe(true);
    });
  }

  for (const item of NOTELINE_CASES.filter((entry) => entry.expect.kind === 'lesson')) {
    it(`${item.id} leaves the lesson for the job to infer`, () => {
      const terms = item.expect.kind === 'lesson' ? item.expect.terms : [];
      expect(terms.some((term) => userText(item).includes(term.toLowerCase()))).toBe(false);
    });
  }

  it('states the user rule in the user\'s own words', () => {
    expect(userText(byId('h-zh-npm'))).toContain('只用 npm');
  });
});

describe('feature-308 note-line arms', () => {
  it('differ only in the system prompt and the memory_reflect description', async () => {
    for (const item of [byId('r1'), byId('h-python3')]) {
      const [a, b] = [await buildNoteLineInput(item, 'A'), await buildNoteLineInput(item, 'B')];
      expect(a.userMessage).toBe(b.userMessage);
      expect(a.tools.map((tool) => tool.name)).toEqual(b.tools.map((tool) => tool.name));
      for (const [index, tool] of a.tools.entries()) {
        const other = b.tools[index]!;
        expect(tool.input_schema).toEqual(other.input_schema);
        if (tool.name !== REFLECT_TOOL_NAME) expect(tool.description).toBe(other.description);
      }
    }
  });

  it('keeps arm A at the pinned pre-change bytes and arm B changed for every case', async () => {
    const { armAHash, identicalCases } = checkArms(await buildArmInputs());
    expect(armAHash).toBe(NOTELINE_ARM_A_SHA256);
    expect(identicalCases).toEqual([]);
  });

  it('plans the pilot inside the frozen call budget', () => {
    expect(plannedCells('pilot')).toHaveLength(16);
    expect(plannedCells('full')).toHaveLength(324);
  });
});

describe('feature-308 note-line diagnostics', () => {
  it('passes a lesson note and fails a session without one', async () => {
    expect((await score('h-python3', [write('use-python3', 'Run the repo scripts with python3; plain python is not on PATH.')])).verdict).toBe('pass');
    expect((await score('h-python3', [])).verdict).toBe('fail');
  });

  it('flags a note written from a one-off failure for review', async () => {
    expect((await score('h-registry-503', [])).verdict).toBe('pass');
    expect((await score('h-registry-503', [write('npm-mirror', 'Install dependencies from the npmmirror registry mirror.')])).verdict).toBe('needs_review');
  });

  it('fails an index line that keeps the misread', async () => {
    expect((await score('m-node-not-installed', [write('no-node', 'Node is not installed; use python for scripts.')])).verdict).toBe('fail');
    expect((await score('m-node-not-installed', [])).verdict).toBe('pass');
  });

  it('needs an active note for a rule the user stated', async () => {
    const quoted = { name: REFLECT_TOOL_NAME, input: { operation: 'write', id: 'npm-only', type: 'feedback', description: 'Use npm, never pnpm, in this repo.', quote: '别用 pnpm，这个仓库只用 npm。' } };
    expect((await score('h-zh-npm', [quoted])).verdict).toBe('pass');
    expect((await score('h-zh-npm', [write('npm-only', 'Use npm, never pnpm, in this repo.')])).verdict).toBe('fail');
  });
});
