import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtensionRuntime } from '../extensions/runtime.js';
import { buildSystemPrompt, buildSystemPromptSnapshot } from './builder.js';

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

describe('buildSystemPrompt', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of cleanupDirs.splice(0)) {
      await removeTempDir(dir);
    }
  });

  it('keeps the rendered prompt identical without rules and refreshes rule bodies without accumulating tokens', async () => {
    const executionCwd = await createTempDir('kodax-prompt-rules-');
    cleanupDirs.push(executionCwd);
    vi.stubEnv('KODAX_HOME', path.join(executionCwd, 'user-home'));
    const options = { provider: 'openai', context: { executionCwd, gitRoot: executionCwd } };
    const baseline = await buildSystemPrompt(options, false);
    const rulesDir = path.join(executionCwd, '.kodax', 'rules');
    await fs.mkdir(rulesDir, { recursive: true });
    expect(await buildSystemPrompt(options, false)).toBe(baseline);
    const rulePath = path.join(rulesDir, 'testing.md');
    await fs.writeFile(rulePath, 'FIRST_ACTION_TESTING_RULE');
    const first = await buildSystemPromptSnapshot(options, true);
    expect(first.sections.find(section => section.id === 'project-agents')?.content)
      .toContain('FIRST_ACTION_TESTING_RULE');
    const next = await buildSystemPrompt(options, false);
    expect(next.match(/FIRST_ACTION_TESTING_RULE/g)).toHaveLength(1);
    expect(await buildSystemPrompt(options, false)).toBe(next);
    await fs.writeFile(rulePath, 'UPDATED_TESTING_RULE');
    const updated = await buildSystemPrompt(options, false);
    expect(updated).toContain('UPDATED_TESTING_RULE');
    expect(updated).not.toContain('FIRST_ACTION_TESTING_RULE');
    await fs.rm(rulePath);
    expect(await buildSystemPrompt(options, false)).toBe(baseline);
  });

  it('respects the host readable-path boundary for user rule bodies', async () => {
    const executionCwd = await createTempDir('kodax-prompt-bound-rules-');
    cleanupDirs.push(executionCwd);
    const userHome = path.join(executionCwd, 'user-home');
    const userRules = path.join(userHome, 'rules');
    await fs.mkdir(userRules, { recursive: true });
    await fs.writeFile(path.join(userRules, 'private.md'), 'PRIVATE_USER_RULE');
    vi.stubEnv('KODAX_HOME', userHome);
    const prompt = await buildSystemPrompt({
      provider: 'openai',
      context: {
        executionCwd, gitRoot: executionCwd,
        assertReadablePath: () => { throw new Error('outside bound workspace'); },
      },
    }, true);
    expect(prompt).not.toContain('PRIVATE_USER_RULE');
  });

  it('uses executionCwd instead of process cwd for prompt context', async () => {
    const executionCwd = await createTempDir('kodax-prompt-cwd-');
    cleanupDirs.push(executionCwd);
    await fs.writeFile(
      path.join(executionCwd, 'README.md'),
      '# temp project',
      'utf-8',
    );

    const prompt = await buildSystemPrompt(
      {
        provider: 'openai',
        context: {
          executionCwd,
          gitRoot: executionCwd,
        },
      },
      true,
    );

    expect(prompt).toContain(`Working Directory: ${executionCwd}`);
    expect(prompt).toContain(`Project: ${path.basename(executionCwd)}`);
  });

  it('appends repository intelligence context when provided', async () => {
    const executionCwd = await createTempDir('kodax-prompt-repo-intel-');
    cleanupDirs.push(executionCwd);

    const prompt = await buildSystemPrompt(
      {
        provider: 'openai',
        context: {
          executionCwd,
          gitRoot: executionCwd,
          repoIntelligenceContext:
            '## Repository Intelligence\nRepository overview for sample-workspace',
        },
      },
      false,
    );

    expect(prompt).toContain('## Repository Intelligence');
    expect(prompt).toContain('Repository overview for sample-workspace');
  });

  it('builds ordered prompt sections with explicit provenance and precedence', async () => {
    const executionCwd = await createTempDir('kodax-prompt-sections-');
    cleanupDirs.push(executionCwd);
    await fs.mkdir(path.join(executionCwd, '.kodax'), { recursive: true });
    await fs.writeFile(
      path.join(executionCwd, '.kodax', 'AGENTS.md'),
      'PROJECT RULE: prefer project-scoped constraints.',
      'utf-8',
    );

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        context: {
          executionCwd,
          gitRoot: executionCwd,
          repoIntelligenceContext: '## Repository Intelligence\nScoped repo truth.',
          promptOverlay: '## Prompt Overlay\nRuntime truth goes here.',
          skillsPrompt: '## Skills\nUse only the necessary specialist workflow.',
        },
      },
      false,
    );

    expect(
      snapshot.sections.map(({ id, slot, owner, feature, stability }) => ({
        id,
        slot,
        owner,
        feature,
        stability,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "feature": "FEATURE_048",
          "id": "base-system",
          "owner": "prompts",
          "slot": "base",
          "stability": "stable",
        },
        {
          "feature": "FEATURE_048",
          "id": "environment-context",
          "owner": "prompts",
          "slot": "runtime-context",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_048",
          "id": "runtime-fact",
          "owner": "prompts",
          "slot": "runtime-context",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_048",
          "id": "working-directory",
          "owner": "prompts",
          "slot": "runtime-context",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_048",
          "id": "repo-intelligence-context",
          "owner": "reasoning",
          "slot": "capability-truth",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_218",
          "id": "self-knowledge-routing",
          "owner": "prompts",
          "slot": "capability-truth",
          "stability": "stable",
        },
        {
          "feature": "FEATURE_048",
          "id": "execution-guidance",
          "owner": "prompts",
          "slot": "capability-truth",
          "stability": "stable",
        },
        {
          "feature": "FEATURE_048",
          "id": "prompt-overlay",
          "owner": "reasoning",
          "slot": "mode-overlay",
          "stability": "dynamic",
        },
        {
          "feature": "FEATURE_048",
          "id": "project-agents",
          "owner": "project",
          "slot": "project-rules",
          "stability": "project",
        },
        {
          "feature": "FEATURE_124",
          "id": "memory-rules",
          "owner": "project",
          "slot": "project-rules",
          "stability": "project",
        },
        {
          "feature": "FEATURE_124",
          "id": "project-memory",
          "owner": "project",
          "slot": "project-rules",
          "stability": "project",
        },
        {
          "feature": "FEATURE_048",
          "id": "skills-addendum",
          "owner": "skills",
          "slot": "skill-addendum",
          "stability": "dynamic",
        },
      ]
    `);

    expect(snapshot.metadata.longRunning).toBe(false);
    expect(snapshot.hash).toHaveLength(64);
    // The router prompt-overlay section was retired (ADR-043 P1.7); the static
    // EXECUTION GUIDANCE block replaces it (capability-truth slot, always on).
    expect(snapshot.rendered.indexOf('EXECUTION GUIDANCE')).toBeGreaterThan(-1);
    expect(snapshot.rendered.indexOf('PROJECT RULE: prefer project-scoped constraints.')).toBeGreaterThan(
      snapshot.rendered.indexOf('EXECUTION GUIDANCE'),
    );
    expect(snapshot.rendered.indexOf('## Skills')).toBeGreaterThan(
      snapshot.rendered.indexOf('PROJECT RULE: prefer project-scoped constraints.'),
    );
  });

  it('Phase A: identity prefix names KodaX as multi-provider agent', async () => {
    const executionCwd = await createTempDir('kodax-prompt-identity-');
    cleanupDirs.push(executionCwd);

    const prompt = await buildSystemPrompt(
      {
        provider: 'openai',
        context: { executionCwd, gitRoot: executionCwd },
      },
      false,
    );

    expect(prompt).toContain('You are KodaX');
    expect(prompt).toContain('multi-provider coding agent');
    // Anti-regression: no leaked Claude/Anthropic identity in base prompt
    expect(prompt).not.toMatch(/\bYou are (Claude|Anthropic)\b/);
    expect(prompt).not.toMatch(/\bhelpful coding assistant\b/);
  });

  it('Phase B: runtime-fact section discloses provider and model', async () => {
    const executionCwd = await createTempDir('kodax-prompt-runtime-');
    cleanupDirs.push(executionCwd);

    const prompt = await buildSystemPrompt(
      {
        provider: 'deepseek',
        model: 'deepseek-v4',
        context: { executionCwd, gitRoot: executionCwd },
      },
      false,
    );

    expect(prompt).toMatch(/\[Runtime\] provider=deepseek; model=deepseek-v4\./);
  });

  it('Phase B: modelOverride takes precedence over model in runtime-fact', async () => {
    const executionCwd = await createTempDir('kodax-prompt-runtime-override-');
    cleanupDirs.push(executionCwd);

    const prompt = await buildSystemPrompt(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        modelOverride: 'claude-opus-4-7',
        context: { executionCwd, gitRoot: executionCwd },
      },
      false,
    );

    expect(prompt).toContain('[Runtime] provider=anthropic; model=claude-opus-4-7.');
    expect(prompt).not.toContain('model=claude-sonnet-4-6');
  });

  it('Phase B: runtime-fact lives in runtime-context slot (not cached base prefix)', async () => {
    const executionCwd = await createTempDir('kodax-prompt-runtime-slot-');
    cleanupDirs.push(executionCwd);

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        model: 'gpt-4o',
        context: { executionCwd, gitRoot: executionCwd },
      },
      false,
    );

    const runtimeSection = snapshot.sections.find((s) => s.id === 'runtime-fact');
    expect(runtimeSection).toBeDefined();
    expect(runtimeSection?.slot).toBe('runtime-context');
    expect(runtimeSection?.stability).toBe('dynamic');
  });

  it('Phase B: runtime-fact omitted when provider and model both absent', async () => {
    const executionCwd = await createTempDir('kodax-prompt-runtime-omit-');
    cleanupDirs.push(executionCwd);

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: '',
        context: { executionCwd, gitRoot: executionCwd },
      },
      false,
    );

    expect(snapshot.sections.some((s) => s.id === 'runtime-fact')).toBe(false);
  });

  it('Phase C (FEATURE_087): tool-construction section omitted by default', async () => {
    const executionCwd = await createTempDir('kodax-prompt-tc-default-');
    cleanupDirs.push(executionCwd);

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'anthropic',
        context: { executionCwd, gitRoot: executionCwd },
      },
      false,
    );

    expect(snapshot.sections.some((s) => s.id === 'tool-construction')).toBe(false);
    expect(snapshot.rendered).not.toContain('[Tool Construction Mode]');
  });

  it('Phase C (FEATURE_087): tool-construction section injected when toolConstructionMode=true', async () => {
    const executionCwd = await createTempDir('kodax-prompt-tc-on-');
    cleanupDirs.push(executionCwd);

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'anthropic',
        context: {
          executionCwd,
          gitRoot: executionCwd,
          toolConstructionMode: true,
        },
      },
      false,
    );

    const section = snapshot.sections.find((s) => s.id === 'tool-construction');
    expect(section).toBeDefined();
    expect(section?.slot).toBe('specialist');
    expect(snapshot.rendered).toContain('[Tool Construction Mode]');
    expect(snapshot.rendered).toContain('scaffold_tool');
    expect(snapshot.rendered).toContain('activate_tool');
    // Lives at the tail — after skill-addendum (specialist > skill-addendum order).
    const tcIdx = snapshot.rendered.indexOf('[Tool Construction Mode]');
    const wdIdx = snapshot.rendered.indexOf('Working Directory:');
    expect(tcIdx).toBeGreaterThan(wdIdx);
  });

  it('Batch E (FEATURE_142): rendered byte-equivalence — section assembly stays stable after extraction', async () => {
    const executionCwd = await createTempDir('kodax-prompt-byte-eq-');
    cleanupDirs.push(executionCwd);

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'deepseek',
        model: 'deepseek-v4',
        context: {
          executionCwd,
          gitRoot: executionCwd,
          repoIntelligenceContext: '## Repository Intelligence\nFROZEN-REPO-CTX',
          promptOverlay: '## Prompt Overlay\nFROZEN-OVERLAY',
          skillsPrompt: '## Skills\nFROZEN-SKILLS',
        },
      },
      false,
    );

    const normalized = snapshot.rendered
      .replaceAll(executionCwd, '<CWD>')
      .replaceAll(path.basename(executionCwd), '<BASENAME>')
      .replace(/Node: v[\d.]+/g, 'Node: <NODE>')
      .replace(/Platform: (Windows|macOS|Linux)/g, 'Platform: <PLATFORM>')
      .replace(/Use: (dir, move, copy, del|ls, mv, cp, rm)/g, 'Use: <SHELL_HINT>');

    // Anchored start/end + presence of every dynamic section header in order.
    const lines = normalized.split('\n');
    expect(lines[0]).toMatch(/^You are KodaX/);
    expect(normalized).toContain('Platform: <PLATFORM>');
    expect(normalized).toContain('Use: <SHELL_HINT>');
    expect(normalized).toContain('Node: <NODE>');
    expect(normalized).toContain('[Runtime] provider=deepseek; model=deepseek-v4.');
    expect(normalized).toContain('Working Directory: <CWD>');
    expect(normalized).toContain('## Repository Intelligence\nFROZEN-REPO-CTX');
    // Static EXECUTION GUIDANCE is always present; the caller-supplied
    // context.promptOverlay (Direct Path Rule / SDK overlay) is re-emitted
    // alongside it (ADR-043 Phase 3 regression fix — P1.7 had dropped it with
    // the retired router overlay). Only the router overlay text itself is gone.
    expect(normalized).toContain('EXECUTION GUIDANCE');
    expect(normalized).toContain('FROZEN-OVERLAY');
    expect(normalized).toContain('## Skills\nFROZEN-SKILLS');

    // Strict ordering — Batch E extraction must not reorder sections.
    const idxRuntimeFact = normalized.indexOf('[Runtime] provider=deepseek');
    const idxWorkingDir = normalized.indexOf('Working Directory: <CWD>');
    const idxRepoIntel = normalized.indexOf('## Repository Intelligence');
    const idxExecGuidance = normalized.indexOf('EXECUTION GUIDANCE');
    const idxSkills = normalized.indexOf('## Skills');
    expect(idxRuntimeFact).toBeLessThan(idxWorkingDir);
    expect(idxWorkingDir).toBeLessThan(idxRepoIntel);
    expect(idxRepoIntel).toBeLessThan(idxExecGuidance);
    expect(idxExecGuidance).toBeLessThan(idxSkills);

    // Hash is deterministic for fixed inputs (modulo cwd/platform/node — those
    // are baked into the rendered string, so the hash legitimately varies; what
    // we lock here is structural equivalence, not literal hash).
    expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('injects MCP capability truth when the extension runtime exposes it', async () => {
    const executionCwd = await createTempDir('kodax-prompt-mcp-');
    cleanupDirs.push(executionCwd);
    const runtime = createExtensionRuntime();
    runtime.registerCapabilityProvider({
      id: 'mcp',
      kinds: ['tool', 'resource', 'prompt'],
      getPromptContext: () => [
        '## MCP Capability Provider',
        'Use mcp_search before calling mcp_call directly.',
      ].join('\n'),
    });

    const snapshot = await buildSystemPromptSnapshot(
      {
        provider: 'openai',
        extensionRuntime: runtime,
        context: {
          executionCwd,
          gitRoot: executionCwd,
        },
      },
      false,
    );

    expect(snapshot.sections.some((section) => section.id === 'mcp-capability-context')).toBe(true);
    expect(snapshot.rendered).toContain('## MCP Capability Provider');
    expect(snapshot.rendered).toContain('Use mcp_search before calling mcp_call directly.');

    await runtime.dispose();
  });
});
