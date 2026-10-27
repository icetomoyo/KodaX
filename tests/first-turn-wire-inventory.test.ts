import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCustomProvider, registerModelProvider, clearRuntimeModelProviders } from '@kodax-ai/llm';
import { runKodaX, runManagedTask, awaitLatestCodingMemoryReviewDrain, type KodaXOptions } from '@kodax-ai/coding';
import { runClientPlaneRound, FileSessionStorage } from '@kodax-ai/repl';
import { formatSkillsSystemPrompt, SkillRegistry } from '@kodax-ai/agent/capabilities/skills';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { countTokens } from '../packages/agent/src/tokenizer.js';
import { McpCapabilityProvider } from '../packages/agent/src/capabilities/mcp/provider.js';
import { createMcpCapabilityId, writeMcpServerCatalog, type McpCapabilityDescriptor } from '../packages/agent/src/capabilities/mcp/catalog.js';
import { createExtensionRuntime } from '../packages/coding/src/extensions/runtime.js';
import { createKodaXRuntime } from '../src/sdk-runtime.js';
import { toKodaXProductClient } from '../src/client-runtime-adapter.js';
import { createCliClientPlane } from '../src/cli-client-plane.js';
import { compactContractInput } from './first-turn-compact-contract.js';
import { restructuredContractInput } from './restructured-contract.js';
import * as scriptModel from '../packages/coding/src/agent-runtime/script/model.js';
import type { Agent } from '@kodax-ai/agent';

// Layer 1: intercept every fetch after the real SDK serializes the request.
// No model, network, tool execution or token-usage claims are involved.
const TASK = '请简短说明你已准备好。';
const AGENTS = '# Fixture rules\nWIRE_AGENTS_FIXTURE: Preserve existing comments.\n';
const scenarios = ['empty', 'agents', 'catalogs', 'runtime-host'] as const;
type Protocol = 'openai' | 'anthropic';
type Body = Record<string, unknown> & { messages?: Array<{ role: string; content: unknown }>; tools?: unknown[] };

