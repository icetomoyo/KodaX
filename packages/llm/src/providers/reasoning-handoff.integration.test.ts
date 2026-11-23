/**
 * Live reasoning-handoff matrix — Issue 441.
 *
 * SKIPPED by default (CI has no keys). Run against real provider HTTP with:
 *
 *   KODAX_INTEGRATION_TEST=1 REASONING_HANDOFF_LABEL=baseline npm run test:integration -- \
 *     packages/llm/src/providers/reasoning-handoff.integration.test.ts
 *
 * Optional filters: REASONING_HANDOFF_SOURCES / REASONING_HANDOFF_TARGETS
 * (comma-separated endpoint ids), REASONING_HANDOFF_REGEN=1 to regenerate
 * the source fixtures.
 *
 * Each source endpoint produces one real tool-loop fixture (thinking +
 * tool_use, tool_result, final answer). The fixture is cached on disk so a
 * before/after run replays identical history. Every target endpoint then
 * receives three history shapes built from every source:
 *   H1 completed: the finished exchange plus a new user turn that needs a tool
 *   H2 mid-loop:  the source's [thinking, tool_use] turn followed by its tool_result
 *   H3 mid-loop without thinking: H2 with the reasoning removed from the tool turn
 *
 * Mechanical assertion: the gateway accepts the request and the stream
 * completes. The dump records what judges the behavior afterwards: whether
 * the reply text carries a `<prior_reasoning>` tag, whether the target's
 * thinking is the bare '...' placeholder, and the serialized request body
 * (messages only, never headers) so a before/after diff shows the wire change.
 * All calls run sequentially (EVAL_GUIDELINES: shared coding-plan quotas).
 *
 * REASONING_HANDOFF_MODE=conversation runs whole conversations instead: three
 * user turns on endpoints A, B, then A again, each finished as a real tool loop.
 * The last turn asks for all three codes and their sum, so the dump shows whether
 * the conversation still works after two switches, plus cache reads on each step.
 * REASONING_HANDOFF_PAIRS picks pairs (`a>b`), REASONING_HANDOFF_RUNS repeats them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCustomProvider } from './custom-provider.js';
import { resolveProvider } from './resolver.js';
import { createCloudProviderConfig } from '../cloud/provider-config.js';
import { serializeCloudCredential } from '../cloud/credentials.js';
import { runWithProviderCredential } from '../provider-credential-context.js';
import type { KodaXBaseProvider } from './base.js';
import type {
  KodaXAssistantBlock,
  KodaXContentBlock,
  KodaXMessage,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '../types.js';

const RUN_INTEGRATION = process.env.KODAX_INTEGRATION_TEST === '1';
const RUN_LABEL = process.env.REASONING_HANDOFF_LABEL ?? 'run';
const MODE = process.env.REASONING_HANDOFF_MODE ?? 'matrix';
const CONVERSATION_RUNS = Number(process.env.REASONING_HANDOFF_RUNS ?? '1');
const REGENERATE = process.env.REASONING_HANDOFF_REGEN === '1';
const ROOT = path.join(tmpdir(), 'kodax-eval-dumps', 'reasoning-handoff');
const FIXTURE_DIR = path.join(ROOT, 'fixtures');
const RESULT_DIR = path.join(ROOT, RUN_LABEL);

interface Endpoint {
  readonly id: string;
  readonly protocol: 'anthropic' | 'openai' | 'google';
  readonly model?: string;
  readonly create: () => KodaXBaseProvider;
}

const builtin = (name: string) => () => resolveProvider(name);

/** A gateway serving Gemini on all three protocols (GEMINI_GATEWAY_URL is its origin, GEMINI_KEY its key). */
const GEMINI_GATEWAY = process.env.GEMINI_GATEWAY_URL;
const GEMINI_KEY = process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
const unconfigured = (name: string) => createCustomProvider({ name, protocol: 'openai', baseUrl: 'https://unconfigured.invalid', apiKeyEnv: 'KODAX_UNSET_KEY', model: 'none' });

