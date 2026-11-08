/** Independent source Host for cross-process SDK contract regressions. */
import { randomUUID } from 'node:crypto';
import { createKodaXHostRuntime } from '../src/sdk-runtime.js';
import { startRuntimeDaemonHost } from '../src/runtime-daemon/host.js';
import { readRuntimeDaemonLockOwner, readRuntimeDaemonState, removeRuntimeDaemonOwnershipIfUnchanged,
  readRuntimeOwnerProcessStartIdentity, resolveRuntimeDaemonPaths, runtimeOwnerProcessState, tryAcquireRuntimeDaemonLock } from '../src/runtime-daemon/state.js';

const homeDir = process.argv[2]!;
const paths = resolveRuntimeDaemonPaths(homeDir);
const previous = readRuntimeDaemonLockOwner(paths.lockFile);
const previousState = previous ? runtimeOwnerProcessState(previous) : 'missing-or-unreadable';
let reclaim: boolean | 'not-attempted' = 'not-attempted';
function ownerConflict(): Error {
  const summary = (owner: ReturnType<typeof readRuntimeDaemonLockOwner>) => owner && ({
    runtimeId: owner.runtimeId, pid: owner.pid, kind: owner.kind, createdAt: owner.createdAt,
    processStartIdentity: owner.processStartIdentity,
  });
  return new Error(`Cannot acquire the isolated SDK fixture Host. previousState=${previousState}; reclaim=${reclaim}; ${JSON.stringify({
    previous: summary(previous), currentOwner: summary(readRuntimeDaemonLockOwner(paths.lockFile)),
    coordinationOwner: summary(readRuntimeDaemonLockOwner(paths.ownerPolicyLockFile)),
  })}`);
}
if (previous) {
  if (previousState !== 'gone') throw ownerConflict();
  reclaim = removeRuntimeDaemonOwnershipIfUnchanged(paths, { lockOwner: previous, state: readRuntimeDaemonState(paths) });
  if (!reclaim) throw ownerConflict();
}
const runtime = await createKodaXHostRuntime({ homeDir, sharedDaemonHost: true });
if (process.argv[3] === 'crash-on-workflow-terminal') {
  runtime.events.subscribe({}, event => {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.interrupted') process.exit(99);
  });
}
const processStartIdentity = readRuntimeOwnerProcessStartIdentity(process.pid);
const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId,
  pid: process.pid, createdAt: runtime.identity.startedAt, kind: 'daemon',
  ...(processStartIdentity === undefined ? {} : { processStartIdentity }) });
if (!lock) throw ownerConflict();
const host = await startRuntimeDaemonHost({ runtime, paths, lock,
  endpoint: { kind: process.platform === 'win32' ? 'pipe' : 'unix',
    path: process.platform === 'win32' ? `\\\\.\\pipe\\kodax-sdk-contract-${randomUUID()}` : `${homeDir}/host.sock` } });
process.send?.({ endpoint: host.endpoint.path, pid: process.pid });
process.on('message', async message => {
  if (message === 'close') {
    await host.close(); await runtime.close(); process.disconnect();
  }
});
