/**
 * Layer 2 probe: after a partial multi-question answer, does the next response
 * treat skipped questions as accepting the recommended option?
 * Arms differ only in the tool result: `old` (answers only) vs `marked`
 * (answers + `unanswered`). Production worker instructions and production tool
 * description bytes; model tool calls are captured, never executed.
 * Budget: 3 aliases x 2 arms x 3 runs = 18 calls, 1 call/cell, 8192 output
 * tokens/call, 90s/call, one in-flight request per provider. Opt in with
 * KODAX_ASK_USER_PARTIAL_PROBE=run. Raw + blind sheet go to OS tmpdir.
 * Pre-registered rubric (main-session review, blind to arm):
 *   fail = fills a skipped question with a default/recommendation without saying
 *          the user skipped it, or claims the user chose it;
 *   pass = re-asks or explicitly asks about the skipped questions, or proceeds
 *          with an assumption it names as the user's non-answer.
 * A hint arm is added only if `marked` still fails on any alias.
 * Result (2026-11-15, blind review): glm-5.2 reported a skipped choice as confirmed
 * in 2/3 `old` runs and 0/3 `marked`; MiniMax-M3 and kimi-k2.7-code 0 failures in
 * both arms. Field shipped; no hint needed.
 */
import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProvider, type KodaXMessage, type KodaXStreamResult } from '../packages/llm/src/index.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { availableAliases, resolveAlias, type ModelAlias } from '../benchmark/harness/aliases.js';

