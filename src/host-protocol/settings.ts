/**
 * Settings: what a person chose for one Session, such as which model answers
 * and what it may do without asking. A setting that is absent follows the
 * Host's default. A change reaches the Session's Runs that are already going.
 *
 * `session.settings.get` answers with the Session's own choices. The Session
 * view shows what is in effect: those choices, and the Host's default wherever
 * the Session made none.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { SessionRef } from './session.js';

const PermissionMode = z.enum(['plan', 'accept-edits', 'auto', 'full-access']);
const WorkMode = z.enum(['agent', 'coding', 'script']);
const RepoIntelligenceMode = z.enum(['auto', 'off', 'light', 'full']);

export const Settings = z.object({
  provider: z.string(),
  model: z.string(),
  /** How hard the model thinks. Which names a model accepts is up to its provider. */
  effort: z.string(),
  /** The effort while `permissionMode` is `plan`, unless `effort` is set. */
  planModeEffort: z.string(),
  /**
   * How much tools may do before a person is asked, from the most careful to the least.
   * `plan` changes nothing in the project. In `auto` the Host judges each call.
   */
  permissionMode: PermissionMode,
  /** The kind of work the Session does. It cannot change once the Session has history. */
  workMode: WorkMode,
  /** The model that judges tool calls in `auto`. */
  autoModeClassifierModel: z.string(),
  /** How full the context gets, in percent, before the Host summarises the older part. */
  compactionTriggerPercent: z.number(),
  /** The same threshold in tokens. Zero turns it off. */
  compactionTriggerTokens: z.number(),
  /** The most turns one Run takes before the Host stops it. */
  maxIter: z.number(),
  /** How much of the repository the Host indexes for the model. */
  repoIntelligenceMode: RepoIntelligenceMode,
  repoIntelligenceTrace: z.boolean(),
  /** Whether the model thinks while it summarises, and how hard. */
  compactionReasoning: z.union([z.boolean(), z.object({ effort: z.string() })]),
}).partial();

const Model = z.string().min(1).max(256);
const Effort = z.string().min(1).max(64);

/** Names the settings to change. `null` clears one, so it follows the Host's default again. */
const SettingsPatch = z.strictObject({
  provider: z.string().min(1).max(128).nullable(),
  model: Model.nullable(),
  effort: Effort.nullable(),
  planModeEffort: Effort.nullable(),
  permissionMode: PermissionMode.nullable(),
  workMode: WorkMode.nullable(),
  autoModeClassifierModel: Model.nullable(),
  compactionTriggerPercent: z.number().min(0).max(100).nullable(),
  compactionTriggerTokens: z.int().min(0).nullable(),
  maxIter: z.int().min(1).nullable(),
  repoIntelligenceMode: RepoIntelligenceMode.nullable(),
  repoIntelligenceTrace: z.boolean().nullable(),
  compactionReasoning: z.union([z.boolean(), z.strictObject({ effort: Effort })]).nullable(),
}).partial();

const SettingsState = {
  settings: Settings,
  /** Changes whenever a setting does. */
  revision: z.string(),
  /** The Session has history, so `workMode` can no longer change. */
  workModeLocked: z.boolean(),
};

export const SETTINGS_METHODS = {
  'session.settings.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ sessionId: SessionRef }),
    result: hostResult(SettingsState),
  },
  /**
   * Answers with the settings as they are after the change.
   * With `ifRevision`, fails with `conflict` when the settings changed since that revision was read,
   * unless they already hold what the patch asks, as when it is sent again after it applied.
   */
  'session.settings.update': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      patch: SettingsPatch,
      ifRevision: z.string().min(1).max(64).optional(),
    }),
    result: hostResult(SettingsState),
  },
} as const satisfies HostMethodRegistry;
