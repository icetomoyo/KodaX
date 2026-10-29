import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { expect, it, vi } from 'vitest';
import { createFileVisualObservationOwner, visualObservationImage, type VisualObservation } from '@kodax-ai/agent/media';
import type { KodaXToolExecutionContext } from '../types.js';
import type { ToolHandlerSync } from '../tools/types.js';
import { createVisualEnvironmentTools, type VisualActionFact, type VisualEnvironmentAdapter } from './visual-environment.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(initialUnknown = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-env-owner-'));
  const bytes = await new Jimp({ width: 2, height: 1, color: 0x00ff00ff }).getBuffer('image/png');
  let version = 'episode-1:0'; let effects = 0; let captures = 0;
  let lastAction: VisualActionFact | undefined = initialUnknown ? { invocationId: 'disconnected', status: 'unknown', version } : undefined;
  let onCapture: (() => Promise<void>) | undefined; let onAction: (() => Promise<void>) | undefined;
  const receipts: VisualObservation[] = []; const pending: VisualObservation[] = [];
  const owner = createFileVisualObservationOwner({ ownerId: 'session', directory, list: async () => receipts });
  const adapter: VisualEnvironmentAdapter = {
    state: () => ({ version, lastAction }),
    async capture() { captures++; const sampledVersion = version; await onCapture?.(); return { bytes, version: sampledVersion, mediaType: 'image/png' }; },
    async act(_action, expected, invocationId, signal) {
      signal?.throwIfAborted();
      if (expected !== version) return { invocationId, status: 'not_dispatched', version };
      lastAction = { invocationId, status: 'unknown', version };
      await onAction?.();
      effects++; version = `episode-1:${effects}`;
      return lastAction = { invocationId, status: 'completed', version };
    },
  };
  const ctx: KodaXToolExecutionContext = { backups: new Map(), visualObservationOwner: owner,
    reserveVisualOutput: () => ({ cancel() {} }),
    admitVisualObservation: async (original, input) => {
      const observation = await owner.pin(original, { ...input, originEntryId: 'canonical-source' }); pending.push(observation);
      return { observation, content: visualObservationImage(owner, observation, original, input.validation) };
    } };
  let tools = createVisualEnvironmentTools({ cards: adapter, other: { ...adapter, state: () => ({ version: 'other:0' }),
    capture: async () => ({ bytes, version: 'other:0', mediaType: 'image/png' }) } });
  return { ctx, owner, receipts, pending, adapter, get effects() { return effects; }, get captures() { return captures; },
    capture(fn?: () => Promise<void>) { onCapture = fn; }, action(fn?: () => Promise<void>) { onAction = fn; },
    reconcile() { lastAction = { invocationId: lastAction?.invocationId ?? 'none', status: 'completed', version }; },
    restore() { tools = createVisualEnvironmentTools({ cards: adapter }); }, reset() { version = 'episode-2:0'; },
    externalUnknown() { lastAction = { invocationId: 'external', status: 'unknown', version }; },
    detail(text: string) { lastAction = { invocationId: 'previous', status: 'completed', version, detail: text }; },
    async call(name: string, input: Record<string, unknown>, context = ctx, commit = true) {
      const result = await (tools.find(tool => tool.name === name)!.handler as ToolHandlerSync)(input, context);
      if (commit) receipts.push(...pending.splice(0));
      const text = typeof result === 'string' ? result : result.filter(item => item.type === 'text').map(item => item.text).join('\n');
      return JSON.parse(text.split('\n')[0]!) as Record<string, unknown>;
    },
    async close() { await rm(directory, { recursive: true, force: true }); },
  };
}
const action = (basis: Record<string, unknown>, source = 'cards') => ({ source, action: 'reveal', expectedObservationId: basis.observationId, expectedSourceVersion: basis.sourceVersion });

it('reserves complete action metadata before capture and rejects over-display PNG before admission', async () => {
  const f = await fixture();
  try {
    f.detail('证'.repeat(500));
    await expect(f.call('visual_observe', { source: 'cards' }, { ...f.ctx,
      reserveVisualOutput: tokens => { if (tokens > 2000) throw new Error('capacity unavailable'); return { cancel() {} }; } })).rejects.toThrow('capacity unavailable');
    expect(f.captures).toBe(0);
    f.detail('small');
    const large = await new Jimp({ width: 2001, height: 1, color: 0xff0000ff }).getBuffer('image/png');
    f.adapter.capture = async () => ({ bytes: large, mediaType: 'image/png', version: 'episode-1:0' });
    await expect(f.call('visual_observe', { source: 'cards' })).rejects.toThrow('display limit');
    expect(f.pending).toHaveLength(0); expect(f.receipts).toHaveLength(0);
  } finally { await f.close(); }
});

it('rechecks live unknown facts even when the local current candidate and version still match', async () => {
  const f = await fixture();
  try {
    const basis = await f.call('visual_observe', { source: 'cards' }); f.externalUnknown();
    expect(await f.call('visual_act', action(basis))).toMatchObject({ status: 'not_dispatched' });
    f.reconcile();
    expect(await f.call('visual_act', action(basis))).toMatchObject({ status: 'not_dispatched' });
    expect(f.effects).toBe(0);
  } finally { await f.close(); }
});

