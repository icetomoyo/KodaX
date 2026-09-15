import {
  expandSkillForLLM,
  getSkillRegistry,
  initializeSkillRegistry,
  type SkillContext,
} from '@kodax-ai/agent';
import {
  parseBareInlineSlashReferences,
  parseInlineSkillReferences,
  type InlineSkillReference,
  type KodaXContextTokenSnapshot,
  type KodaXResult,
} from '@kodax-ai/coding';
import type { CommandInvocationRequest } from '../commands/types.js';

function collectSkillReferences(input: string): readonly InlineSkillReference[] {
  return [
    ...parseInlineSkillReferences(input),
    ...parseBareInlineSlashReferences(input),
  ].sort((left, right) => left.start - right.start);
}

export class MultipleUserSkillReferencesError extends Error {
  constructor(names: readonly string[]) {
    super(`Only one Skill can be active per request; found: ${names.join(', ')}.`);
    this.name = 'MultipleUserSkillReferencesError';
  }
}

export interface UserSkillReference {
  readonly name: string;
  readonly argumentsText: string;
}

/** Parse explicit slash syntax without performing discovery or expansion. */
export function parseUserSkillReferences(input: string): readonly UserSkillReference[] {
  const references = collectSkillReferences(input);
  return references.map((reference, index) => ({
    name: reference.name,
    argumentsText: input.slice(reference.end, references[index + 1]?.start).trim(),
  }));
}

export function assertSingleKnownUserSkillReference(
  input: string,
  hasSkill: (name: string) => boolean,
): UserSkillReference | undefined {
  const knownReferences = parseUserSkillReferences(input)
    .filter((reference) => hasSkill(reference.name));
  if (knownReferences.length > 1) {
    throw new MultipleUserSkillReferencesError(
      knownReferences.map((reference) => reference.name),
    );
  }
  return knownReferences[0];
}

/** Classify a busy-turn slash reference without waiting on discovery. */
export function findQueueableUserSkillReference(
  input: string,
  hasSkill: (name: string) => boolean,
  registryReady: boolean,
): UserSkillReference | undefined {
  const references = parseUserSkillReferences(input);
  return assertSingleKnownUserSkillReference(input, hasSkill)
    ?? (registryReady ? undefined : references[0]);
}

/** Resolve only trusted registry membership; do not load or expand the Skill. */
export async function resolveUserSkillReference(
  input: string,
  context: SkillContext,
): Promise<UserSkillReference | undefined> {
  const projectRoot = context.projectRoot ?? context.workingDirectory;
  let registry = getSkillRegistry(projectRoot);
  if (registry.size === 0) {
    registry = await initializeSkillRegistry(projectRoot);
  }
  return assertSingleKnownUserSkillReference(input, (name) => registry.has(name));
}

export async function createUserSkillInvocation(
  name: string,
  argumentsText: string,
  context: SkillContext,
): Promise<CommandInvocationRequest | undefined> {
  const projectRoot = context.projectRoot ?? context.workingDirectory;
  let registry = getSkillRegistry(projectRoot);
  if (registry.size === 0) {
    registry = await initializeSkillRegistry(projectRoot);
  }
  if (!registry.has(name)) return undefined;

  const skill = await registry.loadFull(name);
  const expanded = await expandSkillForLLM(skill, argumentsText, context);
  return {
    prompt: expanded.content,
    source: 'skill',
    displayName: name,
    path: skill.skillFilePath,
    disableModelInvocation: expanded.disableModelInvocation,
    userInvocable: true,
    allowedTools: skill.allowedTools,
    context: skill.context,
    agent: skill.agent,
    argumentHint: skill.argumentHint,
    model: skill.model,
    hooks: skill.hooks,
    skillInvocation: {
      name,
      path: skill.skillFilePath,
      description: skill.description,
      arguments: argumentsText || undefined,
      allowedTools: skill.allowedTools,
      context: skill.context,
      agent: skill.agent,
      argumentHint: skill.argumentHint,
      model: skill.model,
      hookEvents: skill.hooks
        ? Object.entries(skill.hooks)
            .filter(([, hooks]) => Array.isArray(hooks) && hooks.length > 0)
            .map(([eventName]) => eventName)
        : undefined,
      expandedContent: expanded.content,
    },
  };
}

/**
 * Explicit Skill preparation for unbound surfaces. In the product
 * fixed-Host wiring the Host owns Skill expansion during input admission,
 * so no client-side Host binding exists or is needed.
 */
export async function prepareUserSkillInvocation(
  name: string,
  argumentsText: string,
  context: SkillContext,
): Promise<CommandInvocationRequest | undefined> {
  return createUserSkillInvocation(name, argumentsText, context);
}

/** Resolve-then-prepare form (raw input text). */
export async function prepareUserSkillInvocationFromInput(
  input: string,
  context: SkillContext,
): Promise<CommandInvocationRequest | undefined> {
  const reference = await resolveUserSkillReference(input, context);
  return reference
    ? prepareUserSkillInvocation(reference.name, reference.argumentsText, context)
    : undefined;
}

export async function resolveUserSkillInvocation(
  input: string,
  context: SkillContext,
): Promise<CommandInvocationRequest | undefined> {
  const reference = await resolveUserSkillReference(input, context);
  return reference
    ? createUserSkillInvocation(reference.name, reference.argumentsText, context)
    : undefined;
}

export function preserveQueuedSkillContextSnapshot(
  result: KodaXResult,
  snapshot: KodaXContextTokenSnapshot | undefined,
): KodaXResult {
  return { ...result, contextTokenSnapshot: snapshot };
}
