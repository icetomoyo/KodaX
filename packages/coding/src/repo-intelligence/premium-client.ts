import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import type {
  KodaXRepoIntelligenceMode,
  KodaXRepoIntelligenceResolvedMode,
  KodaXRepoIntelligenceTrace,
} from '../types.js';
import {
  REPOINTEL_CONTRACT_VERSION,
  REPOINTEL_DEFAULT_ENDPOINT,
  type RepointelCommand,
  type RepointelRequestPayload,
  type RepointelRpcRequest,
  type RepointelRpcResponse,
} from '@kodax/repointel-protocol';
import { debugLogRepoIntelligence } from './internal.js';

const PREMIUM_FAILURE_TTL_MS = 2_000;
const PREMIUM_REQUEST_TIMEOUT_MS = 4_000;
/**
 * v0.7.27 — `refresh: true` forces the daemon to rebuild its semantic
 * index before answering. On a medium repo (~800 source files) this
 * takes ~10s; the normal 4s budget is inadequate and produces
 * deterministic AbortError → OSS fallback on the **first turn** of
 * every new session (where `isNewSession` → `refresh: true`).
 *
 * 30s matches what `repointel warm` / `repointel daemon` subcommands
 * expect from a cold index rebuild.
 */
const PREMIUM_REFRESH_TIMEOUT_MS = 30_000;
const PREMIUM_BUILD_ID_TIMEOUT_MS = 2_000;
const PREMIUM_BUILD_ID_CACHE_TTL_MS = 5 * 60_000;
const DAEMON_READY_POLL_INTERVAL_MS = 150;
const DAEMON_READY_PROBE_TIMEOUT_MS = 500;
const DAEMON_READY_MAX_WAIT_MS = 2_000;
const execFileAsync = promisify(execFile);
const JS_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const TS_SCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

/**
 * Detect a timeout / abort so we can distinguish "the daemon is slow"
 * (should NOT poison the 2s failure cache — subsequent turns may
 * complete within budget) from "the daemon is broken / missing / wrong
 * version" (SHOULD poison the cache to avoid spam). Covers the three
 * shapes undici / AbortController produce on Node 18+ / 20+ / 24+.
 */
function isTransientTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }
  const message = error.message.toLowerCase();
  if (message.includes('aborted') || message.includes('timeout')) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return isTransientTimeoutError(cause);
  }
  return false;
}

interface PremiumAvailabilityCache {
  failedAt: number;
  endpoint: string;
  error: string;
}

type RepoIntelligenceRequestedBridge = 'none' | 'shared' | 'native';
type RepoIntelligenceEffectiveEngine = 'off' | 'oss' | 'premium';
type RepoIntelligenceRuntimeStatus = 'disabled' | 'ok' | 'limited' | 'unavailable' | 'warming';
type PremiumTransport = 'daemon' | 'direct';

interface PremiumRuntimeDetails {
  transport?: PremiumTransport;
  clientBuildId?: string;
  daemonBuildId?: string;
  daemonStartedAt?: string;
  daemonPid?: number;
}

export interface RepoIntelligenceRuntimeInspection {
  configuredMode: KodaXRepoIntelligenceMode;
  requestedMode: KodaXRepoIntelligenceResolvedMode;
  endpoint: string;
  bin: string;
  traceEnabled: boolean;
  requestedBridge: RepoIntelligenceRequestedBridge;
  effectiveEngine: RepoIntelligenceEffectiveEngine;
  effectiveBridge: RepoIntelligenceRequestedBridge;
  status: RepoIntelligenceRuntimeStatus;
  fallbackToOss: boolean;
  warnings: string[];
  error?: string;
  transport?: PremiumTransport;
  clientBuildId?: string;
  daemonBuildId?: string;
  daemonStartedAt?: string;
  daemonPid?: number;
}

export interface RepoIntelligenceRuntimeWarmResult extends RepoIntelligenceRuntimeInspection {
  warmed: boolean;
  warmLatencyMs?: number;
}

export interface RepoIntelligenceRuntimeConfig {
  mode: KodaXRepoIntelligenceMode;
  endpoint: string;
  bin: string;
  trace: boolean;
}

