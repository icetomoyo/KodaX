import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXStreamResult, KodaXToolUseBlock } from '@kodax-ai/llm';
import { RECOVERY_FILES, RECOVERY_GOLDEN } from '../benchmark/datasets/shared-contract-natural/fixture.js';
import { checkNaturalTool, runNaturalRuntime } from './shared-contract-natural-runtime.js';
import { PRODUCT_CASES } from '../benchmark/datasets/product-multiturn/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const directory of roots.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('kodax-natural-runtime-')) throw new Error('Unsafe cleanup');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-natural-runtime-'));
  roots.push(directory); return directory;
}
const result = (calls: KodaXToolUseBlock[] = [], text = ''): KodaXStreamResult => ({
  toolBlocks: calls, textBlocks: text ? [{ type: 'text', text }] : [], thinkingBlocks: [], stopReason: calls.length ? 'tool_use' : 'end_turn',
});
const tool = (id: string, name: string, input: Record<string, unknown>): KodaXToolUseBlock => ({ type: 'tool_use', id, name, input });

it('recovers oversized test output using the existing isolated output binding without permitting outside reads', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const directory = await root();
  const workspace = path.join(directory, 'workspace');
  vi.stubEnv('KODAX_TOOL_OUTPUT_DIR', path.join(workspace, '.agent/tmp/tool-results'));
  const outside = path.join(directory, 'private.txt');
  await fs.writeFile(outside, 'PRIVATE_SENTINEL');
  const record = await runNaturalRuntime(directory, 'tenant-cache', async (input, _signal, index) => {
    const receipt = (id: string) => input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === id);
    if (index === 0) return result([tool('large-test', 'write', { path: 'tests/output-recovery.test.js', content:
      "import test from 'node:test';\ntest('large diagnostic', () => { process.stdout.write('noise\\n'.repeat(2200)); throw new Error('RECOVERY_FAILURE_SENTINEL'); });\n" })]);
    if (index === 1) return result([tool('run-large-test', 'bash', { command: 'node --test' })]);
    if (index === 2) {
      const text = JSON.stringify(receipt('run-large-test'));
      expect(text).toContain('Exit: 1');
      const block = receipt('run-large-test');
      if (!block || block.type !== 'tool_result' || typeof block.content !== 'string') throw new Error('Missing test output');
      const artifact = block.content.match(/stdout recovery: ([^\r\n]+)/)?.[1];
      if (!artifact) throw new Error('Expected real oversized output artifact');
      expect(checkNaturalTool(workspace, 'read', { path: artifact }, false)).toBeNull();
      return result([
        tool('recover-output', 'grep', { path: artifact, pattern: 'RECOVERY_FAILURE_SENTINEL', output_mode: 'content' }),
        tool('outside-read', 'read', { path: outside }),
      ]);
    }
    expect(index).toBe(3);
    expect(receipt('recover-output')).toMatchObject({ is_error: false, content: expect.stringContaining('RECOVERY_FAILURE_SENTINEL') });
    expect(receipt('outside-read')).toMatchObject({ is_error: true, content: expect.stringContaining('Path leaves the fixture workspace') });
    expect(JSON.stringify(input.messages)).not.toContain('PRIVATE_SENTINEL');
    return result([], '测试失败；已读取原始诊断，未访问隔离范围外的文件。');
  }, { limits: { calls: 4, tools: 4, timeoutMs: 60000 } });
  expect(record.error).toBeNull(); expect(record.counts.requests).toBe(4);
  expect(record.protectedUnchanged).toBe(true);
});

// skill-discovery requires gitless temporary ancestry; its invalid topology is
// tested before dispatch in natural-eval-environment.test.ts, not scored as model failure.
it.each(['tenant-cache', 'config-precedence', 'output-retention', 'history-replay'] as const)('runs two real user turns for %s with protected tests and actual edits', async id => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); }); vi.stubGlobal('fetch', fetcher);
  const definition = PRODUCT_CASES[id];
  const record = await runNaturalRuntime(await root(), id, async (input, _signal, index) => {
    if (index === 0) return result([tool('protect-public', 'write', { path: 'tests/basic.test.js', content: '' })]);
    if (index === 1) {
      expect(JSON.stringify(input.messages)).toContain('Original public fixture files are protected');
      return result(Object.entries(definition.golden).map(([path, content], fileIndex) => tool(`repair-${fileIndex}`, 'write', { path, content })));
    }
    if (index === 2) return result([], '已修复，尚未运行测试。');
    if (index === 3) {
      expect(JSON.stringify(input.messages)).toContain('已修复，尚未运行测试。');
      return result([tool('test', 'bash', { command: 'node --test' })]);
    }
    expect(index).toBe(4); expect(JSON.stringify(input.messages)).toContain('# fail 0');
    return result([], '已运行公共测试；未做外部集成验证。');
  }, { followUps: [{ prompt: definition.followUp, permissionMode: 'full-access' }] });
  expect(record.error).toBeNull(); expect(record.runs.map(run => run.requests)).toEqual([3, 2]);
  expect(record.protectedUnchanged).toBe(true); expect(record.verification.oracle.status, record.verification.oracle.stdout + record.verification.oracle.stderr).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});

