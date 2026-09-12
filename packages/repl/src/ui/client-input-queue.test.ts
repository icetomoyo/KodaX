import { describe, expect, it, vi } from 'vitest';
import { createClientInputQueue } from './client-input-queue.js';
import { runClientPlaneRound, type InkClientPlane } from './client-plane.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('client input queue', () => {
  it('retains an idle round original and identity when submission acknowledgement is lost', async () => {
    const submit = vi.fn(async () => { throw new Error('acknowledgement lost'); });
    const readInput = vi.fn(async () => null);
    const plane: InkClientPlane = { submit, readInput, withdraw: vi.fn(async () => undefined),
      executeTool: async () => { throw new Error('Unexpected tool invocation'); },
      cancelSession: async () => { throw new Error('Unexpected Session Stop'); },
      activeRun: async () => undefined, awaitRun: async () => ({ phase: 'completed' }),
      stop: async () => undefined, observe: async () => () => undefined,
      readItem: async () => null, respondInteraction: async () => true };
    const queue = createClientInputQueue(plane);
    await expect(runClientPlaneRound({ plane, sessionId: 's', prompt: 'image question',
      submit: (input) => queue.submit(input, 'image question @image.png'),
    })).rejects.toThrow('acknowledgement lost');
    expect(await queue.pull('s', [])).toBe('image question @image.png');
    expect(readInput).toHaveBeenCalledWith('s', expect.stringMatching(/^ink-/));
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('keeps an unconfirmed submission and original identity until the Host confirms withdrawal', async () => {
    const submit = vi.fn(async () => { throw new Error('connection lost'); });
    const readInput = vi.fn(async () => ({ state: 'queued' as const }));
    const withdraw = vi.fn(async () => 'original input');
    const queue = createClientInputQueue({ submit, readInput, withdraw });
    await expect(queue.submit({ sessionId: 's', inputId: 'stable', text: 'original input' })).rejects.toThrow('connection lost');
    expect(await queue.pull('other', [])).toBeUndefined();
    expect(await queue.pull('s', [])).toBe('original input');
    expect(readInput).toHaveBeenCalledWith('s', 'stable');
    expect(withdraw).toHaveBeenCalledWith('s', 'stable');
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('returns only confirmed withdrawals in queue order and never repeats an in-flight withdrawal', async () => {
    let finish!: (value: string) => void;
    const first = new Promise<string>((done) => { finish = done; });
    const withdraw = vi.fn((_session: string, id: string) => id === 'one' ? first : Promise.resolve(undefined));
    const report = vi.fn();
    const queue = createClientInputQueue({ submit: vi.fn(async () => ({ state: 'queued' as const })), withdraw }, report);
    await queue.submit({ sessionId: 's', inputId: 'one', text: 'one' });
    await queue.submit({ sessionId: 's', inputId: 'two', text: 'two' });
    const pull = queue.pull('s', ['one', 'two']);
    await queue.discardNewest('s', ['one', 'two']);
    finish('one');
    expect(await pull).toBe('one');
    expect(withdraw.mock.calls.map((args) => args[1]).sort()).toEqual(['one', 'two']);
    expect(report).toHaveBeenCalled();
  });
  it('submits busy image attachments and returns the editable original on withdrawal', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-queued-images-'));
    try {
      await writeFile(path.join(cwd, 'image.png'), 'image-fixture');
      const submit = vi.fn(async () => ({ state: 'queued' as const }));
      const queue = createClientInputQueue({ submit, withdraw: vi.fn(async () => 'review') });
      await queue.submitPrompt({ sessionId: 's', inputId: 'image', text: 'review @image.png', delivery: 'after_turn' }, cwd);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({
        text: 'review ', inputArtifacts: [expect.objectContaining({ kind: 'image', path: path.join(cwd, 'image.png') })],
      }));
      expect(await queue.pull('s', ['image'])).toBe('review @image.png');
      await queue.submitPrompt({ sessionId: 's', inputId: 'skill', text: '/inspect @image.png', delivery: 'after_turn' }, cwd, true);
      expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
        text: '/inspect @image.png', inputArtifacts: [expect.objectContaining({ kind: 'image' })],
      }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('returns an explicitly dropped input without requiring another Host withdrawal', async () => {
    const withdraw = vi.fn(async () => undefined);
    const queue = createClientInputQueue({ submit: vi.fn(async () => ({ state: 'dropped' as const })), withdraw });
    await queue.submit({ sessionId: 's', inputId: 'dropped', text: 'keep this draft' });
    expect(await queue.pull('s', [])).toBe('keep this draft');
    expect(withdraw).not.toHaveBeenCalled();
  });
  it('waits for the outstanding submit before interpreting an input lookup', async () => {
    let fail!: (reason: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    const readInput = vi.fn(async () => null);
    const queue = createClientInputQueue({ submit: () => pending, readInput, withdraw: vi.fn(async () => undefined) });
    const submit = queue.submit({ sessionId: 's', inputId: 'pending', text: 'keep' }).catch(() => undefined);
    const pull = queue.pull('s', []);
    expect(readInput).not.toHaveBeenCalled();
    fail(new Error('connection lost'));
    await submit;
    expect(await pull).toBe('keep');
  });
  it('scopes input identities to their session', async () => {
    const queue = createClientInputQueue({
      submit: vi.fn(async () => ({ state: 'queued' as const })),
      withdraw: vi.fn(async () => 'host text'),
    });
    await queue.submit({ sessionId: 'first', inputId: 'same', text: 'first original' });
    await queue.submit({ sessionId: 'second', inputId: 'same', text: 'second original' });
    expect(await queue.pull('first', ['same'])).toBe('first original');
    expect(await queue.pull('second', ['same'])).toBe('second original');
  });
});
