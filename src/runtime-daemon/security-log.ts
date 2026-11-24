/**
 * The security events a Host records: a refused credential, an approval
 * decision, a backend's use of trusted authority, and a device paired or
 * revoked. Who approved what is something only the Host knows. Each event goes
 * out as a diagnostic from `host.security`, so the daemon log carries it, and
 * so does the stdout of a `daemon serve` an operator runs. An event names what
 * happened and never carries a token, a credential or a parameter value.
 */
import { emitKodaXDiagnostic } from '@kodax-ai/agent';

import type { RuntimeConnectionRole } from './access.js';

/** Who acted: the role, the credential's subject (a JWT `sub` or a device ID), and the client it named. */
export interface HostSecurityActor {
  readonly role: RuntimeConnectionRole;
  readonly subject?: string;
  readonly client?: string;
}

export type HostSecurityEvent =
  /** `path` names the HTTP endpoint refused, for a caller other than a v2 connection. */
  | { readonly event: 'auth_failed'; readonly reason: string; readonly origin?: string; readonly path?: string }
  | {
    readonly event: 'permission_decided';
    readonly actor: HostSecurityActor;
    readonly sessionId: string;
    readonly runId: string;
    readonly tool: string;
    readonly decision: 'allow_once' | 'allow_session' | 'allow_always' | 'reject';
  }
  | { readonly event: 'trusted_use'; readonly actor: HostSecurityActor; readonly method: string; readonly params: readonly string[] }
  | { readonly event: 'device_paired'; readonly device: string; readonly name: string; readonly origin: string }
  | { readonly event: 'device_revoked'; readonly device: string; readonly name: string };

export function reportHostSecurityEvent(event: HostSecurityEvent): void {
  emitKodaXDiagnostic({
    source: 'host.security',
    level: event.event === 'auth_failed' ? 'warn' : 'info',
    message: event.event,
    detail: event,
  });
}
