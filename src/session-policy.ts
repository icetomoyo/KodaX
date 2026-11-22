/**
 * What the creator of a Session fixed for every Run of it: the middle of the
 * chain Host ⊇ Session ⊇ Run. It binds a Run whoever submits it, and nothing a
 * Run brings can widen it.
 */
import { isDeepStrictEqual } from 'node:util';

import { assertKodaXPromptSpec, resolveWorkMode } from '@kodax-ai/coding';
import type { ClientRunOptions, ClientSessionPolicy, KodaXAgentProfile, KodaXPromptSpec } from '@kodax-ai/coding/client-contract';

import { createExecutionToolPolicy, intersectExecutionToolCeilings } from './execution-profile.js';
import type { RuntimeKodaXOptions } from './sdk-runtime.js';

const PROFILE_FIELDS = ['surface', 'id', 'version', 'name', 'instructions'] as const;
const BUDGET_FIELDS = ['maxIter', 'maxDurationMs'] as const;
/** The longest wait a timer of the platform holds. */
const LONGEST_DURATION_MS = 2 ** 31 - 1;

const SESSION_POLICY = 'Session policy';
const RUN_OPTIONS = 'Run options';

function invalid(message: string, what = SESSION_POLICY): Error {
  return Object.assign(new Error(`Invalid ${what}: ${message}`), { code: 'invalid_params' as const });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKnownFields(value: Record<string, unknown>, known: readonly string[], where: string, what?: string): void {
  const unknown = Object.keys(value).find(key => !known.includes(key));
  if (unknown !== undefined) throw invalid(`${where}${unknown} is not something this Host enforces`, what);
}

function parseTools(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((name): name is string => typeof name === 'string' && name.trim().length > 0)) {
    throw invalid('tools must be a list of tool names');
  }
  return [...new Set(value)];
}

