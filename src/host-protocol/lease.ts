/**
 * Leases: what a trusted client lends the Runs it starts, which the Host asks
 * it for while they work. The one kind so far is `credential`: the client
 * keeps the provider keys and hands one over for each model call that needs
 * it, so a key never rests on the Host.
 *
 * A lease belongs to the client instance that registered it. A reconnect with
 * the same `instanceId` and `instanceSecret` keeps it, and the new connection
 * takes over from the old one. A Host that restarted holds none, so
 * `lease.resume` fails with `not_found` and the client registers again.
 *
 * The Host asks with the notification `lease.request`, sent only to the
 * connection that holds the lease, and the client answers with
 * `lease.complete`. A request the client does not answer in time, or one in
 * flight when its connection is lost, fails the model call that made it.
 */
import { z } from 'zod/v4';

import { HostId, hostCommandParams, hostParams, hostResult, type HostMethodRegistry } from './schema.js';

const Kind = z.literal('credential');

/** Names a lease that already exists. Looser than a new id, for the reason `SessionRef` is. */
const LeaseRef = z.string().min(1).max(256);

const Provider = z.string().regex(/\S/).max(128);

const Lease = z.object({
  id: z.string(),
  kind: Kind,
  /** The providers whose keys the client lends. */
  providers: z.array(z.string()),
  /** When the lease ends, in UTC milliseconds. Absent when it lasts until it is revoked. */
  expiresAt: z.int().optional(),
});

/**
 * The leases a Run started by this command uses, each by its id. Only a role
 * that reaches the trusted plane may send them; the lease must be one this
 * client instance holds.
 */
export const RunLeases = z.strictObject({
  /** The model calls of the Run get their provider keys from this lease. */
  credential: LeaseRef.optional(),
});

export const LEASE_METHODS = {
  /**
   * Lends keys for `providers`. The lease's id is the `requestId`, so a
   * register sent again answers with the same lease; one that names other
   * providers under the same id fails with `conflict`.
   */
  'lease.register': {
    primitive: 'command',
    plane: 'trusted',
    params: hostCommandParams({
      kind: Kind,
      providers: z.array(Provider).min(1).max(64),
      expiresAt: z.int().positive().optional(),
    }),
    result: hostResult({ lease: Lease }),
  },
  /** After a reconnect, whether the Host still holds the lease. Fails with `not_found` when it does not. */
  'lease.resume': {
    primitive: 'query',
    plane: 'trusted',
    params: hostParams({ kind: Kind, leaseId: LeaseRef }),
    result: hostResult({ lease: Lease }),
  },
  /** Ends the lease. Model calls that need it from then on fail. Sent again, or for a lease that is gone, it answers the same. */
  'lease.revoke': {
    primitive: 'command',
    plane: 'trusted',
    params: hostCommandParams({ kind: Kind, leaseId: LeaseRef }),
    result: hostResult({}),
  },
  /**
   * Answers one `lease.request`, by its `callId`, with the key or with why
   * there is none. `already_settled` means the request had ended already:
   * answered before, given up, or its lease revoked.
   */
  'lease.complete': {
    primitive: 'command',
    plane: 'trusted',
    params: hostCommandParams({
      kind: Kind,
      callId: HostId,
      credential: z.string().min(1).max(65_536).optional(),
      /** Shown in the Host's diagnostics. Never put the key here. */
      error: z.string().min(1).max(512).optional(),
    }),
    result: hostResult({ status: z.enum(['accepted', 'already_settled']) }),
  },
} as const satisfies HostMethodRegistry;

/**
 * What a model call needs the key for. `kind` is `run`, `operation` (a
 * compaction or a reasoning probe), `actor_turn` or `workflow`; the fields
 * that name it come with the kind.
 */
const Target = z.object({
  kind: z.string(),
  runId: z.string().optional(),
  operationId: z.string().optional(),
  operation: z.string().optional(),
  actorPath: z.string().optional(),
  turnId: z.string().optional(),
  parentRunId: z.string().optional(),
  workflowRunId: z.string().optional(),
});

/**
 * What the Host sends on its own to the connection that holds a lease. A
 * client never calls it, so it is not in the method table.
 */
export const LEASE_NOTIFICATIONS = {
  'lease.request': {
    params: z.object({
      callId: z.string(),
      kind: Kind,
      leaseId: z.string(),
      provider: z.string(),
      sessionId: z.string(),
      target: Target,
      /** `primary`, `fallback`, `classifier`, `sidecar`, `compaction`, `workflow` or `utility`. */
      purpose: z.string(),
      /** Proves which endpoint the call goes to, for a key bound to one endpoint. */
      connectionFingerprint: z.string().optional(),
      /** Present when the Host can say which key the provider just refused. */
      credentialContextVersion: z.int().optional(),
      rejectedCredentialFingerprint: z.string().optional(),
      _meta: z.record(z.string(), z.unknown()).optional(),
    }),
  },
} as const;

export type HostLeaseRequest = z.output<(typeof LEASE_NOTIFICATIONS)['lease.request']['params']>;
