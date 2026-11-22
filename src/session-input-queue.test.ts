import { expect, it, vi } from 'vitest';
import { SessionInputQueue, type PendingSessionInput } from './session-input-queue.js';
import { withProductExecution, type ProductExecutionContext } from './product-execution-authorization.js';

it('keeps a restored mode floor as a batch boundary after rebinding both inputs to one static authority', () => {
  const queue = new SessionInputQueue(() => {});
  const plain = { sessionId: 's', inputId: 'plain', text: 'Plain original' };
  const constrained = { sessionId: 's', inputId: 'agent-only', text: 'Agent original' };
  queue.restore([{ input: plain, skill: false, principalId: 'owner' },
    { input: constrained, skill: false, principalId: 'owner', requiredWorkMode: 'agent' }], true);
  const fresh: ProductExecutionContext = { principalId: 'owner', key: 'fresh-static', bindRun: async input => input };
  withProductExecution(fresh, () => { queue.rebind(plain); queue.rebind(constrained); });
  expect(queue.batch('s').map(item => item.input.inputId)).toEqual(['plain']);
  queue.submitBatch('s', ['plain'], 'coding-run');
  expect(queue.batch('s')).toMatchObject([{ input: constrained, execution: { profile: { requiredWorkMode: 'agent' } } }]);
});

it.each([{}, { explicitSkill: null }, { explicitSkill: 'explicit-method' }, { explicitSkill: null, plainRunBoundary: true as const }])
  ('retains persisted Run-boundary and legacy Skill markers across JSON restore (%#)', marker => {
    const saved = [{ input: { sessionId: 's', inputId: 'pending', text: '/explicit-method Keep original arguments',
      delivery: 'redirect' as const, targetRunId: 'old-run' }, skill: true, ...marker }];
    const queue = new SessionInputQueue(() => {});
    queue.restore(JSON.parse(JSON.stringify(saved)) as typeof saved);
    expect(queue.snapshot('s')).toEqual(saved);
    expect(queue.batch('s')).toHaveLength(1);
    expect(queue.batch('s')[0]?.input.text).toBe('/explicit-method Keep original arguments');
  });

it('commits plain Run boundaries before changing memory and retains their intent through cold JSON restore', async () => {
  let fail = false;
  let saved: readonly PendingSessionInput[] = [];
  const queue = new SessionInputQueue(() => {}, (_session, pending) => {
    if (fail) throw new Error('EIO');
    saved = JSON.parse(JSON.stringify(pending)) as readonly PendingSessionInput[];
  });
  const input = { sessionId: 's', inputId: 'plain', text: '/unknown-method Keep raw input', delivery: 'redirect' as const, targetRunId: 'old-run' };
  queue.enqueue(input, false);
  fail = true;
  expect(() => queue.deferToRunBoundary('s', 'plain')).toThrow('EIO');
  expect(queue.snapshot('s')).toEqual([{ input, skill: false }]);
  fail = false;
  queue.deferToRunBoundary('s', 'plain');
  expect(saved).toEqual([{ input, skill: true, explicitSkill: null, plainRunBoundary: true }]);
  const restored = new SessionInputQueue(() => {});
  restored.restore(saved);
  expect(restored.snapshot('s')).toEqual(saved);
  expect(await restored.consumePlainBatch('s', 'active-run', async () => {})).toEqual([]);
  expect(restored.batch('s')).toMatchObject([{ input, plainRunBoundary: true }]);
});

it.each([
  { skill: true, explicitSkill: null, plainRunBoundary: 'true' },
  { skill: true, explicitSkill: 'selected-method', plainRunBoundary: true },
  { skill: 'true', explicitSkill: null, plainRunBoundary: true },
])('rejects malformed plain-boundary provenance before restoring any input (%#)', marker => {
  const queue = new SessionInputQueue(() => {});
  const saved = [{ input: { sessionId: 's', inputId: 'bad', text: 'Keep' }, ...marker }];
  expect(() => queue.restore(JSON.parse(JSON.stringify(saved)) as readonly PendingSessionInput[])).toThrow(/boundary/);
  expect(queue.list('s')).toEqual([]);
});

