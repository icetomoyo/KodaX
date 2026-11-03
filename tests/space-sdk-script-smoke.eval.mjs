// Bounded Layer 3.5 smoke. Run explicitly after build; never a prompt comparison.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getProvider, registerModelProvider, runWithAdditionalProviderRequestObserver } from '../dist/sdk-llm.js';
import { runManagedTask, awaitLatestCodingMemoryReviewDrain } from '../dist/sdk-coding.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';

function observeProvider(actual, target, report, save, controller) {
  let lane = Promise.resolve();
  let closed = false;
  let budgetTokens = 0;
  const tracked = new Set();
  const accounted = new Set();
  const dispatched = new Set();
  const terminal = new Map();
  report.dispatches = [];
  report.budgetReservations = [];
  const checkBudget = () => {
    if (budgetTokens >= 500_000) controller.abort(new Error('Per-case token accounting budget reached'));
  };
  const account = (key, usage, partialUsage) => {
    if (accounted.has(key)) return;
    accounted.add(key);
    const known = usage?.totalTokens;
    const reserved = Number.isFinite(known) ? known : Math.max(100_000, partialUsage?.totalTokens ?? 0);
    budgetTokens += reserved;
    report.budgetReservations.push({ key, tokens: reserved, kind: Number.isFinite(known) ? 'reported_usage' : 'unknown_usage_reservation' });
    checkBudget();
  };
  function invoke(method, args) {
    if (closed) return Promise.reject(new Error('Smoke request admission is closed'));
    const pending = lane.then(async () => {
      if (closed) throw new Error('Smoke request admission is closed');
      controller.signal.throwIfAborted();
      if (report.rows.length >= 6 || budgetTokens >= 500_000) {
        controller.abort(new Error('Pre-registered smoke budget exhausted'));
        throw controller.signal.reason;
      }
      const [messages, tools, system, reasoning, options, signal] = args;
      const row = { index: report.rows.length, method, ...structuredClone({ messages, tools, system }),
        purpose: tools.some(tool => tool.name === 'commit_episode_learning_review') ? 'learning' : 'primary_or_auxiliary',
        startedAt: Date.now(), physicalRequestIds: [], partialOutput: { text: [], thinking: [], toolInput: [] } };
      report.rows.push(row); await save();
      const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000), ...[signal, options?.signal].filter(Boolean)]);
      let latestPhysical;
      const firstDispatch = report.dispatches.length;
      try {
        const result = await runWithAdditionalProviderRequestObserver(fact => {
          report.physicalRequestFacts.push(structuredClone(fact));
          if (fact.boundary !== 'physical_attempt') return;
          if (!row.physicalRequestIds.includes(fact.requestId)) row.physicalRequestIds.push(fact.requestId);
          if (fact.state === 'started') latestPhysical = fact;
          else {
            terminal.set(fact.requestId, fact);
            if (dispatched.has(fact.requestId)) account(fact.requestId, fact.usage, fact.partialUsage);
          }
        }, () => actual[method](messages, tools, system, reasoning, {
          ...options, modelOverride: target.model, maxOutputTokensOverride: 2048, signal: requestSignal,
          onTextDelta: text => { row.partialOutput.text.push(text); options?.onTextDelta?.(text); },
          onThinkingDelta: text => { row.partialOutput.thinking.push(text); options?.onThinkingDelta?.(text); },
          onToolInputDelta: (...delta) => { row.partialOutput.toolInput.push(structuredClone(delta)); options?.onToolInputDelta?.(...delta); },
          fetch: (input, init) => {
            requestSignal.throwIfAborted();
            if (report.dispatches.length >= 6) {
              report.blockedFetches = (report.blockedFetches ?? 0) + 1;
              controller.abort(new Error('Physical fetch budget exhausted before dispatch'));
              throw controller.signal.reason;
            }
            const requestId = latestPhysical?.requestId;
            if (requestId) dispatched.add(requestId);
            report.dispatches.push({ index: report.dispatches.length, rowIndex: row.index, requestId,
              purpose: latestPhysical?.purpose ?? row.purpose, startedAt: Date.now() });
            return (options?.fetch ?? globalThis.fetch)(input, { ...init,
              signal: AbortSignal.any([requestSignal, ...[init?.signal].filter(Boolean)]) });
          },
        }, requestSignal));
        row.result = structuredClone(result);
        return result;
      } catch (error) { row.error = String(error); throw error; }
      finally {
        const dispatches = report.dispatches.slice(firstDispatch);
        for (const dispatch of dispatches) {
          const fact = terminal.get(dispatch.requestId);
          account(dispatch.requestId ?? `unobserved-fetch-${dispatch.index}`, fact?.usage, fact?.partialUsage);
        }
        if (!dispatches.length && row.result?.usage) account(`operation-${row.index}`, row.result.usage);
        row.elapsedMs = Date.now() - row.startedAt;
        await save();
      }
    });
    lane = pending.then(() => undefined, () => undefined);
    tracked.add(pending);
    void pending.then(() => tracked.delete(pending), () => tracked.delete(pending));
    return pending;
  }
  const provider = new Proxy(actual, { get(object, key) {
    if (key === 'stream' || key === 'complete') return (...args) => invoke(key, args);
    const value = Reflect.get(object, key, object);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  return { provider,
    async idle() { while (tracked.size) await Promise.allSettled([...tracked]); },
    close() { closed = true; controller.abort(new Error('Smoke collection closed after bounded review drain')); },
    summarize() {
      const attempts = report.dispatches.map(dispatch => ({ ...dispatch, terminal: terminal.get(dispatch.requestId) ?? null }));
      const complete = attempts.filter(attempt => attempt.terminal?.usage);
      const partial = attempts.filter(attempt => !attempt.terminal?.usage && attempt.terminal?.partialUsage);
      const unknown = attempts.filter(attempt => !attempt.terminal?.usage && !attempt.terminal?.partialUsage);
      report.physicalUsage = { complete, partial, unknown,
        knownCompleteTokens: complete.reduce((sum, attempt) => sum + attempt.terminal.usage.totalTokens, 0),
        totalActualTokens: attempts.length > 0 && complete.length === attempts.length
          ? complete.reduce((sum, attempt) => sum + attempt.terminal.usage.totalTokens, 0) : null };
      report.operationUsage = report.rows.map(row => ({ index: row.index, purpose: row.purpose, usage: row.result?.usage ?? null }));
      report.budgetAccountedTokens = budgetTokens;
      report.networkRequests = report.dispatches.length;
      report.providerRequests = report.rows.length;
      report.learningRequests = report.rows.filter(row => row.purpose === 'learning').length;
      report.physicalProviderRequestsObserved = terminal.size;
    },
  };
}

function requestedTarget(targets, reports) {
  if (reports.length !== 2 || reports.some(item => item.report.scriptCellAttempts !== 0)) return undefined;
  return targets.find(target => reports.some(item => item.report.target.alias === target.alias && item.report.taskCorrect));
}

function assertObservedRoutes(env) {
  if (env.KODAX_STALL_PROVIDER && env.KODAX_STALL_MODEL) {
    throw new Error('Smoke requires inherited stall Provider; explicit stall routing would bypass the observed request budget.');
  }
}

async function finalizeGroup(completedReports, reviewDrain = awaitLatestCodingMemoryReviewDrain) {
  let drainTimer;
  let drainTimedOut = false;
  try {
    await Promise.race([
      Promise.all([reviewDrain(30_000), ...completedReports.map(item => item.observed?.idle())]),
      new Promise(resolve => { drainTimer = setTimeout(() => { drainTimedOut = true; resolve(); }, 30_000); }),
    ]);
  } finally {
    clearTimeout(drainTimer);
    for (const item of completedReports) { item.observed?.close(); clearTimeout(item.timer); }
    await Promise.all(completedReports.map(item => item.observed?.idle()));
  }
  for (const { report, save, observed, startedAt, storage, sessionId } of completedReports) {
    observed?.summarize();
    report.reviewDrain = { bestEffort: true, timeoutMs: 30_000, timedOut: drainTimedOut, admissionClosed: true, trackedRequestsSettled: true };
    const saved = storage ? await storage.load(sessionId) : undefined;
    report.records = saved?.extensionRecords ?? [];
    const records = report.records.filter(record => record.extensionId === 'kodax.script');
    report.scriptCellAttempts = records.filter(record => record.type === 'cell.started').length;
    report.scriptCellsCompleted = records.filter(record => record.type === 'cell.settled' && record.data?.data?.status === 'completed').length;
    report.scriptCellsSucceeded = records.filter(record => record.type === 'cell.settled' && record.data?.data?.status === 'completed' && record.data?.data?.hadToolErrors === false).length;
    report.scriptLeafAttempts = records.filter(record => record.type === 'call.started').length;
    report.scriptLeavesSucceeded = records.filter(record => record.type === 'call.settled' && record.data?.data?.result && record.data.data.result.isError !== true).length;
    report.scriptLeavesErrored = records.filter(record => record.type === 'call.settled' && record.data?.data?.result?.isError === true).length;
    report.scriptLeavesUnsettled = report.scriptLeafAttempts - report.scriptLeavesSucceeded - report.scriptLeavesErrored;
    report.modelSelectedOutputRequests = report.rows.flatMap(row => row.result?.toolBlocks ?? [])
      .filter(tool => tool.name === 'script_exec' && tool.input?.selected_output === true).length;
    report.elapsedMs = Date.now() - startedAt;
    report.inputHashes = report.rows.map(row => createHash('sha256').update(JSON.stringify([row.system, row.tools, row.messages])).digest('hex'));
    await save();
  }
}

// Offline exercise of the exact wrapper; never creates a real Provider or calls network fetch.
if (process.argv.includes('--self-test')) {
  const { default: assert } = await import('node:assert/strict');
  let active = 0, maximum = 0;
  const descriptor = { contextWindow: 123456 };
  const fake = { getModelDescriptor: () => descriptor,
    async stream(_messages, _tools, _system, _reasoning, options) {
      maximum = Math.max(maximum, ++active);
      await options.fetch('fixture', {}); await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, textBlocks: [], toolBlocks: [] };
    }, async complete(...args) { return this.stream(...args); } };
  const report = { rows: [], physicalRequestFacts: [] };
  const wrapped = observeProvider(fake, { model: 'fixture' }, report, async () => {}, new AbortController());
  const options = { fetch: async () => ({ ok: true }) };
  await Promise.all([wrapped.provider.stream([], [], '', false, options),
    wrapped.provider.complete([], [{ name: 'commit_episode_learning_review' }], '', false, options)]);
  assert.equal(maximum, 1); assert.equal(wrapped.provider.getModelDescriptor(), descriptor);
  assert.deepEqual(report.rows.map(row => row.method), ['stream', 'complete']);
  wrapped.close(); await wrapped.idle(); wrapped.summarize(); assert.equal(report.learningRequests, 1);
  await assert.rejects(wrapped.provider.stream([], [], '', false, options), /closed/);
  const capReport = { rows: [], physicalRequestFacts: [] };
  let fetches = 0;
  const cap = observeProvider({ async stream(_m, _t, _s, _r, options) { for (let i = 0; i < 7; i++) await options.fetch('fixture', {}); } },
    { model: 'fixture' }, capReport, async () => {}, new AbortController());
  await assert.rejects(cap.provider.stream([], [], '', false, { fetch: async () => { fetches++; } }), /fetch budget/);
  await cap.idle(); cap.summarize(); assert.equal(fetches, 6); assert.equal(capReport.blockedFetches, 1);
  assert.equal(capReport.physicalUsage.totalActualTokens, null);
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const drain = observeProvider({ async complete(_m, _t, _s, _r, options) {
    entered(); await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } }, { model: 'fixture' }, { rows: [], physicalRequestFacts: [] }, async () => {}, new AbortController());
  const waiting = drain.provider.complete([], [{ name: 'commit_episode_learning_review' }], '', false, options);
  await began; drain.close(); await assert.rejects(waiting, /collection closed/); await drain.idle();
  const targets = [{ alias: 'first' }, { alias: 'second' }];
  const natural = targets.map(target => ({ report: { target, scriptCellAttempts: 0, taskCorrect: true } }));
  assert.equal(requestedTarget(targets, [...natural].reverse()), targets[0]);
  natural[0].report.scriptCellAttempts = 1;
  assert.equal(requestedTarget(targets, natural), undefined);
  natural[0].report.scriptCellAttempts = 0; natural[0].report.taskCorrect = false;
  assert.equal(requestedTarget(targets, natural), targets[1]);
  natural[1].report.taskCorrect = false;
  assert.equal(requestedTarget(targets, natural), undefined);
  const sequence = [];
  await finalizeGroup([{ report: { rows: [] }, startedAt: Date.now(), save: async () => { sequence.push('saved'); },
    observed: { idle: async () => { sequence.push('idle'); }, close: () => { sequence.push('closed'); }, summarize: () => { sequence.push('summarized'); } },
  }], async () => { sequence.push('learning-drained'); });
  assert.deepEqual(sequence, ['learning-drained', 'idle', 'closed', 'idle', 'summarized', 'saved']);
  assertObservedRoutes({});
  assert.throws(() => assertObservedRoutes({ KODAX_STALL_PROVIDER: 'external', KODAX_STALL_MODEL: 'external' }), /bypass/);
  process.stdout.write('Offline wrapper checks passed; zero model/network requests.\n');
  process.exit(0);
}

assertObservedRoutes(process.env);
const repairArkConfig = process.argv.includes('--repair-ark-config');
if (!repairArkConfig && !process.argv.includes('--run-revision-4')) {
  throw new Error('Choose --repair-ark-config for the one-case revision 5 or explicitly replay --run-revision-4.');
}
const cases = repairArkConfig ? [
  { alias: 'ark/k27', provider: 'ark-coding', model: 'kimi-k2.7-code', apiKeyEnv: 'ARK_CODING_API_KEY', effort: 'high' },
] : [
  { alias: 'zhipu/glm52', provider: 'zhipu-coding', model: 'glm-5.2', apiKeyEnv: 'ZHIPU_CODING_API_KEY' },
  { alias: 'ark/k27', provider: 'ark-coding', model: 'kimi-k2.7-code', apiKeyEnv: 'ARK_CODING_API_KEY' },
];
const root = await mkdtemp(path.join(tmpdir(), 'kodax-script-live-'));
const dumpDir = path.join(tmpdir(), 'kodax-eval-dumps', 'space-sdk-script-20261103', path.basename(root));
await mkdir(dumpDir, { recursive: true });
const design = { revision: repairArkConfig ? 5 : 4, layer: '3.5-smoke', comparison: false, aliases: cases.map(c => c.alias),
  revisionNote: repairArkConfig
    ? 'Revision 4 raw is retained: 2 cases, 8 logical operations, 7 physical requests, 77514 actual reported tokens. GLM completed with actual Script; Ark main rejected unsupported effort none locally before any primary HTTP. Revision 5 repairs only that invalid Ark configuration with explicit supported effort high, after the Script data-cache fix. One unchanged natural task, no GLM rerun or conditional case, no A/B or lift claim. At most 6 additional requests/500000 token accounting/$6 reservation; cumulative physical ceiling 13 stays below revision 4 total ceiling 18.'
    : 'Revisions 1–4 were revised before any paid request (paid requests so far: 0). Revision 4 retains the two natural-choice tasks unchanged and pre-registers one conditional requested-Script coverage task; maximum budgets rise from 2/12/1M/$12 to 3 cases/18 physical requests/1.5M token accounting/$18 reservation. Earlier revisions preserve actual Provider descriptors, serialize stream/complete, cap physical fetches, drain all calls, distinguish unknown usage and retain native shell.',
  sdkCodingEntrySha256: createHash('sha256').update(await readFile(new URL('../dist/sdk-coding.js', import.meta.url))).digest('hex'),
  staticTextSha256: createHash('sha256').update(await readFile(new URL('../dist/static-text.json', import.meta.url))).digest('hex'),
  maxCases: repairArkConfig ? 1 : 3, maxCallsPerCell: 6, maxProviderCalls: repairArkConfig ? 6 : 18, maxRoundsPerCell: 6, maxLeafCalls: 12,
  maxOutputTokensPerCall: 2048, maxTokensPerCase: 500_000, maxTotalTokens: repairArkConfig ? 500_000 : 1_500_000, timeoutMs: 300_000,
  estimatedExternalSpendUsd: repairArkConfig ? [1, 3] : [1, 9], maxExternalSpendUsd: repairArkConfig ? 6 : 18,
  reasoningEffort: repairArkConfig ? 'high (explicit supported kimi-k2.7-code setting)' : 'SDK fixture default; original Ark primary eval-invalid',
  reservationPerCallUsd: 1, pricingNote: 'Coding-plan routes; reservation is a conservative experiment budget, not measured billing.',
  unknownUsageTokenReservation: 100_000, maxChildren: 0, reviewDrainMs: 30_000,
  fixtureConstraints: 'Temporary local data task; native bash/read/write and bridge remain usable; child tools denied; 6 logical/physical calls per case including learning, 12 tool budget, 6 turns. Restricted fixture, not population adoption.',
  auxiliaryRouting: 'Production learning and default stall sidecar reuse the wrapped Provider instance; explicit KODAX_STALL_PROVIDER plus KODAX_STALL_MODEL is rejected before requests. Direct runManagedTask fixture does not install the interactive/SDK AutoMode guardrail bootstrap; this is not an AutoMode safety evaluation. These route constraints were fixed at zero paid requests.',
  conditionalCase: repairArkConfig ? 'Disabled: one repaired Ark task only.' : 'Only when both finalized natural cases have zero actual cell.started records and at least one taskCorrect, run one selection:requested task on the first successful provider in the declared alias order. First drain/close/settle the entire natural group including learning. No third case if any natural case actually starts Script. Requested coverage is excluded from natural adoption; no rerun or A/B.',
  question: 'Does a real model finish a bounded data task, and does it actually use Script? Record requests, usage and elapsed time separately.',
  whyNotLayer1: 'Deterministic tests cannot establish autonomous tool choice or real Provider usage.',
  rubric: 'Verify totals.json equals {red:5,blue:3}; report zero-script, failures, timeout and missing usage. No population-level quality or efficiency claim.',
  concurrency: 'One request per provider, distinct natural providers parallel; conditional requested case starts after all natural request admissions close and tracked requests settle. No fallback or automatic sample reruns.' };
await writeFile(path.join(dumpDir, 'design.json'), JSON.stringify(design, null, 2));
async function runCase(target, index, selection) {
  const directory = path.join(root, String(index)); await mkdir(directory);
  const storage = new FileSessionStorage({ sessionsDir: path.join(directory, 'sessions'), configHome: directory, cwd: directory });
  await writeFile(path.join(directory, 'a.json'), JSON.stringify([{ category: 'red', count: 2 }, { category: 'blue', count: 3 }]));
  await writeFile(path.join(directory, 'b.json'), JSON.stringify([{ category: 'red', count: 3 }]));
  const file = path.join(dumpDir, `${index}.json`);
  const controller = new AbortController();
  const rows = []; const physicalRequestFacts = [];
  const startedAt = Date.now();
  const task = selection === 'requested'
    ? 'Use script_exec to read a.json and b.json, sum count per category, and write totals.json as a JSON object mapping category to total. Set selected_output:true on script_exec and return a brief selected summary from the script. Native tools remain available if needed.'
    : 'Read a.json and b.json, sum count per category, and write totals.json as a JSON object mapping category to total. Return a brief summary. Choose appropriate available tools.';
  const report = { selection, target: { alias: target.alias, provider: target.provider, model: target.model, effort: target.effort ?? null }, task,
    source: 'built SDK production runManagedTask', completed: false, taskCorrect: false, rows, physicalRequestFacts };
  let saveTail = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(report, null, 2);
    const next = saveTail.then(() => writeFile(file, snapshot)); saveTail = next; return next;
  };
  if (!process.env[target.apiKeyEnv]) {
    report.skipped = 'Configured route credential is unavailable'; await save();
    return { report, save, startedAt };
  }
  const actual = getProvider(target.provider);
  const name = `script-smoke-${index}`;
  const observed = observeProvider(actual, target, report, save, controller);
  registerModelProvider(name, () => observed.provider);
  const timer = setTimeout(() => controller.abort(new Error('Smoke execution deadline exceeded')), 300_000);
  try {
    const result = await runManagedTask({ provider: name, model: target.model, effort: target.effort, workMode: 'script', agentMode: 'ama',
      maxIter: 6, maxOutputTokens: 2048, lsp: false, abortSignal: controller.signal,
      session: { id: `smoke-${index}`, storage }, context: { executionCwd: directory, gitRoot: directory,
        configHome: directory, repoIntelligenceMode: 'off', managedWorkBudget: { totalBudget: 12, spentBudget: 0, currentHarness: 'H0_DIRECT' } },
      events: { beforeToolExecute: async tool => ['bash', 'read', 'write', 'glob', 'grep', 'tool_search', 'tool_call', 'script_exec', 'script_read', 'script_wait'].includes(tool) },
    }, task);
    report.completed = result.success; report.lastText = result.lastText;
  } catch (error) { report.error = String(error); }
  finally { report.taskElapsedMs = Date.now() - startedAt; }
  try {
    const output = JSON.parse(await readFile(path.join(directory, 'totals.json'), 'utf8'));
    report.output = output;
    report.taskCorrect = output.red === 5 && output.blue === 3 && Object.keys(output).length === 2;
  } catch { report.taskCorrect = false; }
  await save();
  return { report, save, observed, timer, startedAt, storage, sessionId: `smoke-${index}` };
}
const naturalReports = await Promise.all(cases.map((target, index) => runCase(target, index, 'natural')));
await finalizeGroup(naturalReports);
const conditionalTarget = repairArkConfig ? undefined : requestedTarget(cases, naturalReports);
const requestedReports = conditionalTarget ? [await runCase(conditionalTarget, 2, 'requested')] : [];
if (requestedReports.length) await finalizeGroup(requestedReports);
const allReports = [...naturalReports, ...requestedReports].map(item => item.report);
await writeFile(path.join(dumpDir, 'summary.json'), JSON.stringify({
  revision: design.revision, cases: allReports.length,
  naturalAdoption: { attemptedCases: naturalReports.filter(item => !item.report.skipped).length,
    casesWithActualScript: naturalReports.filter(item => item.report.scriptCellAttempts > 0).length },
  requestedCoverage: { includedInNaturalAdoption: false, ran: requestedReports.length === 1,
    alias: conditionalTarget?.alias ?? null, actualScriptCells: requestedReports[0]?.report.scriptCellAttempts ?? null,
    modelSelectedOutputRequests: requestedReports[0]?.report.modelSelectedOutputRequests ?? null },
  networkRequests: allReports.reduce((sum, report) => sum + (report.networkRequests ?? 0), 0),
  budgetAccountedTokens: allReports.reduce((sum, report) => sum + (report.budgetAccountedTokens ?? 0), 0),
  spendReservationUsd: allReports.reduce((sum, report) => sum + (report.networkRequests ?? 0), 0),
  measuredBillingUsd: null,
}, null, 2));
process.stdout.write(`Smoke evidence: ${dumpDir}\n`);
