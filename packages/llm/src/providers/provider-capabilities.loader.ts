/**
 * FEATURE_198 v0.7.44 — Provider capability JSON loader.
 *
 * Resolves `provider-capabilities.json` at runtime into the in-memory
 * `ProviderSnapshot` shape that `KODAX_PROVIDER_SNAPSHOTS` callers
 * expect. Owns three concerns:
 *
 *   1. **Lazy load** — parse + validate exactly once per process,
 *      cache the result. `_resetProviderSnapshotsCache` for tests.
 *
 *   2. **Profile-name resolution** — JSON stores `"image-input-native"`
 *      etc., loader maps to the actual `KodaXProviderCapabilityProfile`
 *      object exported from `capability-profile.ts`. Profiles stay
 *      external rather than inlined in JSON to avoid duplicating the
 *      shape across two files.
 *
 *   3. **CLI-bridge fill** — `gemini-cli` and `codex-cli` static fields
 *      live in JSON, but their `model` + `models` are owned by the
 *      local CLI binary and read via `cli-bridge-models.ts`. The
 *      loader fills them in at load time so consumers see a uniform
 *      shape with no special-case branches.
 *
 * **Bundle contract**: this module reads the JSON via `fs.readFileSync`
 * at runtime (not `import ... from './*.json'`). Combined with esbuild
 * `--external:*.json` (see `scripts/build-bundle.mjs`), the JSON ships
 * as a sibling of `dist/index.js` and can be patched in-place without
 * rebuilding the bundle — that's the "hot-update" path F198 enables.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';
import {
  getCodexCliDefaultModel,
  getCodexCliKnownModels,
  getGeminiCliDefaultModel,
  getGeminiCliKnownModels,
} from './cli-bridge-models.js';
import type {
  CapabilityProfileName,
  ProviderCapabilityJsonEntry,
  ProviderSnapshot,
} from './provider-capabilities.types.js';
import { validateProviderCapabilitiesJson } from './provider-capabilities.types.js';
import type { KodaXProviderCapabilityProfile, KodaXReasoningProfile } from '../types.js';

const PROFILE_BY_NAME: Readonly<
  Record<CapabilityProfileName, KodaXProviderCapabilityProfile>
> = Object.freeze({
  'native': NATIVE_PROVIDER_CAPABILITY_PROFILE,
  'image-input-native': IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
  'cli-bridge': CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  'image-input-cli-bridge': IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
});

let cachedSnapshots: Readonly<Record<string, ProviderSnapshot>> | null = null;

/**
 * Resolve the JSON file path across four distribution modes:
 *
 *  1. **Dev / npm** (tsc-compiled, `node dist/...`) — loader at
 *     `packages/llm/dist/providers/loader.js` reads from
 *     `packages/llm/dist/providers/provider-capabilities.json`
 *     (copied by the package's `build` script).
 *
 *  2. **SDK bundle root entry** (e.g. `dist/kodax_cli.js`, the
 *     non-chunked CLI bundle) — loader inlined into `dist/index.js`;
 *     reads `dist/provider-capabilities.json` (copied by
 *     `build-bundle.mjs`).
 *
 *  3. **SDK bundle chunk** (e.g. `dist/chunks/sdk-llm-XXX.js`) — esbuild
 *     `splitting: true` moves shared code into `dist/chunks/`; the
 *     loader's `import.meta.url` resolves there, so the JSON is one
 *     directory up. We probe `__dirname` first, then `dirname(__dirname)`.
 *
 *  4. **Bun --compile binary** — JSON sidecar next to the executable
 *     (same pattern `resolveBuiltinPath()` uses for builtin/ assets).
 *     `KODAX_BUNDLED='true'` is set by `scripts/build-binary.mjs`.
 *
 * Modes 1+2+3 all resolve via `import.meta.url` walking up; Mode 4
 * uses `process.execPath`. The fallback chain costs at most two extra
 * `existsSync` calls at process start (then the result is cached).
 */
function resolveJsonPath(): string {
  if (process.env.KODAX_BUNDLED === 'true') {
    return path.join(path.dirname(process.execPath), 'provider-capabilities.json');
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'provider-capabilities.json'),       // dev/npm + bundle root
    path.join(path.dirname(here), 'provider-capabilities.json'), // bundle chunk (dist/chunks/ → dist/)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Return the first candidate so the downstream readFileSync error
  // names the most likely path the user would expect to populate.
  return candidates[0];
}