/** Native Gemini takes its key through the cloud credential scope, not an env var. */
function geminiNative(): KodaXBaseProvider {
  if (!GEMINI_GATEWAY || !GEMINI_KEY) return unconfigured('gemini-native');
  const config = {
    ...createCloudProviderConfig({ service: 'gemini', name: 'gemini-native', model: GEMINI_MODEL }),
    baseUrl: `${GEMINI_GATEWAY}/v1beta`,
    reasoningProfile: { effortStrategy: 'google-thinking-level' as const, supportedEfforts: [{ value: 'high' as const, isDefault: true }] },
  };
  const provider = createCustomProvider(config);
  const credential = serializeCloudCredential(config.name, { type: 'api-key', key: GEMINI_KEY });
  const stream = provider.stream.bind(provider);
  return Object.assign(provider, {
    isConfigured: () => true,
    stream: (...args: Parameters<typeof stream>) => runWithProviderCredential(config.name, credential, () => stream(...args)),
  });
}

function geminiCompat(protocol: 'anthropic' | 'openai'): KodaXBaseProvider {
  const name = `gemini-${protocol}`;
  if (!GEMINI_GATEWAY) return unconfigured(name);
  return createCustomProvider({
    name, protocol, baseUrl: protocol === 'openai' ? `${GEMINI_GATEWAY}/v1` : GEMINI_GATEWAY,
    apiKeyEnv: 'GEMINI_KEY', model: GEMINI_MODEL, supportsThinking: true,
  });
}

const ENDPOINTS: Endpoint[] = [
  { id: 'zhipu-coding', protocol: 'anthropic', create: builtin('zhipu-coding') },
  { id: 'kimi-code', protocol: 'anthropic', create: builtin('kimi-code') },
  { id: 'minimax-coding', protocol: 'anthropic', create: builtin('minimax-coding') },
  { id: 'ark-coding', protocol: 'anthropic', create: builtin('ark-coding') },
  { id: 'deepseek', protocol: 'anthropic', create: builtin('deepseek') },
  { id: 'qwen-token-plan', protocol: 'anthropic', create: builtin('qwen-token-plan') },
  { id: 'anthropic', protocol: 'anthropic', model: 'claude-opus-5-5', create: builtin('anthropic') },
  {
    id: 'kimi-code-openai',
    protocol: 'openai',
    create: () => createCustomProvider({
      name: 'kimi-code-openai', protocol: 'openai', baseUrl: 'https://api.kimi.com/coding/v1',
      apiKeyEnv: 'KIMI_CODE_API_KEY', model: 'k3-256k', supportsThinking: true, replayReasoningContent: true,
    }),
  },
  {
    id: 'deepseek-openai',
    protocol: 'openai',
    create: () => createCustomProvider({
      name: 'deepseek-openai', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-flash', supportsThinking: true,
      replayReasoningContent: true, reasoningPreset: 'deepseek-v4-flash-openai',
    }),
  },
  {
    id: 'openrouter-qwen',
    protocol: 'openai',
    create: () => createCustomProvider({
      name: 'openrouter-qwen', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY', model: 'qwen/qwen3.8-flash', supportsThinking: true,
      reasoningProfile: { effortStrategy: 'openai-responses-effort' },
    }),
  },
  { id: 'gemini-native', protocol: 'google', create: geminiNative },
  { id: 'gemini-openai', protocol: 'openai', create: () => geminiCompat('openai') },
  { id: 'gemini-anthropic', protocol: 'anthropic', create: () => geminiCompat('anthropic') },
];

/** ark-coding serves the same GLM model as zhipu-coding, so it is a target only. */
const TARGET_ONLY = new Set(['ark-coding']);

function selected(envName: string, fallback: Endpoint[]): Endpoint[] {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const ids = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  return fallback.filter(e => ids.has(e.id));
}

