import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SkillRegistry } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig,
  type KodaXMessage, type KodaXToolDefinition } from '@kodax-ai/llm';
import { createKodaXRuntime, type KodaXRuntime } from '../src/sdk-runtime.js';
import type { FrozenInput } from './first-turn-eval-support.js';
import { EDIT_LIMITS, type CallEvidence, type EditRoute } from './first-turn-edit-eval-support.js';
import { writeEditEvidence } from './first-turn-edit-artifacts.js';

export interface SmokeEvidence {
  layer: '3.5-smoke'; comparison: false; executionEntry: 'createKodaXRuntime'; liveModelEvidence: boolean;
  semanticHonesty: 'requires-main-session-review'; calls: readonly CallEvidence[]; finalResponse: string;
  groundtruth: { fileExact: boolean; nodeTestPassed: boolean; toolOrder: readonly string[]; content: string };
  runtimePhase?: string; runtimeSuccess: boolean; error: string | null;
}
export interface SmokeLaneControl { stopReason: () => string | undefined; onFailure: (reason: string) => void }
export async function runEditRuntimeSmoke(route: EditRoute,
  call: (input: FrozenInput, signal: AbortSignal) => Promise<CallEvidence>, output: string,
  source: 'live' | 'scripted-test', control?: SmokeLaneControl): Promise<SmokeEvidence> {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-edit-runtime-'));
  const workspace = path.join(fixture, 'workspace'); await fs.mkdir(workspace);
  const target = path.join(workspace, 'sum.js');
  const original = '// Preserve this comment.\nexport function add(a, b) { return a - b; }\nexport function multiply(a, b) { return a + b; } // multiply\n';
  const expected = original.replace('return a - b;', 'return a + b;').replace('return a + b; } // multiply', 'return a * b; } // multiply');
  const test = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add, multiply } from './sum.js';\ntest('sum regression', () => { assert.equal(add(2, 3), 5); assert.equal(multiply(2, 3), 6); });\n";
  await fs.writeFile(target, original); await fs.writeFile(path.join(workspace, 'sum.test.js'), test);
  await fs.writeFile(path.join(workspace, 'package.json'), '{"type":"module"}\n');
  const calls: CallEvidence[] = []; const toolOrder: string[] = []; const results: { name: string; content: string; isError: boolean }[] = [];
  const providerName = `edit-smoke-${randomUUID()}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('Smoke total timeout')), EDIT_LIMITS.smokeTimeoutMs);
  let runtime: KodaXRuntime | undefined; let error: string | null = null; let runtimePhase: string | undefined; let runtimeSuccess = false;
  const notifyFailure = (reason: string): void => { error ??= reason; control?.onFailure(reason); controller.abort(new Error(reason)); };
  const reject = (reason: string): never => { notifyFailure(reason); throw new Error(reason); };
  class SmokeProvider extends KodaXBaseProvider {
    readonly name = providerName; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: route.env, model: route.model, contextWindow: 128000, supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string) {
      const round = calls.length;
      const stopped = control?.stopReason();
      if (stopped) return reject(`Smoke lanes stopped: ${stopped}`);
      if (round >= EDIT_LIMITS.maxSmokeCalls) return reject('Smoke four-call ceiling reached');
      const evidence = await call({ messages, tools, system }, controller.signal);
      calls.push(evidence);
      // Persist each paid response before execution of its proposed tool.
      const raw = JSON.stringify({ source, route: route.id, calls }, null, 2);
      if (source === 'live') await writeEditEvidence(`${output}.calls.json`, raw);
      else await fs.writeFile(`${output}.calls.json`, raw);
      if (evidence.error || !evidence.result) return reject(evidence.error ?? 'Provider returned no result');
      const wanted = ['read', 'edit', 'bash'][round];
      if (wanted ? evidence.result.toolBlocks.length !== 1 || evidence.result.toolBlocks[0]?.name !== wanted : evidence.result.toolBlocks.length !== 0 || !evidence.result.textBlocks.some(block => block.text.trim())) return reject('Response did not follow the frozen dependent smoke graph');
      const proposed = evidence.result.toolBlocks[0];
      if (proposed) {
        const input = proposed.input;
        const allowed = proposed.name === 'bash'
          ? input.command === 'node --test sum.test.js' && input.run_in_background !== true
          : typeof input.path === 'string' && path.resolve(workspace, input.path).toLowerCase() === target.toLowerCase();
        if (!allowed) return reject('Smoke exact path/command violation before tool execution');
        if (proposed.name === 'bash' && await fs.readFile(target, 'utf8') !== expected) return reject('Edit groundtruth failed before test');
      }
      if (source === 'live' && evidence.physicalAttempts !== 1) return reject('Live smoke requires one actual request per response');
      return evidence.result;
    }
  }
  const unregister = registerModelProvider(providerName, () => new SmokeProvider());
  try {
    runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(fixture, 'home'), defaultProvider: providerName, defaultModel: route.model, permissionTimeoutMs: 1000 });
    const session = await runtime.sessions.create({ projectPath: workspace });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
    const handle = await runtime.runs.start({ sessionId: session.id,
      prompt: '请修复 sum.js：add 用加法，multiply 用乘法，保留注释和格式。严格按四个依赖轮完成：第一轮 read sum.js；第二轮用一次 edit 批量精确替换两个实现；第三轮只执行 node --test sum.test.js；第四轮根据实际测试结果用简短中文报告。每轮只调用一个工具，等结果返回再下一步。不要创建计划、子agent、重试或修改测试；失败时如实报告，未验证不能称测试通过。',
      options: { provider: providerName, agentMode: 'sa', maxIter: EDIT_LIMITS.maxSmokeRounds, reasoningMode: 'off', maxOutputTokens: EDIT_LIMITS.maxOutputTokens,
        lsp: false, disablePromptCache: true, abortSignal: controller.signal,
        context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', skillRegistry: new SkillRegistry(workspace), repoIntelligenceMode: 'off', resolveShellPermissionMode: () => 'full-access', toolVisibilityPolicy: tool => ['read', 'edit', 'bash'].includes(tool.name) },
        events: {
          onToolResult: result => {
            const isError = result.toolResult?.is_error === true || /^\[Tool Error\]|^Error:/.test(result.content)
              || (result.name === 'bash' && !/(?:Exit|Exit code|exit code): 0/.test(result.content));
            toolOrder.push(result.name); results.push({ name: result.name, content: result.content, isError });
            if (isError) notifyFailure(`Smoke ${result.name} execution failed`);
          },
        },
      } });
    const result = await handle.result; runtimePhase = result.phase; runtimeSuccess = result.result?.success === true;
    if (!runtimeSuccess) notifyFailure('Smoke Runtime did not terminate successfully');
  } catch (cause: unknown) {
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const key = process.env[route.env]; if (key) error = error.replaceAll(key, '[REDACTED]');
    notifyFailure(error);
  } finally {
    clearTimeout(timer);
    await runtime?.close(); unregister();
  }
  const content = await fs.readFile(target, 'utf8');
  const bash = results.find(result => result.name === 'bash');
  const evidence: SmokeEvidence = { layer: '3.5-smoke', comparison: false, executionEntry: 'createKodaXRuntime', liveModelEvidence: source === 'live' && calls.length === EDIT_LIMITS.maxSmokeCalls && calls.every(row => row.physicalAttempts === 1 && row.result && !row.error),
    semanticHonesty: 'requires-main-session-review', calls, finalResponse: calls.at(-1)?.text ?? '',
    groundtruth: { fileExact: content === expected, nodeTestPassed: Boolean(bash && !bash.isError && /(?:Exit|Exit code|exit code): 0/.test(bash.content) && /(?:# pass 1|✔ sum regression|ok 1 - sum regression)/.test(bash.content)), toolOrder, content },
    runtimePhase, runtimeSuccess, error };
  const raw = JSON.stringify({ ...evidence, route: route.id, source, toolResults: results, original, expected, test }, null, 2);
  if (source === 'live') await writeEditEvidence(output, raw, true);
  else await fs.writeFile(output, raw, { flag: 'wx' });
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('kodax-edit-runtime-')) throw new Error('Unsafe smoke cleanup');
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return evidence;
}

/** One shared stop boundary for this two-provider smoke, preserving in-flight replies. */
export async function runEditSmokeLanes(routes: readonly EditRoute[],
  callForRoute: (route: EditRoute, input: FrozenInput, signal: AbortSignal, onFailure: (reason: string) => void, beforeDispatch: () => void) => Promise<CallEvidence>,
  runCase: (route: EditRoute, call: (input: FrozenInput, signal: AbortSignal) => Promise<CallEvidence>, control: SmokeLaneControl) => Promise<SmokeEvidence>): Promise<readonly SmokeEvidence[]> {
  let stopped: string | undefined;
  const control: SmokeLaneControl = { stopReason: () => stopped, onFailure: reason => { stopped ??= reason; } };
  const outcomes = await Promise.allSettled(routes.map(async route => {
    try {
      const evidence = await runCase(route, async (input, signal) => {
        if (stopped) throw new Error(`Smoke lanes stopped before request: ${stopped}`);
        try {
          const response = await callForRoute(route, input, signal, control.onFailure,
            () => { if (stopped) throw new Error(`Smoke lanes stopped before dispatch: ${stopped}`); });
          if (response.error) control.onFailure(response.error);
          return response;
        } catch (cause: unknown) { control.onFailure(cause instanceof Error ? cause.message : String(cause)); throw cause; }
      }, control);
      if (evidence.error || !evidence.runtimeSuccess || !evidence.groundtruth.fileExact || !evidence.groundtruth.nodeTestPassed) control.onFailure(evidence.error ?? 'Smoke groundtruth or terminal state failed');
      return evidence;
    } catch (cause: unknown) { control.onFailure(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }));
  if (stopped || outcomes.some(outcome => outcome.status === 'rejected')) throw new Error(`Smoke incomplete; retained all lane evidence and in-flight charges: ${stopped ?? 'lane failure'}`);
  return outcomes.map(outcome => (outcome as PromiseFulfilledResult<SmokeEvidence>).value);
}
