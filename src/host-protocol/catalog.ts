/**
 * Read-only catalogs: what a client offers a person to pick from. Values that
 * are only shown, such as `source`, are open strings, so a newer Host adding
 * one does not break an older client.
 */
import { z } from 'zod/v4';

import { hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { PROJECT_CHOICE_RESTRICTED, ProjectChoice, SessionRef } from './session.js';

const Provider = z.object({
  name: z.string(),
  /** The model this provider uses when none is chosen. */
  model: z.string(),
  models: z.array(z.string()),
  /** Whether the Host holds what it needs to call this provider. */
  configured: z.boolean(),
  source: z.string(),
  reasoningCapability: z.string(),
  capabilityProfile: z.object({
    transport: z.string(),
    conversationSemantics: z.string(),
    mcpSupport: z.string(),
    contextFidelity: z.string().optional(),
    toolCallingFidelity: z.string().optional(),
    sessionSupport: z.string().optional(),
    longRunningSupport: z.string().optional(),
    multimodalSupport: z.string().optional(),
    evidenceSupport: z.string().optional(),
  }),
});

const Command = z.object({
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  description: z.string(),
  source: z.string(),
  location: z.string().optional(),
  usage: z.string().optional(),
  argumentHint: z.string().optional(),
  userInvocable: z.boolean().optional(),
  disableModelInvocation: z.boolean().optional(),
  allowedTools: z.string().optional(),
  context: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
});

const Skill = z.object({
  name: z.string(),
  description: z.string(),
  source: z.string(),
  argumentHint: z.string().optional(),
  /** True when the Skill is hidden from the model and only a person can start it. */
  disableModelInvocation: z.boolean(),
});

/** A file a Skill brings along, by its path inside the Skill's directory. */
const SkillFile = z.object({ name: z.string(), relativePath: z.string() });

/** A Skill with its instructions as they are written: nothing in them has been filled in or run. */
const skillText = <File extends z.ZodType>(file: File) => Skill.extend({
  content: z.string(),
  scripts: z.array(file).optional(),
  references: z.array(file).optional(),
  assets: z.array(file).optional(),
  templates: z.array(file).optional(),
  resources: z.array(file).optional(),
});

/** A tool the Runs of a Session can be offered. */
const Tool = z.object({
  name: z.string(),
  /** What calling it can change, such as `readonly` or `mutates-fs`. */
  sideEffect: z.string(),
  /** Whether a Run in plan mode may call it. */
  planModeAllowed: z.boolean(),
});

/** An Agent installed on the Host: `session.create` takes its `name` as `agent`. */
const Agent = z.object({
  name: z.string(),
  description: z.string(),
  /** The only tools the Agent uses. Absent when it names none. */
  tools: z.array(z.string()).optional(),
  /** What a Session created as the Agent starts on. Absent leaves what the Host would choose. */
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

/**
 * The project whose own commands and Skills are listed next to the Host-wide
 * ones. When none is named, it is where a Session created without a project
 * works.
 */
const ProjectScope = ProjectChoice;
const PROJECT_SCOPE_RESTRICTED = PROJECT_CHOICE_RESTRICTED;

export const CATALOG_METHODS = {
  'provider.list': { primitive: 'query', plane: 'data', params: hostParams({}), result: hostList(Provider) },
  /** The efforts a Session on this model can be set to. A provider the Host does not know gets the efforts every model takes. */
  'provider.reasoning.efforts': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256).optional() }),
    result: hostList(z.string()),
  },
  /**
   * The commands `command.execute` runs: prompt commands and extension commands a person may start.
   * The REPL's own commands, such as `/model`, are not among them; the REPL runs them itself.
   */
  'command.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams(ProjectScope),
    restricted: PROJECT_SCOPE_RESTRICTED,
    result: hostList(Command),
    localResult: hostList(Command.extend({ path: z.string().optional() })),
  },
  /**
   * The text a prompt command sends to the model, with `args` added the way
   * running the command adds them. No `prompt` when the Session has no such
   * command, or the Host carries the command out itself.
   */
  'command.readPrompt': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      name: z.string().min(1).max(256),
      args: z.array(z.string().max(10_000)).max(100).optional(),
    }),
    result: hostResult({ prompt: z.object({ title: z.string(), text: z.string() }).optional() }),
  },
  'skill.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams(ProjectScope),
    restricted: PROJECT_SCOPE_RESTRICTED,
    result: hostList(Skill),
    localResult: hostList(Skill.extend({ path: z.string() })),
  },
  /** One Skill by its exact name. No `skill` when the project and the Host have none by that name. */
  'skill.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ name: z.string().min(1).max(256), ...ProjectScope }),
    restricted: PROJECT_SCOPE_RESTRICTED,
    result: hostResult({ skill: skillText(SkillFile).optional() }),
    localResult: hostResult({
      skill: skillText(SkillFile.extend({ path: z.string() })).extend({ path: z.string(), skillFilePath: z.string() }).optional(),
    }),
  },
  'tool.list': { primitive: 'query', plane: 'data', params: hostParams({ sessionId: SessionRef }), result: hostList(Tool) },
  'agent.list': { primitive: 'query', plane: 'data', params: hostParams({}), result: hostList(Agent) },
} as const satisfies HostMethodRegistry;