function parseBudget(value: unknown, what?: string): NonNullable<ClientSessionPolicy['budget']> | undefined {
  if (!isRecord(value)) throw invalid('budget must be an object', what);
  assertKnownFields(value, BUDGET_FIELDS, 'budget.', what);
  const budget: { -readonly [Field in typeof BUDGET_FIELDS[number]]?: number } = {};
  for (const name of BUDGET_FIELDS) {
    const limit = value[name];
    if (limit === undefined) continue;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1) throw invalid(`budget.${name} must be a positive whole number`, what);
    budget[name] = Number(limit);
  }
  if (budget.maxDurationMs !== undefined && budget.maxDurationMs > LONGEST_DURATION_MS) {
    throw invalid(`budget.maxDurationMs must be at most ${LONGEST_DURATION_MS}`, what);
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function parseAgentProfile(value: unknown): KodaXAgentProfile {
  if (!isRecord(value)) throw invalid('agentProfile must be an object');
  assertKnownFields(value, PROFILE_FIELDS, 'agentProfile.');
  const profile: { -readonly [Field in typeof PROFILE_FIELDS[number]]?: string } = {};
  for (const name of PROFILE_FIELDS) {
    const text = value[name];
    if (text === undefined) continue;
    if (typeof text !== 'string') throw invalid(`agentProfile.${name} must be text`);
    profile[name] = text;
  }
  return profile;
}

/**
 * Reads the policy a client sent or a Session stored. A field this Host does
 * not enforce is refused, so no limit is accepted and then ignored. A policy
 * that fixes nothing reads as none.
 */
export function parseSessionPolicy(value: unknown): ClientSessionPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid('must be an object');
  assertKnownFields(value, ['tools', 'budget', 'agentProfile', 'prompt', 'interactions'], '');
  const budget = value.budget === undefined ? undefined : parseBudget(value.budget);
  if (value.prompt !== undefined) assertKodaXPromptSpec(value.prompt);
  const { interactions } = value;
  if (interactions !== undefined && interactions !== 'wait' && interactions !== 'reject') {
    throw invalid('interactions must be wait or reject');
  }
  const policy: ClientSessionPolicy = {
    ...(value.tools === undefined ? {} : { tools: parseTools(value.tools) }),
    ...(budget === undefined ? {} : { budget }),
    ...(value.agentProfile === undefined ? {} : { agentProfile: parseAgentProfile(value.agentProfile) }),
    ...(value.prompt === undefined ? {} : { prompt: structuredClone(value.prompt) }),
    ...(interactions === undefined ? {} : { interactions }),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * Reads what a submitter asks for one Run: limits of its own and application
 * prompt entries. It has the shape of the same two fields of a Session policy
 * and is applied the same way, before the policy of the Session.
 */
export function parseRunOptions(value: unknown): ClientRunOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalid('must be an object', RUN_OPTIONS);
  assertKnownFields(value, ['budget', 'prompt'], '', RUN_OPTIONS);
  const budget = value.budget === undefined ? undefined : parseBudget(value.budget, RUN_OPTIONS);
  if (value.prompt !== undefined) assertKodaXPromptSpec(value.prompt);
  const options: ClientRunOptions = {
    ...(budget === undefined ? {} : { budget }),
    ...(value.prompt === undefined ? {} : { prompt: structuredClone(value.prompt) }),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * The entries of the Session come first, then what the Run adds. A Run that is
 * continued already carries the entries of the Session, so those are not added
 * twice. A Run that gives another entry under a key of the Session is refused.
 */
function joinPrompts(session: KodaXPromptSpec, run: KodaXPromptSpec | undefined): KodaXPromptSpec {
  const fixed = session.context ?? [];
  const added = (run?.context ?? []).filter(entry => !fixed.some(own => isDeepStrictEqual(own, entry)));
  const kodaxGuidance = session.kodaxGuidance ?? run?.kodaxGuidance;
  const joined: KodaXPromptSpec = structuredClone({
    ...(kodaxGuidance === undefined ? {} : { kodaxGuidance }),
    ...(fixed.length + added.length > 0 ? { context: [...fixed, ...added] } : {}),
  });
  assertKodaXPromptSpec(joined);
  return joined;
}

function lower(limit: number | undefined, own: number | undefined): number | undefined {
  return limit === undefined ? own : Math.min(limit, own ?? limit);
}

/** Binds the options a Run is about to start with to the policy of its Session. */
export function applySessionPolicy(options: RuntimeKodaXOptions, policy: ClientSessionPolicy | undefined): RuntimeKodaXOptions {
  if (policy === undefined) return options;
  const ceiling = policy.tools === undefined ? undefined : { tools: [...policy.tools] };
  const executionToolCeiling = intersectExecutionToolCeilings(options.executionToolCeiling, ceiling);
  const maxIter = lower(policy.budget?.maxIter, options.maxIter);
  const maxDurationMs = lower(policy.budget?.maxDurationMs, options.maxDurationMs);
  // The engine reads a persona or a tool limit as a request for the coding mode.
  // The policy fixes neither, so the Run keeps the mode it had without them.
  const keepsWorkMode = ceiling !== undefined || policy.agentProfile !== undefined;
  return {
    ...options,
    ...(keepsWorkMode ? { workMode: resolveWorkMode(options) } : {}),
    ...(maxIter === undefined ? {} : { maxIter }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(policy.interactions === 'reject' ? { interactions: 'reject' as const } : {}),
    ...(executionToolCeiling === undefined ? {} : { executionToolCeiling }),
    context: {
      ...options.context,
      ...(policy.agentProfile === undefined ? {} : { agentProfile: structuredClone(policy.agentProfile) }),
      ...(policy.prompt === undefined ? {} : { prompt: joinPrompts(policy.prompt, options.context?.prompt) }),
      ...(keepsWorkMode ? { workModePolicy: 'intersect' as const } : {}),
      ...(ceiling === undefined ? {} : {
        toolVisibilityPolicy: createExecutionToolPolicy(ceiling, options.context?.toolVisibilityPolicy),
      }),
    },
  };
}
