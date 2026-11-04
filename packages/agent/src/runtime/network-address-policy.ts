import { BlockList, isIP } from 'node:net';

// IPv4 rules also match IPv4-mapped IPv6 forms (::ffff:a.b.c.d).
const CLOUD_METADATA = new BlockList();
// Link-local covers AWS, Azure, GCP, Oracle, Tencent and most other clouds.
CLOUD_METADATA.addSubnet('169.254.0.0', 16, 'ipv4');
CLOUD_METADATA.addSubnet('fe80::', 10, 'ipv6');
CLOUD_METADATA.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud
CLOUD_METADATA.addAddress('168.63.129.16', 'ipv4'); // Azure platform endpoint
CLOUD_METADATA.addAddress('fd00:ec2::254', 'ipv6'); // AWS
CLOUD_METADATA.addAddress('fd20:ce::254', 'ipv6'); // GCP
CLOUD_METADATA.addAddress('fd00:c1::a9fe:a9fe', 'ipv6'); // Oracle Cloud

const PRIVATE_NETWORK = new BlockList();
PRIVATE_NETWORK.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_NETWORK.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_NETWORK.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE_NETWORK.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_NETWORK.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_NETWORK.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_NETWORK.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_NETWORK.addAddress('::', 'ipv6');
PRIVATE_NETWORK.addAddress('::1', 'ipv6');
PRIVATE_NETWORK.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_NETWORK.addSubnet('fe80::', 10, 'ipv6');

function matches(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return family === 4 ? list.check(address, 'ipv4') : family === 6 && list.check(address, 'ipv6');
}

/** Cloud instance metadata and platform endpoints, which can hand out credentials. */
export function isCloudMetadataAddress(address: string): boolean {
  return matches(CLOUD_METADATA, address);
}

/** Loopback, private, carrier-grade NAT, link-local and unique-local addresses. */
export function isPrivateNetworkAddress(address: string): boolean {
  return matches(PRIVATE_NETWORK, address);
}