it('retains rejected queued intent across restart and reports a cleared error only after original-principal rebind', () => {
  const queue = new SessionInputQueue(() => {});
  const context: ProductExecutionContext = { principalId: 'A', key: 'lease', bindRun: async input => input };
  const input = { sessionId: 's', inputId: 'blocked', text: 'Keep my original question' };
  withProductExecution(context, () => queue.enqueue(input, false));
  queue.block('s', 'blocked', { code: 'execution_binding_rejected', message: 'Disabled expert' });
  const saved = queue.snapshot('s');
  expect(queue.batch('s')).toEqual([]);
  expect(queue.read('s', 'blocked')?.admissionError?.code).toBe('execution_binding_rejected');
  const restored = new SessionInputQueue(() => {});
  withProductExecution(context, () => restored.restore(saved));
  expect(restored.batch('s')).toEqual([]);
  withProductExecution({ ...context, principalId: 'B' }, () => expect(() => restored.rebind(input)).toThrow(/principal/));
  withProductExecution(context, () => expect(restored.rebind(input)).not.toHaveProperty('admissionError'));
  expect(restored.batch('s')).toMatchObject([{ input }]);
  expect(restored.snapshot('s')[0]).not.toHaveProperty('admissionError');
});

it.each([undefined, 'immediate', 'after_turn', 'redirect'] as const)('preserves exact queued delivery intent %s across restart and fresh authorization', (delivery) => {
  const input = { sessionId: 's', inputId: 'pending', text: 'Keep the original constraint.',
    ...(delivery !== undefined ? { delivery } : {}),
    ...(delivery === 'redirect' ? { targetRunId: 'original-run' } : {}) };
  const original: ProductExecutionContext = { principalId: 'A', key: 'old', bindRun: async value => value };
  const fresh = { ...original, key: 'fresh' };
  const first = new SessionInputQueue(() => {});
  withProductExecution(original, () => first.enqueue(input, false));
  const saved = first.snapshot('s');
  expect(saved).toEqual([{ input, skill: false, principalId: 'A' }]);
  const second = new SessionInputQueue(() => {});
  second.restore(saved, true);
  withProductExecution(fresh, () => expect(second.rebind(input)).toMatchObject({ state: 'queued' }));
  expect(second.batch('s')).toMatchObject([{ input }]);
});

it('preserves other principals in order without blocking recovery or borrowing authority', async () => {
  const context = (principalId: string): ProductExecutionContext => ({ principalId, key: `fresh-${principalId}`, bindRun: async input => input });
  const inputs = ['A', 'B'].map(principalId => ({ principalId, skill: false,
    input: { sessionId: 's', inputId: principalId, text: `Keep ${principalId}`, delivery: 'after_turn' as const } }));
  const queue = new SessionInputQueue(() => {});
  withProductExecution(context('A'), () => queue.restore(inputs));
  expect(queue.snapshot('s')).toEqual(inputs);
  expect(await queue.consumePlainBatch('s', 'root', async () => {}, 'fresh-A', 'A')).toMatchObject([{ inputId: 'A' }]);
  expect(queue.batch('s')).toEqual([]);
  expect(await queue.consumePlainBatch('s', 'root', async () => {}, 'fresh-A', 'A')).toEqual([]);
  expect(() => withProductExecution(context('A'), () => queue.rebind(inputs[1]!.input))).toThrow(/principal/);
  withProductExecution(context('B'), () => queue.rebind(inputs[1]!.input));
  expect(await queue.consumePlainBatch('s', 'next', async () => {}, 'fresh-B', 'B')).toMatchObject([{ inputId: 'B', content: 'Keep B' }]);
  expect(queue.snapshot('s')).toEqual([]);
});

it('rejects conflicting duplicate IDs before restoring any body', () => {
  const queue = new SessionInputQueue(() => {});
  expect(() => queue.restore(['One', 'Different'].map(text => ({ skill: false, input: { sessionId: 's', inputId: 'one', text } })))).toThrow(/intent/);
  expect(queue.list('s')).toEqual([]);
});

