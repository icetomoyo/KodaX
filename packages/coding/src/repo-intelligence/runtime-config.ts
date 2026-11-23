import type {
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceResolvedMode,
} from '../types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  probeRepoIntelligenceStorage,
  resolveRepoIntelligenceStorageRoot,
} from './internal.js';
import { getRepoIntelligenceWorkerPathForDiagnostics } from './semantic-worker-client.js';

export interface RepoIntelligenceRuntimeInspection {
  configuredMode: KodaXRepoIntelligenceMode;
  requestedMode: KodaXRepoIntelligenceResolvedMode;
  traceEnabled: boolean;
  effectiveEngine: 'off' | 'light' | 'full';
  status: 'disabled' | 'ok' | 'limited' | 'unavailable' | 'warming';
  fallbackToLight: boolean;
  warnings: string[];
  error?: string;
  workerPath?: string;
  storageRoot?: string;
}

export interface RepoIntelligenceRuntimeConfig {
  mode: KodaXRepoIntelligenceMode;
  trace: boolean;
  warnings: string[];
}

const PUBLIC_MODES = new Set<string>(['auto', 'off', 'light', 'full']);
const LEGACY_MODES = new Set<string>(['oss', 'premium-native', 'premium-shared']);

function readModeValue(value: string | undefined): {
  mode?: KodaXRepoIntelligenceMode;
  warning?: string;
} {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return {};
  if (PUBLIC_MODES.has(normalized)) {
    return { mode: normalized as KodaXRepoIntelligenceMode };
  }
  if (LEGACY_MODES.has(normalized)) {
    return {
      warning: `Ignoring legacy repo-intelligence mode "${normalized}". Use auto, full, light, or off.`,
    };
  }
  return {
    warning: `Ignoring unknown repo-intelligence mode "${value}". Expected auto, full, light, or off.`,
  };
}

function legacyBridgeWarnings(): string[] {
  const warnings: string[] = [];
  if (process.env.KODAX_REPOINTEL_BIN?.trim()) {
    warnings.push('Ignoring legacy KODAX_REPOINTEL_BIN; repo intelligence is built into KodaX.');
  }
  if (process.env.KODAX_REPOINTEL_ENDPOINT?.trim()) {
    warnings.push('Ignoring legacy KODAX_REPOINTEL_ENDPOINT; repo intelligence no longer uses a daemon endpoint.');
  }
  if (process.env.KODAX_REPOINTEL_BUILD_ID?.trim()) {
    warnings.push('Ignoring legacy KODAX_REPOINTEL_BUILD_ID; built-in repo intelligence has no external build-id probe.');
  }
  return warnings;
}

async function resolveProbeWorkspaceRoot(workspaceRoot: string | undefined): Promise<string> {
  if (!workspaceRoot) return process.cwd();
  try {
    const stat = await fs.stat(workspaceRoot);
    if (stat.isDirectory()) return workspaceRoot;
  } catch {
    // A stale/fake workspace path should not make a status probe create
    // directories outside the active process tree.
  }
  return process.cwd();
}

export function resolveRepoIntelligenceRuntimeConfig(
  modeOverride?: KodaXRepoIntelligenceMode,
  traceOverride?: boolean,
): RepoIntelligenceRuntimeConfig {
  const warnings = legacyBridgeWarnings();
  const preferredEnv = readModeValue(process.env.KODAX_REPO_INTELLIGENCE);
  const legacyEnv = readModeValue(process.env.KODAX_REPO_INTELLIGENCE_MODE);
  if (preferredEnv.warning) warnings.push(preferredEnv.warning);
  if (legacyEnv.warning) warnings.push(legacyEnv.warning);
  if (process.env.KODAX_REPO_INTELLIGENCE_MODE?.trim()) {
    warnings.push('Ignoring deprecated KODAX_REPO_INTELLIGENCE_MODE; use KODAX_REPO_INTELLIGENCE.');
  }

  return {
    mode: modeOverride ?? preferredEnv.mode ?? 'auto',
    trace: traceOverride ?? process.env.KODAX_REPO_INTELLIGENCE_TRACE === '1',
    warnings,
  };
}

export function resolveRepoIntelligenceMode(
  modeOverride?: KodaXRepoIntelligenceMode,
): KodaXRepoIntelligenceResolvedMode {
  const mode = resolveRepoIntelligenceRuntimeConfig(modeOverride).mode;
  if (mode === 'auto') {
    return 'full';
  }
  return mode;
}

/**
 * The agent surface (semantic tools, module/impact injection, background
 * indexing) uses the semantic engine only when a caller explicitly asks for
 * `full` or `light`. `auto` keeps the git-based overview, changed scope and
 * diff tools. Direct SDK calls such as `getModuleContext` still resolve `auto`
 * to `full`, because calling them is itself an explicit request.
 */
export function isRepoIntelligenceSemanticSurfaceEnabled(
  modeOverride?: KodaXRepoIntelligenceMode,
): boolean {
  const mode = resolveRepoIntelligenceRuntimeConfig(modeOverride).mode;
  return mode === 'full' || mode === 'light';
}

export const SEMANTIC_SURFACE_OPT_IN_NOTE =
  'The semantic index is off by default; set repo intelligence to full or light to enable symbol, module and impact tools.';

export async function inspectRepoIntelligenceRuntime(
  options: {
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
    probe?: boolean;
    workspaceRoot?: string;
  } = {},
): Promise<RepoIntelligenceRuntimeInspection> {
  const config = resolveRepoIntelligenceRuntimeConfig(options.mode, options.trace);
  if (config.mode === 'auto') {
    return {
      configuredMode: config.mode,
      requestedMode: 'off',
      traceEnabled: config.trace,
      effectiveEngine: 'off',
      status: 'ok',
      fallbackToLight: false,
      warnings: [...config.warnings, SEMANTIC_SURFACE_OPT_IN_NOTE],
    };
  }
  const requestedMode = resolveRepoIntelligenceMode(config.mode);
  const inspection: RepoIntelligenceRuntimeInspection = {
    configuredMode: config.mode,
    requestedMode,
    traceEnabled: config.trace,
    effectiveEngine: requestedMode,
    status: requestedMode === 'off' ? 'disabled' : 'ok',
    fallbackToLight: false,
    warnings: config.warnings,
  };
  if (requestedMode === 'off' || options.probe !== true) {
    return inspection;
  }

  const workerPath = getRepoIntelligenceWorkerPathForDiagnostics();
  inspection.workerPath = workerPath;
  try {
    await fs.access(workerPath);
  } catch (error) {
    inspection.status = 'unavailable';
    inspection.error = error instanceof Error ? error.message : String(error);
    inspection.warnings.push(`Repo intelligence worker sidecar is not readable: ${workerPath}`);
    return inspection;
  }

  const workspaceRoot = await resolveProbeWorkspaceRoot(options.workspaceRoot);
  const storageRoot = resolveRepoIntelligenceStorageRoot(workspaceRoot);
  inspection.storageRoot = storageRoot;
  const probePath = path.join(
    storageRoot,
    `.repo-intelligence-status-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await probeRepoIntelligenceStorage(storageRoot, probePath);
  } catch (error) {
    inspection.status = 'limited';
    inspection.error = error instanceof Error ? error.message : String(error);
    inspection.warnings.push(`Repo intelligence cache directory is not writable: ${storageRoot}`);
  }
  return inspection;
}
