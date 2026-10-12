/**
 * Unit tests for `recordMutationForTool` — the mutation-tracker feeder that
 * drives managed-task mutation accounting. Regression coverage for the
 * P0 fixes:
 *   - `multi_edit` (registry `mutates-fs`) is now tracked (was silently
 *     omitted by the old hand-written set → gate skipped verification).
 *   - line estimation uses TOUCHED lines (max), so an equal-length rewrite
 *     is not collapsed to 1 line (which let large rewrites slip the gate).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import type { Agent, RunnerToolContext } from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';

import {
  recordMutationForTool,
  MUTATES_FS_TOOL_NAMES,
  wrapCodingToolAsRunnable,
} from './tool-wrappers.js';
import type { ManagedMutationTracker } from '../../../types.js';
import { getExtensionExecutionScope } from '../../../extensions/execution-scope.js';

function tracker(): ManagedMutationTracker {
  return { files: new Map<string, number>(), totalOps: 0, riskyShellOps: 0 };
}

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

it('binds AMA extension handlers to current Run and checked nested effects', async () => {
 const nested = vi.fn(async () => '[Blocked] checked host decision');
 const signal = new AbortController().signal;
 const runnable = wrapCodingToolAsRunnable({ name: 'artifact-scope-probe', description: 'probe', input_schema: { type: 'object', properties: {} } },
  async () => {
   const scope = getExtensionExecutionScope(); expect(scope).toMatchObject({ sessionId: 'session', runId: 'run', invocationId: 'call' });
   return scope!.invokeTool('write', { path: 'effect', content: 'x' });
  }, { backups: new Map(), sessionId: 'session', runtimeRunId: 'run', abortSignal: signal, invokeCheckedTool: nested });
 const runnerContext = { agent: { name: 'worker' } as Agent, toolCallId: 'call', abortSignal: signal };
 expect((await runnable.execute({}, runnerContext)).content).toBe('[Blocked] checked host decision');
 expect(nested).toHaveBeenCalledWith('write', { path: 'effect', content: 'x' }, runnerContext);
});
it('uses the current Runner invocation cancellation signal for handler effects', async () => {
 const rootSignal = new AbortController().signal, invocationSignal = new AbortController().signal;
 const runnable = wrapCodingToolAsRunnable({ name: 'signal-probe', description: 'probe', input_schema: { type: 'object', properties: {} } },
  async (_input, context) => { expect(context.abortSignal).toBe(invocationSignal); return 'ok'; },
  { backups: new Map(), abortSignal: rootSignal });
 expect((await runnable.execute({}, { agent: { name: 'worker' } as Agent, abortSignal: invocationSignal })).content).toBe('ok');
});

describe('recordMutationForTool — file mutation tracking', () => {
  it('tracks multi_edit (the bug: was omitted by the old hand-written set)', () => {
    const t = tracker();
    recordMutationForTool(t, 'multi_edit', {
      path: '/repo/foo.ts',
      edits: [
        { old_string: lines(3), new_string: lines(5) },
        { old_string: lines(2), new_string: lines(2) },
      ],
    });
    expect(t.totalOps).toBe(1);
    expect(t.files.get('/repo/foo.ts')).toBe(5 + 2); // sum of max(old,new) per edit
  });

  it('tracks write via content line count', () => {
    const t = tracker();
    recordMutationForTool(t, 'write', { path: '/repo/new.ts', content: lines(12) });
    expect(t.totalOps).toBe(1);
    expect(t.files.get('/repo/new.ts')).toBe(12);
  });

  it('counts an equal-length edit rewrite as TOUCHED lines, not 1 (touched, not delta)', () => {
    const t = tracker();
    // 80-line region rewritten into a different 80-line region.
    recordMutationForTool(t, 'edit', {
      path: '/repo/big.ts',
      old_string: lines(80),
      new_string: lines(80),
    });
    expect(t.files.get('/repo/big.ts')).toBe(80); // NOT abs(80-80)=0 -> 1
  });

  it('tracks edit via max(old,new) lines', () => {
    const t = tracker();
    recordMutationForTool(t, 'edit', { file_path: '/repo/a.ts', old_string: lines(2), new_string: lines(9) });
    expect(t.files.get('/repo/a.ts')).toBe(9);
  });

  it('accumulates across multiple edits to the same file', () => {
    const t = tracker();
    recordMutationForTool(t, 'edit', { path: '/repo/a.ts', old_string: lines(1), new_string: lines(4) });
    recordMutationForTool(t, 'edit', { path: '/repo/a.ts', old_string: lines(1), new_string: lines(6) });
    expect(t.files.get('/repo/a.ts')).toBe(10);
    expect(t.totalOps).toBe(2);
  });

  it('records a pathless fs mutation (undo) as totalOps + unattributedWriteOps, no file', () => {
    const t = tracker();
    recordMutationForTool(t, 'undo', {}); // undo carries no path; handler resolves it
    expect(t.totalOps).toBe(1);
    expect(t.unattributedWriteOps).toBe(1);
    expect(t.files.size).toBe(0);
  });

  it('records stage_self_modify as a pathless fs mutation', () => {
    const t = tracker();
    recordMutationForTool(t, 'stage_self_modify', { artifact_json: '{"kind":"agent"}' });
    expect(t.totalOps).toBe(1);
    expect(t.unattributedWriteOps).toBe(1);
    expect(t.files.size).toBe(0);
  });

  it('does NOT track scaffold_tool / activate_agent (readonly / mutates-state, not fs)', () => {
    const t = tracker();
    recordMutationForTool(t, 'scaffold_tool', { name: 'foo' });
    recordMutationForTool(t, 'activate_agent', { name: 'bar' });
    expect(t.totalOps).toBe(0);
    expect(t.unattributedWriteOps ?? 0).toBe(0);
  });

  it('records a risky bash mutation as totalOps + riskyShellOps', () => {
    const t = tracker();
    recordMutationForTool(t, 'bash', { command: 'git push origin main' });
    expect(t.totalOps).toBe(1);
    expect(t.riskyShellOps).toBe(1);
    expect(t.files.size).toBe(0);
  });

  it('records shell write-policy patterns as risky bash mutations', () => {
    const t = tracker();
    recordMutationForTool(t, 'bash', { command: 'Set-Content -Path a.txt -Value hi' });
    recordMutationForTool(t, 'bash', { command: 'echo hi > a.txt' });
    recordMutationForTool(t, 'bash', { command: 'sed -i s/old/new/ file.ts' });
    expect(t.totalOps).toBe(3);
    expect(t.riskyShellOps).toBe(3);
    expect(t.files.size).toBe(0);
  });

  it('records shell state-change commands as risky bash mutations', () => {
    const t = tracker();
    recordMutationForTool(t, 'bash', { command: 'git rm old.ts' });
    recordMutationForTool(t, 'bash', { command: 'pnpm update @scope/pkg' });
    recordMutationForTool(t, 'bash', { command: 'chmod 600 secrets.txt' });
    expect(t.totalOps).toBe(3);
    expect(t.riskyShellOps).toBe(3);
    expect(t.files.size).toBe(0);
  });

  it('ignores read-only tools (no mutation recorded)', () => {
    const t = tracker();
    recordMutationForTool(t, 'grep', { pattern: 'foo' });
    recordMutationForTool(t, 'read', { path: '/repo/a.ts' });
    recordMutationForTool(t, 'bash', { command: 'ls -la' });
    expect(t.totalOps).toBe(0);
    expect(t.files.size).toBe(0);
    expect(t.riskyShellOps).toBe(0);
  });

  it('is a no-op when the tracker is undefined', () => {
    expect(() => recordMutationForTool(undefined, 'write', { path: '/x', content: 'y' })).not.toThrow();
  });

  // Drift guard: the production set is hardcoded (importing the registry at
  // module load hits a handler-chain cycle through agent-resolver that leaves
  // BUILTIN_TOOL_DEFINITIONS undefined — reproduced even via dynamic import).
  // This test instead PARSES the registry source for `sideEffect: 'mutates-fs'`
  // tools, so adding one without tracking it fails here with the exact name.
  it('MUTATES_FS_TOOL_NAMES covers every mutates-fs tool in the registry source', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../tools/tool-definitions.ts', import.meta.url)),
      'utf-8',
    );
    const selfModifySrc = readFileSync(
      fileURLToPath(new URL('../../../tools/self-modify-tool.ts', import.meta.url)),
      'utf-8',
    );
    const constNames = new Map<string, string>();
    for (const match of selfModifySrc.matchAll(/export const ([A-Z_0-9]+) = ['"]([a-z_0-9]+)['"] as const/g)) {
      constNames.set(match[1] ?? '', match[2] ?? '');
    }
    // Tool-level `name:` / `sideEffect:` are at exactly 4-space indent; input
    // schema property names are deeper, so anchoring to 4 spaces avoids matching
    // them. Reset `current` after EVERY sideEffect (each tool has exactly one),
    // so a mutates-state tool (e.g. activate_agent) can't leak its name onto a
    // later tool's mutates-fs line — the bug that originally mis-added
    // activate_agent to the set.
    const mutatesFs: string[] = [];
    let current: string | null = null;
    for (const line of src.split('\n')) {
      const nameMatch = line.match(/^ {4}name: (?:['"]([a-z_0-9]+)['"]|([A-Z_0-9]+))/);
      if (nameMatch) {
        current = nameMatch[1] ?? constNames.get(nameMatch[2] ?? '') ?? `__unresolved:${nameMatch[2] ?? 'name'}`;
        continue;
      }
      const seMatch = line.match(/^ {4}sideEffect: ['"]([a-z-]+)['"]/);
      if (seMatch) {
        if (seMatch[1] === 'mutates-fs' && current) mutatesFs.push(current);
        current = null;
      }
    }
    expect(mutatesFs.length).toBeGreaterThan(4); // sanity: parser found tools
    expect(mutatesFs.filter((name) => name.startsWith('__unresolved:'))).toEqual([]);
    expect(mutatesFs).toContain('stage_self_modify');
    expect(mutatesFs).not.toContain('activate_agent'); // mutates-state, not -fs
    expect(mutatesFs).not.toContain('scaffold_tool'); // readonly draft generator
    const missing = mutatesFs.filter((name) => !MUTATES_FS_TOOL_NAMES.has(name));
    expect(missing).toEqual([]);
  });
});

describe('wrapCodingToolAsRunnable — recovery artifact metadata', () => {
  it('returns a tool-owned artifact path as trusted Runner metadata', async () => {
    const definition: KodaXToolDefinition = {
      name: 'bash',
      description: 'test bash wrapper',
      input_schema: { type: 'object', properties: {} },
    };
    const runnable = wrapCodingToolAsRunnable(
      definition,
      async (_input, ctx) => {
        ctx.recordToolResultArtifact?.(ctx.toolCallId!, 'C:/tmp/bash-manifest.txt');
        return '[KODAX_RESULT_INCOMPLETE]';
      },
      { backups: new Map() },
    );
    const runnerCtx: RunnerToolContext = {
      agent: { name: 'worker' } as Agent,
      toolCallId: 'bash-1',
    };

    await expect(runnable.execute({}, runnerCtx)).resolves.toMatchObject({
      content: '[KODAX_RESULT_INCOMPLETE]',
      metadata: {
        truncated: true,
        capacityFallback: true,
        outputPath: 'C:/tmp/bash-manifest.txt',
      },
    });
  });
});
