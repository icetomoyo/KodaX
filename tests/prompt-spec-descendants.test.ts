// Application rules must reach every write descendant of a managed Run, not only its direct children.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig, type KodaXToolDefinition } from '@kodax-ai/llm';
import { createKodaXRuntime } from './runtime-fixture.js';

const PROVIDER = 'prompt-spec-descendants';
const MODEL = 'stub-model';
const RULE = 'RULE_SENTINEL: do not run shell commands.';
const CHILD_TASK = 'CHILD_TASK_MARK: delegate the fix to one write child.';
const GRANDCHILD_TASK = 'GRANDCHILD_TASK_MARK: edit README.md.';

type Role = 'root' | 'child' | 'grandchild';
type Reply = Awaited<ReturnType<KodaXBaseProvider['stream']>>;

const text = (value: string): Reply => ({ textBlocks: [{ type: 'text', text: value }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' });
const call = (name: string, input: Record<string, unknown>): Reply => ({ textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
  toolBlocks: [{ type: 'tool_use', id: `${name}-${Math.random().toString(36).slice(2)}`, name, input }] });

/** Root and child each spawn one write agent, wait for it, then finish. */
function script(role: Role, turn: number, objective: string | undefined): Reply {
  if (role === 'grandchild' || objective === undefined) return text('done');
  if (turn === 0) return call('spawn_agent', { task_name: `helper_${role}`, objective, read_only: false });
  if (turn === 1) return call('wait_agent', { timeout_ms: 10_000 });
  return text('done');
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function runTree(): Promise<Map<Role, string>> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-prompt-spec-descendants-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Fixture\n');
  const systems = new Map<Role, string>();
  const turns = new Map<Role, number>();
  let rootSystem: string | undefined;
  class StubProvider extends KodaXBaseProvider {
    readonly name = PROVIDER;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_PROMPT_SPEC_DESCENDANTS_KEY', model: MODEL, contextWindow: 128000, supportsThinking: false };
    override isConfigured(): boolean { return true; }
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<Reply> {
      // Auxiliary judges carry at most one tool.
      if (tools.length <= 1) return text('done');
      rootSystem ??= system;
      const opening = JSON.stringify(messages.slice(0, 2));
      const role: Role = system === rootSystem ? 'root' : opening.includes('GRANDCHILD_TASK_MARK') ? 'grandchild' : 'child';
      if (!systems.has(role)) systems.set(role, system);
      const turn = turns.get(role) ?? 0;
      turns.set(role, turn + 1);
      const canSpawn = tools.some((tool) => tool.name === 'spawn_agent');
      return script(role, turn, canSpawn ? (role === 'root' ? CHILD_TASK : GRANDCHILD_TASK) : undefined);
    }
  }
  const unregister = registerModelProvider(PROVIDER, () => new StubProvider());
  const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(directory, 'home'), defaultProvider: PROVIDER, defaultModel: MODEL });
  cleanups.push(async () => { await runtime.close(); unregister(); });
  const session = await runtime.sessions.create({ projectPath: workspace });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
  const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: CHILD_TASK, options: {
    provider: PROVIDER, model: MODEL, agentMode: 'ama', reasoningMode: 'off', lsp: false, maxIter: 6, disablePromptCache: true, workMode: 'agent',
    context: { executionCwd: workspace, gitRoot: workspace, repoIntelligenceMode: 'off', resolveShellPermissionMode: () => 'full-access',
      prompt: { context: [{ key: 'no-shell', kind: 'rule', text: RULE }] } },
  } });
  const result = await handle.result;
  if (result.error) throw new Error(`${result.error.name}: ${result.error.message}`);
  return systems;
}

describe('application rules across agent generations', () => {
  it('reach the write child and the write grandchild', async () => {
    const systems = await runTree();
    expect([...systems.keys()]).toEqual(['root', 'child', 'grandchild']);
    expect(systems.get('root')).not.toContain('RULE_SENTINEL');
    expect(systems.get('child')).toContain('## Application rule: no-shell');
    expect(systems.get('child')).toContain('RULE_SENTINEL');
    expect(systems.get('grandchild')).toContain('RULE_SENTINEL');
  }, 120_000);
});
