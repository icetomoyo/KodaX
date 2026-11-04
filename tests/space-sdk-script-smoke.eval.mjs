// Bounded Layer 3.5 smoke. Run explicitly after build; never a prompt comparison.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getProvider, KodaXBaseProvider, registerModelProvider, runWithAdditionalProviderRequestObserver } from '../dist/sdk-llm.js';
import { runManagedTask, awaitLatestCodingMemoryReviewDrain } from '../dist/sdk-coding.js';
import { FileSessionStorage } from '../dist/sdk-repl.js';

function observeProvider(actual, target, report, save, controller, tokenStopThreshold = 500_000) {
  let lane = Promise.resolve();
  let closed = false;
  let budgetTokens = 0;
  const tracked = new Set();
  const accounted = new Set();
  const reservations = new Map();
  const dispatched = new Set();
  const terminal = new Map();
  report.dispatches = [];
  report.budgetReservations = [];
  const checkBudget = () => {
    if (budgetTokens >= tokenStopThreshold) controller.abort(new Error('Token accounting stop threshold reached'));
  };
  const account = (key, usage, partialUsage) => {
    if (accounted.has(key)) return;
    accounted.add(key);
    const known = usage?.totalTokens;
    const reserved = Number.isFinite(known) ? known : Math.max(100_000, partialUsage?.totalTokens ?? 0);
    const previous = reservations.get(key);
    budgetTokens += reserved - (previous?.tokens ?? 0);
    const entry = previous ?? { key };
    Object.assign(entry, { tokens: reserved, kind: Number.isFinite(known) ? 'reported_usage' : 'unknown_usage_reservation' });
    if (!previous) { reservations.set(key, entry); report.budgetReservations.push(entry); }
    checkBudget();
  };
  const reserve = key => {
    if (budgetTokens + 100_000 > tokenStopThreshold) {
      report.blockedTokenReservations = (report.blockedTokenReservations ?? 0) + 1;
      controller.abort(new Error('Per-case token reservation budget exhausted before dispatch'));
      throw controller.signal.reason;
    }
    const entry = { key, tokens: 100_000, kind: 'in_flight_reservation', reservedBeforeDispatch: 100_000 };
    budgetTokens += entry.tokens;
    reservations.set(key, entry); report.budgetReservations.push(entry);
  };
  function invoke(method, args) {
    if (closed) return Promise.reject(new Error('Smoke request admission is closed'));
    const pending = lane.then(async () => {
      if (closed) throw new Error('Smoke request admission is closed');
      controller.signal.throwIfAborted();
      if (report.rows.length >= 6 || budgetTokens >= tokenStopThreshold) {
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
            const requestId = latestPhysical && !dispatched.has(latestPhysical.requestId) ? latestPhysical.requestId : undefined;
            const accountingKey = requestId ?? `unobserved-fetch-${report.dispatches.length}`;
            reserve(accountingKey);
            if (requestId) dispatched.add(requestId);
            report.dispatches.push({ index: report.dispatches.length, rowIndex: row.index, requestId, accountingKey,
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
          account(dispatch.accountingKey, fact?.usage, fact?.partialUsage);
        }
        if (!dispatches.length && row.result?.usage) account(`operation-${row.index}`, row.result.usage);
        row.elapsedMs = Date.now() - row.startedAt;
        if (requestSignal.aborted) row.cancellation = { requestReason: String(requestSignal.reason),
          taskAborted: controller.signal.aborted, taskReason: controller.signal.aborted ? String(controller.signal.reason) : null };
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
      report.tokenStopThreshold = tokenStopThreshold;
      report.settlementOverrunTokens = Math.max(0, budgetTokens - tokenStopThreshold);
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

function revisionSixCases() {
  const glm = { alias: 'zhipu/glm52', provider: 'zhipu-coding', model: 'glm-5.2', apiKeyEnv: 'ZHIPU_CODING_API_KEY', effort: 'high' };
  const ark = { alias: 'ark/k27', provider: 'ark-coding', model: 'kimi-k2.7-code', apiKeyEnv: 'ARK_CODING_API_KEY', effort: 'high' };
  return [
    { id: 'csv-unicode', target: glm, outputFile: 'sales-summary.json',
      task: 'Read sales.csv and write sales-summary.json with totals (an object mapping customer to summed quantity) and notes (an object mapping row id to its note). Preserve customer names, CSV quoting and embedded note newlines; normalize note line endings to LF. Return a brief summary. Choose appropriate available tools.',
      inputs: { 'sales.csv': '\uFEFFid,customer,quantity,note\r\na1,"Mira, Inc",2,ready\r\na2,李雷,3,"two\r\nlines"\r\na3,"Mira, Inc",4,"said ""yes"""\r\n' },
      expected: { totals: { 'Mira, Inc': 6, 李雷: 3 }, notes: { a1: 'ready', a2: 'two\nlines', a3: 'said "yes"' } } },
    { id: 'xml-log', target: ark, outputFile: 'inventory-summary.json',
      task: 'Use catalog.xml and adjustments.log to write inventory-summary.json as an array of active catalog items, sorted by id. Each item must contain id, decoded name and adjustedStock: starting stock plus only INFO log deltas for that item. Ignore inactive items and other log levels. Return a brief summary. Choose appropriate available tools.',
      inputs: { 'catalog.xml': '<catalog>\n  <item id="u1" active="true"><name>Tea &amp; Coffee</name><stock>7</stock></item>\n  <item id="u2" active="false"><name>旧件</name><stock>99</stock></item>\n  <item id="u3" active="true"><name>蓝灯</name><stock>4</stock></item>\n</catalog>\n',
        'adjustments.log': '2026-11-04T01:00:00Z level=INFO item=u1 delta=2\n2026-11-04T01:01:00Z level=WARN item=u1 delta=10\n2026-11-04T01:02:00Z level=INFO item=u3 delta=-1\n2026-11-04T01:03:00Z level=INFO item=u2 delta=50' },
      expected: [{ id: 'u1', name: 'Tea & Coffee', adjustedStock: 9 }, { id: 'u3', name: '蓝灯', adjustedStock: 3 }] },
    { id: 'host-opaque', target: glm, outputFile: 'issue-summary.json', inputs: {},
      task: 'Use the available issue export tools to list open issues for project alpha and fetch each returned issue detail. Write issue-summary.json with issues (id, title, points, sorted by id), totalPoints, source (the list result snapshot and complete fields), and warnings (all source caveat messages preserved verbatim, with repeated messages deduplicated). Return a brief summary. Choose appropriate available tools.',
      expected: { issues: [{ id: 'ISS-17', title: 'Login, café', points: 2 }, { id: 'ISS-23', title: '修复蓝灯', points: 5 }], totalPoints: 7,
        source: { snapshot: 'alpha-20261104', complete: false },
        warnings: ['Source caveat: alpha snapshot omits archived issues; totals describe returned open rows only.', 'Detail caveat: point estimates are provisional.'] } },
  ];
}

function revisionEightCases() {
  const target = { alias: 'ark/k27', provider: 'ark-coding', model: 'kimi-k2.7-code', apiKeyEnv: 'ARK_CODING_API_KEY', effort: 'high' };
  const task = 'Use the available measurement tools to read batch obs-20261104 and its unit scale table. '
    + 'Include only observations whose eligible field is true. Multiply each included reading by the factor for its unit, '
    + 'then write measurement-summary.json with groups (group, count and scaledTotal, sorted by group), '
    + 'source (the batch snapshot and complete fields), and warnings (all source caveats preserved verbatim and deduplicated). '
    + 'Read the saved JSON to verify it, then return a brief summary. Choose appropriate available tools.';
  const sourceData = {
    batch: { snapshot: 'obs-20261104-v2', complete: false, batches: [
      { id: 'a', observations: [
        { id: 'm1', group: 'north', reading: 7, unit: 'ticks', eligible: true },
        { id: 'm2', group: 'south', reading: 4, unit: 'steps', eligible: true },
        { id: 'm3', group: 'north', reading: 6, unit: 'pulses', eligible: true },
        { id: 'm4', group: 'east', reading: 9, unit: 'ticks', eligible: true },
        { id: 'm5', group: 'south', reading: 5, unit: 'pulses', eligible: true },
        { id: 'm6', group: 'east', reading: 3, unit: 'steps', eligible: true },
      ] },
      { id: 'b', observations: [
        { id: 'm7', group: 'north', reading: 2, unit: 'steps', eligible: false },
        { id: 'm8', group: 'south', reading: 8, unit: 'ticks', eligible: true },
        { id: 'm9', group: 'east', reading: 4, unit: 'pulses', eligible: true },
        { id: 'm10', group: 'north', reading: 11, unit: 'ticks', eligible: true },
        { id: 'm11', group: 'east', reading: 100, unit: 'ticks', eligible: false },
        { id: 'm12', group: 'south', reading: 2, unit: 'steps', eligible: false },
      ] },
    ] },
    scaleTable: { factors: { ticks: 2, steps: 5, pulses: 3 } },
  };
  const expected = { groups: [
    { group: 'east', count: 3, scaledTotal: 45 },
    { group: 'north', count: 3, scaledTotal: 54 },
    { group: 'south', count: 3, scaledTotal: 51 },
  ], source: { snapshot: 'obs-20261104-v2', complete: false }, warnings: [
    'Batch caveat: late observations are excluded; complete is false.',
    'Scale caveat: factors are provisional calibration values.',
  ] };
  return [
    { id: 'measurement-requested', selection: 'requested', workMode: 'script',
      task: `For this acceptance task, use Script to obtain the source data, perform the computation, save the result and read it back. ${task}` },
    { id: 'measurement-natural-script', selection: 'natural', workMode: 'script', task },
    { id: 'measurement-native-coding', selection: 'native', workMode: 'coding', task },
  ].map(condition => ({ ...condition, kind: 'measurement', target, inputs: {}, sourceData,
    outputFile: 'measurement-summary.json', expected }));
}

function revisionNineCases() {
  const [requested, natural, native] = revisionEightCases();
  return [
    { ...requested, task: 'For this acceptance task, use Script to obtain the source data and compute directly from the values returned by tools inside Script, '
      + `save the result and read it back; do not copy source records into generated code. ${natural.task}` },
    native,
  ];
}

function revisionTenCases() {
  const requested = { ...revisionNineCases()[0], describeOutputSchemas: true };
  const rows = [
    { id: 'r1', revision: 2, team: 'core', units: 5, unit: 'tick', active: true, note: '新版本' },
    { id: 'r2', revision: 1, team: 'core', units: 3, unit: 'credit', active: true, note: 'two\nlines' },
    { id: 'r3', revision: 1, team: 'edge', units: 4, unit: 'tick', active: true, note: 'said "yes"' },
    { id: 'r4', revision: 1, team: 'ops', units: -2, unit: 'credit', active: true, note: 'refund' },
    { id: 'r5', revision: 1, team: 'edge', units: 100, unit: 'tick', active: true, note: 'superseded' },
    { id: 'r6', revision: 1, team: 'core', units: 7, unit: 'credit', active: false, note: 'inactive' },
    { id: 'r7', revision: 1, team: 'ops', units: 6, unit: 'tick', active: true, note: 'café' },
    { id: 'r8', revision: 1, team: 'edge', units: 1, unit: 'credit', active: true, note: '蓝灯🌱' },
    { id: 'r9', revision: 1, team: 'core', units: 4, unit: 'tick', active: true, note: '  keep spaces  ' },
    { id: 'r10', revision: 1, team: 'ops', units: 3, unit: 'credit', active: true, note: '' },
    { id: 'r11', revision: 1, team: 'edge', units: 8, unit: 'tick', active: true, note: 'edge' },
    { id: 'r12', revision: 1, team: 'core', units: -1, unit: 'credit', active: true, note: 'correction' },
    { id: 'r1', revision: 1, team: 'ops', units: 99, unit: 'tick', active: true, note: 'older row arrives last' },
    { id: 'r5', revision: 2, team: 'edge', units: 10, unit: 'tick', active: false, note: 'retired' },
  ];
  const task = 'Read events.ndjson and weights.json. For each event id keep the row with the highest revision, '
    + 'then include only rows whose active field is true. Multiply units by the factor for its unit. '
    + 'Write event-summary.json with groups (team, count and total, sorted by team), '
    + 'source (snapshot from weights.json, latestCount before filtering and includedCount), '
    + 'and notes (an object mapping included id to its exact note string). '
    + 'Read the saved JSON to verify it, then return a brief summary. Choose appropriate available tools.';
  const inputs = { 'events.ndjson': rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'weights.json': JSON.stringify({ snapshot: 'weights-20261104', factors: { tick: 2, credit: 5 } }) };
  const expected = { groups: [{ team: 'core', count: 4, total: 28 }, { team: 'edge', count: 3, total: 29 }, { team: 'ops', count: 3, total: 17 }],
    source: { snapshot: 'weights-20261104', latestCount: 12, includedCount: 10 },
    notes: { r1: '新版本', r2: 'two\nlines', r3: 'said "yes"', r4: 'refund', r7: 'café', r8: '蓝灯🌱',
      r9: '  keep spaces  ', r10: '', r11: 'edge', r12: 'correction' } };
  return [requested, ...[
    { id: 'events-natural-script', selection: 'natural', workMode: 'script' },
    { id: 'events-native-coding', selection: 'native', workMode: 'coding' },
  ].map(condition => ({ ...condition, target: requested.target, task, inputs, expected, outputFile: 'event-summary.json' }))];
}

function measurementOutputSchemas() {
  return {
    'measurements.read-batch': { type: 'object', required: ['snapshot', 'complete', 'batches'], properties: {
      snapshot: { type: 'string' }, complete: { type: 'boolean' }, batches: { type: 'array', items: { type: 'object',
        required: ['id', 'observations'], properties: { id: { type: 'string' }, observations: { type: 'array', items: {
          type: 'object', required: ['id', 'group', 'reading', 'unit', 'eligible'], properties: { id: { type: 'string' },
            group: { type: 'string' }, reading: { type: 'number' }, unit: { type: 'string' }, eligible: { type: 'boolean' } },
        } } } } } } },
    'measurements.scale-table': { type: 'object', required: ['factors'], properties: {
      factors: { type: 'object', additionalProperties: { type: 'number' } } } },
  };
}

function measurementToolDefinitions() {
  return [
    { name: 'measurements.read-batch', description: 'Read a measurement batch by batch id. Returns nested observations, snapshot, completeness and a source caveat.',
      inputSchema: { type: 'object', properties: { batch: { type: 'string' } }, required: ['batch'] } },
    { name: 'measurements.scale-table', description: 'Read the unit calibration factor table for a measurement batch, with a source caveat.',
      inputSchema: { type: 'object', properties: { batch: { type: 'string' } }, required: ['batch'] } },
  ];
}

function revisionEightDesign(fixtures) {
  return {
    revision: 8, sourceBaseline: '532243a27', layer: '3.5-smoke', comparison: false,
    maxCases: 3, maxProviderCalls: 18, maxCallsPerCell: 6, maxRoundsPerCell: 6,
    maxOutputTokensPerCall: 2048, maxTokensPerCase: 500_000, maxTotalTokens: 1_500_000,
    maxExternalSpendUsd: 18, estimatedExternalSpendUsd: [1, 9], timeoutMs: 300_000,
    revisionNote: 'Three fixed conditions of one new measurement task: explicitly requested Script coverage, natural Script mode, and native coding mode. All share source data, expected artifact and Ark route/effort. Requested coverage is excluded from natural adoption. Old XML and Host failures remain intact; no old task is rerun to obtain success. No production prompt or tool contract changes.',
    reasoningEffort: 'ark/k27 high, identical in all three conditions',
    conditionalCase: 'Disabled. All three predeclared conditions run once, regardless of Script choice, task outcome or missing credentials. No fallback or additional sample.',
    question: 'Can the model obtain structured source data, calculate from it inside Script, save and read back the result when explicitly requested? Separately observe natural Script usage and the same natural task in coding mode, with actual correctness, requests, tokens and time.',
    whyNotLayer1: 'Offline built-SDK checks establish JSON computation, write/readback, exact modes, scorer and no-network budgets. They cannot establish that a real model authors and actually executes the computation. The two natural conditions observe mode costs; a single sample cannot establish an efficiency gain or generalization.',
    rubric: 'Artifact correctness is independent of Script choice. Main session traces actual executed code, original receipts and write/read dependencies to distinguish JSON computation from printing DTOs or reconstructing literals. Requested completion via native tools alone does not establish requested Script coverage. Natural Script and native coding are descriptive matched-task observations, not prompt A/B or causal lift evidence. Keep all failures, zero-script, timeout and missing usage.',
    fixtureConstraints: 'Same nested measurement batch and independent scale table from authorized readonly Host tools in all conditions; source values are not in the user task. Same native bridge/bash/read/write/search hook allowlist, shared 12 billed-leaf work budget, zero children and unchanged production Script VM limits. Only explicit-coverage user prefix and declared work mode differ. Public SDK embedder fixture, no daemon lease, real external service or AutoMode-safety coverage.',
    concurrency: 'One Ark provider lane. Run requested Script, natural Script and native coding sequentially; drain learning, close admissions and settle every tracked request before the next condition. Each has at most six operations and six physical HTTP including learning/retries, at most 500000 token accounting; aggregate at most 18 HTTP, 1500000 token accounting and $18 reservation. No sample retry or extra condition.',
    modeCostInterpretation: 'Compare only the two identical natural user tasks descriptively. If the Script-mode model does not actually use Script, these are configuration costs, not Script-execution efficiency. Requested coverage is never pooled into natural adoption or used as an efficiency arm. Same fixture does not remove model randomness, order or cache effects.',
    toolDefinitions: measurementToolDefinitions().map(tool => ({ ...tool,
      capabilityId: `host:script-smoke:${tool.name}`, sideEffect: 'readonly', planModeAllowed: true })),
    caseDefinitions: fixtures.map(({ id, kind, target, selection, workMode, task, inputs, sourceData, outputFile, expected }) =>
      ({ id, kind, target, selection, workMode, task, inputs, sourceData, outputFile, expected })),
  };
}

function revisionNineDesign(fixtures) {
  return {
    ...revisionEightDesign(fixtures), revision: 9,
    maxCases: 2, maxProviderCalls: 12, maxTotalTokens: 1_000_000,
    maxExternalSpendUsd: 12, estimatedExternalSpendUsd: [1, 6],
    revisionNote: 'Two affected conditions only after generic product corrections: the code contract now explains awaiting or returning async helpers before the cell body finishes, and Anthropic wire tool names are encoded compatibly. Reuse revision 8 measurement data, schemas, expected artifact and Ark route/effort. The requested prefix now explicitly distinguishes computation from copying source records into generated code; it gives no API field, solution or output literal. Do not rerun natural Script. Revision 8 raw, failures and costs remain separate. This is not a prompt A/B or efficiency comparison.',
    reasoningEffort: 'ark/k27 high, unchanged for both conditions',
    conditionalCase: 'Disabled. Exactly requested Script and native coding, once each regardless of outcome. No fallback, sample retry or additional condition.',
    question: 'With the corrected production input, does requested Script compute directly from tool-returned values and save/read back a correct artifact? Separately, does native coding retain working authorized tools through the actual Anthropic wire path?',
    whyNotLayer1: 'Actual VM and captured HTTP payload tests establish lifecycle and reversible wire-name semantics at zero model cost. They cannot show that a real model authors the requested computation or that the real gateway accepts the new native tool wire names. Only the two conditions affected by those changes are repeated; the prior natural sample is retained.',
    rubric: 'Review every executed cell and original receipt to trace source values into computed output and committed readback. Returning DTOs or copying source records into generated code does not establish requested Script computation. Artifact correctness and actual native tool execution are separate observations. Keep failure, unknown effects, missing usage and native fallback. Conditions differ in task prefix and mode; no efficiency, lift or generalization comparison.',
    concurrency: 'One Ark provider lane. Run requested Script then native coding, with bounded learning drain, closed admission and settled tracked calls before the second condition. Each permits at most six operations and six physical HTTP including learning/retries and 500000 token accounting; the new segment permits at most 12 HTTP, 1000000 token accounting and $12 reservation. No sample retry or extra condition.',
    modeCostInterpretation: 'Record actual token and time per condition only. The distinct requested user prefix and coding mode prevent an efficiency comparison. Do not pool these conditions with revision 8 adoption or correctness rates.',
    previousRevision: { revision: 8, evidenceDirectory: 'space-sdk-script-mode-acceptance-20261104/kodax-script-live-Brxwok',
      actualHttpRequests: 15, actualReportedTokens: null, originalMaxProviderCalls: 18,
      originalMaxTotalTokens: 1_500_000, originalMaxExternalSpendUsd: 18,
      note: 'All revision 8 raw and failures remain unchanged. Native usage was incomplete; no total actual token figure is inferred from budget accounting. Unused budget is not transferred.' },
    cumulativeKnownBudget: { previousActualHttpRequests: 15, newSegmentMaxHttpRequests: 12, maxCombinedHttpRequests: 27,
      newSegmentMaxTokenAccounting: 1_000_000, newSegmentMaxExternalSpendUsd: 12 },
  };
}

function revisionTenDesign(fixtures) {
  return { ...revisionEightDesign(fixtures), revision: 10, sourceBaseline: 'e177e0ce98a7e3f38653389382554ffadd31c7bc', reviewDrainMs: 120_000,
    revisionNote: 'Final candidate smoke after isolated sourceContent and on-demand Host outputSchema changes. Reuse the exact revision 9 requested task and strict expected artifact; add one different NDJSON task with identical natural Script/coding conditions. Historical failures remain separate. No production prompt change, sample retry, fallback or extra case.',
    conditionalCase: 'Disabled. The three fixed conditions run once in declared order regardless of outcome. A missing credential is a skip, not a fallback.',
    question: 'Does the final candidate support actual model-authored Script computation, exact-source delivery and persisted readback? Separately observe natural choice and task/cost behavior on a different data format in Script and coding modes.',
    whyNotLayer1: 'Existing VM, independent Host and tarball regressions prove the interfaces. They cannot show real model selection, generated data dependencies, task correctness or physical usage/time. This is a bounded one-family pilot, not a prompt comparison or general intelligence proof.',
    rubric: 'Score artifacts independently of tool choice. Review every original cell, leaf receipt, Session message and saved file. Trace JSON/text parsing into computation and Script write/readback; distinguish returning readback from verifying it. Record direct sourceContent use, rendered-text parsing, schema queried/not queried, native fallback, warnings, failures and missing usage. Requested coverage is excluded from natural adoption. Do not require optional discovery or Script in the natural task.',
    fixtureConstraints: 'Requested measurement fixture and strict warnings are unchanged from revision 9; only truthful output schemas are available through existing authorized describe. The natural task uses out-of-order NDJSON revisions, inactive records, negative adjustments and exact Unicode/whitespace notes. Natural tasks, files and expected values are identical across modes. Keep the same native allowlist and 12 billed-leaf budget, zero children and production VM limits. Embedded public SDK; independent Host mechanism was tested separately, no deployed Space or external service claim.',
    concurrency: 'One Ark lane, requested Script then natural Script then natural coding, each drained/closed before the next. Per condition: six operations/physical fetches/rounds including learning, 500000 token stop threshold, 2048 output tokens, 120s request and 300s execution deadline from task start. Collection waits at most 120s without resetting execution deadline. At most 18 fetches and $18 conservative reservation; aggregate token stop threshold 1500000. Unknown fetches reserve 100000 before dispatch and settle by physical identity; actual usage is never clipped, a single settlement may overrun the stop threshold and is reported. Later conditions receive at most the remaining aggregate threshold; exhausted conditions skip. No production learning/stall disabled.',
    modeCostInterpretation: 'Record B/C identical-task costs descriptively only. One sample per mode, ordering/cache effects and one family preclude causal efficiency or overall intelligence conclusions. Zero actual Script in B means configuration cost only; incomplete usage forbids token saving rates. Requested A is never an efficiency arm.',
    onDemandOutputSchemas: measurementOutputSchemas(),
    caseDefinitions: fixtures.map(({ id, kind, target, selection, workMode, task, inputs, sourceData, outputFile, expected, describeOutputSchemas }) =>
      ({ id, kind, target, selection, workMode, task, inputs, sourceData, outputFile, expected, describeOutputSchemas })),
    previousRevision: { revision: 9, evidenceDirectory: 'space-sdk-script-lifecycle-acceptance-20261104/kodax-script-live-bSSrzt',
      actualHttpRequests: 11, knownCompleteTokens: 128_460, partialRequests: 3, totalActualTokens: null,
      note: 'Keep old task failures and incomplete usage unchanged; no pooled correctness, no unused budget transfer.' },
  };
}

async function prepareRevisionSixCase(fixture, directory, report) {
  report.fixtureInputs = fixture.inputs;
  for (const [name, body] of Object.entries(fixture.inputs)) await writeFile(path.join(directory, name), body);
  const measurement = fixture.kind === 'measurement';
  if (!measurement && fixture.id !== 'host-opaque') return undefined;
  if (measurement) report.fixtureSourceData = fixture.sourceData;
  const rows = [
    { id: 'ISS-17', project: 'alpha', state: 'open', title: 'Login, café', points: 2 },
    { id: 'ISS-23', project: 'alpha', state: 'open', title: '修复蓝灯', points: 5 },
    { id: 'ISS-41', project: 'alpha', state: 'closed', title: 'Archived', points: 80 },
    { id: 'ISS-99', project: 'beta', state: 'open', title: 'Other project', points: 90 },
  ];
  const definitions = (measurement ? measurementToolDefinitions() : [
    { name: 'exports.issue-list', description: 'List issue ids for a project and state. Returns a TSV listing with source caveats and separate structured snapshot/completeness fields.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] } }, required: ['project', 'state'] } },
    { name: 'exports.issue-detail', description: 'Read one issue by id. Returns structured id/title/points and a separate source caveat.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  ]).map(tool => ({ ...tool, capabilityId: `host:script-smoke:${tool.name}`, sideEffect: 'readonly', planModeAllowed: true }));
  report.hostInvocations = [];
  report.hostDescriptions = [];
  const lookup = (provider, id) => {
    const definition = provider === 'mcp' && definitions.find(tool => tool.capabilityId === id);
    if (!definition) throw new Error(`Host capability is not authorized: ${provider}/${id}`);
    return definition;
  };
  const unsupported = async () => { throw new Error('Host fixture operation is not authorized'); };
  return {
    hasCapabilityProvider: provider => provider === 'mcp',
    listCapabilityProviders: () => [{ id: 'mcp', search: async () => definitions }],
    listRunTools: provider => provider === 'mcp' ? definitions : [],
    searchCapabilities: async (provider, query) => provider === 'mcp'
      ? definitions.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))
        .map(tool => ({ id: tool.capabilityId, kind: 'tool', name: tool.name, description: tool.description })) : [],
    describeCapability: async (provider, id) => {
      const definition = lookup(provider, id);
      const descriptor = fixture.describeOutputSchemas ? { ...definition, id: definition.capabilityId, kind: 'tool', server: 'script-smoke',
        outputSchema: measurementOutputSchemas()[definition.name] } : definition;
      report.hostDescriptions.push({ provider, id, descriptor: structuredClone(descriptor) });
      return descriptor;
    },
    async executeCapability(provider, id, input) {
      const invocation = { provider, id, input: structuredClone(input) };
      report.hostInvocations.push(invocation);
      try {
        const definition = lookup(provider, id);
        let result;
        if (measurement) {
          if (input.batch !== 'obs-20261104') throw new Error('Unknown measurement batch');
          const batchResult = definition.name === 'measurements.read-batch';
          result = { kind: 'tool', content: fixture.expected.warnings[batchResult ? 0 : 1],
            structuredContent: structuredClone(batchResult ? fixture.sourceData.batch : fixture.sourceData.scaleTable) };
        } else if (definition.name === 'exports.issue-list') {
          if (typeof input.project !== 'string' || !['open', 'closed'].includes(input.state)) throw new Error('project and state are required');
          const selected = rows.filter(row => row.project === input.project && row.state === input.state);
          result = { kind: 'tool', content: `${fixture.expected.warnings[0]}\nid\tstate\n${selected.map(row => `${row.id}\t${row.state}`).join('\n')}`,
            structuredContent: { snapshot: 'alpha-20261104', complete: false }, metadata: { source: 'offline Host fixture' } };
        } else {
          const row = rows.find(item => item.id === input.id);
          if (!row) throw new Error('Unknown issue id');
          result = { kind: 'tool', content: fixture.expected.warnings[1], structuredContent: { id: row.id, title: row.title, points: row.points } };
        }
        invocation.result = structuredClone(result);
        return result;
      } catch (error) { invocation.error = String(error); throw error; }
    },
    readCapability: unsupported, getCapabilityPrompt: unsupported,
    getCapabilityPromptContext: async () => undefined,
  };
}

async function checkRevisionSixOutput(fixture, directory) {
  try {
    const output = JSON.parse(await readFile(path.join(directory, fixture.outputFile), 'utf8'));
    const normalize = value => (fixture.id === 'host-opaque' || fixture.kind === 'measurement') && Array.isArray(value?.warnings)
      ? { ...value, warnings: [...value.warnings].sort() } : value;
    return { output, taskCorrect: isDeepStrictEqual(normalize(output), normalize(fixture.expected)) };
  } catch (error) { return { taskCorrect: false, outputError: String(error) }; }
}

function scriptCoverage(records) {
  const dataAvailableReceipts = records.filter(record => record.type === 'call.settled'
    && ['text', 'json'].includes(record.data?.data?.result?.data?.kind))
    .map(record => ({ recordId: record.id ?? null, name: record.data.data.name, input: record.data.data.input, kind: record.data.data.result.data.kind }));
  return { dataAvailableReceipts, jsonDataAvailableReceipts: dataAvailableReceipts.filter(receipt => receipt.kind === 'json'),
    dataConsumption: 'unreviewed', jsonDataConsumption: 'unreviewed',
    note: 'Data availability or source syntax does not prove consumption. Main-session review must trace executed cells and output dependencies using full canonical records.' };
}

async function finalizeGroup(completedReports, reviewDrain = awaitLatestCodingMemoryReviewDrain, drainTimeoutMs = 30_000) {
  let drainTimer;
  let drainTimedOut = false;
  try {
    await Promise.race([
      Promise.all([reviewDrain(drainTimeoutMs), ...completedReports.map(item => item.observed?.idle())]),
      new Promise(resolve => { drainTimer = setTimeout(() => { drainTimedOut = true; resolve(); }, drainTimeoutMs); }),
    ]);
  } finally {
    clearTimeout(drainTimer);
    for (const item of completedReports) { item.observed?.close(); clearTimeout(item.timer); }
    await Promise.all(completedReports.map(item => item.observed?.idle()));
  }
  for (const { report, save, observed, startedAt, storage, sessionId } of completedReports) {
    observed?.summarize();
    report.reviewDrain = { bestEffort: true, timeoutMs: drainTimeoutMs, timedOut: drainTimedOut, admissionClosed: true, trackedRequestsSettled: true };
    const saved = storage ? await storage.load(sessionId) : undefined;
    report.records = saved?.extensionRecords ?? [];
    report.sessionMessages = saved?.messages ?? [];
    const records = report.records.filter(record => record.extensionId === 'kodax.script');
    report.scriptCellAttempts = records.filter(record => record.type === 'cell.started').length;
    report.scriptCellsCompleted = records.filter(record => record.type === 'cell.settled' && record.data?.data?.status === 'completed').length;
    report.scriptCellsSucceeded = records.filter(record => record.type === 'cell.settled' && record.data?.data?.status === 'completed' && record.data?.data?.hadToolErrors === false).length;
    report.scriptLeafAttempts = records.filter(record => record.type === 'call.started').length;
    report.scriptLeavesSucceeded = records.filter(record => record.type === 'call.settled' && record.data?.data?.result && record.data.data.result.isError !== true).length;
    report.scriptLeavesErrored = records.filter(record => record.type === 'call.settled' && record.data?.data?.result?.isError === true).length;
    report.scriptLeavesUnsettled = report.scriptLeafAttempts - report.scriptLeavesSucceeded - report.scriptLeavesErrored;
    report.scriptCoverage = scriptCoverage(records);
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
  let unexpectedNetworkCalls = 0;
  globalThis.fetch = async () => { unexpectedNetworkCalls++; throw new Error('Offline self-test forbids network'); };
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
  await assert.rejects(cap.provider.stream([], [], '', false, { fetch: async () => { fetches++; } }), /budget/i);
  await cap.idle(); cap.summarize(); assert.equal(fetches, 5);
  assert.equal(capReport.budgetAccountedTokens, 500_000);
  assert.equal(capReport.physicalUsage.totalActualTokens, null);
  let knownOperations = 0, afterKnownFetches = 0;
  const knownReport = { rows: [], physicalRequestFacts: [] };
  const known = observeProvider({ async stream(_m, _t, _s, _r, request) {
    if (knownOperations++ === 0) return { usage: { inputTokens: 489_999, outputTokens: 1, totalTokens: 490_000 } };
    await request.fetch('fixture', {});
  } }, { model: 'fixture' }, knownReport, async () => {}, new AbortController());
  await known.provider.stream([], [], '', false, options);
  await assert.rejects(known.provider.stream([], [], '', false, { fetch: async () => { afterKnownFetches++; } }), /budget/i);
  await known.idle(); known.summarize();
  assert.equal(afterKnownFetches, 0);
  assert.equal(knownReport.budgetAccountedTokens, 490_000);
  assert.match(knownReport.rows[1].cancellation.taskReason, /reservation budget/);
  const overrunReport = { rows: [], physicalRequestFacts: [] };
  const overrun = observeProvider({ async stream() {
    return { usage: { inputTokens: 539_999, outputTokens: 1, totalTokens: 540_000 } };
  } }, { model: 'fixture' }, overrunReport, async () => {}, new AbortController());
  await overrun.provider.stream([], [], '', false, options);
  await assert.rejects(overrun.provider.stream([], [], '', false, options), /threshold/);
  await overrun.idle(); overrun.summarize();
  assert.equal(overrunReport.budgetAccountedTokens, 540_000);
  assert.equal(overrunReport.settlementOverrunTokens, 40_000);
  assert.equal(overrunReport.rows[0].result.usage.totalTokens, 540_000);
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
  const collection = { rows: [] };
  const messages = [{ role: 'assistant', content: 'Complete persisted evidence.' }];
  await finalizeGroup([{ report: collection, startedAt: Date.now(), save: async () => {},
    storage: { load: async () => ({ messages }) }, sessionId: 'offline-collection' }], async timeoutMs => {
    assert.equal(timeoutMs, 120_000);
  }, 120_000);
  assert.equal(collection.reviewDrain.timeoutMs, 120_000);
  assert.deepEqual(collection.sessionMessages, messages);
  assertObservedRoutes({});
  assert.throws(() => assertObservedRoutes({ KODAX_STALL_PROVIDER: 'external', KODAX_STALL_MODEL: 'external' }), /bypass/);
  const revisionSix = revisionSixCases();
  assert.equal(revisionSix.length, 3);
  assert.deepEqual(revisionSix.map(item => item.target.alias), ['zhipu/glm52', 'ark/k27', 'zhipu/glm52']);
  assert.ok(revisionSix.every(item => item.target.effort === 'high' && !item.task.includes('script_exec')));
  const revisionEight = revisionEightCases();
  assert.deepEqual(revisionEight.map(item => [item.selection, item.workMode]),
    [['requested', 'script'], ['natural', 'script'], ['native', 'coding']]);
  assert.ok(revisionEight.every(item => item.target.alias === 'ark/k27' && item.target.effort === 'high'));
  assert.equal(revisionEight[1].task, revisionEight[2].task);
  assert.ok(revisionEight[0].task.endsWith(revisionEight[1].task));
  assert.ok(!revisionEight[1].task.includes('Script'));
  assert.ok(!revisionEight[0].task.includes('data.value') && !revisionEight[0].task.includes('selected_output'));
  assert.deepEqual(revisionEight[0].sourceData, revisionEight[2].sourceData);
  assert.deepEqual(revisionEight[0].expected, revisionEight[2].expected);
  const revisionNine = revisionNineCases();
  assert.deepEqual(revisionNine.map(item => [item.selection, item.workMode]), [['requested', 'script'], ['native', 'coding']]);
  assert.equal(revisionNine[1].task, revisionEight[2].task);
  assert.ok(revisionNine[0].task.endsWith(revisionEight[1].task));
  assert.ok(revisionNine[0].task.includes('compute directly from the values returned by tools inside Script'));
  assert.ok(revisionNine[0].task.includes('do not copy source records into generated code'));
  assert.ok(!revisionNine[0].task.includes('data.value') && !revisionNine[0].task.includes('selected_output'));
  for (const fixture of revisionNine) {
    assert.deepEqual(fixture.sourceData, revisionEight[0].sourceData);
    assert.deepEqual(fixture.expected, revisionEight[0].expected);
    assert.deepEqual(fixture.target, revisionEight[0].target);
  }
  const designNine = revisionNineDesign(revisionNine);
  assert.equal(designNine.revision, 9);
  assert.equal(designNine.maxCases, 2);
  assert.equal(designNine.maxProviderCalls, 12);
  assert.equal(designNine.maxTotalTokens, 1_000_000);
  assert.equal(designNine.maxExternalSpendUsd, 12);
  assert.equal(designNine.cumulativeKnownBudget.maxCombinedHttpRequests, 27);
  assert.deepEqual(designNine.toolDefinitions, revisionEightDesign(revisionEight).toolDefinitions);
  assert.deepEqual(designNine.caseDefinitions.map(fixture => [fixture.selection, fixture.workMode]), [['requested', 'script'], ['native', 'coding']]);
  const modeDesign = revisionEightDesign(revisionEight);
  assert.equal(modeDesign.revision, 8);
  assert.equal(modeDesign.maxProviderCalls, 3 * modeDesign.maxCallsPerCell);
  assert.equal(modeDesign.maxTotalTokens, 3 * modeDesign.maxTokensPerCase);
  assert.equal(modeDesign.maxExternalSpendUsd, 18);
  assert.equal(modeDesign.comparison, false);
  assert.deepEqual(modeDesign.caseDefinitions.map(item => item.workMode), ['script', 'script', 'coding']);
  assert.deepEqual(modeDesign.caseDefinitions[1].sourceData, modeDesign.caseDefinitions[2].sourceData);
  const revisionTen = revisionTenCases();
  const designTen = revisionTenDesign(revisionTen);
  assert.equal(designTen.revision, 10);
  assert.equal(designTen.reviewDrainMs, 120_000);
  assert.deepEqual(revisionTen.map(item => [item.selection, item.workMode]), [['requested', 'script'], ['natural', 'script'], ['native', 'coding']]);
  assert.equal(revisionTen[0].task, revisionNine[0].task);
  assert.deepEqual(revisionTen[0].expected, revisionNine[0].expected);
  assert.deepEqual(revisionTen[0].sourceData, revisionNine[0].sourceData);
  assert.equal(revisionTen[1].task, revisionTen[2].task);
  assert.ok(!revisionTen[1].task.includes('Script'));
  assert.deepEqual(revisionTen[1].inputs, revisionTen[2].inputs);
  assert.deepEqual(revisionTen[1].expected, revisionTen[2].expected);
  assert.equal(designTen.maxProviderCalls, 18);
  assert.equal(designTen.maxTotalTokens, 1_500_000);
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'kodax-script-offline-'));
  for (const fixture of revisionTen) {
    const directory = path.join(fixtureDirectory, `revision-ten-${fixture.id}`); await mkdir(directory);
    const runtime = await prepareRevisionSixCase(fixture, directory, {});
    if (fixture.describeOutputSchemas) {
      assert.ok(runtime.listRunTools('mcp').every(tool => tool.outputSchema === undefined));
      const descriptor = await runtime.describeCapability('mcp', 'host:script-smoke:measurements.read-batch');
      assert.deepEqual(descriptor.outputSchema, measurementOutputSchemas()['measurements.read-batch']);
      await assert.rejects(runtime.describeCapability('mcp', 'host:script-smoke:unauthorized'), /not authorized/);
    }
    const output = path.join(directory, fixture.outputFile);
    await writeFile(output, JSON.stringify(fixture.expected));
    assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, true);
    await writeFile(output, '{}');
    assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, false);
    if (!fixture.kind) {
      await writeFile(output, JSON.stringify({ ...fixture.expected, notes: { ...fixture.expected.notes, r9: 'keep spaces' } }));
      assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, false);
    }
  }
  for (const fixture of revisionSix) {
    const directory = path.join(fixtureDirectory, fixture.id); await mkdir(directory);
    const report = {};
    await prepareRevisionSixCase(fixture, directory, report);
    await writeFile(path.join(directory, fixture.outputFile), JSON.stringify(fixture.expected));
    assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, true);
    if (fixture.id === 'host-opaque') {
      await writeFile(path.join(directory, fixture.outputFile), JSON.stringify({ ...fixture.expected, warnings: [...fixture.expected.warnings].reverse() }));
      assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, true);
    }
    await writeFile(path.join(directory, fixture.outputFile), '{}');
    assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, false);
  }
  for (const fixture of revisionEight) {
    const directory = path.join(fixtureDirectory, fixture.id); await mkdir(directory);
    const runtime = await prepareRevisionSixCase(fixture, directory, {});
    assert.deepEqual(runtime.listRunTools('mcp').map(tool => tool.name), ['measurements.read-batch', 'measurements.scale-table']);
    assert.deepEqual(runtime.listRunTools('mcp'), modeDesign.toolDefinitions);
    const result = await runtime.executeCapability('mcp', 'host:script-smoke:measurements.read-batch', { batch: 'obs-20261104' });
    assert.deepEqual(result.structuredContent, fixture.sourceData.batch);
    result.structuredContent.batches[0].observations[0].reading = -999;
    assert.equal(fixture.sourceData.batch.batches[0].observations[0].reading, 7);
    await assert.rejects(runtime.executeCapability('mcp', 'host:script-smoke:measurements.scale-table', { batch: 'other' }), /Unknown measurement batch/);
    const outputFile = path.join(directory, fixture.outputFile);
    await writeFile(outputFile, JSON.stringify({ ...fixture.expected, warnings: [...fixture.expected.warnings].reverse() }));
    assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, true);
    await writeFile(outputFile, JSON.stringify({ ...fixture.expected, warnings: ['factors are provisional calibration values.'] }));
    assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, false);
    await writeFile(outputFile, JSON.stringify({ ...fixture.expected, groups: [{ group: 'east', count: 3, scaledTotal: 999 }] }));
    assert.equal((await checkRevisionSixOutput(fixture, directory)).taskCorrect, false);
  }
  const hostReport = {};
  const hostRuntime = await prepareRevisionSixCase(revisionSix[2], fixtureDirectory, hostReport);
  assert.deepEqual(hostRuntime.listRunTools('mcp').map(tool => tool.name), ['exports.issue-list', 'exports.issue-detail']);
  assert.deepEqual(hostRuntime.listRunTools('other'), []);
  const listed = await hostRuntime.executeCapability('mcp', 'host:script-smoke:exports.issue-list', { project: 'alpha', state: 'open' });
  assert.ok(listed.content.includes('ISS-23') && !listed.content.includes('ISS-99'));
  assert.equal(listed.structuredContent.complete, false);
  await assert.rejects(hostRuntime.executeCapability('mcp', 'host:script-smoke:unknown', {}), /not authorized/);
  assert.equal(hostReport.hostInvocations.length, 2);
  class OfflineHostProvider extends KodaXBaseProvider {
    name = 'script-smoke-offline-host';
    supportsThinking = false;
    config = { apiKeyEnv: 'KODAX_SCRIPT_SMOKE_OFFLINE_KEY', model: 'offline', supportsThinking: false };
    calls = 0;
    firstTool = { type: 'tool_use', id: 'offline-host-call', name: 'tool_call', input: { name: 'exports.issue-list', input: { project: 'alpha', state: 'open' } } };
    async stream() {
      const first = this.calls++ === 0;
      return { textBlocks: first ? [] : [{ type: 'text', text: 'Offline fixture complete.' }], thinkingBlocks: [],
        toolBlocks: first ? [this.firstTool] : [],
        stopReason: first ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
  }
  const nativeProvider = new OfflineHostProvider();
  registerModelProvider(nativeProvider.name, () => nativeProvider);
  process.env.KODAX_SCRIPT_SMOKE_OFFLINE_KEY = 'offline-only';
  await runManagedTask({ provider: 'script-smoke-offline-host', model: 'offline', effort: 'none', workMode: 'script', agentMode: 'ama',
    maxIter: 2, lsp: false, extensionRuntime: hostRuntime,
    session: { id: 'offline-host', storage: new FileSessionStorage({ sessionsDir: path.join(fixtureDirectory, 'sessions'), configHome: fixtureDirectory, cwd: fixtureDirectory }) },
    context: { executionCwd: fixtureDirectory, configHome: fixtureDirectory, repoIntelligenceMode: 'off' },
    events: { beforeToolExecute: async tool => ['tool_call', 'exports.issue-list'].includes(tool) },
  }, 'List the open alpha issues.');
  assert.equal(hostReport.hostInvocations.length, 3);
  assert.equal(hostReport.hostInvocations[2].id, 'host:script-smoke:exports.issue-list');
  assert.equal(hostReport.hostInvocations[2].error, undefined);
  const jsonProvider = new OfflineHostProvider();
  jsonProvider.name = 'script-smoke-offline-json';
  jsonProvider.firstTool = { type: 'tool_use', id: 'offline-json-call', name: 'script_exec', input: {
    code: `const r=await tools['exports.issue-list']({project:'alpha',state:'open'});
      if(r.data?.kind!=='json')throw new Error('Built SDK did not deliver typed JSON');
      return {snapshotDayTwice:Number(r.data.value.snapshot.slice(-2))*2};`, selected_output: true } };
  registerModelProvider(jsonProvider.name, () => jsonProvider);
  const jsonStorage = new FileSessionStorage({ sessionsDir: path.join(fixtureDirectory, 'sessions'), configHome: fixtureDirectory, cwd: fixtureDirectory });
  await runManagedTask({ provider: jsonProvider.name, model: 'offline', effort: 'none', workMode: 'script', agentMode: 'ama',
    maxIter: 2, lsp: false, extensionRuntime: hostRuntime, session: { id: 'offline-json', storage: jsonStorage },
    context: { executionCwd: fixtureDirectory, configHome: fixtureDirectory, repoIntelligenceMode: 'off' },
    events: { beforeToolExecute: async tool => ['script_exec', 'script_wait', 'exports.issue-list'].includes(tool) },
  }, 'Inspect the alpha issue snapshot.');
  const jsonRecords = (await jsonStorage.load('offline-json')).extensionRecords.filter(record => record.extensionId === 'kodax.script');
  const jsonReceipt = jsonRecords.find(record => record.type === 'call.settled').data.data.result;
  assert.deepEqual(jsonReceipt.data, { kind: 'json', value: { snapshot: 'alpha-20261104', complete: false } });
  assert.ok(jsonReceipt.content.includes('Source caveat: alpha snapshot omits archived issues; totals describe returned open rows only.'));
  const jsonCell = jsonRecords.find(record => record.type === 'cell.settled').data.data;
  assert.equal(jsonCell.status, 'completed');
  assert.deepEqual(jsonCell.value, { snapshotDayTwice: 8 });
  assert.equal(hostReport.hostInvocations.length, 4);
  const measurementFixture = revisionEight[0];
  const measurementDirectory = path.join(fixtureDirectory, 'measurement-integration'); await mkdir(measurementDirectory);
  const measurementReport = {};
  const measurementRuntime = await prepareRevisionSixCase(measurementFixture, measurementDirectory, measurementReport);
  const measurementProvider = new OfflineHostProvider();
  measurementProvider.name = 'script-smoke-offline-measurements';
  measurementProvider.firstTool = { type: 'tool_use', id: 'measurement-cell', name: 'script_exec', input: { selected_output: true,
    code: `const [batch,scales]=await Promise.all([tools['measurements.read-batch']({batch:'obs-20261104'}),tools['measurements.scale-table']({batch:'obs-20261104'})]);
      const groups={};for(const item of batch.data.value.batches.flatMap(b=>b.observations)){
        if(item.eligible!==true)continue;const group=groups[item.group]??={group:item.group,count:0,scaledTotal:0};
        group.count++;group.scaledTotal+=item.reading*scales.data.value.factors[item.unit];}
      const output={groups:Object.values(groups).sort((a,b)=>a.group.localeCompare(b.group)),
        source:{snapshot:batch.data.value.snapshot,complete:batch.data.value.complete},
        warnings:[batch.sourceContent,scales.sourceContent]};
      const saved=await tools.write({path:'measurement-summary.json',content:JSON.stringify(output)});if(saved.isError)throw new Error(saved.content);
      const back=await tools.read({path:'measurement-summary.json'});return JSON.parse(back.data.text);` } };
  registerModelProvider(measurementProvider.name, () => measurementProvider);
  const measurementStorage = new FileSessionStorage({ sessionsDir: path.join(measurementDirectory, 'sessions'), configHome: measurementDirectory, cwd: measurementDirectory });
  const measurementRun = await runManagedTask({ provider: measurementProvider.name, model: 'offline', effort: 'none', workMode: measurementFixture.workMode, agentMode: 'ama',
    maxIter: 2, lsp: false, extensionRuntime: measurementRuntime, session: { id: 'offline-measurements', storage: measurementStorage },
    context: { executionCwd: measurementDirectory, configHome: measurementDirectory, repoIntelligenceMode: 'off' },
    events: { beforeToolExecute: async tool => ['script_exec', 'script_wait', 'write', 'read', ...measurementRuntime.listRunTools('mcp').map(definition => definition.name)].includes(tool) },
  }, measurementFixture.task);
  assert.equal(measurementRun.success, true);
  assert.equal((await checkRevisionSixOutput(measurementFixture, measurementDirectory)).taskCorrect, true);
  const measurementRecords = (await measurementStorage.load('offline-measurements')).extensionRecords.filter(record => record.extensionId === 'kodax.script');
  assert.deepEqual(measurementRecords.find(record => record.type === 'cell.settled').data.data.value, measurementFixture.expected);
  assert.equal(measurementRecords.filter(record => record.type === 'call.settled').length, 4);
  for (const [index, fixture] of revisionEight.entries()) {
    const modeProvider = new OfflineHostProvider(); modeProvider.name = `script-smoke-mode-${index}`;
    modeProvider.firstTool = fixture.workMode === 'coding'
      ? { type: 'tool_use', id: 'native-measurement', name: 'measurements.read-batch', input: { batch: 'obs-20261104' } }
      : { type: 'tool_use', id: 'script-measurement', name: 'script_exec', input: { code: "return (await tools['measurements.read-batch']({batch:'obs-20261104'})).data.value.snapshot;" } };
    const observedTools = [];
    const stream = modeProvider.stream.bind(modeProvider);
    modeProvider.stream = async (...args) => { observedTools.push(args[1].map(tool => tool.name)); return stream(...args); };
    registerModelProvider(modeProvider.name, () => modeProvider);
    const result = await runManagedTask({ provider: modeProvider.name, model: 'offline', effort: 'none', workMode: fixture.workMode, agentMode: 'ama',
      maxIter: 2, lsp: false, extensionRuntime: measurementRuntime,
      session: { id: `offline-mode-${index}`, storage: measurementStorage },
      context: { executionCwd: measurementDirectory, configHome: measurementDirectory, repoIntelligenceMode: 'off' },
      events: { beforeToolExecute: async tool => ['script_exec', 'script_wait', 'tool_call', 'measurements.read-batch'].includes(tool) },
    }, fixture.task);
    assert.equal(result.success, true);
    assert.equal(observedTools[0].includes('script_exec'), fixture.workMode === 'script');
    assert.equal(observedTools[0].includes('measurements.read-batch'), fixture.workMode === 'coding');
  }
  const coverage = scriptCoverage([{ type: 'call.settled', data: { data: { name: 'read', result: { data: { kind: 'text', text: 'x' } } } } }]);
  assert.equal(coverage.dataAvailableReceipts.length, 1);
  assert.equal(coverage.dataConsumption, 'unreviewed');
  const jsonCoverage = scriptCoverage([
    { type: 'call.settled', data: { data: { name: 'geometry.sample-grid', result: { data: { kind: 'json', value: [0, false, null] } } } } },
    { type: 'call.settled', data: { data: { name: 'opaque', result: { metadata: { data: { kind: 'json', value: 42 } } } } } },
  ]);
  assert.equal(jsonCoverage.jsonDataAvailableReceipts.length, 1);
  assert.equal(jsonCoverage.jsonDataConsumption, 'unreviewed');
  const { spawnSync } = await import('node:child_process');
  const childOptions = { env: { ...process.env, ARK_CODING_API_KEY: '' }, encoding: 'utf8', timeout: 30_000, windowsHide: true };
  for (const [revision, modes] of [[8, ['script', 'script', 'coding']], [9, ['script', 'coding']], [10, ['script', 'script', 'coding']]]) {
    const skipped = spawnSync(process.execPath, [process.argv[1], `--run-revision-${revision}`], childOptions);
    assert.equal(skipped.status, 0, skipped.stderr);
    const skippedDirectory = skipped.stdout.trim().replace('Smoke evidence: ', '');
    const skippedSummary = JSON.parse(await readFile(path.join(skippedDirectory, 'summary.json'), 'utf8'));
    const skippedDesign = JSON.parse(await readFile(path.join(skippedDirectory, 'design.json'), 'utf8'));
    assert.equal(skippedSummary.revision, revision);
    assert.equal(skippedSummary.cases, modes.length);
    assert.equal(skippedSummary.networkRequests, 0);
    assert.equal(skippedSummary.requestedCoverage.ran, false);
    assert.equal(skippedSummary.naturalAdoption.attemptedCases, 0);
    assert.ok(skippedSummary.conditions.every(condition => condition.skipped));
    assert.deepEqual(skippedSummary.conditions.map(condition => condition.workMode), modes);
    assert.equal(skippedDesign.maxCases, modes.length);
    assert.equal(skippedDesign.maxProviderCalls, modes.length * 6);
    if (revision === 9) {
      assert.match(skippedDesign.sdkLlmEntrySha256, /^[0-9a-f]{64}$/);
      assert.match(skippedDesign.scriptWorkerSha256, /^[0-9a-f]{64}$/);
      assert.equal(skippedDesign.maxTotalTokens, 1_000_000);
      assert.equal(skippedDesign.maxExternalSpendUsd, 12);
      assert.deepEqual(skippedDesign.caseDefinitions, designNine.caseDefinitions);
    }
    if (revision === 10) {
      assert.deepEqual(skippedDesign.caseDefinitions, JSON.parse(JSON.stringify(designTen.caseDefinitions)));
      assert.equal(skippedDesign.reviewDrainMs, 120_000);
    }
  }
  const conflicting = spawnSync(process.execPath, [process.argv[1], '--run-revision-8', '--run-revision-9'], childOptions);
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /Choose exactly one explicit revision/);
  assert.equal(unexpectedNetworkCalls, 0);
  process.stdout.write('Offline wrapper, mode conditions, revision budgets, measurement scorer and built SDK JSON integration checks passed; zero model/network requests. Fixture execution is not real-model coverage.\n');
  process.exit(0);
}

