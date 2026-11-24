/**
 * Learning: the Skills the Host learned from its Sessions, and what the person
 * decided about each.
 *
 * A capability moves through its lifecycle as the Host learns and as the
 * person decides. `nameOrSlug` names one by its name, slug or id; a name two
 * capabilities share fails with `invalid_params` (`ambiguous_name`).
 *
 * A decision whose outcome the capability already has succeeds without doing
 * anything, so one sent again answers as the first did. A decision the
 * lifecycle does not allow fails with `conflict` (`invalid_transition`).
 * `ifRevision` makes a decision apply only to the revision the client read;
 * a capability that changed meanwhile fails with `conflict`
 * (`revision_mismatch`): read it again. With `ifRevision`, an outcome
 * counts as already made only at the revision right after it.
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

/** How many capabilities wait on the person, and the revision they were counted at. */
export const LearningCounts = z.object({
  ready: z.int(),
  newlyActive: z.int(),
  attention: z.int(),
  active: z.int(),
  revision: z.int(),
});

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

/** `artifactPath` is where the Skill is on the Host's machine. */
const LocalLearning = Learning.extend({ artifactPath: z.string().optional() });

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
const Notice = hostCommandParams({ nameOrSlug: Name });
const Decision = hostCommandParams({ nameOrSlug: Name, ifRevision: z.int().min(0).optional() });
const Done = hostResult({});

export const LEARNING_METHODS = {
  /** What waits for the person first: `ready`, then `quarantined`, then the rest. `revision` is the event sequence the page was read at. */
  'learning.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      search: z.string().min(1).max(256).optional(),
      carrier: Carrier.max(64).optional(),
      lifecycle: Lifecycle.max(64).optional(),
      limit: z.int().min(1).max(200).optional(),
      cursor: z.string().min(1).max(1024).optional(),
    }),
    result: hostResult({ items: z.array(Learning), nextCursor: z.string().optional(), revision: z.int() }),
    localResult: hostResult({ items: z.array(LocalLearning), nextCursor: z.string().optional(), revision: z.int() }),
  },
  /** Fails with `not_found` (`capability_not_found`). */
  'learning.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ nameOrSlug: Name }),
    result: hostResult({ capability: Learning }),
    localResult: hostResult({ capability: LocalLearning }),
  },
  /** The counts a client shows as a badge: what waits for the person and what became active. */
  'learning.snapshot': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({}),
    result: hostResult(LearningCounts.shape),
  },
  /** The events after `afterRevision`, a sequence, oldest first. */
  'learning.events': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ afterRevision: z.int().min(0).optional() }),
    result: hostList(LearningEvent),
  },
  /** Marks the capability's latest event as seen by this client. */
  'learning.acknowledge': { primitive: 'command', resend: 'auto', plane: 'data', params: Notice, result: Done },
  /** Hides the capability's latest event from this client until `until`, in UTC milliseconds. */
  'learning.snooze': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ nameOrSlug: Name, until: z.int().min(0) }),
    result: Done,
  },
  'learning.reject': { primitive: 'command', resend: 'auto', plane: 'data', params: Decision, result: Done },
  /** Stops using the capability. A rollback brings back the last good revision. */
  'learning.disable': { primitive: 'command', resend: 'auto', plane: 'data', params: Decision, result: Done },
  'learning.rollback': { primitive: 'command', resend: 'auto', plane: 'data', params: Decision, result: Done },
  /** Puts a Skill on trial: the Host uses it a few times and watches how it fares before it becomes active. */
  'learning.review': { primitive: 'command', resend: 'auto', plane: 'data', params: Decision, result: Done },
  /** Lets the Host use the capability without a trial. */
  'learning.trust': { primitive: 'command', resend: 'auto', plane: 'data', params: Decision, result: Done },
  /** Makes a learned Skill one of the person's own Skills. Promoted already, it succeeds. */
  'learning.promote': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ nameOrSlug: Name, scope: z.literal('user'), ifRevision: z.int().min(0).optional() }),
    result: Done,
  },
} as const satisfies HostMethodRegistry;
