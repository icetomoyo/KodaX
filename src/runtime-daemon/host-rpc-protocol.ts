/**
 * What serving v2 needs from the protocol definitions: the method table, the
 * connection that checks frames against it, and the contracts of what the Host
 * sends unasked. Building them imports zod and constructs every schema, which
 * a CLI that only connects to a Host never needs, so only a process that
 * serves v2 loads this module, once, before it accepts connections. The
 * network listener comes with it, so its WebSocket and JWT code load only in a
 * Host as well.
 */
export { createHostConnection } from '../host-protocol/connection.js';
export { LEASE_NOTIFICATIONS } from '../host-protocol/lease.js';
export { HOST_NOTIFICATIONS } from '../host-protocol/host.js';
export { HOST_METHODS } from '../host-protocol/methods.js';
export { HostDocument, LocalHostDocument, LocalSessionView, SessionView } from '../host-protocol/view.js';
export { createHostToolCeiling } from '../host-server/config.js';
export { createHostBlobStore } from './host-blobs.js';
export { startHostNetworkServer } from '../host-server/serve.js';
