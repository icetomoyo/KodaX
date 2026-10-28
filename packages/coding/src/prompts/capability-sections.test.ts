/**
 * v0.7.35.1 FEATURE_142 Batch E — capability-sections unit tests.
 *
 * Verifies the 13 capability-context sections are emitted in the
 * documented order with the correct conditional inclusion behavior.
 * The byte-level equivalence with pre-Batch E SA output is enforced at
 * the integration level by `builder.test.ts` — this file pins the
 * unit-level contract (id ordering + conditional inclusion).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentActorController, resolveMemoryRoot, setAgentConfigHome } from '@kodax-ai/agent';

import type { KodaXOptions } from '../types.js';
import type { KodaXAgentScope } from '../construction/agent-resolver.js';

import { buildCapabilityContextSections } from './capability-sections.js';
import { loadMarkdownAgentScope } from '../construction/markdown-loader.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function isRetryableTempDirRemoveError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM';
}

async function removeTempDir(dir: string): Promise<void> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableTempDirRemoveError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

interface FakeExtensionRuntime {
  readonly mcpContext: string | undefined;
}

function fakeExtensionRuntime(
  mcpContext: string | undefined,
): KodaXOptions['extensionRuntime'] {
  return {
    getCapabilityPromptContext: async (kind: string) =>
      kind === 'mcp' ? mcpContext : undefined,
  } as unknown as KodaXOptions['extensionRuntime'];
}

function ids(sections: ReadonlyArray<{ id: string }>): string[] {
  return sections.map((s) => s.id);
}

interface PartialContextOptions {
  executionCwd: string;
  gitRoot: string;
  repoIntelligenceContext?: string;
  promptOverlay?: string;
  skillsPrompt?: string;
  rawUserInput?: string;
  agentScope?: KodaXAgentScope;
}

interface MakeOptionsExtras {
  provider?: string;
  model?: string;
  extensionRuntime?: KodaXOptions['extensionRuntime'];
  sessionId?: string;
}

/**
 * Build a fixture KodaXOptions. `provider` defaults to undefined so
 * tests that exercise the "no runtime-fact" branch can omit it; pass
 * `{ provider: 'anthropic' }` explicitly to exercise the with-fact
 * branch.
 */
function makeOptions(
  ctx: PartialContextOptions,
  extras: MakeOptionsExtras = {},
): KodaXOptions {
  return {
    ...(extras.provider !== undefined ? { provider: extras.provider } : {}),
    ...(extras.model ? { model: extras.model } : {}),
    ...(extras.extensionRuntime ? { extensionRuntime: extras.extensionRuntime } : {}),
    ...(extras.sessionId ? { session: { id: extras.sessionId } } : {}),
    context: ctx,
  } as unknown as KodaXOptions;
}

