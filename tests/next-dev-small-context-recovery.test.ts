import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { expect, it, vi } from 'vitest';
import { calculateContextSafetyMargin, countTokens, estimateTokens, persistCompactedSessionHistory } from '@kodax-ai/agent';
import { createCustomProvider, registerModelProvider, type KodaXMessage, type KodaXToolUseBlock } from '@kodax-ai/llm';
import { FileSessionStorage } from '@kodax-ai/repl';
import { estimateToolSchemaTokens } from '../packages/coding/src/agent-runtime/context-budget.js';
import { countCompactionRequestTokens } from '../packages/agent/src/session-lineage/compaction/summary-generator.js';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from '../packages/llm/src/providers/capability-profile.js';
import { createKodaXRuntime, type KodaXRuntime } from './runtime-fixture.js';

// Deterministic engineering acceptance, not a model-quality or API-token claim.
// Scoped-rule directory refresh remains covered separately by agents-loader tests.
it.each([32_768, 65_536])('keeps paged and owned evidence recoverable across Runs at %i context tokens', async contextWindow => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-next-small-context-'));
  const imagePath = path.join(root, 'source.png');
  const textPath = path.join(root, 'evidence.txt');
  const png = await new Jimp({ width: 2, height: 2, color: 0x00ff00ff }).getBuffer('image/png');
  const line = Array.from({ length: 16_000 }, (_, index) => `entry-${index}:🙂;`).join('');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  await writeFile(imagePath, png); await writeFile(textPath, line);
  vi.stubEnv('KODAX_NEXT_SMALL_CONTEXT_KEY', 'offline-fixture');
  vi.stubGlobal('fetch', () => { throw new Error('Small-context acceptance forbids network access.'); });
  let phase = 0, step = 0, cursor = 0, observationId = '';
  let failure: unknown;
  const requests: { phase: number; messages: KodaXMessage[]; system: string }[] = [];
  const wires: { phase: number; body: unknown }[] = [];
  const receipts: { phase: number; id: string; text: string }[] = [];
  const providerName = `small-context-${contextWindow}`;
  const unregister = registerModelProvider(providerName, () => {
    const provider = createCustomProvider({ name: providerName, protocol: 'openai', model: 'fixture', imageInput: true,
      contextWindow, maxOutputTokens: 1_024, apiKeyEnv: 'KODAX_NEXT_SMALL_CONTEXT_KEY',
      baseUrl: 'https://small-context.invalid', capabilityProfile: { ...NATIVE_PROVIDER_CAPABILITY_PROFILE } });
    Reflect.set(provider, '_client', { chat: { completions: { create: async (body: unknown) => {
      wires.push({ phase, body: structuredClone(body) });
      return { choices: [{ message: { content: 'Offline serialization.' }, finish_reason: 'stop' }] };
    } } } });
    provider.stream = async (messages, tools, system, reasoning, options) => {
      try {
        expect(provider.getEffectiveContextWindow('fixture')).toBe(contextWindow);
        const summaryRequest = system.includes('context summarization specialist')
          || JSON.stringify(messages.at(-1)?.content).includes('CRITICAL COMPACTION MODE')
          || options?.ephemeralSuffix?.content.includes('CRITICAL COMPACTION MODE') === true;
        const inputTokens = summaryRequest ? countCompactionRequestTokens({ messages, tools, system,
          ephemeralSuffix: options?.ephemeralSuffix })
          : estimateTokens(messages) + countTokens(system) + tools.reduce((sum, tool) => sum + estimateToolSchemaTokens(tool), 0)
            + countTokens(options?.ephemeralSuffix?.content ?? '');
        const outputTokens = options?.maxOutputTokensOverride ?? provider.getEffectiveMaxOutputTokens('fixture');
        expect(outputTokens).toBeGreaterThan(0);
        expect(inputTokens + outputTokens + calculateContextSafetyMargin(inputTokens, contextWindow)).toBeLessThanOrEqual(contextWindow);
        await provider.complete(messages, tools, system, reasoning, options);
        if (summaryRequest || !tools.some(tool => tool.name === 'todo_update')) return {
          textBlocks: [{ type: 'text', text: '<summary>## Goal\nRecover the retained image and paged evidence.\n## Progress\nCompleted tools must not be repeated.\n## Next Steps\nContinue the current request using owned evidence.</summary>' }],
          thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
        };
        requests.push({ phase, messages: structuredClone(messages), system });
        const call = (id: string, name: string, input: Record<string, unknown>): KodaXToolUseBlock => tools.some(tool => tool.name === name)
          ? { type: 'tool_use', id, name, input }
          : { type: 'tool_use', id, name: 'tool_call', input: { name, input } };
        observationId ||= JSON.stringify(messages).match(/obs_[a-f0-9-]{36}/)?.[0] ?? '';
        expect(observationId).not.toBe('');
        let calls: KodaXToolUseBlock[] = [];
        if (phase === 0 && step === 0) calls = [call('page-first', 'read', { path: textPath, offset: 1, limit: 1 })];
        if (phase === 0 && step === 1) {
          const first = receipts.find(receipt => receipt.id.startsWith('page-first'));
          cursor = Number(first?.text.match(/line_offset=(\d+)/)?.[1]);
          expect(cursor).toBeGreaterThan(0);
          calls = [call('page-next', 'read', { path: textPath, offset: 1, limit: 1, line_offset: cursor })];
        }
        if (phase === 1 && step === 0) {
          // Identical individually legal single-view calls exceed the shared batch
          // bound together. A successful sibling distinguishes this from a bad call.
          calls = Array.from({ length: 24 }, (_, index) => call(`sibling-${index}`, 'visual_inspect', {
            question: 'Recall the retained original.', views: [{ label: 'original', observationId }],
          }));
        }
        if ((phase === 1 && step === 1) || (phase === 2 && step === 0)) calls = [call('later-image', 'visual_inspect', {
          question: 'Recall the retained original.', views: [{ label: 'original', observationId }],
        })];
        expect(step++).toBeLessThan(3);
        return { textBlocks: calls.length ? [] : [{ type: 'text', text: 'Evidence checked.' }], thinkingBlocks: [],
          toolBlocks: calls, stopReason: calls.length ? 'tool_use' : 'end_turn' };
      } catch (error) { failure = error; throw error; }
    };
    return provider;
  });
  const open = () => createKodaXRuntime({ homeDir: root, sharedDaemonHost: true, defaultProvider: providerName, defaultModel: 'fixture' });
  let runtime: KodaXRuntime | undefined;
  try {
    runtime = await open();
    const session = await runtime.sessions.create({ projectPath: root, draft: true });
    await runtime.sessions.updateSettings(session.id, { provider: providerName, model: 'fixture', permissionMode: 'full-access', workMode: 'coding' });
    const run = async (next: number) => {
      phase = next; step = 0;
      const handle = await runtime!.runs.start({ sessionId: session.id, mode: 'managed_task',
        prompt: next === 0 ? 'Read two consecutive pages of evidence.txt and retain the supplied image.' : 'Inspect the retained original image.',
        options: { agentMode: 'ama', reasoningMode: 'off', lsp: false,
          context: { skillsPrompt: '', repoIntelligenceMode: 'off', ...(next === 0 ? {
            inputArtifacts: [{ kind: 'image', path: imagePath, mediaType: 'image/png' }],
          } : {}) },
          learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['offline'] } }),
          events: { onToolResult: result => { receipts.push({ phase, id: result.id,
            text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }); } },
        } });
      const result = await handle.result;
      if (failure) throw failure;
      expect(result.phase, result.error?.message).toBe('completed');
      expect(step).toBe(next === 2 ? 2 : 3);
    };
    await run(0);
    const nextPage = receipts.find(receipt => receipt.id.startsWith('page-next'))!;
    expect(nextPage.text).toContain(Array.from(line).slice(cursor, cursor + 24).join(''));
    expect(await readFile(textPath, 'utf8')).toBe(line);
    await run(1);
    const siblings = receipts.filter(receipt => receipt.phase === 1 && receipt.id.startsWith('sibling-'));
    expect(siblings).toHaveLength(24);
    expect(siblings.some(receipt => receipt.text.includes('capacity unavailable'))).toBe(true);
    expect(siblings.some(receipt => !receipt.text.includes('[Tool Error]') && receipt.text.includes(observationId))).toBe(true);
    const laterImage = receipts.find(receipt => receipt.phase === 1 && receipt.id.startsWith('later-image'));
    expect(laterImage?.text).toContain(observationId);
    expect(laterImage?.text).not.toContain('[Tool Error]');
    const previousContext = requests.filter(request => request.phase === 0).at(-1)!.messages
      .find(message => message._source === 'managed-run-context');
    expect(previousContext).toBeDefined();
    expect(requests.find(request => request.phase === 1)!.messages).toContainEqual(previousContext);
    await runtime.close(); runtime = undefined;
    const storage = new FileSessionStorage({ sessionsDir: path.join(root, '.kodax', 'sessions'), configHome: path.join(root, '.kodax') });
    const lineage = (await storage.loadFullLineage(session.id))!;
    const owned = lineage.entries.flatMap(entry => entry.type === 'message' && Array.isArray(entry.message.content)
      ? entry.message.content : []).find(block => block.type === 'image');
    expect(owned?.type).toBe('image');
    if (!owned || owned.type !== 'image') throw new Error('Missing canonical owned image.');
    expect(owned.path).not.toBe(imagePath);
    expect(hash(await readFile(owned.path))).toBe(hash(png));
    await rm(imagePath);
    for (let index = 0; index < 2; index++) {
      const before = (await storage.load(session.id))!;
      const summary = `Retained original: ${observationId}. The first two text pages were read; do not replay tools.`;
      const compactedMessages: KodaXMessage[] = [{ role: 'system', content: `[对话历史摘要]\n\n${summary}` }];
      await persistCompactedSessionHistory({ storage, sessionId: session.id, compactedMessages,
        update: { preCompactionMessages: before.messages, anchor: { summary, tokensBefore: estimateTokens(before.messages),
          tokensAfter: estimateTokens(compactedMessages), entriesRemoved: before.messages.length, reason: 'manual' } } });
    }
    runtime = await open();
    await run(2);
    expect(receipts.find(receipt => receipt.phase === 2 && receipt.id.startsWith('later-image'))?.text).toContain(observationId);
    expect(receipts.find(receipt => receipt.phase === 2 && receipt.id.startsWith('later-image'))?.text).not.toContain('[Tool Error]');
    expect(JSON.stringify(wires.filter(wire => wire.phase === 2).at(-1)?.body)).toContain(png.toString('base64'));
    expect(hash(await readFile(owned.path))).toBe(hash(png));
  } finally {
    await runtime?.close(); unregister(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 90_000);