const premiumFailureCache = new Map<string, PremiumAvailabilityCache>();
const localBuildIdCache = new Map<string, { buildId?: string; checkedAt: number }>();

function normalizeMode(value: string | undefined): KodaXRepoIntelligenceMode {
  if (
    value === 'auto'
    || value === 'off'
    || value === 'oss'
    || value === 'premium-shared'
    || value === 'premium-native'
  ) {
    return value;
  }
  return 'auto';
}

export function resolveRepoIntelligenceRuntimeConfig(
  modeOverride?: KodaXRepoIntelligenceMode,
  traceOverride?: boolean,
): RepoIntelligenceRuntimeConfig {
  return {
    mode: modeOverride ?? normalizeMode(process.env.KODAX_REPO_INTELLIGENCE_MODE),
    endpoint: process.env.KODAX_REPOINTEL_ENDPOINT?.trim() || REPOINTEL_DEFAULT_ENDPOINT,
    bin: process.env.KODAX_REPOINTEL_BIN?.trim() || 'repointel',
    trace: traceOverride ?? process.env.KODAX_REPO_INTELLIGENCE_TRACE === '1',
  };
}

export function resolveRepoIntelligenceMode(
  modeOverride?: KodaXRepoIntelligenceMode,
): KodaXRepoIntelligenceResolvedMode {
  const mode = resolveRepoIntelligenceRuntimeConfig(modeOverride).mode;
  if (mode === 'auto') {
    return 'premium-native';
  }
  return mode;
}

function canRetryPremium(endpoint: string): boolean {
  const cachedFailure = premiumFailureCache.get(endpoint);
  if (!cachedFailure) {
    return true;
  }
  if (Date.now() - cachedFailure.failedAt > PREMIUM_FAILURE_TTL_MS) {
    premiumFailureCache.delete(endpoint);
    return true;
  }
  return false;
}

function rememberPremiumFailure(endpoint: string, error: string): void {
  premiumFailureCache.set(endpoint, {
    endpoint,
    failedAt: Date.now(),
    error,
  });
}

function clearPremiumFailure(endpoint: string): void {
  premiumFailureCache.delete(endpoint);
}

export function isExplicitBinPath(bin: string): boolean {
  const normalizedBin = bin.trim();
  if (!normalizedBin || normalizedBin === 'repointel') {
    return false;
  }
  return path.isAbsolute(normalizedBin)
    || /^[a-zA-Z]:/.test(normalizedBin)
    || normalizedBin.startsWith('.')
    || normalizedBin.includes('/')
    || normalizedBin.includes('\\');
}

function getRequestedBridge(
  mode: KodaXRepoIntelligenceResolvedMode,
): RepoIntelligenceRequestedBridge {
  if (mode === 'premium-native') {
    return 'native';
  }
  if (mode === 'premium-shared') {
    return 'shared';
  }
  return 'none';
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Windows needs `cmd.exe /c` only for shell launchers like `.bat` / `.cmd`;
 * `.exe` binaries and no-extension PATH lookups execute fine through
 * `execFile` directly. Using `cmd.exe /d /s /c` for `.exe` files trips
 * cmd's `/s` quote-stripping rule (leading+trailing `"` around the full
 * command line get stripped, leaving orphan quotes inside the path) and
 * makes the subprocess fail with "command not found" on explicit paths.
 */
function windowsBinNeedsShell(extension: string): boolean {
  return extension === '.bat' || extension === '.cmd';
}

