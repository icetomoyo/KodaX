import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { FrozenInput } from './first-turn-eval-support.js';
import { prepareActivationWorktreePair } from './contract-activation-worktree.js';

it('gives both arms the same real clean Git preflight and truthful new workspace context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-activation-worktree-'));
  const baseline: FrozenInput = { system: 'retained root\nWorking Directory: <OLD>', tools: [], messages: [
    { role: 'user', _synthetic: true, _source: 'managed-run-context', content: '=== Managed Run Context ===\nSession Scratch Directory: <OLD>\n\nProject: workspace\n  sample.png\n  value.mjs\n  tests/\n    value.test.mjs\n\nTask-relevant memory hints: currently empty.\n=== End Managed Run Context ===' },
    { role: 'user', content: 'Original edit task' },
  ] };
  try {
    const pair = await prepareActivationWorktreePair(root, baseline, { ...baseline, system: 'candidate root\nWorking Directory: <OLD>' });
    expect(pair.baseline.messages).toEqual(pair.candidate.messages);
    expect(pair.facts.preflight).toMatchObject({ status: 0, stdout: '## main\n' });
    expect(pair.facts.newBranch.stdout).toBe('');
    expect(pair.baseline.messages[0]!.content).toContain(pair.facts.workspace);
    expect(pair.baseline.messages[0]!.content).not.toContain('sample.png');
    expect(JSON.stringify(pair.baseline.messages)).toContain('git status --short --branch');
    expect(JSON.stringify(pair.baseline.messages)).toContain('codex/cache-ttl-review');
    expect(pair.baseline.system).toBe(`retained root\nWorking Directory: ${pair.facts.workspace}`);
    expect(pair.candidate.system).toBe(`candidate root\nWorking Directory: ${pair.facts.workspace}`);
    expect(pair.scope).toContain('capture-derived');
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-activation-worktree-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(root, { recursive: true, force: true });
  }
});
