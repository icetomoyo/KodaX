/**
 * Controlled F46 follow-up: one next action, no tool execution or free-running agent.
 * Explicit opt-in only. 2 aliases x 2 cases x 2 arms = at most 8 requests.
 * Compare plan submission and recovery after a denied write; inspect every raw pair.
 * Tool-name counts are diagnostics, not a quality/ship verdict. API/network failures
 * remain failed observations. No fallback alias, extra repetitions or auto expansion.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { getCostRate, getProvider, type KodaXMessage } from '@kodax-ai/llm';
import { availableAliases, resolveAlias } from '../benchmark/harness/aliases.js';
import { KODAX_TOOLS } from '../packages/coding/src/tools/registry.js';
import { SYSTEM_PROMPT } from '../packages/coding/src/prompts/system.js';
import { projectManagedToolContract } from '../packages/coding/src/tools/managed-tool-contract.js';
import { executeWithPermission } from '../packages/repl/src/permission/executor.js';
import { getPlanModeBlockReason } from '../packages/coding/src/permissions/permission.js';

const baselineRef = '2ee4a782dff80c5a9f0d9eac8dee66ef65796a82^';
const enabled = process.env.KODAX_RUN_PLAN_EXIT_EVAL === '1';
const budget = { maxProviderCalls: 8, maxCallsPerCell: 1, maxRoundsPerCell: 1,
  maxOutputTokensPerCall: 2048, maxTotalTokens: 200_000, maxExternalSpendUsd: 1, timeoutMs: 45_000 };

describe('Issue 376 plan-exit production wording pilot', () => {
  it.skipIf(!enabled)('preserves raw production-byte pairs for semantic review', { timeout: 240_000 }, async () => {
    const aliases = availableAliases('zhipu/glm52', 'ark/v4flash');
    if (!aliases.length) throw new Error('No pilot credentials available; this is not an accepted eval result.');
    const root = mkdtempSync(path.join(os.tmpdir(), 'kodax-plan-exit-eval-'));
    let physicalCalls = 0, totalTokens = 0, estimatedSpendUsd = 0, stopped = false;
    const historical = JSON.parse(execFileSync('git', ['show', `${baselineRef}:packages/coding/src/prompts/static-text.json`],
      { encoding: 'utf8', windowsHide: true })) as Record<string, string>;
    const oldManaged = execFileSync('git', ['show', `${baselineRef}:packages/coding/src/tools/managed-tool-text.ts`],
      { encoding: 'utf8', windowsHide: true }).match(/exit_plan_mode: \{ description: '([^']+)'/u)?.[1];
    if (!oldManaged) throw new Error('Pinned baseline description unavailable.');
    const deniedInput = { path: path.join(process.cwd(), 'src', 'fix.ts'), content: 'fixed' };
    if (!getPlanModeBlockReason('write', deniedInput, process.cwd())) throw new Error('Invalid eval: path must be plan-blocked before execution.');
    const currentDenied = await executeWithPermission('write', deniedInput, { backups: new Map<string, string>() },
      { permissionMode: 'plan', gitRoot: process.cwd(), confirmTools: new Set(['write']), alwaysAllowTools: [],
        beforeToolExecute: async () => { throw new Error('Invalid eval: tool execution is forbidden.'); } });
    const oldDenied = String(currentDenied).replace(/ Submit the completed plan with exit_plan_mode[\s\S]*$/u,
      ' Do not try to modify files while planning. Finish the plan first, then use ask_user_question to ask the user whether to proceed. If the user confirms, call set_permission_mode with mode "accept-edits" to switch to implementation mode.');
    const cases = [
      { id: 'ready', managed: false, messages: [] as KodaXMessage[], prompt: 'We are in plan mode. The full plan is ready: update src/fix.ts to handle empty input, add its regression test, run tests. Submit it for my review; do not implement yet.' },
      { id: 'denied-write', managed: true, messages: [
        { role: 'user', content: 'We are in plan mode. Fix empty input in src/fix.ts after I approve your plan.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'write-1', name: 'write', input: { path: 'src/fix.ts', content: 'fixed' } }] },
      ] as KodaXMessage[], prompt: 'The completed plan is: handle empty input, add a regression test, run tests. Continue appropriately.' },
    ];
    writeFileSync(path.join(root, 'scope.json'), JSON.stringify({ baselineRef, aliases, requests: aliases.length * 4, budget,
      scope: 'Production base system and complete tool definitions; isolated next-action wording probe, not full AMA prompt or intelligence equivalence.' }, null, 2));
    process.stdout.write(`Plan-exit raw pairs require semantic review: ${root}\n`);
    const outcomes = await Promise.allSettled(aliases.map(async alias => {
      for (const task of cases) for (const arm of ['baseline', 'candidate'] as const) {
        if (stopped) throw new Error('Pilot budget exhausted or usage unavailable; no follow-up allowed.');
        const tools = KODAX_TOOLS.map(tool => {
          const projected = task.managed ? projectManagedToolContract(tool) : tool;
          return arm === 'baseline' && tool.name === 'exit_plan_mode'
            ? { ...projected, description: task.managed ? oldManaged : historical['tool.exit_plan_mode.description']! } : projected;
        });
        const priorMessages: KodaXMessage[] = [...task.messages,
          ...(task.id === 'denied-write' ? [{ role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'write-1',
            content: String(arm === 'baseline' ? oldDenied : currentDenied), is_error: true }] }] : [])];
        const input = { systemPrompt: SYSTEM_PROMPT, tools, priorMessages, userMessage: task.prompt,
          timeoutMs: budget.timeoutMs, maxOutputTokens: budget.maxOutputTokensPerCall };
        const file = path.join(root, `${alias.replaceAll('/', '-')}-${task.id}-${arm}.json`);
        writeFileSync(file, JSON.stringify({ input }, null, 2));
        try {
          const target = resolveAlias(alias);
          let cellCalls = 0;
          const output = await getProvider(target.provider).stream([...priorMessages, { role: 'user', content: task.prompt }], tools,
            SYSTEM_PROMPT, undefined, { modelOverride: target.model, singleAttempt: true,
              maxOutputTokensOverride: budget.maxOutputTokensPerCall, signal: AbortSignal.timeout(budget.timeoutMs),
              fetch: async (...args) => {
                if (stopped || cellCalls >= budget.maxCallsPerCell || physicalCalls >= budget.maxProviderCalls) throw new Error('Physical pilot request budget exhausted.');
                cellCalls++; physicalCalls++;
                return globalThis.fetch(...args);
              } });
          const rate = getCostRate(target.provider, target.model);
          const usage = output.usage;
          if (!usage || !rate) stopped = true;
          else {
            totalTokens += usage.inputTokens + usage.outputTokens;
            // Conservative no-cache estimate; coding-plan nominal value is not a bill.
            estimatedSpendUsd += (usage.inputTokens * rate.inputPer1M + usage.outputTokens * rate.outputPer1M) / 1_000_000;
            if (totalTokens >= budget.maxTotalTokens || estimatedSpendUsd >= budget.maxExternalSpendUsd) stopped = true;
          }
          writeFileSync(file, JSON.stringify({ input, output, cellCalls, physicalCalls, totalTokens, estimatedSpendUsd, stopped }, null, 2));
          if (stopped) throw new Error('Pilot token/spend budget reached or usage unavailable; retained completed output.');
        } catch (error) {
          stopped = true;
          writeFileSync(`${file}.failure.json`, JSON.stringify({ failure: error instanceof Error ? error.message : String(error),
            physicalCalls, totalTokens, estimatedSpendUsd }, null, 2)); throw error;
        }
      }
    }));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), 'Pilot observations incomplete; inspect retained raw files.');
  });
});
