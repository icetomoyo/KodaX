// Manual experiment. prepare is offline; paid phases require the frozen manifest hash.
import { isRunnableTool } from '@kodax-ai/agent';
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
import { projectDeferredRepoLspInput, resolveDeferredEvidenceRoot, isAuxiliaryLocalPreflight, isRejectOnlyBridgeCall, projectBridgeTeachingInput, projectLocalSearchInput } from './deferred-repo-lsp-support.js';
import { captureReadonlySearchInput, restoreSearchCheckpoint, SEARCH_REFERENCE_REVISION, UNFAMILIAR_SEARCH_CASES } from './first-turn-unfamiliar-search.js';

const experiment = process.env.KODAX_DEFERRED_EVAL_EXPERIMENT;
if (experiment !== undefined && !['manual', 'bridge', 'search', 'unfamiliar', 'unfamiliar-continuation'].includes(experiment)) throw new Error('Unknown deferred experiment');
const bridgeExperiment = experiment === 'bridge';
const continuationExperiment = experiment === 'unfamiliar-continuation';
const unfamiliarExperiment = experiment === 'unfamiliar' || continuationExperiment;
const searchExperiment = experiment === 'search' || unfamiliarExperiment;
const manualExperiment = experiment === 'manual';
const projectInput = (input: FrozenInput, root: boolean): FrozenInput =>
  searchExperiment ? projectLocalSearchInput(input, root) : bridgeExperiment ? projectBridgeTeachingInput(input, root) : projectDeferredRepoLspInput(input, root, manualExperiment ? 'manual' : 'all');
const revision = continuationExperiment ? 'unfamiliar-search-20261024-r2' : unfamiliarExperiment ? 'unfamiliar-search-20261024-r1' : searchExperiment ? 'local-search-entry-20261024-r2' : bridgeExperiment ? 'bridge-teaching-20261024-r1' : manualExperiment ? 'deferred-manual-20261024-r2' : 'deferred-repo-lsp-20261023-r3';
const root = resolveDeferredEvidenceRoot(process.env.KODAX_DEFERRED_EVAL_ROOT ?? path.join(os.tmpdir(), 'kodax-eval-dumps', revision));
const checkpointRoot = continuationExperiment ? resolveDeferredEvidenceRoot(path.join(os.tmpdir(), 'kodax-eval-dumps', 'unfamiliar-search-20261024-r1')) : undefined;
const repository = fileURLToPath(new URL('..', import.meta.url));
const limits = unfamiliarExperiment ? { pilot: { calls: continuationExperiment ? 96 : 40, tokens: continuationExperiment ? 4_500_000 : 1_800_000, usd: continuationExperiment ? 0.25 : 0.15, output: 2048 },
  smoke: { calls: 56, tokens: 2_000_000, usd: 0.30, output: 4096 }, requestMs: 120_000,
  smokeCell: { calls: 28, tools: 60, timeoutMs: 600_000 } } : bridgeExperiment || searchExperiment ? { pilot: { calls: searchExperiment ? 12 : 36, tokens: searchExperiment ? 500_000 : 1_200_000, usd: searchExperiment ? 0.05 : 0.15, output: 1536 },
  smoke: { calls: 0, tokens: 0, usd: 0, output: 1536 }, requestMs: 120_000,
  smokeCell: { calls: 0, tools: 0, timeoutMs: 0 } } : manualExperiment ? { pilot: { calls: 20, tokens: 900_000, usd: 0.20, output: 2048 },
  smoke: { calls: 56, tokens: 1_600_000, usd: 0.30, output: 4096 }, requestMs: 120_000,
  smokeCell: { calls: 28, tools: 60, timeoutMs: 600_000 } } : { pilot: { calls: 24, tokens: 600_000, usd: 0.20, output: 2048 },
  smoke: { calls: 80, tokens: 2_400_000, usd: 0.25, output: 4096 }, requestMs: 120_000,
  smokeCell: { calls: 40, tools: 80, timeoutMs: 600_000 } };