it('retains client ownership during withdrawal and enforces restore identity before any mutation', () => {
  const queue = new SessionInputQueue(() => {});
  const a: ProductExecutionContext = { principalId: 'A', key: 'fresh-A', bindRun: async input => input };
  const b: ProductExecutionContext = { principalId: 'B', key: 'fresh-B', bindRun: async input => input };
  const input = { sessionId: 's', inputId: 'a', text: 'Keep A', delivery: 'after_turn' as const };
  withProductExecution(a, () => {
    queue.enqueue(input, false);
    expect(queue.enqueue(input, false)).toMatchObject({ state: 'queued' });
    expect(() => queue.enqueue({ ...input, text: 'Changed' }, false)).toThrow(/intent/);
    queue.restore(queue.snapshot('s'));
    expect(() => queue.validateRestore([{ input, skill: false, principalId: 'B' }])).toThrow(/intent/);
    queue.recordAccepted({ ...input, inputId: 'steer' }, 'root', 'queued');
    expect(() => queue.withdraw('s', 'steer', { principalId: 'A' }, () => false)).toThrow(/being delivered/);
    expect(queue.read('s', 'steer')?.state).toBe('queued');
    queue.recordAccepted({ ...input, inputId: 'steer-pending' }, 'root', 'queued');
    queue.markDropped('s', 'steer');
    expect(queue.read('s', 'steer')?.state).toBe('dropped');
  });
  withProductExecution(b, () => queue.enqueue({ ...input, inputId: 'b' }, false));
  expect(queue.clientSessions('A')).toEqual(['s']);
  expect(queue.withdrawClient('A', 's')).toEqual([{ sessionId: 's', inputId: 'a' }]);
  expect(queue.list('s')).toMatchObject([{ inputId: 'b' }]);
  queue.releaseSession('s');
  expect(queue.list('s')).toEqual([]);
  expect(() => queue.withdraw('s', 'missing')).toThrow(/submitted/);
  expect(() => queue.submitBatch('s', ['missing'], 'root')).toThrow(/available/);
});

it('withdraws a steer input only after its Run releases it, keeping a durable receipt', () => {
  let saved: unknown;
  const queue = new SessionInputQueue(() => {}, (_session, _pending, withdrawn) => { saved = structuredClone(withdrawn); });
  const a: ProductExecutionContext = { principalId: 'A', key: 'fresh-A', bindRun: async input => input };
  const steer = { sessionId: 's', inputId: 'steer', text: 'Use the lighter script.', delivery: 'steer' as const, targetRunId: 'run-1' };
  const released: string[] = [];
  withProductExecution(a, () => queue.recordAccepted(steer, 'run-1', 'queued'));
  expect(() => queue.withdraw('s', 'steer', { principalId: 'B' }, () => true)).toThrow(/original principal/);
  expect(() => queue.withdraw('s', 'steer', { principalId: 'A' }, () => false)).toThrow(/being delivered/);
  expect(saved).toEqual([]);
  expect(queue.withdraw('s', 'steer', { principalId: 'A' }, runId => { released.push(runId); return true; })).toEqual(steer);
  expect(released).toEqual(['run-1']);
  expect(queue.read('s', 'steer')).toEqual({ sessionId: 's', inputId: 'steer', state: 'withdrawn', runId: 'run-1' });
  expect(saved).toEqual([{ input: steer, principalId: 'A' }]);
  expect(queue.withdraw('s', 'steer', { principalId: 'A' }, () => false)).toEqual(steer);
  queue.markSubmitted('s', 'steer');
  expect(queue.read('s', 'steer')?.state).toBe('withdrawn');
  expect(withProductExecution(a, () => queue.recordAccepted(steer, 'run-1', 'queued')).state).toBe('withdrawn');
});

it('rolls back the steer withdrawal receipt when its Run fails to release the input', () => {
  let saved: unknown;
  const queue = new SessionInputQueue(() => {}, (_session, _pending, withdrawn) => { saved = structuredClone(withdrawn); });
  const steer = { sessionId: 's', inputId: 'steer', text: 'Use the lighter script.', delivery: 'steer' as const, targetRunId: 'run-1' };
  queue.recordAccepted(steer, 'run-1', 'queued');
  expect(() => queue.withdraw('s', 'steer', undefined, () => { throw new Error('Run checkpoint write failed'); }))
    .toThrow(/checkpoint write failed/);
  expect(saved).toEqual([]);
  expect(queue.read('s', 'steer')?.state).toBe('queued');
  expect(queue.withdraw('s', 'steer', undefined, () => true)).toEqual(steer);
});