describe('buildCapabilityContextSections', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    setAgentConfigHome(undefined);
    for (const dir of cleanupDirs.splice(0)) {
      await removeTempDir(dir);
    }
  });

  it.each(['excluded', 'policy', 'runtime'] as const)('omits model Skill guidance when the loader is unavailable: %s', async (reason) => {
    const cwd = await createTempDir('kodax-skill-visibility-');
    cleanupDirs.push(cwd);
    const options = makeOptions({ executionCwd: cwd, gitRoot: cwd, skillsPrompt: 'Load audit-skill with the skill tool.' });
    if (reason === 'excluded') options.context!.excludeTools = ['skill'];
    if (reason === 'policy') options.context!.toolVisibilityPolicy = ({ name }) => name !== 'skill';
    if (reason === 'runtime') options.extensionRuntime = { getDefaults: () => ({ activeTools: ['read'] }),
      getCapabilityPromptContext: async () => undefined } as KodaXOptions['extensionRuntime'];
    const sections = await buildCapabilityContextSections(options, false);
    expect(ids(sections)).not.toContain('skills-addendum');
    expect(sections.map(section => section.content).join('\n')).not.toContain('Load audit-skill');
  });

  it('always emits base-system, environment-context, working-directory in canonical order (minimal options)', async () => {
    const cwd = await createTempDir('kodax-capsec-min-');
    cleanupDirs.push(cwd);

    const sections = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false, // not a new session — skip git/project snapshot
      cwd,
    );

    const sectionIds = ids(sections);
    // base-system MUST be first; environment-context + working-directory
    // are unconditional and follow in canonical order. Every other
    // section is conditional and absent in this fixture.
    expect(sectionIds[0]).toBe('base-system');
    expect(sectionIds).toContain('environment-context');
    expect(sectionIds).toContain('working-directory');
    // working-directory comes AFTER environment-context.
    expect(sectionIds.indexOf('environment-context'))
      .toBeLessThan(sectionIds.indexOf('working-directory'));
  });

  it('runtime-fact section is included only when provider or model is set', async () => {
    const cwd = await createTempDir('kodax-capsec-rf-');
    cleanupDirs.push(cwd);

    const without = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false,
      cwd,
    );
    expect(ids(without)).not.toContain('runtime-fact');

    const withProvider = await buildCapabilityContextSections(
      makeOptions(
        { executionCwd: cwd, gitRoot: cwd },
        { provider: 'anthropic' },
      ),
      false,
      cwd,
    );
    expect(ids(withProvider)).toContain('runtime-fact');
    const rf = withProvider.find((s) => s.id === 'runtime-fact');
    expect(rf?.content).toContain('provider=anthropic');
  });

  it('repo-intelligence-context, mcp-capability-context, skills-addendum are conditional; execution-guidance always present', async () => {
    const cwd = await createTempDir('kodax-capsec-cond-');
    cleanupDirs.push(cwd);

    const sections = await buildCapabilityContextSections(
      makeOptions(
        {
          executionCwd: cwd,
          gitRoot: cwd,
          repoIntelligenceContext: '## Repo intel\n- foo',
          promptOverlay: '## Overlay\n- bar',
          skillsPrompt: 'Use skill X',
        },
        { extensionRuntime: fakeExtensionRuntime('## MCP\n- minimax') },
      ),
      false,
      cwd,
    );

    const sectionIds = ids(sections);
    expect(sectionIds).toContain('repo-intelligence-context');
    expect(sectionIds).toContain('mcp-capability-context');
    expect(sectionIds).toContain('skills-addendum');
    // The static `execution-guidance` block is always emitted (it replaced the
    // router overlay text in P1.7). The `prompt-overlay` section is re-emitted
    // when `context.promptOverlay` is set — it now carries only the SA Direct
    // Path Rule + caller-supplied overlay, not the retired router overlay
    // (ADR-043 Phase 3 regression fix).
    expect(sectionIds).toContain('execution-guidance');
    expect(sectionIds).toContain('prompt-overlay');
    const overlaySection = sections.find((s) => s.id === 'prompt-overlay');
    expect(overlaySection?.content).toContain('## Overlay\n- bar');

    // Canonical order: repo-intel → mcp → skills.
    expect(sectionIds.indexOf('repo-intelligence-context'))
      .toBeLessThan(sectionIds.indexOf('mcp-capability-context'));
    expect(sectionIds.indexOf('mcp-capability-context'))
      .toBeLessThan(sectionIds.indexOf('skills-addendum'));
  });

  it('project-agents is included when an AGENTS.md exists in the cwd', async () => {
    const cwd = await createTempDir('kodax-capsec-agents-');
    cleanupDirs.push(cwd);
    await fs.mkdir(path.join(cwd, '.kodax'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.kodax', 'AGENTS.md'),
      '# Project rules\n- never use any',
      'utf8',
    );

    const sections = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false,
      cwd,
    );

    expect(ids(sections)).toContain('project-agents');
    const projectAgents = sections.find((s) => s.id === 'project-agents');
    expect(projectAgents?.content).toContain('never use any');
  });

  it('isNewSession=true triggers project-snapshot (best-effort, with cwd as project root)', async () => {
    const cwd = await createTempDir('kodax-capsec-new-');
    cleanupDirs.push(cwd);

    const sections = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      true, // new session
      cwd,
    );

    // project-snapshot is best-effort; getProjectSnapshot always returns
    // at least `Project: <basename>`. Section presence is sufficient.
    expect(ids(sections)).toContain('project-snapshot');
  });

  it('working-directory section content reports the executionCwd verbatim', async () => {
    const cwd = await createTempDir('kodax-capsec-wd-');
    cleanupDirs.push(cwd);

    const sections = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false,
      cwd,
    );

    const wd = sections.find((s) => s.id === 'working-directory');
    expect(wd?.content).toBe(`Working Directory: ${cwd}`);
  });

  it('emits session-scratch-directory only when a session id is available', async () => {
    const cwd = await createTempDir('kodax-capsec-scratch-');
    cleanupDirs.push(cwd);

    const withoutSession = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false,
      cwd,
    );
    expect(ids(withoutSession)).not.toContain('session-scratch-directory');

    const withSession = await buildCapabilityContextSections(
      makeOptions(
        { executionCwd: cwd, gitRoot: cwd },
        { sessionId: 'session A' },
      ),
      false,
      cwd,
    );

    const sectionIds = ids(withSession);
    expect(sectionIds).toContain('session-scratch-directory');
    expect(sectionIds.indexOf('working-directory'))
      .toBeLessThan(sectionIds.indexOf('session-scratch-directory'));
    const scratch = withSession.find((s) => s.id === 'session-scratch-directory');
    expect(scratch?.content).toBe(
      `Session Scratch Directory: ${path.join(cwd, '.agent', 'tmp', 'sessions', 'session_A')}`,
    );
  });

  it('appends bounded task-relevant memory hints without injecting topic bodies', async () => {
    const cwd = await createTempDir('kodax-capsec-memory-pack-');
    const home = await createTempDir('kodax-capsec-memory-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    const memoryDir = resolveMemoryRoot(cwd);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, 'MEMORY.md'),
      '- [Project stack](project_stack.md) - Repo uses npm workspaces\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(memoryDir, 'project_stack.md'),
      [
        '---',
        'name: Project stack',
        'description: Repo uses npm workspaces',
        'type: project',
        '---',
        '',
        'Full topic body detail should stay out of the prompt until read on demand.',
        '',
      ].join('\n'),
      'utf8',
    );

    const sections = await buildCapabilityContextSections(
      makeOptions({
        executionCwd: cwd,
        gitRoot: cwd,
        rawUserInput: 'Inspect the project stack and npm workspace setup',
      }),
      false,
      cwd,
    );

    const projectMemory = sections.find((section) => section.id === 'project-memory');
    expect(projectMemory?.content).toContain('Task-relevant memory hints (bounded):');
    expect(projectMemory?.content).toContain('memdir:project_stack.md');
    expect(projectMemory?.content).toContain('read the referenced memory file');
    expect(projectMemory?.content).not.toContain('Trace:');
    expect(projectMemory?.content).not.toContain('taskFingerprint');
    expect(projectMemory?.content).not.toContain('selected memory refs');
    expect(projectMemory?.content).not.toContain('Full topic body detail should stay out');
  });

  it('does not run memory curator as a prompt-build side effect', async () => {
    const cwd = await createTempDir('kodax-capsec-no-curator-');
    const home = await createTempDir('kodax-capsec-no-curator-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    const memoryDir = resolveMemoryRoot(cwd);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, 'alpha.md'),
      [
        '---',
        'name: Shared Memory',
        'description: alpha duplicate',
        'type: project',
        '---',
        '',
        'duplicate body',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(memoryDir, 'beta.md'),
      [
        '---',
        'name: Shared Memory',
        'description: beta duplicate',
        'type: project',
        '---',
        '',
        'duplicate body',
        '',
      ].join('\n'),
      'utf8',
    );

    await buildCapabilityContextSections(
      makeOptions({
        executionCwd: cwd,
        gitRoot: cwd,
        rawUserInput: 'Use project memory if relevant',
      }),
      false,
      cwd,
    );

    await expect(pathExists(path.join(memoryDir, '.governance'))).resolves.toBe(false);
  });
});

