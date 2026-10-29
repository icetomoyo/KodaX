// One bounded live SDK smoke; never part of the prompt A/B comparison.
// Run manually with vite-node and KODAX_FIRST_TURN_SMOKE_RUN=1.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry } from '@kodax-ai/agent';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { createKodaXRuntime, type KodaXRuntime } from "./runtime-fixture.js";
import {
  KodaXBaseProvider, getProvider, getCostRate, calculateCost, registerModelProvider,
  clearRuntimeModelProviders, type KodaXProviderConfig, type KodaXMessage,
  type KodaXToolDefinition, type KodaXProviderStreamOptions, type KodaXReasoningRequest, type KodaXTokenUsage,
} from '@kodax-ai/llm';
import { runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { FirstTurnBudget, FIRST_TURN_LIMITS, type BudgetSnapshot } from './first-turn-eval-support.js';

const directory = path.join(os.tmpdir(), 'kodax-eval-dumps', 'first-turn-tokens-v1');
async function runLiveSmoke(): Promise<void> {
  const lockPath = path.join(directory, 'paid-budget.lock');
  const lock = await fs.open(lockPath, 'wx');
  try { await runLockedSmoke(); }
  finally { await lock.close(); await fs.unlink(lockPath); }
}

async function runLockedSmoke(): Promise<void> {
  const ledgerPath = path.join(directory, 'paid-budget-ledger.json');
  // Generation keeps its 32-call ceiling; the shared preregistered ceiling
  // includes the separate smoke and is 35. Never reset historical charges.
  const budget = new FirstTurnBudget(JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as BudgetSnapshot, 35);
  const backend = getProvider('zhipu-coding');
  const model = 'glm-5.3-flash';
  const rate = getCostRate('zhipu-coding', model);
  if (!rate) throw new Error('Missing smoke budget rate');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-first-turn-live-'));
  const target = path.join(fixture, 'sum.js');
  const original = '// Preserve this comment.\nexport function add(a, b) { return a - b; }\n';
  await fs.writeFile(target, original);
  const facts: ProviderRequestObservation[] = [];
  const calls: unknown[] = [];
  let toolCalls = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Smoke total timeout')), 180_000);
  const providerName = 'first-turn-live-smoke';
  class SmokeProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'ZHIPU_CODING_API_KEY', model, contextWindow: 128_000, supportsThinking: false,
    };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string,
      _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions) {
      if (calls.length >= 3) throw new Error('Smoke three-call ceiling reached');
      const inputAllowance = Buffer.byteLength(JSON.stringify({ messages, tools, system })) + 4096;
      const reservation = inputAllowance + FIRST_TURN_LIMITS.maxOutputTokens;
      const costAllowance = calculateCost(rate!, inputAllowance, FIRST_TURN_LIMITS.maxOutputTokens);
      budget.reserve(reservation, costAllowance);
      calls.push({ inputAllowance });
      await fs.writeFile(ledgerPath, JSON.stringify(budget.state, null, 2));
      let usage: KodaXTokenUsage | undefined;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(FIRST_TURN_LIMITS.timeoutMs)]);
        const result = await backend.stream(messages, tools, system, { enabled: false, effort: 'none' }, {
          ...options, modelOverride: model, maxOutputTokensOverride: FIRST_TURN_LIMITS.maxOutputTokens,
          singleAttempt: true, signal,
        });
        usage = result.usage;
        calls[calls.length - 1] = { inputAllowance, result };
        return result;
      } finally {
        const cost = usage ? calculateCost(rate!, usage.inputTokens, usage.outputTokens,
          usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
        budget.settle(reservation, costAllowance, usage, cost);
        await fs.writeFile(ledgerPath, JSON.stringify(budget.state, null, 2));
      }
    }
  }
  setAgentConfigHome(path.join(fixture, 'home'));
  registerModelProvider(providerName, () => new SmokeProvider());
  let runtime: KodaXRuntime | undefined;
  try {
    runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(fixture, 'home'),
      defaultProvider: providerName, defaultModel: model, permissionTimeoutMs: 1000 });
    const session = await runtime.sessions.create({ projectPath: fixture });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: fixture });
    const runtimeForRun = runtime;
    const result = await runWithProviderRequestObserver(fact => { facts.push(fact); }, async () => {
      const handle = await runtimeForRun.runs.start({ sessionId: session.id,
        prompt: '请读取 sum.js，把 add 的实现修正为加法，保留现有注释和格式。这是一个简单修复，只需精确编辑并简短报告完成，不需要运行命令或创建计划。', options: {
      provider: providerName, agentMode: 'sa', maxIter: 3, reasoningMode: 'off',
      maxOutputTokens: 2048, lsp: false, disablePromptCache: true, abortSignal: controller.signal,
      context: { executionCwd: fixture, gitRoot: fixture, skillsPrompt: '', skillRegistry: new SkillRegistry(fixture),
        repoIntelligenceMode: 'off', resolveShellPermissionMode: () => 'full-access',
        toolVisibilityPolicy: tool => tool.name === 'read' || tool.name === 'edit' },
      events: { beforeToolExecute: async (name, input) => {
        if (toolCalls >= 2) { controller.abort(new Error('Smoke two-tool-call ceiling reached')); return false; }
        toolCalls += 1;
        return (name === 'read' || name === 'edit') && typeof input.path === 'string'
          && path.resolve(fixture, input.path).toLowerCase() === target.toLowerCase();
      } },
      } });
      return await handle.result;
    });
    const content = await fs.readFile(target, 'utf8');
    const physicalAttempts = new Set(facts.filter(f => f.boundary === 'physical_attempt' && f.state === 'started').map(f => f.requestId)).size;
    const resultSuccess = result.result?.success === true;
    const passed = resultSuccess && content === original.replace('a - b', 'a + b')
      && physicalAttempts > 0 && physicalAttempts <= 3;
    const output = path.join(directory, 'live-sdk-smoke-runtime-v1.json');
    await fs.writeFile(output, JSON.stringify({ route: 'zhipu-coding/glm-5.3-flash', layer: '3.5-smoke',
      comparison: false, executionEntry: 'createKodaXRuntime', maxCalls: 3, maxToolCalls: 2, toolCalls, calls, facts, physicalAttempts, resultSuccess, runtimePhase: result.phase,
      content, passed, budget: budget.state }, null, 2), { flag: 'wx' });
    process.stdout.write(JSON.stringify({ output, passed, calls: calls.length, physicalAttempts, budget: budget.state }) + '\n');
    if (!passed) throw new Error('Live smoke groundtruth failed; inspect saved evidence');
  } catch (error: unknown) {
    const key = process.env.ZHIPU_CODING_API_KEY;
    const message = error instanceof Error ? error.message : String(error);
    const redacted = key ? message.replaceAll(key, '[REDACTED]') : message;
    await fs.writeFile(path.join(directory, 'live-sdk-smoke-runtime-v1-failure.json'), JSON.stringify({
      error: redacted, toolCalls, calls, facts, budget: budget.state,
    }, null, 2), { flag: 'wx' });
    throw new Error(redacted);
  } finally {
    clearTimeout(timer);
    await runtime?.close();
    clearRuntimeModelProviders();
    setAgentConfigHome(undefined);
    if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('kodax-first-turn-live-')) throw new Error('Unsafe smoke cleanup');
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.env.KODAX_FIRST_TURN_SMOKE_RUN === '1') await runLiveSmoke();
else process.stdout.write('Preflight only: live smoke requires explicit run flag; max 3 calls, read/edit only.\n');
