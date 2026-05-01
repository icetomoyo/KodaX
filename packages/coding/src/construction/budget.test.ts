import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  consumeBudget,
  DEFAULT_SELF_MODIFY_BUDGET,
  readBudget,
  remaining,
  resetBudget,
} from './budget.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-budget-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('readBudget', () => {
  it('returns the default record when the file does not exist (no write)', async () => {
    const state = await readBudget('alpha', { cwd: tmpRoot });
    expect(state).toEqual({ name: 'alpha', limit: DEFAULT_SELF_MODIFY_BUDGET, count: 0 });

    const file = path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '_self_modify.json');
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads a persisted record', async () => {
    await consumeBudget('alpha', { cwd: tmpRoot });
    await consumeBudget('alpha', { cwd: tmpRoot });
    const state = await readBudget('alpha', { cwd: tmpRoot });
    expect(state.count).toBe(2);
    expect(state.limit).toBe(DEFAULT_SELF_MODIFY_BUDGET);
    expect(state.lastModifiedAt).toBeTypeOf('string');
  });

  it('falls back to defaults for missing fields in a partial file', async () => {
    const file = path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'beta', '_self_modify.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ name: 'beta' }), 'utf8');

    const state = await readBudget('beta', { cwd: tmpRoot });
    expect(state).toEqual({ name: 'beta', limit: DEFAULT_SELF_MODIFY_BUDGET, count: 0 });
  });

  it('ignores a tampered limit field (security: agent cannot raise its own cap)', async () => {
    const file = path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'beta', '_self_modify.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ name: 'beta', limit: 999, count: 0 }), 'utf8');

    const state = await readBudget('beta', { cwd: tmpRoot });
    expect(state.limit).toBe(DEFAULT_SELF_MODIFY_BUDGET);
  });

  it('clamps a negative count to zero (security: tampered count cannot grant extra budget)', async () => {
    const file = path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'beta', '_self_modify.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ name: 'beta', count: -100 }), 'utf8');

    const state = await readBudget('beta', { cwd: tmpRoot });
    expect(state.count).toBe(0);
    expect(remaining(state)).toBe(DEFAULT_SELF_MODIFY_BUDGET);
  });
});

describe('persisted file shape', () => {
  it('does not include limit on disk (it is hard-coded, never trusted from disk)', async () => {
    await consumeBudget('alpha', { cwd: tmpRoot });
    const file = path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '_self_modify.json');
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).not.toHaveProperty('limit');
    expect(parsed.count).toBe(1);
  });
});

describe('remaining', () => {
  it('returns limit minus count', () => {
    expect(remaining({ name: 'a', limit: 3, count: 1 })).toBe(2);
  });

  it('clamps at zero on a corrupt count > limit', () => {
    expect(remaining({ name: 'a', limit: 3, count: 5 })).toBe(0);
  });
});

describe('consumeBudget', () => {
  it('increments count and persists', async () => {
    const after = await consumeBudget('alpha', { cwd: tmpRoot });
    expect(after.count).toBe(1);

    const reread = await readBudget('alpha', { cwd: tmpRoot });
    expect(reread.count).toBe(1);
  });

  it('accumulates across calls', async () => {
    await consumeBudget('alpha', { cwd: tmpRoot });
    await consumeBudget('alpha', { cwd: tmpRoot });
    const after = await consumeBudget('alpha', { cwd: tmpRoot });
    expect(after.count).toBe(3);
  });

  it('exhausts the default budget after N=DEFAULT_SELF_MODIFY_BUDGET calls', async () => {
    for (let i = 0; i < DEFAULT_SELF_MODIFY_BUDGET; i += 1) {
      await consumeBudget('alpha', { cwd: tmpRoot });
    }
    const state = await readBudget('alpha', { cwd: tmpRoot });
    expect(remaining(state)).toBe(0);
  });

  it('records lastModifiedAt as an ISO string', async () => {
    const before = Date.now();
    const after = await consumeBudget('alpha', { cwd: tmpRoot });
    expect(after.lastModifiedAt).toBeDefined();
    const ts = Date.parse(after.lastModifiedAt!);
    expect(ts).toBeGreaterThanOrEqual(before);
  });
});

describe('resetBudget', () => {
  it('zeros the counter without changing the limit', async () => {
    await consumeBudget('alpha', { cwd: tmpRoot });
    await consumeBudget('alpha', { cwd: tmpRoot });
    const after = await resetBudget('alpha', { cwd: tmpRoot });
    expect(after.count).toBe(0);
    expect(after.limit).toBe(DEFAULT_SELF_MODIFY_BUDGET);
    expect(remaining(after)).toBe(DEFAULT_SELF_MODIFY_BUDGET);
  });

  it('creates the file even when no prior consumption occurred', async () => {
    const after = await resetBudget('fresh', { cwd: tmpRoot });
    expect(after.count).toBe(0);

    const file = path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'fresh', '_self_modify.json');
    const raw = await fs.readFile(file, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ name: 'fresh', count: 0 });
  });
});
