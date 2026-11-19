// Zero-network capture of the first root request through the real managed Runtime, per work mode.
// Unlike tests/skill-trigger.capture.ts this runs repository intelligence and routing on a dirty
// Git worktree, so review breadth, PR routing and Script-mode guidance reach the request as shipped.
// Usage: KODAX_MANAGED_CAPTURE_OUT=<new file> KODAX_MANAGED_CAPTURE_CASES=<cases.json> [KODAX_MANAGED_CAPTURE_STAGE=name] [KODAX_MANAGED_CAPTURE_REPO_MODE=auto|off|light|full] [KODAX_MANAGED_CAPTURE_CHILD=read|write]
//   vite-node -c vitest.config.ts tests/managed-first-turn.capture.ts
// Output matches the skill-trigger capture shape, so tests/skill-trigger.eval.ts replays it.
// KODAX_MANAGED_CAPTURE_CATALOG=builtin passes the builtin Skill catalog the way the REPL does; run it
// with USERPROFILE/HOME pointed at an empty dir, because ~/.agents/skills is always scanned.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig, type KodaXToolDefinition } from '@kodax-ai/llm';
import { SkillRegistry } from '@kodax-ai/agent';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { initializeSkillRegistry, resetSkillRegistry } from '../packages/agent/src/capabilities/skills/skill-registry.js';
import type { KodaXWorkMode } from '../packages/coding/src/types.js';
import { createKodaXRuntime } from './runtime-fixture.js';
import { CACHE_GOLDEN, writeCacheFixture } from '../benchmark/datasets/search-entry-complex/fixture.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';
import { sourceHashes } from './skill-trigger.capture.js';

interface ManagedCaptureCase { readonly id: string; readonly task: string; readonly workMode: KodaXWorkMode }

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });

/** Committed multi-package repo plus an uncommitted fix across three packages and two root docs. */
async function writeDirtyWorkspace(workspace: string): Promise<void> {
  await writeCacheFixture(workspace);
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'core.autocrlf', 'false');
  git(workspace, 'add', '--all');
  git(workspace, '-c', 'user.name=Eval Fixture', '-c', 'user.email=eval-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture baseline');
  for (const [file, content] of Object.entries(CACHE_GOLDEN)) await fs.writeFile(path.join(workspace, file), content);
  await fs.appendFile(path.join(workspace, 'README.md'), '\nTenant keys are opaque and collision-free across any string encoding.\n');
  await fs.writeFile(path.join(workspace, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n- Fix tenant isolation and TTL boundaries in the cache client.\n');
}

// The capture stub replies with text, so the Run ends after one root response.
const PROVIDER = 'managed-capture';
type CatalogKind = 'none' | 'builtin';
const MODEL = 'capture-model';
const REPO_MODES = ['auto', 'off', 'light', 'full'] as const;
const repoMode = (process.env.KODAX_MANAGED_CAPTURE_REPO_MODE ?? 'auto') as typeof REPO_MODES[number];
if (!REPO_MODES.includes(repoMode)) throw new Error(`KODAX_MANAGED_CAPTURE_REPO_MODE must be one of ${REPO_MODES.join(', ')}`);
// With a lane, the root's first response spawns one child and its first request is captured too.
const childLane = process.env.KODAX_MANAGED_CAPTURE_CHILD as 'read' | 'write' | undefined;
if (childLane !== undefined && childLane !== 'read' && childLane !== 'write') throw new Error('KODAX_MANAGED_CAPTURE_CHILD must be read or write');
const CHILD_OBJECTIVE = 'Fix the TTL boundary in packages/cache-client so an entry expires exactly at its TTL, and report the change.';

/** The REPL hands the run its project registry and that registry's catalog snippet. */
async function skillContext(workspace: string, catalog: CatalogKind) {
  if (catalog === 'none') return { skillsPrompt: '', skillRegistry: new SkillRegistry(workspace) };
  resetSkillRegistry();
  const skillRegistry = await initializeSkillRegistry(workspace);
  const skillsPrompt = skillRegistry.getSystemPromptSnippet();
  if (!skillsPrompt.includes('## Available Skills')) throw new Error('Builtin capture must carry a model-visible Skill catalog');
  return { skillsPrompt, skillRegistry };
}

interface CapturedCase { readonly root: FrozenInput; readonly child?: FrozenInput }

async function captureCase(root: string, testCase: ManagedCaptureCase, catalog: CatalogKind): Promise<CapturedCase> {
  const directory = await fs.mkdtemp(path.join(root, `${testCase.id}-`));
  const workspace = path.join(directory, 'workspace');
  await writeDirtyWorkspace(workspace);
  let captured: FrozenInput | undefined;
  let child: FrozenInput | undefined;
  const freeze = (input: FrozenInput): FrozenInput => JSON.parse(JSON.stringify(input)) as FrozenInput;
  const reply = { textBlocks: [{ type: 'text' as const, text: 'capture only' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' as const };
  class CaptureProvider extends KodaXBaseProvider {
    readonly name = PROVIDER;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_MANAGED_CAPTURE_KEY', model: MODEL, contextWindow: 128000, supportsThinking: false };
    // Child admission checks provider configuration; the stub never needs a key.
    override isConfigured(): boolean { return true; }
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string) {
      // The root Worker request is the first one carrying the managed tool menu; auxiliary judges carry one tool.
      if (tools.length <= 1) return reply;
      if (!captured) {
        captured = freeze({ messages, tools, system });
        if (!childLane) return reply;
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use' as const, toolBlocks: [{ type: 'tool_use' as const, id: 'capture-spawn', name: 'spawn_agent',
          input: { task_name: 'capture-child', objective: CHILD_OBJECTIVE, read_only: childLane === 'read' } }] };
      }
      // Later root requests keep the root system prompt; the first other one is the child's.
      if (childLane && !child && system !== captured.system) child = freeze({ messages, tools, system });
      return reply;
    }
  }
  const unregister = registerModelProvider(PROVIDER, () => new CaptureProvider());
  const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(directory, 'home'), defaultProvider: PROVIDER, defaultModel: MODEL });
  try {
    const session = await runtime.sessions.create({ projectPath: workspace });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
    const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: testCase.task, options: {
      provider: PROVIDER, model: MODEL, agentMode: 'ama', reasoningMode: 'off', lsp: false, maxIter: childLane ? 4 : 2, disablePromptCache: true, workMode: testCase.workMode,
      learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['eval-isolated'] } }),
      context: { executionCwd: workspace, gitRoot: workspace, ...await skillContext(workspace, catalog), repoIntelligenceMode: repoMode, resolveShellPermissionMode: () => 'full-access' },
    } });
    const result = await handle.result;
    if (result.error) throw new Error(`${testCase.id}: ${result.error.name}: ${result.error.message}`);
  } finally {
    await runtime.close();
    unregister();
  }
  if (!captured) throw new Error(`${testCase.id}: no root request captured`);
  if (catalog === 'builtin' && !JSON.stringify(captured).includes('## Available Skills')) throw new Error(`${testCase.id}: Skill catalog missing from the request`);
  if (!childLane) return { root: captured };
  if (!child) throw new Error(`${testCase.id}: no ${childLane} child request captured`);
  return { root: captured, child };
}

