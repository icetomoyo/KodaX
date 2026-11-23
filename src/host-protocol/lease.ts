/**
 * Leases: what a trusted client lends the Runs it starts, which the Host asks
 * it for while they work. There are two kinds:
 *
 * - `credential`: the client keeps the provider keys and hands one over for
 *   each model call that needs it, so a key never rests on the Host.
 * - `host_tool`: tools the client runs itself, such as an application's
 *   business actions. The model calls them like any other tool, and the
 *   client does the work and answers with the result.
 *
 * A lease belongs to the client instance that registered it. A reconnect with
 * the same `instanceId` and `instanceSecret` keeps it, and the new connection
 * takes over from the old one. A Host that restarted holds none, so
 * `lease.resume` fails with `not_found` and the client registers again.
 *
 * The Host asks with the notification `lease.request`, sent only to the
 * connection that holds the lease, and the client answers with
 * `lease.complete`. What happens to a request nobody answers depends on the
 * kind:
 *
 * - A key request the client does not answer in time, or one in flight when
 *   its connection is lost, fails the model call that made it.
 * - A tool call waits while the client is away, and goes out when the same
 *   instance is back and sends `lease.resume`. One that was already sent when
 *   the connection was lost cannot be known to have run or not: the model is
 *   told its outcome is unknown, and `lease.call.get` tells the client the
 *   same. A call still waiting when the time limit for calls to a client
 *   passes is not run.
 */
import { z } from 'zod/v4';

import { HostId, hostCommandParams, hostParams, hostResult, type HostMethodRegistry } from './schema.js';

const Kind = z.enum(['credential', 'host_tool']);

/** Names a lease that already exists. Looser than a new id, for the reason `SessionRef` is. */
const LeaseRef = z.string().min(1).max(256);

const Provider = z.string().regex(/\S/).max(128);

/** What a tool may change. `none` reads only; the model may call it while it plans. */
const SideEffect = z.enum(['none', 'idempotent', 'non_idempotent']);

const JsonSchema = z.record(z.string(), z.unknown());

/** A tool the client runs. The model sees its name, description and input schema. */
const HostTool = z.strictObject({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/),
  description: z.string().regex(/\S/).max(4096),
  /** A JSON Schema of an object. */
  inputSchema: JsonSchema,
  /** The shape of `structuredContent` in the result, which the model may look up. */
  outputSchema: JsonSchema.optional(),
  sideEffect: SideEffect,
});

const Lease = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('credential'),
    /** The providers whose keys the client lends. */
    providers: z.array(z.string()),
    /** When the lease ends, in UTC milliseconds. Absent when it lasts until it is revoked. */
    expiresAt: z.int().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('host_tool'),
    tools: z.array(z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: JsonSchema,
      outputSchema: JsonSchema.optional(),
      sideEffect: SideEffect,
    })),
  }),
]);

/**
 * The lease a command that calls the model but starts no Run uses, by its id.
 * Only a role that reaches the trusted plane may send it; the lease must be
 * one this client instance holds.
 */
export const CredentialLeases = z.strictObject({
  /** The model calls get their provider keys from this lease. */
  credential: LeaseRef.optional(),
});

/** The leases a Run started by this command uses, each by its id, under the same rules. */
export const RunLeases = z.strictObject({
  /** The model calls of the Run get their provider keys from this lease. */
  credential: LeaseRef.optional(),
  /** The Run may call the tools of this lease. */
  hostTools: LeaseRef.optional(),
});

