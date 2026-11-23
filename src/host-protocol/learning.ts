/**
 * Learning: the Skills the Host learned from its Sessions, and what the person
 * decided about each. Only the owner may see or govern them for now.
 *
 * A capability moves through its lifecycle as the Host learns and as the
 * person decides. `nameOrSlug` names one by its name, slug or id; a name two
 * capabilities share fails with `invalid_params` (`ambiguous_name`).
 *
 * A decision the lifecycle does not allow fails with `conflict`
 * (`invalid_transition`), and so does one sent again after it took effect:
 * read the capability to see where it stands. A capability that changed while
 * the decision was being made fails with `conflict` (`revision_mismatch`).
 * That is why the SDK does not send a decision again when its answer was lost.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';

/** `skill`, `extension` or `workflow_handoff`. */
const Carrier = z.string();
/**
 * `opportunity`, `drafting`, `ready`, `testing`, `active_learned`,
 * `promoted_user`, `quarantined`, `archived` or `rejected`.
 */
const Lifecycle = z.string();

const Learning = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  carrier: Carrier,
  lifecycle: Lifecycle,
  /** Goes up with every change to the capability. */
  revision: z.int(),
  createdAt: z.int(),
  updatedAt: z.int(),
  /** The decision that produced this revision, when the lifecycle does not say: `rollback`, for one. */
  lastAction: z.string().optional(),
  /** Where the Skill is, as a path on the Host. */
  artifactPath: z.string().optional(),
  /** The revision a rollback returns to. */
  previousGoodRevision: z.int().optional(),
  diagnostics: z.array(z.string()).optional(),
  /** How a Skill on trial has fared so far. */
  canary: z.object({
    invocationCount: z.int(),
    maxInvocations: z.int(),
    verifiedSuccesses: z.int(),
    credibleNegatives: z.int(),
  }).optional(),
});

/** What happened to a capability, in the order the Host recorded it. */
const LearningEvent = z.object({
  sequence: z.int(),
  id: z.string(),
  /** `opportunity`, `drafting`, `ready`, `testing`, `activated`, `promoted`, `attention`, `archived` or `rejected`. */
  kind: z.string(),
  capabilityId: z.string(),
  capabilityRevision: z.int(),
  lifecycle: Lifecycle,
  name: z.string(),
  slug: z.string(),
  carrier: Carrier,
  createdAt: z.int(),
});

const Name = z.string().min(1).max(256);
const Decision = hostCommandParams({ nameOrSlug: Name });
const Done = hostResult({});

export const LEARNING_METHODS = {
  /** What waits for the person first: `ready`, then `quarantined`, then the rest. `revision` is the event sequence the page was read at. */
  'learning.list': {
    primitive: 'query',
    plane: 'local',
    params: hostParams({
      search: z.string().min(1).max(256).optional(),
      carrier: Carrier.max(64).optional(),
      lifecycle: Lifecycle.max(64).optional(),
      limit: z.int().min(1).max(200).optional(),
      cursor: z.string().min(1).max(1024).optional(),
    }),
    result: hostResult({ items: z.array(Learning), nextCursor: z.string().optional(), revision: z.int() }),
  },
  /** Fails with `not_found` (`capability_not_found`). */
  'learning.get': {
    primitive: 'query', plane: 'local', params: hostParams({ nameOrSlug: Name }), result: hostResult({ capability: Learning }),
  },
  /** The counts a client shows as a badge: what waits for the person and what became active. */
  'learning.snapshot': {
    primitive: 'query',
    plane: 'local',
    params: hostParams({}),
    result: hostResult({
      ready: z.int(),
      newlyActive: z.int(),
      attention: z.int(),
      active: z.int(),
      revision: z.int(),
    }),
  },
  /** The events after `afterRevision`, a sequence, oldest first. */
  'learning.events': {
    primitive: 'query',
    plane: 'local',
    params: hostParams({ afterRevision: z.int().min(0).optional() }),
    result: hostList(LearningEvent),
  },
  /** Marks the capability's latest event as seen by this client. */
  'learning.acknowledge': { primitive: 'command', resend: 'never', plane: 'local', params: Decision, result: Done },
  /** Hides the capability's latest event from this client until `until`, in UTC milliseconds. */
  'learning.snooze': {
    primitive: 'command',
    resend: 'never',
    plane: 'local',
    params: hostCommandParams({ nameOrSlug: Name, until: z.int().min(0) }),
    result: Done,
  },
  'learning.reject': { primitive: 'command', resend: 'never', plane: 'local', params: Decision, result: Done },
  /** Stops using the capability. A rollback brings back the last good revision. */
  'learning.disable': { primitive: 'command', resend: 'never', plane: 'local', params: Decision, result: Done },
  'learning.rollback': { primitive: 'command', resend: 'never', plane: 'local', params: Decision, result: Done },
  /** Puts a Skill on trial: the Host uses it a few times and watches how it fares before it becomes active. */
  'learning.review': { primitive: 'command', resend: 'never', plane: 'local', params: Decision, result: Done },
  /** Lets the Host use the capability without a trial. */
  'learning.trust': { primitive: 'command', resend: 'never', plane: 'local', params: Decision, result: Done },
  /** Makes a learned Skill one of the person's own Skills. Promoted already, it succeeds. */
  'learning.promote': {
    primitive: 'command',
    resend: 'never',
    plane: 'local',
    params: hostCommandParams({ nameOrSlug: Name, scope: z.literal('user') }),
    result: Done,
  },
} as const satisfies HostMethodRegistry;
