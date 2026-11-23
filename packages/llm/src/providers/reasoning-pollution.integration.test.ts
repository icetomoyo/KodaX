/**
 * Live polluted-session probe — Issue 441, Layer 3.
 *
 * SKIPPED by default (CI has no keys). Each cell sends one fixed, already
 * polluted session to a real endpoint and records the next response:
 *
 *   KODAX_INTEGRATION_TEST=1 REASONING_POLLUTION_ARM=new REASONING_POLLUTION_RUNS=4 \
 *     npx vitest run -c tests/config/vitest.integration.config.ts \
 *     packages/llm/src/providers/reasoning-pollution.integration.test.ts
 *
 * The stored session reproduces what Space found: every earlier reply starts
 * with a `<prior_reasoning>` block the model wrote itself, and its own thinking
 * is the bare '...'. Arms:
 *   old       the pre-fix serializer (run this file from a checkout of the old code)
 *   new       the current serializer ('...'-only thinking replays empty)
 *   drop-dots the current serializer, with '...'-only thinking removed from history
 *             (DeepSeek rejects it: an in-loop tool turn must carry thinking)
 *
 * Cases: P1 asks a new question that needs a tool, P2 continues after a tool result.
 * Cells `<a>--to--<b>` replay a session written on endpoint a to endpoint b: the
 * same model behind the other protocol (Anthropic-compatible ↔ OpenAI-compatible).
 * REASONING_POLLUTION_ALIASES selects cells by id.
 * Raw output goes to os.tmpdir()/kodax-eval-dumps/reasoning-pollution/<arm>/<cell id>.json.
 * Cells run sequentially per provider; one call per cell, no follow-up turns.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createCustomProvider } from './custom-provider.js';
import { resolveProvider } from './resolver.js';
import type { KodaXBaseProvider } from './base.js';
import type { KodaXContentBlock, KodaXGenerationSource, KodaXMessage, KodaXStreamResult, KodaXToolDefinition } from '../types.js';

const RUN_INTEGRATION = process.env.KODAX_INTEGRATION_TEST === '1';
const ARM = process.env.REASONING_POLLUTION_ARM ?? 'new';
const RUNS = Number(process.env.REASONING_POLLUTION_RUNS ?? '1');
const MAX_CALLS = Number(process.env.REASONING_POLLUTION_MAX_CALLS ?? '30');
const RESULT_DIR = path.join(tmpdir(), 'kodax-eval-dumps', 'reasoning-pollution', ARM);

const builtin = (name: string) => () => resolveProvider(name);

/** OpenAI-compatible endpoints stamp no source on their reasoning, so their history carries none. */
type SourcedProvider = KodaXBaseProvider & { getGenerationSource?(model?: string): KodaXGenerationSource };

const ENDPOINTS = {
  'zhipu-coding': { model: 'glm-5.3-flash', create: builtin('zhipu-coding') },
  'deepseek': { model: 'deepseek-flash', create: builtin('deepseek') },
  'kimi-code': { model: 'kimi-for-coding', create: builtin('kimi-code') },
  'kimi-code-openai': {
    model: 'k3-256k',
    create: () => createCustomProvider({
      name: 'kimi-code-openai', protocol: 'openai', baseUrl: 'https://api.kimi.com/coding/v1',
      apiKeyEnv: 'KIMI_CODE_API_KEY', model: 'k3-256k', supportsThinking: true, replayReasoningContent: true,
    }),
  },
  'deepseek-openai': {
    model: 'deepseek-flash',
    create: () => createCustomProvider({
      name: 'deepseek-openai', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-flash', supportsThinking: true,
      replayReasoningContent: true, reasoningPreset: 'deepseek-v4-flash-openai',
    }),
  },
};
type EndpointId = keyof typeof ENDPOINTS;

/**
 * Each cell replays the polluted session to `target`. With `historyFrom`, the
 * session was written on that endpoint, so the target also sees a protocol switch.
 */
const CELLS: { target: EndpointId; historyFrom?: EndpointId }[] = [
  { target: 'zhipu-coding' },
  { target: 'deepseek' },
  { target: 'kimi-code' },
  { target: 'kimi-code-openai' },
  { target: 'deepseek-openai' },
  { target: 'kimi-code-openai', historyFrom: 'kimi-code' },
  { target: 'deepseek-openai', historyFrom: 'deepseek' },
  { target: 'kimi-code', historyFrom: 'kimi-code-openai' },
  { target: 'deepseek', historyFrom: 'deepseek-openai' },
];
const cellId = (cell: typeof CELLS[number]) => cell.historyFrom ? `${cell.historyFrom}--to--${cell.target}` : cell.target;
const SELECTED = CELLS.filter(cell => !process.env.REASONING_POLLUTION_ALIASES
  || process.env.REASONING_POLLUTION_ALIASES.split(',').includes(cellId(cell)));

const SYSTEM_PROMPT = [
  'You are a coding assistant working in a TypeScript repository.',
  'Use the read_file tool to inspect files before answering.',
  'Keep answers short.',
].join(' ');

