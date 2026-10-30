import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from '@kodax-ai/agent';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { runKodaX } from '@kodax-ai/coding';
import { createKodaXRuntime } from "./runtime-fixture.js";
import {
  KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXProviderConfig, type KodaXMessage, type KodaXToolDefinition,
} from '@kodax-ai/llm';

describe('zero-network replay of first-turn live smoke', () => {
  it.each(['original', 'no-hook', 'no-visibility', 'test-fallback'] as const)('%s: separates SDK host provisioning from guard and schema visibility', async (variant) => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-first-turn-replay-'));
    const target = path.join(fixture, 'sum.js');
    const original = '// Preserve this comment.\nexport function add(a, b) { return a - b; }\n';
    await fs.writeFile(target, original);
    const providerName = 'first-turn-smoke-replay';
    const transcripts: unknown[] = [];
    const guards: unknown[] = [];
    const controller = new AbortController();
    let toolCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Replay forbids network'); }));
    vi.stubEnv('KODAX_UNUSED_REPLAY_KEY', 'local-replay-fixture');
    vi.stubEnv('NODE_ENV', variant === 'test-fallback' ? 'test' : 'production');
    class ReplayProvider extends KodaXBaseProvider {
      readonly name = providerName;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'KODAX_UNUSED_REPLAY_KEY', model: 'scripted-replay', contextWindow: 128_000, supportsThinking: false,
      };
      async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string) {
        const turn = transcripts.length;
        transcripts.push(JSON.parse(JSON.stringify({ messages, tools, system })) as unknown);
        if (turn > 2) throw new Error('Replay three-response ceiling');
        const call = turn === 1
          ? { name: 'edit', input: { path: target, old_string: 'return a - b;', new_string: 'return a + b;' } }
          : { name: 'read', input: { path: target } };
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use' as const, id: `replay-${turn}`, ...call }], stopReason: 'tool_use' as const };
      }
    }
    setAgentConfigHome(path.join(fixture, 'home'));
    registerModelProvider(providerName, () => new ReplayProvider());
    try {
      const result = await runKodaX({
        provider: providerName, agentMode: 'sa', maxIter: 3, reasoningMode: 'off',
        maxOutputTokens: 2048, lsp: false, disablePromptCache: true, abortSignal: controller.signal,
        context: { executionCwd: fixture, gitRoot: fixture, skillsPrompt: '', skillRegistry: new SkillRegistry(fixture),
          repoIntelligenceMode: 'off', resolveShellPermissionMode: () => 'full-access',
          toolVisibilityPolicy: variant === 'no-visibility' ? undefined : tool => tool.name === 'read' || tool.name === 'edit' },
        events: variant === 'no-hook' ? {} : { beforeToolExecute: async (name, input, meta) => {
          if (toolCalls >= 2) { guards.push({ name, input, meta, toolCalls, abortedBefore: controller.signal.aborted, allowed: false, reason: 'two-tool ceiling' }); controller.abort(new Error('Replay two-tool ceiling')); return false; }
          toolCalls += 1;
          const resolved = typeof input.path === 'string' ? path.resolve(fixture, input.path) : undefined;
          const allowed = (name === 'read' || name === 'edit') && resolved?.toLowerCase() === target.toLowerCase();
          guards.push({ name, input, meta, toolCalls, abortedBefore: controller.signal.aborted, resolved, target, allowed });
          return allowed;
        } },
      }, '请读取 sum.js，把 add 的实现修正为加法，保留现有注释和格式。这是一个简单修复，只需精确编辑并简短报告完成，不需要运行命令或创建计划。');
      const content = await fs.readFile(target, 'utf8');
      const directory = path.join(os.tmpdir(), 'kodax-eval-dumps', 'first-turn-tokens-v1');
      await fs.mkdir(directory, { recursive: true });
      const source = process.env.KODAX_FIRST_TURN_REPLAY_SOURCE ?? 'candidate';
      if (!/^[a-z0-9-]+$/.test(source)) throw new Error('Invalid replay source label');
      await fs.writeFile(path.join(directory, `zero-network-replay-${source}-${variant}.json`), JSON.stringify({ source, variant, fixture, transcripts, guards, result, content }, null, 2));
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(transcripts).toHaveLength(3);
      if (variant === 'test-fallback') {
        expect(content).toBe(original.replace('a - b', 'a + b'));
        expect(JSON.stringify(transcripts[2])).toContain('File edited:');
      } else {
        // Lower-level runKodaX requires the production host to provision text mutations.
        // This assertion records the smoke harness limitation, not a successful live E2E.
        expect(content).toBe(original);
        expect(JSON.stringify(transcripts[2])).toContain('[Tool Error] edit: The trusted text transaction host is unavailable.');
      }
    } finally {
      clearRuntimeModelProviders(); setAgentConfigHome(undefined); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('kodax-first-turn-replay-')) throw new Error('Unsafe replay fixture');
      await fs.rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 30_000);

  it('production Runtime provisions the real host for captured read/edit calls', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-first-turn-replay-'));
    const workspace = path.join(fixture, 'workspace');
    await fs.mkdir(workspace);
    const target = path.join(workspace, 'sum.js');
    const original = '// Preserve this comment.\nexport function add(a, b) { return a - b; }\n';
    await fs.writeFile(target, original);
    const providerName = 'first-turn-runtime-replay';
    const transcripts: unknown[] = [];
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('KODAX_UNUSED_REPLAY_KEY', 'local-replay-fixture');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Replay forbids network'); }));
    class RuntimeReplayProvider extends KodaXBaseProvider {
      readonly name = providerName;
      readonly supportsThinking = false;
      protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_UNUSED_REPLAY_KEY', model: 'scripted-replay', contextWindow: 128_000, supportsThinking: false };
      async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string) {
        const turn = transcripts.length;
        transcripts.push(JSON.parse(JSON.stringify({ messages, tools, system })) as unknown);
        if (turn > 2) throw new Error('Runtime replay three-response ceiling');
        if (turn === 2) return { textBlocks: [{ type: 'text' as const, text: 'Scripted replay endpoint; not the live model third response.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' as const };
        const call = turn === 1
          ? { name: 'edit', input: { path: target, old_string: 'return a - b;', new_string: 'return a + b;' } }
          : { name: 'read', input: { path: target } };
        return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use' as const, id: `runtime-replay-${turn}`, ...call }], stopReason: 'tool_use' as const };
      }
    }
    registerModelProvider(providerName, () => new RuntimeReplayProvider());
    const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: path.join(fixture, 'home'), defaultProvider: providerName, defaultModel: 'scripted-replay', permissionTimeoutMs: 1000 });
    try {
      const session = await runtime.sessions.create({ projectPath: workspace });
      await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
      const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'Read sum.js and change subtraction to addition, preserving the comment and formatting.', options: {
        agentMode: 'sa', reasoningMode: 'off', maxIter: 3, maxOutputTokens: 2048, lsp: false, disablePromptCache: true,
        context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', skillRegistry: new SkillRegistry(workspace), repoIntelligenceMode: 'off', toolVisibilityPolicy: tool => tool.name === 'read' || tool.name === 'edit' },
      } });
      const result = await handle.result;
      const content = await fs.readFile(target, 'utf8');
      const directory = path.join(os.tmpdir(), 'kodax-eval-dumps', 'first-turn-tokens-v1');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'zero-network-runtime-production-replay.json'), JSON.stringify({ fixture, transcripts, result, content, nativeHostInjectedBy: 'createKodaXRuntime', scriptedFinalResponse: true }, null, 2));
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(transcripts).toHaveLength(3);
      expect(content).toBe(original.replace('a - b', 'a + b'));
      expect(JSON.stringify(transcripts[2])).toContain('File edited:');
      expect(result.result?.success).toBe(true);
    } finally {
      await runtime.close(); clearRuntimeModelProviders(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
      if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('kodax-first-turn-replay-')) throw new Error('Unsafe replay fixture');
      await fs.rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }, 30_000);
});
