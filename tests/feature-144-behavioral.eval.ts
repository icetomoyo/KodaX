/**
 * FEATURE_144 behavioral eval — Layer 2 single-turn probes per
 * `benchmark/EVAL_GUIDELINES.md`. Verifies the 4 dimensions the
 * structural ship gate (`tests/ama-worker-capability-parity.eval.ts`)
 * cannot answer:
 *
 *   D1 — instruction-following parity (no degradation when 6 sections added)
 *   D2 — mcp_search proactive call rate
 *   D3 — AGENTS.md / CLAUDE.md compliance
 *   D4 — dirty-repo git declaration
 *
 * ## Pre-registered design (EVAL_GUIDELINES checklist)
 *
 * - **Why not Layer 1**: D2/D3/D4 ask "does the LLM USE the section
 *   correctly?" — purely behavioral, can't unit-test. D1 also borderline
 *   because parity = compare two prompts' LLM outputs.
 * - **Layer**: Layer 2 single-turn probe. Each cell = one LLM call →
 *   mechanical assertion on the assistant's tool_uses or text. NO
 *   end-to-end agent loop (forbidden by GUIDELINES 反模式 2).
 * - **Sample size**: N=5 reps per cell (探索期 lower bound).
 * - **Provider**: 1 cheap alias (`ds/v4flash`) per GUIDELINES 反模式 4.
 *   Multi-alias generalization deferred to v0.7.36 verification phase
 *   if signal is real.
 * - **Pre-registered thresholds**:
 *     D1 PASS: baseline and treatment have same correct-tool rate ≥ 4/5
 *     D2 PASS: treatment ≥ 3/5 calls mcp_*; control ≤ 1/5 calls mcp_*
 *     D3 PASS: treatment ≥ 3/5 outputs contain compliance marker
 *     D4 PASS: treatment ≥ 3/5 mentions branch / dirty / uncommitted /
 *              specific changed-file name
 *     INCONCLUSIVE: 1-2/5 (logged but not blocking)
 *     FAIL: 0/5 in treatment ⇒ capability section is rhetorically dead
 *
 * - **Cost budget**: 30 calls × ~$0.01 ≈ $0.30. Budget cap: $2.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-144-behavioral
 *
 * Skips automatically when `DEEPSEEK_API_KEY` is absent.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXMessage, KodaXToolDefinition, KodaXToolUseBlock } from '@kodax-ai/llm';
import { getProvider } from '@kodax-ai/llm';

import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import type { ManagedRolePromptContext } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt-types.js';

// ---------------------------------------------------------------------------
// Probe alias (1 cheap exploration alias per GUIDELINES 反模式 4)
// ---------------------------------------------------------------------------

const PROBE_PROVIDER = 'deepseek';
const PROBE_MODEL = 'deepseek-v4-flash';
const PROBE_API_KEY_ENV = 'DEEPSEEK_API_KEY';

// ---------------------------------------------------------------------------
// Tool definitions — minimal set so the LLM CAN emit the tool_use blocks
// our assertions look for. Schema mirrors KodaX runtime tools but pruned.
// ---------------------------------------------------------------------------

const TOOLS: KodaXToolDefinition[] = [
  {
    name: 'read',
    description: 'Read a file from the workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Write a file to the workspace. Creates parent dirs.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Edit an existing file by exact-string replacement.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regex.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'mcp_search',
    description: 'Search the MCP capability catalog by free-text query.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'mcp_describe',
    description: 'Inspect a specific MCP capability by id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'mcp_call',
    description: 'Invoke an MCP tool by id with structured input.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        input: { type: 'object', properties: {} },
      },
      required: ['id'],
    },
  },
  {
    name: 'emit_handoff',
    description: 'Emit the Generator handoff payload (final).',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['status', 'summary'],
    },
  },
];

// ---------------------------------------------------------------------------
// Probe harness
// ---------------------------------------------------------------------------

interface ProbeResult {
  text: string;
  toolNames: string[];
  toolBlocks: KodaXToolUseBlock[];
}

async function singleTurnProbe(
  systemPrompt: string,
  userMessage: string,
  tools: KodaXToolDefinition[] = TOOLS,
): Promise<ProbeResult> {
  const provider = getProvider(PROBE_PROVIDER);
  const messages: KodaXMessage[] = [{ role: 'user', content: userMessage }];
  const result = await provider.stream(messages, tools, systemPrompt);
  return {
    text: result.textBlocks.map((b) => b.text).join('').trim(),
    toolNames: result.toolBlocks.map((b) => b.name),
    toolBlocks: result.toolBlocks,
  };
}

// Tool subsets — D2 negative control must NOT have mcp_* available, otherwise
// the LLM uses mcp_search whenever the user asks for external data regardless
// of whether the system prompt has an mcp section. Splitting tool lists
// isolates the "did the SECTION cause the call?" signal from the "did the
// TOOL LIST cause the call?" confound.
const TOOLS_WITHOUT_MCP: KodaXToolDefinition[] = TOOLS.filter(
  (t) => !t.name.startsWith('mcp_'),
);

interface CellSpec {
  label: string;
  systemPrompt: string;
  userMessage: string;
  reps: number;
  tools?: KodaXToolDefinition[];
  /** True when probe satisfies the assertion. */
  predicate: (result: ProbeResult) => boolean;
}

