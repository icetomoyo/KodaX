/**
 * Coding Agent internal tools for runtime AGENT construction
 * (FEATURE_089, v0.7.31). Mirrors the FEATURE_088 tool-construction
 * staircase but produces Agent manifests instead of Tool definitions.
 *
 * Five tools form the agent generation staircase:
 *
 *   scaffold_agent           → emit a fillable AgentArtifact skeleton.
 *   validate_agent           → dry-run admission audit (Runner.admit) on
 *                              a candidate JSON; no disk write.
 *   stage_agent_construction → persist the manifest under
 *                              .kodax/constructed/agents/.
 *   test_agent               → run the agent test pipeline (manifest
 *                              shape + Runner.admit + sandbox-runner
 *                              case execution).
 *   activate_agent           → invoke policy gate, activate, and
 *                              register in the resolver so Runner.run
 *                              can find the agent by name.
 *
 * Notes:
 *   - All five operate on `.kodax/constructed/agents/<name>/<version>.json`.
 *     Network-free.
 *   - Scaffolding emits a minimal but valid skeleton — the smallest
 *     manifest that passes admission today is `{ instructions: '...' }`.
 *     The LLM iterates from this baseline.
 *   - Gating: the agent-layer `filterAgentConstructionToolNames` honours
 *     the same prompt-mode toggle as tool-construction; off by default.
 */

import type { KodaXToolExecutionContext } from '../types.js';
import { Runner, listRegisteredInvariants } from '@kodax/core';

import {
  type AgentArtifact,
  type AgentContent,
  type StagedHandle,
  type TestResult,
  stage as stageArtifact,
  testArtifact,
  activate as activateArtifact,
  listArtifacts,
  readArtifact,
} from '../construction/index.js';
import { buildAdmissionManifest } from '../construction/admission-bridge.js';
import { readOptionalString } from './internal.js';

/**
 * Names of the five agent-construction-staircase tools. Single source
 * of truth used by both the registry definitions and the agent-layer
 * gating below.
 */
export const AGENT_CONSTRUCTION_TOOL_NAMES = [
  'scaffold_agent',
  'validate_agent',
  'stage_agent_construction',
  'test_agent',
  'activate_agent',
] as const;

const AGENT_CONSTRUCTION_TOOL_NAME_SET = new Set<string>(AGENT_CONSTRUCTION_TOOL_NAMES);

export function isAgentConstructionToolName(name: string): boolean {
  return AGENT_CONSTRUCTION_TOOL_NAME_SET.has(name);
}

/**
 * Filter agent-construction tools out of an active-tool-name list when
 * agent-construction mode is OFF. Mirrors `filterConstructionToolNames`.
 */
export function filterAgentConstructionToolNames<T extends string>(
  toolNames: readonly T[],
  agentConstructionMode: boolean | undefined,
): T[] {
  if (agentConstructionMode) return [...toolNames];
  return toolNames.filter((name) => !isAgentConstructionToolName(name));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRequiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`'${key}' is required and must be a non-empty string.`);
  }
  return value.trim();
}

function parseArtifactJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`artifact_json failed to parse as JSON: ${(err as Error).message}`);
  }
}

/**
 * Shape-narrow an unknown into an AgentArtifact, throwing with a
 * pointed message on the first missing/wrong field. Cheap up-front
 * check before delegating to the runtime.
 */
function asAgentArtifact(value: unknown): AgentArtifact {
  if (!value || typeof value !== 'object') {
    throw new Error('artifact must be a JSON object.');
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind !== 'agent') {
    throw new Error(`artifact.kind must be 'agent' (got ${JSON.stringify(obj.kind)}).`);
  }
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    throw new Error('artifact.name must be a non-empty string.');
  }
  if (typeof obj.version !== 'string' || obj.version.trim() === '') {
    throw new Error('artifact.version must be a non-empty string (semver recommended).');
  }
  if (!obj.content || typeof obj.content !== 'object') {
    throw new Error('artifact.content must be an object.');
  }
  const content = obj.content as Record<string, unknown>;
  if (typeof content.instructions !== 'string' || content.instructions.trim().length === 0) {
    throw new Error('artifact.content.instructions must be a non-empty string.');
  }
  return value as AgentArtifact;
}

