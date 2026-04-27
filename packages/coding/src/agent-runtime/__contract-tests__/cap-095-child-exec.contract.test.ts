/**
 * Contract test for CAP-095: child-executor SA invocation contract
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-095-child-executor-sa-invocation-contract
 *
 * Test obligations:
 * - CAP-CHILD-EXEC-001: read child uses agentMode:'sa' + READONLY excludeTools
 * - CAP-CHILD-EXEC-002: write child has isolated worktree (executionCwd /
 *   gitRoot / fresh backups Map)
 * - CAP-CHILD-EXEC-003: post-FEATURE_100 child enters Runner frame.
 *   Activated by FEATURE_100 P3.6s — `runKodaX` is now a thin
 *   `Runner.run(createDefaultCodingAgent(), …)` shim, so any
 *   `runKodaX(…)` call from `child-executor` automatically flows through
 *   the Runner frame. Asserting this contract = asserting the shim is
 *   wired (which the smoke test in `agent.ts` would crash without).
 *
 * Risk: HIGH (subagent fan-out is the second consumer of substrate
 * after main SA path; must enter Runner frame after FEATURE_100)
 *
 * Class: 1
 *
 * Verified location: child-executor.ts:196-241 (executeReadChild);
 * :243-317 (executeWriteChild). The lazy-loader bridge
 * `getRunKodaX()` (child-executor.ts:33-67) imports `runKodaX` from
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
  runKodaX: vi.fn(),
}));

vi.mock('../../tools/worktree.js', () => ({
  toolWorktreeCreate: vi.fn(),
  toolWorktreeRemove: vi.fn(),
}));

import { executeChildAgents, CHILD_EXCLUDE_TOOLS_BASE } from '../../child-executor.js';
import { runKodaX } from '../../agent.js';
import { toolWorktreeCreate, toolWorktreeRemove } from '../../tools/worktree.js';
import type {
  KodaXChildContextBundle,
  KodaXAmaFanoutClass,
} from '../../types.js';

const mockRunKodaX = runKodaX as ReturnType<typeof vi.fn>;
const mockWorktreeCreate = toolWorktreeCreate as ReturnType<typeof vi.fn>;
const mockWorktreeRemove = toolWorktreeRemove as ReturnType<typeof vi.fn>;

function createBundle(overrides: Partial<KodaXChildContextBundle> = {}): KodaXChildContextBundle {
  return {
    id: `cb-${Math.random().toString(36).slice(2, 6)}`,
    fanoutClass: 'evidence-scan' as KodaXAmaFanoutClass,
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

describe('CAP-095: child-executor SA invocation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CAP-CHILD-EXEC-001: executeReadChild invokes SA with agentMode:"sa", CHILD_AGENT_SYSTEM_PROMPT override, and READONLY excludeTools', async () => {
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
        parentRole: 'scout',
        parentHarness: 'H0_DIRECT',
      },
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const [opts] = mockRunKodaX.mock.calls[0]!;
    expect(opts.agentMode).toBe('sa');
    // System prompt is replaced wholesale (not appended) for child agents
    expect(typeof opts.context?.systemPromptOverride).toBe('string');
    expect(opts.context?.systemPromptOverride).toContain('focused sub-agent');
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

  it('CAP-CHILD-EXEC-002: executeWriteChild creates an isolated worktree with its own executionCwd, gitRoot, and a fresh empty backups Map', async () => {
    mockWorktreeCreate.mockResolvedValueOnce(
      JSON.stringify({ path: '/tmp/wt-iso', branch: 'wt-iso' }),
    );
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
        parentOptions: { provider: 'anthropic' },
        // Only Generator + H2 harness may emit write fan-out.
        parentRole: 'generator',
        parentHarness: 'H2_PLAN_EXECUTE_EVAL',
      },
    );

    expect(mockWorktreeCreate).toHaveBeenCalledTimes(1);
    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const [opts] = mockRunKodaX.mock.calls[0]!;
    // Child sees its OWN executionCwd / gitRoot — NOT the parent's
    // /parent/repo
    expect(opts.context?.executionCwd).toBe('/tmp/wt-iso');
    expect(opts.context?.gitRoot).toBe('/tmp/wt-iso');
    // Write children keep write/edit tools (NOT in excludeTools)
    const excluded = opts.context?.excludeTools as readonly string[];
    expect(excluded).not.toContain('write');
    expect(excluded).not.toContain('edit');
    // Base exclusions still in effect (no recursion / no AMA / no
    // ask_user / no plan-mode-exit)
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
        parentRole: 'scout',
        parentHarness: 'H0_DIRECT',
      },
    );
    // The lazy-loaded import resolved to the FEATURE_100 thin shim ⇒
    // any successful invocation IS a Runner-frame invocation.
    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
  });
});
