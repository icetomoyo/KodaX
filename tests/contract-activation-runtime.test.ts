import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import { createCustomProvider, registerModelProvider, type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { persistCompactedSessionHistory, evictOldIslandMessageContent } from '@kodax-ai/agent';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime } from '../src/sdk-runtime.js';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from '../packages/llm/src/providers/capability-profile.js';
import { countTokens } from '../packages/agent/src/tokenizer.js';
import { measureModelFields } from './first-turn-uniform-costs.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';

const label = 'ALPHA-MARKER-17';
type Phase = 'seed' | 'edit' | 'follow-up' | 'visual' | 'history';
type WorkMode = 'agent' | 'coding' | 'script';
const firstUseOnly = process.env.KODAX_CONTRACT_ACTIVATION_FIRST_USE_ONLY === '1';
const historyOnly = process.env.KODAX_CONTRACT_ACTIVATION_HISTORY_ONLY === '1';
const editVisualOnly = process.env.KODAX_CONTRACT_ACTIVATION_EDIT_VISUAL_ONLY === '1';
const stepLimits: Record<Phase, number> = { seed: 1, edit: 4, 'follow-up': 2, visual: firstUseOnly ? 2 : 5, history: 4 };
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
type HistoryHit = { entryId: string; active: boolean };
const compactedHistoryEntry = (hits: HistoryHit[]): string => {
  const historicalHits = hits.filter(hit => !hit.active);
  if (historicalHits.length !== 1) throw new Error('Expected exactly one compacted-history hit');
  return historicalHits[0]!.entryId;
};
const sourcePaths = () => process.env.KODAX_CONTRACT_ACTIVATION_SOURCE_MANIFEST
  ? JSON.parse(readFileSync(process.env.KODAX_CONTRACT_ACTIVATION_SOURCE_MANIFEST, 'utf8')) as string[]
  : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--',
  'packages/coding/src/**/*.ts', 'packages/agent/src/**/*.ts', 'packages/llm/src/**/*.ts', 'packages/repl/src/**/*.ts', 'packages/repl/src/**/*.tsx', 'src/**/*.ts',
  'vitest.config.ts', 'vitest.setup.queue.ts', 'vitest.test-tiers.ts', 'tsconfig.json', 'package.json', 'package-lock.json',
  'tests/contract-activation-runtime.test.ts'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter(Boolean);
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths().map(async file => [file, inputHash(await fs.readFile(file, 'utf8'))])));

it('selects compacted history using returned provenance and rejects ambiguous history', () => {
  expect(compactedHistoryEntry([{ entryId: 'new-question', active: true }, { entryId: 'stored-earlier-entry', active: false }])).toBe('stored-earlier-entry');
  expect(() => compactedHistoryEntry([{ entryId: 'new-question', active: true }])).toThrow('exactly one');
  expect(() => compactedHistoryEntry([{ entryId: 'earlier-a', active: false }, { entryId: 'earlier-b', active: false }])).toThrow('exactly one');
});

