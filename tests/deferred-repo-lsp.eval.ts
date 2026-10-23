// Manual experiment. prepare is offline; paid phases require the frozen manifest hash.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getProvider, getProviderModels, getCostRate, calculateCost,
  type KodaXMessage, type KodaXStreamResult, type KodaXReasoningRequest, type KodaXProviderStreamOptions } from '@kodax-ai/llm';
import { observeProviderOperation, runWithAdditionalProviderRequestObserver, currentProviderRequestAttribution,
  type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { countTokens } from '../packages/agent/src/tokenizer.js';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/runner-driven.js';
import { getToolExecutionOverride } from '../packages/coding/src/agent-runtime/permission-gate.js';
import { getModuleContext } from '../packages/coding/src/repo-intelligence/runtime.js';
import { resolveToolBridgeTarget } from '../packages/coding/src/tools/tool-bridge.js';
import { CACHE_TASK } from '../benchmark/datasets/search-entry-complex/fixture.js';
import { inputHash, type FrozenInput, type BudgetSnapshot } from './first-turn-eval-support.js';
import type { CallEvidence } from './first-turn-edit-eval-support.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { checkComplexTool } from './first-turn-complex-guard.js';
import { projectDeferredRepoLspInput, resolveDeferredEvidenceRoot, isAuxiliaryLocalPreflight } from './deferred-repo-lsp-support.js';

const revision = 'deferred-repo-lsp-20261023-r3';
const root = resolveDeferredEvidenceRoot(process.env.KODAX_DEFERRED_EVAL_ROOT ?? path.join(os.tmpdir(), 'kodax-eval-dumps', revision));
const repository = fileURLToPath(new URL('..', import.meta.url));
const limits = { pilot: { calls: 24, tokens: 600_000, usd: 0.20, output: 2048 },
  smoke: { calls: 80, tokens: 2_400_000, usd: 0.25, output: 4096 }, requestMs: 120_000,
  smokeCell: { calls: 40, tools: 80, timeoutMs: 600_000 } };
const routes = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
].map(route => { const rate = getCostRate(route.provider, route.model); if (!rate) throw new Error('Missing frozen reference price'); return { ...route, rate }; });
type Route = typeof routes[number];
type Meta = { reasoning?: boolean | KodaXReasoningRequest; streamOptions?: KodaXProviderStreamOptions; taskSignal?: AbortSignal };
const cases = [
  { id: 'ordinary', task: '只读取 README.md，说明 TTL=0 与恰好到期时的公开契约。不修改文件、不创建计划、不派子 Agent；请依据实际读取结果简短回答。' },
  { id: 'module-recovery', task: '只读预检：取得 packages/cache 的完整模块上下文，保留测试、文档、依赖和入口线索。此前错误路径被拒绝，请依据反馈自主恢复；不要修改文件、派子 Agent或编造已获取的证据。' },
];
type Frozen = { id: string; task: string; workspace: string; input: FrozenInput };
interface Manifest { revision: string; limits: typeof limits; sourceHashes: Record<string, string>; routes: typeof routes; frozen: Frozen[]; }
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function save(relative: string, value: unknown, exclusive = false): Promise<void> {
  const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  if (exclusive) await fs.writeFile(file, text, { flag: 'wx' });
  else { const temporary = file + '.' + randomUUID() + '.tmp'; await fs.writeFile(temporary, text); await fs.rename(temporary, file); }
}
function redact(cause: unknown): string {
  let value = cause instanceof Error ? cause.name + ': ' + cause.message : String(cause);
  for (const route of routes) { const key = process.env[route.env]; if (key) value = value.replaceAll(key, '[REDACTED]'); }
  return value;
}
async function prepare(): Promise<void> {
  const frozen: Frozen[] = [];
  for (const test of cases) {
    let captured: FrozenInput | undefined;
    const directory = path.join(root, 'capture', test.id);
    await runComplexRuntime(routes[0]!, directory, async input => {
      if (test.id === 'module-recovery' && !input.messages.some(message => JSON.stringify(message.content).includes('Path leaves the fixture workspace.'))) {
        const result: KodaXStreamResult = { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
          { type: 'tool_use', id: 'frozen-refusal', name: 'tool_call', input: { name: 'module_context', input: { target_path: '../outside' } } },
        ] };
        return { inputHash: inputHash(input), result, text: '', toolCalls: result.toolBlocks, usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
      }
      captured = structuredClone(input);
      const result: KodaXStreamResult = { textBlocks: [{ type: 'text', text: 'Offline input capture complete.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
      return { inputHash: inputHash(input), result, text: 'Offline input capture complete.', toolCalls: [], usage: null, estimatedUsd: null, error: null, physicalRequestObservations: [], physicalAttempts: 0, durationMs: 0 };
    }, { calls: 2, tools: 4, timeoutMs: 60_000 }, false, test.task);
    if (!captured) throw new Error('Production Runtime did not capture ' + test.id);
    frozen.push({ ...test, workspace: path.join(directory, 'workspace'), input: captured });
  }
  const tracked = execFileSync('git', ['ls-files', '--', 'src', 'packages', 'tests'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  const files = [...new Set([...tracked.filter(file => /\.(?:ts|tsx|json)$/.test(file) && !file.includes('/dist/')),
    'tests/deferred-repo-lsp.eval.ts', 'tests/deferred-repo-lsp-support.ts',
    'benchmark/datasets/search-entry-complex/fixture.ts', 'package.json', 'package-lock.json'])].sort();
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await fs.readFile(path.join(repository, file)))])));
  const manifest = { revision, limits, sourceHashes, routes, frozen,
    rubric: 'Blind main-session review: actual task evidence, usable module detail, autonomous refusal recovery, accurate report, missing/incorrect tools and arguments. Compare all calls/tokens/cache/reference fee/wall time; no aggregate ship boolean. Layer3 <=3 generation calls; complex smoke is not A/B.',
    protocol: 'First call per cell is Layer2 only. Followup reuses that raw and executes only scoped readonly production tools, then at most two fixed generation steps. No retry/fallback, corrected parameters or synthetic successful tool results. Both arms use the same frozen Host input; only root schema projection differs.',
    smokeTask: CACHE_TASK + '\n另请取得 packages/cache 模块的完整模块证据（包括测试/文档线索），在最终报告说明实际获取情况；若不可用必须如实说明。',
    limitations: ['No installed real TypeScript language server in this fixture; eight LSP native/bridge transports and outputs are checked offline using the existing JSON-RPC fixture, not a compiler-quality claim.', 'Raw reservations are conservative; prices are repository coding-plan reference rates, not invoice amounts.', 'Root projection only; child/specialist menus and context reservation remain unchanged.'],
    previousRecordedHistory: { calls: 703, conservativeTokens: 14_178_522, referenceUsd: 0.6738935658, unknownUsageCalls: 27 },
  };
  await save('manifest.json', manifest, true);
  for (const phase of ['pilot', 'smoke']) await save(phase + '-ledger.json', { calls: 0, chargedTokens: 0, reservedTokens: 0, chargedUsd: 0, reservedUsd: 0, unknownUsageCalls: 0 } satisfies BudgetSnapshot, true);
  await save('metrics.json', frozen.map(test => ({ id: test.id, baseline: countTokens(JSON.stringify(test.input)),
    candidate: countTokens(JSON.stringify(projectDeferredRepoLspInput(test.input, true))), tools: test.input.tools.length,
    projectedTools: projectDeferredRepoLspInput(test.input, true).tools.length })), true);
  process.stdout.write(JSON.stringify({ prepared: true, root, manifestHash: inputHash(manifest), paidCalls: 0 }) + '\n');
}

