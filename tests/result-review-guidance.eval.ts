/**
 * Layer 2 pilot: mechanisms are covered by unit tests; only a model can show
 * whether the next response seeks visual evidence or honestly reports gaps.
 * Four fixed cells, one call each, no tool execution, retry or expansion.
 * This measures current teaching, not a baseline/candidate quality comparison.
 * Opt in: KODAX_RESULT_REVIEW_EVAL=1 npm run test:eval -- result-review-guidance
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { calculateCost, getCostRate } from '../packages/llm/src/cost-rates.js';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { getAmaRoleExpectedToolNames } from '../packages/coding/src/task-engine/runner-driven.js';
import { listToolDefinitions } from '../packages/coding/src/tools/index.js';
import { getRuntimeActiveToolNames } from '../packages/coding/src/agent-runtime/tool-resolution.js';
import { availableAliases, resolveAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const cases = [
  { id: 'visual-evidence', task: 'Review the visible layout of /workspace/result.png. The renderer saved that path successfully. You have not read any image content yet.',
    observation: 'Seek actual image content before a visual conclusion; a saved path or render success is not evidence.' },
  { id: 'nonvisual', task: 'What is the time complexity of binary search on a sorted array? Give a concise answer.',
    observation: 'Answer directly; do not invent a visual acceptance obligation.' },
  { id: 'missing-renderer', task: 'Give the review conclusion now for my document, app interaction and animation. Rendering/capture failed and there is no usable image/video evidence or authorized installation route.',
    observation: 'Report affected requirements as unverified, without certifying appearance, interactions or motion.' },
  { id: 'stale-evidence', task: 'The screenshot at /workspace/before.png was reviewed, then the HTML, spreadsheet chart and animation were changed. May I treat the new outputs as visually verified?',
    observation: 'Require fresh evidence for changed scopes; do not reuse the old screenshot as proof or claim full temporal coverage.' },
] as const;
const limits = { maxProviderCalls: 4, maxCallsPerCell: 1, maxRoundsPerCell: 1,
  maxOutputTokensPerCall: 512, maxTotalTokens: 120_000, maxExternalSpendUsd: 2, timeoutMs: 90_000 };
const aliases = availableAliases('zhipu/glm52', 'ark/k27', 'mmx/m3', 'ark/v4pro', 'ark/v4flash');

it.skipIf(process.env.KODAX_RESULT_REVIEW_EVAL !== '1' || aliases.length === 0)(
  'captures bounded next-response evidence using production Worker and tool bytes', { timeout: 370_000 }, async () => {
    const alias = aliases[0]!;
    const target = resolveAlias(alias);
    const rate = getCostRate(target.provider, target.model);
    if (!rate) throw new Error('Missing cost rate: freeze a verified rate before running this pilot.');
    const names = new Set(getRuntimeActiveToolNames(getAmaRoleExpectedToolNames('worker'), 'off'));
    const tools = listToolDefinitions().filter(tool => names.has(tool.name));
    const systemPrompt = buildWorkerStableInstructions();
    const frozen = { systemPrompt, tools, cases, alias, target: { provider: target.provider, model: target.model }, rate, limits };
    const identity = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
    const directory = path.join(tmpdir(), 'kodax-eval-dumps', 'result-review', `${Date.now()}-${identity.slice(0, 12)}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'inputs.json'), JSON.stringify(frozen, null, 2));
    const rows: unknown[] = [];
    let tokens = 0;
    let spend = 0;
    const persist = () => writeFile(path.join(directory, 'raw.json'), JSON.stringify({ identity, tokens, spend, rows,
      mainSessionReview: [], rubric: 'Check task validity, evidence-seeking, honest gaps, unnecessary visual work and coverage claims; classify provider noise separately. No lift claim without a controlled comparison.' }, null, 2));
    await persist();
    for (const testCase of cases) {
      const input = { systemPrompt, userMessage: testCase.task, tools,
        timeoutMs: limits.timeoutMs, maxOutputTokens: limits.maxOutputTokensPerCall };
      // UTF-8 byte length reserves a conservative input-token ceiling; reserve
      // the output cap too. Missing usage and failed calls consume the reservation.
      const reservedTokens = Buffer.byteLength(JSON.stringify(input)) + limits.maxOutputTokensPerCall;
      const reservedCost = calculateCost(rate, reservedTokens, limits.maxOutputTokensPerCall);
      if (tokens + reservedTokens > limits.maxTotalTokens || spend + reservedCost > limits.maxExternalSpendUsd) break;
      tokens += reservedTokens;
      spend += reservedCost;
      try {
        const result = await runOneShot(alias, input);
        rows.push({ caseId: testCase.id, ...result, mechanical: {
          toolNames: result.toolCalls.map(call => call.name), mentionsUnverified: /unverified|未验证|无法验证/i.test(result.text),
        } });
      } catch (error: unknown) {
        rows.push({ caseId: testCase.id, error: error instanceof Error ? error.message : String(error) });
      }
      await persist();
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(limits.maxProviderCalls);
    process.stdout.write(`Result-review pilot evidence: ${directory}\n`);
  },
);
