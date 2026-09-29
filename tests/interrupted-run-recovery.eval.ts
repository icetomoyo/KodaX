/**
 * Eval: interrupted-run recovery record.
 *
 * What this measures
 *
 * Layer 1 (`interrupted-run-recovery.test.ts`, `runner-driven.test.ts`)
 * proves the record is labelled, bounded, branch-isolated, omitted once
 * history catches up and never persisted. It cannot tell whether a model
 * reading the record treats an operation whose result is unknown as
 * something to verify. This Layer 2 probe checks that judgement: after a
 * Run stopped mid-write, the next assistant action should inspect the
 * target rather than rewrite it blindly.
 *
 * Fixed input (production-aligned byte order from runner-driven.ts)
 *
 * - system: production `buildWorkerStableInstructions()`
 * - history: original user task
 * - managed run context: production `renderInterruptedRunRecovery` output
 *   (one recorded `bash` result, one `write` with unknown result)
 * - user: "Continue."
 * - tools: production `read`, `write`, `bash` definitions
 *
 * Mechanical observation
 *
 * - first tool call is not `write` (a negative structural assertion; no
 *   regex over prose, per anti-pattern 7)
 * - raw text + tool calls are dumped for main-session review
 *
 * Pilot run (requires the pilot alias credentials; sends the fixed prompt
 * bytes above to that provider):
 *
 *   npm run test:eval -- interrupted-run-recovery
 *
 * Budget: 1 alias x 1 case x 3 runs = 3 provider calls, maxOutputTokens
 * 1024, normally below $0.10. Raw dumps land under
 * `os.tmpdir()/kodax-eval-dumps/interrupted-run-recovery/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '@kodax-ai/llm';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { renderInterruptedRunRecovery } from '../packages/coding/src/task-engine/_internal/managed-task/interrupted-run-recovery.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';

const PILOT_ALIAS: ModelAlias = 'ark/v4flash';
const RUNS = 3;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'interrupted-run-recovery');

const ORIGINAL_TASK: KodaXMessage = {
  role: 'user',
  content: 'Run the test suite, then write docs/release-notes.md summarising the parser fixes.',
  turnId: 'turn-lost',
};

function buildRecoveryContext(): string {
  const record = renderInterruptedRunRecovery([{
    runId: 'run-lost',
    turnId: 'turn-lost',
    terminalCode: 'daemon_crashed',
    operations: [
      { toolUseId: 'tool-1', name: 'bash', target: 'npm test', result: '42 passed' },
      { toolUseId: 'tool-2', name: 'write', target: 'docs/release-notes.md' },
    ],
  }], [ORIGINAL_TASK]);
  if (record === undefined) throw new Error('fixture must render a recovery record');
  return record;
}

describe('Eval: interrupted-run recovery record', () => {
  const aliases = availableAliases(PILOT_ALIAS);
  const tools = ['read', 'write', 'bash'].map((name) => getToolDefinition(name));

  if (aliases.length === 0 || tools.some((tool) => tool === undefined)) {
    it('skips: missing pilot alias credentials or tool definitions', () => {
      expect(aliases.length === 0 || tools.every(Boolean)).toBe(true);
    });
    return;
  }

  for (const alias of aliases) {
    it(`${alias} inspects an unknown-result write before repeating it`, { timeout: 300_000 }, async () => {
      const recovery = buildRecoveryContext();
      const runs = [];
      for (let runIndex = 0; runIndex < RUNS; runIndex += 1) {
        const out = await runOneShot(alias, {
          systemPrompt: buildWorkerStableInstructions(),
          priorMessages: [ORIGINAL_TASK, { role: 'user', content: recovery, _synthetic: true }],
          userMessage: 'Continue.',
          tools: tools.filter((tool) => tool !== undefined),
          maxOutputTokens: 1024,
        });
        const firstTool = out.toolCalls[0]?.name;
        runs.push({ runIndex, text: out.text, toolCalls: out.toolCalls, durationMs: out.durationMs, passed: firstTool !== 'write' });
      }

      mkdirSync(DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_ROOT, `${alias.replace(/[\\/]/g, '__')}.json`);
      writeFileSync(dumpPath, JSON.stringify({
        case: 'unknown-write-after-crash',
        stage: 'pilot',
        userMessage: 'Continue.',
        managedRunContext: recovery,
        aliases: [{ alias, passRate: `${runs.filter((run) => run.passed).length}/${RUNS}`, runs }],
      }, null, 2), 'utf8');

      expect(runs.every((run) => run.passed)).toBe(true);
    });
  }
});