async function run(phase: 'pilot' | 'followup' | 'smoke'): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest & { smokeTask: string };
  if (manifest.revision !== revision || inputHash(manifest.limits) !== inputHash(limits)
    || process.env.KODAX_DEFERRED_EVAL_MANIFEST_HASH !== inputHash(manifest)) throw new Error('Frozen reviewed manifest required');
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) if (hash(await fs.readFile(path.join(repository, file))) !== expected) throw new Error('Frozen source changed: ' + file);
  for (const route of routes) if (!process.env[route.env] || !getProviderModels(route.provider).includes(route.model)) throw new Error('Unavailable route ' + route.id);
  if (phase !== 'pilot') {
    const review = JSON.parse(await fs.readFile(path.join(root, phase + '-review.json'), 'utf8')) as { reviewer: string; allowNext: boolean };
    if (review.reviewer !== 'main-session' || !review.allowNext) throw new Error('Main-session evidence review required');
  }
  await save(phase + '-started.json', { at: new Date().toISOString() }, true);
  const budgetPhase = phase === 'followup' ? 'pilot' : phase;
  const budget = JSON.parse(await fs.readFile(path.join(root, budgetPhase + '-ledger.json'), 'utf8')) as BudgetSnapshot;
  if (budget.reservedTokens || budget.reservedUsd) throw new Error('Unsettled reservation');
  const cap = limits[budgetPhase]; let stopped = false;
  let ledgerTail = Promise.resolve();
  const saveBudget = (): Promise<void> => {
    ledgerTail = ledgerTail.then(() => save(budgetPhase + '-ledger.json', budget));
    return ledgerTail;
  };
  const active = new Set<string>();
  async function call(route: Route, input: FrozenInput, label: string, signal: AbortSignal, meta: Meta = {}): Promise<CallEvidence> {
    signal.throwIfAborted();
    if (stopped || active.has(route.provider)) throw new Error('Stopped or same-provider overlap');
    const output = Math.min(cap.output, meta.streamOptions?.maxOutputTokensOverride ?? cap.output);
    const reservedInput = Buffer.byteLength(JSON.stringify(input)) + 4096, reservedTokens = reservedInput + output;
    const reservedUsd = calculateCost(route.rate, reservedInput, output);
    if (budget.calls >= cap.calls || budget.chargedTokens + budget.reservedTokens + reservedTokens > cap.tokens
      || budget.chargedUsd + budget.reservedUsd + reservedUsd > cap.usd) { stopped = true; throw new Error('Frozen budget exhausted'); }
    budget.calls++; budget.reservedTokens += reservedTokens; budget.reservedUsd += reservedUsd; active.add(route.provider);
    await saveBudget(); await save(label + '.input.json', input, true);
    const reasoning = meta.reasoning ?? (route.provider === 'kimi-code' ? { enabled: true, effort: 'low' } : { enabled: false, effort: 'none' });
    await save(label + '.options.json', { reasoning, output, forcedToolName: meta.streamOptions?.forcedToolName }, true);
    const facts: ProviderRequestObservation[] = []; const started = Date.now();
    let firstOutputMs: number | null = null;
    const sawOutput = (): void => { firstOutputMs ??= Date.now() - started; };
    let result: KodaXStreamResult | undefined, error: string | null = null, failure: unknown;
    try {
      result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route.provider,
        input.tools.length === 1 && input.tools[0]?.name === 'report_stall_judgment' ? 'sidecar' : 'primary', currentProviderRequestAttribution(),
        () => getProvider(route.provider).stream([...input.messages], [...input.tools], input.system, reasoning,
          { ...meta.streamOptions, modelOverride: route.model, maxOutputTokensOverride: output, singleAttempt: true,
            onTextDelta: (...args) => { sawOutput(); meta.streamOptions?.onTextDelta?.(...args); },
            onThinkingDelta: (...args) => { sawOutput(); meta.streamOptions?.onThinkingDelta?.(...args); },
            onToolInputDelta: (...args) => { sawOutput(); meta.streamOptions?.onToolInputDelta?.(...args); },
          },
          AbortSignal.any([signal, AbortSignal.timeout(limits.requestMs)])), undefined, signal));
    } catch (cause: unknown) { failure = cause; error = redact(cause); }
    finally { active.delete(route.provider); }
    const attempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
    const usage = result?.usage;
    const cost = usage ? calculateCost(route.rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
    const localAuxiliaryRejection = isAuxiliaryLocalPreflight(failure, facts, input.tools.map(tool => tool.name));
    if (localAuxiliaryRejection) error = 'local-preflight: ' + error;
    const settlement = localAuxiliaryRejection
      ? { chargedTokens: 0, chargedUsd: 0, unknownUsage: false, stop: false, boundedAuxiliaryCancellation: false, localAuxiliaryRejection: true }
      : settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name), reasoning,
      outputCap: output, requestCancelled: signal.aborted, taskCancelled: meta.taskSignal?.aborted ?? false, failed: error !== null, actualUsd: cost });
    const evidence = { inputHash: inputHash(input), result, text: result?.textBlocks.map(block => block.text).join('') ?? '', toolCalls: result?.toolBlocks ?? [],
      usage: usage ?? null, estimatedUsd: cost ?? null, error, physicalRequestObservations: facts, physicalAttempts: attempts, durationMs: Date.now() - started,
      boundedAuxiliaryCancellation: settlement.boundedAuxiliaryCancellation, firstOutputMs };
    await save(label + '.json', { ...evidence, settlement }, true);
    budget.reservedTokens -= reservedTokens; budget.reservedUsd -= reservedUsd;
    if (localAuxiliaryRejection) budget.calls--;
    if (Math.abs(budget.reservedUsd) < 1e-12) budget.reservedUsd = 0;
    budget.chargedTokens += settlement.chargedTokens; budget.chargedUsd += settlement.chargedUsd;
    if (settlement.unknownUsage) budget.unknownUsageCalls++;
    await saveBudget();
    if (settlement.stop) { stopped = true; throw new Error(error ?? 'Physical attempt/usage contract failed'); }
    return evidence;
  }
  const mapping: Array<{ route: string; case: string; A: string; B: string }> = [];
  if (phase === 'pilot') {
    for (const route of routes) for (const test of manifest.frozen) {
      const reversed = randomInt(2) === 1;
      mapping.push({ route: route.id, case: test.id, A: reversed ? 'candidate' : 'baseline', B: reversed ? 'baseline' : 'candidate' });
    }
    await save('mapping.json', mapping, true);
  } else mapping.push(...JSON.parse(await fs.readFile(path.join(root, 'mapping.json'), 'utf8')) as typeof mapping);
  const outcomes = await Promise.allSettled(routes.map(async route => {
    if (phase === 'smoke') {
      await runComplexRuntime(route, path.join(root, 'smoke', route.id), (input, signal, index, meta) => {
        const projected = projectDeferredRepoLspInput(input, !input.system.includes('focused sub-agent'));
        return call(route, projected, `smoke/${route.id}/call-${index}`, signal, meta);
      }, limits.smokeCell, true, manifest.smokeTask);
      return;
    }
    for (const test of manifest.frozen) for (const arm of ['A', 'B'] as const) {
      const selected = mapping.find(row => row.route === route.id && row.case === test.id)![arm];
      const prefix = `pilot/${route.id}-${test.id}-${arm}`;
      const input = selected === 'candidate' ? projectDeferredRepoLspInput(test.input, true) : test.input;
      if (phase === 'pilot') { await call(route, input, prefix + '/call-0', AbortSignal.timeout(limits.requestMs)); continue; }
      const continuationStarted = Date.now();
      const ctx = { backups: new Map<string, string>(), executionCwd: test.workspace, gitRoot: test.workspace, repoIntelligenceMode: 'auto' as const };
      await getModuleContext(ctx, { targetPath: 'packages/cache', maxWaitMs: 15_000 });
      const preparationMs = Date.now() - continuationStarted;
      const worker = buildRunnerAgentChain(ctx).worker;
      let evidence = JSON.parse(await fs.readFile(path.join(root, prefix + '/call-0.json'), 'utf8')) as CallEvidence;
      const initialCallMs = evidence.durationMs;
      let firstNonDiscoveryResultMs: number | null = null;
      const messages: KodaXMessage[] = [...input.messages]; const receipts: unknown[] = [];
      for (let round = 1; round <= 2 && evidence.result?.toolBlocks.length; round++) {
        const response = evidence.result;
        if (receipts.length + response.toolBlocks.length > 8) throw new Error('Controlled case tool budget exhausted');
        messages.push({ role: 'assistant', content: [...response.thinkingBlocks, ...response.textBlocks, ...response.toolBlocks] });
        const results = [];
        for (const block of response.toolBlocks) {
          const toolStarted = Date.now();
          const bridge = resolveToolBridgeTarget(block); const target = bridge?.ok ? bridge.call : block;
          let content: string; let isError = true;
          const scoped = checkComplexTool(test.workspace, target.name, target.input, true);
          const permitted = target.name === 'tool_search' || ['read', 'grep', 'glob', 'code_search', 'repo_overview', 'relationship_scan', 'semantic_lookup',
            'module_context', 'symbol_context', 'process_context', 'impact_estimate', 'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_document_symbols',
            'lsp_workspace_symbols', 'lsp_incoming_calls', 'lsp_outgoing_calls', 'lsp_implementation'].includes(target.name);
          if (scoped || !permitted) content = '[Tool Error] ' + (scoped ?? 'This controlled case permits scoped readonly evidence only.');
          else {
            const tool = worker.tools?.find(candidate => candidate.name === block.name);
            const permission = await getToolExecutionOverride({}, target.name, target.input, block.id, test.workspace, test.workspace);
            if (permission !== undefined || !tool) content = permission ?? '[Tool Error] Tool is unavailable in this execution context.';
            else { const result = await tool.execute(block.input, { agent: worker, toolCallId: block.id }); content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content); isError = result.isError === true; }
          }
          results.push({ type: 'tool_result' as const, tool_use_id: block.id, content, is_error: isError });
          if (!isError && target.name !== 'tool_search') firstNonDiscoveryResultMs ??= initialCallMs + Date.now() - continuationStarted;
          receipts.push({ originalCall: block, target, content, isError, advertised: input.tools.some(tool => tool.name === block.name), durationMs: Date.now() - toolStarted });
        }
        messages.push({ role: 'user', content: results }); await save(prefix + `/receipts-${round}.json`, receipts, true);
        evidence = await call(route, { ...input, messages }, prefix + `/call-${round}`, AbortSignal.timeout(limits.requestMs));
      }
      await save(prefix + '/controlled-completion.json', { finalText: evidence.text, pendingToolCalls: evidence.result?.toolBlocks ?? [],
        receipts, complete: evidence.result?.stopReason === 'end_turn' && evidence.result.toolBlocks.length === 0,
        timing: { initialCallMs, preparationMs, continuationWallMs: Date.now() - continuationStarted,
          activeWallMs: initialCallMs + Date.now() - continuationStarted, firstNonDiscoveryResultMs,
          interpretation: 'Split-phase active wall includes generation and real tools; excludes human evidence-review delay. firstOutputMs is a streaming-delta proxy, not backend prefill time.' } }, true);
    }
  }));
  await save(phase + '-completion.json', outcomes.map(outcome => outcome.status === 'fulfilled' ? { status: 'fulfilled' } : { status: 'rejected', reason: redact(outcome.reason) }), true);
  process.stdout.write(JSON.stringify({ root, phase, stopped, budget }) + '\n');
}

const phase = process.env.KODAX_DEFERRED_EVAL_PHASE;
if (phase === 'prepare') await prepare();
else if (phase === 'pilot' || phase === 'followup' || phase === 'smoke') await run(phase);
else if (phase !== undefined) throw new Error('Unknown deferred experiment phase');
