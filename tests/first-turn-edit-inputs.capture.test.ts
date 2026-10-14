import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { captureEditInputs, EDIT_CASES, assertEditSourcesCurrent, editFixtureRoot } from './first-turn-edit-inputs.capture.js';
import { inputHash } from './first-turn-eval-support.js';

it('freezes both affected tasks with the complete production Worker tool channel without network', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-edit-capture-test-'));
  const fetch = vi.fn(async () => { throw new Error('Capture forbids network'); });
  vi.stubGlobal('fetch', fetch);
  try {
    const capture = await captureEditInputs(fixture, 'baseline');
    expect(capture.cases.map(row => row.id)).toEqual(['batch_edit', 'concrete_plan']);
    for (const row of capture.cases) {
      expect(row.hash).toBe(inputHash(row.input));
      expect(row.input.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['read', 'edit', 'bash', 'todo_create', 'todo_update']));
      expect(row.input.tools.every(tool => tool.description.length > 0)).toBe(true);
      expect(row.input.messages.at(-1)).toEqual({ role: 'user', content: row.task });
    }
    expect(capture.cases[0]?.input.messages).toEqual(expect.arrayContaining([...EDIT_CASES[0]!.priorMessages]));
    expect(fetch).not.toHaveBeenCalled();
    await expect(assertEditSourcesCurrent(capture)).resolves.toBeUndefined();
    await expect(assertEditSourcesCurrent({ ...capture, sourceHashes: { ...capture.sourceHashes, 'packages/coding/src/tools/edit.ts': 'wrong-frozen-hash' } })).rejects.toThrow('Production source changed');
  } finally {
    vi.unstubAllGlobals();
    await fs.rm(fixture, { recursive: true, force: true });
  }
}, 30_000);

it('keeps the model-visible fixture fixed when evidence TEMP changes', () => {
  const temporary = os.tmpdir();
  const original = path.join(temporary, 'kodax-first-turn-edit-v2-fixture');
  const isolated = path.join(temporary, 'ev2');
  vi.stubEnv('KODAX_EDIT_FIXTURE_ROOT', original);
  vi.stubEnv('TEMP', isolated); vi.stubEnv('TMP', isolated); vi.stubEnv('TMPDIR', isolated);
  try { expect(editFixtureRoot()).toBe(original); }
  finally { vi.unstubAllEnvs(); }
});
