// Test-only capture of a real, pinned unfamiliar package. No reference implementation is injected.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SkillRegistry } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime, type KodaXRuntime } from '../src/sdk-runtime.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';
import { resolveDeferredEvidenceRoot } from './deferred-repo-lsp-support.js';

export const SEARCH_REFERENCE_REVISION = '136b87e8a7f5a3e5186de0289523ba327dc592fc';
/** Resume successful pending evidence only; no added teaching, replay, or output repair. */
export function restoreSearchCheckpoint(input: FrozenInput, evidence: {
  inputHash: string; error: string | null; result?: KodaXStreamResult;
}): KodaXMessage[] {
  if (inputHash(input) !== evidence.inputHash) throw new Error('Checkpoint input changed');
  if (evidence.error || evidence.result?.stopReason !== 'tool_use' || !evidence.result.toolBlocks.length) {
    throw new Error('A successful pending tool response is required');
  }
  return structuredClone([...input.messages]);
}
export const UNFAMILIAR_SEARCH_CASES = [
  { id: 'width', task: '只读调查这个陌生终端 UI 包：找到负责计算带 ANSI 控制序列、中文和组合字符的显示列宽的实际实现，说明它如何缓存重复文本、缓存满时淘汰谁，以及缓存命中是否改变淘汰顺序。给出公开导出路径、关键源码位置，并区分列宽缓存与组件渲染缓存。以实际读取为依据，不修改文件、不运行测试、不创建计划或子 Agent。' },
  { id: 'paste', task: '只读调查这个陌生终端 UI 包：定位一次粘贴跨多个 stdin 数据块到达时的实际处理链，说明开始/结束标记被拆开时如何缓存、结束标记之后的普通输入如何继续处理，以及终端层怎样将粘贴交给既有编辑器。给出关键实现和已有测试证据；不要只引用组件里的粘贴函数。不修改文件、不运行测试、不创建计划或子 Agent。' },
] as const;

export async function captureReadonlySearchInput(directory: string, task: string, sourceRepository: string, revision: string) {
  resolveDeferredEvidenceRoot(directory);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Exact source revision required');
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  if ((await fs.readdir(workspace)).length) throw new Error('Snapshot workspace must be empty');
  const git = (args: string[]) => execFileSync('git', args, { cwd: sourceRepository, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const records = git(['ls-tree', '-rz', revision, 'packages/tui/']).toString('utf8').split('\0').filter(Boolean);
  if (!records.length) throw new Error('Missing reference subtree');
  const files: Record<string, string> = {};
  for (const record of records) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\tpackages\/tui\/(.+)$/.exec(record);
    if (!match) throw new Error('Reference contains unsupported tree entries');
    const relative = match[3]!;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe reference path');
    const bytes = git(['cat-file', 'blob', match[2]!]);
    const target = path.join(workspace, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
    files[relative] = createHash('sha256').update(bytes).digest('hex');
  }
  // Normal local Git context; do not strip overview/path hints from the production prompt.
  const localGit = (...args: string[]) => execFileSync('git', args, { cwd: workspace, windowsHide: true });
  localGit('init', '-q');
  await fs.appendFile(path.join(workspace, '.git/info/exclude'), '\n.agent/\n');
  localGit('add', '--all');
  localGit('-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'reference snapshot');
  let input: FrozenInput | undefined;
  const providerName = 'readonly-capture-' + randomUUID();
  class CaptureProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'ZHIPU_CODING_API_KEY', model: 'offline', contextWindow: 128000, supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
      if (input) throw new Error('Capture must use exactly one request');
      input = structuredClone({ messages, tools, system });
      return { textBlocks: [{ type: 'text', text: 'Offline capture only.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider(providerName, () => new CaptureProvider());
  let runtime: KodaXRuntime | undefined;
  try {
    runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(directory, 'home'), defaultProvider: providerName, defaultModel: 'offline' });
    const session = await runtime.sessions.create({ projectPath: workspace });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
    const run = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: task,
      options: { provider: providerName, model: 'offline', agentMode: 'ama', lsp: false,
        abortSignal: AbortSignal.timeout(60_000),
        learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['eval-isolated'] } }),
        context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'auto', skillsPrompt: '', skillRegistry: new SkillRegistry(workspace), resolveShellPermissionMode: () => 'full-access' },
      } });
    const result = await run.result;
    if (!input || result.phase !== 'completed') throw new Error('Readonly Runtime capture failed');
    return { workspace, input, files, sourceRevision: revision };
  } finally { await runtime?.close(); unregister(); }
}