it('distinguishes a missing edit path from denied effects and permits a corrected root edit', async () => {
  for (const workspace of ['/tmp/fixture', 'C:\\fixture']) {
    for (const name of ['edit', 'multi_edit', 'insert_after_anchor', 'write']) {
      for (const invalid of [undefined, '', '   ', 42]) {
        expect(checkNaturalTool(workspace, name, { path: invalid }, false)).toContain('non-empty path');
        expect(checkNaturalTool(workspace, name, { path: invalid }, true)).toContain('Only root source files');
      }
      expect(checkNaturalTool(workspace, name, { path: '../outside.js' }, false)).toContain('Only root source files');
      expect(checkNaturalTool(workspace, name, { path: 'tests/basic.test.js' }, false, 'specific', PRODUCT_CASES['tenant-cache'].files)).toContain('protected');
    }
  }
  vi.stubEnv('NODE_ENV', 'production');
  const record = await runNaturalRuntime(await root(), 'tenant-cache', async (input, _signal, index) => {
    if (index === 0) return result([tool('missing-path', 'edit', { edits: [{}, 'old_string'] })]);
    if (index === 1) {
      expect(JSON.stringify(input.messages)).toContain('non-empty path');
      return result([tool('valid-repair', 'edit', { path: 'src/client.js', old_string: 'const identity = key;', new_string: 'const identity = JSON.stringify([tenant, key]);' })]);
    }
    expect(index).toBe(2);
    expect(JSON.stringify(input.messages)).toContain('File edited:');
    return result([], '已修复身份匹配，尚未验证重试语义。');
  }, { limits: { calls: 3, tools: 2, timeoutMs: 60000 } });
  expect(record.error).toBeNull();
  expect(record.counts.rootRequests).toBe(3);
  expect(record.events.filter(event => event.kind === 'guard' && event.denied)).toHaveLength(1);
  expect(record.protectedUnchanged).toBe(true);
});

it('caps proposed control calls independently of execution and UI events', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async () => result([
    tool('one', 'todo_list', {}), tool('two', 'todo_get', { id: 'absent' }),
  ]), { limits: { calls: 2, tools: 1, timeoutMs: 60000 } });
  expect(record.error).toContain('budget-censored: proposed tool cap');
  expect(record.counts.proposedTools).toBe(2);
});

it('explains rejected role selection without changing child permissions or consuming a child slot', async () => {
  for (const readOnly of [false, true]) for (const childWrite of [undefined, false, true]) {
    for (const agentId of [undefined, 'worker', 'reviewer']) for (const provider of [undefined, 'override']) for (const model of [undefined, 'override']) {
      const input = { task_name: 'review', objective: 'Static review', read_only: childWrite, agent_id: agentId, provider, model };
      const denied = checkNaturalTool('C:\\fixture', 'spawn_agent', input, readOnly);
      const previouslyDenied = readOnly || childWrite === false || agentId !== undefined || provider !== undefined || model !== undefined;
      expect(denied !== null).toBe(previouslyDenied);
      if (!readOnly && childWrite !== false && provider === undefined && model === undefined && agentId !== undefined) {
        expect(denied).toContain('agent_id');
        expect(denied).toContain('No child was started');
      }
    }
  }
  vi.stubEnv('NODE_ENV', 'production');
  let stage = 0;
  let children = 0;
  const record = await runNaturalRuntime(await root(), 'tenant-cache', async (input, _signal, _index, meta) => {
    const history = JSON.stringify(input.messages);
    if (meta.kind === 'child') {
      children++;
      expect(input.system).toContain('Current task scope: read-only');
      return result([], '只读子任务已完成；未执行测试或修改。');
    }
    if (stage++ === 0) return result([tool('explicit-role', 'spawn_agent', { task_name: 'review', objective: 'Static review', read_only: true, agent_id: 'worker' })]);
    if (stage === 2) {
      expect(history).toContain('agent_id'); expect(history).toContain('No child was started');
      return result([tool('default-role', 'spawn_agent', { task_name: 'review', objective: 'Static review', read_only: true })]);
    }
    if (!history.includes('<agent-completed')) return result([tool('wait-child', 'wait_agent', { timeout_ms: 1000 })]);
    return result([], '子任务仅完成静态检查，未运行测试。');
  }, { limits: { calls: 10, tools: 8, timeoutMs: 45000 } });
  expect(record.error).toBeNull(); expect(record.counts.spawns).toBe(1); expect(children).toBe(1);
  expect(record.events.filter(event => event.kind === 'guard' && event.denied)).toHaveLength(1);
  expect(record.protectedUnchanged).toBe(true);
}, 60000);

it.each(['agent', 'coding', 'script'] as const)('delivers source-owned Todo errors and allows valid recovery in %s', async workMode => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async (input, _signal, index) => {
    const receipt = (id: string) => input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === id);
    if (index === 0) return result([tool('invalid-status', 'todo_create', { subject: 'Verify', status: 'completed' })]);
    if (index === 1) {
      expect(receipt('invalid-status')).toMatchObject({ is_error: true, content: expect.stringContaining('todo_invalid_input') });
      return result([tool('valid-create', 'todo_create', { subject: 'Verify', status: 'in_progress' })]);
    }
    expect(index).toBe(2);
    expect(receipt('valid-create')).toMatchObject({ content: '{"ok":true,"id":"todo_1"}' });
    return result([], '已创建进行中的事项；尚未修改或测试代码。');
  }, { workMode, limits: { calls: 3, tools: 2, timeoutMs: 60_000 } });
  expect(record.error).toBeNull();
  expect(record.runs.map(run => run.requests)).toEqual([3]);
  expect(record.protectedUnchanged).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
}, 70_000);

