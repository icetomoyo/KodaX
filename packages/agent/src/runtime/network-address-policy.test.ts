import { describe, expect, it } from 'vitest';
import { isCloudMetadataAddress, isPrivateNetworkAddress } from './network-address-policy.js';

describe('cloud metadata address policy', () => {
  it.each([
    '169.254.169.254', // AWS, Azure, GCP, Oracle and most other clouds
    '169.254.0.23', // Tencent Cloud
    '169.254.1.1',
    'fe80::1',
    'fe80::1%12', // scoped link-local from getaddrinfo
    'fd00:ec2::254', // AWS IPv6
    'fd20:ce::254', // GCP IPv6-only instances
    'fd00:c1::a9fe:a9fe', // Oracle Cloud IPv6
    '100.100.100.200', // Alibaba Cloud
    '168.63.129.16', // Azure platform endpoint
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
  ])('blocks %s', (address) => {
    expect(isCloudMetadataAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '::1',
    '10.0.0.5',
    '172.16.4.2',
    '192.168.1.10',
    '100.64.0.1', // Tailscale and carrier NAT share 100.64.0.0/10
    '100.100.100.201',
    'fd00::1',
    '93.184.216.34',
    '2606:4700::1111',
  ])('keeps %s reachable', (address) => {
    expect(isCloudMetadataAddress(address)).toBe(false);
  });
});

describe('private network address classification', () => {
  it.each(['127.0.0.1', '::1', '10.1.2.3', '172.31.0.1', '192.168.0.1', '100.64.0.1',
    '169.254.169.254', 'fd00::1', 'fe80::1', '0.0.0.0', '::', '::ffff:10.0.0.1'])('treats %s as private', (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::1111', '172.32.0.1'])('treats %s as public', (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(false);
  });
});
