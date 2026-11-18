// Zero-network capture of root first-turn inputs WITH a real Skill catalog.
// Usage: KODAX_SKILL_CAPTURE_OUT=<new file> [KODAX_SKILL_CAPTURE_CATALOG=builtin|rich] [KODAX_SKILL_CAPTURE_STAGE=baseline|candidate]
//   [KODAX_SKILL_CAPTURE_CASES=<cases.json>] vite-node -c vitest.config.ts tests/skill-trigger.capture.ts  (config strips Skill script shebangs)
// Prior first-turn captures used an empty agent home, so no catalog reached the model; this one does.
// For a builtin-only catalog run with USERPROFILE/HOME pointed at an empty dir (~/.agents/skills is always scanned).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createAgentActorController } from '../packages/agent/src/actors/index.js';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { initializeSkillRegistry, resetSkillRegistry } from '../packages/agent/src/capabilities/skills/skill-registry.js';
import { buildSystemPromptSnapshot } from '../packages/coding/src/prompts/builder.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.js';
import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import { filterModelToolAliases } from '../packages/coding/src/agent-runtime/tool-resolution.js';
import { markOrdinaryRootToolContract } from '../packages/coding/src/tools/managed-tool-contract.js';
import { createManagedRunContextMessage } from '../packages/coding/src/task-engine/_internal/managed-task/managed-run-context.js';
import type { KodaXMessage } from '../packages/llm/src/types.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';

export interface SkillCaptureCase {
  readonly id: string;
  readonly task: string;
  readonly priorMessages?: readonly KodaXMessage[];
}

export type SkillCatalogKind = 'builtin' | 'rich';

/** Copy the rich catalog source (if any) into the fixture home so discovery sees user Skills. */
async function prepareHome(home: string, catalog: SkillCatalogKind): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  if (catalog !== 'rich') return;
  const source = process.env.KODAX_SKILL_CAPTURE_RICH_SOURCE;
  if (!source) throw new Error('rich catalog needs KODAX_SKILL_CAPTURE_RICH_SOURCE (a skills directory)');
  await fs.cp(source, path.join(home, 'skills'), { recursive: true });
}

export async function captureSkillTriggerInputs(
  fixture: string,
  cases: readonly SkillCaptureCase[],
  catalog: SkillCatalogKind,
): Promise<{ catalog: SkillCatalogKind; skillsPrompt: string; cases: { id: string; task: string; input: FrozenInput; hash: string }[] }> {
  const workspace = path.join(fixture, 'workspace');
  const home = path.join(fixture, 'home');
  await fs.mkdir(workspace, { recursive: true });
  if ((await fs.readdir(workspace)).length) throw new Error('Capture workspace must be empty');
  await prepareHome(home, catalog);
  setAgentConfigHome(home);
  resetSkillRegistry();
  try {
    const registry = await initializeSkillRegistry(workspace);
    const skillsPrompt = registry.getSystemPromptSnippet();
    if (!skillsPrompt.includes('## Available Skills')) throw new Error('Capture must include a model-visible Skill catalog');
    const context = { executionCwd: workspace, gitRoot: workspace, skillsPrompt };
    const snapshot = await buildSystemPromptSnapshot({ provider: 'zhipu-coding', context }, true);
    const owned = new Set(['base-system', 'base-system-suffix', 'environment-context', 'runtime-fact', 'working-directory', 'session-scratch-directory', 'repo-intelligence-context', 'execution-guidance', 'active-skill-invocation']);
    const stableIds = new Set(['project-agents', 'self-knowledge-routing', 'memory-rules', 'tool-construction']);
    const shared = snapshot.sections.filter(section => !owned.has(section.id));
    // Default CLI/REPL runs are AMA: the root holds an Actor client, which adds delegation tools and
    // switches the request onto the compact Worker contract. KODAX_SKILL_CAPTURE_ACTOR=0 models SA.
    const actor = process.env.KODAX_SKILL_CAPTURE_ACTOR === '0' ? undefined
      : await createAgentActorController({ executor: { execute: async () => ({ output: 'capture only' }) } });
    const actorControl = actor?.bind('/root');
    const chain = buildRunnerAgentChain({ backups: new Map(), executionCwd: workspace, gitRoot: workspace,
      ...(actorControl ? { actorControl, actorTurnRef: { actorPath: '/root', turnId: 'skill-trigger-capture' } } : {}) });
    // Production ordinary roots get the managed tool/context projections (runner-driven.ts).
    markOrdinaryRootToolContract(chain.worker);
    const rows = [];
    for (const testCase of cases) {
      const decision = buildFallbackRoutingDecision(testCase.task);
      const roleContext = { originalTask: testCase.task, availableToolNames: filterModelToolAliases(chain.worker.tools ?? []).map(tool => tool.name),
        workspace: { executionCwd: workspace, gitRoot: workspace, platform: process.platform },
        stableCapabilityContextBlock: shared.filter(section => stableIds.has(section.id)).map(section => section.content).join('\n\n'),
        capabilityContextBlock: shared.filter(section => !stableIds.has(section.id)).map(section => section.content).join('\n\n'),
        ...(actorControl ? { actorCapacity: { maxConcurrentThreads: actorControl.list().maxConcurrentThreads, activeNonRootTurns: actorControl.list().activeNonRootTurns } } : {}) };
      const role = (mode: 'stable' | 'context') => createRolePrompt('worker', testCase.task, decision, undefined, undefined, 'kodax/role/worker', undefined, roleContext, undefined, false, mode);
      let captured: FrozenInput | undefined;
      const adapter = buildRunnerLlmAdapter({ provider: 'zhipu-coding', context: { ...context, repoIntelligenceMode: 'off' }, events: {} }, async (messages, tools, system) => {
        if (captured) throw new Error('Capture must use one adapter response');
        captured = JSON.parse(JSON.stringify({ messages, tools, system })) as FrozenInput;
        return { textBlocks: [{ text: 'capture only' }], toolBlocks: [] };
      });
      // Same envelope as resolveRoleRunContext (role-prompts.ts): the system prompt grants authority only
      // to text inside these markers, and the context projection uses the end marker as a boundary.
      const runContext = `=== Managed Run Context ===\n${role('context')}\n=== End Managed Run Context ===`;
      await adapter([{ role: 'system', content: role('stable') }, createManagedRunContextMessage(runContext),
        ...(testCase.priorMessages ?? []), { role: 'user', content: testCase.task }], chain.worker);
      if (!captured) throw new Error('Adapter did not capture');
      rows.push({ id: testCase.id, task: testCase.task, input: captured, hash: inputHash(captured) });
    }
    return { catalog, skillsPrompt, cases: rows };
  } finally {
    setAgentConfigHome(undefined);
    resetSkillRegistry();
  }
}