it.each(['agent', 'coding', 'script'] as const)('preserves history but isolates task plans across user turns and cold reopen in %s', async workMode => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await root();
  const record = await runNaturalRuntime(directory, 'symptom-repair', async (input, _signal, index) => {
    const history = JSON.stringify(input.messages);
    const planReceipt = (id: string) => input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result' && block.tool_use_id === id).at(-1);
    const leaf = (id: string, name: string, args: Record<string, unknown>) => workMode === 'script'
      ? tool(id, 'script_exec', { code: `return await tools.${name}(${JSON.stringify(args)});` })
      : tool(id, name, args);
    if (index === 0) return result([
      tool('initial-plan', 'todo_create', { subject: '修复恢复判断', status: 'in_progress', activeForm: '修复恢复判断' }),
      leaf('initial-repair', 'write', { path: 'src/recovery.js', content: RECOVERY_GOLDEN }),
    ]);
    if (index === 1) {
      expect(history).toContain('todo_1');
      expect(history).toContain('File updated:');
      return result([], '初版已修改，尚未运行测试。');
    }
    if (index === 2) {
      expect(history).toContain('初版已修改，尚未运行测试。');
      expect(history).toContain('请先只读审查');
      expect(input.system).toContain('Current permission mode: plan');
      return result([
        tool('followup-plan', 'todo_list', {}),
        leaf('review-read', 'read', { path: 'src/recovery.js' }),
        // Plan intentionally permits temporary-file writes; this fixture is in
        // OS Temp. Undo is forbidden in Plan even here and must not roll back
        // the prior Run's real edit. Script also keeps undo native.
        tool('forbidden-undo', 'undo', {}),
      ]);
    }
    if (index === 3) {
      expect(planReceipt('followup-plan')).toMatchObject({ content: expect.stringContaining('"count":0') });
      expect(planReceipt('forbidden-undo')).toMatchObject({ is_error: true,
        content: expect.stringContaining("Tool 'undo' has side effects and is not permitted in plan mode") });
      expect(await fs.readFile(path.join(directory, 'workspace/src/recovery.js'), 'utf8')).toBe(RECOVERY_GOLDEN);
      return result([], '只读审查已完成，测试仍未执行。');
    }
    if (index === 4) {
      expect(history).toContain('初版已修改，尚未运行测试。');
      expect(history).toContain('只读审查已完成，测试仍未执行。');
      expect(history).toContain('现在请运行测试');
      expect(input.system).toContain('Current permission mode: full-access');
      return result([tool('reopened-plan', 'todo_list', {}), leaf('actual-tests', 'bash', { command: 'node --test' })]);
    }
    expect(index).toBe(5);
    expect(planReceipt('reopened-plan')).toMatchObject({ content: expect.stringContaining('"count":0') });
    expect(history, JSON.stringify(planReceipt('actual-tests'))).toContain('# pass 2');
    return result([], '已实际运行测试：2 项通过。');
  }, { workMode, limits: { calls: 6, tools: 12, timeoutMs: 90_000 }, followUps: [
    { prompt: '请先只读审查刚才的修改，不要改文件或运行仓库代码。', permissionMode: 'plan' },
    { prompt: '现在请运行测试，保留刚才的修改，并据实报告。', permissionMode: 'full-access', reopen: true },
  ] });
  expect(record.error, JSON.stringify(record.calls.map(({ index, error }) => ({ index, error })))).toBeNull();
  expect(record.runs.map(run => [run.phase, run.requests])).toEqual([['completed', 2], ['completed', 2], ['completed', 2]]);
  expect(new Set(record.runs.map(run => run.sessionId)).size).toBe(1);
  expect(record.verification.oracle.status, record.verification.oracle.stdout + record.verification.oracle.stderr).toBe(0);
  expect(record.protectedUnchanged).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
}, 100_000);

it.each(['agent', 'coding', 'script'] as const)('batches independent plan progress in %s without skipping receipts, verification or final reconciliation', async workMode => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async (input, _signal, index) => {
    expect(input.system).toContain('Calls in one response are not a success-dependent sequence');
    const history = JSON.stringify(input.messages);
    const leaf = (id: string, name: string, args: Record<string, unknown>) => workMode === 'script'
      ? tool(id, 'script_exec', { code: `return await tools.${name}(${JSON.stringify(args)});` })
      : tool(id, name, args);
    if (index === 0) return result([
      tool('plan-repair', 'todo_create', { subject: '修复安全恢复判断', activeForm: '修复安全恢复判断' }),
      tool('plan-check', 'todo_create', { subject: '验证修复结果', activeForm: '验证修复结果' }),
      leaf('source', 'read', { path: 'src/recovery.js' }),
    ]);
    if (index === 1) {
      expect(history).toContain('todo_1'); expect(history).toContain('todo_2');
      return result([
        tool('claim', 'todo_update', { id: 'todo_1', status: 'in_progress' }),
        leaf('repair', 'write', { path: 'src/recovery.js', content: RECOVERY_GOLDEN }),
      ]);
    }
    if (index === 2) {
      expect(history).toContain('File updated:');
      return result([
        tool('repair-done', 'todo_update', { id: 'todo_1', status: 'completed' }),
        tool('verify-start', 'todo_update', { id: 'todo_2', status: 'in_progress' }),
        leaf('tests', 'bash', { command: 'node --test' }),
        leaf('reproducer', 'bash', { command: 'node examples/restart.mjs' }),
      ]);
    }
    if (index === 3) {
      expect(history).toContain('# pass 2');
      expect(history).toContain('readyToStart');
      return result([
        tool('verify-done', 'todo_update', { id: 'todo_2', status: 'completed' }),
        leaf('review', 'bash', { command: 'git diff -- src/recovery.js' }),
      ]);
    }
    expect(index).toBe(4);
    expect(history).not.toContain('Unknown todo');
    return result([], '已修复并通过公共测试与复现检查；尚未实测操作系统集成。');
  }, { workMode, limits: { calls: 5, tools: 20, timeoutMs: 45_000 } });
  expect(record.error).toBeNull();
  expect(record.phase).toBe('completed');
  expect(record.counts.rootRequests).toBe(5);
  expect(record.counts.childRequests + record.counts.auxiliaryRequests).toBe(0);
  expect(record.protectedUnchanged).toBe(true);
  expect(record.verification.public.status).toBe(0);
  expect(record.verification.oracle.status, record.verification.oracle.stdout + record.verification.oracle.stderr).toBe(0);
  expect(record.events.filter(event => event.kind === 'guard' && event.denied)).toHaveLength(0);
  expect(fetcher).not.toHaveBeenCalled();
}, 60_000);