export const LEASE_METHODS = {
  /**
   * Registers a lease. Its id is the `requestId`, so a register sent again
   * answers with the same lease; one that lends something else under the
   * same id fails with `conflict`.
   */
  'lease.register': {
    primitive: 'command',
    resend: 'auto',
    plane: 'trusted',
    params: z.discriminatedUnion('kind', [
      hostCommandParams({
        kind: z.literal('credential'),
        /** The providers whose keys the client lends. */
        providers: z.array(Provider).min(1).max(64),
        expiresAt: z.int().positive().optional(),
      }),
      hostCommandParams({
        kind: z.literal('host_tool'),
        /** Names must be unique in the lease and must not be the name of a tool the Host has. */
        tools: z.array(HostTool).min(1).max(64),
      }),
    ]),
    result: hostResult({ lease: Lease }),
  },
  /**
   * After a reconnect, whether the Host still holds the lease. Fails with
   * `not_found` when it does not. For a `host_tool` lease it also sends the
   * calls that waited while the client was away.
   */
  'lease.resume': {
    primitive: 'query',
    plane: 'trusted',
    params: hostParams({ kind: Kind, leaseId: LeaseRef }),
    result: hostResult({ lease: Lease }),
  },
  /**
   * Ends the lease. Model calls that need a key from it, or Runs that would
   * call its tools, fail from then on. Sent again, or for a lease that is
   * gone, it answers the same.
   */
  'lease.revoke': {
    primitive: 'command',
    resend: 'auto',
    plane: 'trusted',
    params: hostCommandParams({ kind: Kind, leaseId: LeaseRef }),
    result: hostResult({}),
  },
  /**
   * Answers one `lease.request`, by its `callId`. A key request is answered
   * with `credential` or `error`, a tool call with `result` or `error`.
   * `already_settled` means the request had ended already: answered before,
   * given up, or its lease revoked. A tool call answered with `error` is
   * reported to the model as a call whose outcome is unknown.
   */
  'lease.complete': {
    primitive: 'command',
    resend: 'auto',
    plane: 'trusted',
    params: z.discriminatedUnion('kind', [
      hostCommandParams({
        kind: z.literal('credential'),
        callId: HostId,
        credential: z.string().min(1).max(65_536).optional(),
        /** Shown in the Host's diagnostics. Never put the key here. */
        error: z.string().min(1).max(512).optional(),
      }),
      hostCommandParams({
        kind: z.literal('host_tool'),
        callId: HostId,
        result: z.strictObject({
          /** What the model reads. */
          content: z.string(),
          /** Data for the application, shaped by the tool's `outputSchema`. */
          structuredContent: z.unknown().optional(),
        }).optional(),
        error: z.string().min(1).max(512).optional(),
      }),
    ]),
    result: hostResult({ status: z.enum(['accepted', 'already_settled']) }),
  },
  /**
   * What the Host recorded for one tool call of this client instance, such as
   * one it was handling when its connection was lost. The Host keeps the
   * latest thousand calls. Fails with `not_found` for a call it does not have.
   */
  'lease.call.get': {
    primitive: 'query',
    plane: 'trusted',
    params: hostParams({ callId: HostId }),
    result: hostResult({
      call: z.object({
        callId: z.string(),
        leaseId: z.string(),
        tool: z.string(),
        sessionId: z.string(),
        runId: z.string(),
        /**
         * `waiting`: not sent yet, because the client was away.
         * `sent`: sent and not answered yet.
         * `completed`: answered with a result.
         * `unknown`: sent, then the connection was lost, the time limit passed, or the client answered with `error`.
         * `not_sent`: never sent before the time limit passed.
         */
        state: z.enum(['waiting', 'sent', 'completed', 'unknown', 'not_sent']),
        /** When the state last changed, in UTC milliseconds. */
        updatedAt: z.int(),
      }),
    }),
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

const Meta = z.record(z.string(), z.unknown()).optional();

/**
 * What the Host sends on its own to the connection that holds a lease. A
 * client never calls it, so it is not in the method table.
 */
export const LEASE_NOTIFICATIONS = {
  'lease.request': {
    params: z.discriminatedUnion('kind', [
      z.object({
        callId: z.string(),
        kind: z.literal('credential'),
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
        _meta: Meta,
      }),
      z.object({
        callId: z.string(),
        kind: z.literal('host_tool'),
        leaseId: z.string(),
        sessionId: z.string(),
        runId: z.string(),
        tool: z.string(),
        /** What the model passed, as its input schema describes. */
        input: z.record(z.string(), z.unknown()),
        sideEffect: SideEffect,
        _meta: Meta,
      }),
    ]),
  },
} as const;

export type HostLeaseRequest = z.output<(typeof LEASE_NOTIFICATIONS)['lease.request']['params']>;
export type HostCredentialRequest = Extract<HostLeaseRequest, { readonly kind: 'credential' }>;
export type HostToolCall = Extract<HostLeaseRequest, { readonly kind: 'host_tool' }>;
