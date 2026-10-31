import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActorController } from '@kodax-ai/agent';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { executeChildAgents, CHILD_AGENT_SYSTEM_PROMPT, type ChildExecutorOptions } from './child-executor.js';
import { runKodaX } from './agent.js';
import { getBuiltinToolDefinition, listToolDefinitions } from './tools/index.js';
import { projectModelToolDefinition } from './tools/model-tool-definition.js';
import { projectManagedToolContract } from './tools/managed-tool-contract.js';
import { _resetAgentResolverForTesting, registerConstructedAgent } from './construction/agent-resolver.js';
import { clearAgentsLoaderCacheForTesting } from './context/agents-loader.js';
import * as childScope from './prompts/child-contract-scope.js';
import * as childContract from './prompts/compact-child-contract.js';

const providerName = 'child-contract-assembly';
const providerKey = 'KODAX_CHILD_CONTRACT_ASSEMBLY_KEY';
const captured: { system: string; tools: readonly KodaXToolDefinition[]; messages: readonly KodaXMessage[] }[] = [];
let response: (() => KodaXStreamResult) | undefined;
class ContractProvider extends KodaXBaseProvider {
  readonly name = providerName;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = { apiKeyEnv: providerKey, model: 'offline',
    supportsThinking: false, contextWindow: 128_000, maxOutputTokens: 1000 };
  async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
    captured.push({ system, tools, messages });
    if (response) return response();
    return { textBlocks: [{ type: 'text', text: 'Inspected; no changes.' }], toolBlocks: [], thinkingBlocks: [] };
  }
}