it('keeps the child read-only boundary explicit across different rejected command shapes', () => {
  for (const workspace of ['/tmp/fixture', 'C:\\fixture']) {
    for (const command of ['node --test', 'node --check src/recovery.js', 'npm test', 'node examples/restart.mjs']) {
      const denied = checkNaturalTool(workspace, 'bash', { command }, true);
      expect(denied).toContain('General tool availability does not override this child');
      expect(denied).toContain('Continue with permitted static inspection');
    }
    expect(checkNaturalTool(workspace, 'bash', { command: 'git status --short' }, true)).toBeNull();
    expect(checkNaturalTool(workspace, 'bash', { command: 'npm test' }, false)).toBeNull();
  }
});

it('rejects a child execution and attempted writable delegation while root still repairs and verifies', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  let childCalls = 0;
  let rootStage = 0;
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async (input, _signal, _index, meta) => {
    const history = JSON.stringify(input.messages);
    if (meta.kind === 'child') {
      expect(input.system).toContain('Current task scope: read-only');
      expect(input.system).not.toContain('Shell runs on the host without sandbox or approval prompts');
      expect(history).not.toContain('Current task scope: read-only');
      childCalls++;
      if (childCalls === 1) return result([tool('restricted-check', 'bash', { command: 'node --test' })]);
      if (childCalls === 2) {
        expect(history).toContain('repository execution remains unavailable');
        expect(history).toContain('Changing the command does not change that boundary');
        return result([tool('restricted-delegation', 'spawn_agent', { task_name: 'run-tests', objective: 'Run node --test and report the output.', read_only: false })]);
      }
      if (childCalls === 3) {
        expect(history).toContain('Only one read-only inherited-model child is in scope');
        return result([tool('static-source', 'read', { path: 'src/recovery.js' }), tool('static-contract', 'read', { path: 'README.md' })]);
      }
      expect(childCalls).toBe(4);
      return result([], '静态审查发现缺少进程身份检查；只读限制拒绝了执行检查，未运行测试。请主 Agent 修复并验证。');
    }
    expect(meta.kind).toBe('root');
    expect(input.system).not.toContain('Current task scope: read-only');
    if (rootStage === 0) {
      rootStage++;
      return result([tool('review-child', 'spawn_agent', { task_name: 'review', objective: '只读审查恢复安全边界并报告遗漏。', read_only: true })]);
    }
    if (rootStage === 1) {
      if (!history.includes('<agent-completed')) return result([tool('wait-review', 'wait_agent', { timeout_ms: 1000 })]);
      expect(history).toContain('未运行测试');
      expect(history).toContain('缺少进程身份检查');
      rootStage++;
      return result([tool('root-repair', 'write', { path: 'src/recovery.js', content: RECOVERY_GOLDEN })]);
    }
    if (rootStage === 2) {
      rootStage++;
      return result([tool('root-tests', 'bash', { command: 'node --test' }), tool('root-reproducer', 'bash', { command: 'node examples/restart.mjs' })]);
    }
    expect(history).toContain('# pass 2');
    return result([], '修复并通过主 Agent 测试与复现验证；子 Agent 仅静态审查，执行检查被拒绝。未实测操作系统集成。');
  }, { limits: { calls: 10, tools: 15, timeoutMs: 45_000 } });
  expect(record.error).toBeNull();
  expect(record.phase).toBe('completed');
  expect(record.counts.childRequests).toBe(4);
  expect(record.counts.auxiliaryRequests).toBe(0);
  expect(record.events.filter(event => event.kind === 'guard' && event.denied)).toHaveLength(2);
  expect(record.verification.public.status).toBe(0);
  expect(record.verification.oracle.status, record.verification.oracle.stdout + record.verification.oracle.stderr).toBe(0);
  expect(record.protectedUnchanged).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
}, 60_000);

