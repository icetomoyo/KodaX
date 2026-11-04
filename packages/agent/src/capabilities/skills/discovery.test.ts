import { mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome } from '../../runtime/agent-home.js';
import { discoverSkills } from './discovery.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { getDefaultSkillPaths } from './types.js';

describe('User Skill discovery follows the agent home', () => {
  const originalEnv = process.env.KODAX_HOME;
  let agentHome: string | undefined;

  beforeEach(async () => {
    agentHome = await createTempDir('kodax-skill-home-');
    setAgentConfigHome(undefined);
    process.env.KODAX_HOME = agentHome;
  });

  afterEach(async () => {
    setAgentConfigHome(undefined);
    if (originalEnv === undefined) delete process.env.KODAX_HOME;
    else process.env.KODAX_HOME = originalEnv;
    await removeTempDir(agentHome);
  });

  it('reads user Skills from KODAX_HOME and keeps ~/.agents/skills on the OS home', () => {
    expect(getDefaultSkillPaths().userPaths).toEqual([
      join(agentHome!, 'skills'),
      join(homedir(), '.agents', 'skills'),
    ]);
  });

  it('follows setAgentConfigHome() over KODAX_HOME', async () => {
    const override = await createTempDir('kodax-skill-override-');
    try {
      setAgentConfigHome(override);
      expect(getDefaultSkillPaths().userPaths[0]).toBe(join(override, 'skills'));
    } finally {
      await removeTempDir(override);
    }
  });

  it('discovers a user Skill placed under KODAX_HOME', async () => {
    const skillDir = join(agentHome!, 'skills', 'home-only-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: home-only-skill\ndescription: Found under KODAX_HOME.\n---\n\nBody.\n');

    const { skills } = await discoverSkills(undefined, {
      userPaths: getDefaultSkillPaths().userPaths.slice(0, 1),
      pluginPaths: [],
      builtinPath: join(agentHome!, 'no-builtins'),
    });

    expect(skills.get('home-only-skill')?.source).toBe('user');
  });
});