function renderTestResult(result: TestResult): string {
  const lines: string[] = [];
  lines.push(`ok=${result.ok ? 'true' : 'false'}`);
  if (result.errors && result.errors.length > 0) {
    lines.push('errors:');
    for (const err of result.errors) lines.push(`  - ${err}`);
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push('warnings:');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 1. scaffold_agent
// ---------------------------------------------------------------------------

export async function toolScaffoldAgent(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const name = readRequiredString(input, 'name');
    const version = readOptionalString(input, 'version') ?? '0.1.0';
    const description =
      readOptionalString(input, 'description')
      ?? 'TODO: short summary of what this agent does and when to invoke it.';

    const skeleton: AgentArtifact = {
      kind: 'agent',
      name,
      version,
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions: `${description}\n\nTODO: replace with the agent's full operating instructions.`,
        tools: [],
        reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: false },
      },
    };

    return [
      'Scaffolded agent manifest (fill TODO sections, then call validate_agent):',
      '',
      'Manifest schema notes:',
      '  - instructions: string (required) — the agent\'s system-prompt body.',
      '  - tools: ToolRef[] — refs like { ref: "builtin:read" } or { ref: "constructed:foo@1.0.0" }.',
      '  - handoffs: AgentHandoffRef[] — { target: { ref }, kind: "continuation"|"as-tool" }.',
      '  - reasoning: { default, max?, escalateOnRevise? } — same shape as Layer A AgentReasoningProfile.',
      '  - guardrails: GuardrailRef[] — { kind: "input"|"output"|"tool", ref }.',
      '  - maxBudget: number — clamped against systemCap.maxBudget at admission.',
      '  - declaredInvariants: string[] — voluntary invariants (e.g. ["harnessSelectionTiming"]).',
      '  - testCases: AgentTestCase[] — { id, input, expectMatch?|expectNotMatch?|expectFinalText? }.',
      '',
      JSON.stringify(skeleton, null, 2),
    ].join('\n');
  } catch (err) {
    return `[Tool Error] scaffold_agent: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// 2. validate_agent
// ---------------------------------------------------------------------------

export async function toolValidateAgent(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const raw = readRequiredString(input, 'artifact_json');
    let artifact: AgentArtifact;
    try {
      artifact = asAgentArtifact(parseArtifactJson(raw));
    } catch (err) {
      return `[Tool Error] validate_agent: ${(err as Error).message}`;
    }

    // Phase 3.6 review fix — empty-registry guard. If no invariants
    // are registered, Runner.admit silently returns ok=true with an
    // empty bindings list, giving a false assurance. The REPL bootstrap
    // calls registerCodingInvariants() at startup; non-REPL surfaces
    // need to call it explicitly. Surface that as a clear error so
    // the LLM doesn't waste tokens on a vacuous validation.
    if (listRegisteredInvariants().length === 0) {
      return [
        '[Tool Error] validate_agent: invariant registry is empty.',
        'Call registerCodingInvariants() (from @kodax/coding) before invoking validate_agent —',
        'the REPL surface bootstraps this at startup; non-REPL contexts must register explicitly.',
      ].join(' ');
    }

    // Dry-run admission against the candidate manifest. No disk write.
    const manifest = buildAdmissionManifest({ name: artifact.name, content: artifact.content });
    const verdict = await Runner.admit(manifest);

    const errors: string[] = [];
    const warnings: string[] = [];
    if (!verdict.ok) {
      errors.push(`[admission] ${verdict.reason} (retryable=${verdict.retryable})`);
    } else {
      for (const note of verdict.clampNotes) {
        warnings.push(`[admission] ${note}`);
      }
    }

    return renderTestResult({
      ok: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    return `[Tool Error] validate_agent: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// 3. stage_agent_construction
// ---------------------------------------------------------------------------

export async function toolStageAgentConstruction(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const raw = readRequiredString(input, 'artifact_json');
    const artifact = asAgentArtifact(parseArtifactJson(raw));

    // FEATURE_090 (v0.7.32) — self-modify-in-disguise guard. An agent
    // could otherwise bump its own version through the FEATURE_089
    // stage_agent_construction path and bypass FEATURE_090's hard
    // checks (guardrail ratchet / budget / force ask-user). Refuse
    // to stage when the manifest's name collides with a still-active
    // agent — the LLM must explicitly call stage_self_modify to
    // travel the self-modify lifecycle.
    const activeCollision = (await listArtifacts('agent')).find(
      (a) => a.kind === 'agent' && a.name === artifact.name && a.status === 'active',
    );
    if (activeCollision) {
      return [
        `[Tool Error] stage_agent_construction:`,
        `'${artifact.name}' already has an active manifest (${activeCollision.version}).`,
        `Modifying an existing constructed agent must go through stage_self_modify so the FEATURE_090 hard checks (guardrail ratchet, budget, force-ask-user) apply.`,
        `Pick a different name to create a separate agent.`,
      ].join(' ');
    }

    const handle = await stageArtifact(artifact);
    return [
      `staged: ${handle.artifact.name}@${handle.artifact.version} (kind=agent)`,
      `status=${handle.artifact.status}`,
      'Next: call test_agent with name and version.',
    ].join('\n');
  } catch (err) {
    return `[Tool Error] stage_agent_construction: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// 4. test_agent
// ---------------------------------------------------------------------------

export async function toolTestAgent(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const name = readRequiredString(input, 'name');
    const version = readRequiredString(input, 'version');
    const artifact = await readArtifact(name, version);
    if (!artifact) {
      return `[Tool Error] test_agent: no staged artifact found for ${name}@${version}.`;
    }
    if (artifact.kind !== 'agent') {
      return `[Tool Error] test_agent: ${name}@${version} has kind='${artifact.kind}', expected 'agent'. Use test_tool for tool artifacts.`;
    }
    if (artifact.status === 'revoked') {
      return `[Tool Error] test_agent: ${name}@${version} is revoked. Bump the version and re-stage.`;
    }
    const handle: StagedHandle = { artifact, stagedAt: Date.now() };
    const result = await testArtifact(handle);
    return renderTestResult(result);
  } catch (err) {
    return `[Tool Error] test_agent: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// 5. activate_agent
// ---------------------------------------------------------------------------

export async function toolActivateAgent(
  input: Record<string, unknown>,
  _ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    const name = readRequiredString(input, 'name');
    const version = readRequiredString(input, 'version');
    const artifact = await readArtifact(name, version);
    if (!artifact) {
      return `[Tool Error] activate_agent: no artifact found for ${name}@${version}. Stage and test it first.`;
    }
    if (artifact.kind !== 'agent') {
      return `[Tool Error] activate_agent: ${name}@${version} has kind='${artifact.kind}', expected 'agent'. Use activate_tool for tool artifacts.`;
    }
    if (artifact.status === 'revoked') {
      return `[Tool Error] activate_agent: ${name}@${version} is revoked. Bump the version and re-stage.`;
    }
    const handle: StagedHandle = { artifact, stagedAt: Date.now() };
    await activateArtifact(handle);
    return [
      `activated: ${name}@${version} (kind=agent)`,
      'Resolver now exposes the agent at this name; subsequent Runner.run calls can resolve it.',
    ].join('\n');
  } catch (err) {
    return `[Tool Error] activate_agent: ${(err as Error).message}`;
  }
}

/** Convenience export — used by the registry to thread the named tool dispatchers. */
export const AGENT_CONSTRUCTION_TOOLS = {
  scaffold_agent: toolScaffoldAgent,
  validate_agent: toolValidateAgent,
  stage_agent_construction: toolStageAgentConstruction,
  test_agent: toolTestAgent,
  activate_agent: toolActivateAgent,
} as const;

/**
 * Type-level check for `AgentContent` — exported so external schema
 * tooling (e.g. doc generators) can constrain inputs they round-trip
 * through these tools.
 */
export type AgentManifestContent = AgentContent;