it('an observation that sees unknown invalidates A even if reconciliation keeps the same version', async () => {
  const f = await fixture();
  try {
    const basis = await f.call('visual_observe', { source: 'cards' }); f.externalUnknown();
    expect(await f.call('visual_observe', { source: 'cards' })).toMatchObject({ applicability: 'historical' });
    f.reconcile(); expect(await f.call('visual_act', action(basis))).toMatchObject({ status: 'not_dispatched' });
    expect(f.effects).toBe(0);
  } finally { await f.close(); }
});

it('rejects A invalidated by an unknown observation while its committed receipt lookup is pending', async () => {
  const f = await fixture(); const entered = gate(); const held = gate();
  const list = f.owner.list;
  let attempted: ReturnType<typeof f.call> | undefined;
  try {
    const basis = await f.call('visual_observe', { source: 'cards' });
    f.owner.list = async () => { entered.release(); await held.promise; return list(); };
    attempted = f.call('visual_act', action(basis));
    await entered.promise;
    f.externalUnknown();
    expect(await f.call('visual_observe', { source: 'cards' })).toMatchObject({ applicability: 'historical' });
    f.reconcile(); // The adapter version remains episode-1:0; A is still invalid.
    held.release();
    expect(await attempted).toMatchObject({ status: 'not_dispatched' });
    expect(f.effects).toBe(0);
    f.owner.list = list;
    const fresh = await f.call('visual_observe', { source: 'cards' });
    expect(await f.call('visual_act', action(fresh))).toMatchObject({ status: 'completed' });
    expect(f.effects).toBe(1);
  } finally { held.release(); if (attempted) await attempted; f.owner.list = list; await f.close(); }
});

it.each(['new observation', 'reset', 'unknown', 'cancel'] as const)('rechecks %s after awaiting the receipt, before entering the adapter', async change => {
  const f = await fixture(); const entered = gate(); const held = gate(); const abort = new AbortController();
  const list = f.owner.list; const dispatch = vi.spyOn(f.adapter, 'act');
  let outcome: Promise<{ status: unknown; error?: unknown }> | undefined;
  try {
    const basis = await f.call('visual_observe', { source: 'cards' });
    f.owner.list = async () => { entered.release(); await held.promise; return list(); };
    outcome = f.call('visual_act', action(basis), { ...f.ctx, abortSignal: abort.signal }).then(
      result => ({ status: result.status }), (error: unknown) => ({ status: undefined, error }));
    await entered.promise;
    if (change === 'new observation') await f.call('visual_observe', { source: 'cards' });
    else if (change === 'reset') f.reset();
    else if (change === 'unknown') f.externalUnknown();
    else abort.abort(new Error('cancel during receipt'));
    held.release();
    if (change === 'cancel') expect(await outcome).toMatchObject({ error: { message: 'cancel during receipt' } });
    else expect(await outcome).toEqual({ status: 'not_dispatched' });
    expect(dispatch).not.toHaveBeenCalled(); expect(f.effects).toBe(0);
  } finally { held.release(); if (outcome) await outcome; f.owner.list = list; await f.close(); }
});

it('bounds an exception after confirmed completion and counts it in the image result metadata', async () => {
  const f = await fixture();
  try {
    const basis = await f.call('visual_observe', { source: 'cards' });
    const act = f.adapter.act;
    f.adapter.act = async (...args) => { await act(...args); throw new Error('中'.repeat(3000)); };
    const result = await f.call('visual_act', action(basis));
    expect(result.status).toBe('completed');
    expect(String(result.dispatchError)).toContain('[truncated]');
    expect(String(result.dispatchError).length).toBeLessThan(1050);
  } finally { await f.close(); }
});

it('restoring an unknown dispatched action requires adapter reconciliation before any new action', async () => {
  const f = await fixture(true);
  try {
    f.restore();
    const unknown = await f.call('visual_observe', { source: 'cards' });
    expect(unknown.applicability).toBe('historical');
    expect(await f.call('visual_act', action(unknown))).toMatchObject({ status: 'not_dispatched' });
    expect(f.effects).toBe(0);
    f.reconcile();
    const fresh = await f.call('visual_observe', { source: 'cards' });
    expect(await f.call('visual_act', action(fresh))).toMatchObject({ status: 'completed' });
    expect(f.effects).toBe(1);
  } finally { await f.close(); }
});

