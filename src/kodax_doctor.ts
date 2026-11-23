/**
 * FEATURE_204 (v0.7.45) — `kodax doctor` diagnostic CLI.
 *
 * Minimalist scope: read-only environment probes that need no network + no
 * billing — runtime, terminal capabilities, configured providers, session/
 * trace disk usage, config home. Live provider `ping` (network + billing) and
 * MCP handshake probes are deferred until there's demand; `kodax doctor` today
 * answers "is my env sane / how much disk are sessions using" without any cost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectDoctorCoreConfig, inspectDoctorLocks } from './doctor-storage.js';
import { observeRuntimeDaemonHealth } from './runtime-daemon/lifecycle.js';
import {
  classifyRuntimeDaemonHealth, HOST_STATUS_EXIT_CODES, hostHealthState, resolveRuntimeDaemonPathsFromConfigHome,
  resolveRuntimeHostSlot, type HostHealthState,
} from './runtime-daemon/state.js';

import { getAgentConfigHome } from '@kodax-ai/agent';
import { KODAX_PROVIDER_SNAPSHOTS } from '@kodax-ai/coding';
import { resolveProvider, sideQuery } from '@kodax-ai/llm';
import {
  probeTrustedTextNativeBinding,
  type TrustedTextNativeBindingProbe,
} from './windows-text-transaction.js';

interface DirSummary {
  readonly count: number;
  readonly bytes: number;
}

interface ProviderStatus {
  readonly name: string;
  /** The env var that configures this provider's API key. */
  readonly apiKeyEnv: string;
  /** Key env var is present. NOT the same as "reachable" — see note below. */
  readonly configured: boolean;
}

/** Live reachability probe result for one provider (`--ping`). */
interface ProviderPing {
  readonly name: string;
  readonly apiKeyEnv: string;
  /** The provider answered a minimal request. */
  readonly reachable: boolean;
  readonly latencyMs?: number;
  /** Human-readable outcome: `ok` / `timeout` / a short error reason. */
  readonly detail: string;
}

interface DoctorReport {
  readonly version: string;
  readonly runtime: { readonly node: string; readonly platform: string };
  readonly terminal: { readonly tty: boolean; readonly truecolor: boolean };
  /**
   * Per-provider key-presence. `configured` = the provider's env var is set —
   * it does NOT verify the key works or (for coding-plan providers) that the
   * subscription is active; that needs the live `--ping` probe below.
   */
  readonly providers: readonly ProviderStatus[];
  readonly configHome: string;
  readonly coreConfig: ReturnType<typeof inspectDoctorCoreConfig>;
  readonly locks: ReturnType<typeof inspectDoctorLocks>;
  readonly sessions: DirSummary | null;
  readonly traces: DirSummary | null;
  /** The Host serving this home, in the vocabulary of `kodax host status`. */
  readonly host: { readonly state: HostHealthState; readonly runtimeId?: string; readonly pid?: number };
  /** Present only when `--native-text` explicitly loads the verified addon. */
  readonly trustedTextNative?: TrustedTextNativeBindingProbe;
  /** Present only when `--ping` ran. Live reachability per configured provider. */
  readonly providersPing?: readonly ProviderPing[];
}

/**
 * Probe one provider with the smallest possible live request. Unlike the
 * key-presence check, this proves the key actually works AND (for coding-plan
 * providers) that the subscription is active. Costs a few output tokens; only
 * runs under `--ping`.
 */
