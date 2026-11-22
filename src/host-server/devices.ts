/**
 * The browsers a person paired with their Host, for a Host they reach through
 * a tunnel without an identity provider. A one-time code, shown on the Host's
 * own machine, is traded for a long-lived device token; the Host keeps only
 * the token's hash, and the origin the device paired from, which every later
 * connection must come from. Codes live in memory only. The Host process is
 * the file's only writer, so the copy in memory is the truth and the file is
 * rewritten whole on each change.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { writeCoreConfigAtomically } from '@kodax-ai/repl';

import { reportHostSecurityEvent } from '../runtime-daemon/security-log.js';

/** How long a pairing code may be redeemed. */
export const HOST_PAIRING_CODE_TTL_MS = 10 * 60_000;

/** A paired device as its owner sees it. Times are UTC milliseconds. */
export interface HostDevice {
  readonly id: string;
  readonly name: string;
  /** The browser origin it paired from. It connects from this origin only. */
  readonly origin: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
}

export interface HostPairingCode {
  readonly code: string;
  readonly expiresAt: number;
}

export interface HostDeviceRegistry {
  /** A code that pairs one device. The same `requestId` answers with the same code while it is good. */
  pair(request: { readonly requestId: string; readonly name: string }): HostPairingCode;
  /** Trades a good code for a new device and its token, once. Undefined when the code is not good. */
  redeem(code: string, origin: string): { readonly device: HostDevice; readonly token: string } | undefined;
  /** The device a token belongs to, when it comes from the origin the device paired from. Records the visit. */
  admit(token: string, origin: string): HostDevice | undefined;
  list(): readonly HostDevice[];
  /** Whether a device was removed. Its token is refused from then on, and listeners are told. */
  revoke(id: string): boolean;
  /** Returns the function that removes the listener. */
  onRevoke(listener: (id: string) => void): () => void;
}

interface StoredDevice extends HostDevice {
  readonly tokenHash: string;
}

interface PendingCode extends HostPairingCode {
  readonly requestId: string;
  readonly name: string;
}

export function openHostDeviceRegistry(options: {
  readonly file: string;
  /** @internal Tests move the clock. */
  readonly now?: () => number;
}): HostDeviceRegistry {
  const now = options.now ?? Date.now;
  const devices = new Map<string, StoredDevice>(readDevices(options.file).map(device => [device.tokenHash, device]));
  const pending = new Map<string, PendingCode>();
  const listeners = new Set<(id: string) => void>();

  const save = (): void => {
    mkdirSync(path.dirname(options.file), { recursive: true });
    writeCoreConfigAtomically(options.file, `${JSON.stringify({ version: 1, devices: [...devices.values()] }, null, 2)}\n`);
  };
  const dropExpired = (): void => {
    for (const [code, entry] of pending) if (entry.expiresAt <= now()) pending.delete(code);
  };
  const visible = ({ tokenHash: _hash, ...device }: StoredDevice): HostDevice => device;

  return {
    pair({ requestId, name }) {
      dropExpired();
      const repeat = [...pending.values()].find(entry => entry.requestId === requestId);
      if (repeat !== undefined) return { code: repeat.code, expiresAt: repeat.expiresAt };
      const code = randomBytes(16).toString('base64url');
      const expiresAt = now() + HOST_PAIRING_CODE_TTL_MS;
      pending.set(code, { code, expiresAt, requestId, name });
      return { code, expiresAt };
    },
    redeem(code, origin) {
      dropExpired();
      const entry = pending.get(code);
      if (entry === undefined) return undefined;
      pending.delete(code);
      const token = randomBytes(32).toString('base64url');
      const at = now();
      const device: StoredDevice = {
        id: `dev_${randomBytes(6).toString('hex')}`, name: entry.name, origin, pairedAt: at, lastSeenAt: at, tokenHash: hash(token),
      };
      devices.set(device.tokenHash, device);
      save();
      reportHostSecurityEvent({ event: 'device_paired', device: device.id, name: device.name, origin });
      return { device: visible(device), token };
    },
    admit(token, origin) {
      const found = devices.get(hash(token));
      if (found === undefined || found.origin !== origin) return undefined;
      const seen = { ...found, lastSeenAt: now() };
      devices.set(seen.tokenHash, seen);
      save();
      return visible(seen);
    },
    list: () => [...devices.values()].map(visible),
    revoke(id) {
      const found = [...devices.values()].find(device => device.id === id);
      if (found === undefined) return false;
      devices.delete(found.tokenHash);
      save();
      reportHostSecurityEvent({ event: 'device_revoked', device: found.id, name: found.name });
      for (const listener of listeners) listener(id);
      return true;
    },
    onRevoke(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A file it cannot read pairs nothing, so the Host still starts and its devices pair again. */
function readDevices(file: string): readonly StoredDevice[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return unreadable(file, error);
  }
  try {
    const parsed = JSON.parse(raw) as { readonly version?: unknown; readonly devices?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.devices) || !parsed.devices.every(isStoredDevice)) {
      throw new Error('not a version 1 device list');
    }
    return parsed.devices;
  } catch (error: unknown) {
    return unreadable(file, error);
  }
}

function unreadable(file: string, error: unknown): readonly StoredDevice[] {
  emitKodaXDiagnostic({
    source: 'host.devices', level: 'warn',
    message: 'The paired devices could not be read; every device must pair again.',
    detail: { file, error: error instanceof Error ? error.message : String(error) },
  });
  return [];
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (typeof value !== 'object' || value === null) return false;
  const device = value as Record<string, unknown>;
  return ['id', 'name', 'origin', 'tokenHash'].every(field => typeof device[field] === 'string')
    && typeof device.pairedAt === 'number' && typeof device.lastSeenAt === 'number';
}