it('commits pending bodies before accepting enqueue or withdrawal and permits retry after failed persistence', () => {
  let fail = true;
  let saved: unknown;
  const queue = new SessionInputQueue(() => {}, (_session, pending) => {
    if (fail) throw new Error('EIO');
    saved = structuredClone(pending);
  });
  const input = { sessionId: 's', inputId: 'one', text: 'Never deploy.', delivery: 'after_turn' as const };
  expect(() => queue.enqueue(input, false)).toThrow('EIO');
  expect(queue.read('s', 'one')).toBeUndefined();
  fail = false;
  queue.enqueue(input, false);
  expect(saved).toEqual([{ input, skill: false }]);
  fail = true;
  expect(() => queue.withdraw('s', 'one')).toThrow('EIO');
  expect(queue.list('s')).toHaveLength(1);
  fail = false;
  queue.withdraw('s', 'one');
  expect(saved).toEqual([]);
});

it('preflights the entire restored queue before mutating any input', () => {
  const queue = new SessionInputQueue(() => {});
  const pending = Array.from({ length: 6 }, (_, index) => ({ input: { sessionId: 's', inputId: String(index), text: 'Keep' }, skill: false }));
  expect(() => queue.validateRestore(pending)).toThrow(/limit/);
  expect(() => queue.restore(pending)).toThrow(/limit/);
  expect(queue.list('s')).toEqual([]);
});

it('restores exact pending constraints without replaying already submitted inputs', async () => {
  const first = new SessionInputQueue(() => {});
  first.enqueue({ sessionId: 's', inputId: 'done', text: 'Old instruction' }, false);
  await first.consumePlainBatch('s', 'r', async () => {});
  const full = 'Do not change exports.\n'.repeat(80);
  first.enqueue({ sessionId: 's', inputId: 'pending', text: full }, false);
  const saved = first.snapshot('s');
  first.close();
  const second = new SessionInputQueue(() => {});
  second.restore(saved);
  expect(await second.consumePlainBatch('s', 'r', async () => {})).toMatchObject([{ inputId: 'pending', content: full }]);
  expect(saved).toHaveLength(1);
});

it('retains queued identity and bodies until canonical persistence succeeds', async () => {
  const queue = new SessionInputQueue(() => {});
  const input = { sessionId: 's', inputId: 'one', text: 'Keep this', delivery: 'after_turn' as const };
  queue.enqueue(input, false);
  const failedSave = vi.fn(async () => { throw new Error('save rejected'); });
  await expect(queue.consumePlainBatch('s', 'run', failedSave)).rejects.toThrow('save rejected');
  expect(queue.read('s', 'one')).toMatchObject({ state: 'queued' });
  expect(queue.list('s')).toHaveLength(1);
  const persist = vi.fn(async () => {
    expect(queue.read('s', 'one')).toMatchObject({ state: 'queued' });
    expect(queue.list('s')).toHaveLength(1);
  });
  expect(await queue.consumePlainBatch('s', 'run', persist)).toMatchObject([{ inputId: 'one', content: 'Keep this' }]);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(queue.read('s', 'one')).toMatchObject({ state: 'submitted', runId: 'run' });
  expect(queue.list('s')).toEqual([]);
  expect(await queue.consumePlainBatch('s', 'run', persist)).toEqual([]);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(() => queue.withdraw('s', 'one')).toThrow('already been submitted');
});

it('keeps a Skill barrier and later plain inputs pending while consuming only the earlier plain batch', async () => {
  const queue = new SessionInputQueue(() => {});
  for (const [inputId, text] of [['before', 'First'], ['skill', '/inspect'], ['after', 'Last']]) {
    queue.enqueue({ sessionId: 's', inputId: inputId!, text: text!, delivery: 'after_turn' }, inputId === 'skill');
  }
  const persist = vi.fn(async () => {});
  expect(await queue.consumePlainBatch('s', 'run', persist)).toMatchObject([{ inputId: 'before' }]);
  expect(await queue.consumePlainBatch('s', 'run', persist)).toEqual([]);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(queue.list('s').map(input => input.inputId)).toEqual(['skill', 'after']);
  expect(queue.withdraw('s', 'skill').text).toBe('/inspect');
  expect(await queue.consumePlainBatch('s', 'run', persist)).toMatchObject([{ inputId: 'after' }]);
});

