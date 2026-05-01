/**
 * FEATURE_090 (v0.7.32) — disable-state IO + integration with
 * `validateSelfModify`'s `self-modify-disabled` rule.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { disableSelfModify, readDisableState } from './disable-state.js';
import { validateSelfModify } from './self-modify.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-disable-state-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('readDisableState', () => {
  it('returns disabled=false when the marker does not exist', async () => {
    const state = await readDisableState('alpha', { cwd: tmpRoot });
    expect(state).toEqual({ name: 'alpha', disabled: false });
  });

  it('returns disabled=true when the marker exists, capturing timestamp + user', async () => {
    await disableSelfModify('alpha', { cwd: tmpRoot, user: 'op' });
    const state = await readDisableState('alpha', { cwd: tmpRoot });
    expect(state.disabled).toBe(true);
    expect(state.user).toBe('op');
    expect(state.disabledAt).toBeTypeOf('string');
  });

  it('coerces a tampered "disabled: false" marker file to disabled=true (presence wins)', async () => {
    const file = path.join(
      tmpRoot,
      '.kodax',
      'constructed',
      'agents',
      'alpha',
      '_self_modify_disabled.json',
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ name: 'alpha', disabled: false, disabledAt: 'tampered' }),
      'utf8',
    );

    const state = await readDisableState('alpha', { cwd: tmpRoot });
    expect(state.disabled).toBe(true);
  });

  it('treats malformed JSON as disabled (fail-safe)', async () => {
    const file = path.join(
      tmpRoot,
      '.kodax',
      'constructed',
      'agents',
      'alpha',
      '_self_modify_disabled.json',
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json', 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const state = await readDisableState('alpha', { cwd: tmpRoot });
      expect(state.disabled).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('disableSelfModify', () => {
  it('writes the marker file and returns the state', async () => {
    const state = await disableSelfModify('alpha', { cwd: tmpRoot, user: 'op' });
    expect(state).toMatchObject({ name: 'alpha', disabled: true, user: 'op' });
    expect(state.disabledAt).toBeTypeOf('string');

    const reread = await readDisableState('alpha', { cwd: tmpRoot });
    expect(reread.disabled).toBe(true);
  });

  it('is idempotent — disabling twice rewrites the timestamp', async () => {
    const first = await disableSelfModify('alpha', { cwd: tmpRoot });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await disableSelfModify('alpha', { cwd: tmpRoot });
    expect(second.disabledAt).not.toBe(first.disabledAt);
  });
});

describe('validateSelfModify integration with isDisabled', () => {
  const baseInput = {
    prev: { instructions: 'You are alpha.' },
    next: { instructions: 'updated' },
    prevName: 'alpha',
    nextName: 'alpha',
    prevKind: 'agent' as const,
    nextKind: 'agent' as const,
    budgetRemaining: 3,
  };

  it('rejects with self-modify-disabled when isDisabled=true', () => {
    const result = validateSelfModify({ ...baseInput, isDisabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rule).toBe('self-modify-disabled');
      expect(result.reason).toContain('disable-self-modify');
    }
  });

  it('passes (subject to other checks) when isDisabled=false', () => {
    const result = validateSelfModify({ ...baseInput, isDisabled: false });
    expect(result.ok).toBe(true);
  });

  it('passes when isDisabled is omitted (defaults to false)', () => {
    const result = validateSelfModify(baseInput);
    expect(result.ok).toBe(true);
  });

  it('disable rule fires before budget-exhausted (ordering)', () => {
    const result = validateSelfModify({
      ...baseInput,
      isDisabled: true,
      budgetRemaining: 0,
    });
    if (!result.ok) {
      expect(result.rule).toBe('self-modify-disabled');
    }
  });
});
