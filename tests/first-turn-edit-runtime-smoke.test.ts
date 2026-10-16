import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runEditRuntimeSmoke, runEditSmokeLanes } from './first-turn-edit-runtime-smoke.js';
import type { EditRoute } from './first-turn-edit-eval-support.js';
import type { KodaXStreamResult } from '../packages/llm/src/types.js';
import { inputHash } from './first-turn-eval-support.js';

it.each([
  { executionMode: 'coding', scenario: 'edit' },
  { executionMode: 'managed_task', scenario: 'edit' },
  { executionMode: 'managed_task', scenario: 'fixture-check' },
] as const)('checks Runtime tools and real node tests with scripted responses ($executionMode/$scenario)', async ({ executionMode, scenario }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-edit-smoke-test-'));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('KODAX_EDIT_TEST_KEY', 'local-scripted-only');
  const localFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(String(request));
    if (url.hostname !== '127.0.0.1') throw new Error('Offline smoke forbids external network');
    return localFetch(request, init);
  }));
  let round = 0;
  try {
    const evidence = await runEditRuntimeSmoke({ id: 'scripted', provider: 'scripted', model: 'scripted', env: 'KODAX_EDIT_TEST_KEY', rate: { inputPer1M: 0, outputPer1M: 0 }, reasoning: { enabled: false, effort: 'none' }, billing: 'coding-plan-reference-only' }, async input => {
      const calls = scenario === 'fixture-check' ? [
        { name: 'bash', input: { command: 'node --test page.test.js' } },
      ] : [
        { name: 'read', input: { path: 'sum.js' } },
        { name: 'edit', input: { path: 'sum.js', edits: [{ old_string: 'return a - b;', new_string: 'return a + b;' }, { old_string: 'return a + b; } // multiply', new_string: 'return a * b; } // multiply' }] } },
        { name: 'bash', input: { command: 'node --test sum.test.js' } },
      ];
      const call = calls[round++];
      const result: KodaXStreamResult = { textBlocks: call ? [] : [{ type: 'text', text: 'Scripted fixture: the actual Node test passed. This is not a live model conclusion.' }], thinkingBlocks: [], toolBlocks: call ? [{ type: 'tool_use', id: `offline-${round}`, ...call }] : [], stopReason: call ? 'tool_use' : 'end_turn' };
      return { inputHash: inputHash(input), result, text: result.textBlocks.map(block => block.text).join(''), toolCalls: result.toolBlocks, usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, path.join(directory, 'evidence.json'), 'scripted-test', undefined, executionMode, undefined, scenario);
    expect(evidence.error).toBeNull();
    expect(round).toBe(scenario === 'fixture-check' ? 2 : 4);
    expect(evidence.groundtruth.fileExact).toBe(true);
    expect(evidence.groundtruth.nodeTestPassed).toBe(true);
    expect(evidence.groundtruth.toolOrder).toEqual(scenario === 'fixture-check' ? ['bash'] : ['read', 'edit', 'bash']);
    if (scenario === 'fixture-check') expect(evidence.fixtureCheck).toEqual({ serverRequests: 1 });
    expect(evidence.runtimeSuccess).toBe(true); expect(evidence.error).toBeNull();
    expect(evidence.executionMode).toBe(executionMode);
    expect(evidence.liveModelEvidence).toBe(false);
    expect(evidence.semanticHonesty).toBe('requires-main-session-review');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it('keeps already in-flight evidence but forbids another provider request after one lane fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-edit-smoke-lanes-test-'));
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('KODAX_EDIT_TEST_KEY', 'local-scripted-only');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Offline lane test forbids network'); }));
  const route = (id: string): EditRoute => ({ id, provider: id, model: 'scripted', env: 'KODAX_EDIT_TEST_KEY', rate: { inputPer1M: 0, outputPer1M: 0 }, reasoning: { enabled: false, effort: 'none' }, billing: 'coding-plan-reference-only' });
  let startOther!: () => void; const otherStarted = new Promise<void>(resolve => { startOther = resolve; });
  let noteFailure!: () => void; const failureNoted = new Promise<void>(resolve => { noteFailure = resolve; });
  const requests: string[] = [];
  try {
    await expect(runEditSmokeLanes([route('failing'), route('running')], async (lane, input, _signal, onFailure) => {
      requests.push(lane.id);
      if (lane.id === 'failing') {
        await otherStarted; onFailure('scripted transport failure'); noteFailure();
        return { inputHash: inputHash(input), text: '', toolCalls: [], usage: null, estimatedUsd: null, error: 'scripted transport failure', physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }
      startOther(); await failureNoted;
      const result: KodaXStreamResult = { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'in-flight-read', name: 'read', input: { path: 'sum.js' } }], stopReason: 'tool_use' };
      return { inputHash: inputHash(input), result, text: '', toolCalls: result.toolBlocks, usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, (lane, call, control) => runEditRuntimeSmoke(lane, call, path.join(directory, `${lane.id}.json`), 'scripted-test', control))).rejects.toThrow('Smoke incomplete');
    expect(requests.sort()).toEqual(['failing', 'running']);
    const inFlight = JSON.parse(await fs.readFile(path.join(directory, 'running.json'), 'utf8')) as { calls: unknown[]; error: string; runtimeSuccess: boolean };
    expect(inFlight.calls).toHaveLength(1); expect(inFlight.error).toContain('Smoke lanes stopped');
    expect(inFlight.runtimeSuccess).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it('rejects an out-of-fixture tool before Runtime executes it and records failed offline evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-edit-smoke-guard-test-'));
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('KODAX_EDIT_TEST_KEY', 'local-scripted-only');
  let count = 0;
  try {
    const evidence = await runEditRuntimeSmoke({ id: 'scripted', provider: 'scripted', model: 'scripted', env: 'KODAX_EDIT_TEST_KEY', rate: { inputPer1M: 0, outputPer1M: 0 }, reasoning: { enabled: false, effort: 'none' }, billing: 'coding-plan-reference-only' }, async input => {
      count++;
      const result: KodaXStreamResult = { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'wrong-path', name: 'read', input: { path: '../outside.js' } }], stopReason: 'tool_use' };
      return { inputHash: inputHash(input), result, text: '', toolCalls: result.toolBlocks, usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, path.join(directory, 'evidence.json'), 'scripted-test');
    expect(count).toBe(1); expect(evidence.error).toContain('exact path/command violation');
    expect(evidence.groundtruth.toolOrder).toEqual([]);
    expect(evidence.groundtruth.fileExact).toBe(false); expect(evidence.groundtruth.nodeTestPassed).toBe(false);
    expect(evidence.runtimeSuccess).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60_000);
