/**
 * Browser SDK entry — @kodax-ai/kodax/browser. A v2 client of a Host on the
 * network for a web page, such as one the Host serves from `server.webRoot`.
 * No Node dependency and no schema library at run time: the Host validates
 * every request, so the types here are for the compiler only.
 */
export { connectKodaXHost, type ConnectKodaXHostOptions } from './host-protocol/remote-host.js';
export { createRequestId } from './host-protocol/host-client.js';
export type {
  KodaXHostClient, HostCallableMethod, HostCallParams, HostCallResult, HostCallOptions,
  HostConnectionState, HostSessionObserver, HostSessionObservation, HostSessionView,
} from './host-protocol/host-client.js';
export { HostProtocolError, type HostErrorCode } from './host-protocol/codec.js';