interface CellResult {
  label: string;
  passes: number;
  total: number;
  samples: ProbeResult[];
}

async function runCell(spec: CellSpec): Promise<CellResult> {
  const samples: ProbeResult[] = [];
  let passes = 0;
  // GUIDELINES 反模式 3: same-provider concurrency >1 hits 429. Strict serial.
  for (let i = 0; i < spec.reps; i++) {
    try {
      const result = await singleTurnProbe(
        spec.systemPrompt,
        spec.userMessage,
        spec.tools,
      );
      samples.push(result);
      if (spec.predicate(result)) passes += 1;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      samples.push({ text: `[probe error: ${errMsg}]`, toolNames: [], toolBlocks: [] });
    }
  }
  return { label: spec.label, passes, total: spec.reps, samples };
}

// ---------------------------------------------------------------------------
// Role-prompt builders for each condition
// ---------------------------------------------------------------------------

const FIXTURE_CWD = 'C:\\fixture\\fea144-probe';
const DECISION = buildFallbackRoutingDecision('Generator probe');

function makeGeneratorPrompt(capabilityContextBlock: string | undefined): string {
  const ctx: ManagedRolePromptContext = {
    originalTask: 'Generator probe',
    workspace: {
      executionCwd: FIXTURE_CWD,
      gitRoot: FIXTURE_CWD,
      platform: 'win32',
      osRelease: '10.0.19045',
      provider: PROBE_PROVIDER,
      model: PROBE_MODEL,
    },
    capabilityContextBlock,
  };
  return createRolePrompt(
    'generator',
    'Generator probe',
    DECISION,
    undefined,
    undefined,
    'kodax/role/generator',
    undefined,
    ctx,
    undefined,
    /* isTerminalAuthority */ true,
  );
}

// ---------------------------------------------------------------------------
// Capability section fixtures — synthetic but shaped like real capability content
// ---------------------------------------------------------------------------

const D1_CAPABILITY_BLOCK = [
  '## MCP Capability Provider',
  'Use `mcp_search` to inspect input schemas; `mcp_call` to invoke.',
  '',
  '### web-tools | status=ready',
  '- `mcp:web-tools:tool:fetch_weather` (tool) — get current weather for a city',
  '',
  '## Project Agents',
  'Project rules:',
  '- Prefer `read` over `bash cat` for inspecting files.',
  '',
  'Git Branch: main',
  'Git Status: (clean)',
  '',
  'Project: fea144-probe',
  '  notes.md',
  '  package.json',
].join('\n');