it('two caller contexts sharing the owner cannot both act on A; unrelated sources and historical bytes remain accessible', async () => {
  const f = await fixture(); const held = gate(); const started = gate();
  try {
    const basis = await f.call('visual_observe', { source: 'cards' });
    f.action(async () => { started.release(); await held.promise; });
    const first = f.call('visual_act', action(basis), { ...f.ctx, runtimeRunId: 'run-A', actorTurnRef: { actorPath: '/a', turnId: 'a' } });
    await started.promise;
    const second = f.call('visual_act', action(basis), { ...f.ctx, runtimeRunId: 'run-B', actorTurnRef: { actorPath: '/b', turnId: 'b' } });
    expect(await f.call('visual_observe', { source: 'other' })).toMatchObject({ sourceVersion: 'other:0' });
    expect(await f.owner.read(f.receipts[0]!)).toBeInstanceOf(Buffer);
    held.release();
    expect(await first).toMatchObject({ status: 'completed' });
    expect(await second).toMatchObject({ status: 'not_dispatched' });
    expect(f.effects).toBe(1);
  } finally { held.release(); await f.close(); }
});

it('a pre-action sample arriving after the post-action frame is retained as historical without replacing current', async () => {
  const f = await fixture(); const held = gate(); const started = gate();
  try {
    const basis = await f.call('visual_observe', { source: 'cards' });
    f.capture(async () => { started.release(); await held.promise; });
    const late = f.call('visual_observe', { source: 'cards' }); await started.promise; f.capture();
    const changed = await f.call('visual_act', action(basis));
    held.release(); expect(await late).toMatchObject({ applicability: 'historical', sourceVersion: 'episode-1:0' });
    expect(await f.call('visual_act', action(changed))).toMatchObject({ status: 'completed' });
    expect(f.effects).toBe(2);
  } finally { held.release(); await f.close(); }
});

it('uncommitted receipts, a reset version and restored owner state never authorize old coordinates', async () => {
  const f = await fixture();
  try {
    const provisional = await f.call('visual_observe', { source: 'cards' }, f.ctx, false);
    expect(await f.call('visual_act', action(provisional), f.ctx, false)).toMatchObject({ status: 'not_dispatched' });
    f.receipts.push(...f.pending.splice(0)); f.reset();
    expect(await f.call('visual_act', action(provisional))).toMatchObject({ status: 'not_dispatched' });
    const fresh = await f.call('visual_observe', { source: 'cards' }); f.restore();
    expect(await f.call('visual_act', action(fresh))).toMatchObject({ status: 'not_dispatched' });
    expect(f.effects).toBe(0); expect(await f.owner.read(f.receipts[0]!)).toBeInstanceOf(Buffer);
  } finally { await f.close(); }
});

it('completion survives failed capture; aborted-before-dispatch has no effects; unknown-after-dispatch is never replayed', async () => {
  const f = await fixture();
  try {
    const basis = await f.call('visual_observe', { source: 'cards' });
    const controller = new AbortController(); controller.abort(new Error('cancel before dispatch'));
    await expect(f.call('visual_act', action(basis), { ...f.ctx, abortSignal: controller.signal })).rejects.toThrow('cancel before dispatch');
    expect(f.effects).toBe(0);
    f.capture(async () => { throw new Error('capture disconnected'); });
    expect(await f.call('visual_act', action(basis))).toMatchObject({ status: 'completed', observation: 'unavailable' });
    expect(f.effects).toBe(1);
    expect(await f.call('visual_act', action(basis))).toMatchObject({ status: 'not_dispatched' });
    f.capture(); const fresh = await f.call('visual_observe', { source: 'cards' });
    f.action(async () => { throw new Error('connection lost after dispatch'); });
    expect(await f.call('visual_act', action(fresh))).toMatchObject({ status: 'unknown', dispatchError: 'connection lost after dispatch' });
    f.restore(); const uncertain = await f.call('visual_observe', { source: 'cards' });
    expect(await f.call('visual_act', action(uncertain))).toMatchObject({ status: 'not_dispatched' });
    expect(f.effects).toBe(1);
  } finally { await f.close(); }
});

it('keeps dispatched cancellation unknown and completed cancellation completed, including failed archive', async () => {
  const f = await fixture();
  try {
    const first = await f.call('visual_observe', { source: 'cards' });
    const abort = new AbortController();
    f.action(async () => { abort.abort(new Error('cancel while dispatched')); throw abort.signal.reason; });
    expect(await f.call('visual_act', action(first), { ...f.ctx, abortSignal: abort.signal })).toMatchObject({ status: 'unknown', dispatchError: 'cancel while dispatched' });
    expect(f.effects).toBe(0);
    f.reconcile(); f.action(); const basis = await f.call('visual_observe', { source: 'cards' });
    const completed = new AbortController();
    f.action(async () => { completed.abort(new Error('cancel after physical completion is permitted')); });
    expect(await f.call('visual_act', action(basis), { ...f.ctx, abortSignal: completed.signal })).toMatchObject({ status: 'completed', observation: 'unavailable' });
    expect(f.effects).toBe(1);
    f.action(); const fresh = await f.call('visual_observe', { source: 'cards' });
    expect(await f.call('visual_act', action(fresh), { ...f.ctx, admitVisualObservation: async () => { throw new Error('archive failed'); } }))
      .toMatchObject({ status: 'completed', observationError: 'archive failed' });
    expect(f.effects).toBe(2);
  } finally { await f.close(); }
});
