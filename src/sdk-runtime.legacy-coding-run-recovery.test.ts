// FEATURE_311: a Run persisted by an older build with mode 'coding' (the retired
// direct engine) stays readable and recovers on the managed Worker. Recovery must
// not fall back to system.md or lose the saved history.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionLineage } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import { KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';

const WORKER_MARK = 'Preserve any exact machine-readable closing contract';
const RETIRED_SYSTEM_MD = 'helpful multi-provider coding agent';

it('recovers a persisted coding-mode Run on the managed Worker with its saved history', async () => {
  const temporaryRoot = resolve(tmpdir());
  const homeDir = await mkdtemp(join(temporaryRoot, 'kodax-legacy-coding-run-'));
  const configHome = join(homeDir, '.kodax');
  const sessionId = 'legacy-coding-session';
  const runId = 'legacy-coding-run';
  const providerName = 'legacy-coding-offline';
  const fetcher = vi.fn(() => { throw new Error('Legacy recovery fixture cannot make HTTP requests.'); });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('UNUSED_LEGACY_CODING_KEY', 'offline-fixture-only');
  const requests: Array<{ system: string; messages: KodaXMessage[]; tools: string[] }> = [];
  class FixtureProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'UNUSED_LEGACY_CODING_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
      requests.push({ system, messages, tools: tools.map(tool => tool.name) });
      return { textBlocks: [{ type: 'text', text: 'Continued the original task; EDIT031 stays done.' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider(providerName, () => new FixtureProvider());
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    const task = 'Continue the original task without repeating EDIT031.';
    const messages: KodaXMessage[] = [
      { role: 'user', content: task },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'completed-edit', name: 'write',
        input: { path: join(homeDir, 'notes.md'), content: 'EDIT031\n' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'completed-edit', content: 'EDIT031 completed and verified.' }] },
    ];
    const lineage = createSessionLineage(messages);
    await new FileSessionStorage({ sessionsDir: join(configHome, 'sessions'), configHome }).save(sessionId,
      { title: 'Legacy coding checkpoint', gitRoot: homeDir, messages, lineage, runtimeInfo: { surface: 'partner' } });
    const checkpoint = { version: 1, sessionId, turnId: 'original-turn', activeEntryId: lineage.activeEntryId,
      messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
    const runDir = join(configHome, 'runtime', 'runs', runId);
    await mkdir(runDir, { recursive: true });
    // An older build wrote mode 'coding' and started the direct engine without agentMode.
    await writeFile(join(runDir, 'status.json'), JSON.stringify({ runId, sessionId, phase: 'recovering',
      mode: 'coding', provider: providerName, model: 'fixture', startedAt: '2026-11-01T00:00:00Z',
      contextRecovery: { waitingSince: '2026-11-01T00:00:00Z', checkpoint },
      _runtime: { revision: 1, owner: { ownerId: 'dead-legacy-owner', runtimeId: 'dead-legacy-runtime',
        pid: 2147483647, startedAt: '2026-11-01T00:00:00Z' } } }));
    await writeFile(join(runDir, 'generation-recovery.json'), JSON.stringify({ version: 1, checkpoint,
      start: { prompt: task, options: { provider: providerName, model: 'fixture', lsp: false, reasoningMode: 'off',
        context: { gitRoot: homeDir, executionCwd: homeDir, repoIntelligenceMode: 'off' } }, requiredBindings: [] },
      requiresCredential: false, requiresHostTools: false, actorTurnBaseline: [] }));

    runtime = await createKodaXRuntime({ homeDir, defaultProvider: providerName, defaultModel: 'fixture' });
    expect(await runtime.runs.get(runId)).toMatchObject({ phase: 'recovering', mode: 'coding' });

    const recovered = await runtime.runs.recover({ runId });
    expect(recovered.runId).toBe(runId);
    const result = await recovered.result;
    expect(result, JSON.stringify(result)).toMatchObject({ phase: 'completed' });
    expect(await runtime.runs.get(runId)).toMatchObject({ phase: 'completed' });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.system).toContain(WORKER_MARK);
    expect(request!.system).not.toContain(RETIRED_SYSTEM_MD);
    expect(JSON.stringify(request!.messages)).toContain('EDIT031 completed and verified.');
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await runtime?.close();
    clearRuntimeModelProviders();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (dirname(homeDir) !== temporaryRoot) throw new Error('Unsafe legacy fixture cleanup.');
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