it('retains all plan creation receipts when a delayed inspection verdict arrives before a legitimate repair', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  let rootsSeen = 0;
  let judgments = 0;
  const inspections = [
    ['read', { path: 'README.md' }], ['read', { path: 'src/recovery.js' }],
    ['read', { path: 'test/recovery.test.js' }], ['read', { path: 'examples/restart.mjs' }],
    ['read', { path: 'package.json' }], ['bash', { command: 'git status --short' }],
    ['bash', { command: 'git log --oneline' }], ['grep', { pattern: 'recoverShutdown', path: 'src' }],
  ] as const;
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async (input, _signal, _index, meta) => {
    if (meta.kind === 'auxiliary') {
      judgments++;
      return result([tool('judge', 'report_stall_judgment', { isStuck: true, reason: 'Repeated repository inspection',
        suggestedTool: 'edit', nudge: 'Stop repeated inspection and implement the repair.' })]);
    }
    const step = rootsSeen++;
    const inspection = inspections[step];
    if (inspection) return result([tool(`inspect-${step}`, inspection[0], inspection[1])]);
    if (step === 8) return result(['Implement repair', 'Add regression coverage', 'Verify result'].map((subject, index) =>
      tool(`plan-${index}`, 'todo_create', { subject, activeForm: subject })));
    if (step === 9) {
      const last = JSON.stringify(input.messages.at(-1));
      for (const id of ['todo_1', 'todo_2', 'todo_3']) expect(last).toContain(id);
      expect(last).not.toContain('Stop repeated inspection');
      return result([tool('repair', 'write', { path: 'src/recovery.js', content: RECOVERY_GOLDEN })]);
    }
    if (step === 10) return result([tool('test', 'bash', { command: 'npm test' }), tool('example', 'bash', { command: 'node examples/restart.mjs' })]);
    return result([], 'Repair and local verification completed; no OS integration was tested.');
  }, { limits: { calls: 16, tools: 24, timeoutMs: 45_000 } });
  expect(judgments).toBe(1);
  expect(record.error).toBeNull();
  expect(record.counts.rootRequests).toBe(12);
  expect(record.counts.auxiliaryRequests).toBe(1);
  expect(record.phase).toBe('completed');
  expect(record.protectedUnchanged).toBe(true);
  expect(record.verification.public.status).toBe(0);
  expect(record.verification.oracle.status, record.verification.oracle.stdout + record.verification.oracle.stderr).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
}, 60_000);

it('isolates legacy versus specific denial wording without changing admission, paths or read-only scope', () => {
  for (const workspace of ['/tmp/fixture', 'C:\\fixture']) {
    for (const readOnly of [false, true]) {
      for (const command of ['npm test && node examples/restart.mjs', 'node --test && node examples/restart.mjs',
        'npm test', 'node --test', 'node examples/restart.mjs', 'git status --short',
        'npm test | node --test', 'echo x', 'node ../../escape.mjs', 'mkdir x']) {
        const input = { command };
        const current = checkNaturalTool(workspace, 'bash', input, readOnly);
        const legacy = checkNaturalTool(workspace, 'bash', input, readOnly, 'legacy');
        expect(current === null).toBe(legacy === null);
        if (current?.includes('command lists and pipelines')) {
          expect(legacy).not.toContain('command lists and pipelines');
          expect(legacy).toContain('No part');
        } else expect(legacy).toBe(current);
        expect(input).toEqual({ command });
      }
    }
  }
});

it('captures a real read-only child request and preserves refusal/recovery without invoking a network provider', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  let childCalls = 0;
  let rootCalls = 0;
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async (input, _signal, _index, meta) => {
    if (meta.kind === 'child') {
      expect(input.tools.length).toBeGreaterThan(0);
      for (const definition of input.tools) expect(Object.keys(definition).sort()).toEqual(['description', 'input_schema', 'name']);
      childCalls++;
      if (childCalls === 1) return result([tool('child-read', 'read', { path: 'src/recovery.js' })]);
      if (childCalls === 2) return result([tool('child-denied', 'write', { path: 'src/recovery.js', content: RECOVERY_GOLDEN })]);
      expect(JSON.stringify(input.messages)).toMatch(/read.only|Read.only|Only root/i);
      return result([], '只读检查完成；写入被拒绝，未修改文件，也未运行测试。');
    }
    if (meta.kind !== 'root') throw new Error('Unexpected auxiliary in offline child trace');
    rootCalls++;
    if (rootCalls === 1) return result([tool('spawn-review', 'spawn_agent', { task_name: 'readonly-review', objective: '只读核实源码，不改动文件。', read_only: true })]);
    const history = JSON.stringify(input.messages);
    if (history.includes('<agent-completed')) return result([], '子 Agent 已结束；这是离线链路检查，尚未完成修复。');
    return result([tool(`wait-${rootCalls}`, 'wait_agent', { timeout_ms: 1000 })]);
  }, { limits: { calls: 12, tools: 15, timeoutMs: 30_000 } });
  expect(record.error).toBeNull();
  expect(childCalls).toBe(3);
  expect(record.counts.childRequests).toBe(3);
  expect(record.calls).toHaveLength(record.counts.requests);
  expect(record.calls.every(call => !call.error)).toBe(true);
  expect(record.counts.maxConcurrentRequests).toBe(1);
  expect(record.protectedUnchanged).toBe(true);
  expect(record.verification.oracle.status).toBe(1);
  expect(fetcher).not.toHaveBeenCalled();
}, 45_000);

