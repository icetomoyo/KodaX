/** Independent source Host for cross-process SDK contract regressions. */
import { randomUUID } from 'node:crypto';
import { createKodaXHostRuntime } from '../src/sdk-runtime.js';
import { startRuntimeDaemonHost } from '../src/runtime-daemon/host.js';
import { readRuntimeDaemonLockOwner, readRuntimeDaemonState, removeRuntimeDaemonOwnershipIfUnchanged,
  resolveRuntimeDaemonPaths, runtimeOwnerProcessState, tryAcquireRuntimeDaemonLock } from '../src/runtime-daemon/state.js';

const homeDir = process.argv[2]!;
const paths = resolveRuntimeDaemonPaths(homeDir);
const previous = readRuntimeDaemonLockOwner(paths.lockFile);
if (previous && runtimeOwnerProcessState(previous) === 'gone') {
  removeRuntimeDaemonOwnershipIfUnchanged(paths, { lockOwner: previous, state: readRuntimeDaemonState(paths) });
}
const runtime = await createKodaXHostRuntime({ homeDir, sharedDaemonHost: true });
if (process.argv[3] === 'crash-on-workflow-terminal') {
  runtime.events.subscribe({}, event => {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.interrupted') process.exit(99);
  });
}
const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId,
  pid: process.pid, createdAt: runtime.identity.startedAt });
if (!lock) throw new Error('Cannot acquire the isolated SDK fixture Host.');
const host = await startRuntimeDaemonHost({ runtime, paths, lock,
  endpoint: { kind: process.platform === 'win32' ? 'pipe' : 'unix',
    path: process.platform === 'win32' ? `\\\\.\\pipe\\kodax-sdk-contract-${randomUUID()}` : `${homeDir}/host.sock` } });
process.send?.({ endpoint: host.endpoint.path, pid: process.pid });
process.on('message', async message => {
  if (message === 'close') {
    await host.close(); await runtime.close(); process.disconnect();
  }
});