const READ_FILE: KodaXToolDefinition = {
  name: 'read_file',
  description: 'Read a file from the repository and return its contents.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const reasoned = (reasoning: string, reply: string) => `<prior_reasoning>\n${reasoning}\n</prior_reasoning>\n\n${reply}`;

function pollutedSession(source: KodaXGenerationSource | undefined): Record<'P1' | 'P2', KodaXMessage[]> {
  const dots = { type: 'thinking' as const, thinking: '...', signature: '', ...(source ? { source } : {}) };
  const turn = (text: string, call?: { id: string; path: string }): KodaXMessage => ({
    role: 'assistant',
    content: [dots, { type: 'text', text }, ...(call ? [{ type: 'tool_use' as const, id: call.id, name: 'read_file', input: { path: call.path } }] : [])] as KodaXContentBlock[],
  });
  const result = (id: string, content: string): KodaXMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
  const shared: KodaXMessage[] = [
    { role: 'user', content: 'Why does `npm test` fail with "port already in use"? Check src/server.ts.' },
    turn(reasoned(
      'The user reports a port conflict during tests. The server module probably binds a fixed port when it is imported. I should read src/server.ts to confirm before answering.',
      'Let me look at the server setup.'), { id: 'call_server', path: 'src/server.ts' }),
    result('call_server', "import http from 'node:http';\nimport { app } from './app.js';\n\nexport const server = http.createServer(app).listen(3000);\n"),
    turn(reasoned(
      'The server listens on port 3000 as a side effect of importing the module. Each test file that imports it starts another listener, so the second import fails with EADDRINUSE. The fix is to export a start function and listen only in the entry point, or use port 0 in tests.',
      '`src/server.ts` calls `listen(3000)` when it is imported, so every test file that imports it binds port 3000 again. Export a `start(port)` function, call it only from `src/index.ts`, and pass port `0` in tests.')),
    { role: 'user', content: 'Makes sense. Now check src/config.ts: is the database URL read safely?' },
  ];
  return {
    P1: shared,
    P2: [...shared,
      turn(reasoned(
        'The user wants to know whether the database URL is read safely. I need to read src/config.ts and look for validation and defaults.',
        'Checking the config module.'), { id: 'call_config', path: 'src/config.ts' }),
      result('call_config', "export const config = {\n  port: Number(process.env.PORT ?? 3000),\n  databaseUrl: process.env.DATABASE_URL!,\n};\n"),
    ],
  };
}

/** The drop-dots arm: the history a serializer would send if it also dropped '...'-only thinking. */
function withoutDotThinking(messages: KodaXMessage[]): KodaXMessage[] {
  return messages.map(m => typeof m.content === 'string' ? m
    : { ...m, content: m.content.filter(b => !(b.type === 'thinking' && b.thinking.trim() === '...')) });
}

const PRIOR_TAG = '<prior_reasoning>';
function observe(result: KodaXStreamResult) {
  const text = result.textBlocks.map(b => b.text).join('');
  const thinking = result.thinkingBlocks.map(b => (b.type === 'thinking' ? b.thinking : '[redacted]')).join('\n');
  return {
    stopReason: result.stopReason ?? null,
    text,
    textStartsWithPriorTag: text.trimStart().startsWith(PRIOR_TAG),
    textContainsPriorTag: text.includes(PRIOR_TAG),
    thinkingLength: thinking.trim().length,
    thinkingIsDots: thinking.trim() === '...',
    thinking,
    toolCalls: result.toolBlocks.map(b => ({ name: b.name, input: b.input })),
    usage: result.usage ?? null,
  };
}

let calls = 0;

describe.skipIf(!RUN_INTEGRATION)(`polluted session — arm ${ARM}`, () => {
  for (const cell of SELECTED) {
    const id = cellId(cell);
    const alias = { provider: cell.target, model: ENDPOINTS[cell.target].model, historyFrom: cell.historyFrom ?? null };
    const provider = ENDPOINTS[cell.target].create() as SourcedProvider;
    const writer = cell.historyFrom ? ENDPOINTS[cell.historyFrom].create() as SourcedProvider : provider;
    const historySource = writer.getGenerationSource?.(ENDPOINTS[cell.historyFrom ?? cell.target].model);
    const runs: Record<string, unknown>[] = [];
    const file = path.join(RESULT_DIR, `${id}.json`);
    describe.skipIf(!provider.isConfigured())(`${id}/${alias.model}`, () => {
      for (const caseId of ['P1', 'P2'] as const) {
        for (let runIndex = 0; runIndex < RUNS; runIndex++) {
          it(`${caseId} run ${runIndex}`, async () => {
            if (++calls > MAX_CALLS) throw new Error(`call budget ${MAX_CALLS} reached`);
            const history = pollutedSession(historySource)[caseId];
            const messages = ARM === 'drop-dots' ? withoutDotThinking(history) : history;
            const started = Date.now();
            const base = { case: caseId, runIndex, arm: ARM, alias: `${id}/${alias.model}` };
            try {
              const result = await provider.stream(messages, [READ_FILE], SYSTEM_PROMPT,
                { enabled: true, effort: 'high' }, { modelOverride: alias.model });
              runs.push({ ...base, ok: true, ...observe(result), durationMs: Date.now() - started });
              expect(result).toBeDefined();
            } catch (error) {
              runs.push({ ...base, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started });
              throw error;
            } finally {
              mkdirSync(RESULT_DIR, { recursive: true });
              writeFileSync(file, JSON.stringify({ arm: ARM, alias, systemPrompt: SYSTEM_PROMPT, runs }, null, 2));
            }
          }, 240_000);
        }
      }
    });
  }
});