// Files whose bytes reach the captured request; candidates must not drift after freeze.
const SOURCE_FILES = ['packages/agent/src/capabilities/skills/skill-registry.ts',
  'packages/coding/src/prompts/static-text.json', 'packages/coding/src/tools/managed-tool-text.ts', 'packages/coding/src/agents/worker-role-prompt.ts',
  'packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts', 'packages/coding/src/prompts/builder.ts',
  'packages/coding/src/prompts/compact-worker-contract.ts', 'packages/coding/src/prompts/managed-system-contract.ts',
  'packages/coding/src/tools/tool-definitions.ts', 'packages/coding/src/tools/deferred-tools.ts', 'packages/coding/src/tools/skill.ts'];

export async function sourceHashes(): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async file =>
    [file, createHash('sha256').update(await fs.readFile(new URL(`../${file}`, import.meta.url))).digest('hex')])));
}

const out = process.env.KODAX_SKILL_CAPTURE_OUT;
if (out !== undefined) {
  const catalog = (process.env.KODAX_SKILL_CAPTURE_CATALOG ?? 'builtin') as SkillCatalogKind;
  if (catalog !== 'builtin' && catalog !== 'rich') throw new Error('Unknown catalog kind');
  const stage = process.env.KODAX_SKILL_CAPTURE_STAGE ?? 'adhoc';
  const casesFile = process.env.KODAX_SKILL_CAPTURE_CASES;
  const cases: SkillCaptureCase[] = casesFile
    ? (JSON.parse(await fs.readFile(casesFile, 'utf8')) as SkillCaptureCase[]).map(c => ({ id: c.id, task: c.task, priorMessages: c.priorMessages }))
    : [{ id: 'customer_docker_rpm', task: '请帮我用 Docker 安装 RPM 的离线包' }];
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Duplicate case id');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-skill-capture-'));
  // Request bytes do not vary by provider (checked 2026-11-17: deepseek, kimi-code, ark-coding match modulo fixture path).
  const capture = await captureSkillTriggerInputs(fixture, cases, catalog);
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify({ stage, source, sourceHashes: await sourceHashes(), ...capture }, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ out, stage, catalog, cases: capture.cases.map(c => ({ id: c.id, hash: c.hash, tools: c.input.tools.length })) }) + '\n');
}