describe('builtin child request contract through real executor and substrate', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kodax-child-contract-'));
    captured.length = 0;
    response = undefined;
    process.env[providerKey] = 'offline-fixture';
    registerModelProvider(providerName, () => new ContractProvider());
    clearAgentsLoaderCacheForTesting();
    _resetAgentResolverForTesting();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearRuntimeModelProviders();
    _resetAgentResolverForTesting();
    delete process.env[providerKey];
    rmSync(root, { recursive: true, force: true });
  });
  const options = (): ChildExecutorOptions => ({ maxParallel: 2, maxIterationsPerChild: 1,
    parentRole: 'worker', parentHarness: 'tool-dispatch',
    parentOptions: { provider: providerName, reasoningMode: 'off', repoIntelligenceMode: 'off' },
    actorControl: new AgentActorController().bind('/root') });
  const bundle = (readOnly: boolean, specialistName?: string) => ({ id: readOnly ? 'reader' : 'writer',
    fanoutClass: 'evidence-scan' as const, objective: 'Inspect the assigned file and report evidence.',
    constraints: ['Do not publish'], evidenceRefs: [], readOnly, specialistName });
  const ctx = () => ({ backups: new Map(), executionCwd: root, gitRoot: root,
    resolveShellPermissionMode: () => 'full-access' as const });

  it.each([true, false])('compacts the real readonly=%s child request without removing live authority or tools', async readOnly => {
    const claim = vi.spyOn(childScope, 'claimBuiltinChildContract');
    const project = vi.spyOn(childContract, 'projectBuiltinChildRequestContract');
    writeFileSync(join(root, 'AGENTS.md'), '# Rules\n\nKeep the project sentinel unchanged.\n');
    const result = await executeChildAgents([bundle(readOnly)], ctx(), options());
    expect(result.results[0]?.status).toBe('completed');
    expect(captured).toHaveLength(1);
    expect(claim.mock.results[0]?.value, 'executor provenance must reach the real substrate').toBeDefined();
    const [source, request, full] = project.mock.calls[0]!;
    expect(request.tools, 'normal fit must preserve the complete menu').toEqual(full);
    const base = { system: source!.system, tools: request.tools };
    expect(childContract.buildCompactChildContractCandidate(base, { source: 'builtin-child' }), 'canonical pair must qualify').not.toBe(base);
    const wire = captured[0]!;
    expect(wire.system).toContain(CHILD_AGENT_SYSTEM_PROMPT);
    expect(wire.system).toContain('## Shared tool obligations');
    expect(wire.system).toContain('Current permission mode: full-access');
    expect(wire.system).toContain(readOnly ? 'Current task scope: read-only' : 'Ordinary local text targets');
    expect(wire.system.includes('Keep the project sentinel unchanged.')).toBe(!readOnly);
    for (const name of ['read', 'glob', 'grep', 'spawn_agent', 'todo_update']) {
      const actual = wire.tools.find(tool => tool.name === name)!;
      const canonical = projectModelToolDefinition(getBuiltinToolDefinition(name)!, { kind: 'builtin' });
      const expected = projectManagedToolContract(canonical);
      expect(actual.description, name).toBe(expected.description);
      expect(actual.input_schema, name).toEqual(expected.input_schema);
    }
    expect(wire.tools.some(tool => tool.name === 'edit')).toBe(!readOnly);
    expect(wire.tools.some(tool => ['get_goal', 'create_goal', 'update_goal'].includes(tool.name))).toBe(false);
    expect(wire.messages.some(message => JSON.stringify(message).includes('## Shared tool obligations'))).toBe(false);
  });

  it('does not project a matching SDK override or a specialist using the identical builtin instructions', async () => {
    await runKodaX({ provider: providerName, reasoningMode: 'off', maxIter: 1,
      context: { executionCwd: root, currentAgentId: 'sdk-child', systemPromptOverride: CHILD_AGENT_SYSTEM_PROMPT,
        repoIntelligenceMode: 'off' } }, 'Inspect.');
    registerConstructedAgent({ kind: 'agent', name: 'matching-specialist', version: '1.0.0',
      content: { instructions: CHILD_AGENT_SYSTEM_PROMPT,
        tools: listToolDefinitions().map(tool => ({ ref: `builtin:${tool.name}` })) },
      status: 'active', createdAt: Date.now(), testedAt: Date.now(), activatedAt: Date.now() });
    await executeChildAgents([bundle(true, 'matching-specialist')], ctx(), options());
    expect(captured).toHaveLength(2);
    for (const wire of captured) {
      expect(wire.system).not.toContain('## Shared tool obligations');
      expect(wire.tools.find(tool => tool.name === 'glob')?.description)
        .toBe(getBuiltinToolDefinition('glob')!.description);
    }
  });

  it('keeps a custom visibility policy on the canonical contract', async () => {
    await executeChildAgents([bundle(true)], { ...ctx(), toolVisibilityPolicy: () => true }, options());
    expect(captured).toHaveLength(1);
    expect(captured[0]!.system).not.toContain('## Shared tool obligations');
    expect(captured[0]!.tools.find(tool => tool.name === 'glob')?.description)
      .toBe(getBuiltinToolDefinition('glob')!.description);
  });

  it('retains the paired teaching across turns while refreshing live permission changes', async () => {
    writeFileSync(join(root, 'evidence.txt'), 'Current evidence.');
    let mode: 'full-access' | 'plan' = 'full-access';
    response = () => {
      if (captured.length === 1) {
        mode = 'plan';
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'read-evidence',
          name: 'read', input: { path: join(root, 'evidence.txt') } }] };
      }
      return { textBlocks: [{ type: 'text', text: 'Read evidence; no changes.' }], thinkingBlocks: [], toolBlocks: [] };
    };
    await executeChildAgents([bundle(false)], { ...ctx(), resolveShellPermissionMode: () => mode },
      { ...options(), maxIterationsPerChild: 2 });
    expect(captured).toHaveLength(2);
    expect(captured[0]!.system).toContain('Current permission mode: full-access');
    expect(captured[1]!.system).toContain('Current permission mode: plan');
    expect(captured[1]!.system).toContain('Read-only planning. Do not perform ordinary file mutations.');
    for (const wire of captured) {
      expect(wire.system).toContain('## Shared tool obligations');
      expect(wire.tools.find(tool => tool.name === 'glob')?.description).toBe('Find file paths by glob.');
      expect(wire.messages.some(message => JSON.stringify(message).includes('## Shared tool obligations'))).toBe(false);
    }
  });
});
