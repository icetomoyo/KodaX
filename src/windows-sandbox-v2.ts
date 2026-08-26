import { createHash } from 'node:crypto';
import path from 'node:path';

import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

import {
  resolveWindowsNativeArtifact,
  type ResolveWindowsNativeArtifactOptions,
} from './windows-native-artifacts.js';

export const WINDOWS_SANDBOX_V2_PROTOCOL = 4;

export interface AsrtWindowsInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface SplitAsrtWindowsInvocation {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly targetArgv: readonly string[];
  readonly childEnvironment: Readonly<Record<string, string>>;
}

export interface WindowsSandboxV2PolicyInput {
  readonly generation: string;
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

export interface WindowsSandboxV2RunRequest {
  readonly protocol: typeof WINDOWS_SANDBOX_V2_PROTOCOL;
  readonly generation: string;
  readonly sandboxUserSid: string;
  readonly sandboxGroupSid: string;
  readonly asrtExecutable: string;
  readonly asrtPrefixArgs: readonly string[];
  readonly targetArgv: readonly string[];
  readonly cwd: string;
  readonly policyFingerprint: string;
  readonly policyCapabilitySid: string;
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly controllerPipe: string;
  readonly launchDeadlineUnixMs: number;
}

export interface WindowsSandboxV2RunRequestInput {
  readonly generation: string;
  readonly sandboxUserSid: string;
  readonly sandboxGroupSid: string;
  readonly asrtInvocation: SplitAsrtWindowsInvocation;
  readonly targetArgv: readonly string[];
  readonly cwd: string;
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly controllerPipe: string;
  readonly launchDeadlineUnixMs: number;
}

/**
 * Keep ASRT as the Windows proxy/WFP owner without allowing its session-level
 * grant/revoke state machine to become a second filesystem authority.
 */
export function asrtWindowsNetworkOnlyConfig(
  config: SandboxRuntimeConfig,
): SandboxRuntimeConfig {
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      disabled: true,
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    },
  };
}

export function splitAsrtWindowsInvocation(
  invocation: AsrtWindowsInvocation,
): SplitAsrtWindowsInvocation {
  const separators = invocation.args.flatMap((value, index) => value === '--' ? [index] : []);
  if (separators.length === 0) {
    throw new Error('ASRT Windows invocation omitted its target separator.');
  }
  if (separators.length !== 1) {
    throw new Error('ASRT Windows invocation must contain exactly one target separator.');
  }
  const separator = separators[0]!;
  const targetArgv = invocation.args.slice(separator + 1);
  if (targetArgv.length === 0 || targetArgv[0] === '') {
    throw new Error('ASRT Windows invocation omitted its target executable.');
  }
  const childEnvironment = new Map<string, readonly [string, string]>();
  const prefixArgs: string[] = [];
  for (let index = 0; index <= separator; index += 1) {
    const argument = invocation.args[index]!;
    const normalizedArgument = argument.toLowerCase();
    if (normalizedArgument.startsWith('--env=')) {
      throw new Error('ASRT Windows invocation used an unsupported inline environment entry.');
    }
    if (normalizedArgument !== '--env') {
      prefixArgs.push(argument);
      continue;
    }
    if (index + 1 >= separator) {
      throw new Error('ASRT Windows invocation contained an incomplete environment entry.');
    }
    const assignment = invocation.args[index + 1]!;
    const equals = assignment.indexOf('=');
    const name = equals < 1 ? '' : assignment.slice(0, equals);
    const value = equals < 0 ? '' : assignment.slice(equals + 1);
    const normalized = name.toLowerCase();
    if (
      name === ''
      || name.includes('\0')
      || value.includes('\0')
    ) {
      throw new Error('ASRT Windows invocation contained an invalid environment entry.');
    }
    // ASRT 0.0.65 emits upper- and lower-case proxy aliases. Windows
    // environment names are case-insensitive and the later assignment wins.
    // Collapse with those semantics before constructing the private bootstrap.
    childEnvironment.set(normalized, [name, value]);
    index += 1;
  }
  return {
    executable: invocation.executable,
    prefixArgs,
    targetArgv,
    childEnvironment: Object.fromEntries(childEnvironment.values()),
  };
}