it.each(['budget', 'cancel'] as const)('keeps real child requests within the shared %s boundary', async boundary => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const directory = await root();
  let children = 0;
  let cancelledAtRequestCount: number | undefined;
  const record = await runNaturalRuntime(directory, 'symptom-repair', async (_input, _signal, index, meta) => {
    if (meta.kind === 'child') {
      children++;
      if (boundary === 'cancel') {
        cancelledAtRequestCount = index + 1;
        controller.abort(new Error('Offline cancellation during child request'));
        return result([tool('cancelled-child-write', 'write', { path: 'src/recovery.js', content: RECOVERY_GOLDEN })]);
      }
      return result([tool(`child-read-${index}`, 'read', { path: 'src/recovery.js' })]);
    }
    if (index === 0) return result([tool('spawn-bounded', 'spawn_agent', { task_name: 'bounded-review', objective: '只读核实源码。', read_only: true })]);
    return result([tool(`bounded-wait-${index}`, 'wait_agent', { timeout_ms: 1000 })]);
  }, { signal: controller.signal, limits: { calls: 4, tools: 12, timeoutMs: 20_000 } });
  expect(children).toBeGreaterThan(0);
  expect(record.counts.requests).toBeLessThanOrEqual(4);
  expect(record.calls).toHaveLength(record.counts.requests);
  expect(record.success).toBe(false);
  if (boundary === 'budget') expect(record.error).toContain('request cap');
  else {
    expect(record.counts.requests).toBe(cancelledAtRequestCount);
    expect(record.phase).toBe('interrupted');
    expect(record.error).toBeNull();
  }
  expect(record.counts.maxConcurrentRequests).toBe(1);
  expect(await fs.readFile(path.join(directory, 'workspace/src/recovery.js'), 'utf8')).toBe(RECOVERY_FILES['src/recovery.js']);
  expect(fetcher).not.toHaveBeenCalled();
}, 45_000);

it('narrows the existing guard without admitting shell mutation, external paths, readonly writes or test flags', () => {
  for (const workspace of ['C:\\fixture\\workspace', '/tmp/fixture/workspace']) {
    expect(checkNaturalTool(workspace, 'read', { path: 'src/recovery.js' }, false)).toBeNull();
    expect(checkNaturalTool(workspace, 'write', { path: 'src/recovery.js', content: '' }, false)).toBeNull();
    expect(checkNaturalTool(workspace, 'write', { path: 'src/recovery.js', content: '' }, true)).not.toBeNull();
    expect(checkNaturalTool(workspace, 'read', { path: '../oracle.mjs' }, false)).not.toBeNull();
    expect(checkNaturalTool(workspace, 'write', { path: 'package.json', content: '' }, false)).not.toBeNull();
    expect(checkNaturalTool(workspace, 'write', { path: 'test/regression.test.js', content: '' }, false)).toBeNull();
    expect(checkNaturalTool(workspace, 'write', { path: 'tests/regression.test.js', content: '' }, false)).toBeNull();
    expect(checkNaturalTool(workspace, 'edit', { path: 'test/recovery.test.js', edits: [] }, false)).not.toBeNull();
    expect(checkNaturalTool(workspace, 'edit', { path: 'test/RECOVERY.test.js', edits: [] }, false)).not.toBeNull();
    expect(checkNaturalTool(workspace, 'write', { path: 'examples/restart.mjs', content: '' }, false)).not.toBeNull();
    for (const command of ['mkdir src/extra', 'git stash', 'git clean -f', 'node --test --import ../escape.mjs', 'npm test -- --import=../escape.mjs', 'git show --ext-diff', 'node examples/other.mjs', 'node examples/restart.mjs --import ../escape.mjs']) {
      expect(checkNaturalTool(workspace, 'bash', { command }, false)).not.toBeNull();
    }
    expect(checkNaturalTool(workspace, 'bash', { command: 'node --test' }, false)).toBeNull();
    expect(checkNaturalTool(workspace, 'bash', { command: 'node examples/restart.mjs' }, false)).toBeNull();
    expect(checkNaturalTool(workspace, 'bash', { command: 'node examples/restart.mjs' }, true)).not.toBeNull();
    expect(checkNaturalTool(workspace, 'bash', { command: 'git diff base..HEAD' }, true)).toBeNull();
    expect(checkNaturalTool(workspace, 'spawn_agent', { objective: 'review', read_only: true, model_hint: 'fast' }, false)).not.toBeNull();
  }
});

it('recognizes only the protected Windows reproducer path without rewriting the command or broadening execution', () => {
  const workspace = 'C:\\fixture\\workspace';
  const input = Object.freeze({ command: 'node examples\\restart.mjs' });
  expect(checkNaturalTool(workspace, 'bash', input, false)).toBeNull();
  expect(input).toEqual({ command: 'node examples\\restart.mjs' });
  expect(checkNaturalTool(workspace, 'bash', input, true)).not.toBeNull();
  expect(checkNaturalTool(workspace, 'bash', { ...input, run_in_background: true }, false)).not.toBeNull();
  expect(checkNaturalTool(workspace, 'bash', { ...input, cwd: '..' }, false)).not.toBeNull();
  expect(checkNaturalTool('/tmp/fixture/workspace', 'bash', input, false)).not.toBeNull();
  for (const command of [
    'node examples\\other.mjs', 'node examples\\restart.mjs --import other.mjs',
    'node --import other.mjs examples\\restart.mjs', 'node examples\\restart.mjs && node --test',
    'node examples\\restart.mjs & node --test', 'node examples\\restart.mjs | node --test',
    'node examples\\restart.mjs > tests/result.txt', 'node ..\\examples\\restart.mjs',
    'node examples\\..\\restart.mjs', 'node C:\\fixture\\workspace\\examples\\restart.mjs',
  ]) expect(checkNaturalTool(workspace, 'bash', { command }, false)).not.toBeNull();
});