const controlledLimits = { rounds: continuationExperiment ? 12 : unfamiliarExperiment ? 5 : 3, tools: continuationExperiment ? 32 : unfamiliarExperiment ? 16 : 8 };
const routes = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
].map(route => { const rate = getCostRate(route.provider, route.model); if (!rate) throw new Error('Missing frozen reference price'); return { ...route, rate }; });
const routeSelection = process.env.KODAX_DEFERRED_EVAL_ROUTE;
if (routeSelection !== undefined && !routes.some(route => route.id === routeSelection)) throw new Error('Unknown deferred route');
const selectedRoutes = routes.filter(route => routeSelection === undefined || route.id === routeSelection);
type Route = typeof routes[number];
type Meta = { reasoning?: boolean | KodaXReasoningRequest; streamOptions?: KodaXProviderStreamOptions; taskSignal?: AbortSignal };
const bridgeTask = '请查当前 KodaX 内置手册，说明扩展默认目录和交互会话重新加载方式。只读查询后依据实际结果回答；不创建计划或派子 Agent。';
const cases = unfamiliarExperiment ? UNFAMILIAR_SEARCH_CASES : searchExperiment ? [
  { id: 'search', task: '只读核查 createCache 的 TTL 边界：追踪它从 src 公开入口到实际实现的重导出链，依据实际读取报告文件路径、到期判定条件及其与 README 契约的差异。仅限 createCache，不分析 createClient、cacheKey 或租户隔离；不要把 examples 的历史实现当作当前入口。不修改文件、不创建计划或派子 Agent。' },
] : bridgeExperiment ? [
  { id: 'ordinary', task: '只读取 README.md，说明 TTL=0 与恰好到期时的公开契约；不修改文件、不创建计划或派子 Agent。' },
  { id: 'bridge-discovered', task: bridgeTask },
  { id: 'bridge-recovery', task: bridgeTask },
] : [
  { id: 'ordinary', task: '只读取 README.md，说明 TTL=0 与恰好到期时的公开契约。不修改文件、不创建计划、不派子 Agent；请依据实际读取结果简短回答。' },
  manualExperiment
    ? { id: 'manual', task: '请查当前 KodaX 内置手册，告诉我扩展的默认安装目录、按路径加载方式，以及修改后如何在交互会话重新加载。只读查询后简短回答，标明依据；不要把其他产品的用法当作 KodaX 的契约。不修改文件、不创建计划、不派子 Agent。' }
    : { id: 'module-recovery', task: '只读预检：取得 packages/cache 的完整模块上下文，保留测试、文档、依赖和入口线索。此前错误路径被拒绝，请依据反馈自主恢复；不要修改文件、派子 Agent或编造已获取的证据。' },
];
type Frozen = { id: string; task: string; workspace: string; input: FrozenInput; files?: Record<string, string> };
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
  const checkpointHashes: Record<string, string> = {};
  if (checkpointRoot) {
    const parent = JSON.parse(await fs.readFile(path.join(checkpointRoot, 'manifest.json'), 'utf8')) as Manifest;
    if (inputHash(parent) !== '9620d4dbad16dd63b7df9a698ef7e90208731a8e895d0e2f8413749bb4ed919e') throw new Error('Unexpected parent manifest');
    for (const [file, expected] of Object.entries(parent.sourceHashes)) {
      if (['tests/deferred-repo-lsp.eval.ts', 'tests/first-turn-unfamiliar-search.ts', 'tests/first-turn-unfamiliar-search.test.ts'].includes(file)) continue;
      if (hash(await fs.readFile(path.join(repository, file))) !== expected) throw new Error('Production substrate changed: ' + file);
    }
    frozen.push(...parent.frozen);
    for (const name of ['manifest.json', 'mapping.json', 'pilot-ledger.json', 'paired-blind-review.json']) checkpointHashes[name] = hash(await fs.readFile(path.join(checkpointRoot, name)));
    for (const cell of await fs.readdir(path.join(checkpointRoot, 'pilot'))) {
      for (const name of await fs.readdir(path.join(checkpointRoot, 'pilot', cell))) {
        if (name.endsWith('.json')) { const relative = `pilot/${cell}/${name}`; checkpointHashes[relative] = hash(await fs.readFile(path.join(checkpointRoot, relative))); }
      }
    }
    await save('mapping.json', JSON.parse(await fs.readFile(path.join(checkpointRoot, 'mapping.json'), 'utf8')), true);
  }
  for (const test of checkpointRoot ? [] : cases) {
    if (unfamiliarExperiment) {
      const sourceRepository = process.env.KODAX_SEARCH_REFERENCE_REPO;
      if (!sourceRepository) throw new Error('KODAX_SEARCH_REFERENCE_REPO is required for offline capture');
      const captured = await captureReadonlySearchInput(path.join(root, 'capture', test.id), test.task, sourceRepository, SEARCH_REFERENCE_REVISION);
      frozen.push({ ...test, ...captured });
      continue;
    }
    let captured: FrozenInput | undefined;
    const directory = path.join(root, 'capture', test.id);
    await runComplexRuntime(selectedRoutes[0]!, directory, async input => {
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
    const workspace = path.join(directory, 'workspace');
    if (bridgeExperiment && test.id !== 'ordinary') {
      const worker = buildRunnerAgentChain({ backups: new Map(), executionCwd: workspace }).worker;
      const messages: KodaXMessage[] = [...captured.messages];
      const calls = [{ id: 'frozen-discovery', name: 'tool_search', input: { query: 'select:kodax_manual' } },
        ...(test.id === 'bridge-recovery' ? [{ id: 'frozen-malformed', name: 'tool_call', input: { input: { name: 'kodax_manual', input: { topic: 'extensions' } } } }] : [])];
      for (const call of calls) {
        const tool = worker.tools!.filter(isRunnableTool).find(tool => tool.name === call.name)!;
        const result = await tool.execute(call.input, { agent: worker, toolCallId: call.id });
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', ...call }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: String(result.content), is_error: result.isError === true }] });
      }
      captured = { ...projectDeferredRepoLspInput(captured, true, 'manual'), messages };
    }
    frozen.push({ ...test, workspace, input: captured });
  }
  if (searchExperiment && frozen.some(test => inputHash(test.input) === inputHash(projectInput(test.input, true)))) {
    throw new Error('Search menu comparison is now a no-op. Do not spend model budget on identical inputs; define a new experiment before preparing.');
  }
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'packages', 'tests'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  const files = [...new Set([...tracked.filter(file => /\.(?:ts|tsx|json)$/.test(file) && !file.includes('/dist/')),
    'tests/deferred-repo-lsp.eval.ts', 'tests/deferred-repo-lsp-support.ts',
    'benchmark/datasets/search-entry-complex/fixture.ts', 'package.json', 'package-lock.json'])].sort();
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await fs.readFile(path.join(repository, file)))])));
  const manifest = { revision, limits, controlledLimits, sourceHashes, routes: selectedRoutes, frozen,
    ...(checkpointRoot ? { checkpointRoot, checkpointHashes, continuationProtocol: 'User-authorized bounded whole-task continuation of every censored cell, not resampling. Keep prior five calls and receipts verbatim, resume pending calls once, stop at end_turn or total 12 generations/32 receipts. At most seven additional calls: finish queued evidence, trace missing export/caller, inspect targeted tests, reconcile edge cases, verify precise references, synthesize, report. These are budget allowances, not injected model steps. No final-answer forcing or hints. Report open-label continuation limitations and total old+new cost; prior mapping already disclosed. Same original task and permission scope. No rerun or further extension.' } : {}),
    ...(manualExperiment || unfamiliarExperiment ? { smokeTokensPerCell: 800_000 } : {}),
    rubric: `${continuationExperiment ? 'Open-label continuation (prior mapping disclosed)' : 'Blind'} main-session review: actual implementation/caller/test evidence, accurate reports and limitations, extra discovery/repair rounds, missing/incorrect tools and arguments. Compare all calls/tokens/cache/reference fee/wall time; no aggregate ship boolean. Bounded <=${controlledLimits.rounds} generations; complex smoke is not A/B.`,
    bridgeProtocol: bridgeExperiment ? 'Controlled frontier: real Runtime menu plus actual discovery/validation results. Seeded prior calls are fixed history, not paid generations. Compare completion from this identical frontier; do not label these as whole-task costs from user start. Only tool_call description differs. Ordinary control stays fully native.' : undefined,
    protocol: continuationExperiment ? 'Reuse all eight complete five-call prefixes, execute their pending calls once, then at most seven new generations per cell. User requested complete-task comparison after the five-round cutoff proved uninformative. This is a bounded observational whole-task comparison, not fixed-step causal prompt evidence; no repeated sampling, hints, retries or changed isolation.' : `First call per cell is Layer2 only. Followup reuses that raw and executes only scoped readonly production tools, then at most ${controlledLimits.rounds - 1} fixed generation steps. No retry/fallback, corrected parameters or synthetic successful tool results. Both arms use the same frozen Host input; only root schema projection differs.`,
    searchProtocol: searchExperiment ? `Whole bounded readonly task from user request. At most ${controlledLimits.rounds} generations/${controlledLimits.tools} tool receipts: discover, read implementation, trace caller/export, inspect tests/disambiguate, report (early completion allowed). No seeded discoveries or answer hints; normal Runtime repo context retained. Only builtin code_search root schema omitted; all executable tools/SDK/child menus and AMA stay intact. Unknown/unadvertised tools and scope refusals require separate review, not success. Incomplete tasks have no completed-task cost claim.` : undefined,
    smokeTask: unfamiliarExperiment ? CACHE_TASK : manualExperiment ? CACHE_TASK + '\n另请查当前 KodaX 内置手册并说明扩展的默认安装目录和交互会话重新加载方式，不能与其他产品混淆。' : CACHE_TASK + '\n另请取得 packages/cache 模块的完整模块证据（包括测试/文档线索），在最终报告说明实际获取情况；若不可用必须如实说明。',
    limitations: ['No installed real TypeScript language server in this fixture; eight LSP native/bridge transports and outputs are checked offline using the existing JSON-RPC fixture, not a compiler-quality claim.', 'Raw reservations are conservative; prices are repository coding-plan reference rates, not invoice amounts.', 'Root projection only; child/specialist menus and context reservation remain unchanged.'],
    previousRecordedHistory: { calls: 703, conservativeTokens: 14_178_522, referenceUsd: 0.6738935658, unknownUsageCalls: 27 },
    ...(manualExperiment ? { priorRevision: { id: 'deferred-manual-20261024-r1', calls: 46, tokens: 823_720,
      referenceUsd: 0.022362955, reason: 'Keep prior paired and GLM smoke evidence. Only repeat the Kimi complex case after offline rejection-feedback fixes; no model-output or permission changes.' } } : {}),
  };
  await save('manifest.json', manifest, true);
  for (const phase of ['pilot', 'smoke']) await save(phase + '-ledger.json', checkpointRoot && phase === 'pilot'
    ? JSON.parse(await fs.readFile(path.join(checkpointRoot, 'pilot-ledger.json'), 'utf8')) as BudgetSnapshot
    : { calls: 0, chargedTokens: 0, reservedTokens: 0, chargedUsd: 0, reservedUsd: 0, unknownUsageCalls: 0 } satisfies BudgetSnapshot, true);
  await save('metrics.json', frozen.map(test => ({ id: test.id, baseline: countTokens(JSON.stringify(test.input)),
    candidate: countTokens(JSON.stringify(projectInput(test.input, true))), tools: test.input.tools.length,
    projectedTools: projectInput(test.input, true).tools.length })), true);
  process.stdout.write(JSON.stringify({ prepared: true, root, manifestHash: inputHash(manifest), paidCalls: 0 }) + '\n');
}

