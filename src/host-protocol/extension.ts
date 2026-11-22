/**
 * What extends the Host: the extension modules it loaded, and the external
 * Agents registered for its Runs to hand tasks to. Only the owner may see or
 * change them for now; a platform may later open them to the person.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';

const Extension = z.object({
  /** Where the module is, as a path on the Host. */
  path: z.string(),
  label: z.string(),
  /** How the Host found it: `config`, `cli`, `api` or `discovery`. */
  loadSource: z.string(),
});

const ExtensionFailure = z.object({
  /** `load`, `reload`, `event`, `hook`, `persistence` or `dispose`. */
  stage: z.string(),
  target: z.string(),
  message: z.string(),
  occurredAt: z.string(),
});

/** `active` is false when the Host runs without extensions, and the lists are then empty. */
const Extensions = hostResult({ active: z.boolean(), extensions: z.array(Extension), failures: z.array(ExtensionFailure) });

const AgentId = z.string().min(1).max(256);

/**
 * An external Agent's registration as anyone may read it. `configurationRevision`
 * names its content; `managementOwner` is the manager that claimed it, if any.
 */
const Registration = z.object({
  agentId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  managementOwner: z.string().optional(),
  enabled: z.boolean(),
  executorId: z.string(),
  protocol: z.string(),
  configurationRevision: z.string(),
  endpointIdentityHash: z.string(),
  /** Whether a credential is bound to it. The credential itself never comes back. */
  credentialConfigured: z.boolean(),
  capabilities: z.record(z.string(), z.unknown()),
  effects: z.record(z.string(), z.unknown()),
  health: z.record(z.string(), z.unknown()).optional(),
  diagnostics: z.array(z.string()),
});

/**
 * Conditions a change to a registration must meet, or it fails with
 * `conflict`: `ifRevision` is the `configurationRevision` it must still have,
 * and `ifOwner` the `managementOwner`. `null` means there must be none.
 */
const Conditions = {
  ifRevision: z.string().min(1).max(256).nullable().optional(),
  ifOwner: z.string().min(1).max(256).nullable().optional(),
};

export const EXTENSION_METHODS = {
  'extension.list': { primitive: 'query', plane: 'settings', params: hostParams({}), result: Extensions },
  /**
   * Loads again the extensions the Host has loaded, so a changed module takes
   * effect. One that fails is listed under `failures`; the others still load.
   * An extension newly added to the configuration, or one that failed when the
   * Host started, loads at the next restart.
   */
  'extension.reload': { primitive: 'command', plane: 'settings', params: hostCommandParams({}), result: Extensions },
  /** Fails with `method_not_found` when the Host was started without external Agents. */
  'agent.registration.list': {
    primitive: 'query', plane: 'settings', params: hostParams({}), result: hostList(Registration),
  },
  /**
   * Registers an external Agent, or replaces the one of the same `agentId`.
   * The same content under the same `configurationRevision` is safe to send
   * again; different content must come with a new revision.
   */
  'agent.registration.upsert': {
    primitive: 'command',
    plane: 'settings',
    params: hostCommandParams({ registration: z.record(z.string(), z.unknown()), ...Conditions }),
    result: hostResult({ registration: Registration }),
  },
  /**
   * Turns an Agent on or off. `claimOwner` also claims an Agent no manager
   * owns yet. Fails with `not_found` when no Agent has the id.
   */
  'agent.registration.setEnabled': {
    primitive: 'command',
    plane: 'settings',
    params: hostCommandParams({ agentId: AgentId, enabled: z.boolean(), claimOwner: z.string().min(1).max(256).optional(), ...Conditions }),
    result: hostResult({ registration: Registration }),
  },
  /**
   * Answers the same whether or not the Agent was there, so it is safe to send
   * again. Fails with `conflict` when the Agent is there but no longer meets
   * `ifRevision` or `ifOwner`.
   */
  'agent.registration.remove': {
    primitive: 'command', plane: 'settings', params: hostCommandParams({ agentId: AgentId, ...Conditions }), result: hostResult({}),
  },
} as const satisfies HostMethodRegistry;