it.each<WorkMode>(['agent', 'coding', 'script'])('captures %s editing, accepted-image and compacted-history work without a discovery prerequisite', async mode => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-contract-activation-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(workspace, 'tests'));
  await fs.writeFile(path.join(workspace, 'value.mjs'), 'export const value = 1;\n');
  await fs.writeFile(path.join(workspace, 'tests/value.test.mjs'), "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../value.mjs';\ntest('value is two',()=>assert.equal(value,2));\n");
  await fs.writeFile(path.join(workspace, 'sample.png'), await new Jimp({ width: 2, height: 2, color: 0xff0000ff }).getBuffer('image/png'));
  const hashes = await sourceHashes();
  const stage = process.env.KODAX_CONTRACT_ACTIVATION_CAPTURE_STAGE ?? 'current';
  const artifactRoot = path.join(os.tmpdir(), 'kodax-eval-dumps', 'contract-activation-runtime-r2-20261031', stage, path.basename(root));
  await fs.mkdir(artifactRoot, { recursive: true });
  vi.stubEnv('KODAX_HOME', root);
  vi.stubEnv('KODAX_ACTIVATION_OFFLINE_KEY', 'offline-only');
  vi.stubGlobal('fetch', () => { throw new Error('Offline activation capture forbids network'); });
  const providerName = `activation-${path.basename(root)}`;
  const inputs: { phase: Phase; step: number; input: FrozenInput }[] = [];
  const wires: { phase: Phase; step: number; body: unknown }[] = [];
  const receipts: { phase: Phase; name: string; reportedName: string; content: string; isError: boolean }[] = [];
  const dispatched: { phase: Phase; step: number; action: ReturnType<typeof call> }[] = [];
  const timings: { phase: Phase; requests: number; wallMs: number }[] = [];
  let phase: Phase = 'edit', step = 0, observationId = '', failure: unknown;
  let history: { revision: string; hits: HistoryHit[] } | undefined;
  let historicalEntryId = '';
  const historyReads: { status: string; entryId: string; content?: string }[] = [];
  let activeToolNames = new Set<string>();
  const leaf = (id: string, name: string, input: Record<string, unknown>) => mode === 'script'
    ? call(id, 'script_exec', { code: `return await tools.${name}(${JSON.stringify(input)});` })
    : !activeToolNames.has(name) ? call(id, 'tool_call', { name, input }) : call(id, name, input);
  const unregister = registerModelProvider(providerName, () => {
    const provider = createCustomProvider({ name: providerName, protocol: 'openai', model: 'fixture', imageInput: true,
      apiKeyEnv: 'KODAX_ACTIVATION_OFFLINE_KEY', baseUrl: 'https://activation-capture.invalid',
      capabilityProfile: { ...NATIVE_PROVIDER_CAPABILITY_PROFILE } });
    Reflect.set(provider, '_client', { chat: { completions: { create: async (body: unknown) => {
      wires.push({ phase, step, body: structuredClone(body) });
      return { choices: [{ message: { content: 'Offline serialization.' }, finish_reason: 'stop' }] };
    } } } });
    provider.stream = async (messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> => {
      if (!tools.some(tool => tool.name === 'todo_update')) return { textBlocks: [{ type: 'text', text: 'Auxiliary work complete.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
      try {
        const current = step;
        if (current >= stepLimits[phase]) throw new Error(`Unexpected extra ${phase} request`);
        inputs.push({ phase, step: current, input: structuredClone({ system, messages, tools }) });
        activeToolNames = new Set(tools.map(tool => tool.name));
        if (inputs.length === 1) await fs.writeFile(path.join(artifactRoot, 'first-input.json'), JSON.stringify(inputs[0], null, 2), { flag: 'wx' });
        if (stage === 'candidate' && inputs.length === 1) {
          expect(activeToolNames.has('visual_history')).toBe(true);
          expect(activeToolNames.has('visual_inspect'), 'Fresh product owner must defer specialized visual schemas until actual activation').toBe(false);
          expect(activeToolNames.has('visual_read_pixels')).toBe(false);
          const directory = tools.find(tool => tool.name === 'tool_search')?.description ?? '';
          expect(directory).toContain('visual_inspect');
          expect(directory).toContain('visual_read_pixels');
        }
        await provider.complete(messages, tools, system);
        step++;
        let action: ReturnType<typeof call> | undefined;
        if (phase === 'seed') {
          expect(current).toBe(0);
        } else if (phase === 'edit') {
          if (current === 0) action = leaf('edit-read', 'read', { path: 'value.mjs' });
          if (current === 1) action = leaf('edit-change', 'edit', { path: 'value.mjs', old_string: 'value = 1', new_string: 'value = 2' });
          if (current === 2) action = leaf('edit-test', 'bash', { command: 'node --test tests/value.test.mjs' });
          if (current === 3) expect(receipts.some(item => item.name === 'bash' && item.content.includes('# pass 1') && !item.isError)).toBe(true);
        } else if (phase === 'follow-up') {
          if (current === 0) action = leaf('follow-read', 'read', { path: 'value.mjs' });
          else expect(JSON.stringify(messages)).toContain('value = 2');
        } else if (phase === 'visual') {
          if (current === 0) action = leaf('image-read', 'read', { path: 'sample.png' });
          if (current > 0) {
            observationId ||= JSON.stringify(messages).match(/obs_[a-f0-9-]+/)?.[0] ?? '';
            expect(observationId).not.toBe('');
          }
          if (stage === 'candidate' && current > 0) {
            expect(activeToolNames.has('visual_inspect'), 'Actual image admission must activate its contract on the next original request').toBe(true);
            expect(activeToolNames.has('visual_read_pixels')).toBe(true);
          }
          if (current === 1 && !firstUseOnly) action = call('image-inspect', 'visual_inspect', { question: '核对图像原始区域。', views: [{ label: '原图', observationId }] });
          if (current === 2) action = call('image-pixels', 'visual_read_pixels', { question: '确认四个原始像素的颜色。', views: [{ label: '四像素', observationId,
            region: { x: 0, y: 0, width: 2, height: 2 }, rows: 2, columns: 2 }] });
          if (current === 3) action = call('image-history', 'visual_history', { limit: 5 });
          if (current === 4) {
            const visual = receipts.filter(item => item.phase === 'visual' && item.name.startsWith('visual_'));
            expect(visual).toHaveLength(3);
            expect(visual.every(item => !item.isError)).toBe(true);
            const pixels = JSON.parse(visual.find(item => item.name === 'visual_read_pixels')!.content);
            expect(pixels).toMatchObject({ status: 'complete', palette: [[255, 0, 0, 255]] });
            expect(visual.find(item => item.name === 'visual_history')!.content).toContain(observationId);
          }
        } else {
          if (current === 0) action = leaf('history-search', 'session_history_search', { query: '兼容标签', role: 'user', scope: 'all' });
          if (current === 1) {
            expect(history?.hits.length).toBeGreaterThan(0);
            // The search includes the current question: select the actual compacted-history hit,
            // using the returned provenance rather than assuming the newest hit is the answer.
            historicalEntryId = compactedHistoryEntry(history!.hits);
            action = leaf('history-read', 'session_history_read', { entry_id: historicalEntryId, revision: history!.revision });
          }
          if (current === 2) {
            expect(historyReads).toHaveLength(1);
            expect(historyReads[0]).toMatchObject({ status: 'stale', entryId: historicalEntryId });
            // A stable cited entry remains legal to read without the optional whole-history revision.
            // Preserve the actual stale feedback and issue a new request, never rewrite an earlier call.
            action = leaf('history-recover', 'session_history_read', { entry_id: historicalEntryId });
          }
          if (current === 3) {
            expect(historyReads).toHaveLength(2);
            expect(historyReads[1]).toMatchObject({ status: 'ok', entryId: historicalEntryId });
            expect(historyReads[1]!.content).toContain(label);
          }
        }
        if (action) dispatched.push({ phase, step: current, action: structuredClone(action) });
        return { textBlocks: action ? [] : [{ type: 'text', text: phase === 'history' ? `已核对历史原文，兼容标签为 ${label}。` : '已完成要求的修改与核验。' }],
          toolBlocks: action ? [action] : [], thinkingBlocks: [], stopReason: action ? 'tool_use' : 'end_turn' };
      } catch (error) { failure = error; throw error; }
    };
    return provider;
  });
  const open = () => createKodaXRuntime({ homeDir: root, sharedDaemonHost: true, defaultProvider: providerName, defaultModel: 'fixture' });
  let runtime = await open();
  let sessionId = '';
  let captureCompleted = false;
  try {
    sessionId = (await runtime.sessions.create({ projectPath: workspace })).id;
    await runtime.sessions.updateSettings(sessionId, { provider: providerName, model: 'fixture', permissionMode: 'full-access', workMode: mode, executionCwd: workspace });
    const run = async (next: Phase, prompt: string) => {
      phase = next; step = 0;
      const started = Date.now();
      const handle = await runtime.runs.start({ sessionId, mode: 'managed_task', prompt, options: { agentMode: 'ama', reasoningMode: 'off', lsp: false,
        learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['offline'] } }),
        context: { repoIntelligenceMode: 'off', skillsPrompt: '' }, events: { onToolResult: result => {
          const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
          const sent = dispatched.find(item => item.action.id === result.id)?.action;
          const name = sent?.name === 'tool_call' && typeof sent.input.name === 'string' ? sent.input.name : result.name;
          receipts.push({ phase, name, reportedName: result.name, content, isError: result.toolResult?.is_error === true });
          if (name === 'session_history_search') history = JSON.parse(content) as typeof history;
          if (name === 'session_history_read') historyReads.push(JSON.parse(content) as typeof historyReads[number]);
        } } } });
      const result = await handle.result;
      if (failure) throw failure;
      expect(result.phase, result.error?.message).toBe('completed');
      expect(step).toBe(stepLimits[next]);
      timings.push({ phase: next, requests: step, wallMs: Date.now() - started });
    };
    if (firstUseOnly) await run('visual', '请读取 sample.png，确认图像已成功载入。');
    else {
    if (historyOnly) await run('seed', `我们这次排查的兼容标签是 ${label}，稍后请继续用它。`);
    else {
    await run('edit', `兼容标签是 ${label}，保持不变。请把 value.mjs 的值改成 2，再运行现有 Node 测试。`);
    expect(await fs.readFile(path.join(workspace, 'value.mjs'), 'utf8')).toBe('export const value = 2;\n');
    await run('follow-up', '请再核对已保存的值，不需要重新执行已经通过的测试。');
    await run('visual', '请查看 sample.png，检查原图、测量四个像素，并核对本次接受的历史图像记录。');
    }
    if (!editVisualOnly) {
    await runtime.close(); await awaitLatestCodingMemoryReviewDrain(5_000);
    const storage = new FileSessionStorage({ sessionsDir: path.join(root, '.kodax', 'sessions'), configHome: path.join(root, '.kodax') });
    const before = await storage.load(sessionId);
    if (!before) throw new Error('Missing persisted Runtime history');
    const summary = historyOnly ? '已讨论一个兼容标签，具体原文已移出当前上下文，需要时查询持久历史。'
      : '已将值改为2并通过测试，已查看图像；兼容标签的具体原文已移出当前上下文，需要时查询持久历史。';
    const compactedMessages: KodaXMessage[] = [{ role: 'system', content: `[对话历史摘要]\n\n${summary}` }];
    await persistCompactedSessionHistory({ storage, sessionId, compactedMessages, update: { preCompactionMessages: before.messages,
      anchor: { summary, tokensBefore: countTokens(JSON.stringify(before.messages)), tokensAfter: countTokens(JSON.stringify(compactedMessages)), entriesRemoved: before.messages.length, reason: 'manual' } } });
    const compacted = await storage.load(sessionId);
    if (!compacted?.lineage) throw new Error('Missing compacted Runtime lineage');
    await storage.save(sessionId, { ...compacted, lineage: evictOldIslandMessageContent(compacted.lineage) });
    runtime = await open();
    await run('history', '刚才的兼容标签是哪一个？请从持久历史原文核对后告诉我。');
    }
    }
    const afterHashes = await sourceHashes();
    expect(afterHashes, 'Capture sources must remain frozen throughout all four Runs').toEqual(hashes);
    const normalized = inputs.map(({ input, ...identity }) => ({ ...identity, input: JSON.parse(JSON.stringify(input).replaceAll(root.replaceAll('\\', '\\\\'), '<FIXTURE_ROOT>').replaceAll(sessionId, '<SESSION_ID>')) as FrozenInput }));
    const measures = normalized.map(row => ({ phase: row.phase, step: row.step, ...measureModelFields(row.input) }));
    const serializedMeasures = wires.map(row => ({ phase: row.phase, step: row.step,
      ...measureModelFields(JSON.parse(JSON.stringify(row.body).replaceAll(root.replaceAll('\\', '\\\\'), '<FIXTURE_ROOT>').replaceAll(sessionId, '<SESSION_ID>'))) }));
    const summaryOutput = { stage, mode, firstUseOnly, historyOnly, editVisualOnly, externalModelCalls: 0, providerRequests: inputs.length, sdkSerializations: wires.length,
      firstEstimatedTokens: measures[0]?.estimatedTokens, taskEstimatedInput: measures.reduce((total, item) => total + item.estimatedTokens, 0), timings,
      serializedFirstEstimatedTokens: serializedMeasures[0]?.estimatedTokens, serializedTaskEstimatedInput: serializedMeasures.reduce((total, item) => total + item.estimatedTokens, 0),
      historyReads: historyReads.map(({ status, entryId }) => ({ status, entryId })),
      scope: firstUseOnly ? 'Two-request product seam only: initial reliable empty owner then actual PNG admission; not a complete task or paired efficiency comparison.'
        : historyOnly ? 'R2 history-only: original text accepted by one natural Runtime Run, real compaction/restart, search, unchanged stale rejection, new legal optional-revision read with strict actual-content assertion. R1 edit/visual data reused separately; no replay/replacement of their successful baselines.'
        : editVisualOnly ? 'R1-compatible first three Runs only: actual edit/test, follow-up, accepted PNG inspect/pixels/history. Match R1 valid phases; do not combine with independent history-only input cost as one task.'
        : 'R2: scripted Runtime and real SDK serialization. Typed measures and serialized model-fields measures are separate. Actual edit/test, accepted PNG, compaction/restart, original stale rejection then a new legal optional-revision read. Original R1 remains evidence of an incomplete history read and overclaimed scripted report. Skills catalogue explicitly empty, not full builtin Host, autonomous intelligence or API usage.' };
    await fs.writeFile(path.join(artifactRoot, 'evidence.json'), JSON.stringify({ sourceHashes: hashes, summary: summaryOutput, inputs, normalized, wires, receipts, dispatched, observationId, sessionId, measures, serializedMeasures }, null, 2), { flag: 'wx' });
    captureCompleted = true;
    process.stdout.write(JSON.stringify({ artifactRoot, ...summaryOutput }) + '\n');
  } finally {
    if (!captureCompleted) await fs.writeFile(path.join(artifactRoot, 'failed-capture.json'), JSON.stringify({ stage, mode, firstUseOnly,
      phase, step, sourceHashes: hashes, inputs, wires, receipts, dispatched,
      failure: failure instanceof Error ? { name: failure.name, message: failure.message, stack: failure.stack } : String(failure) }, null, 2), { flag: 'wx' });
    await runtime.close(); await awaitLatestCodingMemoryReviewDrain(5_000); unregister(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-contract-activation-')) throw new Error('Unsafe Runtime fixture cleanup');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 120_000);
