/**
 * AMA-role tool exclude sets — exclude-based wiring contract.
 *
 * Each AMA role exposes "all registered tools minus its effective
 * exclude set". This module centralises the per-role exclude sets and
 * the two query helpers (`getAmaRoleEffectiveExclude`,
 * `getAmaRoleExpectedToolNames`) consumed by the agent-chain builder
 * (R3) and the FEATURE_168 contract tests.
 *
 * Extracted from `task-engine/runner-driven.ts` (lines 2095–2204 in
 * the pre-FEATURE_171 monolith) as part of FEATURE_171 (v0.7.41)
 * modular split. Zero behavior change — sets and helper bodies are
 * byte-identical to the previous in-file declarations.
 *
 * Why exclude-based: prior include-based wiring (each role's tools array
 * manually push'd) silently dropped 17 registered tools across multiple
 * features — FEATURE_120 collaboration controls, FEATURE_161 (4 of
 * 8 repo-intel pull tools the Worker prompt teaches), and the four web
 * tools (web_search / web_fetch / code_search / semantic_lookup). The
 * AMA path is shielded from SA-path defaults so wiring drift went
 * undetected by every test layer (handler unit tests pass, prompt
 * teaches the tool, registry registers it, CHILD_EXCLUDE excludes the
 * non-existent child copy — no test asserted "agent.tools actually
 * contains a schema with this name"). Defaulting to "all registered
 * tools available unless excluded" makes that drift architecturally
 * impossible: new tools land in every AMA role automatically, and
 * security-sensitive omissions become explicit (one new EXCLUDE entry
 * rather than five missing push lines).
 */

import { filterMcpToolNames, listToolDefinitions } from '../../../tools/registry.js';
import { isSessionHistoryTool } from '../../../tools/session-history.js';
import type { AmaRole } from './types.js';

/** Tools every AMA role excludes — specialized paths (SA-root, construction). */
const AMA_BASELINE_EXCLUDE: ReadonlySet<string> = new Set([
  // FEATURE_193 (v0.7.43) deep V1 cleanup: `emit_managed_protocol` was the
  // SA-preset entry point for the V1 chain; with the chain retired and the
  // tool itself deleted from the registry, no exclude entry is needed.
  // Construction / agent-construction / self-modify — activated only when
  // `toolConstructionMode=true` (see `agent-runtime/tool-resolution.ts:81`).
  // AMA roles never run in construction mode.
  'scaffold_tool',
  'validate_tool',
  'stage_construction',
  'test_tool',
  'activate_tool',
  'scaffold_agent',
  'validate_agent',
  'stage_agent_construction',
  'test_agent',
  'activate_agent',
  'stage_self_modify',
]);

// FEATURE_193 (v0.7.43): SCOUT_EXTRA_EXCLUDE, PLANNER_EXTRA_EXCLUDE,
// GENERATOR_EXTRA_EXCLUDE deleted (V1 chain roles retired) — AmaRole
// narrowed to a single 'worker' member, so ROLE_EXTRA_EXCLUDE collapses
// to a single-entry record.
// FEATURE_184 (v0.7.45) Phase C.1: EVALUATOR_EXTRA_EXCLUDE already deleted.

/** Worker (V2 single-loop primary agent): collapses Scout+Generator, full surface. */
const WORKER_EXTRA_EXCLUDE: ReadonlySet<string> = new Set<string>();

const ROLE_EXTRA_EXCLUDE: Record<AmaRole, ReadonlySet<string>> = {
  worker: WORKER_EXTRA_EXCLUDE,
};

/**
 * The effective exclude set for an AMA role — baseline ∪ role-specific.
 * Exported for contract tests in `runner-driven-tool-wiring.test.ts`.
 */
export function getAmaRoleEffectiveExclude(role: AmaRole): ReadonlySet<string> {
  return new Set([...AMA_BASELINE_EXCLUDE, ...ROLE_EXTRA_EXCLUDE[role]]);
}

/**
 * The names of all registry-borne tools an AMA role can see, computed by
 * subtracting the role's effective exclude set from `listToolDefinitions()`.
 *
 * Exported for the FEATURE_168 contract test that pins each role's
 * expected tool surface. MCP tools are runtime-backed, so callers pass
 * whether a capability runtime is actually bound for the run.
 */
export function getAmaRoleExpectedToolNames(
  role: AmaRole,
  hasCapabilityRuntime = true,
  hasSessionHistory = false,
): readonly string[] {
  const exclude = getAmaRoleEffectiveExclude(role);
  const names = listToolDefinitions()
    .map((def) => def.name)
    .filter((name) => !exclude.has(name))
    .filter((name) => hasSessionHistory || !isSessionHistoryTool(name));
  return (hasCapabilityRuntime ? names : filterMcpToolNames(names)).sort();
}