async function executePremiumBinCommand(
  bin: string,
  command: RepointelCommand,
  payload: RepointelRequestPayload,
  timeoutMs: number,
): Promise<{
  response: RepointelRpcResponse;
  latencyMs: number;
}> {
  const normalizedBin = bin.trim();
  const payloadJson = JSON.stringify(payload);
  const startedAt = Date.now();

  if (isExplicitBinPath(normalizedBin)) {
    const resolvedBinPath = path.resolve(normalizedBin);
    if (!existsSync(resolvedBinPath)) {
      throw new Error(`Configured repointel bin was not found: ${resolvedBinPath}`);
    }
  }

  const extension = normalizedBin.includes('.')
    ? normalizedBin.slice(normalizedBin.lastIndexOf('.')).toLowerCase()
    : '';

  let stdout = '';
  if (JS_SCRIPT_EXTENSIONS.has(extension)) {
    ({ stdout } = await execFileAsync(process.execPath, [normalizedBin, command, payloadJson], {
      timeout: timeoutMs,
      windowsHide: true,
    }));
  } else if (TS_SCRIPT_EXTENSIONS.has(extension)) {
    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    ({ stdout } = await execFileAsync(npxBin, ['tsx', normalizedBin, command, payloadJson], {
      timeout: timeoutMs,
      windowsHide: process.platform === 'win32',
    }));
  } else if (process.platform === 'win32' && windowsBinNeedsShell(extension)) {
    ({ stdout } = await execFileAsync(
      'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        `${quoteWindowsCmdArg(normalizedBin)} ${command} ${quoteWindowsCmdArg(payloadJson)}`,
      ],
      {
        timeout: timeoutMs,
        windowsHide: true,
      },
    ));
  } else {
    ({ stdout } = await execFileAsync(normalizedBin, [command, payloadJson], {
      timeout: timeoutMs,
      windowsHide: process.platform === 'win32',
    }));
  }

  let response: RepointelRpcResponse;
  try {
    response = JSON.parse(stdout) as RepointelRpcResponse;
  } catch (error) {
    throw new Error(
      `repointel ${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    response,
    latencyMs: Date.now() - startedAt,
  };
}

function extractPremiumRuntimeDetails(response: RepointelRpcResponse): PremiumRuntimeDetails {
  const result = response.result && typeof response.result === 'object'
    ? response.result as Record<string, unknown>
    : undefined;

  return {
    transport: result?.transport === 'daemon' || result?.transport === 'direct'
      ? result.transport
      : undefined,
    clientBuildId: typeof result?.clientBuildId === 'string' ? result.clientBuildId : undefined,
    daemonBuildId: typeof result?.daemonBuildId === 'string' ? result.daemonBuildId : undefined,
    daemonStartedAt: typeof result?.daemonStartedAt === 'string' ? result.daemonStartedAt : undefined,
    daemonPid: typeof result?.daemonPid === 'number' ? result.daemonPid : undefined,
  };
}

function buildBaseRuntimeInspection(
  config: RepoIntelligenceRuntimeConfig,
  requestedMode: KodaXRepoIntelligenceResolvedMode,
): RepoIntelligenceRuntimeInspection {
  const requestedBridge = getRequestedBridge(requestedMode);
  if (requestedMode === 'off') {
    return {
      configuredMode: config.mode,
      requestedMode,
      endpoint: config.endpoint,
      bin: config.bin,
      traceEnabled: config.trace,
      requestedBridge,
      effectiveEngine: 'off',
      effectiveBridge: 'none',
      status: 'disabled',
      fallbackToOss: false,
      warnings: ['Repo intelligence is disabled for this session.'],
    };
  }

  if (requestedMode === 'oss') {
    return {
      configuredMode: config.mode,
      requestedMode,
      endpoint: config.endpoint,
      bin: config.bin,
      traceEnabled: config.trace,
      requestedBridge,
      effectiveEngine: 'oss',
      effectiveBridge: 'none',
      status: 'ok',
      fallbackToOss: false,
      warnings: ['KodaX is pinned to the OSS repo-intelligence baseline.'],
    };
  }

  return {
    configuredMode: config.mode,
    requestedMode,
    endpoint: config.endpoint,
    bin: config.bin,
    traceEnabled: config.trace,
    requestedBridge,
    effectiveEngine: 'premium',
    effectiveBridge: requestedBridge,
    status: 'unavailable',
    fallbackToOss: false,
    warnings: [],
  };
}

async function resolveLocalPremiumBuildIdFromPath(bin: string): Promise<string | undefined> {
  const explicitBuildId = process.env.KODAX_REPOINTEL_BUILD_ID?.trim();
  if (explicitBuildId) {
    return explicitBuildId;
  }

  const normalizedBin = bin.trim();
  if (!normalizedBin || normalizedBin === 'repointel') {
    return undefined;
  }

  if (!isExplicitBinPath(normalizedBin)) {
    return undefined;
  }

  const resolvedBinPath = path.resolve(normalizedBin);
  const binDir = path.dirname(resolvedBinPath);
  const candidates = [
    path.join(binDir, 'build-id.json'),
    path.resolve(binDir, '../dist/build-id.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as { buildId?: unknown };
      if (typeof parsed.buildId === 'string' && parsed.buildId.trim()) {
        return parsed.buildId.trim();
      }
    } catch {
      // Ignore missing or malformed local build metadata and continue falling back.
    }
  }
  return undefined;
}

async function probeLocalPremiumBuildId(bin: string): Promise<string | undefined> {
  const cached = localBuildIdCache.get(bin);
  if (cached && (Date.now() - cached.checkedAt) < PREMIUM_BUILD_ID_CACHE_TTL_MS) {
    return cached.buildId;
  }
  try {
    const { response } = await executePremiumBinCommand(bin, 'status', {}, PREMIUM_BUILD_ID_TIMEOUT_MS);
    const result = response.result && typeof response.result === 'object'
      ? response.result as Record<string, unknown>
      : undefined;
    const buildId =
      (typeof result?.clientBuildId === 'string' ? result.clientBuildId : undefined)
      || response.buildId
      || (typeof result?.buildId === 'string' ? result.buildId : undefined);
    localBuildIdCache.set(bin, {
      buildId,
      checkedAt: Date.now(),
    });
    return buildId;
  } catch {
    localBuildIdCache.set(bin, {
      buildId: undefined,
      checkedAt: Date.now(),
    });
    return undefined;
  }
}

function clearLocalBuildIdCache(bin?: string): void {
  if (!bin) {
    localBuildIdCache.clear();
    return;
  }
  localBuildIdCache.delete(bin);
}

async function resolveLocalPremiumBuildId(bin: string, options: { forceRefresh?: boolean } = {}): Promise<string | undefined> {
  if (options.forceRefresh) {
    clearLocalBuildIdCache(bin);
  }
  return await resolveLocalPremiumBuildIdFromPath(bin)
    || await probeLocalPremiumBuildId(bin);
}

/**
 * Pick the fetch timeout budget for a daemon request.
 * `refresh: true` forces a semantic-index rebuild on the daemon side
 * (~10s on a medium repo); use the long budget only in that case so
 * hot-path requests keep the 4s cap.
 */
function selectRequestTimeoutMs(request: RepointelRpcRequest): number {
  return request.payload?.refresh === true
    ? PREMIUM_REFRESH_TIMEOUT_MS
    : PREMIUM_REQUEST_TIMEOUT_MS;
}

async function fetchPremiumJson(
  endpoint: string,
  request: RepointelRpcRequest,
): Promise<RepointelRpcResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), selectRequestTimeoutMs(request));
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await response.json() as RepointelRpcResponse;
    }
    if (!response.ok) {
      throw new Error(`Daemon responded with HTTP ${response.status}.`);
    }
    throw new Error('Daemon response was not JSON.');
  } finally {
    clearTimeout(timeout);
  }
}

async function runPremiumBinSubcommand(
  bin: string,
  subcommand: 'warm' | 'daemon',
): Promise<number | null> {
  const startedAt = Date.now();
  try {
    const normalizedBin = bin.trim();
    if (isExplicitBinPath(normalizedBin)) {
      const resolvedBinPath = path.resolve(normalizedBin);
      if (!existsSync(resolvedBinPath)) {
        throw new Error(`Configured repointel bin was not found: ${resolvedBinPath}`);
      }
    }
    const extension = normalizedBin.includes('.')
      ? normalizedBin.slice(normalizedBin.lastIndexOf('.')).toLowerCase()
      : '';

    if (JS_SCRIPT_EXTENSIONS.has(extension)) {
      await execFileAsync(process.execPath, [normalizedBin, subcommand, '{}'], {
        timeout: PREMIUM_REQUEST_TIMEOUT_MS,
        windowsHide: true,
      });
    } else if (TS_SCRIPT_EXTENSIONS.has(extension)) {
      const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      await execFileAsync(npxBin, ['tsx', normalizedBin, subcommand, '{}'], {
        timeout: PREMIUM_REQUEST_TIMEOUT_MS,
        windowsHide: process.platform === 'win32',
      });
    } else if (process.platform === 'win32' && windowsBinNeedsShell(extension)) {
      await execFileAsync(
        'cmd.exe',
        ['/d', '/s', '/c', `${quoteWindowsCmdArg(normalizedBin)} ${subcommand} "{}"`],
        {
          timeout: PREMIUM_REQUEST_TIMEOUT_MS,
          windowsHide: true,
        },
      );
    } else {
      await execFileAsync(normalizedBin, [subcommand, '{}'], {
        timeout: PREMIUM_REQUEST_TIMEOUT_MS,
        windowsHide: process.platform === 'win32',
      });
    }
    return Date.now() - startedAt;
  } catch (error) {
    debugLogRepoIntelligence(`Premium CLI ${subcommand} failed via ${bin}.`, error);
    return null;
  }
}

async function warmPremiumViaBin(bin: string): Promise<number | null> {
  return runPremiumBinSubcommand(bin, 'warm');
}

async function spawnPremiumDaemonViaBin(bin: string): Promise<number | null> {
  return runPremiumBinSubcommand(bin, 'daemon');
}

async function probeDaemonEndpoint(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DAEMON_READY_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: REPOINTEL_CONTRACT_VERSION,
        command: 'status',
        payload: {},
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDaemonReady(
  endpoint: string,
  maxWaitMs = DAEMON_READY_MAX_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await probeDaemonEndpoint(endpoint)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, DAEMON_READY_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * v0.7.27 — ensure the premium daemon is listening at `endpoint`. Tries
 * `bin warm` first (the TS CLI's `warm` spawns the daemon as a side
 * effect and waits for readiness), and falls back to an explicit
 * `bin daemon` subcommand for native SEA binaries whose `warm` runs in
 * direct mode without forking a daemon process. Polls the endpoint until
 * it responds or the deadline elapses.
 *
 * Returns the accumulated bin-side latency when the daemon becomes
 * reachable, or `null` when every approach failed (bin missing, daemon
 * refuses to start, readiness poll times out).
 */
async function ensurePremiumDaemonReady(
  bin: string,
  endpoint: string,
): Promise<number | null> {
  if (await probeDaemonEndpoint(endpoint)) {
    return 0;
  }

  let totalLatencyMs = 0;
  const warmLatency = await warmPremiumViaBin(bin);
  if (warmLatency !== null) {
    totalLatencyMs += warmLatency;
    if (await probeDaemonEndpoint(endpoint)) {
      return totalLatencyMs;
    }
  }

  const daemonLatency = await spawnPremiumDaemonViaBin(bin);
  if (daemonLatency === null) {
    return warmLatency !== null && await probeDaemonEndpoint(endpoint)
      ? totalLatencyMs
      : null;
  }
  totalLatencyMs += daemonLatency;

  if (await waitForDaemonReady(endpoint)) {
    return totalLatencyMs;
  }
  return null;
}

export async function inspectRepoIntelligenceRuntime(
  options: {
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
    probePremium?: boolean;
  } = {},
): Promise<RepoIntelligenceRuntimeInspection> {
  const config = resolveRepoIntelligenceRuntimeConfig(options.mode, options.trace);
  const requestedMode = resolveRepoIntelligenceMode(config.mode);
  const base = buildBaseRuntimeInspection(config, requestedMode);
  const shouldProbePremium = options.probePremium ?? (requestedMode === 'premium-native' || requestedMode === 'premium-shared');

  if (!shouldProbePremium) {
    return base;
  }

  try {
    const { response } = await executePremiumBinCommand(config.bin, 'status', {}, PREMIUM_BUILD_ID_TIMEOUT_MS);
    const details = extractPremiumRuntimeDetails(response);
    const warnings = [...(response.warnings ?? [])];
    const premiumUsable = response.status === 'ok' || response.status === 'limited' || response.status === 'warming';
    if (details.transport === 'direct') {
      warnings.push('Premium frontdoor is available, but the daemon is not currently serving requests.');
    }

    if (!premiumUsable) {
      return {
        ...base,
        status: 'unavailable',
        fallbackToOss: requestedMode === 'premium-native' || requestedMode === 'premium-shared',
        warnings: warnings.length > 0
          ? warnings
          : ['Premium runtime is unavailable. KodaX will fall back to the OSS baseline.'],
        error: response.error,
        ...details,
      };
    }

    return {
      ...base,
      status: response.status,
      effectiveEngine: requestedMode === 'premium-native' || requestedMode === 'premium-shared'
        ? 'premium'
        : base.effectiveEngine,
      effectiveBridge: requestedMode === 'premium-native' || requestedMode === 'premium-shared'
        ? base.requestedBridge
        : base.effectiveBridge,
      fallbackToOss: false,
      warnings,
      error: response.error,
      ...details,
    };
  } catch (error) {
    return {
      ...base,
      status: 'unavailable',
      fallbackToOss: requestedMode === 'premium-native' || requestedMode === 'premium-shared',
      warnings: ['Premium runtime is unreachable. KodaX will fall back to the OSS baseline.'],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function warmRepoIntelligenceRuntime(
  options: {
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
  } = {},
): Promise<RepoIntelligenceRuntimeWarmResult> {
  const config = resolveRepoIntelligenceRuntimeConfig(options.mode, options.trace);
  let warmLatencyMs: number | undefined;

  try {
    // v0.7.27 — use ensurePremiumDaemonReady instead of raw warm so that
    // native SEA binaries (whose `warm` runs in direct mode without
    // spawning a daemon) still end up with a live daemon at `endpoint`.
    warmLatencyMs = await ensurePremiumDaemonReady(config.bin, config.endpoint) ?? undefined;
    if (warmLatencyMs === undefined) {
      throw new Error('repointel warm did not complete successfully.');
    }
    clearPremiumFailure(config.endpoint);
  } catch (error) {
    const inspection = await inspectRepoIntelligenceRuntime({
      ...options,
      probePremium: true,
    });
    return {
      ...inspection,
      warmed: false,
      warmLatencyMs,
      warnings: inspection.warnings.length > 0
        ? inspection.warnings
        : ['Unable to start the local repointel runtime.'],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const inspection = await inspectRepoIntelligenceRuntime({
    ...options,
    probePremium: true,
  });
  const daemonReady = inspection.status === 'ok'
    && inspection.transport === 'daemon';

  if (daemonReady) {
    return {
      ...inspection,
      warmed: true,
      warmLatencyMs,
    };
  }

  return {
    ...inspection,
    warmed: false,
    warmLatencyMs,
    warnings: inspection.warnings.length > 0
      ? inspection.warnings
      : ['repointel did not become ready over the local daemon endpoint.'],
    error: inspection.error ?? 'Local repointel service did not become ready.',
  };
}

export async function callPremiumDaemon(
  command: RepointelCommand,
  payload: RepointelRequestPayload,
  options: {
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
  } = {},
): Promise<{
  response: RepointelRpcResponse;
  trace?: KodaXRepoIntelligenceTrace;
} | null> {
  const config = resolveRepoIntelligenceRuntimeConfig(options.mode, options.trace);
  const resolvedMode = resolveRepoIntelligenceMode(config.mode);
  if (resolvedMode === 'off' || resolvedMode === 'oss') {
    return null;
  }
  if (!canRetryPremium(config.endpoint)) {
    debugLogRepoIntelligence(
      `Skipping premium daemon call due to failure cache: ${premiumFailureCache.get(config.endpoint)?.error ?? 'unknown error'}`,
    );
    return null;
  }

  let localBuildId = await resolveLocalPremiumBuildId(config.bin);
  let request: RepointelRpcRequest = {
    contractVersion: REPOINTEL_CONTRACT_VERSION,
    buildId: localBuildId,
    command,
    payload,
  };

  const startedAt = Date.now();
  try {
    let cliLatencyMs: number | undefined;
    let daemonAttemptStartedAt = Date.now();
    let response: RepointelRpcResponse;
    try {
      daemonAttemptStartedAt = Date.now();
      response = await fetchPremiumJson(config.endpoint, request);
    } catch (error) {
      const warmedMs = await ensurePremiumDaemonReady(config.bin, config.endpoint);
      if (warmedMs === null) {
        throw error;
      }
      cliLatencyMs = warmedMs;
      daemonAttemptStartedAt = Date.now();
      response = await fetchPremiumJson(config.endpoint, request);
    }
    if (response.contractVersion !== REPOINTEL_CONTRACT_VERSION) {
      // Contract mismatch: the daemon IS reachable but speaks a different
      // protocol version. Re-warm the CLI so TS-CLI's `tryRecycleStaleDaemon`
      // can swap in a matching daemon. No daemon-start fallback needed —
      // `warmPremiumViaBin` alone is the right tool here.
      const warmedMs = await warmPremiumViaBin(config.bin);
      if (warmedMs !== null) {
        cliLatencyMs = (cliLatencyMs ?? 0) + warmedMs;
        daemonAttemptStartedAt = Date.now();
        response = await fetchPremiumJson(config.endpoint, request);
      }
      if (response.contractVersion !== REPOINTEL_CONTRACT_VERSION) {
        rememberPremiumFailure(config.endpoint, `Contract mismatch ${response.contractVersion}`);
        return null;
      }
    }
    if (localBuildId && response.buildId && response.buildId !== localBuildId) {
      debugLogRepoIntelligence(`Premium daemon build mismatch: expected ${localBuildId}, got ${response.buildId}. Attempting local build-id refresh.`);
      const refreshedBuildId = await resolveLocalPremiumBuildId(config.bin, { forceRefresh: true });
      if (refreshedBuildId && refreshedBuildId !== localBuildId) {
        localBuildId = refreshedBuildId;
        request = {
          ...request,
          buildId: refreshedBuildId,
        };
        daemonAttemptStartedAt = Date.now();
        response = await fetchPremiumJson(config.endpoint, request);
      } else {
        // Build mismatch: daemon is reachable, just stale. Re-warm the CLI
        // to let `tryRecycleStaleDaemon` kill+respawn with the current build.
        const warmedMs = await warmPremiumViaBin(config.bin);
        if (warmedMs !== null) {
          cliLatencyMs = (cliLatencyMs ?? 0) + warmedMs;
          daemonAttemptStartedAt = Date.now();
          response = await fetchPremiumJson(config.endpoint, request);
        }
      }
      if (localBuildId && response.buildId && response.buildId !== localBuildId) {
        clearLocalBuildIdCache(config.bin);
        rememberPremiumFailure(config.endpoint, `Build mismatch ${response.buildId}`);
        return null;
      }
    }
    if (response.status === 'unavailable' && response.error) {
      rememberPremiumFailure(config.endpoint, response.error);
      return null;
    }
    clearPremiumFailure(config.endpoint);
    const trace: KodaXRepoIntelligenceTrace | undefined = config.trace
      ? {
        mode: resolvedMode,
        engine: 'premium',
        bridge: resolvedMode === 'premium-native' ? 'native' : 'shared',
        triggeredAt: new Date().toISOString(),
        source: 'premium',
        daemonLatencyMs: Date.now() - daemonAttemptStartedAt,
        cliLatencyMs,
        cacheHit: response.cacheHit,
        capsuleBytes: response.trace?.capsuleBytes,
        capsuleEstimatedTokens: response.trace?.capsuleEstimatedTokens,
      }
      : undefined;
    return {
      response,
      trace,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // v0.7.27 — transient timeouts (e.g. refresh:true preturn exceeding
    // even the 30s budget on an unusually large repo, or a passing network
    // hiccup) should NOT poison the 2s failure cache. The cache is meant
    // to suppress spam when the daemon is structurally broken (bin
    // missing, contract/build mismatch, daemon returning `unavailable`),
    // not to amplify a single slow call into session-wide OSS fallback.
    if (!isTransientTimeoutError(error)) {
      rememberPremiumFailure(config.endpoint, message);
    }
    debugLogRepoIntelligence(`Premium daemon call failed for ${command}.`, error);
    return null;
  }
}