it('keeps another Session input separate even when both clients used the same inputId', async () => {
  const queue = new SessionInputQueue(() => {});
  queue.enqueue({ sessionId: 'a', inputId: 'same', text: 'A', delivery: 'after_turn' }, false);
  queue.enqueue({ sessionId: 'b', inputId: 'same', text: 'B', delivery: 'after_turn' }, false);
  expect(await queue.consumePlainBatch('a', 'run-a', async () => {})).toMatchObject([{ content: 'A' }]);
  expect(queue.read('b', 'same')).toMatchObject({ state: 'queued' });
  expect(queue.withdraw('b', 'same').text).toBe('B');
});

it('lets another client of the same person withdraw a queued input and keeps a service apart', () => {
  let saved: unknown;
  const queue = new SessionInputQueue(() => {}, (_session, pending, withdrawn) => { saved = structuredClone({ pending, withdrawn }); });
  const laptop: ProductExecutionContext = { principalId: 'laptop', subject: 'person', key: 'laptop-key', bindRun: async input => input };
  const input = { sessionId: 's', inputId: 'queued', text: 'Take this back from the phone.', delivery: 'after_turn' as const };
  withProductExecution(laptop, () => queue.enqueue(input, false));
  expect(saved).toMatchObject({ pending: [{ principalId: 'laptop', subject: 'person' }] });
  expect(() => queue.withdraw('s', 'queued', { principalId: 'backend', subject: 'service:billing' })).toThrow(/original principal/);
  expect(queue.withdraw('s', 'queued', { principalId: 'phone', subject: 'person' })).toEqual(input);
  // Cleanup on client exit still follows the client instance that submitted the input.
  expect(saved).toMatchObject({ withdrawn: [{ principalId: 'laptop', subject: 'person' }] });
});

it('checks an input recorded before subjects existed against its client instance', () => {
  const queue = new SessionInputQueue(() => {});
  const input = { sessionId: 's', inputId: 'old', text: 'Written by an earlier Host.' };
  queue.restore([{ input, skill: false, principalId: 'laptop' }], true);
  expect(queue.snapshot('s')).toEqual([{ input, skill: false, principalId: 'laptop' }]);
  expect(() => queue.withdraw('s', 'old', { principalId: 'phone', subject: 'person' })).toThrow(/original principal/);
  expect(queue.withdraw('s', 'old', { principalId: 'laptop', subject: 'person' })).toEqual(input);
});

it('gives an input with Run options a Run of its own and keeps the options through a restart', async () => {
  const saved: PendingSessionInput[][] = [];
  const queue = new SessionInputQueue(() => {}, (_sessionId, pending) => { saved.push(structuredClone([...pending])); });
  const limited = { sessionId: 's', inputId: 'limited', text: 'Second', delivery: 'after_turn' as const, runOptions: { budget: { maxIter: 1 } } };
  queue.enqueue({ sessionId: 's', inputId: 'before', text: 'First', delivery: 'after_turn' }, false);
  queue.enqueue(limited, false);
  queue.enqueue({ sessionId: 's', inputId: 'after', text: 'Third', delivery: 'after_turn' }, false);

  // Sent again it is the same input; with other options it is another intent under the same id.
  expect(queue.enqueue(limited, false)).toMatchObject({ inputId: 'limited', state: 'queued' });
  expect(() => queue.enqueue({ ...limited, runOptions: { budget: { maxIter: 2 } } }, false)).toThrow(/different intent/);
  expect(() => queue.enqueue({ ...limited, runOptions: undefined }, false)).toThrow(/different intent/);

  expect(queue.batch('s').map(item => item.input.inputId)).toEqual(['before']);
  // A Run that is already working does not take it in either.
  expect(await queue.consumePlainBatch('s', 'run', async () => {})).toMatchObject([{ inputId: 'before' }]);
  expect(await queue.consumePlainBatch('s', 'run', async () => {})).toEqual([]);
  expect(queue.batch('s')).toMatchObject([{ input: limited }]);

  const restored = new SessionInputQueue(() => {});
  restored.restore(JSON.parse(JSON.stringify(saved.at(-1))) as PendingSessionInput[]);
  expect(restored.batch('s')).toMatchObject([{ input: limited }]);
  restored.submitBatch('s', ['limited'], 'run-limited');
  expect(restored.batch('s').map(item => item.input.inputId)).toEqual(['after']);
});
