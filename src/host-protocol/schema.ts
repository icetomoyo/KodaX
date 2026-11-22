/**
 * What every v2 method definition is built from. A client's params are strict:
 * a field the contract does not name is an error. A Host's result is cut to the
 * contract: a field the contract does not name is dropped before it is sent, so
 * an internal type gaining a field neither leaks it nor fails the method.
 */
import { z } from 'zod/v4';

import type { RuntimeMethodPlane } from '../runtime-daemon/access.js';

/**
 * What kind of exchange a method is.
 *   handshake    — opens the connection
 *   query        — reads; safe to repeat
 *   command      — changes state once per `requestId`
 *   subscription — starts or ends a stream of patches
 *   notification — one-way; gets no answer
 */
export type HostPrimitive = 'handshake' | 'query' | 'command' | 'subscription' | 'notification';

export interface HostMethodSpec {
  readonly primitive: HostPrimitive;
  readonly plane: RuntimeMethodPlane;
  readonly params: z.ZodType;
  /** Absent for a notification. */
  readonly result?: z.ZodType;
  /** Top-level params only a role that reaches the named plane may send. */
  readonly restricted?: Readonly<Record<string, RuntimeMethodPlane>>;
  /**
   * What a role that reaches the local plane is answered instead: `result`
   * plus paths on the Host's own machine. No other role is sent a Host path.
   */
  readonly localResult?: z.ZodType;
}

export type HostMethodRegistry = Readonly<Record<string, HostMethodSpec>>;

const Meta = z.record(z.string(), z.unknown());

/**
 * The params of a method. `_meta` is reserved in every params and result object
 * for data that is not the method's own, such as trace context.
 */
export function hostParams<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject({ ...shape, _meta: Meta.optional() });
}

/** The result of a method. Objects inside it use `z.object`, so they are cut to the contract too. */
export function hostResult<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ ...shape, _meta: Meta.optional() });
}

/** The result of every query that lists. `nextCursor` is absent on the last page. */
export function hostList<Item extends z.ZodType>(item: Item) {
  return hostResult({ items: z.array(item), nextCursor: z.string().optional() });
}

/** An id the Host or a client chose: a Session, a Run, an input, a request. */
export const HostId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** A path on the Host's own machine. Only appears in params and results the owner exchanges. */
export const HostPath = z.string().min(1).max(4096);

/**
 * A directory inside the Host's workspace, by its path from the workspace root
 * with `/` between names; `.` is the root. How every role but the owner names a
 * place on the Host. The Host checks that it stays inside.
 */
export const WorkspacePath = z.string().min(1).max(4096).regex(/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))[^\\]+$/);

/** The start of a retry-safe command. Sending it again under the same id repeats nothing. */
export function hostCommandParams<Shape extends z.ZodRawShape>(shape: Shape) {
  return hostParams({ requestId: HostId, ...shape });
}