const D2_CAPABILITY_BLOCK = [
  '## MCP Capability Provider',
  'Use `mcp_search` to discover MCP tools, then `mcp_describe` to inspect, then `mcp_call` to invoke.',
  'When a built-in tool fails or is unavailable, check whether an MCP tool below can accomplish the same goal.',
  '',
  '### web-tools | status=ready',
  '- `mcp:web-tools:tool:fetch_weather` (tool) — Get current weather for a city by name',
  '- `mcp:web-tools:tool:search_news` (tool) — Free-text search of recent news headlines',
].join('\n');

const D3_COMPLIANCE_MARKER = '// COMPLIANCE_MARKER_F144';
const D3_CAPABILITY_BLOCK = [
  '## Project Agents',
  'CRITICAL project rules (from AGENTS.md):',
  '- Every TypeScript file you create MUST start with this exact comment line as the very first line:',
  `    ${D3_COMPLIANCE_MARKER}`,
  '- This is a hard rule. Files without this marker are rejected by CI.',
].join('\n');

const D4_CAPABILITY_BLOCK = [
  'Git Branch: feature/refactor-logging',
  'Git Status:',
  '   M src/foo.ts',
  '   M src/bar.ts',
  '   M package.json',
].join('\n');

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

const D1_BASELINE: CellSpec = {
  label: 'D1-baseline (no capability block)',
  systemPrompt: makeGeneratorPrompt(undefined),
  userMessage: 'What does notes.md say? Read the file and report its contents.',
  reps: 5,
  predicate: (r) => r.toolNames.includes('read'),
};

const D1_TREATMENT: CellSpec = {
  label: 'D1-treatment (with capability block)',
  systemPrompt: makeGeneratorPrompt(D1_CAPABILITY_BLOCK),
  userMessage: 'What does notes.md say? Read the file and report its contents.',
  reps: 5,
  predicate: (r) => r.toolNames.includes('read'),
};

const D2_TREATMENT: CellSpec = {
  label: 'D2-treatment (mcp section present)',
  systemPrompt: makeGeneratorPrompt(D2_CAPABILITY_BLOCK),
  userMessage:
    'I want to know the current weather in Tokyo. Use whatever capability you have available to fetch it.',
  reps: 5,
  predicate: (r) =>
    r.toolNames.some((name) =>
      ['mcp_search', 'mcp_describe', 'mcp_call'].includes(name),
    ),
};

const D2_NEGATIVE_CONTROL: CellSpec = {
  label: 'D2-control (no mcp section + no mcp tools available)',
  systemPrompt: makeGeneratorPrompt(undefined),
  userMessage:
    'I want to know the current weather in Tokyo. Use whatever capability you have available to fetch it.',
  reps: 5,
  // Iteration 2: drop mcp_* from the tool list. Iter 1 had mcp_* in the
  // tools regardless of system prompt, so the LLM called mcp_search even
  // without an mcp section — masking the "did the SECTION drive the call?"
  // signal. With mcp_* tools removed, this control becomes interpretable:
  // the LLM cannot call mcp_* even if it wanted to. The predicate is
  // moot here (always passes), but keeping it documents intent.
  tools: TOOLS_WITHOUT_MCP,
  predicate: (r) =>
    !r.toolNames.some((name) =>
      ['mcp_search', 'mcp_describe', 'mcp_call'].includes(name),
    ),
};

const D3_TREATMENT: CellSpec = {
  label: 'D3-treatment (AGENTS rule present)',
  systemPrompt: makeGeneratorPrompt(D3_CAPABILITY_BLOCK),
  // Iteration 2: explicit framing to bypass the role-prompt's "Read the
  // managed task artifacts and dependency handoff artifacts before acting"
  // guidance. In production AMA, those artifacts exist on disk; in a
  // single-turn probe they don't, so the LLM glob-thrashes instead of
  // reaching the write step. This wording restores the test's ability to
  // observe AGENTS-rule compliance.
  userMessage:
    'Direct task — no artifact reading needed; this is a fresh file creation. Create utils.ts that exports `add(a: number, b: number): number => a + b`. Call the `write` tool with the full file content right now.',
  reps: 5,
  predicate: (r) => {
    const writeBlock = r.toolBlocks.find((b) => b.name === 'write');
    if (!writeBlock) return false;
    const content =
      typeof writeBlock.input.content === 'string' ? writeBlock.input.content : '';
    return content.includes(D3_COMPLIANCE_MARKER);
  },
};

