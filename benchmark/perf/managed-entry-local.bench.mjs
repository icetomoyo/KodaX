import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Zero network/model cost. Run each baseline/candidate distribution in its own process.
const dist = path.resolve(process.argv[2] ?? 'dist');
const { KodaXBaseProvider, registerModelProvider } = await import(pathToFileURL(path.join(dist, 'sdk-llm.js')));
const { SkillRegistry } = await import(pathToFileURL(path.join(dist, 'sdk-agent.js')));
const { runManagedTask, awaitLatestCodingMemoryReviewDrain } = await import(pathToFileURL(path.join(dist, 'sdk-coding.js')));
const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-managed-entry-perf-'));
const project = path.join(root, 'project');
await mkdir(project);
let calls = 0;
class Provider extends KodaXBaseProvider {
  name = 'local-entry-perf';
  supportsThinking = false;
  config = { model: 'offline', apiKeyEnv: 'UNUSED_LOCAL_ENTRY_PERF_KEY' };
  isConfigured() { return true; }
  async stream() {
    calls++;
    return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
  }
}
const unregister = registerModelProvider('local-entry-perf', () => new Provider());
const samplesMs = [];
const ownedWorkMs = [];
try {
  for (let iteration = 0; iteration < 14; iteration++) {
    const registry = new SkillRegistry(project, { projectPaths: [], userPaths: [], pluginPaths: [], builtinPath: path.join(root, 'empty') });
    const start = performance.now();
    const owned = [];
    const result = await runManagedTask({ provider: 'local-entry-perf', effort: 'none', lsp: false, maxIter: 1,
      events: { runMemoryWork: async work => {
        const started = performance.now();
        try { await work(); } finally { owned.push(performance.now() - started); }
      } },
      context: { configHome: path.join(root, 'home'), executionCwd: project, gitRoot: project,
        skillRegistry: registry, managedTaskWorkspaceDir: project, repoIntelligenceMode: 'off' },
    }, 'Reply briefly.');
    assert.equal(result.success, true);
    if (iteration >= 2) { samplesMs.push(performance.now() - start); ownedWorkMs.push(owned); }
    await awaitLatestCodingMemoryReviewDrain(15_000);
  }
  assert.equal(calls, 14, 'Entry setup must not add provider requests');
  const sorted = [...samplesMs].sort((a, b) => a - b);
  process.stdout.write(JSON.stringify({ calls, samplesMs, ownedWorkMs, medianMs: (sorted[5] + sorted[6]) / 2, p95Ms: sorted.at(-1) }) + '\n');
} finally {
  unregister();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('kodax-managed-entry-perf-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
