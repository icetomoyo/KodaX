/**
 * The leases the REPL lends the Runs it starts on a v2 Host. The CLI's
 * authorizer keeps provider keys in this process and binds them to the Host it
 * is connected to; a new Host gets a new lease, because its id changed.
 */
import type {
  KodaXClientExecutionRequest,
  KodaXClientHostAuthorization,
  KodaXClientHostServices,
} from '../client-host-authorization.js';
import { createHostCredentialService } from '../host-credentials.js';
import type { HostCallParams, KodaXHostClient } from '../host-protocol/host-client.js';

export type ReplRunLeases = NonNullable<HostCallParams<'input.submit'>['leases']>;

/** What a Run started for `request` sends as its `leases`; undefined when the CLI lends nothing. */
export type ReplLeases = (request: KodaXClientExecutionRequest) => Promise<ReplRunLeases | undefined>;

/** The CLI authorizer reaches for keys alone; a service a v2 Host has no counterpart for fails loudly instead of acting. */
async function unsupported(name: string): Promise<never> {
  throw new Error(`The REPL lends a v2 Host provider keys only; ${name} has no v2 counterpart.`);
}

const NO_HOST_TOOLS: KodaXClientHostServices['hostTools'] = {
  register: () => unsupported('hostTools.register'),
  resume: () => unsupported('hostTools.resume'),
  getInvocation: () => unsupported('hostTools.getInvocation'),
  revoke: () => unsupported('hostTools.revoke'),
};

const NO_EXECUTION_BINDINGS: KodaXClientHostServices['executionBindings'] = {
  register: () => unsupported('executionBindings.register'),
  revoke: () => unsupported('executionBindings.revoke'),
};

/** Takes over the client's lease requests, so make one per client. */
export function createReplLeases(client: KodaXHostClient<'local'>, authorize: KodaXClientHostAuthorization): ReplLeases {
  const credentials = createHostCredentialService(client);
  return async (request) => {
    const authorization = await authorize(request, {
      identity: { runtimeId: client.handshake.host.id },
      credentials,
      hostTools: NO_HOST_TOOLS,
      executionBindings: NO_EXECUTION_BINDINGS,
      createExecutionProfile: () => unsupported('createExecutionProfile'),
    });
    if (authorization === undefined) return undefined;
    const { credential, ...rest } = authorization;
    // Anything else the authorizer grants would be dropped on the way to the Host, so it is refused rather than lost.
    const dropped = Object.keys(rest);
    if (dropped.length > 0) throw new Error(`A v2 Host takes no ${dropped.join(', ')} from the REPL.`);
    return credential === undefined ? undefined : { credential: credential.leaseId };
  };
}
