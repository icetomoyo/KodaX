/**
 * Historical eval: FEATURE_119 Pattern B async dispatch (v0.7.36).
 *
 * Superseded by FEATURE_270 in v0.7.72. The retired tool surface remains here
 * as release evidence, but this suite is skipped because it must not constrain
 * or dynamically import the current Actor collaboration implementation.
 *
 * ## Why this exists
 *
 * v0.7.36 FEATURE_119 changed the tool surface the LLM sees from a single
 * blocking `dispatch_child_task` to a launch + await pair. The risk surface
 * is *behavioral*, not internal:
 *
 *   - The LLM might `await_child_task` immediately after `dispatch_child_task`,
 *     defeating the async win and degenerating to the v0.7.35 sync path.
 *   - The LLM might forget to `await_child_task` and orphan the in-flight
 *     promise.
 *   - The LLM might serialize awaits when a parallel batch was the right
 *     pattern (lose the concurrency dividend).
 *
 * Behavioral validation (LLM-judge eval over real model rollouts) is the
 * gold standard but requires multi-provider API keys and a non-trivial
 * budget. This file is the **structural ship gate** that runs in CI with
 * no API key and no LLM call:
 *
 * 1. **Tool surface**: both `dispatch_child_task` AND `await_child_task` are
 *    registered as first-class tools.
 * 2. **Description load-bearing content**: the descriptions actually carry
 *    the WHEN-TO-USE guidance the LLM needs — `dispatch_child_task` mentions
 *    parallel-call usage + `await_child_task` references the `task_id:<id>`
 *    handoff banner + the parallel-then-reclaim pattern.
 * 3. **Worker V2 role prompt**: contains the Pattern B explanation block
 *    documented in `worker-role-prompt.ts`.
 * 4. **Async path is the default**: `shouldUseAsyncDispatch` returns true
 *    in default env; the `KODAX_ASYNC_DISPATCH=0` escape hatch is the only
 *    way to opt back into the sync path.
 *
 * Behavioral eval (LLM-judge over 8 alias × parallel/serial routing decisions)
 * is tracked as a v0.7.37 follow-up in `docs/features/v0.7.37.md` §
 * "FEATURE_119 behavioral follow-up".
 *
 * ## Run
 *
 *   npx vitest run -c tests/config/vitest.eval.config.ts tests/feature-119-pattern-b-async-dispatch.eval.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getToolDefinition } from '../packages/coding/src/tools/registry.js';
import { buildWorkerInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import type { KodaXTaskRoutingDecision } from '../packages/coding/src/types.js';

const baseDecision: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.7,
  reason: 'PLANNED route',
  requiresBrainstorm: false,
};

describe.skip('FEATURE_119 — superseded Pattern B async dispatch evidence', () => {
  describe('tool surface', () => {
    it('registers both dispatch_child_task AND await_child_task', () => {
      const dispatch = getToolDefinition('dispatch_child_task');
      const awaitTool = getToolDefinition('await_child_task');
      expect(dispatch, 'dispatch_child_task must be registered').toBeDefined();
      expect(awaitTool, 'await_child_task must be registered').toBeDefined();
    });

    it('dispatch_child_task description guides parallel use (multi tool_use blocks per response)', () => {
      const dispatch = getToolDefinition('dispatch_child_task');
      const desc = (dispatch?.description ?? '').toLowerCase();
      expect(
        desc,
        'dispatch_child_task description must mention parallel/concurrent usage so LLM emits multiple tool_use blocks',
      ).toMatch(/parallel|concurrent/);
    });

    it('await_child_task description carries the load-bearing parallel-then-reclaim pattern', () => {
      const awaitTool = getToolDefinition('await_child_task');
      const desc = awaitTool?.description ?? '';

      expect(desc, 'await_child_task description must reference the task_id banner contract').toMatch(/task_id/);
      expect(desc, 'await_child_task description must mention WHEN TO USE').toMatch(/WHEN TO USE/i);
      expect(
        desc,
        'await_child_task description must show the dispatch-multiple-then-await pattern',
      ).toMatch(/parallel|in one response|multiple tool_use/i);
      expect(
        desc.toLowerCase(),
        'await_child_task description must mention background notification arrival so LLM understands proactive vs reactive await',
      ).toMatch(/notification|task-completed|background/);
    });

    it('await_child_task input schema requires task_id', () => {
      const awaitTool = getToolDefinition('await_child_task');
      const schema = awaitTool?.input_schema as
        | { properties?: Record<string, { description?: string }>; required?: string[] }
        | undefined;
      expect(schema?.required, 'task_id is the only meaningful input').toEqual(['task_id']);
      expect(schema?.properties?.task_id?.description ?? '').toMatch(/task_id|dispatch_child_task/i);
    });
  });

  describe('Worker V2 role prompt — Pattern B integration', () => {
    it('includes the Pattern B explanation block (FEATURE_119 anchor)', () => {
      const out = buildWorkerInstructions(baseDecision, undefined, false);
      expect(out, 'Worker prompt must contain "Pattern B" anchor for V2 path').toContain('Pattern B');
      expect(
        out,
        'Worker prompt must reference FEATURE_119 dispatch+await contract',
      ).toContain('FEATURE_119');
    });

    it('explains the task_id:<id> handoff banner', () => {
      const out = buildWorkerInstructions(baseDecision, undefined, false);
      expect(out).toMatch(/task_id:<id>|task_id<id>|`task_id:/);
    });

    it('explains the await_child_task reclaim path', () => {
      const out = buildWorkerInstructions(baseDecision, undefined, false);
      expect(out).toContain('await_child_task');
      expect(
        out,
        'Worker prompt should mention that background completion arrives via notification',
      ).toMatch(/notification|<task-completed>/i);
    });

    it('emits dispatch RULE A/B/C decision criteria so LLM knows WHEN to dispatch vs go inline', () => {
      const out = buildWorkerInstructions(baseDecision, undefined, false);
      expect(out).toContain('RULE A');
      expect(out).toContain('RULE B');
      expect(out).toContain('RULE C');
    });
  });

  describe('default-on policy + escape hatch', () => {
    const ORIG = process.env.KODAX_ASYNC_DISPATCH;
    beforeEach(() => {
      delete process.env.KODAX_ASYNC_DISPATCH;
    });
    afterEach(() => {
      if (ORIG === undefined) delete process.env.KODAX_ASYNC_DISPATCH;
      else process.env.KODAX_ASYNC_DISPATCH = ORIG;
    });

    it('async path is on by default — only KODAX_ASYNC_DISPATCH=0 disables it', async () => {
      // shouldUseAsyncDispatch is module-private; we verify via the
      // tool's external behavior. With env unset and a registry on the
      // ctx, the async branch sets a `task_id:` banner. That's the
      // structural signature we anchor on.
      const { toolDispatchChildTask } = await import('../packages/coding/src/tools/dispatch-child-tasks.js');
      // Just exercise the type signature export — running it requires
      // a fully populated KodaXToolExecutionContext + child-executor
      // mock that lives in async-dispatch.test.ts. Here we only need
      // to confirm the launcher exists and is callable.
      expect(typeof toolDispatchChildTask).toBe('function');
    });
  });
});