function freezeConstraints(value: Pick<ProviderSnapshot, 'toolCapabilities' | 'cacheCapabilities'>): void {
  if (value.toolCapabilities?.grammar) Object.freeze(value.toolCapabilities.grammar);
  if (value.toolCapabilities) Object.freeze(value.toolCapabilities);
  if (value.cacheCapabilities?.locations) Object.freeze(value.cacheCapabilities.locations);
  if (value.cacheCapabilities) Object.freeze(value.cacheCapabilities);
}
function deepFreezeSnapshot(snapshot: ProviderSnapshot): ProviderSnapshot {
  freezeConstraints(snapshot);
  if (snapshot.models) {
    for (const m of snapshot.models) {
      if (m.reasoningProfile) {
        freezeReasoningProfile(m.reasoningProfile);
      }
    }
    for (const m of snapshot.models) { freezeConstraints(m); Object.freeze(m); }
    Object.freeze(snapshot.models);
  }
  if (snapshot.reasoningProfile) {
    freezeReasoningProfile(snapshot.reasoningProfile);
  }
  if (snapshot.modelReasoningCapabilities) {
    Object.freeze(snapshot.modelReasoningCapabilities);
  }
  return Object.freeze(snapshot);
}

function freezeReasoningProfile(
  capability: KodaXReasoningProfile,
): void {
  if (capability.supportedEfforts) {
    for (const preset of capability.supportedEfforts) Object.freeze(preset);
    Object.freeze(capability.supportedEfforts);
  }
  if (capability.budgetByEffort) {
    Object.freeze(capability.budgetByEffort);
  }
  if (capability.effortAliases) {
    Object.freeze(capability.effortAliases);
  }
  if (capability.disabledEfforts) {
    Object.freeze(capability.disabledEfforts);
  }
  if (capability.localRejectEfforts) {
    Object.freeze(capability.localRejectEfforts);
  }
  Object.freeze(capability);
}

function resolveCliBridgeModels(name: string): {
  model: string;
  models: ReadonlyArray<{ readonly id: string }>;
} {
  if (name === 'gemini-cli') {
    const def = getGeminiCliDefaultModel();
    return {
      model: def,
      models: getGeminiCliKnownModels()
        .filter((m) => m !== def)
        .map((id) => ({ id })),
    };
  }
  if (name === 'codex-cli') {
    const def = getCodexCliDefaultModel();
    return {
      model: def,
      models: getCodexCliKnownModels()
        .filter((m) => m !== def)
        .map((id) => ({ id })),
    };
  }
  throw new Error(
    `provider-capabilities loader: unknown cliBridge provider '${name}'`,
  );
}

function buildSnapshot(
  name: string,
  entry: ProviderCapabilityJsonEntry,
): ProviderSnapshot {
  const capabilityProfile = PROFILE_BY_NAME[entry.capabilityProfile];
  if (!capabilityProfile) {
    throw new Error(
      `provider-capabilities loader: unknown capabilityProfile '${entry.capabilityProfile}' for provider '${name}'`,
    );
  }

  // Static model presence was checked by the validator; bridges discover theirs locally.
  const snapshot: ProviderSnapshot = {
    ...(entry.cliBridge ? resolveCliBridgeModels(name) : { model: entry.model as string }),
    apiKeyEnv: entry.apiKeyEnv,
    reasoningCapability: entry.reasoningCapability,
    capabilityProfile,
    verifyStrategy: entry.verifyStrategy,
  };
  for (const field of ['reasoningProfile', 'supportsThinking', 'toolCapabilities', 'cacheCapabilities'] as const) {
    if (entry[field] !== undefined) Object.assign(snapshot, { [field]: entry[field] });
  }
  if (!entry.cliBridge) {
    for (const field of ['models', 'modelReasoningCapabilities', 'contextWindow', 'maxOutputTokens',
      'outputTokenLimit', 'maxOutputTokensField', 'thinkingBudgetCap'] as const) {
      if (entry[field] !== undefined) Object.assign(snapshot, { [field]: entry[field] });
    }
  }
  return snapshot;
}

/**
 * Read, validate, and resolve `provider-capabilities.json` into the
 * runtime snapshot map. Cached after the first call; subsequent calls
 * return the same frozen object identity.
 *
 * Throws with a path-qualified error message when the JSON is missing,
 * malformed, or references an unknown profile name. Callers SHOULD NOT
 * try/catch this — a broken capability file is unrecoverable and the
 * loud failure surfaces the misconfiguration immediately.
 */
export function getProviderSnapshots(): Readonly<
  Record<string, ProviderSnapshot>
> {
  if (cachedSnapshots) return cachedSnapshots;
  const jsonPath = resolveJsonPath();
  let raw: unknown;
  try {
    const text = readFileSync(jsonPath, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `provider-capabilities loader: failed to read ${jsonPath}: ${reason}`,
    );
  }
  const parsed = validateProviderCapabilitiesJson(raw);
  const out: Record<string, ProviderSnapshot> = {};
  for (const [name, entry] of Object.entries(parsed.providers)) {
    out[name] = deepFreezeSnapshot(buildSnapshot(name, entry));
  }
  cachedSnapshots = Object.freeze(out);
  return cachedSnapshots;
}

/**
 * Test-only hook. Clears the cached snapshot map so callers can patch
 * the JSON file on disk and re-load. Production code path never touches
 * this — the cache is process-lifetime by design.
 */
export function _resetProviderSnapshotsCache(): void {
  cachedSnapshots = null;
}