async function pingProvider(name: string, apiKeyEnv: string): Promise<ProviderPing> {
  const startedAt = performance.now();
  try {
    const provider = resolveProvider(name);
    const result = await sideQuery({
      provider,
      model: provider.getModel(),
      system: 'Connectivity probe.',
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      timeoutMs: 10_000,
      querySource: 'doctor-ping',
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (result.stopReason === 'end_turn' || result.stopReason === 'max_tokens') {
      return { name, apiKeyEnv, reachable: true, latencyMs, detail: 'ok' };
    }
    if (result.stopReason === 'timeout') {
      return { name, apiKeyEnv, reachable: false, latencyMs, detail: 'timeout (>10s)' };
    }
    const reason = result.error?.message ?? result.stopReason;
    return { name, apiKeyEnv, reachable: false, latencyMs, detail: shortReason(reason) };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const reason = error instanceof Error ? error.message : String(error);
    return { name, apiKeyEnv, reachable: false, latencyMs, detail: shortReason(reason) };
  }
}

function shortReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

/** Ping every provider whose key is present, concurrently. */
async function pingConfiguredProviders(
  providers: readonly ProviderStatus[],
): Promise<ProviderPing[]> {
  const configured = providers.filter((p) => p.configured);
  return Promise.all(configured.map((p) => pingProvider(p.name, p.apiKeyEnv)));
}

function buildProviderStatuses(): ProviderStatus[] {
  return Object.entries(KODAX_PROVIDER_SNAPSHOTS)
    .map(([name, snap]) => ({
      name,
      apiKeyEnv: (snap as { apiKeyEnv: string }).apiKeyEnv,
      configured: Boolean(process.env[(snap as { apiKeyEnv: string }).apiKeyEnv]),
    }))
    .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
}

function summarizeDir(dir: string): DirSummary | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    try {
      const stat = fs.statSync(path.join(dir, entry));
      if (stat.isFile()) {
        bytes += stat.size;
        count += 1;
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return { count, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function inspectHost(home: string): Promise<DoctorReport['host']> {
  const slot = resolveRuntimeHostSlot(home, path.join(home, 'sessions'));
  const observation = await observeRuntimeDaemonHealth(resolveRuntimeDaemonPathsFromConfigHome(home, slot));
  const state = hostHealthState(classifyRuntimeDaemonHealth(observation), observation.state);
  return observation.state === undefined
    ? { state }
    : { state, runtimeId: observation.state.runtimeId, pid: observation.state.pid };
}

/** A stopped Host is normal; a Host that does not answer, or a config KodaX cannot read, is a failure. */
function doctorExitCode(report: DoctorReport): 0 | 1 {
  const configBroken = report.coreConfig.state === 'invalid' || report.coreConfig.state === 'unreadable';
  return configBroken || HOST_STATUS_EXIT_CODES[report.host.state] === 1 ? 1 : 0;
}

async function buildReport(version: string): Promise<DoctorReport> {
  const home = getAgentConfigHome();
  return {
    version,
    runtime: { node: process.version, platform: `${os.platform()} ${os.release()}` },
    terminal: {
      tty: Boolean(process.stdout.isTTY),
      truecolor: process.env.COLORTERM === 'truecolor',
    },
    providers: buildProviderStatuses(),
    configHome: home,
    coreConfig: inspectDoctorCoreConfig(home),
    locks: inspectDoctorLocks(home),
    sessions: summarizeDir(path.join(home, 'sessions')),
    traces: summarizeDir(path.join(home, '.traces')),
    host: await inspectHost(home),
  };
}

function summaryLine(label: string, summary: DirSummary | null): string {
  if (!summary) return `  ${label}: (none)`;
  return `  ${label}: ${summary.count} files, ${formatBytes(summary.bytes)}`;
}

export async function runDoctor(
  version: string,
  asJson: boolean,
  opts: { readonly ping?: boolean; readonly nativeText?: boolean } = {},
): Promise<0 | 1> {
  const base = await buildReport(version);
  const providersPing = opts.ping ? await pingConfiguredProviders(base.providers) : undefined;
  const trustedTextNative = opts.nativeText ? probeTrustedTextNativeBinding() : undefined;
  const report: DoctorReport = {
    ...base,
    ...(providersPing === undefined ? {} : { providersPing }),
    ...(trustedTextNative === undefined ? {} : { trustedTextNative }),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return doctorExitCode(report);
  }
  const lines = [
    `KodaX v${report.version} diagnostic`,
    '',
    'Runtime',
    `  Node ${report.runtime.node}`,
    `  Platform: ${report.runtime.platform}`,
    '',
    'Terminal',
    `  TTY: ${report.terminal.tty ? 'yes' : 'no'}`,
    `  Truecolor: ${report.terminal.truecolor ? 'yes' : 'unknown'}`,
    '',
    'Providers (configured = API key env var present; NOT verified reachable)',
    ...report.providers.map((p) =>
      p.configured
        ? `  ✓ ${p.name.padEnd(16)} ${p.apiKeyEnv}`
        : `  ✗ ${p.name.padEnd(16)} ${p.apiKeyEnv}  (set to enable)`,
    ),
    '',
    `Storage (${report.configHome})`,
    summaryLine('sessions', report.sessions),
    summaryLine('traces  ', report.traces),
    `  Core config: ${report.coreConfig.state} (${report.coreConfig.path})${'offset' in report.coreConfig ? `; JSON offset ${report.coreConfig.offset}` : ''}`,
    '',
    'Host',
    `  ${report.host.state}${report.host.runtimeId !== undefined ? ` (${report.host.runtimeId}, PID ${report.host.pid})` : ''}`,
    '',
    'Retained locks (presence alone does not prove abandonment)',
    ...report.locks.items.map(item => `  ${item.state}: ${item.path}${item.record ? `; ${item.kind}, record=${item.record}, ownership=${item.ownership}` : ''}`),
    ...report.locks.issues.map(issue => `  unavailable (${issue.code}): ${issue.path}`),
    `  ${report.locks.recovery}`,
    `  ${report.locks.scope}`,
  ];
  if (report.providersPing) {
    lines.push(
      '',
      'Provider reachability (live probe — sent a minimal request, small token cost)',
      ...(report.providersPing.length === 0
        ? ['  (no configured providers to probe)']
        : report.providersPing.map((p) =>
            p.reachable
              ? `  ✓ ${p.name.padEnd(16)} ${p.detail} (${p.latencyMs}ms)`
              : `  ✗ ${p.name.padEnd(16)} ${p.detail}`,
          )),
    );
  }
  if (report.trustedTextNative) {
    lines.push(
      '',
      'Trusted text native binding (explicit load/hash check)',
      report.trustedTextNative.ready
        ? `  ✓ protocol ${report.trustedTextNative.protocol}`
        : `  ✗ ${report.trustedTextNative.error}`,
    );
  }
  console.log(lines.join('\n'));
  return doctorExitCode(report);
}
