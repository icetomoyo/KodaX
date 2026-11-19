// FEATURE_311 acceptance: every entry sends one tool text and one Worker.
// A loopback provider records the first primary request of each root entry and
// of the children an AMA root spawns; no model or network is involved.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Runner } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig,
  type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { KodaXClient, createKodaXTaskRunner, runKodaX, runManagedTask, runOrchestration, startKodaX,
  type KodaXOptions } from '../packages/coding/src/index.js';
import { createDefaultCodingAgent } from '../packages/coding/src/default-coding-agent.js';
import { authorWorkflowViaWorker } from '../packages/coding/src/workflows/author-via-worker.js';
import { createKodaXRuntime } from './runtime-fixture.js';

const PROVIDER = 'f311-entry-matrix';
const MODEL = 'fixture-model';
const TASK = 'ENTRY_TASK: say you are ready.';
const WORKER_MARK = 'Preserve any exact machine-readable closing contract';
const RETIRED_SYSTEM_MD = 'helpful multi-provider coding agent';

interface Captured { system: string; tools: Map<string, string> }
type Reply = KodaXStreamResult;

const text = (value: string): Reply => ({ textBlocks: [{ type: 'text', text: value }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' });
const calls = (...blocks: Array<[string, Record<string, unknown>]>): Reply => ({ textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
  toolBlocks: blocks.map(([name, input], index) => ({ type: 'tool_use', id: `${name}-${index}-${Date.now()}`, name, input })) });

let directory = '';
let workspace = '';
let entry = '';
let spawnChildren = false;
let rootTurns = 0;
const captured = new Map<string, Captured>();

class LoopbackProvider extends KodaXBaseProvider {
  readonly name = PROVIDER;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_F311_ENTRY_KEY', model: MODEL, contextWindow: 128_000, supportsThinking: false };
  override isConfigured(): boolean { return true; }
  async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<Reply> {
    // Auxiliary judges and summaries carry at most one tool.
    if (tools.length <= 1) return text('done');
    const opening = JSON.stringify(messages);
    const role = opening.includes('CHILD_WRITE_MARK') ? 'write-child' : opening.includes('CHILD_READ_MARK') ? 'read-child' : 'root';
    const key = role === 'root' ? entry : `${entry}/${role}`;
    if (!captured.has(key)) captured.set(key, { system, tools: new Map(tools.map(tool => [tool.name, tool.description ?? ''])) });
    if (role !== 'root' || !spawnChildren) return text('done');
    rootTurns += 1;
    if (rootTurns === 1) return calls(
      ['spawn_agent', { task_name: 'writer', objective: 'CHILD_WRITE_MARK: append a line to README.md.', read_only: false }],
      ['spawn_agent', { task_name: 'reader', objective: 'CHILD_READ_MARK: report the README title.', read_only: true }]);
    if (rootTurns === 2) return calls(['wait_agent', { timeout_ms: 10_000 }]);
    return text('done');
  }
}

function options(extra: Partial<KodaXOptions> = {}, context: KodaXOptions['context'] = {}): KodaXOptions {
  return { provider: PROVIDER, model: MODEL, reasoningMode: 'off', lsp: false, maxIter: 4, disablePromptCache: true, ...extra,
    context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off', ...context } };
}

async function capture(name: string, run: () => Promise<unknown>): Promise<void> {
  entry = name;
  rootTurns = 0;
  await run();
  expect(captured.has(name), `${name} reached the provider`).toBe(true);
}

let unregister: () => void = () => undefined;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-f311-entry-'));
  workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Fixture\n');
  unregister = registerModelProvider(PROVIDER, () => new LoopbackProvider());
});
afterAll(async () => {
  unregister();
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

it('sends the managed Worker and one tool text from every entry', async () => {
  await capture('runManagedTask', () => runManagedTask(options(), TASK));
  await capture('runManagedTask/ama', () => runManagedTask(options({ agentMode: 'ama' }), TASK));
  await capture('runKodaX', () => runKodaX(options(), TASK));
  await capture('startKodaX', () => startKodaX(options(), TASK).result);
  await capture('startKodaX/ama', () => startKodaX(options({ agentMode: 'ama' }), TASK).result);
  await capture('KodaXClient', () => new KodaXClient(options()).send(TASK));
  await capture('createKodaXTaskRunner', () => runOrchestration({ workspaceDir: path.join(directory, 'orchestration'),
    tasks: [{ id: 'entry', title: 'Entry', prompt: TASK }], runner: createKodaXTaskRunner({ baseOptions: options(), buildPrompt: () => TASK }) }));
  await capture('Runner preset', () => Runner.run(createDefaultCodingAgent(), TASK, { presetOptions: options() }));
  await capture('authorWorkflowViaWorker', () => authorWorkflowViaWorker({ request: TASK,
    options: options({ workflowRunsBaseDir: path.join(directory, 'workflow-runs') }) }).session.result);
  await capture('persona root', () => runManagedTask(options({ agentMode: 'ama' }, { agentProfile: { instructions: 'PERSONA_MARK' } }), TASK));
  await capture('override root', () => runManagedTask(options({ agentMode: 'ama' }, { systemPromptOverride: 'OVERRIDE_MARK' }), TASK));
  await capture('visibility-policy root', () => runManagedTask(options({ agentMode: 'ama' },
    { toolVisibilityPolicy: ({ name }) => name !== 'web_fetch' }), TASK));

  const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(directory, 'home'), defaultProvider: PROVIDER, defaultModel: MODEL });
  try {
    for (const mode of [undefined, 'coding', 'managed_task'] as const) {
      const session = await runtime.sessions.create({ projectPath: workspace });
      await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
      await capture(`runs.start/${mode ?? 'default'}`, async () => {
        const handle = await runtime.runs.start({ sessionId: session.id, ...(mode ? { mode } : {}), prompt: TASK, options: options() });
        const result = await handle.result;
        expect(result.error, `runs.start/${mode ?? 'default'}`).toBeUndefined();
      });
    }
  } finally { await runtime.close(); }

  spawnChildren = true;
  await capture('children', () => runManagedTask(options({ agentMode: 'ama', maxIter: 6 },
    { resolveShellPermissionMode: () => 'full-access' }), TASK));
  spawnChildren = false;

  const roots = [...captured].filter(([name]) => !name.startsWith('children/'));
  for (const [name, request] of roots) {
    expect(request.system, name).toContain(WORKER_MARK);
    expect(request.system, name).not.toContain(RETIRED_SYSTEM_MD);
  }
  expect(captured.has('children/write-child')).toBe(true);
  expect(captured.has('children/read-child')).toBe(true);
  for (const [name, request] of captured) expect(request.system, name).not.toContain(RETIRED_SYSTEM_MD);

  // Ordinary roots of one agent mode send the same Worker, whatever the entry.
  const reference = (name: string) => captured.get(name)!.system;
  for (const name of ['runKodaX', 'startKodaX', 'KodaXClient', 'createKodaXTaskRunner', 'Runner preset']) {
    expect(reference(name), name).toBe(reference('runManagedTask'));
  }
  expect(reference('startKodaX/ama')).toBe(reference('runManagedTask/ama'));
  expect(reference('persona root')).toContain('PERSONA_MARK');
  expect(reference('override root').startsWith('OVERRIDE_MARK')).toBe(true);

  // A tool sends one source description from every entry and every generation.
  // tool_call and tool_search may append contracts for the deferred tools a Run actually has.
  const descriptions = new Map<string, Array<{ name: string; description: string }>>();
  for (const [name, request] of captured) {
    for (const [tool, description] of request.tools) descriptions.set(tool, [...(descriptions.get(tool) ?? []), { name, description }]);
  }
  const forked = [...descriptions].flatMap(([tool, variants]) => {
    const source = variants.map(variant => variant.description).reduce((a, b) => (b.length < a.length ? b : a));
    return variants.filter(variant => variant.description !== source
      && (!['tool_call', 'tool_search'].includes(tool) || !variant.description.startsWith(`${source}\n`)))
      .map(variant => `${tool} @ ${variant.name}`);
  });
  expect(forked).toEqual([]);
}, 240_000);

it('keeps no second tool text, Worker rewrite or system.md source', () => {
  for (const retired of ['packages/coding/src/prompts/text/prompts/system.md', 'packages/coding/src/prompts/system.ts',
    'packages/coding/src/prompts/builder.ts', 'packages/coding/src/prompts/compact-worker-contract.ts',
    'packages/coding/src/prompts/managed-system-contract.ts', 'packages/coding/src/prompts/compact-child-contract.ts',
    'packages/coding/src/prompts/text/tools/managed-tool-text.md', 'packages/coding/src/tools/managed-tool-text.ts']) {
    expect(existsSync(new URL(`../${retired}`, import.meta.url)), retired).toBe(false);
  }
});
