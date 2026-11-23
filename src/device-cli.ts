/**
 * `kodax host pair` and `kodax host devices`: the owner pairs browsers with
 * the running Host of this home, lists them and revokes them, over the same v2
 * methods KodaX Space uses. The Host holds the devices, so it must be running.
 */
import { randomUUID } from 'node:crypto';

import type { Command } from 'commander';

import { connectHostRpc, type HostRpcClient } from './host-protocol/client.js';
import type { HostResult } from './host-protocol/methods.js';
import { observeRuntimeDaemonHealth, runtimeDaemonEndpointFromState } from './runtime-daemon/lifecycle.js';
import {
  classifyRuntimeDaemonHealth, readRuntimeDaemonToken, resolveRuntimeDaemonPathsFromConfigHome, type RuntimeDaemonState,
} from './runtime-daemon/state.js';
import { dialRuntimeDaemonHostRpc } from './runtime-daemon/transport.js';

type Device = HostResult<'device.list'>['items'][number];
type Connection = Pick<HostRpcClient, 'request' | 'close'>;

/** Where the commands reach the Host and print. Tests pass their own. */
export interface DeviceCliHost {
  readonly connect: () => Promise<Connection>;
  readonly write: (text: string) => void;
}

export async function pairDevice(
  input: { readonly name: string; readonly url?: string; readonly json: boolean },
  host: DeviceCliHost,
): Promise<void> {
  const address = input.url === undefined ? undefined : originOf(input.url);
  const { code, expiresAt } = await withHost(host, rpc => rpc.request('device.pair', { requestId: randomUUID(), name: input.name })) as
    HostResult<'device.pair'>;
  const link = `${address ?? ''}/#pair=${code}`;
  if (input.json) {
    host.write(`${JSON.stringify({ code, expiresAt, ...(address !== undefined ? { link } : {}) }, null, 2)}\n`);
    return;
  }
  const where = address !== undefined
    ? `Open this link on the device: ${link}`
    : `Open <address>${link} on the device, where <address> is how it reaches this Host, such as your tunnel's address.`;
  host.write(`${where}\nThe code works once, until ${new Date(expiresAt).toISOString()}.\n`);
}

export async function listDevices(input: { readonly json: boolean }, host: DeviceCliHost): Promise<void> {
  const devices = await withHost(host, readDevices);
  if (input.json) {
    host.write(`${JSON.stringify(devices, null, 2)}\n`);
    return;
  }
  if (devices.length === 0) {
    host.write('No devices are paired with this Host.\n');
    return;
  }
  host.write(devices.map(device =>
    `${device.id}  ${device.name}  ${device.origin}  last seen ${new Date(device.lastSeenAt).toISOString()}\n`).join(''));
}

/** `device` is an id, or a name only one device has. */
export async function revokeDevice(input: { readonly device: string; readonly json: boolean }, host: DeviceCliHost): Promise<void> {
  const revoked = await withHost(host, async (rpc) => {
    const target = pick(await readDevices(rpc), input.device);
    await rpc.request('device.revoke', { requestId: randomUUID(), deviceId: target.id });
    return target;
  });
  host.write(input.json ? `${JSON.stringify(revoked, null, 2)}\n` : `Revoked ${revoked.name} (${revoked.id}).\n`);
}

/** Connects to the running Host of a home as its owner. */
export async function connectRunningHost(
  location: { readonly configHome: string; readonly profile: string },
  version: string,
): Promise<HostRpcClient> {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(location.configHome, location.profile);
  const observation = await observeRuntimeDaemonHealth(paths);
  const token = readRuntimeDaemonToken(paths);
  if (classifyRuntimeDaemonHealth(observation) !== 'healthy' || observation.state === undefined || token === undefined) {
    throw new Error('No Host is running for this home. Start it with `kodax host start`, or open KodaX Space.');
  }
  return connectHostOwner(observation.state, token, version);
}

/** Connects as the owner to the Host a state file names. A `probe` connection only reads whether it is up. */
export function connectHostOwner(
  state: RuntimeDaemonState,
  token: string,
  version: string,
  purpose?: 'probe',
): Promise<HostRpcClient> {
  return connectHostRpc(dialRuntimeDaemonHostRpc(runtimeDaemonEndpointFromState(state)), {
    client: { name: 'kodax-cli', version, instanceId: `cli-${randomUUID()}` },
    auth: { scheme: 'ipc', token },
    ...(purpose !== undefined ? { purpose } : {}),
  });
}

export function configureKodaXDeviceCommands(daemon: Command, options: {
  readonly locate: (home: string | undefined) => { readonly configHome: string; readonly profile: string };
  readonly version: string;
  readonly homeHelp: string;
}): void {
  const host = (home: string | undefined): DeviceCliHost => ({
    connect: () => connectRunningHost(options.locate(home), options.version),
    write: text => process.stdout.write(text),
  });
  daemon
    .command('pair')
    .description('Pair a browser with the running Host, for use through a tunnel')
    .requiredOption('--name <name>', 'What to call the device')
    .option('--url <address>', "The address the device opens, such as your tunnel's")
    .option('--home <dir>', options.homeHelp)
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { name: string; url?: string; home?: string; json?: boolean }) => {
      await pairDevice({ name: opts.name, ...(opts.url !== undefined ? { url: opts.url } : {}), json: opts.json === true }, host(opts.home));
    });
  const devices = daemon
    .command('devices')
    .description('List the browsers paired with the running Host')
    .option('--home <dir>', options.homeHelp)
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { home?: string; json?: boolean }) => {
      await listDevices({ json: opts.json === true }, host(opts.home));
    });
  devices
    .command('revoke')
    .description('Revoke a paired browser and close its connections')
    .argument('<device>', 'The device id, or a name only one device has')
    .option('--home <dir>', options.homeHelp)
    .option('--json', 'Output machine-readable JSON')
    .action(async (device: string, _opts: unknown, command: Command) => {
      const opts = command.optsWithGlobals<{ home?: string; json?: boolean }>();
      await revokeDevice({ device, json: opts.json === true }, host(opts.home));
    });
}

async function withHost<T>(host: DeviceCliHost, run: (rpc: Connection) => Promise<T>): Promise<T> {
  const rpc = await host.connect();
  try {
    return await run(rpc);
  } finally {
    rpc.close();
  }
}

async function readDevices(rpc: Connection): Promise<readonly Device[]> {
  return (await rpc.request('device.list') as HostResult<'device.list'>).items;
}

function pick(devices: readonly Device[], wanted: string): Device {
  const byId = devices.find(device => device.id === wanted);
  if (byId !== undefined) return byId;
  const named = devices.filter(device => device.name === wanted);
  if (named.length === 1) return named[0]!;
  if (named.length === 0) throw new Error(`No paired device has the id or name ${wanted}. See \`kodax host devices\`.`);
  throw new Error(`Several devices are called ${wanted}: ${named.map(device => device.id).join(', ')}. Name one by its id.`);
}

function originOf(url: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  // Anything after the origin, such as a path, is not where the Host serves the pairing page.
  if (parsed === undefined || !['http:', 'https:'].includes(parsed.protocol) || parsed.href !== `${parsed.origin}/`) {
    throw new Error(`--url must be an origin such as https://laptop.example.ts.net, without a path: ${url}`);
  }
  return parsed.origin;
}