const SOURCES = selected('REASONING_HANDOFF_SOURCES', ENDPOINTS.filter(e => !TARGET_ONLY.has(e.id)));
const TARGETS = selected('REASONING_HANDOFF_TARGETS', ENDPOINTS);

const SYSTEM_PROMPT = [
  'You are a terse assistant that answers by calling tools.',
  'Codes are only available through the lookup tool.',
  'After you have a code, reply with one short sentence that states it.',
].join(' ');

const LOOKUP_TOOL: KodaXToolDefinition = {
  name: 'lookup',
  description: 'Return the secret code for a named item.',
  input_schema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
};
const TOOLS = [LOOKUP_TOOL];
const REASONING = { enabled: true, effort: 'high' as const };
const FIRST_TASK = 'What is the secret code for "alpha"? Think it through briefly, then use the lookup tool.';
const ALPHA_RESULT = 'alpha => 7319';
const SECOND_TASK = 'Now find the secret code for "beta" the same way.';

interface SourceFixture {
  readonly source: string;
  readonly toolTurn: KodaXMessage;
  readonly toolUseId: string;
  readonly finalTurn: KodaXMessage;
}

/** Captures the JSON request body only; headers (and therefore keys) are never read. */
let lastRequestBody: unknown;
const originalFetch = globalThis.fetch;

function installBodyCapture(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof init?.body === 'string') {
      try { lastRequestBody = JSON.parse(init.body); } catch { lastRequestBody = undefined; }
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

function wireMessages(): unknown {
  if (!lastRequestBody || typeof lastRequestBody !== 'object') return null;
  const body = lastRequestBody as Record<string, unknown>;
  return body.messages ?? body.input ?? body.contents ?? null;
}

function assistantContent(result: KodaXStreamResult): KodaXAssistantBlock[] {
  return result.contentBlocks
    ?? [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks];
}

function assistantMessage(result: KodaXStreamResult): KodaXMessage {
  return {
    role: 'assistant',
    content: assistantContent(result) as KodaXContentBlock[],
    ...(result.nativeHistory ? { nativeHistory: result.nativeHistory } : {}),
  };
}

function toolResult(toolUseId: string): KodaXMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: ALPHA_RESULT }] };
}

function stripReasoning(message: KodaXMessage): KodaXMessage {
  const content = Array.isArray(message.content)
    ? message.content.filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking')
    : message.content;
  return { role: message.role, content };
}

async function streamOn(endpoint: Endpoint, provider: KodaXBaseProvider, messages: KodaXMessage[]) {
  lastRequestBody = undefined;
  return provider.stream(messages, TOOLS, SYSTEM_PROMPT, REASONING,
    endpoint.model ? { modelOverride: endpoint.model } : undefined);
}

async function loadOrCreateFixture(endpoint: Endpoint): Promise<SourceFixture> {
  const file = path.join(FIXTURE_DIR, `${endpoint.id}.json`);
  if (!REGENERATE && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as SourceFixture;
  const provider = endpoint.create();
  const user: KodaXMessage = { role: 'user', content: FIRST_TASK };
  // A fixture without reasoning tests nothing, so retry a few samples before giving up.
  // Gemini carries its reasoning as a signature on the call, and its compatible routes return no reasoning text.
  const needsThinking = !endpoint.id.startsWith('gemini-');
  let first: KodaXStreamResult | undefined;
  for (let attempt = 0; attempt < 3 && !(first?.toolBlocks.length && (first.thinkingBlocks.length || !needsThinking)); attempt++) {
    first = await streamOn(endpoint, provider, [user]);
  }
  const toolUse = first?.toolBlocks[0];
  if (!first || !toolUse || (needsThinking && first.thinkingBlocks.length === 0)) {
    throw new Error(`${endpoint.id} produced no [thinking, tool_use] turn: ${first?.textBlocks.map(b => b.text).join('')}`);
  }
  const toolTurn = assistantMessage(first);
  const second = await streamOn(endpoint, provider, [user, toolTurn, toolResult(toolUse.id)]);
  const fixture: SourceFixture = { source: endpoint.id, toolTurn, toolUseId: toolUse.id, finalTurn: assistantMessage(second) };
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(fixture, null, 2));
  return fixture;
}