function normalizePolicyPath(candidate: string): string {
  return path.win32.resolve(candidate.replaceAll('/', '\\')).toLowerCase();
}

function normalizedPolicyPaths(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(normalizePolicyPath))].sort();
}

/**
 * The complete immutable write policy is the authority key. Two Runtime
 * processes independently derive the same key without a mutable SID registry.
 */
export function windowsSandboxV2PolicyFingerprint(
  input: WindowsSandboxV2PolicyInput,
): string {
  if (input.generation.trim() === '') {
    throw new Error('Windows sandbox v2 generation is empty.');
  }
  const canonical = JSON.stringify({
    version: 1,
    generation: input.generation,
    allowWrite: normalizedPolicyPaths(input.allowWrite),
    denyWrite: normalizedPolicyPaths(input.denyWrite),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Windows capability SID used as a restricting SID. It deliberately uses the
 * machine-SID shape accepted by CreateRestrictedToken (the same approach as
 * Codex), while the digest keeps each policy identity deterministic and isolated.
 */
export function windowsSandboxV2PolicyCapabilitySid(fingerprint: string): string {
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) {
    throw new Error('Invalid Windows sandbox v2 policy fingerprint.');
  }
  const digest = createHash('sha256')
    .update('KodaX Windows sandbox v2 policy capability\0', 'utf8')
    .update(fingerprint.toLowerCase(), 'ascii')
    .digest();
  const authorities = Array.from(
    { length: 4 },
    (_, index) => digest.readUInt32LE(index * 4),
  );
  return `S-1-5-21-${authorities.join('-')}`;
}

export function windowsSandboxV2Generation(input: {
  readonly sandboxUserSid: string;
  readonly sandboxGroupSid: string;
  readonly asrtSha256: string;
  readonly shellSha256: string;
}): string {
  if (!/^S-1-(?:\d+-)+\d+$/.test(input.sandboxUserSid)) {
    throw new Error('Invalid Windows sandbox account SID.');
  }
  if (!/^S-1-(?:\d+-)+\d+$/.test(input.sandboxGroupSid)) {
    throw new Error('Invalid Windows sandbox group SID.');
  }
  if (!/^[0-9a-f]{64}$/i.test(input.asrtSha256)
    || !/^[0-9a-f]{64}$/i.test(input.shellSha256)) {
    throw new Error('Invalid Windows sandbox generation artifact hash.');
  }
  return createHash('sha256').update(JSON.stringify({
    version: WINDOWS_SANDBOX_V2_PROTOCOL,
    sandboxUserSid: input.sandboxUserSid,
    sandboxGroupSid: input.sandboxGroupSid,
    asrtSha256: input.asrtSha256.toLowerCase(),
    shellSha256: input.shellSha256.toLowerCase(),
  }), 'utf8').digest('hex');
}

export function encodeWindowsSandboxV2Bootstrap(
  environment: Readonly<Record<string, string>>,
): Buffer {
  const normalizedNames = new Set<string>();
  let environmentUnits = 1;
  const targetEnvironment: Record<string, string> = {};
  const entries = Object.entries(environment);
  if (entries.length > 4_096) {
    throw new Error('Windows sandbox target environment has too many entries.');
  }
  for (const [name, value] of entries) {
    if (
      name === ''
      || name.includes('=')
      || name.includes('\0')
      || value.includes('\0')
    ) {
      throw new Error('Windows sandbox target environment contains an invalid entry.');
    }
    const normalized = name.toUpperCase();
    if (normalizedNames.has(normalized)) {
      throw new Error('Windows sandbox target environment contains ambiguous names.');
    }
    normalizedNames.add(normalized);
    environmentUnits += name.length + value.length + 2;
    targetEnvironment[name] = value;
  }
  if (environmentUnits > 30_000) {
    throw new Error('Windows sandbox target environment exceeds its UTF-16 bound.');
  }
  const payload = Buffer.from(JSON.stringify({
    protocol: WINDOWS_SANDBOX_V2_PROTOCOL,
    targetEnvironment: Object.entries(targetEnvironment).map(([name, value]) => ({ name, value })),
  }), 'utf8');
  if (payload.byteLength > 512 * 1024) {
    throw new Error('Windows sandbox bootstrap frame exceeds 512 KiB.');
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export function createWindowsSandboxV2RunRequest(
  input: WindowsSandboxV2RunRequestInput,
): WindowsSandboxV2RunRequest {
  if (input.targetArgv.length === 0 || input.targetArgv[0]?.trim() === '') {
    throw new Error('Windows sandbox v2 target argv is empty.');
  }
  if (!/^\\\\\.\\pipe\\kodax-v2-[1-9]\d{0,9}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
    .test(input.controllerPipe)) {
    throw new Error('Windows sandbox v2 controller pipe is invalid.');
  }
  if (input.asrtInvocation.prefixArgs.at(-1) !== '--') {
    throw new Error('Windows sandbox v2 ASRT prefix omitted its target separator.');
  }
  if (input.asrtInvocation.prefixArgs.some((argument) => {
    const normalized = argument.toLowerCase();
    return normalized === '--env' || normalized.startsWith('--env=');
  })) {
    throw new Error('Windows sandbox v2 ASRT prefix retained a target environment entry.');
  }
  if (!Number.isSafeInteger(input.launchDeadlineUnixMs) || input.launchDeadlineUnixMs <= 0) {
    throw new Error('Windows sandbox v2 launch deadline is invalid.');
  }
  if (!/^S-1-(?:\d+-)+\d+$/.test(input.sandboxUserSid)) {
    throw new Error('Windows sandbox v2 account SID is invalid.');
  }
  if (!/^S-1-(?:\d+-)+\d+$/.test(input.sandboxGroupSid)) {
    throw new Error('Windows sandbox v2 group SID is invalid.');
  }
  const policyFingerprint = windowsSandboxV2PolicyFingerprint({
    generation: input.generation,
    allowWrite: input.allowWrite,
    denyWrite: input.denyWrite,
  });
  const policyCapabilitySid = windowsSandboxV2PolicyCapabilitySid(policyFingerprint);
  if (
    input.sandboxGroupSid === input.sandboxUserSid
    || input.sandboxGroupSid === policyCapabilitySid
  ) {
    throw new Error('Windows sandbox v2 group SID must be an independent account group.');
  }
  return {
    protocol: WINDOWS_SANDBOX_V2_PROTOCOL,
    generation: input.generation,
    sandboxUserSid: input.sandboxUserSid,
    sandboxGroupSid: input.sandboxGroupSid,
    asrtExecutable: input.asrtInvocation.executable,
    asrtPrefixArgs: input.asrtInvocation.prefixArgs,
    targetArgv: input.targetArgv,
    cwd: input.cwd,
    policyFingerprint,
    policyCapabilitySid,
    allowRead: input.allowRead,
    allowWrite: input.allowWrite,
    denyRead: input.denyRead,
    denyWrite: input.denyWrite,
    controllerPipe: input.controllerPipe,
    launchDeadlineUnixMs: input.launchDeadlineUnixMs,
  };
}

export function resolveWindowsSandboxV2Executable(
  options: ResolveWindowsNativeArtifactOptions = {},
): {
  readonly path: string;
  readonly sha256: string;
} {
  const artifact = resolveWindowsNativeArtifact(
    import.meta.url,
    'shellSandbox',
    WINDOWS_SANDBOX_V2_PROTOCOL,
    options,
  );
  return { path: artifact.path, sha256: artifact.entry.sha256 };
}
