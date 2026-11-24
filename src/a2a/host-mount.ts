/**
 * A2A served on the Host's own network port at `/a2a`. The Host checks the
 * caller's JWT with the same check and the same `owner`/`services` list as a
 * v2 connection, so an A2A caller is one of the people or backends the Host
 * already admits, not a third kind of identity. A2A keys its tasks by the
 * subject the Host admitted, under the realm `kodax-host`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';

import { sendFetchResponse, toFetchRequest } from './node-http.js';
import type { A2AAuthentication, A2APrincipal, KodaXA2AServer } from './types.js';

/** What the Host's port calls for an A2A request: with the subject it admitted, or none when it admitted nobody. */
export interface HostA2AMount {
  serve(request: IncomingMessage, response: ServerResponse, subject: string | undefined): void;
}

export interface HostA2AMountFactory {
  /** The A2A server's authentication: whom the Host admitted for the request, and nobody for one that did not come through it. */
  readonly authentication: A2AAuthentication;
  mount(server: Pick<KodaXA2AServer, 'handle'>): HostA2AMount;
}

export function createHostA2AMount(): HostA2AMountFactory {
  const admitted = new WeakMap<Request, A2APrincipal>();
  return {
    authentication: {
      securityRealm: 'kodax-host',
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      authenticate: async request => admitted.get(request) ?? null,
    },
    mount: server => ({
      serve(request, response, subject) {
        // Inside the chain, so a request fetch cannot represent is answered rather than thrown at the listener.
        Promise.resolve().then(() => {
          const fetchRequest = toFetchRequest(request);
          if (subject !== undefined) admitted.set(fetchRequest, { subject, scopes: ['a2a:invoke'] });
          return server.handle(fetchRequest);
        }).then(result => sendFetchResponse(response, result)).catch((error: unknown) => {
          emitKodaXDiagnostic({
            source: 'host.network', level: 'warn', message: 'The Host could not answer an A2A request.',
            detail: { error: error instanceof Error ? error.message : String(error) },
          });
          if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end('{"error":"Internal server error."}');
          else response.destroy();
        });
      },
    }),
  };
}
