import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult } from '@kodax-ai/llm';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { createKodaXRuntime } from '../src/sdk-runtime.js';
import { measureModelFields } from './first-turn-uniform-costs.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';
import { projectToolSearchResultParameters } from '../packages/coding/src/tools/tool-search-model-result.js';

const url = 'https://nodejs.org/api/fs.html';
const text = 'fs.rm: When force is true, exceptions will be ignored if path does not exist. Default: false.';
const report = `Source: ${url}\n${text}\n`;
const receipt = (messages: readonly KodaXMessage[], id: string) => messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  .find(block => block.type === 'tool_result' && block.tool_use_id === id);
const functions = (body: string): Record<string, unknown>[] => body.split('\n').flatMap(line => {
  const match = /^<function>(.+)<\/function>$/.exec(line);
  return match ? [JSON.parse(match[1]!) as Record<string, unknown>] : [];
});

it.each(['agent', 'coding', 'script'] as const)('keeps %s URL/report work direct and projects only redundant model parameters', async initialMode => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-deferred-direct-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const sourceFiles = ['tests/deferred-tool-direct-runtime.test.ts', 'packages/coding/src/tools/deferred-tools.ts',
    'packages/coding/src/tools/tool-search.ts', 'packages/coding/src/tools/tool-search-model-result.ts',
    'packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts', 'packages/coding/src/agent-runtime/script/model.ts'];
  const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, inputHash(await fs.readFile(file, 'utf8'))])));
  const sourceHashes = await hashes();
  vi.stubEnv('KODAX_HOME', root);
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (requested !== url) throw new Error('Unexpected network request in offline Runtime test');
    return new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const providerName = `deferred-direct-${path.basename(root)}`;
  const inputs: FrozenInput[] = [], publicResults: { name: string; content: string }[] = [];
  let mode = initialMode, canonicalHelp = '', step = 0, failure: unknown;
  const leaf = (id: string, name: string, input: Record<string, unknown>) => mode === 'script'
    ? { type: 'tool_use' as const, id, name: 'script_exec', input: { code: `return await tools.${name}(${JSON.stringify(input)});` } }
    : { type: 'tool_use' as const, id, name, input };
  class Offline extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_OFFLINE_NO_KEY', model: 'fixture', supportsThinking: false };
    override isConfigured() { return true; }
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
      try {
        inputs.push(structuredClone({ system, messages, tools }));
        const current = step++;
        if (current > 6) throw new Error('Unexpected extra generation');
        if (current >= 1) {
          const found = receipt(messages, 'discover');
          expect(found?.type).toBe('tool_result');
          const modelHelp = functions(String(found && 'content' in found ? found.content : ''));
          const full = functions(canonicalHelp);
          expect(full).toHaveLength(1);
          expect(modelHelp[0]?.description).toBe(full[0]!.description);
          expect(modelHelp[0]?.name).toBe('web_fetch');
          expect(modelHelp[0]).not.toHaveProperty('parameters');
        }
        if (current === 0) {
          const native = tools.find(tool => tool.name === 'web_fetch');
          const teaching = native?.description ?? tools.find(tool => tool.name === 'script_exec')?.description ?? '';
          expect(teaching).toContain(native ? 'Read a URL as bounded plain text' : 'Read a specific URL as bounded text');
          expect(teaching).not.toContain('call tool_search("web_fetch")');
          if (native) expect(native.input_schema.properties).toHaveProperty('url');
        }
        if (current === 2) expect(JSON.stringify(messages)).toContain(text);
        if (current === 3) expect(await fs.readFile(path.join(workspace, 'report.md'), 'utf8')).toBe(report);
        if (current === 4 || current === 6) expect(JSON.stringify(receipt(messages, current === 4 ? 'verify' : 'verify-again'))).toContain(text);
        if (current === 5) {
          expect(tools.some(tool => tool.name === 'script_exec')).toBe(mode === 'script');
          expect(tools.some(tool => tool.name === 'web_fetch')).toBe(mode !== 'script');
        }
        const call = current === 0 ? { type: 'tool_use' as const, id: 'discover', name: 'tool_search', input: { query: 'select:web_fetch' } }
          : current === 1 ? leaf('fetch-page', 'web_fetch', { url })
          : current === 2 ? leaf('save', 'write', { path: 'report.md', content: report })
          : current === 3 ? leaf('verify', 'read', { path: 'report.md' })
          : current === 5 ? leaf('verify-again', 'read', { path: 'report.md' }) : undefined;
        return { textBlocks: call ? [] : [{ type: 'text', text: '已保存并重新读取核对 report.md；内容和来源一致。' }],
          toolBlocks: call ? [call] : [], thinkingBlocks: [], stopReason: call ? 'tool_use' : 'end_turn' };
      } catch (error) { failure = error; throw error; }
    }
  }
  const unregister = registerModelProvider(providerName, () => new Offline());
  const runtime = await createKodaXRuntime({ homeDir: root, sharedDaemonHost: true, defaultProvider: providerName, defaultModel: 'fixture' });
  const started = Date.now();
  try {
    const session = await runtime.sessions.create({ projectPath: workspace });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', workMode: mode, executionCwd: workspace });
    const run = async (prompt: string) => {
      const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt,
        options: { agentMode: 'ama', reasoningMode: 'off', lsp: false,
          learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['offline'] } }),
          context: { repoIntelligenceMode: 'off', skillsPrompt: '' },
          events: { onToolResult: value => {
            const content = typeof value.content === 'string' ? value.content : JSON.stringify(value.content);
            publicResults.push({ name: value.name, content });
            if (value.name === 'tool_search') canonicalHelp = content;
          } } } });
      const result = await handle.result;
      if (failure) throw failure;
      expect(result.phase, result.error?.message).toBe('completed');
      return result;
    };
    await run(`看一下 ${url} 的页面说明，把 rm 的 force 选项结论写进 report.md，保存后核对内容和来源。`);
    const taskWallMs = Date.now() - started;
    const taskResultCount = publicResults.length;
    expect(step).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(functions(canonicalHelp)[0]?.parameters).toHaveProperty('properties.url');
    const transcript = await runtime.sessions.transcript(session.id);
    const durable = receipt(transcript?.messages ?? [], 'discover');
    expect(durable?.type).toBe('tool_result');
    expect(functions(String(durable && 'content' in durable ? durable.content : ''))[0]?.parameters)
      .toEqual(functions(canonicalHelp)[0]?.parameters);
    expect(receipt(projectToolSearchResultParameters(transcript?.messages ?? [], []), 'discover')).toEqual(durable);
    const canonicalInputs: FrozenInput[] = [];
    const measured = inputs.map(input => {
      const restored: FrozenInput = { ...input, messages: input.messages.map(message => !Array.isArray(message.content) ? message : { ...message,
        content: message.content.map(block => block.type === 'tool_result' && block.tool_use_id === 'discover' ? { ...block, content: canonicalHelp } : block) }) };
      canonicalInputs.push(restored);
      return { after: measureModelFields(input).estimatedTokens, before: measureModelFields(restored).estimatedTokens, inputHash: inputHash(input) };
    });
    expect(measured.reduce((sum, row) => sum + row.before - row.after, 0)).toBeGreaterThan(0);
    mode = initialMode === 'script' ? 'agent' : 'script';
    await runtime.sessions.updateSettings(session.id, { workMode: mode });
    await run('请再核对已保存的报告，不需要重新访问网页。');
    expect(step).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(workspace, 'report.md'), 'utf8')).toBe(report);
    const directory = path.join(os.tmpdir(), 'kodax-eval-dumps', 'deferred-tool-direct-runtime', path.basename(root));
    const artifact = path.join(directory, 'evidence.json');
    await fs.mkdir(directory, { recursive: true });
    const summary = { mode: initialMode, fixedTaskRequests: 5, followUpRequests: 2, externalModelCalls: 0, fixtureHttpReads: 1,
      taskLeafCalls: publicResults.slice(0, taskResultCount).filter(item => item.name !== 'script_exec').length,
      followUpLeafCalls: publicResults.slice(taskResultCount).filter(item => item.name !== 'script_exec').length,
      publicResultNames: publicResults.map(item => item.name),
      taskEstimatedBefore: measured.reduce((sum, row) => sum + row.before, 0), taskEstimatedAfter: measured.reduce((sum, row) => sum + row.after, 0),
      taskWallMs, wallMs: Date.now() - started,
      scope: 'Same scripted trajectory and shared system/tool contracts; counterfactual restores only search-result parameters, not historical hint text. AMA and capability execution remain active. Heuristic input tokens, not API usage or model quality. Mode-switch follow-up is separate.' };
    expect(inputHash(await hashes()), 'Capture sources must stay unchanged throughout both Runs').toBe(inputHash(sourceHashes));
    await fs.writeFile(artifact, JSON.stringify({ sourceHashes, summary, measured, inputs, canonicalInputs, publicResults, canonicalHelp, durable, transcript }, null, 2), { flag: 'wx' });
    await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
    process.stdout.write(JSON.stringify({ artifact, summary: path.join(directory, 'summary.json'), ...summary }) + '\n');
  } finally {
    await runtime.close(); await awaitLatestCodingMemoryReviewDrain(5_000); unregister(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('kodax-deferred-direct-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 90_000);
