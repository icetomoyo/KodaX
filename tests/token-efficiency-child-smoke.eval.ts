/** Bounded real-child L3.5 smoke; no parent LLM, no prompt A/B, no retries. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AgentActorController, type ToolGuardrail } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, getProvider, getCostRate, calculateCost,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult, type KodaXReasoningRequest, type KodaXProviderStreamOptions } from '@kodax-ai/llm';
import { observeProviderOperation, runWithAdditionalProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { getBuiltinToolDefinition } from '../packages/coding/src/tools/index.js';
import { projectManagedToolContract } from '../packages/coding/src/tools/managed-tool-contract.js';
import { FirstTurnBudget, inputHash } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { NEXT_STAGE_ROUTES, type NextStageRoute } from './token-efficiency-next-stage-fixtures.js';
import { checkNaturalTool } from './shared-contract-natural-runtime.js';
import { PRODUCT_CASES, prepareProductCase } from '../benchmark/datasets/product-multiturn/fixture.js';
import { prepareNaturalExecutionEnvironment } from '../benchmark/harness/natural-execution-environment.js';
import { resolveToolBridgeTarget } from '../packages/coding/src/tools/tool-bridge.js';

const revision = 'token-efficiency-child-smoke-r1-20261031';
const selected = process.env.KODAX_CHILD_CONTRACT_SMOKE_ROUTE;
const limits = { calls: 4, tools: 12, tokens: 150_000, usd: 0.30, output: 2048, timeoutMs: 180_000, callTimeoutMs: 120_000 };
it('runs a bounded builtin readonly child through actual production assembly', async () => {
  const offline = !selected;
  if (selected && !Object.hasOwn(NEXT_STAGE_ROUTES, selected)) throw new Error('Unsupported child smoke route');
  const route = (selected ?? 'deepseek') as NextStageRoute, config = NEXT_STAGE_ROUTES[route];
  if (!offline && !process.env[config.key]) throw new Error(`Missing ${route} credential`);
  const root = path.join(os.tmpdir(), 'kodax-eval-dumps', revision, offline ? `offline-${randomUUID()}` : route);
  await fs.mkdir(root, { recursive: true });
  const redact = (text: string) => Object.values(NEXT_STAGE_ROUTES).reduce((value, item) => {
    const key = process.env[item.key]; return key ? value.replaceAll(key, '[REDACTED]') : value;
  }, text);
  const save = (name: string, value: unknown) => fs.writeFile(path.join(root, name), redact(JSON.stringify(value, null, 2)), { flag: 'wx' });
  const sources = ['tests/token-efficiency-child-smoke.eval.ts', 'packages/coding/src/child-executor.ts',
    'packages/coding/src/agent-runtime/run-substrate.ts', 'packages/coding/src/prompts/compact-child-contract.ts',
    'packages/coding/src/prompts/child-contract-scope.ts', 'packages/coding/src/prompts/child-system-contract.ts'];
  const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, inputHash(await fs.readFile(file, 'utf8'))])));
  const sourceHashes = await hashes(), rate = getCostRate(route, config.model)!;
  const objective = '请只读审查配置解析器的行为是否符合项目约定，找出会影响用户配置生效的问题，并向父 Agent 报告具体依据和验证范围。';
  await save('preregistration.json', { revision, offline, route, model: config.model, sourceHashes, limits, rate, objective,
    scope: 'Host dispatches one readonly child; production executor and request assembly unchanged. No forced refusal/discovery. L3.5 usability, no A/B or global intelligence claim.',
    aggregateCaps: { families: 3, calls: 12, tokens: 450_000, referenceUsd: 0.90 },
    stop: 'One attempt, no fallback. Source drift, tool/call/token/cost cap, unknown usage or transport failure stops. Never rerun a paid route. Subscription prices are reference rates.' });
  const { workspace } = await prepareProductCase(root, 'config-precedence');
  const execution = await prepareNaturalExecutionEnvironment(workspace);
  const budget = new FirstTurnBudget(undefined, limits.calls), abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Child smoke timeout')), limits.timeoutMs);
  const records: Record<string, unknown>[] = [], events: Record<string, unknown>[] = [];
  let calls = 0, toolsSeen = 0;
  const boundary: ToolGuardrail = { kind: 'tool', name: 'readonly-child-smoke-boundary', beforeTool: async call => {
    if (abort.signal.aborted || ++toolsSeen > limits.tools) { abort.abort(); return { action: 'block', reason: 'Child smoke budget exhausted.' }; }
    const bridge = resolveToolBridgeTarget(call), target = bridge?.ok ? bridge.call : call;
    const denied = bridge && !bridge.ok ? bridge.error : checkNaturalTool(workspace, target.name, target.input, true, 'specific', PRODUCT_CASES['config-precedence'].files);
    events.push({ kind: 'guard', name: target.name, input: target.input, denied });
    return denied ? { action: 'block', reason: denied } : { action: 'allow' };
  } };
  const providerName = `bounded-child-smoke-${randomUUID()}`;
  class Relay extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = !offline && route === 'kimi-code';
    protected readonly config = { apiKeyEnv: config.key, model: config.model, contextWindow: 128_000, supportsThinking: this.supportsThinking, maxOutputTokens: limits.output };
    override isConfigured() { return true; }
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string, reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
      const index = calls++;
      if (index >= limits.calls || abort.signal.aborted || inputHash(sourceHashes) !== inputHash(await hashes())) { abort.abort(); throw new Error('Child smoke stopped before dispatch'); }
      expect(tools.find(tool => tool.name === 'glob')?.description).toBe(projectManagedToolContract(getBuiltinToolDefinition('glob')!).description);
      expect(system).toContain('Current task scope: read-only');
      const input = { system, tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })), messages };
      await save(`call-${index}.input.json`, { ...input, inputHash: inputHash(input), reasoning, options });
      if (offline) return index === 0 ? { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'offline-read', name: 'read', input: { path: path.join(workspace, 'src/config.js') } }], stopReason: 'tool_use' }
        : { textBlocks: [{ type: 'text', text: 'Static review complete; tests were not run.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
      const inputUpper = Buffer.byteLength(JSON.stringify(input), 'utf8') + 4096, output = Math.min(options?.maxOutputTokensOverride ?? limits.output, limits.output);
      const reservedTokens = inputUpper + output, reservedUsd = calculateCost(rate, inputUpper, output);
      if (budget.state.chargedTokens + reservedTokens > limits.tokens || budget.state.chargedUsd + reservedUsd > limits.usd) { abort.abort(); throw new Error('Child smoke reservation cap'); }
      budget.reserve(reservedTokens, reservedUsd);
      const combined = AbortSignal.any([abort.signal, AbortSignal.timeout(limits.callTimeoutMs), ...(signal ? [signal] : [])]);
      const facts: ProviderRequestObservation[] = [], started = Date.now();
      let result: KodaXStreamResult | undefined, error: string | null = null;
      try { result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route, 'primary', undefined,
        () => getProvider(route).stream(messages, tools, system, reasoning, { ...options, modelOverride: config.model, maxOutputTokensOverride: output, singleAttempt: true }, combined), undefined, combined)); }
      catch (cause) { error = redact(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)); }
      const usage = result?.usage, actualUsd = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
      const settlement = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: tools.map(tool => tool.name), reasoning, outputCap: output,
        requestCancelled: combined.aborted, taskCancelled: abort.signal.aborted, failed: error !== null, actualUsd });
      budget.settle(reservedTokens, reservedUsd, settlement.unknownUsage ? undefined : usage, actualUsd);
      const overrun = (usage?.totalTokens ?? 0) > reservedTokens || (usage?.outputTokens ?? 0) > output || (actualUsd ?? 0) > reservedUsd;
      const row = { index, result, error, facts, settlement, overrun, actualUsd, wallMs: Date.now() - started, budget: { ...budget.state } };
      records.push(row); await save(`call-${index}.result.json`, row);
      if (settlement.stop || overrun || !result) { abort.abort(); throw new Error(error ?? 'Child smoke incomplete provider attempt'); }
      return result;
    }
  }
  const unregister = registerModelProvider(providerName, () => new Relay()), started = Date.now();
  try {
    const result = await executeChildAgents([{ id: 'configuration-review', fanoutClass: 'evidence-scan', objective, constraints: [], evidenceRefs: [], readOnly: true }],
      { backups: new Map(), executionCwd: workspace, gitRoot: workspace, shellExecution: execution.shellExecution, resolveShellPermissionMode: () => 'full-access' },
      { maxParallel: 1, maxIterationsPerChild: limits.calls, parentRole: 'worker', parentHarness: 'tool-dispatch', abortSignal: abort.signal,
        actorControl: new AgentActorController().bind('/root'), guardrails: [boundary],
        parentOptions: { provider: providerName, model: config.model, reasoningMode: !offline && route === 'kimi-code' ? 'quick' : 'off', effort: !offline && route === 'kimi-code' ? 'low' : 'none', repoIntelligenceMode: 'off',
          events: { onToolResult: receipt => { events.push({ kind: 'result', ...receipt }); } } } });
    const protectedUnchanged = (await Promise.all(Object.entries(PRODUCT_CASES['config-precedence'].files).map(async ([file, bytes]) => await fs.readFile(path.join(workspace, file), 'utf8') === bytes))).every(Boolean);
    await save('result.json', { result, records, events, calls, toolsSeen, protectedUnchanged, budget: budget.state, wallMs: Date.now() - started, offline });
    if (offline) { expect(calls).toBe(2); expect(toolsSeen).toBe(1); expect(result.results[0]?.status).toBe('completed'); expect(protectedUnchanged).toBe(true); }
    process.stdout.write(JSON.stringify({ root, calls, toolsSeen, protectedUnchanged, budget: budget.state, status: result.results[0]?.status, offline }) + '\n');
  } finally { clearTimeout(timer); unregister(); }
}, 200_000);
