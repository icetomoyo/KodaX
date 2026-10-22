import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXToolDefinition } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each([1, 2])('settles a restored AMA completion with a %i-response budget without claiming a censored report completed', async limit => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('KODAX_TERMINAL_MAILBOX_KEY', 'offline-only');
  const fetcher = vi.fn(async () => { throw new Error('Offline regression forbids network'); });
  vi.stubGlobal('fetch', fetcher);
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-terminal-mailbox-'));
  const providerName = `terminal-mailbox-${randomUUID()}`;
  const requests: Array<{ messages: KodaXMessage[]; tools: string[] }> = [];
  let responses = 0;
  class Offline extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_TERMINAL_MAILBOX_KEY', model: 'offline', supportsThinking: false,
    };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]) {
      requests.push({ messages: structuredClone(messages), tools: tools.map(tool => tool.name) });
      if (responses >= limit) throw new Error('offline-budget-censored: response cap');
      responses++;
      return { textBlocks: [{ type: 'text' as const, text: responses === 1 ? 'Initial synthetic report.' : 'Acknowledged failed QA; independent review remains incomplete.' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' as const };
    }
  }
  const unregister = registerModelProvider(providerName, () => new Offline());
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    runtime = await createKodaXRuntime({ mode: 'embedded', homeDir, defaultProvider: providerName });
    const session = await runtime.sessions.create({ projectPath: homeDir });
    const child = await runtime.agents.spawn(session.id, { taskName: 'qa', objective: 'Review without an attached run.' });
    await expect(runtime.agents.wait(session.id, 2, 1000)).resolves.toMatchObject({
      kind: 'turn_failed', actorPath: '/root/qa', turnId: child.turnId,
    });
    await runtime.close();
    runtime = await createKodaXRuntime({ mode: 'embedded', homeDir, defaultProvider: providerName });
    await runtime.sessions.load(session.id);
    const options = { provider: providerName, agentMode: 'ama' as const, reasoningMode: 'off' as const,
      maxIter: 4, lsp: false,
      learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] },
        capabilityDecision: { disposition: 'discard' as const, reasonCodes: ['offline-test'] } }),
    };
    const handle = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'Report the work and unfinished QA.', options });
    const result = await handle.result;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages.at(-1)?.content).toBe('Report the work and unfinished QA.');
    expect(requests[1]?.messages.at(-1)).toMatchObject({ _synthetic: true, _source: 'agent-completed',
      _taskResult: { taskId: child.turnId, status: 'failed' } });
    expect(requests[1]?.tools).toEqual(requests[0]?.tools);
    expect(requests[1]?.tools).toContain('spawn_agent');
    if (limit === 1) {
      expect(result.phase).toBe('failed');
      expect(result.result?.success).not.toBe(true);
    } else {
      expect(result.phase).toBe('completed');
      expect(result.result).toMatchObject({ success: true, lastText: 'Acknowledged failed QA; independent review remains incomplete.' });
      await runtime.close();
      runtime = await createKodaXRuntime({ mode: 'embedded', homeDir, defaultProvider: providerName });
      await runtime.sessions.load(session.id);
      responses = 0;
      requests.length = 0;
      const next = await runtime.runs.start({ sessionId: session.id, mode: 'managed_task', prompt: 'A new independent turn.', options });
      expect((await next.result).phase).toBe('completed');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.messages.at(-1)?.content).toBe('A new independent turn.');
    }
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await runtime?.close();
    unregister();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
