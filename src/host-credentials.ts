/**
 * The credential service the CLI's authorizers bind to, served by the leases of
 * a v2 Host client. A Run's model calls then get their key from this process,
 * and the Host never stores it.
 */
import type {
  RuntimeCredentialLease,
  RuntimeCredentialService,
  RuntimeScopedCredentialBroker,
  RuntimeScopedCredentialRequest,
} from './client-host-authorization.js';
import {
  createRequestId, type HostAnswerScope, type HostCallResult, type HostCredentialRequest, type KodaXHostClient,
} from './host-protocol/host-client.js';

type HostLease = HostCallResult<'lease.register', 'shared'>['lease'];
type HostCredentialLease = Extract<HostLease, { readonly kind: 'credential' }>;

/** Takes over the client's lease requests: each goes to the broker of the lease it names. */
export function createHostCredentialService<Scope extends HostAnswerScope>(client: KodaXHostClient<Scope>): RuntimeCredentialService {
  const brokers = new Map<string, RuntimeScopedCredentialBroker>();
  client.answerLeaseRequests(async (request) => {
    const broker = brokers.get(request.leaseId);
    return broker === undefined ? undefined : await broker(toScopedRequest(request));
  });
  const lend = (lease: HostLease, broker: RuntimeScopedCredentialBroker): RuntimeCredentialLease => {
    // Asked for a credential lease, a Host that keeps the contract answers with one.
    if (lease.kind !== 'credential') throw new Error(`The Host answered with a ${lease.kind} lease where a credential lease was asked for.`);
    brokers.set(lease.id, broker);
    return toRuntimeLease(lease);
  };
  // A v2 Host lends only keys bound to the request that needs them, as every current authorizer asks for.
  const unscoped = async (): Promise<never> => {
    throw new Error('A v2 Host lends only scoped credentials; use registerScoped.');
  };
  return {
    register: unscoped,
    resume: unscoped,
    async registerScoped({ providers, expiresAt }, broker) {
      const { lease } = await client.call('lease.register', {
        requestId: createRequestId(), kind: 'credential', providers: [...providers],
        ...(expiresAt !== undefined ? { expiresAt: Date.parse(expiresAt) } : {}),
      });
      return lend(lease, broker);
    },
    async resumeScoped(leaseId, broker) {
      const { lease } = await client.call('lease.resume', { kind: 'credential', leaseId });
      return lend(lease, broker);
    },
    async revoke(leaseId) {
      brokers.delete(leaseId);
      // The Host answers the same whether or not it still held the lease.
      await client.call('lease.revoke', { requestId: createRequestId(), kind: 'credential', leaseId });
      return true;
    },
  };
}

function toRuntimeLease({ id, providers, expiresAt }: HostCredentialLease): RuntimeCredentialLease {
  return { id, providers, brokerVersion: 2, ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
}

/** The Host builds the request from the same v1 fields, so only the names of the call differ. */
function toScopedRequest({ callId, kind: _kind, _meta, ...request }: HostCredentialRequest): RuntimeScopedCredentialRequest {
  return { ...request, requestId: callId } as RuntimeScopedCredentialRequest;
}