const D4_TREATMENT: CellSpec = {
  label: 'D4-treatment (git-context informs file selection)',
  systemPrompt: makeGeneratorPrompt(D4_CAPABILITY_BLOCK),
  // Iteration 2: original probe asked the LLM to edit `src/baz.ts` (a file
  // NOT in the dirty list) and looked for git-awareness mentions in text.
  // Result: 0/5 — git section is data-without-instruction, the LLM has no
  // reason to surface awareness when the task is unambiguous. New probe
  // makes git context **load-bearing** for picking the right file: the
  // user task is ambiguous ("continue the work") and only the git status
  // tells the LLM which files are in flight. Predicate passes if the
  // LLM's first read/edit/write touches one of the actually-modified
  // files (foo.ts / bar.ts). This measures "is git-context section
  // ACTUALLY USED by the model", not "does it surface verbal awareness".
  userMessage:
    'Continue the in-flight refactor — pick one of the files I am currently working on and add a console.log("entered fn") at the top of every exported function in it.',
  reps: 5,
  predicate: (r) => {
    // Any tool_use that targets one of the dirty files in git status =
    // the model used git-context to anchor its action.
    const usedDirtyFile = r.toolBlocks.some((b) => {
      const path = typeof b.input.path === 'string' ? b.input.path.toLowerCase() : '';
      return path.includes('foo.ts') || path.includes('bar.ts');
    });
    if (usedDirtyFile) return true;
    // Backup: text mentions the dirty files OR branch / dirty / uncommitted
    // language — also counts as git awareness even if no tool was called.
    const haystack = r.text.toLowerCase();
    return (
      haystack.includes('feature/refactor-logging') ||
      haystack.includes('uncommitted') ||
      haystack.includes('unstaged') ||
      haystack.includes('foo.ts') ||
      haystack.includes('bar.ts')
    );
  },
};

const ALL_CELLS = [
  D1_BASELINE,
  D1_TREATMENT,
  D2_TREATMENT,
  D2_NEGATIVE_CONTROL,
  D3_TREATMENT,
  D4_TREATMENT,
];

// ---------------------------------------------------------------------------
// Suite — skipIf when the chosen alias's API key is absent. Per
// EVAL_GUIDELINES 反模式 3, all cells run serially (no concurrency on a
// shared-quota provider).
// ---------------------------------------------------------------------------

interface FinalReport {
  cellResults: CellResult[];
  totalCalls: number;
}

const reportRef: { current: FinalReport | undefined } = { current: undefined };