async function run(phase: 'pilot' | 'followup' | 'smoke'): Promise<void> {
  if (continuationExperiment && phase === 'pilot') throw new Error('Reuse existing calls; resampling is forbidden');
  if ((bridgeExperiment || (searchExperiment && !unfamiliarExperiment)) && phase === 'smoke') throw new Error('Experiment is controlled only');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest & { smokeTask: string; controlledLimits: typeof controlledLimits; checkpointHashes?: Record<string, string> };
  if (manifest.revision !== revision || inputHash(manifest.limits) !== inputHash(limits)
    || inputHash(manifest.controlledLimits) !== inputHash(controlledLimits)
    || process.env.KODAX_DEFERRED_EVAL_MANIFEST_HASH !== inputHash(manifest)) throw new Error('Frozen reviewed manifest required');
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) if (hash(await fs.readFile(path.join(repository, file))) !== expected) throw new Error('Frozen source changed: ' + file);
  if (checkpointRoot) for (const [file, expected] of Object.entries(manifest.checkpointHashes ?? {})) {
    if (hash(await fs.readFile(path.join(checkpointRoot, file))) !== expected) throw new Error('Checkpoint evidence changed: ' + file);
  }
  if (inputHash(manifest.routes) !== inputHash(selectedRoutes)) throw new Error('Frozen routes changed');
  for (const test of manifest.frozen) for (const [file, expected] of Object.entries(test.files ?? {})) {
    if (hash(await fs.readFile(path.join(test.workspace, file))) !== expected) throw new Error('Frozen reference changed: ' + file);
  }
  for (const route of selectedRoutes) if (!process.env[route.env] || !getProviderModels(route.provider).includes(route.model)) throw new Error('Unavailable route ' + route.id);
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
  // Each smoke lane is serial, including root/child/auxiliary requests.
  const smokeCellTokens = new Map<string, number>();
  async function call(route: Route, input: FrozenInput, label: string, signal: AbortSignal, meta: Meta = {}): Promise<CallEvidence> {
    signal.throwIfAborted();
    if (stopped || active.has(route.provider)) throw new Error('Stopped or same-provider overlap');
    const output = Math.min(cap.output, meta.streamOptions?.maxOutputTokensOverride ?? cap.output);
    const reservedInput = Buffer.byteLength(JSON.stringify(input)) + 4096, reservedTokens = reservedInput + output;
    const reservedUsd = calculateCost(route.rate, reservedInput, output);
    if ((manualExperiment || unfamiliarExperiment) && phase === 'smoke'
      && (smokeCellTokens.get(route.id) ?? 0) + reservedTokens > 800_000) throw new Error('Frozen per-cell token budget exhausted');
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
    if ((manualExperiment || unfamiliarExperiment) && phase === 'smoke') {
      const chargedTokens = (smokeCellTokens.get(route.id) ?? 0) + settlement.chargedTokens;
      smokeCellTokens.set(route.id, chargedTokens);
      await save(`smoke/${route.id}/token-ledger.json`, { chargedTokens, maxTokens: 800_000 });
    }
    if (settlement.unknownUsage) budget.unknownUsageCalls++;
    await saveBudget();
    if (settlement.stop) { stopped = true; throw new Error(error ?? 'Physical attempt/usage contract failed'); }
    return evidence;
  }
  const mapping: Array<{ route: string; case: string; A: string; B: string }> = [];
  if (phase === 'pilot') {
    for (const route of selectedRoutes) for (const test of manifest.frozen) {
      const reversed = randomInt(2) === 1;
      mapping.push({ route: route.id, case: test.id, A: reversed ? 'candidate' : 'baseline', B: reversed ? 'baseline' : 'candidate' });
    }
    await save('mapping.json', mapping, true);
  } else if (phase === 'followup') mapping.push(...JSON.parse(await fs.readFile(path.join(root, 'mapping.json'), 'utf8')) as typeof mapping);
  const outcomes = await Promise.allSettled(selectedRoutes.map(async route => {
    if (phase === 'smoke') {
      await runComplexRuntime(route, path.join(root, 'smoke', route.id), (input, signal, index, meta) => {
        const projected = projectInput(input, !input.system.includes('focused sub-agent'));
        return call(route, projected, `smoke/${route.id}/call-${index}`, signal, meta);
      }, limits.smokeCell, true, manifest.smokeTask);
      return;
    }
    for (const test of manifest.frozen) for (const arm of ['A', 'B'] as const) {
      const selected = mapping.find(row => row.route === route.id && row.case === test.id)![arm];
      const prefix = `pilot/${route.id}-${test.id}-${arm}`;
      const input = selected === 'candidate' ? projectInput(test.input, true) : test.input;
      if (phase === 'pilot') { await call(route, input, prefix + '/call-0', AbortSignal.timeout(limits.requestMs)); continue; }
      const continuationStarted = Date.now();
      const ctx = { backups: new Map<string, string>(), executionCwd: test.workspace, gitRoot: test.workspace, repoIntelligenceMode: 'auto' as const };
      if (!manualExperiment && !bridgeExperiment && !searchExperiment) await getModuleContext(ctx, { targetPath: 'packages/cache', maxWaitMs: 15_000 });
      const preparationMs = Date.now() - continuationStarted;
      const worker = buildRunnerAgentChain(ctx).worker;
      const startRound = checkpointRoot ? 5 : 1;
      let evidence = JSON.parse(await fs.readFile(path.join(checkpointRoot ?? root, prefix + `/call-${startRound - 1}.json`), 'utf8')) as CallEvidence;
      const previousCompletion = checkpointRoot ? JSON.parse(await fs.readFile(path.join(checkpointRoot, prefix + '/controlled-completion.json'), 'utf8')) as { receipts: unknown[]; timing: { activeWallMs: number; firstNonDiscoveryResultMs: number | null } } : undefined;
      const initialCallMs = previousCompletion?.timing.activeWallMs ?? evidence.durationMs;
      let firstNonDiscoveryResultMs: number | null = null;
      const messages: KodaXMessage[] = checkpointRoot ? restoreSearchCheckpoint(JSON.parse(await fs.readFile(path.join(checkpointRoot, prefix + '/call-4.input.json'), 'utf8')) as FrozenInput, evidence) : [...input.messages];
      const receipts: unknown[] = previousCompletion?.receipts ?? [];
      firstNonDiscoveryResultMs = previousCompletion?.timing.firstNonDiscoveryResultMs ?? null;
      const taskSignal = AbortSignal.timeout(180_000);
      for (let round = startRound; round < controlledLimits.rounds && evidence.result?.toolBlocks.length; round++) {
        taskSignal.throwIfAborted();
        const response = evidence.result;
        if (receipts.length + response.toolBlocks.length > controlledLimits.tools) throw new Error('Controlled case tool budget exhausted');
        messages.push({ role: 'assistant', content: [...response.thinkingBlocks, ...response.textBlocks, ...response.toolBlocks] });
        const results = [];
        for (const block of response.toolBlocks) {
          const toolStarted = Date.now();
          const bridge = resolveToolBridgeTarget(block); const target = bridge?.ok ? bridge.call : block;
          let content: string; let isError = true;
          const scoped = checkComplexTool(test.workspace, target.name, target.input, true);
          const permitted = isRejectOnlyBridgeCall(block) || target.name === 'tool_search' || ((manualExperiment || bridgeExperiment) && target.name === 'kodax_manual') || ['read', 'grep', 'glob', 'code_search', 'repo_overview', 'relationship_scan', 'semantic_lookup',
            'module_context', 'symbol_context', 'process_context', 'impact_estimate', 'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_document_symbols',
            'lsp_workspace_symbols', 'lsp_incoming_calls', 'lsp_outgoing_calls', 'lsp_implementation'].includes(target.name);
          if (scoped || !permitted) content = '[Tool Error] ' + (scoped ?? 'This controlled case permits scoped readonly evidence only.');
          else {
            const tool = worker.tools?.filter(isRunnableTool).find(candidate => candidate.name === block.name);
            const permission = await getToolExecutionOverride({}, target.name, target.input, block.id, test.workspace, test.workspace);
            if (permission !== undefined || !tool) content = permission ?? '[Tool Error] Tool is unavailable in this execution context.';
            else { const result = await tool.execute(block.input, { agent: worker, toolCallId: block.id }); content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content); isError = result.isError === true; }
          }
          results.push({ type: 'tool_result' as const, tool_use_id: block.id, content, is_error: isError });
          if (!isError && target.name !== 'tool_search') firstNonDiscoveryResultMs ??= initialCallMs + Date.now() - continuationStarted;
          receipts.push({ originalCall: block, target, content, isError, advertised: input.tools.some(tool => tool.name === block.name), durationMs: Date.now() - toolStarted });
        }
        messages.push({ role: 'user', content: results }); await save(prefix + `/receipts-${round}.json`, receipts, true);
        evidence = await call(route, { ...input, messages }, prefix + `/call-${round}`, AbortSignal.any([taskSignal, AbortSignal.timeout(limits.requestMs)]));
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