type Shape = 'H1-completed' | 'H2-mid-loop' | 'H3-mid-loop-no-thinking';

function historyFor(shape: Shape, fixture: SourceFixture): KodaXMessage[] {
  const user: KodaXMessage = { role: 'user', content: FIRST_TASK };
  const result = toolResult(fixture.toolUseId);
  if (shape === 'H1-completed') {
    return [user, fixture.toolTurn, result, fixture.finalTurn, { role: 'user', content: SECOND_TASK }];
  }
  if (shape === 'H2-mid-loop') return [user, fixture.toolTurn, result];
  return [user, stripReasoning(fixture.toolTurn), result];
}

function shapesFor(target: Endpoint): Shape[] {
  // Without thinking there is nothing to replay; only the Anthropic placeholder path differs there.
  return target.protocol === 'anthropic'
    ? ['H1-completed', 'H2-mid-loop', 'H3-mid-loop-no-thinking']
    : ['H1-completed', 'H2-mid-loop'];
}

const PRIOR_TAG = '<prior_reasoning>';
const records: Record<string, unknown[]> = {};

function record(target: string, entry: Record<string, unknown>): void {
  (records[target] ??= []).push(entry);
  mkdirSync(RESULT_DIR, { recursive: true });
  writeFileSync(path.join(RESULT_DIR, `${target}.json`), JSON.stringify({ target, label: RUN_LABEL, runs: records[target] }, null, 2));
}

function summarize(result: KodaXStreamResult) {
  const text = result.textBlocks.map(b => b.text).join('');
  const thinking = result.thinkingBlocks.map(b => (b.type === 'thinking' ? b.thinking : '[redacted]')).join('\n');
  return {
    stopReason: result.stopReason ?? null,
    text,
    textStartsWithPriorTag: text.trimStart().startsWith(PRIOR_TAG),
    textContainsPriorTag: text.includes(PRIOR_TAG),
    thinkingLength: thinking.length,
    thinkingIsPlaceholder: thinking.trim() === '...',
    thinkingHead: thinking.slice(0, 400),
    toolCalls: result.toolBlocks.map(b => ({ name: b.name, input: b.input })),
    usage: result.usage ?? null,
  };
}

const fixtures = new Map<string, SourceFixture>();

describe.skipIf(!RUN_INTEGRATION || MODE !== 'matrix')('reasoning handoff — real provider HTTP', () => {
  beforeAll(installBodyCapture);
  afterAll(() => { globalThis.fetch = originalFetch; });

  describe('source fixtures', () => {
    for (const source of SOURCES) {
      it.skipIf(!source.create().isConfigured())(`fixture from ${source.id}`, async () => {
        fixtures.set(source.id, await loadOrCreateFixture(source));
      }, 240_000);
    }
  });

  for (const target of TARGETS) {
    const provider = target.create();
    describe.skipIf(!provider.isConfigured())(`target ${target.id}`, () => {
      for (const source of SOURCES) {
        for (const shape of shapesFor(target)) {
          it(`${source.id} -> ${target.id} ${shape}`, async (ctx) => {
            const fixture = fixtures.get(source.id);
            if (!fixture) ctx.skip();
            const started = Date.now();
            const base = { source: source.id, target: target.id, shape, crossModel: source.id !== target.id };
            try {
              const result = await streamOn(target, provider, historyFor(shape, fixture!));
              record(target.id, { ...base, ok: true, ...summarize(result), wire: wireMessages(), durationMs: Date.now() - started });
              expect(result).toBeDefined();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              record(target.id, { ...base, ok: false, error: message, wire: wireMessages(), durationMs: Date.now() - started });
              throw error;
            }
          }, 240_000);
        }
      }
    });
  }
});