it('explains denied command composition without changing inputs or permitting either unsafe stages or readonly execution', () => {
  for (const workspace of ['C:\\fixture\\workspace', '/tmp/fixture/workspace']) {
    for (const command of ['node --test && node examples/restart.mjs', 'npm test && node examples/restart.mjs',
      'node --test && npm test', 'npm test; node --test', 'git status --short | git diff']) {
      const input = Object.freeze({ command });
      for (const readOnly of [false, true]) {
        const reason = checkNaturalTool(workspace, 'bash', input, readOnly);
        expect(reason).toContain('one foreground command per call');
        expect(reason).toContain('No part of this command ran');
        expect(reason).toContain('Changing the executable or alias does not permit command composition');
        expect(reason).toContain('Each command must still satisfy the path, argument and read-only restrictions');
      }
      expect(input.command).toBe(command);
    }
    // More specific capability/path failures must not be obscured by composition feedback.
    expect(checkNaturalTool(workspace, 'bash', { command: 'node --test && node ../escape.mjs' }, false)).toContain('leaves the fixture workspace');
    expect(checkNaturalTool(workspace, 'bash', { command: 'node --test && rm src/recovery.js' }, false)).toContain('Executable is outside');
    expect(checkNaturalTool(workspace, 'bash', { command: 'node --test' }, false)).toBeNull();
    expect(checkNaturalTool(workspace, 'bash', { command: 'node --test' }, true)).toContain('Read-only');
    expect(checkNaturalTool(workspace, 'bash', { command: 'node examples/restart.mjs' }, false)).toBeNull();
    expect(checkNaturalTool(workspace, 'bash', { command: 'node examples/restart.mjs' }, true)).toContain('Read-only');
  }
});

it('delivers precise composition refusal and the next legal test receipt through the unchanged Runtime boundary', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async (input, _signal, index) => {
    if (index === 0) return result([tool('composed', 'bash', { command: 'node --test && node examples/restart.mjs' })]);
    if (index === 1) {
      expect(JSON.stringify(input.messages)).toContain('one foreground command per call');
      expect(JSON.stringify(input.messages)).toContain('No part of this command ran');
      expect(JSON.stringify(input.messages)).not.toContain('TAP version');
      return result([tool('legal-test', 'bash', { command: 'node --test' })]);
    }
    expect(index).toBe(2);
    expect(JSON.stringify(input.messages)).toContain('# pass 2');
    return result([], '公共测试两项通过；此离线边界检查未修复原问题。');
  }, { limits: { calls: 3, tools: 3, timeoutMs: 30_000 } });
  expect(record.error).toBeNull();
  expect(record.counts.requests).toBe(3);
  expect(record.events.filter(event => event.kind === 'guard' && event.denied)).toHaveLength(1);
  expect(record.verification.oracle.status).toBe(1);
  expect(record.protectedUnchanged).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
}, 45000);

it('injects the remaining-work reminder at the existing threshold without creating Todos or extra requests', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network'); });
  vi.stubGlobal('fetch', fetcher);
  const inspection = [
    ...['README.md', 'src/recovery.js', 'test/recovery.test.js', 'examples/restart.mjs', 'package.json']
      .map((file, index) => tool(`read-${index}`, 'read', { path: file })),
    tool('files', 'glob', { pattern: '**/*.js' }),
    tool('references', 'grep', { pattern: 'recoverShutdown', path: 'src' }),
    tool('tests', 'bash', { command: 'node --test' }),
  ];
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async (input, _signal, index) => {
    const history = JSON.stringify(input.messages);
    if (index < 8) {
      expect(history).not.toContain('You have not committed a plan');
      return result([inspection[index]!]);
    }
    expect(index).toBe(8);
    expect(history).toContain('You have not committed a plan in 8 iterations');
    expect(history).toContain('multiple execution steps remain');
    expect(history).toContain('Do not create milestones for already completed work');
    expect(history).toContain('Missing or failed checks remain unfinished work');
    return result([], '离线链路检查结束；尚未修复原问题。');
  }, { limits: { calls: 9, tools: 9, timeoutMs: 30_000 } });
  expect(record.error).toBeNull();
  expect(record.counts.requests).toBe(9);
  expect(record.counts.tools).toBe(8);
  expect(record.verification.oracle.status).toBe(1);
  expect(record.protectedUnchanged).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
}, 45000);

