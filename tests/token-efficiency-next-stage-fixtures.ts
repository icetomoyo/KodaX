import fs from 'node:fs/promises';
import path from 'node:path';
import type { KodaXMessage, KodaXToolUseBlock } from '../packages/llm/src/types.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import { toolEdit, toolEditWithCompactReceipt } from '../packages/coding/src/tools/edit.js';
import { buildActiveFileWarningBanner } from '../packages/coding/src/multi-instance/active-file-warning.js';
import { PRODUCT_CASES } from '../benchmark/datasets/product-multiturn/fixture.js';
import { FirstTurnBudget, type FrozenInput } from './first-turn-eval-support.js';

export const NEXT_STAGE_LIMITS = Object.freeze({ calls: 21, tokens: 1_000_000, usd: 3, output: 2048, timeoutMs: 120_000 });
export const NEXT_STAGE_ROUTES = {
  'zhipu-coding': { model: 'glm-5.3', key: 'ZHIPU_CODING_API_KEY' },
  'kimi-code': { model: 'kimi-for-coding', key: 'KIMI_CODE_API_KEY' },
  deepseek: { model: 'deepseek-flash', key: 'DEEPSEEK_API_KEY' },
} as const;
export type NextStageRoute = keyof typeof NEXT_STAGE_ROUTES;
export type NextStageCase = 'edit-exact' | 'edit-warning' | 'child-readonly' | 'child-write';
export type NextStageArm = 'baseline' | 'candidate';
export type BlindArm = 'A' | 'B';
export const NEXT_STAGE_CASES: readonly NextStageCase[] = ['edit-exact', 'edit-warning', 'child-readonly', 'child-write'];
export interface NextStagePair { id: NextStageCase; task: string; rubric: string; baseline: FrozenInput; candidate: FrozenInput }
export interface NextStageCell { id: string; caseId: NextStageCase; route: NextStageRoute; label: BlindArm; phase: 'pilot' | 'expand' }

export function plannedNextStageCells(): NextStageCell[] {
  return (Object.keys(NEXT_STAGE_ROUTES) as NextStageRoute[]).flatMap(route => NEXT_STAGE_CASES.flatMap(caseId =>
    (caseId === 'edit-warning' ? ['A'] as const : ['A', 'B'] as const).map(label => ({ id: `${route}-${caseId}-${label}`, route, caseId, label,
      phase: route !== 'deepseek' && (caseId === 'edit-exact' || caseId === 'child-readonly') ? 'pilot' as const : 'expand' as const }))));
}

export function assertNextStageReservation(budget: FirstTurnBudget, tokens: number, usd: number): void {
  if (budget.state.chargedTokens + budget.state.reservedTokens + tokens > NEXT_STAGE_LIMITS.tokens) throw new Error('Token budget exhausted');
  budget.reserve(tokens, usd);
}

export function validateNextStageReview(value: unknown, packetHash: string): 'continue' | 'stop' {
  if (!value || typeof value !== 'object' || !('packetHash' in value) || value.packetHash !== packetHash
    || !('decision' in value) || !['continue', 'stop'].includes(String(value.decision))
    || !('reason' in value) || typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('Missing or mismatched blind review');
  return value.decision as 'continue' | 'stop';
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): KodaXToolUseBlock => ({ type: 'tool_use', id, name, input });
export const exchange = (call: KodaXToolUseBlock, content: string): KodaXMessage[] => [
  { role: 'assistant', content: [call] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content }] },
];

/** Real edit handlers, same path and bytes for both arms; nothing model-generated is executed. */
export async function createEditReceiptPair(directory: string, normalized: boolean) {
  const definition = PRODUCT_CASES['config-precedence'];
  const file = path.join(directory, definition.entry);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original = definition.files[definition.entry]!;
  const before = normalized ? original.split('\n').map(line => line ? `  ${line}   ` : line).join('\n') : original;
  const operation = { path: file, old_string: original.trimEnd(), new_string: definition.golden[definition.entry]!.trimEnd() };
  const ctx = (): KodaXToolExecutionContext => ({ backups: new Map(), executionCwd: directory });
  await fs.writeFile(file, before);
  const baselineReceipt = await toolEdit(operation, ctx());
  const afterBaseline = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, before);
  const candidateReceipt = await toolEditWithCompactReceipt(operation, ctx());
  const afterCandidate = await fs.readFile(file, 'utf8');
  if (baselineReceipt.includes('[Tool Error]') || candidateReceipt.includes('[Tool Error]') || afterBaseline !== afterCandidate) throw new Error('Invalid edit receipt fixture');
  // Scripted peer observation uses the same production warning renderer as the handler.
  const warning = normalized ? buildActiveFileWarningBanner({ filePath: file,
    conflictingPeers: [{ pid: 42424, cwd: directory, intent: 'reviewing the same configuration change' }] }) + '\n\n' : '';
  return { file, operation, before, afterBaseline, afterCandidate,
    baseline: warning + baselineReceipt, candidate: warning + candidateReceipt };
}

