/**
 * Auto-Mode Rules Loader — FEATURE_092 Phase 2b.2 (v0.7.33).
 *
 * Three-layer trust model for `auto-rules.jsonc` files consumed by the
 * auto-mode classifier:
 *
 *   1. ~/.kodax/auto-rules.jsonc                  — user-level, always trusted
 *   2. <project>/.kodax/auto-rules.jsonc          — shared, opt-in (sha256 fingerprint)
 *   3. <project>/.kodax/auto-rules.local.jsonc    — workspace-local, gitignored, trusted
 *
 * Why opt-in for the shared file: a malicious PR could land an
 * `auto-rules.jsonc` claiming "allow any curl" and the user wouldn't
 * notice. First-checkout opt-in via fingerprint forces the user to
 * acknowledge the file by content. If the fingerprint changes later,
 * the file is silently skipped until re-trusted — failures favor safety.
 *
 * Schema (each field optional, defaults to []):
 *   {
 *     "allow":       string[],   // patterns the classifier defaults to allowing
 *     "soft_deny":   string[],   // patterns the classifier defaults to blocking
 *     "environment": string[]    // background context the classifier sees verbatim
 *   }
 *
 * Merge: layers concatenated in order (user → project → local). Identical
 * strings deduplicated by stable insertion (later layers win position only
 * when the string is unique per layer).
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AutoRules {
  readonly allow: readonly string[];
  readonly soft_deny: readonly string[];
  readonly environment: readonly string[];
}

export type RulesOrigin = 'user' | 'project' | 'local';

export interface LoadedRulesSource {
  readonly origin: RulesOrigin;
  readonly path: string;
  readonly fingerprint: string;
}

export interface SkippedRulesSource {
  readonly origin: 'project';
  readonly path: string;
  readonly fingerprint: string;
  readonly reason: 'untrusted' | 'fingerprint-changed';
}

export interface RulesLoadError {
  readonly path: string;
  readonly message: string;
}

export interface RulesLoadResult {
  readonly merged: AutoRules;
  readonly sources: readonly LoadedRulesSource[];
  readonly skipped: readonly SkippedRulesSource[];
  readonly errors: readonly RulesLoadError[];
}

export interface LoadAutoRulesOptions {
  readonly userKodaxDir: string;
  readonly projectRoot: string;
}

export interface TrustState {
  readonly trusted: Readonly<Record<string, string>>;
}

const TRUST_FILE_NAME = 'trusted-project-rules.json';
const RULES_FILE_NAME = 'auto-rules.jsonc';
const LOCAL_RULES_FILE_NAME = 'auto-rules.local.jsonc';

const EMPTY_RULES: AutoRules = { allow: [], soft_deny: [], environment: [] };

// =============== Fingerprint ===============

export function computeRulesFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// =============== Trust state I/O ===============

export async function readTrustState(userKodaxDir: string): Promise<TrustState> {
  const path = join(userKodaxDir, TRUST_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return { trusted: {} };
  }
  try {
    const parsed = JSON.parse(raw) as { trusted?: unknown };
    if (parsed && typeof parsed === 'object' && parsed.trusted && typeof parsed.trusted === 'object') {
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.trusted as Record<string, unknown>)) {
        if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) {
          cleaned[k] = v;
        }
      }
      return { trusted: cleaned };
    }
  } catch {
    // fall through to fail-safe empty state
  }
  return { trusted: {} };
}

export interface TrustOptions {
  readonly userKodaxDir: string;
}

export async function trustProjectRules(
  rulesPath: string,
  fingerprint: string,
  opts: TrustOptions,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`trustProjectRules: invalid fingerprint format (expected 64-char hex sha256)`);
  }
  await mkdir(opts.userKodaxDir, { recursive: true });
  const current = await readTrustState(opts.userKodaxDir);
  const next: TrustState = {
    trusted: { ...current.trusted, [rulesPath]: fingerprint },
  };
  const trustFilePath = join(opts.userKodaxDir, TRUST_FILE_NAME);
  await writeFile(trustFilePath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

// =============== JSONC parser (minimal, no extra dependency) ===============

/**
 * Strip JS-style line and block comments from a source string while
 * preserving content inside string literals. Sufficient for user-edited
 * config files; not a full JSONC spec implementation (no trailing-comma
 * tolerance, since `JSON.parse` would still reject those).
 */
function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringQuote = '';
  let escape = false;

  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      // Skip until newline
      i += 2;
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      // Skip until '*/'
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