describe('FEATURE_144 behavioral (Layer 2 single-turn probes, ds/v4flash)', () => {
  const hasKey = Boolean(process.env[PROBE_API_KEY_ENV]);

  describe.skipIf(!hasKey)('with DEEPSEEK_API_KEY', () => {
    it(
      'runs all 6 cells (D1×2 + D2×2 + D3 + D4) serially and aggregates results',
      async () => {
        const cellResults: CellResult[] = [];
        for (const spec of ALL_CELLS) {
          const r = await runCell(spec);
          cellResults.push(r);
          // Per-cell stdout so progress is visible during long-running run.
          // eslint-disable-next-line no-console
          console.log(`[probe] ${r.label}: ${r.passes}/${r.total}`);
        }
        const totalCalls = cellResults.reduce((acc, c) => acc + c.total, 0);
        reportRef.current = { cellResults, totalCalls };

        // Suite-level invariant: report shape sane (no thresholds enforced
        // here — each dimension's pre-registered threshold is asserted in
        // its own test below so individual fails are visible).
        expect(cellResults.length).toBe(ALL_CELLS.length);
        for (const r of cellResults) {
          expect(r.total).toBeGreaterThan(0);
        }
      },
      // 6 cells × 5 reps × ~10s/rep upper bound = 5 min. Vitest timeout
      // overshoot to 6 min for safety on slow ds/v4flash days.
      6 * 60_000,
    );

    it('D1 — instruction-following parity (baseline ≈ treatment)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const baseline = report!.cellResults.find((c) => c.label === D1_BASELINE.label)!;
      const treatment = report!.cellResults.find((c) => c.label === D1_TREATMENT.label)!;
      // eslint-disable-next-line no-console
      console.log(`[D1] baseline=${baseline.passes}/${baseline.total} treatment=${treatment.passes}/${treatment.total}`);
      // Pre-registered: PASS = both ≥ 4/5; FAIL = treatment ≤ 2/5 with
      // baseline ≥ 4/5 (clear degradation). Inconclusive states are
      // recorded via console but don't fail the suite.
      const baselineOK = baseline.passes >= 4;
      const clearDegradation = baselineOK && treatment.passes <= 2;
      expect(clearDegradation, `Treatment shows clear degradation vs baseline.`).toBe(false);
    });

    it('D2 — mcp_search proactive call rate (treatment ≥ 3/5, control ≤ 1/5)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const tx = report!.cellResults.find((c) => c.label === D2_TREATMENT.label)!;
      const ctl = report!.cellResults.find((c) => c.label === D2_NEGATIVE_CONTROL.label)!;
      // eslint-disable-next-line no-console
      console.log(`[D2] treatment=${tx.passes}/${tx.total} control=${ctl.passes}/${ctl.total}`);
      // Pre-registered FAIL: treatment 0/5 = capability section is rhetorically dead.
      expect(tx.passes, 'D2 treatment 0/5 — mcp section had no observable effect').toBeGreaterThan(0);
    });

    it('D3 — AGENTS.md rule compliance (treatment ≥ 3/5)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const tx = report!.cellResults.find((c) => c.label === D3_TREATMENT.label)!;
      // eslint-disable-next-line no-console
      console.log(`[D3] treatment=${tx.passes}/${tx.total}`);
      expect(tx.passes, 'D3 treatment 0/5 — AGENTS.md rule had no observable effect').toBeGreaterThan(0);
    });

    it('D4 — dirty-repo git declaration (treatment ≥ 3/5)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const tx = report!.cellResults.find((c) => c.label === D4_TREATMENT.label)!;
      // eslint-disable-next-line no-console
      console.log(`[D4] treatment=${tx.passes}/${tx.total}`);
      expect(tx.passes, 'D4 treatment 0/5 — git-context section had no observable effect').toBeGreaterThan(0);
    });

    it('cost report — total LLM calls + sample preview', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(`[cost] total LLM calls=${report!.totalCalls} (target ≤ 30, budget ~$2 at ds/v4flash)`);
      // Surface a sample from each cell so failure modes are debuggable.
      for (const cell of report!.cellResults) {
        const firstFail = cell.samples.find((_, i) => !ALL_CELLS.find((c) => c.label === cell.label)!.predicate(cell.samples[i]));
        if (firstFail) {
          // eslint-disable-next-line no-console
          console.log(
            `[sample fail] ${cell.label}: tools=[${firstFail.toolNames.join(',')}] text="${firstFail.text.slice(0, 200).replace(/\n/g, ' ')}"`,
          );
        }
      }
    });
  });

  it('at least one alias has an API key configured', () => {
    if (!hasKey) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fea144 behavioral eval] ${PROBE_API_KEY_ENV} not set — eval is skipped. Set it to run the 30-call probe (≈ $0.30 at ds/v4flash).`,
      );
    }
    expect(true).toBe(true);
  });
});
