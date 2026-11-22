import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listInstalledAgents, sessionAsInstalledAgent } from './session-agent.js';

let home: string;
let configHome: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'kodax-session-agent-'));
  configHome = path.join(home, '.kodax');
  mkdirSync(path.join(configHome, 'agents'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeAgent(name: string, frontmatter: readonly string[], instructions: string, directory = configHome): void {
  mkdirSync(path.join(directory, 'agents'), { recursive: true });
  writeFileSync(path.join(directory, 'agents', `${name}.md`), [
    '---', `name: ${name}`, `description: The ${name}`, ...frontmatter, '---', instructions,
  ].join('\n'));
}

describe('Agents a Session can be created as', () => {
  it('lists the Agents installed in the Host home, without their instructions', async () => {
    writeAgent('clerk', ['tools: [read, grep]', 'model: clerk-model', 'provider: clerk-provider', 'effort: high'], 'You are the release clerk.');
    writeAgent('scribe', [], 'You are the scribe.');
    // Neither a file that does not load nor an Agent of some project is on offer.
    writeFileSync(path.join(configHome, 'agents', 'broken.md'), '---\nname: broken\n---\n');
    writeAgent('local', [], 'You belong to one project.', path.join(home, 'project', '.kodax'));

    const agents = await listInstalledAgents(configHome);
    expect([...agents].sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: 'clerk', description: 'The clerk', tools: ['read', 'grep'], provider: 'clerk-provider', model: 'clerk-model', effort: 'high' },
      { name: 'scribe', description: 'The scribe' },
    ]);
    expect(await listInstalledAgents(path.join(home, 'no-such-home'))).toEqual([]);
  });

  it('fixes the persona and the tools of the Agent in the policy of the Session', async () => {
    writeAgent('clerk', ['tools: [read, grep]', 'model: clerk-model', 'effort: high'], 'You are the release clerk.');
    writeAgent('scribe', [], 'You are the scribe.');

    expect(await sessionAsInstalledAgent(configHome, 'clerk', undefined)).toEqual({
      policy: { tools: ['read', 'grep'], agentProfile: { name: 'clerk', instructions: 'You are the release clerk.' } },
      settings: { model: 'clerk-model', effort: 'high' },
    });
    // What the creator fixed still binds: the Agent narrows the tools and widens nothing.
    expect(await sessionAsInstalledAgent(configHome, 'clerk', { tools: ['grep', 'bash'], budget: { maxIter: 3 }, interactions: 'reject' })).toEqual({
      policy: {
        tools: ['grep'], budget: { maxIter: 3 }, interactions: 'reject',
        agentProfile: { name: 'clerk', instructions: 'You are the release clerk.' },
      },
      settings: { model: 'clerk-model', effort: 'high' },
    });
    // An Agent that names no tools leaves the tools as they were.
    expect(await sessionAsInstalledAgent(configHome, 'scribe', { tools: ['read'] })).toEqual({
      policy: { tools: ['read'], agentProfile: { name: 'scribe', instructions: 'You are the scribe.' } },
      settings: {},
    });
    expect((await sessionAsInstalledAgent(configHome, 'scribe', undefined)).policy).toEqual({
      agentProfile: { name: 'scribe', instructions: 'You are the scribe.' },
    });
  });

  it('refuses an Agent that is not installed, and a second persona', async () => {
    writeAgent('clerk', [], 'You are the release clerk.');
    writeAgent('local', [], 'You belong to one project.', path.join(home, 'project', '.kodax'));

    for (const name of ['nobody', 'local', '', '../clerk']) {
      await expect(sessionAsInstalledAgent(configHome, name, undefined)).rejects.toMatchObject({ code: 'not_found' });
    }
    await expect(sessionAsInstalledAgent(configHome, 'clerk', { agentProfile: { name: 'Other' } }))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('does not offer an Agent whose instructions are longer than a policy holds', async () => {
    writeAgent('verbose', [], 'word '.repeat(6_500));
    writeAgent('clerk', [], 'You are the release clerk.');

    expect((await listInstalledAgents(configHome)).map(agent => agent.name)).toEqual(['clerk']);
    await expect(sessionAsInstalledAgent(configHome, 'verbose', undefined)).rejects.toMatchObject({ code: 'not_found' });
  });
});