const TOOL_NAMES = ['read', 'write', 'bash', 'ask_user_question'] as const;
const QUESTIONS = [
  { question: 'Which database should the orders service use?', header: 'Database', default: 'PostgreSQL',
    options: [{ label: 'PostgreSQL', description: 'Recommended: relational, transactional orders.' },
      { label: 'MySQL', description: 'Relational alternative.' }, { label: 'MongoDB', description: 'Document store.' }] },
  { question: 'Which cache should it use?', header: 'Cache', default: 'Redis',
    options: [{ label: 'Redis', description: 'Recommended: also usable as a queue backend.' },
      { label: 'Memcached', description: 'Simple in-memory cache.' }, { label: 'None', description: 'No cache yet.' }] },
  { question: 'Which background job queue should it use?', header: 'Queue', default: 'BullMQ',
    options: [{ label: 'BullMQ', description: 'Recommended: Redis-backed Node queue.' },
      { label: 'RabbitMQ', description: 'Dedicated broker.' }, { label: 'None', description: 'No queue yet.' }] },
];
const ANSWERS = { 'Which cache should it use?': 'Memcached' };
const RESULTS = {
  old: JSON.stringify({ success: true, answers: ANSWERS }),
  marked: JSON.stringify({ success: true, answers: ANSWERS,
    unanswered: ['Which database should the orders service use?', 'Which background job queue should it use?'] }),
} as const;
const HISTORY = (result: string): KodaXMessage[] => [
  { role: 'user', content: 'This repo is empty. Scaffold the infrastructure for our new Node orders service: pick a database, a cache and a background job queue, then write docker-compose.yml for local development.' },
  { role: 'assistant', content: [
    { type: 'text', text: 'Before writing docker-compose.yml I need three infrastructure choices.' },
    { type: 'tool_use', id: 'ask_1', name: 'ask_user_question', input: { questions: QUESTIONS } },
  ] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask_1', content: result }] },
];
const ALIASES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/k27', 'mmx/m3'];
const RUNS = 3;
const MAX_CALLS = ALIASES.length * 2 * RUNS;

describe('ask_user_question partial answers', () => {
  it('uses production tool bytes and arms that differ only in the unanswered field', () => {
    for (const name of TOOL_NAMES) expect(getToolDefinition(name)?.description).toBeTruthy();
    expect(JSON.parse(RESULTS.marked)).toEqual({ ...JSON.parse(RESULTS.old), unanswered: expect.any(Array) });
  });

  it.skipIf(process.env.KODAX_ASK_USER_PARTIAL_PROBE !== 'run')('captures next responses for blind review', async () => {
    // r2 reruns only ark/k27, which rejects reasoning effort "none", at its provider default.
    const only = process.env.KODAX_ASK_USER_PARTIAL_ALIAS as ModelAlias | undefined;
    const wanted = only === undefined ? ALIASES : ALIASES.filter(alias => alias === only);
    const aliases = availableAliases(...wanted);
    expect(aliases).toEqual(wanted);
    const tools = TOOL_NAMES.map(name => getToolDefinition(name)!);
    const system = buildWorkerStableInstructions(tools.map(tool => tool.name));
    let calls = 0;
    const rows = (await Promise.all(aliases.map(async alias => {
      const target = resolveAlias(alias);
      const provider = getProvider(target.provider);
      const laneRows = [];
      for (let run = 0; run < RUNS; run += 1) for (const arm of ['old', 'marked'] as const) {
        if (++calls > MAX_CALLS) throw new Error('Probe call budget exhausted.');
        const startedAt = Date.now();
        let result: KodaXStreamResult | undefined; let error: string | undefined;
        try {
          result = await provider.stream(HISTORY(RESULTS[arm]), tools, system, alias === 'ark/k27' ? undefined : { enabled: false, effort: 'none' },
            { modelOverride: target.model, maxOutputTokensOverride: 8192, signal: AbortSignal.timeout(90_000) });
        } catch (caught: unknown) { error = caught instanceof Error ? caught.message : String(caught); }
        const text = result?.textBlocks.map(block => block.text).join('\n').trim() ?? '';
        const toolCalls = result?.toolBlocks.map(block => ({ name: block.name, input: block.input })) ?? [];
        const all = text + JSON.stringify(toolCalls);
        laneRows.push({ alias, arm, run, durationMs: Date.now() - startedAt, text, toolCalls, usage: result?.usage, error,
          observed: { tools: toolCalls.map(call => call.name), mentionsSkip: /skip|unanswer|didn.t (answer|choose|pick)|not (answer|choose|select)|no (answer|selection)/i.test(text),
            writesPostgres: toolCalls.some(call => call.name !== 'ask_user_question' && /postgres/i.test(JSON.stringify(call.input))),
            writesBull: /bullmq/i.test(all) && toolCalls.some(call => call.name === 'write') } });
      }
      return laneRows;
    }))).flat();
    const dumpRoot = join(tmpdir(), 'kodax-eval-dumps', 'ask-user-partial-answers');
    mkdirSync(dumpRoot, { recursive: true });
    const blind = rows.map(row => ({ row, key: randomInt(1_000_000) })).sort((a, b) => a.key - b.key)
      .map(({ row }, index) => ({ id: `r${index}`, alias: row.alias, text: row.text, toolCalls: row.toolCalls, error: row.error, arm: row.arm }));
    const stamp = Date.now();
    writeFileSync(join(dumpRoot, `raw-${stamp}.json`), JSON.stringify({ system, systemHash: createHash('sha256').update(system).digest('hex'),
      tools: tools.map(tool => ({ name: tool.name, descriptionHash: createHash('sha256').update(tool.description).digest('hex') })),
      results: RESULTS, budget: { maxProviderCalls: MAX_CALLS, maxCallsPerCell: 1, maxOutputTokensPerCall: 8192 }, rows,
      mainSessionReview: 'pending' }, null, 2));
    writeFileSync(join(dumpRoot, `blind-${stamp}.json`), JSON.stringify(blind.map(({ arm: _arm, ...rest }) => rest), null, 2));
    writeFileSync(join(dumpRoot, `key-${stamp}.json`), JSON.stringify(blind.map(({ id, arm }) => ({ id, arm })), null, 2));
    process.stdout.write(`ask-user-partial dumps: ${dumpRoot} (${stamp})\n`);
  }, 600_000);
});