it.each(['agent', 'coding', 'script'] as const)('uses real AMA %s Runtime for read, refusal, repair, tests and final report without model calls', async workMode => {
  vi.stubEnv('NODE_ENV', 'production');
  const fetcher = vi.fn(() => { throw new Error('No network in offline Runtime validation'); });
  vi.stubGlobal('fetch', fetcher);
  const directory = await root();
  const record = await runNaturalRuntime(directory, 'symptom-repair', async (input, _signal, index) => {
    expect(input.system).not.toContain('RECOVERY_ORACLE');
    expect(JSON.stringify(input.messages)).not.toContain('请派一个只读子 Agent');
    if (index === 2) {
      const receipt = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === 'step-1');
      expect(receipt?.type === 'tool_result' && receipt.is_error).toBe(true);
      expect(JSON.stringify(receipt)).toContain('No part');
    }
    if (index === 4) {
      expect(JSON.stringify(input.messages)).toContain('# pass 2');
      return result([], '已修复安全恢复决策，执行 node --test：两项公共测试通过。未实测真实 Host 或操作系统进程。');
    }
    const calls = [
      tool('step-0', 'read', { path: 'src/recovery.js' }),
      tool('step-1', 'bash', { command: 'mkdir src/extra' }),
      tool('step-2', 'edit', { path: 'src/recovery.js', edits: [{ old_string: RECOVERY_FILES['src/recovery.js'], new_string: RECOVERY_GOLDEN }] }),
      tool('step-3', 'bash', { command: 'node --test' }),
    ];
    const call = calls[index];
    if (!call) throw new Error(`Unexpected scripted Runtime request ${index}`);
    return result([workMode === 'script' ? tool(call.id, 'script_exec', { code: `return await tools.${call.name}(${JSON.stringify(call.input)});` }) : call]);
  }, { workMode, limits: { calls: 8, tools: 12, timeoutMs: 45_000 } });
  expect(record.error).toBeNull();
  expect(record.success).toBe(true);
  expect(record.counts.requests).toBe(5);
  expect(record.counts.maxConcurrentRequests).toBe(1);
  expect(record.counts.childRequests).toBe(0);
  expect(record.verification.public.status).toBe(0);
  expect(record.verification.oracle.status, record.verification.oracle.stdout + record.verification.oracle.stderr).toBe(0);
  expect(record.protectedUnchanged).toBe(true);
  expect(record.events.filter(event => event.kind === 'guard' && event.denied).length).toBe(1);
  expect(record.counts.scriptLeaves).toBe(workMode === 'script' ? 4 : 0);
  await expect(fs.stat(path.join(directory, 'workspace/src/extra'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(fetcher).not.toHaveBeenCalled();
}, 60_000);

it('stops at the shared request cap and records the incomplete task without manufacturing success', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network'); }));
  const record = await runNaturalRuntime(await root(), 'symptom-repair', async () => result([tool('only-read', 'read', { path: 'src/recovery.js' })]),
    { limits: { calls: 1, tools: 4, timeoutMs: 20_000 } });
  expect(record.counts.requests).toBe(1);
  expect(record.error).toContain('request cap');
  expect(record.verification.oracle.status).toBe(1);
  expect(record.protectedUnchanged).toBe(true);
}, 45_000);

it('returns a bridged refusal unchanged and allows the next legal read', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network'); }));
  const record = await runNaturalRuntime(await root(), 'review', async (input, _signal, index) => {
    if (index === 0) return result([tool('denied-bridge', 'tool_call', { name: 'read', input: { path: '../oracle.mjs' } })]);
    if (index === 1) {
      expect(JSON.stringify(input.messages)).toContain('Path leaves the fixture workspace.');
      return result([tool('legal-read', 'tool_call', { name: 'read', input: { path: 'README.md' } })]);
    }
    return result([], '已读取公共契约；越界读取被拒绝，尚未完成源码评审。');
  }, { limits: { calls: 4, tools: 6, timeoutMs: 20_000 } });
  expect(record.error).toBeNull();
  expect(record.counts.requests).toBe(3);
  expect(record.counts.tools).toBe(2);
  expect(record.events.filter(event => event.kind === 'guard' && event.denied)).toHaveLength(1);
  expect(record.protectedUnchanged).toBe(true);
}, 45_000);

it('blocks a second tool at the shared tool cap before its mutation', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network'); }));
  const directory = await root();
  const record = await runNaturalRuntime(directory, 'symptom-repair', async (_input, _signal, index) => index === 0
    ? result([tool('initial-read', 'read', { path: 'src/recovery.js' })])
    : result([tool('over-budget-write', 'write', { path: 'src/recovery.js', content: RECOVERY_GOLDEN })]),
  { limits: { calls: 4, tools: 1, timeoutMs: 20_000 } });
  expect(record.error).toContain('tool cap');
  expect(record.counts.requests).toBe(2);
  expect(await fs.readFile(path.join(directory, 'workspace/src/recovery.js'), 'utf8')).toBe(RECOVERY_FILES['src/recovery.js']);
  expect(record.verification.oracle.status).toBe(1);
}, 45_000);

it('cancels before a proposed mutation executes and retains the unfixed oracle outcome', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network'); }));
  const controller = new AbortController();
  const directory = await root();
  const record = await runNaturalRuntime(directory, 'symptom-repair', async () => {
    controller.abort(new Error('offline cancellation'));
    return result([tool('must-not-write', 'write', { path: 'src/recovery.js', content: RECOVERY_GOLDEN })]);
  }, { signal: controller.signal, limits: { calls: 3, tools: 4, timeoutMs: 20_000 } });
  expect(record.counts.requests).toBe(1);
  expect(record.success).toBe(false);
  expect(await fs.readFile(path.join(directory, 'workspace/src/recovery.js'), 'utf8')).toBe(RECOVERY_FILES['src/recovery.js']);
  expect(record.verification.oracle.status).toBe(1);
}, 45_000);

it('passes Runtime thinking/low and the Run signal to the callback without rewriting provider output', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network'); }));
  const record = await runNaturalRuntime(await root(), 'verification-followup', async (_input, signal, _index, meta) => {
    expect(meta.kind).toBe('root');
    expect(meta.reasoning).toMatchObject({ enabled: true, effort: 'low' });
    expect(meta.taskSignal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    return result([], '两项公共测试通过，并运行了复现示例；没有实测真实 Host 和操作系统进程，不能保证全部边界。');
  }, { reasoning: 'auto', effort: 'low', maxOutputTokens: 8192, limits: { calls: 2, tools: 2, timeoutMs: 20_000 } });
  expect(record.error).toBeNull();
  expect(record.counts.requests).toBe(1);
}, 45_000);