const out = process.env.KODAX_MANAGED_CAPTURE_OUT;
const casesFile = process.env.KODAX_MANAGED_CAPTURE_CASES;
if (!out || !casesFile) throw new Error('KODAX_MANAGED_CAPTURE_OUT and KODAX_MANAGED_CAPTURE_CASES are required');
const cases = JSON.parse(await fs.readFile(casesFile, 'utf8')) as ManagedCaptureCase[];
if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Duplicate case id');
const catalog = (process.env.KODAX_MANAGED_CAPTURE_CATALOG ?? 'none') as CatalogKind;
if (catalog !== 'none' && catalog !== 'builtin') throw new Error('KODAX_MANAGED_CAPTURE_CATALOG must be none or builtin');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-managed-capture-'));
if (catalog === 'builtin') {
  const skillHome = path.join(root, 'skill-home');
  await fs.mkdir(skillHome);
  setAgentConfigHome(skillHome);
}
const rows = [];
// Repository intelligence and routing signals race a 2s budget, so a cold attempt can drop blocks.
// Keeping the most complete of several attempts gives both arms the full context.
const attempts = Number(process.env.KODAX_MANAGED_CAPTURE_ATTEMPTS ?? '3');
for (const testCase of cases) {
  let best: CapturedCase | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = await captureCase(root, testCase, catalog);
    if (!best || JSON.stringify(candidate.root).length > JSON.stringify(best.root).length) best = candidate;
  }
  if (!best) throw new Error('KODAX_MANAGED_CAPTURE_ATTEMPTS must be at least 1');
  const { root: input, child } = best;
  rows.push({ id: testCase.id, task: testCase.task, workMode: testCase.workMode, input, hash: inputHash(input),
    ...child ? { childLane, child, childHash: inputHash(child) } : {} });
  process.stderr.write(`captured ${testCase.id}\n`);
}
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify({ stage: process.env.KODAX_MANAGED_CAPTURE_STAGE ?? 'adhoc', source, sourceHashes: await sourceHashes(), catalog, fixtureRoot: root, cases: rows }, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ out, cases: rows.map(r => ({ id: r.id, workMode: r.workMode, hash: r.hash, tools: r.input.tools.length,
  ...r.child ? { childHash: r.childHash, childTools: r.child.tools.length } : {} })) }) + '\n');
