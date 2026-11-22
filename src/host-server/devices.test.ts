import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOST_PAIRING_CODE_TTL_MS, openHostDeviceRegistry, type HostDeviceRegistry } from './devices.js';

const ORIGIN = 'https://laptop.tailnet.ts.net';

describe('openHostDeviceRegistry', () => {
  let dir: string;
  let file: string;
  let clock: number;
  const open = (): HostDeviceRegistry => openHostDeviceRegistry({ file, now: () => clock });

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kodax-devices-'));
    file = path.join(dir, 'runtime', 'devices.json');
    clock = 1_000_000;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pairs a device with a one-time code and admits its token from the pairing origin', () => {
    const devices = open();
    const { code, expiresAt } = devices.pair({ requestId: 'r1', name: 'Phone' });
    expect(expiresAt).toBe(clock + HOST_PAIRING_CODE_TTL_MS);

    const paired = devices.redeem(code, ORIGIN);
    expect(paired?.device).toMatchObject({ name: 'Phone', origin: ORIGIN, pairedAt: clock, lastSeenAt: clock });
    expect(paired?.device.id).toMatch(/^dev_[0-9a-f]{12}$/u);

    clock += 5_000;
    expect(devices.admit(paired!.token, ORIGIN)).toMatchObject({ id: paired!.device.id, lastSeenAt: clock });
    expect(devices.list()).toEqual([{ ...paired!.device, lastSeenAt: clock }]);
  });

  it('keeps only the hash of the token on disk, and the devices across a restart', () => {
    const devices = open();
    const paired = devices.redeem(devices.pair({ requestId: 'r1', name: 'Phone' }).code, ORIGIN)!;

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(paired.token);
    expect(raw).toContain(createHash('sha256').update(paired.token).digest('hex'));
    expect(open().admit(paired.token, ORIGIN)?.id).toBe(paired.device.id);
  });

  it('accepts a code once', () => {
    const devices = open();
    const { code } = devices.pair({ requestId: 'r1', name: 'Phone' });
    expect(devices.redeem(code, ORIGIN)).toBeDefined();
    expect(devices.redeem(code, ORIGIN)).toBeUndefined();
  });

  it('refuses a code after it expires', () => {
    const devices = open();
    const { code } = devices.pair({ requestId: 'r1', name: 'Phone' });
    clock += HOST_PAIRING_CODE_TTL_MS;
    expect(devices.redeem(code, ORIGIN)).toBeUndefined();
  });

  it('answers a repeated pairing request with the same code', () => {
    const devices = open();
    const first = devices.pair({ requestId: 'r1', name: 'Phone' });
    expect(devices.pair({ requestId: 'r1', name: 'Phone' })).toEqual(first);
    expect(devices.pair({ requestId: 'r2', name: 'Phone' }).code).not.toBe(first.code);
  });

  it('refuses a token from another origin or one it never issued', () => {
    const devices = open();
    const paired = devices.redeem(devices.pair({ requestId: 'r1', name: 'Phone' }).code, ORIGIN)!;
    expect(devices.admit(paired.token, 'https://evil.example')).toBeUndefined();
    expect(devices.admit('not-a-token', ORIGIN)).toBeUndefined();
  });

  it('revokes a device, tells who listens, and admits its token no more', () => {
    const devices = open();
    const paired = devices.redeem(devices.pair({ requestId: 'r1', name: 'Phone' }).code, ORIGIN)!;
    const revoked: string[] = [];
    devices.onRevoke(id => revoked.push(id));

    expect(devices.revoke(paired.device.id)).toBe(true);
    expect(revoked).toEqual([paired.device.id]);
    expect(devices.admit(paired.token, ORIGIN)).toBeUndefined();
    expect(devices.list()).toEqual([]);
    expect(open().admit(paired.token, ORIGIN)).toBeUndefined();
    // Again, or a device it never paired: nothing to do.
    expect(devices.revoke(paired.device.id)).toBe(false);
    expect(revoked).toHaveLength(1);
  });

  it('starts with no devices, and says so, when the file cannot be read', () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const devices = open();
    devices.redeem(devices.pair({ requestId: 'r1', name: 'Phone' }).code, ORIGIN);
    writeFileSync(file, '{ not json');

    const restore = setKodaXDiagnosticSink(diagnostic => diagnostics.push(diagnostic));
    try {
      expect(open().list()).toEqual([]);
    } finally {
      restore();
    }
    expect(diagnostics).toEqual([expect.objectContaining({ source: 'host.devices', level: 'warn' })]);
  });
});