assertObservedRoutes(process.env);
const repairArkConfig = process.argv.includes('--repair-ark-config');
const namespaceDataSmoke = process.argv.includes('--run-revision-6');
const structuredDataSmoke = process.argv.includes('--run-revision-7');
const modeAcceptanceSmoke = process.argv.includes('--run-revision-8');
const lifecycleAcceptanceSmoke = process.argv.includes('--run-revision-9');
const returnContractSmoke = process.argv.includes('--run-revision-10');
if ([repairArkConfig, namespaceDataSmoke, structuredDataSmoke, modeAcceptanceSmoke, lifecycleAcceptanceSmoke, returnContractSmoke, process.argv.includes('--run-revision-4')].filter(Boolean).length !== 1) {
  throw new Error('Choose exactly one explicit revision: --run-revision-10, --run-revision-9, --run-revision-8, --run-revision-7, --run-revision-6, --repair-ark-config (5), or --run-revision-4.');
}
const dataCases = returnContractSmoke ? revisionTenCases() : lifecycleAcceptanceSmoke ? revisionNineCases() : modeAcceptanceSmoke ? revisionEightCases()
  : structuredDataSmoke ? [revisionSixCases()[2]] : namespaceDataSmoke ? revisionSixCases() : undefined;
const cases = dataCases?.map(fixture => fixture.target) ?? (repairArkConfig ? [
  { alias: 'ark/k27', provider: 'ark-coding', model: 'kimi-k2.7-code', apiKeyEnv: 'ARK_CODING_API_KEY', effort: 'high' },
] : [
  { alias: 'zhipu/glm52', provider: 'zhipu-coding', model: 'glm-5.2', apiKeyEnv: 'ZHIPU_CODING_API_KEY' },
  { alias: 'ark/k27', provider: 'ark-coding', model: 'kimi-k2.7-code', apiKeyEnv: 'ARK_CODING_API_KEY' },
]);
const root = await mkdtemp(path.join(tmpdir(), 'kodax-script-live-'));
const dumpDir = path.join(tmpdir(), 'kodax-eval-dumps', returnContractSmoke ? 'space-sdk-script-final-candidate-20261104' : lifecycleAcceptanceSmoke ? 'space-sdk-script-lifecycle-acceptance-20261104'
  : modeAcceptanceSmoke ? 'space-sdk-script-mode-acceptance-20261104' : structuredDataSmoke ? 'space-sdk-script-structured-data-20261104'
  : namespaceDataSmoke ? 'space-sdk-script-namespace-data-20261104' : 'space-sdk-script-20261103', path.basename(root));
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
if (dataCases) Object.assign(design, {
  revision: 6, sourceBaseline: '49da64f24',
  maxBilledLeafExecutions: 12,
  scriptCellLimits: { timeoutMs: 60_000, memoryBytes: 32 * 1024 * 1024, maxCalls: 64, maxTransferBytes: 1024 * 1024 },
  leafAccounting: 'The shared work budget charges executions, not all attempts. Each Script cell keeps its production 64-attempt limit and VM limits above; denied/refused attempts can be unbilled. Record started, succeeded, errored and unsettled calls plus full receipts separately; there is no 12-attempt ceiling.',
  revisionNote: 'New candidate-only namespace/data smoke with three fixed natural tasks. Historical revisions 4/5 and their raw failures/results remain separate; their red/blue tasks and earlier candidate builds are not pooled into this candidate rate. No conditional requested-Script case, sample rerun, A/B, lift or generalization claim.',
  reasoningEffort: 'high for both fixed provider/model families',
  conditionalCase: 'Disabled. Exactly three predeclared tasks regardless of Script choice or task outcome.',
  question: 'For three bounded natural tasks, separately observe task correctness, actual Script starts/success, reviewed data consumption, requests, tokens and elapsed time.',
  whyNotLayer1: 'Layer 1 proves namespace/data contracts and native invariants first. It cannot observe autonomous execution choices, real multi-step data consumption or physical Provider usage. These are Layer 3.5 observations; no additional single-turn probes are run.',
  rubric: 'Compare parsed output with literal fixture ground truth, independently of tool choice. Main session reviews every case from full records for task validity, Script execution and data dependencies; data presence or .data source text alone is not consumption. Native completion, no Script, failures, timeouts and unknown usage are retained. Efficiency is descriptive only; no A/B evidence exists.',
  fixtureConstraints: 'CSV with BOM/CRLF/quoted Unicode and multiline fields; XML plus log filters; explicit trusted SDK embedder Host tools with dotted/hyphen names and opaque caveats/separate structured values. Native bash/read/write/search/tool_call remain available. No child tools; 12 billed leaf executions, 6 turns and 6 logical/physical requests per case including learning/retries. Host fixture is not daemon lease or external service coverage.',
  concurrency: 'CSV/GLM and XML/Ark run in parallel. Close admissions and settle tracked requests plus bounded learning drain for both before Host/GLM starts. One request per provider, no fallback, retries of samples or conditional tasks.',
  caseDefinitions: dataCases.map(({ id, target, task, inputs, outputFile, expected }) => ({ id, target, task, inputs, outputFile, expected })),
  reviewOutput: 'main-session-review.json is a pending review template, not an automatic verdict. Fill case evidence references, data-consumption reasoning, limits and recommendation from persisted raw without new generation.',
});
if (dataCases) delete design.maxLeafCalls;
if (structuredDataSmoke) Object.assign(design, {
  revision: 7, maxCases: 1, maxProviderCalls: 6, maxTotalTokens: 500_000, maxExternalSpendUsd: 6, estimatedExternalSpendUsd: [1, 3],
  revisionNote: 'One affected Host case only: production contracts now expose genuine structuredContent as JSON data, so the actual model input changes. Reuse revision 6 Host task, fixture inputs, expected output, route/effort and strict scorer unchanged. This tests typed source consumption rather than model reconstruction; it is not a warning-prefix fix and does not guarantee strict task correctness. No CSV/Ark rerun, requested-Script case, A/B or pooled candidate rate.',
  reasoningEffort: 'zhipu/glm52 high, unchanged from revision 6 Host case',
  conditionalCase: 'Disabled. Exactly the existing Host case regardless of Script choice or task outcome.',
  question: 'Does the unchanged natural Host task actually consume typed JSON source data, and does its output meet the unchanged contract? Record both independently from Script starts and usage.',
  whyNotLayer1: 'Independent geometry.sample-grid tests prove JSON data contracts and safety boundaries at zero model cost. They cannot establish autonomous typed source consumption in the existing Host task. Only that task has changed production input; previous CSV and XML/Ark raw are retained without reruns.',
  fixtureConstraints: 'Unchanged revision 6 Host task through explicit trusted SDK embedder tools with dotted/hyphen names, opaque caveats and existing structured values. Native bridge/bash remain available. No children; 12 billed leaf executions and production per-cell 64-attempt/VM limits; 6 turns/logical requests/physical HTTP including learning and retries. No daemon lease or external-service coverage.',
  concurrency: 'One case, one GLM provider lane. Bounded learning drain closes admissions and settles tracked calls. No fallback, sample retry or additional case.',
  previousRevision: { revision: 6, evidenceDirectory: 'space-sdk-script-namespace-data-20261104/kodax-script-live-F9E92m',
    actualHttpRequests: 17, actualReportedTokens: 250_634, originalMaxProviderCalls: 18, originalMaxTotalTokens: 1_500_000,
    originalMaxExternalSpendUsd: 18, note: 'Original caps/raw remain intact; no unused balance is transferred. Results remain a separate revision.' },
  cumulativeKnownBudget: { previousActualHttpRequests: 17, newSegmentMaxHttpRequests: 6, maxCombinedHttpRequests: 23,
    previousReportedTokens: 250_634, newSegmentMaxTokenAccounting: 500_000, newSegmentMaxExternalSpendUsd: 6 },
});
if (modeAcceptanceSmoke) Object.assign(design, revisionEightDesign(dataCases));
if (lifecycleAcceptanceSmoke) Object.assign(design, revisionNineDesign(dataCases), {
  sdkLlmEntrySha256: createHash('sha256').update(await readFile(new URL('../dist/sdk-llm.js', import.meta.url))).digest('hex'),
  scriptWorkerSha256: createHash('sha256').update(await readFile(new URL('../dist/script-worker.cjs', import.meta.url))).digest('hex'),
});
if (returnContractSmoke) Object.assign(design, revisionTenDesign(dataCases), {
  sdkLlmEntrySha256: createHash('sha256').update(await readFile(new URL('../dist/sdk-llm.js', import.meta.url))).digest('hex'),
  scriptWorkerSha256: createHash('sha256').update(await readFile(new URL('../dist/script-worker.cjs', import.meta.url))).digest('hex'),
  driverSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
});
await writeFile(path.join(dumpDir, 'design.json'), JSON.stringify(design, null, 2));
async function runCase(target, index, selection, fixture) {
  const directory = path.join(root, String(index)); await mkdir(directory);
  const storage = new FileSessionStorage({ sessionsDir: path.join(directory, 'sessions'), configHome: directory, cwd: directory });
  const file = path.join(dumpDir, `${index}.json`);
  const controller = new AbortController();
  const rows = []; const physicalRequestFacts = [];
  const startedAt = Date.now();
  const task = fixture?.task ?? (selection === 'requested'
    ? 'Use script_exec to read a.json and b.json, sum count per category, and write totals.json as a JSON object mapping category to total. Set selected_output:true on script_exec and return a brief selected summary from the script. Native tools remain available if needed.'
    : 'Read a.json and b.json, sum count per category, and write totals.json as a JSON object mapping category to total. Return a brief summary. Choose appropriate available tools.');
  const workMode = fixture?.workMode ?? 'script';
  const report = { case: fixture?.id ?? 'red-blue', selection, workMode, evidenceFile: `${index}.json`, target: { alias: target.alias, provider: target.provider, model: target.model, effort: target.effort ?? null }, task,
    source: 'built SDK production runManagedTask', completed: false, taskCorrect: false, rows, physicalRequestFacts };
  const hostRuntime = fixture ? await prepareRevisionSixCase(fixture, directory, report) : undefined;
  if (!fixture) {
    await writeFile(path.join(directory, 'a.json'), JSON.stringify([{ category: 'red', count: 2 }, { category: 'blue', count: 3 }]));
    await writeFile(path.join(directory, 'b.json'), JSON.stringify([{ category: 'red', count: 3 }]));
  }
  let saveTail = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(report, null, 2);
    const next = saveTail.then(() => writeFile(file, snapshot)); saveTail = next; return next;
  };
  const tokenStopThreshold = returnContractSmoke ? Math.min(500_000,
    Math.max(0, design.maxTotalTokens - modeReports.reduce((sum, item) => sum + (item.report.budgetAccountedTokens ?? 0), 0))) : 500_000;
  if (tokenStopThreshold <= 0 || !process.env[target.apiKeyEnv]) {
    report.skipped = tokenStopThreshold <= 0 ? 'Aggregate token stop threshold exhausted' : 'Configured route credential is unavailable'; await save();
    return { report, save, startedAt };
  }
  const actual = getProvider(target.provider);
  const name = `script-smoke-${index}`;
  const observed = observeProvider(actual, target, report, save, controller, tokenStopThreshold);
  registerModelProvider(name, () => observed.provider);
  const timer = setTimeout(() => controller.abort(new Error('Smoke execution deadline exceeded')), 300_000);
  try {
    const result = await runManagedTask({ provider: name, model: target.model, effort: target.effort, workMode, agentMode: 'ama',
      extensionRuntime: hostRuntime,
      maxIter: 6, maxOutputTokens: 2048, lsp: false, abortSignal: controller.signal,
      session: { id: `smoke-${index}`, storage }, context: { executionCwd: directory, gitRoot: directory,
        configHome: directory, repoIntelligenceMode: 'off', managedWorkBudget: { totalBudget: 12, spentBudget: 0, currentHarness: 'H0_DIRECT' } },
      events: { beforeToolExecute: async tool => ['bash', 'read', 'write', 'glob', 'grep', 'tool_search', 'tool_call', 'script_exec', 'script_read', 'script_wait',
        ...(hostRuntime?.listRunTools('mcp').map(definition => definition.name) ?? []), ...(fixture ? ['mcp_search', 'mcp_describe', 'mcp_call'] : [])].includes(tool) },
    }, task);
    report.completed = result.success; report.lastText = result.lastText;
  } catch (error) { report.error = String(error); }
  finally { report.taskElapsedMs = Date.now() - startedAt; }
  if (fixture) Object.assign(report, await checkRevisionSixOutput(fixture, directory));
  else try {
    const output = JSON.parse(await readFile(path.join(directory, 'totals.json'), 'utf8'));
    report.output = output;
    report.taskCorrect = output.red === 5 && output.blue === 3 && Object.keys(output).length === 2;
  } catch (error) { report.taskCorrect = false; report.outputError = String(error); }
  await save();
  return { report, save, observed, timer, startedAt, storage, sessionId: `smoke-${index}` };
}
const modeReports = [];
const naturalReports = [];
const requestedReports = [];
const nativeReports = [];
if (modeAcceptanceSmoke || lifecycleAcceptanceSmoke || returnContractSmoke) {
  for (const [index, fixture] of dataCases.entries()) {
    const item = await runCase(fixture.target, index, fixture.selection, fixture);
    await finalizeGroup([item], awaitLatestCodingMemoryReviewDrain, design.reviewDrainMs ?? 30_000); modeReports.push(item);
    (fixture.selection === 'requested' ? requestedReports : fixture.selection === 'natural' ? naturalReports : nativeReports).push(item);
  }
} else {
  naturalReports.push(...await Promise.all(cases.slice(0, namespaceDataSmoke ? 2 : cases.length)
    .map((target, index) => runCase(target, index, 'natural', dataCases?.[index]))));
  await finalizeGroup(naturalReports);
  if (namespaceDataSmoke) {
    const host = await runCase(cases[2], 2, 'natural', dataCases[2]);
    await finalizeGroup([host]); naturalReports.push(host);
  }
}
const conditionalTarget = repairArkConfig || dataCases ? undefined : requestedTarget(cases, naturalReports);
if (conditionalTarget) {
  requestedReports.push(await runCase(conditionalTarget, 2, 'requested'));
  await finalizeGroup(requestedReports);
}
const allReports = (modeAcceptanceSmoke || lifecycleAcceptanceSmoke || returnContractSmoke ? modeReports : [...naturalReports, ...requestedReports]).map(item => item.report);
await writeFile(path.join(dumpDir, 'summary.json'), JSON.stringify({
  revision: design.revision, cases: allReports.length,
  naturalAdoption: { attemptedCases: naturalReports.filter(item => !item.report.skipped).length,
    casesWithActualScript: naturalReports.filter(item => item.report.scriptCellAttempts > 0).length },
  requestedCoverage: { includedInNaturalAdoption: false, ran: requestedReports.some(item => !item.report.skipped),
    alias: requestedReports[0]?.report.target.alias ?? null, actualScriptCells: requestedReports[0]?.report.scriptCellAttempts ?? null,
    modelSelectedOutputRequests: requestedReports[0]?.report.modelSelectedOutputRequests ?? null },
  nativeBaseline: { includedInNaturalAdoption: false, cases: nativeReports.length },
  conditions: allReports.map(report => ({ case: report.case, selection: report.selection, workMode: report.workMode,
    completed: report.completed, taskCorrect: report.taskCorrect, skipped: report.skipped ?? null,
    scriptCellAttempts: report.scriptCellAttempts ?? 0, scriptCellsSucceeded: report.scriptCellsSucceeded ?? 0,
    networkRequests: report.networkRequests ?? 0, actualReportedTokens: report.physicalUsage?.totalActualTokens ?? null,
    taskElapsedMs: report.taskElapsedMs ?? null, collectionElapsedMs: report.elapsedMs ?? null })),
  networkRequests: allReports.reduce((sum, report) => sum + (report.networkRequests ?? 0), 0),
  budgetAccountedTokens: allReports.reduce((sum, report) => sum + (report.budgetAccountedTokens ?? 0), 0),
  spendReservationUsd: allReports.reduce((sum, report) => sum + (report.networkRequests ?? 0), 0),
  measuredBillingUsd: null,
}, null, 2));
if (dataCases) await writeFile(path.join(dumpDir, 'main-session-review.json'), JSON.stringify({
  revision: design.revision, status: 'pending-main-session-review', comparison: false,
  cases: allReports.map((report, index) => ({ case: report.case, selection: report.selection, workMode: report.workMode,
    evidenceFile: report.evidenceFile ?? `${index}.json`, evidenceSha256: createHash('sha256').update(JSON.stringify(report, null, 2)).digest('hex'),
    mechanicalTaskCorrect: report.taskCorrect, actualScriptStarted: report.scriptCellAttempts ?? 0, actualScriptSucceeded: report.scriptCellsSucceeded ?? 0,
    taskValidity: 'unreviewed', dataConsumption: 'unreviewed', jsonDataConsumption: 'unreviewed', evidenceReferences: [], reason: null })),
  recommendation: null, limitations: returnContractSmoke
    ? 'Three fixed candidate-only conditions, one family. Strict artifact and actual Script computation/source/readback coverage are distinct. Natural same-task costs are descriptive, not causal efficiency, overall intelligence or cross-model generalization evidence. Missing usage remains unknown; no saving rate. Previous raw/failures are retained.'
    : lifecycleAcceptanceSmoke
    ? 'Two affected conditions after changed production input. Requested coverage requires actual computation from tool results; native coding separately checks real wire compatibility. No natural adoption rerun, causal efficiency, prompt A/B or generalization conclusion; revision 8 raw and failures remain separate.'
    : modeAcceptanceSmoke
    ? 'One task, one family and one sample per condition. Requested Script is separate coverage, not autonomous adoption. Natural mode costs are descriptive only; no causal efficiency, prompt A/B or generalization conclusion. Old raw and failures remain separate.'
    : structuredDataSmoke
    ? 'One affected Host case and one family, no controlled A/B. Revision 6 raw remains separate; no pooled adoption, warning-fix, efficiency or generalization conclusion.'
    : 'Three different tasks, two families, one candidate; case/family effects are confounded. No population adoption, A/B efficiency or generalization conclusion.',
}, null, 2));
process.stdout.write(`Smoke evidence: ${dumpDir}\n`);
