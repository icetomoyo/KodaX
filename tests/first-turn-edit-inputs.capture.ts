// Zero-network capture; manual freeze: KODAX_EDIT_CAPTURE_STAGE=baseline|candidate.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { buildSystemPromptSnapshot } from '../packages/coding/src/prompts/builder.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.js';
import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import type { FirstTurnCase } from '../benchmark/datasets/first-turn-tokens/cases.js';
import { inputHash, type FrozenInput, type FrozenCapture } from './first-turn-eval-support.js';
import { writeEditEvidence } from './first-turn-edit-artifacts.js';

export const EDIT_REVISION = 'first-turn-edit-v2';
export const editDumpRoot = () => path.join(os.tmpdir(), 'kodax-eval-dumps', EDIT_REVISION);
export const editFixtureRoot = () => process.env.KODAX_EDIT_FIXTURE_ROOT ?? path.join(os.tmpdir(), 'kodax-first-turn-edit-v2-fixture');
export const EDIT_CASES: readonly FirstTurnCase[] = [
  {
    id: 'batch_edit', phase: 'pilot',
    task: '根据刚读取的 src/math.ts，把 add 改为加法、multiply 改为乘法，保留两个现有注释和格式。两个修改互不影响，文件没有其他改动；直接精确修改，不需要重复读取或创建计划。此轮只提出编辑调用，执行和验证在后续轮次进行，不要声称已经完成。',
    priorMessages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read_math', name: 'read', input: { path: 'src/math.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_math', content: '1: // Preserve addition policy.\n2: export function add(a, b) { return a - b; }\n3: // Preserve multiplication policy.\n4: export function multiply(a, b) { return a + b; }' }] },
    ],
    rubric: 'Select precise edits for both known bugs, preserving comments/format/unrelated text. Compare actual structured tool calls and edit targets, including lawful legacy calls. A call proposal is not execution evidence. No whole-file rewrite, fabricated verification, duplicate plan or unnecessary read. Batching/bytes are diagnostic; judge correctness and user value.',
  },
  {
    id: 'concrete_plan', phase: 'pilot',
    task: '为缓存到期边界修复先建立具体可执行的计划，然后继续实施。已确认 src/cache.ts 使用 now > expiresAt，需求是到期瞬间也失效；tests/cache.test.ts 缺少相等边界测试。范围只有这两个文件，不需要先决定范围。计划要明确改哪个比较、补哪种边界断言、运行哪个测试以及何时核对结果，不能只有“调查、实现、测试”等泛称。现在先提交计划，不要把未执行的编辑或验证记成完成。',
    priorMessages: [],
    rubric: 'A concrete tracked plan preserves now===expiresAt semantics, names src/cache.ts and tests/cache.test.ts, specifies the regression assertion and appropriate test command, and keeps unperformed work pending. Compare useful specificity/clarity and execution honesty; lawful recon-first is not automatically failure. No invented completed work or unrelated scope.',
  },
];

