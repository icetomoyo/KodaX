import { describe, expect, it, vi } from 'vitest';

import { listDevices, pairDevice, revokeDevice, type DeviceCliHost } from './device-cli.js';

const PHONE = { id: 'dev_0123456789ab', name: 'Phone', origin: 'https://laptop.example.test', pairedAt: 1_000, lastSeenAt: 2_000 };
const TABLET = { ...PHONE, id: 'dev_ba9876543210', name: 'Tablet' };

function fakeHost(answers: Record<string, unknown>) {
  const request = vi.fn(async (method: string) => {
    if (!Object.hasOwn(answers, method)) throw new Error(`unexpected ${method}`);
    return answers[method] as Readonly<Record<string, unknown>>;
  });
  const close = vi.fn();
  const output: string[] = [];
  const host: DeviceCliHost = { connect: async () => ({ request, close }), write: text => output.push(text) };
  return { host, request, close, output };
}

describe('kodax host pair', () => {
  it('prints the link the device opens, built on the address it reaches the Host at', async () => {
    const { host, request, close, output } = fakeHost({ 'device.pair': { code: 'abc_123', expiresAt: Date.parse('2026-11-22T10:10:00Z') } });
    await pairDevice({ name: 'Phone', url: 'https://laptop.example.test/', json: false }, host);

    expect(request).toHaveBeenCalledWith('device.pair', { requestId: expect.any(String), name: 'Phone' });
    expect(output.join('')).toContain('https://laptop.example.test/#pair=abc_123');
    expect(close).toHaveBeenCalled();
  });

  it('prints the code alone when it does not know the address', async () => {
    const { host, output } = fakeHost({ 'device.pair': { code: 'abc_123', expiresAt: 0 } });
    await pairDevice({ name: 'Phone', json: false }, host);
    expect(output.join('')).toContain('/#pair=abc_123');
  });

  it('refuses an address with a path before asking the Host', async () => {
    const { host, request } = fakeHost({});
    await expect(pairDevice({ name: 'Phone', url: 'https://laptop.example.test/ui', json: false }, host))
      .rejects.toThrow(/origin/u);
    expect(request).not.toHaveBeenCalled();
  });

  it('answers in JSON', async () => {
    const { host, output } = fakeHost({ 'device.pair': { code: 'abc_123', expiresAt: 5 } });
    await pairDevice({ name: 'Phone', url: 'http://192.168.1.5:8787', json: true }, host);
    expect(JSON.parse(output.join(''))).toEqual({ code: 'abc_123', expiresAt: 5, link: 'http://192.168.1.5:8787/#pair=abc_123' });
  });
});

describe('kodax host devices', () => {
  it('lists the paired devices with where they connect from and when they were last seen', async () => {
    const { host, output } = fakeHost({ 'device.list': { items: [PHONE] } });
    await listDevices({ json: false }, host);
    const text = output.join('');
    expect(text).toContain(PHONE.id);
    expect(text).toContain('Phone');
    expect(text).toContain(PHONE.origin);
    expect(text).toContain(new Date(PHONE.lastSeenAt).toISOString());
  });

  it('says when no device is paired', async () => {
    const { host, output } = fakeHost({ 'device.list': { items: [] } });
    await listDevices({ json: false }, host);
    expect(output.join('')).toMatch(/No devices/u);
  });

  it('revokes a device named by its id or by a name only it has', async () => {
    const { host, request } = fakeHost({ 'device.list': { items: [PHONE, TABLET] }, 'device.revoke': {} });
    await revokeDevice({ device: PHONE.id, json: false }, host);
    await revokeDevice({ device: 'Tablet', json: false }, host);
    expect(request).toHaveBeenCalledWith('device.revoke', { requestId: expect.any(String), deviceId: PHONE.id });
    expect(request).toHaveBeenCalledWith('device.revoke', { requestId: expect.any(String), deviceId: TABLET.id });
  });

  it('refuses a name it does not know or that several devices share', async () => {
    const { host, request } = fakeHost({ 'device.list': { items: [PHONE, { ...TABLET, name: 'Phone' }] } });
    await expect(revokeDevice({ device: 'Laptop', json: false }, host)).rejects.toThrow(/No paired device/u);
    await expect(revokeDevice({ device: 'Phone', json: false }, host)).rejects.toThrow(/dev_0123456789ab.*dev_ba9876543210/u);
    expect(request).not.toHaveBeenCalledWith('device.revoke', expect.anything());
  });
});
