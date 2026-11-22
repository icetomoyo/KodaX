/**
 * The v2 method table: the one definition of what a client may send and what
 * the Host answers. Access rules, JSON Schema and the client types all derive
 * from it. Each resource defines its methods in its own file; this one holds
 * the connection's own and puts the table together.
 */
import { z } from 'zod/v4';

import { ACTOR_METHODS } from './actor.js';
import { BLOB_METHODS } from './blob.js';
import { CATALOG_METHODS } from './catalog.js';
import { CONFIG_METHODS } from './config.js';
import { DEVICE_METHODS } from './device.js';
import { EXTENSION_METHODS } from './extension.js';
import { HOST_PROTOCOL } from './codec.js';
import { HISTORY_METHODS } from './history.js';
import { HOST_ADMIN_METHODS } from './host.js';
import { INTERACTION_METHODS } from './interaction.js';
import { LEARNING_METHODS } from './learning.js';
import { LEASE_METHODS } from './lease.js';
import { MCP_METHODS } from './mcp.js';
import { hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { RUN_METHODS } from './run.js';
import { SESSION_METHODS } from './session.js';
import { SETTINGS_METHODS } from './settings.js';
import { STATS_METHODS } from './stats.js';
import { VIEW_METHODS } from './view.js';
import { WORKFLOW_METHODS } from './workflow.js';

export { hostCommandParams, hostList, hostParams, hostResult } from './schema.js';
export type { HostMethodRegistry, HostMethodSpec, HostPrimitive } from './schema.js';

const RpcId = z.union([z.string().min(1).max(128), z.int()]);

const InitializeParams = hostParams({
  protocol: z.literal(HOST_PROTOCOL),
  /** The newest revision the client speaks. The connection uses the lower of the two sides'. */
  revision: z.int().min(1),
  client: z.strictObject({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    /** Stable for one installed client, so its requests and leases survive a reconnect. */
    instanceId: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/),
    /**
     * Proves a reconnecting client is the same instance. Without it the id
     * alone identifies the client, and its leases end with each connection.
     */
    instanceSecret: z.string().min(32).max(256).optional(),
  }),
  /** Absent when the transport already proved who the client is, as a paired browser's cookie does. */
  auth: z.strictObject({
    scheme: z.enum(['ipc', 'jwt']),
    token: z.string().min(1).max(8192),
  }).optional(),
});

const InitializeResult = hostResult({
  protocol: z.literal(HOST_PROTOCOL),
  revision: z.int().min(1),
  /** For display and diagnosis. Clients decide what to offer from `methods` and `locks`. */
  role: z.enum(['owner', 'user', 'service']),
  subject: z.string(),
  host: z.object({ id: z.string(), version: z.string() }),
  /** Every method this connection may call. */
  methods: z.array(z.string()),
  features: z.array(z.string()),
  /** Settings the Host operator fixed for this connection. */
  locks: z.array(z.string()),
  /** When the credential ends, in UTC milliseconds. Absent when it does not expire. */
  expiresAt: z.int().optional(),
  limits: z.object({
    maxFrameBytes: z.int().positive(),
    /**
     * The Host hangs up when it hears nothing from the client for this long, so
     * the client pings more often. The client may treat the same silence from
     * the Host as a lost connection. Absent on a local connection.
     */
    idleTimeoutMs: z.int().positive().optional(),
    /** The most bytes one `blob.write` carries and one `blob.read` returns. */
    blobChunkBytes: z.int().positive().optional(),
    /** The most bytes one blob may hold. */
    maxBlobBytes: z.int().positive().optional(),
    /** The most bytes all the blobs on the Host may hold together. An upload that would pass it is refused. */
    blobQuotaBytes: z.int().positive().optional(),
  }),
});

export type HostInitializeParams = z.output<typeof InitializeParams>;
export type HostInitializeResult = z.output<typeof InitializeResult>;
export type HostLimits = HostInitializeResult['limits'];

const CONNECTION_METHODS = {
  'initialize': { primitive: 'handshake', plane: 'data', params: InitializeParams, result: InitializeResult },
  'ping': { primitive: 'query', plane: 'data', params: hostParams({}), result: hostResult({}) },
  // A new token for the same subject and role, sent before `expiresAt`. Any other subject or role ends the connection.
  'auth.renew': {
    primitive: 'handshake',
    plane: 'data',
    params: hostParams({ token: z.string().min(1).max(8192) }),
    result: hostResult({ expiresAt: z.int().optional() }),
  },
  // `id` is the JSON-RPC id of the request to give up. A command's `requestId` names its intent and is something else.
  'request.cancel': { primitive: 'notification', plane: 'data', params: hostParams({ id: RpcId }) },
} as const satisfies HostMethodRegistry;

export const HOST_METHODS = {
  ...CONNECTION_METHODS,
  ...CATALOG_METHODS,
  ...SESSION_METHODS,
  ...SETTINGS_METHODS,
  ...VIEW_METHODS,
  ...HISTORY_METHODS,
  ...RUN_METHODS,
  ...BLOB_METHODS,
  ...INTERACTION_METHODS,
  ...STATS_METHODS,
  ...ACTOR_METHODS,
  ...WORKFLOW_METHODS,
  ...HOST_ADMIN_METHODS,
  ...DEVICE_METHODS,
  ...CONFIG_METHODS,
  ...MCP_METHODS,
  ...EXTENSION_METHODS,
  ...LEARNING_METHODS,
  ...LEASE_METHODS,
} as const satisfies HostMethodRegistry;

export type HostMethodName = keyof typeof HOST_METHODS;

type SchemaOutput<Schema> = Schema extends z.ZodType ? z.output<Schema> : never;
type SpecOf<Method extends HostMethodName> = (typeof HOST_METHODS)[Method];

/** What a handler receives: the params after they passed the method's schema. */
export type HostParams<Method extends HostMethodName> = SchemaOutput<SpecOf<Method>['params']>;

/** What any role is answered. */
export type HostResult<Method extends HostMethodName> =
  SpecOf<Method> extends { readonly result: infer Schema } ? SchemaOutput<Schema> : never;

/** What the owner on the Host's own machine is answered: the result, plus Host paths where the method has any. */
export type HostLocalResult<Method extends HostMethodName> =
  SpecOf<Method> extends { readonly localResult: infer Schema } ? SchemaOutput<Schema> : HostResult<Method>;

/** The whole contract as plain data: what the drift test records and what other languages generate from. */
export function hostMethodContract(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(HOST_METHODS as HostMethodRegistry).map(([name, spec]) => [name, {
    primitive: spec.primitive,
    plane: spec.plane,
    // What a client may send, then what the Host produces.
    params: z.toJSONSchema(spec.params, { io: 'input' }),
    ...(spec.restricted !== undefined ? { restricted: spec.restricted } : {}),
    ...(spec.result !== undefined ? { result: z.toJSONSchema(spec.result) } : {}),
    ...(spec.localResult !== undefined ? { localResult: z.toJSONSchema(spec.localResult) } : {}),
  }]));
}
