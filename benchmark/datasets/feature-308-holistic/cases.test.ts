/**
 * Layer 1 ($0) checks on the holistic experiment: every second session reaches the
 * reflection job, the candidate is hidden from the index it would join, a
 * hand-written answer meets the host guards the way the case intends, and the
 * use-stage arms differ only in the stored lesson.
 */
import { buildEvidence, shouldReflect } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { CONFIRM_CASES, USE_CASES } from './cases.js';
import { applyConfirm, buildUseArm, confirmInput, noteReads, OTHER_NOTES } from './runner.js';

const byId = (id: string) => CONFIRM_CASES.find((item) => item.id === id)!;
const reflect = (input: Record<string, unknown>) => ({ toolCalls: [{ name: 'memory_reflect', input }] });

describe('feature-308 holistic confirm cases', () => {
  it('has unique ids and covers every expectation', () => {
    expect(new Set(CONFIRM_CASES.map((item) => item.id)).size).toBe(CONFIRM_CASES.length);
    expect(new Set(CONFIRM_CASES.map((item) => item.expect))).toEqual(new Set(['confirm', 'leave', 'correct', 'repeat']));
  });

  for (const item of CONFIRM_CASES) {
    it(`${item.id}: the second session passes the gate and shows the candidate but not in the index`, async () => {
      expect(shouldReflect(item.session)).toBe(true);
      const input = await confirmInput(item);
      expect(input.userMessage).toContain(`## ${item.candidate.id} (${item.scope}, ${item.candidate.type}, candidate, inferred, session session-one)`);
      expect((input.userMessage ?? '').match(/^## \S+ \((?:project|user), /gm)).toHaveLength(OTHER_NOTES + 1);
    });
  }

  it('confirms a project candidate from local output of a later session', async () => {
    const outcome = await applyConfirm(byId('c-node-path'), reflect({ operation: 'corroborate', id: 'fnm-node-path', quote: 'bash: line 1: npx: command not found' }));
    expect(outcome.fate).toBe('confirmed');
  });

  it('confirms a user-scope candidate from another project, with or without the scope named', async () => {
    const item = byId('c-node-path-other-project');
    const quote = 'bash: line 1: npm: command not found';
    expect((await applyConfirm(item, reflect({ operation: 'corroborate', id: 'fnm-node-path', scope: 'user', quote }))).fate).toBe('confirmed');
    expect((await applyConfirm(item, reflect({ operation: 'corroborate', id: 'fnm-node-path', quote }))).fate).toBe('confirmed');
    // Local output still cannot rewrite a note that reaches every project.
    const rewrite = await applyConfirm(item, reflect({ operation: 'rewrite', id: 'fnm-node-path', quote, description: 'Put the fnm Node bin on PATH.' }));
    expect(rewrite.fate).toBe('left');
  });

  it('accepts a quote copied across several local results, the way the job copies a run of output', async () => {
    const quote = 'Command: cd packages/server && npx vitest run\nExit: 1\n FAIL  src/routes/health.test.ts\n\nCommand: npx vitest run packages/server\nExit: 0';
    expect((await applyConfirm(byId('c-vitest-root'), reflect({ operation: 'corroborate', id: 'run-vitest-from-root', quote }))).fate).toBe('confirmed');
  });

  it('records a dispute, a rewrite, a refused proof and a duplicate write as distinct fates', async () => {
    const item = byId('c-ui-kit-published');
    const quote = '"2.9.4", "3.0.0", "3.0.1"';
    expect((await applyConfirm(item, reflect({ operation: 'dispute', id: 'acme-ui-kit-3-local', quote, why: 'the registry lists 3.0.0' }))).fate).toBe('disputed');
    expect((await applyConfirm(item, reflect({ operation: 'rewrite', id: 'acme-ui-kit-3-local', quote, description: 'Install @acme/ui-kit from the registry.' }))).fate).toBe('rewritten');
    expect((await applyConfirm(item, reflect({ operation: 'corroborate', id: 'acme-ui-kit-3-local', quote: 'invented text' }))).fate).toBe('left');
    const duplicate = await applyConfirm(item, reflect({ operation: 'write', id: 'ui-kit-registry', description: 'Install @acme/ui-kit from the registry.', why: 'npm view lists 3.0.0 and 3.0.1.', body: 'It is published.' }));
    expect(duplicate.fate).toBe('left');
    expect(duplicate.newNotes).toEqual([{ id: 'ui-kit-registry', status: 'candidate', description: 'Install @acme/ui-kit from the registry.' }]);
  });

  it('offers local proof where the case allows it, and none for the jq failure inside a gh pipeline', () => {
    const local = (id: string, text: string) => buildEvidence(byId(id).session).segments.some((segment) => segment.source === 'local' && segment.text.includes(text));
    expect(local('c-ui-kit-published', '"3.0.0"')).toBe(true);
    expect(local('c-db-stopped-again', 'npm run db:up')).toBe(true);
    expect(local('c-node-path-other-project', 'npm: command not found')).toBe(true);
    // A command that runs gh fetches from the network, so its whole result is external, stderr included.
    expect(local('c-gh-jq', 'jq: command not found')).toBe(false);
  });
});

describe('feature-308 holistic use cases', () => {
  for (const item of USE_CASES) {
    it(`${item.id}: the arms differ only in the stored lesson`, async () => {
      const none = await buildUseArm(item, 'N');
      const old = await buildUseArm(item, 'O');
      const rule = await buildUseArm(item, 'R');
      const text = (state: typeof none) => JSON.stringify(state.input);
      expect(text(none)).not.toContain(`${item.noteId}.md`);
      expect(text(old)).toContain(item.oldLine);
      expect(text(rule)).toContain(item.ruleLine);
      expect(text(old).replace(item.oldLine, item.ruleLine)).toBe(text(rule));
      expect(old.indexTokens).toBeGreaterThan(none.indexTokens);
      expect([...rule.noteFiles.values()].some((content) => content.includes(item.body))).toBe(true);
    });
  }

  it('counts note reads by kind', async () => {
    const item = USE_CASES[0]!;
    const state = await buildUseArm(item, 'R');
    const root = state.noteRoots[0]!;
    const counts = noteReads(state, item.noteId, [
      { name: 'read', input: { path: `${root}/${item.noteId}.md` } },
      { name: 'read', input: { path: `${root}/MEMORY.md` } },
      { name: 'bash', input: { command: `cat ${root}/distractor-03.md` } },
      { name: 'read', input: { path: '/work/project/package.json' } },
    ]);
    expect(counts).toEqual({ lesson: 1, index: 1, other: 1 });
  });
});
