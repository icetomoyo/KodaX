/**
 * Contract test for CAP-095: child-executor direct-engine invocation contract
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-095-child-executor-sa-invocation-contract
 *
 * Test obligations:
 * - CAP-CHILD-EXEC-001: read child carries no agentMode label + READONLY excludeTools
 * - CAP-CHILD-EXEC-002: write child inherits parent executionCwd / gitRoot
 *   + a fresh backups Map (FEATURE_188 v0.7.42 dropped forced worktree —
 *   ADR-034; per-file `backups` Map remains the per-child rollback
 *   substrate)
 * - CAP-CHILD-EXEC-003: post-FEATURE_100 child enters Runner frame.
 *   Activated by FEATURE_100 P3.6s — `runKodaX` is now a thin
 *   `Runner.run(createDefaultCodingAgent(), …)` shim, so any
 *   `runKodaX(…)` call from `child-executor` automatically flows through
 *   the Runner frame. Asserting this contract = asserting the shim is
 *   wired (which the smoke test in `agent.ts` would crash without).
 *
 * Risk: HIGH (subagent fan-out is the second consumer of substrate
 * after the main direct-engine path; must enter Runner frame after FEATURE_100)
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:196-241 (executeReadChild);
 * :243-317 (executeWriteChild). The lazy-loader bridge
 * `getRunLeaf()` (child-executor.ts:33-67) imports `runKodaX` from
 * `./agent.js`, which is the FEATURE_100 P3.6s thin Runner.run shim.
 *
 * Time-ordering constraint: triggered mid-turn during parent's tool
 * dispatch; child runs to completion before parent's tool result is built.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6t.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock runKodaX before importing child-executor — same hoisted-mock
// pattern used by `child-executor.test.ts`. The dynamic-import bridge
// in child-executor (`getRunKodaX`) resolves through `./agent.js`, so
// we mock that module surface.
vi.mock('../../agent.js', () => ({
  runLeafAgent: vi.fn(),
}));

// FEATURE_188 v0.7.42 — write children no longer use worktree; remove the
// previous `vi.mock('../../tools/worktree.js')` block (child-executor no
// longer imports those helpers, so mocking the module surface is moot).

import {
  CHILD_AGENT_SYSTEM_PROMPT,
  CHILD_EXCLUDE_TOOLS_BASE,
  executeChildAgents,
} from '../../child-executor.js';
import { runLeafAgent } from '../../agent.js';
import {
  _resetAgentResolverForTesting,
  registerConstructedAgent,
} from '../../construction/index.js';
import type { AgentArtifact } from '../../construction/types.js';
import type {
  KodaXChildContextBundle,
  KodaXChildFanoutClass,
} from '../../types.js';

const mockRunKodaX = runLeafAgent as ReturnType<typeof vi.fn>;

function createBundle(overrides: Partial<KodaXChildContextBundle> = {}): KodaXChildContextBundle {
  return {
    id: `cb-${Math.random().toString(36).slice(2, 6)}`,
    fanoutClass: 'evidence-scan' as KodaXChildFanoutClass,
    objective: 'Test objective',
    evidenceRefs: [],
    constraints: [],
    readOnly: true,
    ...overrides,
  };
}

function createCtx() {
  return {
    backups: new Map([['/parent/file.ts', 'parent backup content']]),
    gitRoot: '/parent/repo',
    executionCwd: '/parent/repo',
  };
}

describe('CAP-095: child-executor direct-engine invocation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // FEATURE_191 — keep the specialist registry empty by default so
    // existing CAP-CHILD-EXEC-001..003 hit the no-specialist branch
    // (matches the contract's pre-FEATURE_191 behavior).
    _resetAgentResolverForTesting();
  });

  it('CAP-CHILD-EXEC-001: executeReadChild invokes runKodaX without an agentMode label, CHILD_AGENT_SYSTEM_PROMPT override, and READONLY excludeTools', async () => {
    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'read finding',
      messages: [{ role: 'assistant', content: 'read finding' }],
      sessionId: 's1',
    });

    await executeChildAgents(
      [createBundle({ id: 'cb-r', readOnly: true, objective: 'investigate auth' })],
      createCtx(),
      {
        maxParallel: 1,
        maxIterationsPerChild: 5,
        parentOptions: { provider: 'anthropic' },
        parentRole: 'worker',
        parentHarness: 'tool-dispatch',
      },
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const [opts] = mockRunKodaX.mock.calls[0]!;
    expect(opts.agentMode).toBeUndefined();
    // FEATURE_191 default-path guard: identity check against the canonical
    // CHILD_AGENT_SYSTEM_PROMPT. Pre-F191 read-only children use this
    // prompt verbatim; if a specialist branch ever leaks into this no-
    // specialist bundle path the override would be the specialist's own
    // instructions string (not this constant), and the assertion fails.
    // Identity check (vs. word-match like `not.toMatch(/SPECIALIST/i)`)
    // is robust against future SP additions that happen to include the
    // word "specialist" (e.g. FEATURE_125 Team Mode).
    expect(opts.context?.systemPromptOverride).toBe(CHILD_AGENT_SYSTEM_PROMPT);
    // Read-only children must not see write/edit/multi_edit/insert_after_anchor/undo
    const excluded = opts.context?.excludeTools as readonly string[];
    expect(excluded).toEqual(
      expect.arrayContaining([
        ...CHILD_EXCLUDE_TOOLS_BASE,
        'write',
        'edit',
        'multi_edit',
        'insert_after_anchor',
        'undo',
      ]),
    );
  });

  it('CAP-CHILD-EXEC-001b: executeReadChild inherits parent repo-intelligence mode and trace', async () => {
    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'read finding',
      messages: [{ role: 'assistant', content: 'read finding' }],
      sessionId: 's-ri',
    });

    await executeChildAgents(
      [createBundle({ id: 'cb-ri', readOnly: true, objective: 'investigate auth' })],
      createCtx(),
      {
        maxParallel: 1,
        maxIterationsPerChild: 5,
        parentOptions: {
          provider: 'anthropic',
          repoIntelligenceMode: 'off',
          repoIntelligenceTrace: true,
        },
        parentRole: 'worker',
        parentHarness: 'tool-dispatch',
      },
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const [opts] = mockRunKodaX.mock.calls[0]!;
    expect(opts.context?.repoIntelligenceMode).toBe('off');
    expect(opts.context?.repoIntelligenceTrace).toBe(true);
  });

  it('CAP-CHILD-EXEC-002: executeWriteChild inherits parent executionCwd / gitRoot and gets a fresh backups Map (FEATURE_188 v0.7.42, ADR-034 — forced worktree dropped)', async () => {
    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'wrote',
      messages: [{ role: 'assistant', content: '' }],
      sessionId: 's-write',
    });

    await executeChildAgents(
      [createBundle({ id: 'cb-w', readOnly: false, objective: 'refactor module' })],
      createCtx(),
      {
        maxParallel: 1,
        maxIterationsPerChild: 5,
        parentOptions: {
          provider: 'anthropic',
          repoIntelligenceMode: 'off',
          repoIntelligenceTrace: true,
        },
        // Only Worker + tool-dispatch harness may emit write fan-out.
        parentRole: 'worker',
        parentHarness: 'tool-dispatch',
      },
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const [opts] = mockRunKodaX.mock.calls[0]!;
    // Child shares parent executionCwd / gitRoot (no worktree).
    expect(opts.context?.executionCwd).toBe('/parent/repo');
    expect(opts.context?.gitRoot).toBe('/parent/repo');
    expect(opts.context?.repoIntelligenceMode).toBe('off');
    expect(opts.context?.repoIntelligenceTrace).toBe(true);
    // Write children keep write/edit tools (NOT in excludeTools)
    const excluded = opts.context?.excludeTools as readonly string[];
    expect(excluded).not.toContain('write');
    expect(excluded).not.toContain('edit');
    // Base exclusions still block user interaction, parent-managed worktree
    // lifecycle, and plan-mode exit. Recursive collaboration stays available.
    expect(excluded).toEqual(expect.arrayContaining([...CHILD_EXCLUDE_TOOLS_BASE]));
  });

  it('CAP-CHILD-EXEC-003: child invocation flows through the Runner frame via the runKodaX shim (post-FEATURE_100 P3.6s)', async () => {
    // The shim guarantee: child-executor calls `runKodaX(opts, briefing)`,
    // and `runKodaX` (agent.ts) is now a thin
    // `Runner.run(createDefaultCodingAgent(), …)` wrapper. The contract
    // is satisfied by:
    //   1. child-executor reaches `runKodaX` (verified by call count)
    //   2. `runKodaX` itself flows through Runner — covered by
    //      `coding-preset.test.ts` "Runner.run delegates to
    //      Agent.substrateExecutor" + the agent.ts implementation
    //
    // Asserting (1) here suffices for the boundary; (2) is verified at
    // the agent.ts boundary, not the child-executor boundary.
    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'done',
      messages: [],
      sessionId: 's-frame',
    });
    await executeChildAgents(
      [createBundle({ id: 'cb-frame', readOnly: true, objective: 'verify Runner-frame entry' })],
      createCtx(),
      {
        maxParallel: 1,
        maxIterationsPerChild: 3,
        parentOptions: { provider: 'anthropic' },
        parentRole: 'worker',
        parentHarness: 'tool-dispatch',
      },
    );
    // The lazy-loaded import resolved to the FEATURE_100 thin shim ⇒
    // any successful invocation IS a Runner-frame invocation.
    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
  });

  it('CAP-CHILD-EXEC-004: specialist branch — bundle.specialistName routes the child through the registered Agent (FEATURE_191 v0.7.43)', async () => {
    // Register a specialist agent in the resolver registry. The child
    // executor's specialist branch (child-executor.ts
    // `resolveSpecialistOverride`) reads instructions from the registered
    // Agent and appends them after the stable child system prefix. This
    // contract guarantee mirrors CAP-CHILD-EXEC-001 for the new branch:
    // the parent's KodaXOptions are not leaked, and the specialist's
    // declared tools narrow the child's tool surface.
    const SPECIALIST_PROMPT = 'You are a database migration reviewer.';
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'db-reviewer',
      version: '0.0.0-cap095',
      content: {
        instructions: SPECIALIST_PROMPT,
        description: 'Reviews DB migrations for safety',
        tools: [{ ref: 'builtin:read' }, { ref: 'builtin:grep' }],
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    };
    registerConstructedAgent(artifact);

    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'reviewed',
      messages: [],
      sessionId: 's-specialist',
    });

    await executeChildAgents(
      [createBundle({
        id: 'cb-specialist',
        readOnly: true,
        objective: 'review the latest migration',
        specialistName: 'db-reviewer',
      })],
      createCtx(),
      {
        maxParallel: 1,
        maxIterationsPerChild: 3,
        parentOptions: { provider: 'anthropic' },
        parentRole: 'worker',
        parentHarness: 'tool-dispatch',
      },
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const [opts] = mockRunKodaX.mock.calls[0]!;
    // Constructed specialists retain the documented full-prompt override
    // contract; child safety is enforced independently through tool policy.
    expect(opts.context?.systemPromptOverride).toBe(SPECIALIST_PROMPT);
    // Complementary exclusion: specialist whitelisted `read` + `grep`,
    // so the executor builds excludeTools = allTools - specialistTools.
    const excluded = opts.context?.excludeTools as readonly string[];
    expect(excluded).not.toContain('read');
    expect(excluded).not.toContain('grep');
    expect(excluded).toContain('write');
    expect(excluded).toContain('edit');
  });
});
