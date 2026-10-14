// Zero-network production builder + managed adapter capture, before provider serialization.
// node node_modules/vite-node/vite-node.mjs --config vitest.config.ts tests/first-turn-inputs.capture.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FIRST_TURN_CASES } from '../benchmark/datasets/first-turn-tokens/cases.js';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { countTokens } from '../packages/agent/src/tokenizer.js';
import { buildSystemPromptSnapshot } from '../packages/coding/src/prompts/builder.js';
import { getActiveToolDefinitions } from '../packages/coding/src/agent-runtime/tool-resolution.js';
import { listToolDefinitions } from '../packages/coding/src/tools/registry.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.js';
import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import type { KodaXMessage, KodaXToolDefinition } from '../packages/llm/src/types.js';

const source = process.env.KODAX_FIRST_TURN_SOURCE_COMMIT
  ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
const stage = process.env.KODAX_FIRST_TURN_STAGE ?? 'candidate';
if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Unsafe capture stage');
// Keep the model-visible workspace stable when only the raw evidence TEMP changes.
const fixture = process.env.KODAX_FIRST_TURN_FIXTURE_ROOT ?? path.join(os.tmpdir(), 'kodax-first-turn-controlled-fixture');
const workspace = path.join(fixture, 'workspace');
const home = path.join(fixture, 'home');
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(home, { recursive: true });
if ((await fs.readdir(workspace)).length || (await fs.readdir(home)).length) throw new Error('Capture fixture must stay empty');
setAgentConfigHome(home);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const metric = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { chars: text.length, bytes: Buffer.byteLength(text), estimatedTokens: countTokens(text), hash: hash(value) };
};
interface CapturedInput { readonly system: string; readonly messages: readonly KodaXMessage[]; readonly tools: readonly KodaXToolDefinition[] }
try {
  const snapshot = await buildSystemPromptSnapshot({ provider: 'zhipu-coding', context: { executionCwd: workspace, gitRoot: workspace } }, true);
  const excluded = new Set(['memory_recall', 'memory_intent', 'session_history_search', 'session_history_read', 'run_skill_script']);
  const saTools = getActiveToolDefinitions(listToolDefinitions().map(t => t.name).filter(n => !excluded.has(n)), 'full', false, false, false).filter(t => t.name !== 'run_workflow');
  const managedOwned = new Set(['base-system', 'base-system-suffix', 'environment-context', 'runtime-fact', 'working-directory', 'session-scratch-directory', 'repo-intelligence-context', 'execution-guidance', 'active-skill-invocation']);
  const stableIds = new Set(['project-agents', 'self-knowledge-routing', 'memory-rules', 'tool-construction']);
  const shared = snapshot.sections.filter(s => !managedOwned.has(s.id));
  const chain = buildRunnerAgentChain({ backups: new Map(), executionCwd: workspace, gitRoot: workspace });
  const cases = [];
  for (const testCase of FIRST_TURN_CASES) {
    const decision = buildFallbackRoutingDecision(testCase.task);
    const context = {
      originalTask: testCase.task,
      availableToolNames: (chain.worker.tools ?? []).map(tool => tool.name),
      workspace: { executionCwd: workspace, gitRoot: workspace, platform: process.platform },
      stableCapabilityContextBlock: shared.filter(s => stableIds.has(s.id)).map(s => s.content).join('\n\n'),
      capabilityContextBlock: shared.filter(s => !stableIds.has(s.id)).map(s => s.content).join('\n\n'),
    };
    const role = (mode: 'stable' | 'context') => createRolePrompt('worker', testCase.task, decision, undefined, undefined, 'kodax/role/worker', undefined, context, undefined, false, mode);
    let captured: CapturedInput | undefined;
    const adapter = buildRunnerLlmAdapter({ provider: 'zhipu-coding', context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off' }, events: {} }, async (messages, tools, system) => {
      if (captured) throw new Error('Unexpected repeated adapter call');
      captured = JSON.parse(JSON.stringify({ messages, tools, system })) as CapturedInput;
      return { textBlocks: [{ text: 'capture complete' }], toolBlocks: [] };
    });
    await adapter([
      { role: 'system', content: role('stable') },
      { role: 'user', content: role('context'), _synthetic: true },
      ...testCase.priorMessages,
      { role: 'user', content: testCase.task },
    ], chain.worker);
    if (!captured) throw new Error('Adapter did not capture');
    cases.push({ ...testCase, input: captured, hash: hash(captured), metrics: { system: metric(captured.system), messages: metric(captured.messages), tools: metric(captured.tools), toolCount: captured.tools.length } });
  }
  const content = {
    revision: 'first-turn-v1', source, stage,
    sourceHashes: Object.fromEntries(await Promise.all([
      'packages/coding/src/agents/worker-role-prompt.ts',
      'packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts',
      'packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts',
      'packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts',
      'packages/coding/src/agent-runtime/tool-resolution.ts',
      'packages/coding/src/tools/tool-definitions.ts',
      'packages/coding/src/prompts/builder.ts',
    ].map(async file => [file, createHash('sha256').update(await fs.readFile(new URL(`../${file}`, import.meta.url))).digest('hex')]))),
    methodology: 'Zero network; actual production SA component builders and managed Worker adapter overrideStream boundary. Empty deterministic isolated home/non-Git workspace. All production tool descriptions and schema, no stubs. No optional hosts/AGENTS/skills/MCP/history/permission suffix/preturn. Synthetic controlled histories, not real compaction. Provider HTTP serialization is a separate capture. No tool execution.',
    sa: { system: snapshot.rendered, tools: saTools, hash: hash({ system: snapshot.rendered, tools: saTools }) },
    cases,
  };
  const directory = path.join(os.tmpdir(), 'kodax-eval-dumps', 'first-turn-tokens-v1');
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, `${stage}-inputs.json`);
  await fs.writeFile(output, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ output, source, stage, hash: hash(content), cases: cases.map(c => ({ id: c.id, hash: c.hash, metrics: c.metrics })) }, null, 2) + '\n');
} finally { setAgentConfigHome(undefined); }