export type ParseAutoRulesResult =
  | { readonly ok: true; readonly rules: AutoRules }
  | { readonly ok: false; readonly error: string };

export function parseAutoRules(src: string): ParseAutoRulesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(src));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'auto-rules root must be an object' };
  }
  const obj = parsed as Record<string, unknown>;
  const fields: Array<keyof AutoRules> = ['allow', 'soft_deny', 'environment'];
  const rules: { allow: string[]; soft_deny: string[]; environment: string[] } = {
    allow: [],
    soft_deny: [],
    environment: [],
  };
  for (const field of fields) {
    const raw = obj[field];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      return { ok: false, error: `auto-rules.${field} must be an array of strings` };
    }
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        return { ok: false, error: `auto-rules.${field} entries must be strings` };
      }
      rules[field].push(entry);
    }
  }
  return { ok: true, rules };
}

// =============== Loader ===============

async function tryReadRulesFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

export async function loadAutoRules(opts: LoadAutoRulesOptions): Promise<RulesLoadResult> {
  const sources: LoadedRulesSource[] = [];
  const skipped: SkippedRulesSource[] = [];
  const errors: RulesLoadError[] = [];
  const collected: AutoRules[] = [];

  const userPath = join(opts.userKodaxDir, RULES_FILE_NAME);
  const projectPath = join(opts.projectRoot, '.kodax', RULES_FILE_NAME);
  const localPath = join(opts.projectRoot, '.kodax', LOCAL_RULES_FILE_NAME);

  // 1. User-level (always trusted)
  const userRaw = await tryReadRulesFile(userPath);
  if (userRaw !== null) {
    const parsed = parseAutoRules(userRaw);
    if (parsed.ok) {
      collected.push(parsed.rules);
      sources.push({
        origin: 'user',
        path: userPath,
        fingerprint: computeRulesFingerprint(userRaw),
      });
    } else {
      errors.push({ path: userPath, message: parsed.error });
    }
  }

  // 2. Project-shared (opt-in via fingerprint)
  const projectRaw = await tryReadRulesFile(projectPath);
  if (projectRaw !== null) {
    const fp = computeRulesFingerprint(projectRaw);
    const trust = await readTrustState(opts.userKodaxDir);
    const trustedFp = trust.trusted[projectPath];
    if (trustedFp === undefined) {
      skipped.push({ origin: 'project', path: projectPath, fingerprint: fp, reason: 'untrusted' });
    } else if (trustedFp !== fp) {
      skipped.push({
        origin: 'project',
        path: projectPath,
        fingerprint: fp,
        reason: 'fingerprint-changed',
      });
    } else {
      const parsed = parseAutoRules(projectRaw);
      if (parsed.ok) {
        collected.push(parsed.rules);
        sources.push({ origin: 'project', path: projectPath, fingerprint: fp });
      } else {
        errors.push({ path: projectPath, message: parsed.error });
      }
    }
  }

  // 3. Project-local (always trusted, gitignored)
  const localRaw = await tryReadRulesFile(localPath);
  if (localRaw !== null) {
    const parsed = parseAutoRules(localRaw);
    if (parsed.ok) {
      collected.push(parsed.rules);
      sources.push({
        origin: 'local',
        path: localPath,
        fingerprint: computeRulesFingerprint(localRaw),
      });
    } else {
      errors.push({ path: localPath, message: parsed.error });
    }
  }

  return {
    merged: collected.length === 0 ? EMPTY_RULES : mergeRules(collected),
    sources,
    skipped,
    errors,
  };
}

/**
 * Merge rule lists with "later layer wins position" semantics: when an
 * entry appears in multiple layers, the LATER layer's position determines
 * where it lands in the output. This matches the v0.7.33.md spec
 * ("后者覆盖前者的同类规则") and lets a project-local file demote a
 * user-level rule to its local position without losing it entirely.
 */
function mergeRules(layers: readonly AutoRules[]): AutoRules {
  return {
    allow: dedupConcat(layers.map((l) => l.allow)),
    soft_deny: dedupConcat(layers.map((l) => l.soft_deny)),
    environment: dedupConcat(layers.map((l) => l.environment)),
  };
}

function dedupConcat(arrays: readonly (readonly string[])[]): readonly string[] {
  let out: string[] = [];
  for (const arr of arrays) {
    const layerSet = new Set(arr);
    // Remove any entries this layer also contains — they'll be re-appended at the layer's position.
    out = out.filter((s) => !layerSet.has(s));
    const seen = new Set(out);
    for (const s of arr) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}
