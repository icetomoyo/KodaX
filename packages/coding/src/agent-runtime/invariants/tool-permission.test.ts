/**
 * FEATURE_101 — `toolPermission` invariant unit tests.
 *
 * Covers the tier mapping, the system-cap intersection, and the
 * removeTools clamp shape.
 */

import { describe, expect, it } from 'vitest';

import { createAgent } from '@kodax/core';
import type { Agent, AdmissionCtx, AgentManifest, SystemCap, ToolCapability } from '@kodax/core';

import { resolveToolCapability, toolPermission } from './tool-permission.js';

type ToolEntry = NonNullable<Agent['tools']>[number];

function ctx(manifest: AgentManifest, allowed: readonly ToolCapability[]): AdmissionCtx {
  return {
    manifest,
    activatedAgents: new Map(),
    stagedAgents: new Map(),
    systemCap: { maxBudget: 200, maxIterations: 200, allowedToolCapabilities: allowed },
  };
}

function tool(name: string): ToolEntry {
  return { name, description: '', inputSchema: { type: 'object' } } as unknown as ToolEntry;
}

describe('resolveToolCapability', () => {
  it('maps read-only tools to "read"', () => {
    expect(resolveToolCapability('read')).toBe('read');
    expect(resolveToolCapability('grep')).toBe('read');
    expect(resolveToolCapability('glob')).toBe('read');
    expect(resolveToolCapability('code_search')).toBe('read');
    expect(resolveToolCapability('semantic_lookup')).toBe('read');
  });

  it('maps repo-intelligence tools to "read" (no FS mutation)', () => {
    expect(resolveToolCapability('repo_overview')).toBe('read');
    expect(resolveToolCapability('changed_scope')).toBe('read');
    expect(resolveToolCapability('changed_diff')).toBe('read');
    expect(resolveToolCapability('changed_diff_bundle')).toBe('read');
    expect(resolveToolCapability('module_context')).toBe('read');
    expect(resolveToolCapability('symbol_context')).toBe('read');
    expect(resolveToolCapability('process_context')).toBe('read');
    expect(resolveToolCapability('impact_estimate')).toBe('read');
  });

  it('maps interaction-only tools to "read" (no side effect on workspace)', () => {
    expect(resolveToolCapability('ask_user_question')).toBe('read');
    expect(resolveToolCapability('exit_plan_mode')).toBe('read');
  });

  it('maps mutation tools to "edit"', () => {
    expect(resolveToolCapability('write')).toBe('edit');
    expect(resolveToolCapability('edit')).toBe('edit');
    expect(resolveToolCapability('multi_edit')).toBe('edit');
    expect(resolveToolCapability('insert_after_anchor')).toBe('edit');
    expect(resolveToolCapability('undo')).toBe('edit');
  });

  it('maps construction-staircase + worktree tools to "subagent"', () => {
    expect(resolveToolCapability('scaffold_tool')).toBe('subagent');
    expect(resolveToolCapability('validate_tool')).toBe('subagent');
    expect(resolveToolCapability('stage_construction')).toBe('subagent');
    expect(resolveToolCapability('test_tool')).toBe('subagent');
    expect(resolveToolCapability('activate_tool')).toBe('subagent');
    expect(resolveToolCapability('worktree_create')).toBe('subagent');
    expect(resolveToolCapability('worktree_remove')).toBe('subagent');
  });

  it('maps bash to "bash:mutating"', () => {
    expect(resolveToolCapability('bash')).toBe('bash:mutating');
  });

  it('maps network/MCP tools to "bash:network"', () => {
    expect(resolveToolCapability('web_search')).toBe('bash:network');
    expect(resolveToolCapability('web_fetch')).toBe('bash:network');
    expect(resolveToolCapability('mcp_call')).toBe('bash:network');
  });

  it('maps subagent dispatch tools to "subagent"', () => {
    expect(resolveToolCapability('dispatch_child_task')).toBe('subagent');
    expect(resolveToolCapability('emit_managed_protocol')).toBe('subagent');
  });

  it('maps unknown tools to "subagent" (strictest default)', () => {
    expect(resolveToolCapability('mystery_tool')).toBe('subagent');
    expect(resolveToolCapability('')).toBe('subagent');
  });
});

describe('toolPermission.admit', () => {
  it('admits manifest without tools', () => {
    const m: AgentManifest = createAgent({ name: 'a', instructions: 'b' });
    expect(toolPermission.admit!(m, ctx(m, ['read', 'edit'])).ok).toBe(true);
  });

  it('admits manifest where every tool is in the allowed set', () => {
    const m: AgentManifest = createAgent({
      name: 'reader',
      instructions: 'r',
      tools: [tool('read'), tool('grep'), tool('glob')],
    });
    expect(toolPermission.admit!(m, ctx(m, ['read'])).ok).toBe(true);
  });

  it('clamps tools whose capability is disallowed', () => {
    const m: AgentManifest = createAgent({
      name: 'mixed',
      instructions: 'm',
      tools: [tool('read'), tool('write'), tool('bash')],
    });
    const result = toolPermission.admit!(m, ctx(m, ['read']));
    expect(result.ok).toBe(false);
    if (!result.ok && result.severity === 'clamp') {
      expect(result.patch.removeTools).toEqual(expect.arrayContaining(['write', 'bash']));
      expect(result.patch.removeTools).not.toContain('read');
      expect(result.reason).toContain('write=edit');
      expect(result.reason).toContain('bash=bash:mutating');
    } else {
      throw new Error('expected clamp severity');
    }
  });

  it('clamps unknown tools when "subagent" capability is not allowed', () => {
    const m: AgentManifest = createAgent({
      name: 'with-unknown',
      instructions: 'u',
      tools: [tool('mystery_tool')],
    });
    const result = toolPermission.admit!(m, ctx(m, ['read', 'edit']));
    expect(result.ok).toBe(false);
    if (!result.ok && result.severity === 'clamp') {
      expect(result.patch.removeTools).toEqual(['mystery_tool']);
    }
  });

  it('admits unknown tools when "subagent" is in the allowed set', () => {
    const m: AgentManifest = createAgent({
      name: 'with-unknown',
      instructions: 'u',
      tools: [tool('mystery_tool')],
    });
    expect(
      toolPermission.admit!(m, ctx(m, ['subagent'])).ok,
    ).toBe(true);
  });
});