/** Same model behind both protocols, then different models across and within protocols. */
const CONVERSATION_PAIRS: readonly (readonly [string, string])[] = [
  ['kimi-code', 'kimi-code-openai'],
  ['deepseek', 'deepseek-openai'],
  ['zhipu-coding', 'deepseek-openai'],
  ['kimi-code-openai', 'deepseek'],
  ['zhipu-coding', 'kimi-code'],
  ['kimi-code-openai', 'deepseek-openai'],
];
const CONVERSATIONS = CONVERSATION_PAIRS.flatMap(([a, b]) => [[a, b], [b, a]] as const)
  .filter(([a, b]) => !process.env.REASONING_HANDOFF_PAIRS
    || process.env.REASONING_HANDOFF_PAIRS.split(',').includes(`${a}>${b}`));

const CODES: Record<string, string> = { alpha: '7319', beta: '4826', gamma: '5150' };
const CODE_SUM = '17295';
const CONVERSATION_TURNS = [
  FIRST_TASK,
  SECOND_TASK,
  'Look up "gamma" too, then tell me all three codes and their sum.',
];
const MAX_STEPS_PER_TURN = 4;

const endpointById = (id: string): Endpoint => {
  const endpoint = ENDPOINTS.find(e => e.id === id);
  if (!endpoint) throw new Error(`unknown endpoint ${id}`);
  return endpoint;
};

function lookup(input: unknown): string {
  const item = String((input as { item?: unknown } | undefined)?.item ?? '');
  return `${item} => ${CODES[item] ?? 'unknown item'}`;
}

/** Runs one user turn as a real tool loop, appending every assistant turn and tool result to `messages`. */
async function runTurn(endpoint: Endpoint, provider: KodaXBaseProvider, messages: KodaXMessage[], steps: Record<string, unknown>[], turn: number) {
  for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
    const started = Date.now();
    let result: KodaXStreamResult;
    try {
      result = await streamOn(endpoint, provider, messages);
    } catch (error) {
      steps.push({ turn, step, endpoint: endpoint.id, ok: false, error: error instanceof Error ? error.message : String(error), wire: wireMessages() });
      throw error;
    }
    steps.push({ turn, step, endpoint: endpoint.id, ok: true, ...summarize(result), durationMs: Date.now() - started });
    messages.push(assistantMessage(result));
    if (result.toolBlocks.length === 0) return;
    messages.push({
      role: 'user',
      content: result.toolBlocks.map(b => ({ type: 'tool_result' as const, tool_use_id: b.id, content: lookup(b.input) })),
    });
  }
}

describe.skipIf(!RUN_INTEGRATION || MODE !== 'conversation')('conversation across switches — real provider HTTP', () => {
  beforeAll(installBodyCapture);
  afterAll(() => { globalThis.fetch = originalFetch; });

  for (const [a, b] of CONVERSATIONS) {
    const order = [endpointById(a), endpointById(b), endpointById(a)];
    const providers = new Map(order.map(e => [e.id, e.create()]));
    const configured = [...providers.values()].every(p => p.isConfigured());
    for (let run = 0; run < CONVERSATION_RUNS; run++) {
      it.skipIf(!configured)(`${a} -> ${b} -> ${a} run ${run}`, async () => {
        const messages: KodaXMessage[] = [];
        const steps: Record<string, unknown>[] = [];
        try {
          for (const [turn, endpoint] of order.entries()) {
            messages.push({ role: 'user', content: CONVERSATION_TURNS[turn]! });
            await runTurn(endpoint, providers.get(endpoint.id)!, messages, steps, turn);
          }
        } finally {
          const last = steps.at(-1);
          const finalText = last?.turn === 2 && typeof last.text === 'string' ? last.text : '';
          record(`${a}--${b}`, {
            run,
            completed: steps.every(s => s.ok) && finalText.length > 0,
            recallsAllCodes: Object.values(CODES).every(code => finalText.includes(code)),
            sumCorrect: finalText.replace(/[,\s]/g, '').includes(CODE_SUM),
            finalText,
            steps,
          });
        }
      }, 600_000);
    }
  }
});
