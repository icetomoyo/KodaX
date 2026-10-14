/**
 * Unit tests for FEATURE_189 Batch 3 B.2 — tool_search + deferred tool swap.
 *
 * Behavioral guarantees pinned here:
 *   - `tool_search` `select:NAME` returns the full schema as a `<function>` block
 *   - `tool_search` keyword search ranks by hint-content match
 *   - Selecting a deferred tool name adds it to the per-context unlock Set
 *   - `getActiveToolDefinitions` returns the searchHint for deferred tools
 *     when the unlock set does not contain them
 *   - `getActiveToolDefinitions` returns the full description when the
 *     unlock set contains the tool name
 *   - `getActiveToolDefinitions` leaves non-deferred tools alone
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from '@kodax-ai/agent/capabilities/skills';

import type { KodaXToolExecutionContext, KodaXToolVisibilityMeta } from '../types.js';
import { getActiveToolDefinitions } from '../agent-runtime/tool-resolution.js';
import { executeTool, getToolDefinition } from './index.js';
import {
  DEFERRED_TOOL_HINTS,
  isDeferredTool,
  unlockDeferredToolForContext,
  getUnlockedDeferredTools,
  _resetUnlockedDeferredToolsForTest,
} from './deferred-tools.js';
import { toolSearchHandler, TOOL_SEARCH_DEFINITION } from './tool-search.js';

function makeContext(): KodaXToolExecutionContext {
  return { backups: new Map(), executionCwd: process.cwd() };
}

describe('FEATURE_189 B.2 — deferred-tools registry', () => {
  it('exports a non-empty hint map', () => {
    expect(Object.keys(DEFERRED_TOOL_HINTS).length).toBeGreaterThanOrEqual(10);
  });

  it('classifies all deferred hint entries as deferred', () => {
    for (const name of Object.keys(DEFERRED_TOOL_HINTS)) {
      expect(isDeferredTool(name)).toBe(true);
    }
  });

  it('keeps exactly the intended rich-schema tool set deferred', () => {
    const expected = [
      'web_search', 'web_fetch', 'code_search', 'semantic_lookup',
      'repo_overview', 'changed_scope',
      'module_context', 'symbol_context', 'process_context', 'impact_estimate',
      'run_workflow',
    ];
    expect(Object.keys(DEFERRED_TOOL_HINTS)).toEqual(expected);
  });

  it('does NOT classify core tools as deferred', () => {
    for (const name of [
      'read', 'write', 'edit', 'bash', 'grep', 'glob', 'todo_create', 'todo_update',
      'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents',
      'interrupt_agent', 'agent_output', 'tool_search',
      'get_goal', 'create_goal', 'update_goal',
      'mcp_search', 'mcp_describe', 'mcp_call', 'mcp_read_resource', 'mcp_get_prompt',
    ]) {
      expect(isDeferredTool(name)).toBe(false);
    }
  });

  it('hint length stays compact (≤ ~250 chars per hint)', () => {
    for (const [name, hint] of Object.entries(DEFERRED_TOOL_HINTS)) {
      expect(hint.length, `${name} hint too long: ${hint.length}`).toBeLessThanOrEqual(250);
    }
  });

  it('teaches the changed-scope to review-fan-out transition', () => {
    expect(DEFERRED_TOOL_HINTS.changed_scope).toContain(
      'fan out independent review lanes before reading every diff',
    );
    expect(DEFERRED_TOOL_HINTS.changed_scope).toContain('change-set reviews');
    expect(DEFERRED_TOOL_HINTS.changed_scope).not.toContain('canonical review entry');
  });
});

describe('FEATURE_189 B.2 — unlockDeferredToolForContext', () => {
  let ctx: KodaXToolExecutionContext;
  beforeEach(() => {
    ctx = makeContext();
    _resetUnlockedDeferredToolsForTest(ctx);
  });

  it('starts empty for a fresh context', () => {
    expect(getUnlockedDeferredTools(ctx).size).toBe(0);
  });

  it('records an unlocked tool', () => {
    unlockDeferredToolForContext(ctx, 'web_fetch');
    const unlocked = getUnlockedDeferredTools(ctx);
    expect(unlocked.has('web_fetch')).toBe(true);
  });

  it('is idempotent on repeat unlock', () => {
    unlockDeferredToolForContext(ctx, 'web_fetch');
    unlockDeferredToolForContext(ctx, 'web_fetch');
    expect(getUnlockedDeferredTools(ctx).size).toBe(1);
  });

  it('isolates per context (different ctx → different state)', () => {
    const ctxA = makeContext();
    const ctxB = makeContext();
    unlockDeferredToolForContext(ctxA, 'web_fetch');
    expect(getUnlockedDeferredTools(ctxA).has('web_fetch')).toBe(true);
    expect(getUnlockedDeferredTools(ctxB).has('web_fetch')).toBe(false);
  });
});

describe('FEATURE_189 B.2 — tool_search handler', () => {
  let ctx: KodaXToolExecutionContext;
  beforeEach(() => {
    ctx = makeContext();
    _resetUnlockedDeferredToolsForTest(ctx);
  });

  it('returns a function block for `select:web_fetch`', async () => {
    const out = await toolSearchHandler({ query: 'select:web_fetch' }, ctx);
    expect(out).toContain('<function>');
    expect(out).toContain('"name":"web_fetch"');
    // Full description should include the load-bearing teaching:
    expect(out).toContain('prefer `bash` with the `gh` CLI');
  });

  it('keeps host-forbidden skill scripts undiscoverable through the registry', async () => {
    const capable = { ...makeContext(), skillScriptRunner: { run: async () => 'ran' } };
    for (const denied of [
      { ...capable, excludeTools: ['run_skill_script'] },
      { ...capable, toolVisibilityPolicy: (tool: { name: string }) => tool.name !== 'run_skill_script' },
    ]) {
      const out = await executeTool('tool_search', { query: 'select:run_skill_script' }, denied);
      expect(out).not.toContain('<function>');
      expect(out).not.toContain('run_skill_script');
      expect(getUnlockedDeferredTools(denied).size).toBe(0);
    }
  });

  it('omits host-forbidden registered tools from the no-match directory without unlocking it', async () => {
    const restricted = {
      ...makeContext(),
      excludeTools: ['web_fetch'],
      toolVisibilityPolicy: (tool: { name: string }) => tool.name !== 'module_context',
    };
    const out = await executeTool('tool_search', { query: 'zzz_nonexistent_xyz' }, restricted);
    expect(out).toContain('Available deferred tools');
    expect(out).toContain('web_search');
    expect(out).not.toContain('web_fetch');
    expect(out).not.toContain('module_context');
    expect(getUnlockedDeferredTools(restricted).size).toBe(0);
  });

  it('requires a runner and cwd even when a skill catalog is present, and honors real registry metadata', async () => {
    const runner = { run: async () => 'ran' };
    const catalog = { skillsPrompt: 'Available skills: example', skillRegistry: new SkillRegistry(process.cwd()) };
    const unavailable: KodaXToolExecutionContext[] = [
      { ...makeContext(), ...catalog },
      { backups: new Map(), ...catalog, skillScriptRunner: runner },
    ];
    for (const context of unavailable) {
      const out = await executeTool('tool_search', { query: 'select:run_skill_script' }, context);
      expect(out).not.toContain('<function>');
      expect(getUnlockedDeferredTools(context).size).toBe(0);
    }
    const metadata: KodaXToolVisibilityMeta[] = [];
    const capable = {
      ...makeContext(), skillScriptRunner: runner,
      toolVisibilityPolicy: (tool: KodaXToolVisibilityMeta) => { metadata.push(tool); return true; },
    };
    const out = await executeTool('tool_search', { query: 'select:run_skill_script' }, capable);
    expect(out).toContain('"name":"run_skill_script"');
    expect(out).toContain('<function>');
    expect(metadata).toEqual([{ name: 'run_skill_script', sideEffect: 'mutates-shell', planModeAllowed: false }]);
    expect(getUnlockedDeferredTools(capable).has('run_skill_script')).toBe(true);
  });

  it('keeps exact lookup compatible for the newly resident goal tools', async () => {
    const out = await toolSearchHandler(
      { query: 'select:get_goal,create_goal,update_goal' },
      ctx,
    );

    expect(out.match(/<function>/g)).toHaveLength(3);
    expect(out).toContain('only when explicitly requested');
    expect(out).toContain('3 consecutive turns');
  });

  it('unlocks the requested tool for the context as a side effect', async () => {
    await toolSearchHandler({ query: 'select:module_context' }, ctx);
    expect(getUnlockedDeferredTools(ctx).has('module_context')).toBe(true);
  });

  it('FEATURE_294: select:<hostTool> resolves a run-scoped host tool schema', async () => {
    const out = await toolSearchHandler(
      { query: 'select:space_artifact_create' },
      {
        ...makeContext(),
        extensionRuntime: {
          listRunTools: () => [{
            name: 'space_artifact_create',
            description: 'Create a Space artifact.',
            inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
            capabilityId: 'host:lease-1:space_artifact_create',
            sideEffect: 'mutates-state',
            planModeAllowed: false,
          }],
        },
      },
    );
    expect(out).toContain('<function>');
    expect(out).toContain('"name":"space_artifact_create"');
  });

  it('FEATURE_221: white-labels the kodax_manual description on a select: lookup', async () => {
    // Default: the raw KodaX description (with config paths) is returned.
    const plain = await toolSearchHandler({ query: 'select:kodax_manual' }, makeContext());
    expect(plain).toContain('~/.kodax/config.json');
    expect(plain).toContain('KodaX');
    // Re-branded: no KodaX name / config-path leak via tool_search either.
    const branded = await toolSearchHandler(
      { query: 'select:kodax_manual' },
      { ...makeContext(), selfManual: { productName: 'KodaX-Space' } },
    );
    expect(branded).toContain('KodaX-Space');
    expect(branded).not.toContain('~/.kodax');
    expect(branded).not.toContain('KODAX_');
  });

  it('supports multi-name select with comma separation', async () => {
    const out = await toolSearchHandler({ query: 'select:web_fetch,web_search' }, ctx);
    const blocks = (out.match(/<function>/g) ?? []).length;
    expect(blocks).toBe(2);
    expect(getUnlockedDeferredTools(ctx).has('web_fetch')).toBe(true);
    expect(getUnlockedDeferredTools(ctx).has('web_search')).toBe(true);
  });

  it('returns every explicitly selected schema instead of silently capping the list at 15', async () => {
    const names = Object.keys(DEFERRED_TOOL_HINTS);
    const out = await toolSearchHandler({ query: `select:${names.join(',')}` }, ctx);

    expect(out.match(/<function>/g)).toHaveLength(names.length);
    expect(getUnlockedDeferredTools(ctx).size).toBe(names.length);
  });

  it('keyword search finds matching deferred tools', async () => {
    const out = await toolSearchHandler({ query: 'module exploration', max_results: 3 }, ctx);
    expect(out).toContain('<function>');
    // module_context hint mentions "module" — should be in the top results
    expect(out).toMatch(/"name":"module_context"/);
  });

  it('probes one extra keyword match and returns only max_results with an actionable marker', async () => {
    const out = await toolSearchHandler({ query: 'module', max_results: 1 }, ctx);

    expect(out.match(/<function>/g)).toHaveLength(1);
    expect(out).toContain('RESULT_LIMIT_REACHED');
    expect(out).toContain('select:NAME');
  });

  it('does not add a limit marker when keyword matches exactly fit max_results', async () => {
    const out = await toolSearchHandler({ query: 'pre-indexed', max_results: 1 }, ctx);

    expect(out.match(/<function>/g)).toHaveLength(1);
    expect(out).not.toContain('RESULT_LIMIT_REACHED');
  });

  it('`+keyword` enforces required term', async () => {
    const out = await toolSearchHandler({ query: '+refactor impact', max_results: 5 }, ctx);
    // impact_estimate hint mentions "refactor" and "impact"
    expect(out).toContain('"name":"impact_estimate"');
  });

  it('returns helpful message when query is empty', async () => {
    const out = await toolSearchHandler({ query: '' }, ctx);
    expect(out).toContain('`query` is required');
  });

  it('returns helpful message when nothing matches', async () => {
    const out = await toolSearchHandler({ query: 'zzz_nonexistent_xyz', max_results: 5 }, ctx);
    expect(out).toContain('No tools matched');
    expect(out).toContain('Available deferred tools');
  });

  it('TOOL_SEARCH_DEFINITION has the expected shape', () => {
    expect(TOOL_SEARCH_DEFINITION.name).toBe('tool_search');
    expect(TOOL_SEARCH_DEFINITION.sideEffect).toBe('readonly');
    expect(TOOL_SEARCH_DEFINITION.planModeAllowed).toBe(true);
    expect(TOOL_SEARCH_DEFINITION.description).not.toContain('get_goal / create_goal / update_goal');
    expect(TOOL_SEARCH_DEFINITION.description).not.toContain('mcp_*');
    expect(TOOL_SEARCH_DEFINITION.description).toContain('AMA managed path');
    expect(TOOL_SEARCH_DEFINITION.description).not.toContain('AMAW');
  });
});

describe('FEATURE_189 B.2 — getActiveToolDefinitions deferred description swap', () => {
  const ACTIVE = [
    'read', 'write', 'edit', 'bash', 'grep', 'glob',
    'web_fetch', 'web_search', 'module_context', 'symbol_context',
    'tool_search',
  ];

  it('emits searchHint instead of full description for deferred tools by default', () => {
    const defs = getActiveToolDefinitions(ACTIVE);
    const webFetch = defs.find((d) => d.name === 'web_fetch');
    expect(webFetch).toBeDefined();
    expect(webFetch!.description).toBe(DEFERRED_TOOL_HINTS.web_fetch);
    // Make sure we are NOT emitting the full "prefer gh CLI" content here:
    expect(webFetch!.description).not.toContain('prefer `bash` with the `gh` CLI');
  });

  it('emits full description when the tool is in the unlock set', () => {
    const unlocked = new Set(['web_fetch']);
    const defs = getActiveToolDefinitions(
      ACTIVE,
      undefined,
      false,
      false,
      undefined,
      unlocked,
    );
    const webFetch = defs.find((d) => d.name === 'web_fetch');
    expect(webFetch).toBeDefined();
    expect(webFetch!.description).toContain('prefer `bash` with the `gh` CLI');
  });

  it('leaves non-deferred tools unchanged regardless of unlock set', () => {
    const unlocked = new Set(['read']); // read isn't deferred
    const defs = getActiveToolDefinitions(
      ACTIVE,
      undefined,
      false,
      false,
      undefined,
      unlocked,
    );
    const read = defs.find((d) => d.name === 'read');
    expect(read).toBeDefined();
    // read's real description should be substantial, not a tiny hint
    expect(read!.description.length).toBeGreaterThan(200);
  });

  it('keeps all goal tools resident with their complete lifecycle contracts', () => {
    const goalNames = ['get_goal', 'create_goal', 'update_goal'];
    const defs = getActiveToolDefinitions(goalNames);

    for (const name of goalNames) {
      expect(defs.find((definition) => definition.name === name)?.description)
        .toBe(getToolDefinition(name)?.description);
    }
    expect(defs.find((definition) => definition.name === 'create_goal')?.description)
      .toContain('only when explicitly requested');
    expect(defs.find((definition) => definition.name === 'update_goal')?.description)
      .toContain('3 consecutive turns');
  });

  it('keeps MCP facades directly callable without a tool_search unlock round-trip', () => {
    const defs = getActiveToolDefinitions([
      'mcp_search', 'mcp_describe', 'mcp_call', 'mcp_read_resource', 'mcp_get_prompt',
    ], undefined, false, true);

    expect(defs).toHaveLength(5);
    expect(defs.find((definition) => definition.name === 'mcp_search')?.description)
      .toContain('compact inventory');
    expect(defs.find((definition) => definition.name === 'mcp_call')?.description)
      .toContain('may mutate files');
  });

  it('emits hints simultaneously for multiple un-unlocked deferred tools', () => {
    const defs = getActiveToolDefinitions(ACTIVE);
    const moduleCtx = defs.find((d) => d.name === 'module_context');
    const symbolCtx = defs.find((d) => d.name === 'symbol_context');
    expect(moduleCtx!.description).toBe(DEFERRED_TOOL_HINTS.module_context);
    expect(symbolCtx!.description).toBe(DEFERRED_TOOL_HINTS.symbol_context);
  });

  it('partial unlock — only the unlocked tool gets full description', () => {
    const unlocked = new Set(['module_context']);
    const defs = getActiveToolDefinitions(
      ACTIVE,
      undefined,
      false,
      false,
      undefined,
      unlocked,
    );
    const moduleCtx = defs.find((d) => d.name === 'module_context');
    const symbolCtx = defs.find((d) => d.name === 'symbol_context');
    expect(moduleCtx!.description.length).toBeGreaterThan(300); // full
    expect(symbolCtx!.description).toBe(DEFERRED_TOOL_HINTS.symbol_context); // hint
  });

  it('tool_search itself is not deferred (always full description)', () => {
    const defs = getActiveToolDefinitions(ACTIVE);
    const ts = defs.find((d) => d.name === 'tool_search');
    expect(ts).toBeDefined();
    expect(ts!.description.length).toBeGreaterThan(200);
    expect(ts!.description).toContain('Fetch full schema');
  });
});