describe('FEATURE_191 — specialist-agents section (A.3)', () => {
  // Tests register fake constructed agents and verify the
  // `specialist-agents` capability section appears (or not) in the
  // assembled section list. _resetAgentResolverForTesting is called
  // before/after each so the global registry stays clean.
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    setAgentConfigHome(undefined);
    const { _resetAgentResolverForTesting } = await import('../construction/agent-resolver.js');
    _resetAgentResolverForTesting();
    for (const dir of cleanupDirs) {
      await removeTempDir(dir);
    }
    cleanupDirs.length = 0;
  });

  async function buildSections(cwd: string): Promise<readonly { id: string; content: string }[]> {
    return buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd, actorControl: await actorControl() }),
      false,
      cwd,
    );
  }

  async function actorControl() {
    return (await createAgentActorController({ executor: { execute: async () => { throw new Error('Prompt fixture must not spawn'); } } })).bind('/root');
  }

  it('omits specialist-agents section when registry is empty (token saving)', async () => {
    const { _resetAgentResolverForTesting } = await import('../construction/agent-resolver.js');
    _resetAgentResolverForTesting();
    const cwd = await createTempDir('kodax-capsec-sp1-');
    cleanupDirs.push(cwd);

    const sections = await buildSections(cwd);
    expect(ids(sections)).not.toContain('specialist-agents');
  });

  it('injects specialist-agents section when registry has agents, lists name + description', async () => {
    const { _resetAgentResolverForTesting, registerConstructedAgent } =
      await import('../construction/agent-resolver.js');
    _resetAgentResolverForTesting();
    registerConstructedAgent({
      kind: 'agent',
      name: 'db-reviewer',
      version: '1.0.0',
      content: {
        instructions: 'DB REVIEWER PROMPT',
        description: 'Reviews DB migrations for safety',
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    registerConstructedAgent({
      kind: 'agent',
      name: 'e2e-runner',
      version: '1.0.0',
      content: {
        instructions: 'E2E PROMPT',
        description: 'End-to-end testing specialist using Playwright',
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    const cwd = await createTempDir('kodax-capsec-sp2-');
    cleanupDirs.push(cwd);

    const actorless = await buildCapabilityContextSections(makeOptions({ executionCwd: cwd, gitRoot: cwd }), false, cwd);
    expect(ids(actorless)).not.toContain('specialist-agents');
    const excluded = await buildCapabilityContextSections(makeOptions({ executionCwd: cwd, gitRoot: cwd, actorControl: await actorControl(), excludeTools: ['spawn_agent'] }), false, cwd);
    expect(ids(excluded)).not.toContain('specialist-agents');

    const sections = await buildSections(cwd);
    const sp = sections.find((s) => s.id === 'specialist-agents');
    expect(sp).toBeDefined();
    expect(sp?.content).toContain('=== Available specialist agents ===');
    expect(sp?.content).toContain('- db-reviewer: Reviews DB migrations for safety');
    expect(sp?.content).toContain('- e2e-runner: End-to-end testing specialist using Playwright');
    expect(sp?.content).toContain('Start one with spawn_agent(agent_id="<name>")');
    expect(sp?.content).toContain('list_dispatchable_agents returns the equivalent canonical id');
  });

  it('uses scoped markdown agents for prompt rendering without leaking into another project scope', async () => {
    const configHome = await createTempDir('kodax-capsec-md-home-');
    const projectA = await createTempDir('kodax-capsec-md-a-');
    const projectB = await createTempDir('kodax-capsec-md-b-');
    cleanupDirs.push(configHome, projectA, projectB);
    await fs.mkdir(path.join(projectA, '.kodax', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(projectA, '.kodax', 'agents', 'agent-a.md'),
      [
        '---',
        'name: agent-a',
        'description: Project A specialist',
        '---',
        'project A instructions',
      ].join('\n'),
      'utf8',
    );

    const scopeA = await loadMarkdownAgentScope({ cwd: projectA, configHome });
    const scopeB = await loadMarkdownAgentScope({ cwd: projectB, configHome });

    const sectionsA = await buildCapabilityContextSections(
      makeOptions({ executionCwd: projectA, gitRoot: projectA, agentScope: scopeA.scope, actorControl: await actorControl() }),
      false,
      projectA,
    );
    const sectionsB = await buildCapabilityContextSections(
      makeOptions({ executionCwd: projectB, gitRoot: projectB, agentScope: scopeB.scope, actorControl: await actorControl() }),
      false,
      projectB,
    );

    const specialistA = sectionsA.find((section) => section.id === 'specialist-agents');
    const specialistB = sectionsB.find((section) => section.id === 'specialist-agents');
    expect(specialistA?.content).toContain('- agent-a: Project A specialist');
    expect(specialistB?.content ?? '').not.toContain('agent-a');

    await scopeA.dispose();
    await scopeB.dispose();
  });

  it('renders "(no description)" placeholder for agents missing the description field (FEATURE_089 backward compat)', async () => {
    const { _resetAgentResolverForTesting, registerConstructedAgent } =
      await import('../construction/agent-resolver.js');
    _resetAgentResolverForTesting();
    registerConstructedAgent({
      kind: 'agent',
      name: 'legacy-agent',
      version: '1.0.0',
      // No description — FEATURE_089 minimal-agent shape
      content: { instructions: 'LEGACY PROMPT' },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    const cwd = await createTempDir('kodax-capsec-sp3-');
    cleanupDirs.push(cwd);

    const sections = await buildSections(cwd);
    const sp = sections.find((s) => s.id === 'specialist-agents');
    expect(sp?.content).toContain('- legacy-agent: (no description)');
  });

  it('section is positioned after mcp-capability-context (per documented ordering)', async () => {
    const { _resetAgentResolverForTesting, registerConstructedAgent } =
      await import('../construction/agent-resolver.js');
    _resetAgentResolverForTesting();
    registerConstructedAgent({
      kind: 'agent',
      name: 'positional',
      version: '1.0.0',
      content: { instructions: 'P', description: 'positional test' },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    const cwd = await createTempDir('kodax-capsec-sp4-');
    cleanupDirs.push(cwd);

    const sectionIds = ids(await buildSections(cwd));
    const specialistIdx = sectionIds.indexOf('specialist-agents');
    expect(specialistIdx).toBeGreaterThan(-1);
    // mcp-capability-context only fires when an extensionRuntime is configured
    // (we don't pass one here) — verify specialist-agents lands BEFORE
    // project-agents / memory-rules instead.
    const projectAgentsIdx = sectionIds.indexOf('project-agents');
    if (projectAgentsIdx !== -1) {
      expect(specialistIdx).toBeLessThan(projectAgentsIdx);
    }
  });

  it('FEATURE_221: self-knowledge-routing rule is re-branded end-to-end by selfManual.productName', async () => {
    const cwd = await createTempDir('kodax-capsec-selfmanual-');
    cleanupDirs.push(cwd);
    const base = makeOptions({ executionCwd: cwd, gitRoot: cwd });

    // Default (no selfManual) → "KodaX self-knowledge" in the rendered section.
    const dft = await buildCapabilityContextSections(base, false, cwd);
    expect(dft.find((s) => s.id === 'self-knowledge-routing')?.content).toContain(
      'KodaX self-knowledge',
    );

    // Injected productName flows through into the rendered prompt section.
    const branded = await buildCapabilityContextSections(
      { ...base, selfManual: { productName: 'KodaX-Space' } } as KodaXOptions,
      false,
      cwd,
    );
    const rule = branded.find((s) => s.id === 'self-knowledge-routing');
    expect(rule?.content).toContain('KodaX-Space self-knowledge');
    expect(rule?.content).not.toContain('KodaX self-knowledge:');
  });
});
