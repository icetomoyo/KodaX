import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXStreamResult, KodaXToolUseBlock } from '@kodax-ai/llm';
import { inputHash } from './first-turn-eval-support.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { createCompactReadRecoveryFault } from './first-turn-compact-recovery.js';
import { currentProviderRequestAttribution } from '../packages/llm/src/provider-request-observation.js';
import { compactManagedWorkerInput } from './first-turn-compact-candidate.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['read', 'tool_call'])('keeps a readonly child %s refusal stable, preserves arguments and recovers through another real read before AMA closure', async entry => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('COMPACT_RECOVERY_KEY', 'offline-only');
  const fetcher = vi.fn(async () => { throw new Error('Offline recovery regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-compact-recovery-'));
  const fault = createCompactReadRecoveryFault(path.join(directory, 'workspace'));
  const tool = (name: string, input: Record<string, unknown>, id: string): KodaXToolUseBlock => ({ type: 'tool_use', name, input, id });
  const firstRead = tool(entry, entry === 'read' ? { path: 'README.md' } : { name: 'read', input: { path: 'README.md' } }, 'child-read-first');
  const retryRead = tool('read', { path: './README.md' }, 'child-read-retry');
  const originalFirst = structuredClone(firstRead);
  const originalRetry = structuredClone(retryRead);
  const childFinal = 'README read was refused twice; inspected tests/basic.test.js successfully. Parent owns delivery.';
  let childCalls = 0;
  let rootCalls = 0;
  let receivedChild = false;
  let rootReread = false;
  let sawFirstDenial = false;
  let sawRetryDenial = false;
  let sawRecovery = false;
  const actorPaths = new Set<string>();
  const attributions: unknown[] = [];
  let compactRoot = 0;
  try {
    const record = await runComplexRuntime({ id: 'compact-recovery', provider: 'offline', model: 'offline', env: 'COMPACT_RECOVERY_KEY' }, directory,
      async input => {
        const attribution = currentProviderRequestAttribution();
        attributions.push(attribution ?? null);
        expect(attribution?.kind).toBe('actor_turn');
        if (attribution?.kind !== 'actor_turn') throw new Error('Missing execution attribution');
        actorPaths.add(attribution.actorPath);
        const child = attribution.actorPath !== '/root';
        if (child) {
          expect(attribution.actorPath).toBe('/root/readonly-check');
          expect(attribution.turnId).not.toMatch(/^eval-root-/);
        } else expect(attribution.turnId).toMatch(/^eval-root-/);
        const candidate = compactManagedWorkerInput(input, !child);
        expect(candidate.tools).toBe(input.tools);
        expect(candidate.messages).toBe(input.messages);
        if (child) expect(candidate).toBe(input);
        else {
          // Exercise the adopted production contract, without stacking the
          // retired experimental projection on top of it.
          expect(input.system).toContain('TRUST AND SCOPE');
          expect(candidate).toBe(input);
          compactRoot++;
        }
        const blocks = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        const resultFor = (id: string) => blocks.find(block => block.type === 'tool_result' && block.tool_use_id === id);
        let calls: KodaXToolUseBlock[];
        let text = '';
        if (child) {
          const turn = childCalls++;
          if (turn === 0) calls = [firstRead];
          else if (turn === 1) {
            const receipt = resultFor(firstRead.id);
            sawFirstDenial = receipt?.type === 'tool_result' && receipt.is_error === true
              && String(receipt.content).includes('Fixture read refusal');
            expect(sawFirstDenial).toBe(true);
            expect(blocks).toContainEqual(firstRead);
            expect(String(receipt?.type === 'tool_result' ? receipt.content : '')).not.toContain('Tenant cache client');
            calls = [retryRead, tool('read', { path: 'tests/basic.test.js' }, 'child-read-recovery')];
          } else {
            const retry = resultFor(retryRead.id);
            const recovery = resultFor('child-read-recovery');
            sawRetryDenial = retry?.type === 'tool_result' && retry.is_error === true
              && String(retry.content).includes('Fixture read refusal');
            sawRecovery = recovery?.type === 'tool_result' && !recovery.is_error
              && String(recovery.content).includes('basic caching and expiry after deadline');
            expect(sawRetryDenial).toBe(true);
            expect(sawRecovery).toBe(true);
            expect(blocks).toContainEqual(retryRead);
            calls = []; text = childFinal;
          }
        } else {
          const turn = rootCalls++;
          if (turn === 0) calls = [tool('read', { path: 'README.md' }, 'root-initial-read')];
          else if (turn === 1) {
            const receipt = resultFor('root-initial-read');
            expect(receipt?.type === 'tool_result' && !receipt.is_error && String(receipt.content).includes('Tenant cache client')).toBe(true);
            calls = [tool('spawn_agent', { task_name: 'readonly-check', objective: 'Read README and the basic test, then report the evidence and limitations.', read_only: true, fork_turns: 'none' }, 'spawn-child')];
          } else {
            receivedChild ||= input.messages.some(message => message._taskResult?.summary === childFinal
              || message._taskResults?.some(result => result.summary === childFinal));
            if (receivedChild && !rootReread) {
              rootReread = true;
              calls = [tool('read', { path: 'README.md' }, 'root-final-read')];
            } else if (receivedChild && rootReread) {
              const receipt = resultFor('root-final-read');
              // A repeat root read may use the production bounded-read cache.
              expect(receipt?.type === 'tool_result' && !receipt.is_error).toBe(true);
              calls = []; text = 'Integrated the completed readonly check; its README refusal did not become a successful read.';
            } else calls = [tool('wait_agent', { timeout_ms: 10000 }, `wait-${turn}`)];
          }
        }
        const result: KodaXStreamResult = { textBlocks: text ? [{ type: 'text', text }] : [], thinkingBlocks: [], toolBlocks: calls,
          stopReason: calls.length ? 'tool_use' : 'end_turn' };
        return { inputHash: inputHash(input), result, text, toolCalls: calls, usage: null, estimatedUsd: null, error: null,
          physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }, { calls: 16, tools: 24, timeoutMs: 30000 }, true, 'Inspect the fixture compatibility evidence without making changes.', [fault.guardrail]);
    expect(record.error).toBeNull();
    expect(record.phase, JSON.stringify({ finalText: record.finalText, tree: record.tree, attributions, actorPaths: [...actorPaths], childCalls, rootCalls, faults: fault.events })).toBe('completed');
    expect(record.success).toBe(true);
    expect(receivedChild && sawFirstDenial && sawRetryDenial && sawRecovery).toBe(true);
    expect(childCalls).toBe(3);
    expect(compactRoot).toBe(rootCalls);
    expect(compactRoot).toBeGreaterThan(0);
    expect([...actorPaths].sort()).toEqual(['/root', '/root/readonly-check']);
    expect(attributions).toHaveLength(rootCalls + childCalls);
    expect(firstRead).toEqual(originalFirst);
    expect(retryRead).toEqual(originalRetry);
    const denied = fault.events.filter(event => event.action === 'block');
    expect(denied).toHaveLength(2);
    expect(denied.map(event => event.input.path)).toEqual(['README.md', './README.md']);
    expect(new Set(denied.map(event => event.target)).size).toBe(1);
    expect(denied.every(event => event.permissionIntent?.readOnly === true && Boolean(event.permissionIntent.delegatedObjective))).toBe(true);
    expect(denied.every(event => event.actorPath === '/root/readonly-check' && event.turnId?.startsWith('turn_'))).toBe(true);
    expect(record.groundtruth.protectedUnchanged).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected cleanup target');
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 40000);
