import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '../diagnostics.js';
import { importApprovedLearnedSkills } from './learned-skill-driver.js';
import {
  commitLearnedSkillRevision,
  createLearnedCapabilityScope,
  resolveProjectLearnedAreaRoot,
  type DeclarativeSkillSpec,
} from './learned-skill.js';
import { LearnedAreaStore } from './learned-area-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function spec(step: string): DeclarativeSkillSpec {
  return {
    name: 'verify-release',
    description: 'Use when validating this project before a release.',
    purpose: 'Verify release state from reproducible evidence.',
    triggers: ['A release candidate needs verification.'],
    steps: [step],
    verification: ['Require a passing check artifact.'],
    pitfalls: ['Do not treat model self-report as verification.'],
  };
}

async function configHomeFixture(): Promise<string> {
  const configHome = await mkdtemp(join(tmpdir(), 'kodax-learned-import-'));
  roots.push(configHome);
  return configHome;
}

async function projectRecord(
  configHome: string,
  projectId: string,
  step: string,
  approve: boolean,
) {
  const projectRoot = resolveProjectLearnedAreaRoot(configHome, { tenantId: 'tenant-a', projectId });
  const store = new LearnedAreaStore(projectRoot);
  await store.initialize();
  const created = await commitLearnedSkillRevision(store, {
    scope: createLearnedCapabilityScope(configHome, { tenantId: 'tenant-a', projectId }),
    spec: approve ? spec(step) : { ...spec(step), name: `draft-${projectId}` },
    disposition: 'ready',
    operation: 'create',
    provenance: {
      jobId: `job-${projectId}`,
      inputHash: 'c'.repeat(64),
      decisionId: `decision-${projectId}`,
      actionId: `action-${projectId}`,
    },
  });
  const record = approve
    ? { ...created, lifecycle: 'active_learned' as const, revision: created.revision + 1 }
    : created;
  if (approve) await store.writeCapability(record);
  return { projectRoot, store, record };
}

async function collectDiagnostics(run: () => Promise<void>): Promise<KodaXDiagnostic[]> {
  const diagnostics: KodaXDiagnostic[] = [];
  const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
  try {
    await run();
  } finally {
    restore();
  }
  return diagnostics;
}

describe('importApprovedLearnedSkills', () => {
  it('copies approved Skills once, never overwrites a user Skill and leaves learned records alone', async () => {
    const configHome = await configHomeFixture();
    const first = await projectRecord(configHome, 'project-a', 'Run the release test suite.', true);
    await projectRecord(configHome, 'project-b', 'Run only the smoke tests.', true);
    await projectRecord(configHome, 'project-c', 'Not approved yet.', false);
    const skillsRoot = join(configHome, 'skills');

    const diagnostics = await collectDiagnostics(() => importApprovedLearnedSkills(configHome));

    const copied = await readFile(join(skillsRoot, 'verify-release', 'SKILL.md'), 'utf8');
    expect(copied.includes('Run the release test suite.') !== copied.includes('Run only the smoke tests.')).toBe(true);
    expect((await readdir(skillsRoot)).sort()).toEqual(['.learned-skills-imported.json', 'verify-release']);
    expect(diagnostics.filter((item) => item.level === 'warn')).toHaveLength(1);
    expect(await first.store.readCapability(first.record.capabilityId)).toMatchObject({ lifecycle: 'active_learned' });

    await rm(join(skillsRoot, 'verify-release'), { recursive: true, force: true });
    await importApprovedLearnedSkills(configHome);
    await expect(access(join(skillsRoot, 'verify-release'))).rejects.toThrow();
  });

  it('skips a learned artifact whose content no longer matches its fingerprint', async () => {
    const configHome = await configHomeFixture();
    const { projectRoot, record } = await projectRecord(configHome, 'project-a', 'Run the release test suite.', true);
    await writeFile(join(projectRoot, ...record.artifact.relativePath.split('/')), 'tampered learned Skill', 'utf8');

    const diagnostics = await collectDiagnostics(() => importApprovedLearnedSkills(configHome));

    await expect(access(join(configHome, 'skills', record.slug, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(diagnostics.filter((item) => item.level === 'warn')).toHaveLength(1);
  });

  it('never writes through a user Skill directory that is a symlink or junction', async () => {
    const configHome = await configHomeFixture();
    const { record } = await projectRecord(configHome, 'project-a', 'Run the release test suite.', true);
    const outsideDir = join(configHome, 'outside-formal-skill');
    await mkdir(join(configHome, 'skills'), { recursive: true });
    await mkdir(outsideDir);
    await symlink(outsideDir, join(configHome, 'skills', record.slug), process.platform === 'win32' ? 'junction' : 'dir');

    const diagnostics = await collectDiagnostics(() => importApprovedLearnedSkills(configHome));

    await expect(access(join(outsideDir, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(diagnostics.filter((item) => item.level === 'warn')).toHaveLength(1);
  });
});