export async function captureEditInputs(fixture: string, stage: 'baseline' | 'candidate'): Promise<FrozenCapture & { revision: string; sourceHashes: Record<string, string> }> {
  const workspace = path.join(fixture, 'workspace');
  const home = path.join(fixture, 'home');
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(home, { recursive: true });
  if ((await fs.readdir(workspace)).length || (await fs.readdir(home)).length) throw new Error('Capture fixture must be empty');
  setAgentConfigHome(home);
  try {
    const snapshot = await buildSystemPromptSnapshot({ provider: 'zhipu-coding', context: { executionCwd: workspace, gitRoot: workspace } }, true);
    const owned = new Set(['base-system', 'base-system-suffix', 'environment-context', 'runtime-fact', 'working-directory', 'session-scratch-directory', 'repo-intelligence-context', 'execution-guidance', 'active-skill-invocation']);
    const stableIds = new Set(['project-agents', 'self-knowledge-routing', 'memory-rules', 'tool-construction']);
    const shared = snapshot.sections.filter(section => !owned.has(section.id));
    const chain = buildRunnerAgentChain({ backups: new Map(), executionCwd: workspace, gitRoot: workspace });
    const cases = [];
    for (const testCase of EDIT_CASES) {
      const decision = buildFallbackRoutingDecision(testCase.task);
      const context = { originalTask: testCase.task, availableToolNames: (chain.worker.tools ?? []).map(tool => tool.name), workspace: { executionCwd: workspace, gitRoot: workspace, platform: process.platform },
        stableCapabilityContextBlock: shared.filter(section => stableIds.has(section.id)).map(section => section.content).join('\n\n'),
        capabilityContextBlock: shared.filter(section => !stableIds.has(section.id)).map(section => section.content).join('\n\n') };
      const role = (mode: 'stable' | 'context') => createRolePrompt('worker', testCase.task, decision, undefined, undefined, 'kodax/role/worker', undefined, context, undefined, false, mode);
      let captured: FrozenInput | undefined;
      const adapter = buildRunnerLlmAdapter({ provider: 'zhipu-coding', context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off' }, events: {} }, async (messages, tools, system) => {
        if (captured) throw new Error('Capture must use one adapter response');
        captured = JSON.parse(JSON.stringify({ messages, tools, system })) as FrozenInput;
        return { textBlocks: [{ text: 'capture only' }], toolBlocks: [] };
      });
      await adapter([{ role: 'system', content: role('stable') }, { role: 'user', content: role('context'), _synthetic: true }, ...testCase.priorMessages, { role: 'user', content: testCase.task }], chain.worker);
      if (!captured) throw new Error('Adapter did not capture');
      cases.push({ ...testCase, input: captured, hash: inputHash(captured) });
    }
    const stableFiles = ['packages/coding/src/agents/worker-role-prompt.ts', 'packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts', 'packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts', 'packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts', 'packages/coding/src/agent-runtime/tool-resolution.ts', 'packages/coding/src/tools/tool-definitions.ts', 'packages/coding/src/prompts/builder.ts', 'packages/coding/src/tools/model-tool-definition.ts', 'packages/coding/src/tools/edit.ts', 'packages/coding/src/tools/multi-edit.ts', 'packages/coding/src/tools/changed-diff.ts', 'src/sdk-runtime.ts'];
    const baselineSource = stage === 'candidate'
      ? (JSON.parse(await fs.readFile(path.join(editDumpRoot(), 'baseline-inputs.json'), 'utf8')) as FrozenCapture).source
      : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    const changed = execFileSync('git', ['diff', '--name-only', baselineSource, '--', 'src', 'packages'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src', 'packages'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    const files = [...new Set([...stableFiles, ...changed, ...untracked].filter(file => /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !/\.(?:test|spec)\./.test(file)))].sort();
    const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(new URL(`../${file}`, import.meta.url))).digest('hex')])));
    return { revision: EDIT_REVISION, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), stage, sourceHashes, cases };
  } finally { setAgentConfigHome(undefined); }
}

export async function assertEditSourcesCurrent(capture: FrozenCapture & { sourceHashes?: Record<string, string> }): Promise<void> {
  const hashes = (capture as FrozenCapture & { sourceHashes: Record<string, string> }).sourceHashes;
  if (!hashes || typeof hashes !== 'object') throw new Error('Candidate source hashes missing');
  for (const [file, expected] of Object.entries(hashes)) {
    if (!/^(?:src|packages)\//.test(file) || file.split('/').includes('..')) throw new Error('Invalid frozen source path');
    if (createHash('sha256').update(await fs.readFile(new URL(`../${file}`, import.meta.url))).digest('hex') !== expected) throw new Error(`Production source changed after candidate freeze: ${file}`);
  }
}

const stage = process.env.KODAX_EDIT_CAPTURE_STAGE;
if (stage !== undefined) {
  if (stage !== 'baseline' && stage !== 'candidate') throw new Error('Unknown capture stage');
  const capture = await captureEditInputs(editFixtureRoot(), stage);
  const directory = editDumpRoot();
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, `${stage}-inputs.json`);
  await writeEditEvidence(output, JSON.stringify(capture, null, 2) + '\n', true);
  process.stdout.write(JSON.stringify({ output, hash: inputHash(capture), source: capture.source, cases: capture.cases.map(row => ({ id: row.id, hash: row.hash, tools: row.input.tools.length })) }) + '\n');
}