// Only facts created by this fixture are normalized. Tool descriptions/schema,
// user text, arbitrary dates/hex strings and every other request field survive.
function normalizeFixtureBody(body: Body, root: string, workspace: string, sessionId?: string) {
  const processedKeys: Array<{ key: string; fact: string; original: string }> = [];
  function visit(value: unknown, key: string): unknown {
    if (typeof value === 'string') {
      let normalized = value;
      if (key.startsWith('$.system') || key.startsWith('$.messages')) {
        normalized = normalized.replace(/^Session Scratch Directory: (.+)$/gm, (line: string, scratch: string) => {
          const prefix = path.join(workspace, '.agent', 'tmp', 'sessions') + path.sep;
          if (!scratch.startsWith(prefix)) return line;
          const actualId = scratch.slice(prefix.length);
          if (sessionId !== undefined) expect(actualId).toBe(sessionId);
          processedKeys.push({ key, fact: 'runtime.sessions.create.id in scratch path', original: actualId });
          return `Session Scratch Directory: ${prefix}<SESSION_ID>`;
        });
        normalized = normalized.replace(/^Snapshot: filesystem @ (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/gm,
          (_line: string, generatedAt: string) => {
            processedKeys.push({ key, fact: 'filesystem overview.generatedAt', original: generatedAt });
            return 'Snapshot: filesystem @ <FILESYSTEM_SNAPSHOT_TIME>';
          });
      }
      const absoluteRoot = path.resolve(root);
      for (const fixtureRoot of new Set([absoluteRoot, absoluteRoot.replaceAll('\\', '/')])) {
        if (normalized.includes(fixtureRoot)) {
          processedKeys.push({ key, fact: 'mkdtemp fixtureRoot', original: fixtureRoot });
          normalized = normalized.replaceAll(fixtureRoot, '<FIXTURE_ROOT>');
        }
      }
      return normalized;
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${key}[${index}]`));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, visit(item, `${key}.${name}`)]));
    return value;
  }
  return { body: visit(body, '$'), processedKeys };
}

function metric(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { chars: text.length, utf8Bytes: Buffer.byteLength(text), estimatedTokens: countTokens(text),
    sha256: createHash('sha256').update(text).digest('hex') };
}

function terminalSse(protocol: Protocol): string {
  if (protocol === 'openai') return [
    { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: '准备好了。' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return [
    { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '准备好了。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

it('inventories first serialized requests for isolated content and real Runtime Host scenarios', async () => {
  const wrappers: Agent[] = [];
  const originalScriptWrapper = scriptModel.withScriptModelTool;
  const scriptSpy = vi.spyOn(scriptModel, 'withScriptModelTool').mockImplementation((...args) => {
    const wrapped = originalScriptWrapper(...args);
    wrappers.push(wrapped);
    return wrapped;
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-first-turn-wire-'));
  const rows: Array<Record<string, unknown>> = [];
  const source = process.env.KODAX_FIRST_TURN_SOURCE_COMMIT
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  const sourcePaths = [
    'packages/coding/src/tools/tool-definitions.ts',
    'packages/coding/src/tools/managed-tool-contract.ts',
    'packages/coding/src/tools/managed-tool-text.ts',
    'packages/coding/src/prompts/managed-system-contract.ts',
    'packages/coding/src/prompts/compact-worker-contract.ts',
    'packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts',
    'packages/coding/src/agents/worker-role-prompt.ts',
    'packages/coding/src/task-engine/runner-driven.ts',
    'packages/coding/src/prompts/builder.ts',
    'packages/coding/src/agent-runtime/script/model.ts',
    'packages/coding/src/agent-runtime/script/pilot.ts',
    'packages/coding/src/work-mode.ts',
    'packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts',
    'packages/coding/src/agent-runtime/tool-exposure-planner.ts',
    'src/sdk-runtime.ts',
    ...(process.env.KODAX_COMPACT_CONTRACT_CAPTURE === 'candidate' ? [
      'tests/first-turn-compact-contract.ts', 'tests/first-turn-compact-contract-tools.ts',
      'tests/first-turn-compact-contract-baseline.ts',
    ] : []),
    ...(process.env.KODAX_COMPACT_CONTRACT_CAPTURE === 'restructured' ? [
      'tests/restructured-contract.ts', 'tests/restructured-worker-contract.ts',
    ] : []),
  ];
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
    [file, metric(await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).sha256])));
  const comparisonPath = process.env.KODAX_WIRE_COMPARE_INVENTORY;
  const previous = comparisonPath ? JSON.parse(await readFile(comparisonPath, 'utf8')) as {
    sourceHashes: Record<string, string>;
    rows: Array<{ cell: string; fixturePaths: { workspace: string }; wire: ReturnType<typeof metric> }>;
  } : undefined;
  if (previous) expect(sourceHashes).toEqual(previous.sourceHashes);
  vi.stubEnv('KODAX_WIRE_FIXTURE_KEY', 'synthetic-key');
  try {
    for (const protocol of ['openai', 'anthropic'] as const) {
      for (const mode of ['sa', 'ama', 'agent', 'script'] as const) {
        for (const scenario of scenarios) {
          const cell = `${protocol}-${mode}-${scenario}`;
          const directory = path.join(root, cell);
          const workspace = path.join(directory, 'workspace');
          const home = path.join(directory, 'home');
          await mkdir(workspace, { recursive: true });
          await mkdir(home, { recursive: true });
          vi.stubEnv('USERPROFILE', home);
          vi.stubEnv('HOME', home);
          expect(os.homedir()).toBe(home);
          setAgentConfigHome(home);
          if (scenario === 'agents' || scenario === 'catalogs') await writeFile(path.join(workspace, 'AGENTS.md'), AGENTS);
          const extension = createExtensionRuntime();
          let skillsPrompt = '';
          if (scenario === 'catalogs') {
            skillsPrompt = formatSkillsSystemPrompt([{ name: 'wire-fixture', description: 'WIRE_SKILLS_FIXTURE: inspect a synthetic sample.',
              path: path.join(workspace, 'SKILL.md'), source: 'project', userInvocable: true, disableModelInvocation: false }]);
            const cacheDir = path.join(directory, 'mcp-cache');
            const item: McpCapabilityDescriptor = { id: createMcpCapabilityId('wire-fixture', 'tool', 'inspect'),
              serverId: 'wire-fixture', kind: 'tool', name: 'inspect', summary: 'Synthetic cached inventory item.',
              risk: 'read', cachedAt: '2026-10-14T00:00:00.000Z' };
            await writeMcpServerCatalog(cacheDir, { serverId: 'wire-fixture', updatedAt: '2026-10-14T00:00:00.000Z',
              descriptors: [item], items: [item] });
            extension.registerCapabilityProvider(new McpCapabilityProvider({ 'wire-fixture': { type: 'stdio', command: 'never-executed-wire-fixture' } }, { cacheDir }));
          }
          const requests: string[] = [];
          const primaryRequests: string[] = [];
          const captureController = new AbortController();
          let runtimeSessionId: string | undefined;
          vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (!url.startsWith('https://wire-fixture.invalid/')) throw new Error(`Unexpected fetch in wire inventory: ${new URL(url).origin}`);
            const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : undefined;
            if (!body) throw new Error('SDK request body missing');
            requests.push(body);
            await writeFile(path.join(directory, `attempt-${requests.length}.json`), body, { flag: 'wx' });
            const parsed = JSON.parse(body) as Body;
            const primary = parsed.tools?.some(tool => {
              const item = tool as { name?: string; function?: { name: string } };
              return (item.name ?? item.function?.name) === 'todo_update';
            }) === true;
            if (primary) primaryRequests.push(body);
            if (!primary || primaryRequests.length > 1) {
              const error = new Error('Post-turn auxiliary request blocked by wire inventory');
              error.name = 'AbortError';
              throw error;
            }
            return new Response(terminalSse(protocol), { status: 200, headers: { 'content-type': 'text/event-stream' } });
          });
          const provider = `wire-${protocol}`;
          registerModelProvider(provider, () => {
            const instance = createCustomProvider({ name: provider, protocol, model: 'fixture-model',
              apiKeyEnv: 'KODAX_WIRE_FIXTURE_KEY', baseUrl: 'https://wire-fixture.invalid/v1', contextWindow: 128_000, reasoning: 'none' });
            if (['candidate', 'restructured'].includes(process.env.KODAX_COMPACT_CONTRACT_CAPTURE ?? '')) {
              const stream = instance.stream.bind(instance);
              instance.stream = (messages, tools, system, reasoning, options, signal) => {
                const script = wrappers.map(agent => scriptModel.getScriptModelContracts(agent, tools)).find(Boolean);
                const projected = process.env.KODAX_COMPACT_CONTRACT_CAPTURE === 'restructured'
                  ? restructuredContractInput({ messages, tools, system }, mode !== 'sa', script)
                  : compactContractInput({ messages, tools, system }, mode === 'ama' || mode === 'agent');
                return stream([...projected.messages], [...projected.tools], projected.system, reasoning, options, signal);
              };
            }
            return instance;
          });
          try {
            if (scenario === 'runtime-host') {
              const runtime = await createKodaXRuntime({ homeDir: home, sharedDaemonHost: true, defaultProvider: provider, defaultModel: 'fixture-model' });
              try {
                const plane = createCliClientPlane(toKodaXProductClient(runtime));
                const session = await runtime.sessions.create({ title: 'Wire inventory', surface: 'repl', projectPath: workspace });
                runtimeSessionId = session.id;
                await runtime.sessions.updateSettings(session.id, { agentMode: mode === 'sa' ? 'sa' : 'ama',
                  ...(mode === 'script' || mode === 'agent' ? { workMode: mode } : {}), executionCwd: workspace, permissionMode: 'full-access' });
                const result = await runClientPlaneRound({ plane, sessionId: session.id, prompt: TASK });
                expect(result.success).toBe(true);
              } finally { await runtime.close(); }
            } else {
              const options: KodaXOptions = { provider, agentMode: mode === 'sa' ? 'sa' : 'ama', maxIter: 1, reasoningMode: 'off', lsp: false,
                abortSignal: captureController.signal,
                ...(mode === 'agent' ? { workMode: 'agent' as const } : {}),
                ...(mode === 'script' ? { workMode: 'script' as const, session: {
                  storage: new FileSessionStorage({ sessionsDir: path.join(home, 'sessions'), configHome: home, cwd: workspace }),
                } } : {}),
                ...(scenario === 'catalogs' ? { extensionRuntime: extension } : {}),
                context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt,
                  skillRegistry: new SkillRegistry(workspace), repoIntelligenceMode: 'off' } };
              const result = await (mode === 'sa' ? runKodaX : runManagedTask)(options, TASK);
              expect(result.success).toBe(true);
            }
            captureController.abort();
            await awaitLatestCodingMemoryReviewDrain(5_000);
            expect(primaryRequests, `${cell}: exactly one root generation, excluding captured auxiliary requests`).toHaveLength(1);
            const raw = primaryRequests[0]!;
            const body = JSON.parse(raw) as Body;
            const { messages = [], tools = [], system, ...controls } = body;
            const systemMessages = messages.filter(message => message.role === 'system' || message.role === 'developer');
            const conversation = messages.filter(message => message.role !== 'system' && message.role !== 'developer');
            if (!process.env.KODAX_COMPACT_CONTRACT_CAPTURE && mode !== 'sa') {
              expect(JSON.stringify(system ?? systemMessages), `${cell}: default assembled contract`).toContain('TRUST AND SCOPE');
            }
            if (scenario === 'agents' || scenario === 'catalogs') expect(raw).toContain('WIRE_AGENTS_FIXTURE');
            if (scenario === 'catalogs') {
              expect(raw).toContain('WIRE_SKILLS_FIXTURE');
              expect(raw.includes(createMcpCapabilityId('wire-fixture', 'tool', 'inspect'))).toBe(true);
            }
            const toolNames = tools.map(tool => {
              const value = tool as { name?: string; function?: { name: string } };
              return value.name ?? value.function?.name;
            });
            expect(toolNames).toContain('todo_update');
            if (mode === 'agent') {
              expect(toolNames).toContain('read');
              expect(toolNames).not.toContain('relationship_scan');
              expect(toolNames).not.toContain('script_exec');
            }
            if (mode === 'script') {
              expect(toolNames).toContain('script_exec');
              expect(toolNames).toContain('undo');
              expect(toolNames).toContain('bash');
              expect(toolNames).not.toContain('read');
              expect(raw).toContain('Callable contracts (JSON Schema)');
            }
            // These SDK fixtures explicitly disable default LSP and supply no
            // service. The real Runtime Host retains its normal lazy service.
            if (scenario !== 'runtime-host') {
              expect(toolNames.filter(name => name?.startsWith('lsp_')), cell).toEqual([]);
            }
            const components = { system: metric(system ?? systemMessages), conversation: metric(conversation), tools: metric(tools), controls: metric(controls) };
            const normalized = normalizeFixtureBody(body, root, workspace, runtimeSessionId);
            let repeatComparison: Record<string, unknown> | undefined;
            if (previous && comparisonPath) {
              const prior = previous.rows.find(row => row.cell === cell);
              if (!prior) throw new Error(`Prior inventory lacks ${cell}`);
              const previousRoot = path.dirname(comparisonPath);
              const previousBody = JSON.parse(await readFile(path.join(previousRoot, cell, 'request.json'), 'utf8')) as Body;
              const priorNormalized = normalizeFixtureBody(previousBody, previousRoot, prior.fixturePaths.workspace);
              repeatComparison = { previousInventory: comparisonPath, previousRawSha256: prior.wire.sha256,
                rawBytesDelta: metric(raw).utf8Bytes - prior.wire.utf8Bytes, previousNormalizedSha256: metric(priorNormalized.body).sha256,
                priorProcessedKeys: priorNormalized.processedKeys };
              expect(metric(normalized.body).sha256, `${cell} normalized complete model input`).toBe(metric(priorNormalized.body).sha256);
            }
            const row = { cell, protocol, mode, scenario, boundary: 'SDK fetch serialized JSON body', wire: metric(raw), components,
              normalizedModelInput: metric(normalized.body), processedKeys: normalized.processedKeys, repeatComparison,
              toolCount: tools.length, toolNames, auxiliaryBlockedRequests: requests.filter(body => body !== raw).map(body => metric(body)), fixturePaths: { workspace, home } };
            await writeFile(path.join(directory, 'request.json'), raw, { flag: 'wx' });
            await writeFile(path.join(directory, 'normalized-model-input.json'), JSON.stringify(normalized.body, null, 2), { flag: 'wx' });
            rows.push(row);
            await writeFile(path.join(root, 'inventory.json'), JSON.stringify({ source, sourceHashes, externalCalls: 0,
              usageIsSynthetic: true, rows }, null, 2));
          } finally { captureController.abort(); await awaitLatestCodingMemoryReviewDrain(5_000); await extension.dispose(); clearRuntimeModelProviders(); }
        }
      }
    }
    expect(rows).toHaveLength(32);
    process.stdout.write(`Wire inventory saved: ${path.join(root, 'inventory.json')}\n`);
  } finally {
    scriptSpy.mockRestore();
    setAgentConfigHome(undefined);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    // Preserve this uniquely owned evidence directory; never clear shared dumps.
  }
}, 120_000);
