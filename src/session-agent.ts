/**
 * The Agents installed in the home of a Host, as a Session can be created as
 * one of them. Creating the Session copies the Agent into the policy of the
 * Session, so a later change to the Agent's file does not reach that Session.
 */
import { loadMarkdownAgentScope } from '@kodax-ai/coding';
import type { ClientSessionPolicy } from '@kodax-ai/coding/client-contract';

import type { RuntimeSessionSettings } from './sdk-runtime.js';

/** The longest instructions a Session policy holds; the protocol refuses to answer with more. */
const LONGEST_INSTRUCTIONS = 32_000;

/** The model an Agent asks for. A Session starts with it and may change it. */
export type InstalledAgentModel = Pick<RuntimeSessionSettings, 'provider' | 'model' | 'effort'>;

export interface InstalledAgent extends InstalledAgentModel {
  readonly name: string;
  readonly description: string;
  /** The only tools the Agent uses. Absent when it names none. */
  readonly tools?: readonly string[];
}

/**
 * Only the Agents of the Host home: an Agent of a project is that project's
 * word, and nothing here says the project is trusted. An Agent passes the same
 * admission as one a remote Agent binding serves.
 */
async function loadInstalledAgents(configHome: string): Promise<ReadonlyArray<InstalledAgent & { readonly instructions: string }>> {
  const found = await loadMarkdownAgentScope({ cwd: configHome, configHome, userOnly: true });
  try {
    return found.loaded.flatMap((loaded) => {
      const agent = found.scope.resolve(loaded.name)?.agent;
      if (agent === undefined) return [];
      const instructions = typeof agent.instructions === 'string' ? agent.instructions : agent.instructions({});
      if (instructions.length > LONGEST_INSTRUCTIONS) return [];
      return [{
        name: loaded.name,
        description: loaded.description,
        ...(loaded.effectiveTools === undefined ? {} : { tools: [...loaded.effectiveTools] }),
        ...(agent.provider ? { provider: agent.provider } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        instructions,
      }];
    });
  } finally {
    await found.dispose();
  }
}

export async function listInstalledAgents(configHome: string): Promise<readonly InstalledAgent[]> {
  return (await loadInstalledAgents(configHome)).map(({ instructions: _instructions, ...agent }) => agent);
}

/**
 * What a Session created as the Agent `name` is bound to and starts with. The
 * persona and the tools of the Agent join the policy its creator fixed: the
 * tools only narrow it, and a creator that fixed a persona of its own is refused.
 */
export async function sessionAsInstalledAgent(
  configHome: string,
  name: string,
  policy: ClientSessionPolicy | undefined,
): Promise<{ readonly policy: ClientSessionPolicy; readonly settings: InstalledAgentModel }> {
  if (policy?.agentProfile !== undefined) {
    throw Object.assign(new Error('A Session is created as an Agent or with an agentProfile; send only one of them.'), {
      code: 'invalid_params' as const,
    });
  }
  const agent = (await loadInstalledAgents(configHome)).find(installed => installed.name === name);
  if (agent === undefined) {
    throw Object.assign(new Error(`No Agent named ${JSON.stringify(name)} is installed on this Host.`), { code: 'not_found' as const });
  }
  const { tools: own, instructions, provider, model, effort } = agent;
  const allowed = policy?.tools;
  const tools = own === undefined ? allowed : allowed === undefined ? own : own.filter(tool => allowed.includes(tool));
  return {
    policy: {
      ...policy,
      ...(tools === undefined ? {} : { tools }),
      agentProfile: { name: agent.name, instructions },
    },
    settings: {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    },
  };
}
