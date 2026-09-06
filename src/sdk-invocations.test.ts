import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createKodaXRuntime } from './sdk-runtime.js';

/**
 * FEATURE_298 T37 S1 — the Host prepares Skills from a trusted registry:
 * expansion, metadata, and the enforce-at-runtime policy are minted
 * Host-side; the client only ever supplied a name and argument text.
 */
async function seedSkillProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-t37-skill-'));
  const skillDir = path.join(projectRoot, '.kodax', 'skills', 'audit-helper');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: audit-helper',
      'description: Audit the current diff with arguments',
      'allowed-tools: Read, Grep',
      '---',
      '',
      'Audit request: $ARGUMENTS',
    ].join('\n'),
    'utf8',
  );
  const dynDir = path.join(projectRoot, '.kodax', 'skills', 'dyn-context');
  await mkdir(dynDir, { recursive: true });
  await writeFile(
    path.join(dynDir, 'SKILL.md'),
    [
      '---',
      'name: dyn-context',
      'description: Uses dynamic context blocks',
      '---',
      '',
      'Workspace root is !`pwd`.',
    ].join('\n'),
    'utf8',
  );
  return projectRoot;
}

it('prepares a Skill Host-side with expansion, metadata, and runtime policy', async () => {
  const projectRoot = await seedSkillProject();
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    const prepared = await runtime.invocations.prepareSkill({
      projectRoot,
      name: 'audit-helper',
      argumentsText: 'focus on auth',
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(prepared.invocation.prompt).toContain('focus on auth');
    expect(prepared.invocation.source).toBe('skill');
    expect(prepared.invocation.allowedTools ?? '').toContain('Read');
    expect(prepared.invocation.allowedTools ?? '').toContain('Grep');
    expect(prepared.invocation.skillInvocation?.name).toBe('audit-helper');
    expect(prepared.invocation.skillInvocation?.runtimePolicy?.enforceAtRuntime).toBe(true);
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it('reports unknown skills without touching any executor', async () => {
  const projectRoot = await seedSkillProject();
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    const prepared = await runtime.invocations.prepareSkill({
      projectRoot,
      name: 'definitely-not-a-skill',
      argumentsText: '',
    });
    expect(prepared).toMatchObject({ kind: 'unknown' });
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it('hard-disables `!`cmd`` dynamic context when no host executor is bound', async () => {
  const projectRoot = await seedSkillProject();
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  try {
    const prepared = await runtime.invocations.prepareSkill({
      projectRoot,
      name: 'dyn-context',
      argumentsText: '',
    });
    // The kill switch surfaces as an inlined placeholder (the resolver never
    // poisons a whole load); no shell command may have run.
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    expect(prepared.invocation.prompt).toContain('Dynamic context disabled by host');
    expect(prepared.invocation.prompt).not.toMatch(/Workspace root is [A-Za-z]:\\/);
  } finally {
    await runtime.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