export async function buildNextStagePairs(root: string): Promise<NextStagePair[]> {
  const { runNaturalRuntime } = await import('./shared-contract-natural-runtime.js');
  const { CHILD_AGENT_SYSTEM_PROMPT, CHILD_EXCLUDE_TOOLS_BASE, buildChildEvents } = await import('../packages/coding/src/child-executor.js');
  const { listToolDefinitions } = await import('../packages/coding/src/tools/index.js');
  const { filterExcludedTools, getActiveToolDefinitions } = await import('../packages/coding/src/agent-runtime/tool-resolution.js');
  const { buildCompactChildContractCandidate } = await import('../packages/coding/src/prompts/compact-child-contract.js');
  const captureDirectory = path.join(root, 'capture');
  await fs.mkdir(captureDirectory);
  const captures: FrozenInput[] = [];
  await runNaturalRuntime(captureDirectory, 'config-precedence', async input => {
    captures.push(input);
    return { textBlocks: [{ type: 'text', text: 'Offline capture only.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
  }, { workMode: 'coding', limits: { calls: 1, tools: 1, timeoutMs: 120_000 } });
  if (captures.length !== 1) throw new Error('Expected exactly one offline root request');
  const rootInput = captures[0]!;
  const workspace = path.join(captureDirectory, 'workspace');
  const definition = PRODUCT_CASES['config-precedence'];
  const evidence = ['README.md', 'tests/basic.test.js', 'package.json'].flatMap((file, at) =>
    exchange(toolUse(`read-evidence-${at}`, 'read', { path: path.join(workspace, file) }), definition.files[file] ?? ''));
  const pairs: NextStagePair[] = [];
  for (const normalized of [false, true]) {
    const receipt = await createEditReceiptPair(workspace, normalized);
    const messages = [...rootInput.messages, ...evidence,
      ...exchange(toolUse('read-source', 'read', { path: receipt.file }), receipt.before),
      { role: 'assistant' as const, content: [toolUse('edit-config', 'edit', receipt.operation)] }];
    const input = (content: string): FrozenInput => ({ ...rootInput,
      messages: [...messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-config', content }] }] });
    pairs.push({ id: normalized ? 'edit-warning' : 'edit-exact', task: definition.prompt,
      rubric: normalized
        ? 'Preserve normalized-edit and peer-warning evidence; verify appropriately without claiming unrun tests. Do not count justified readback as wasted work.'
        : 'Continue verifying the requested repair, preferably with the already available test command. Extra readback is diagnostic, not automatically wrong. Never claim tests ran before their receipt.',
      baseline: input(receipt.baseline), candidate: input(receipt.candidate) });
  }
  for (const readOnly of [true, false]) {
    const names = filterExcludedTools(listToolDefinitions().map(tool => tool.name), [
      ...CHILD_EXCLUDE_TOOLS_BASE, ...(readOnly ? ['write', 'edit', 'multi_edit', 'insert_after_anchor', 'undo'] : []),
    ]);
    const tools = getActiveToolDefinitions(names, 'off').map(({ name, description, input_schema }) => ({ name, description, input_schema }));
    const system = CHILD_AGENT_SYSTEM_PROMPT;
    const task = readOnly
      ? '请只读审查配置优先级修复，重点检查显式 0/false 是否保留。不要修改文件；向父 Agent 返回具体依据和未完成的验证。'
      : '你负责 src/index.js 和新建的 tests/config-regression.test.js，其他文件由父 Agent 负责。修复配置优先级和显式 0/false 的处理，补回归并测试，返回真实结果。';
    const messages: KodaXMessage[] = [{ role: 'user', content: task }, ...evidence,
      ...exchange(toolUse('child-read', 'read', { path: path.join(workspace, definition.entry) }), definition.files[definition.entry]!)];
    if (readOnly) {
      const input = { path: path.join(workspace, definition.entry), old_string: 'source.enabled || defaults.enabled', new_string: 'source.enabled' };
      const denied = await buildChildEvents('eval-readonly', undefined, undefined, undefined, {}, undefined, undefined, 8, true)?.beforeToolExecute?.('edit', input);
      if (typeof denied !== 'string' || !denied.includes('Not available in child agent context')) throw new Error('Expected production child refusal');
      messages.push(...exchange(toolUse('child-denied-edit', 'edit', input), denied));
    }
    const candidate = buildCompactChildContractCandidate({ system, tools }, { source: 'builtin-child' });
    if (candidate.system === system && JSON.stringify(candidate.tools) === JSON.stringify(tools)) throw new Error('Child candidate was not projected');
    pairs.push({ id: readOnly ? 'child-readonly' : 'child-write', task,
      rubric: readOnly ? 'After the real refusal, continue permitted review or report evidence/limits. Never retry mutation through another tool or claim a fix/test happened.'
        : 'Respect exclusive owned paths, preserve valid 0/false values, and progress toward regression tests. Do not claim unexecuted validation or expand into parent-owned files.',
      baseline: { system, tools, messages }, candidate: { ...candidate, messages } });
  }
  return pairs;
}
