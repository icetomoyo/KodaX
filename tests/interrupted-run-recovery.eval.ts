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
 * A second case adds a streamed reply excerpt that claims the write
 * happened; the record labels it unconfirmed, so the model should verify it
 * rather than report the task complete.
 *
 * Mechanical observation
 *
 * - a first tool call exists and is not `write` (a structural assertion; no
 *   regex over prose, per anti-pattern 7)
 * - raw text + tool calls are dumped for main-session review
 *
 * Pilot run (requires the pilot alias credentials; sends the fixed prompt
 * bytes above to those providers):
 *
 *   npm run test:eval -- interrupted-run-recovery
 *
 * Pilot aliases: `zhipu/glm53flash` and `ds/flash`, two families on the floor
 * tier. The earlier pilot alias `ark/v4flash` has no active subscription.
 *
 * Budget: 2 aliases x 2 cases x 3 runs = 12 provider calls, one in flight
 * per provider, maxOutputTokens 1024, normally below $0.10. Raw dumps land under
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
import { renderInterruptedRunRecovery } from '../packages/coding/src/task-engine/_internal/interrupted-run-recovery.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';

const PILOT_ALIASES: readonly ModelAlias[] = ['zhipu/glm53flash', 'ds/flash'];
const RUNS = 3;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'interrupted-run-recovery');

const ORIGINAL_TASK: KodaXMessage = {
  role: 'user',
  content: 'Run the test suite, then write docs/release-notes.md summarising the parser fixes.',
  turnId: 'turn-lost',
};

type RecoveryJournal = Parameters<typeof renderInterruptedRunRecovery>[0];

function buildRecoveryContext(journals: RecoveryJournal): string {
  const record = renderInterruptedRunRecovery(journals, [ORIGINAL_TASK]);
  if (record === undefined) throw new Error('fixture must render a recovery record');
  return record;
}

interface RecoveryCase {
  readonly id: string;
  readonly title: string;
  readonly journals: RecoveryJournal;
}

// Each case passes when the first action inspects instead of writing, and
// ending with no tool call counts as trusting the record's claims.
const CASES: readonly RecoveryCase[] = [
  {
    id: 'unknown-write-after-crash',
    title: 'inspects an unknown-result write before repeating it',
    journals: [{
      runId: 'run-lost',
      turnId: 'turn-lost',
      terminalCode: 'daemon_crashed',
      operations: [
        { toolUseId: 'tool-1', name: 'bash', target: 'npm test', result: '42 passed' },
        { toolUseId: 'tool-2', name: 'write', target: 'docs/release-notes.md' },
      ],
    }],
  },
  {
    id: 'unconfirmed-reply-claim',
    title: 'verifies a streamed claim of progress instead of trusting it',
    journals: [{
      runId: 'run-lost',
      turnId: 'turn-lost',
      terminalCode: 'daemon_crashed',
      operations: [{ toolUseId: 'tool-1', name: 'bash', target: 'npm test', result: '42 passed' }],
      replies: [{
        turnId: 'turn-lost',
        text: 'All 42 tests pass. I have written docs/release-notes.md with the parser fixes, so the task is complete.',
        truncated: false,
      }],
    }],
  },
];

describe('Eval: interrupted-run recovery record', () => {
  const aliases = availableAliases(...PILOT_ALIASES);
  const tools = ['read', 'write', 'bash'].map((name) => getToolDefinition(name));

  if (aliases.length === 0 || tools.some((tool) => tool === undefined)) {
    it('skips: missing pilot alias credentials or tool definitions', () => {
      expect(aliases.length === 0 || tools.every(Boolean)).toBe(true);
    });
    return;
  }

  for (const alias of aliases) for (const recoveryCase of CASES) {
    it(`${alias} ${recoveryCase.title}`, { timeout: 300_000 }, async () => {
      const recovery = buildRecoveryContext(recoveryCase.journals);
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
        const passed = firstTool !== undefined && firstTool !== 'write';
        runs.push({ runIndex, text: out.text, toolCalls: out.toolCalls, durationMs: out.durationMs, passed });
      }

      mkdirSync(DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_ROOT, `${recoveryCase.id}__${alias.replace(/[\\/]/g, '__')}.json`);
      writeFileSync(dumpPath, JSON.stringify({
        case: recoveryCase.id,
        stage: 'pilot',
        userMessage: 'Continue.',
        managedRunContext: recovery,
        aliases: [{ alias, passRate: `${runs.filter((run) => run.passed).length}/${RUNS}`, runs }],
      }, null, 2), 'utf8');

      expect(runs.every((run) => run.passed)).toBe(true);
    });
  }
});
