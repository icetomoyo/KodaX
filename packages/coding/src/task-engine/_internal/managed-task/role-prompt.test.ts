import { describe, expect, it } from 'vitest';
import { createRolePrompt } from './role-prompt.js';
import { buildFallbackRoutingDecision } from '../../../reasoning.js';
import type { ManagedRolePromptContext } from './role-prompt-types.js';

const userQuestion = '你底层用的是什么模型？';

function buildContext(
  overrides: Partial<NonNullable<ManagedRolePromptContext['workspace']>> = {},
): ManagedRolePromptContext {
  return {
    originalTask: userQuestion,
    workspace: {
      executionCwd: 'C:\\Works\\GitWorks\\KodaX-author\\KodaX',
      platform: 'win32',
      osRelease: '10.0.19045',
      ...overrides,
    },
  };
}

function callScout(ctx: ManagedRolePromptContext): string {
  const decision = buildFallbackRoutingDecision(userQuestion);
  return createRolePrompt(
    'scout',
    userQuestion,
    decision,
    undefined,
    undefined,
    'kodax/role/scout',
    undefined,
    ctx,
    undefined,
    false,
  );
}

describe('createRolePrompt — runtime identity in workspace section', () => {
  it('emits Provider and Model lines when both are supplied', () => {
    const rendered = callScout(
      buildContext({ provider: 'ark-coding', model: 'glm-5.1' }),
    );
    expect(rendered).toContain('Provider: ark-coding');
    expect(rendered).toContain('Model: glm-5.1');
  });

  it('places Provider/Model inside the ## Environment block (not elsewhere)', () => {
    const rendered = callScout(
      buildContext({ provider: 'kimi-code', model: 'kimi-for-coding' }),
    );
    const envIdx = rendered.indexOf('## Environment');
    const providerIdx = rendered.indexOf('Provider: kimi-code');
    const modelIdx = rendered.indexOf('Model: kimi-for-coding');
    const shellIdx = rendered.indexOf('Shell defaults:');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThan(envIdx);
    expect(modelIdx).toBeGreaterThan(envIdx);
    // Sanity: runtime fact comes before the shell-defaults guidance,
    // matching the proximity assumption in the role-prompt source.
    expect(providerIdx).toBeLessThan(shellIdx);
    expect(modelIdx).toBeLessThan(shellIdx);
  });

  it('omits Provider line when provider is absent', () => {
    const rendered = callScout(buildContext({ model: 'glm-5.1' }));
    expect(rendered).not.toMatch(/^Provider:/m);
    expect(rendered).toContain('Model: glm-5.1');
  });

  it('omits Model line when model is absent', () => {
    const rendered = callScout(buildContext({ provider: 'ark-coding' }));
    expect(rendered).toContain('Provider: ark-coding');
    expect(rendered).not.toMatch(/^Model:/m);
  });

  it('emits neither when workspace lacks both fields (legacy callers unaffected)', () => {
    const rendered = callScout(buildContext());
    expect(rendered).not.toMatch(/^Provider:/m);
    expect(rendered).not.toMatch(/^Model:/m);
    // Sanity: the rest of the workspace block still renders.
    expect(rendered).toContain('## Environment');
    expect(rendered).toContain('Working Directory:');
    expect(rendered).toContain('Platform: Windows');
  });

  it('emits identity facts for non-Scout roles too (Generator)', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const rendered = createRolePrompt(
      'generator',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/generator',
      undefined,
      buildContext({ provider: 'zhipu-coding', model: 'glm-5' }),
      undefined,
      false,
    );
    expect(rendered).toContain('Provider: zhipu-coding');
    expect(rendered).toContain('Model: glm-5');
  });
});

// FEATURE_107 (v0.7.32): Generator reasoning-discipline now hardcoded as default
// after P6 eval confirmed it's harmless on low-context tasks across 6 aliases.
// Originally an env-gated experiment (KODAX_GENERATOR_REASONING_DISCIPLINE);
// promoted to always-on prompt fragment.
describe('FEATURE_107 — Generator reasoning discipline (Claude Code verbatim)', () => {
  function renderGenerator(): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    return createRolePrompt(
      'generator',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/generator',
      undefined,
      buildContext({ provider: 'p', model: 'm' }),
      undefined,
      false,
    );
  }

  it('Generator prompt includes the discipline block by default (no env hook)', () => {
    const rendered = renderGenerator();
    // v3 core sentences (Claude Code verbatim with emit_handoff swap)
    expect(rendered).toContain('diagnose why before switching tactics');
    expect(rendered).toContain('check your assumptions');
    expect(rendered).toContain('Don\'t retry the identical action blindly');
    expect(rendered).toContain('don\'t abandon a viable approach after a single failure');
    expect(rendered).toContain('Reserve emit_handoff status="blocked"');
    expect(rendered).toContain('genuine impasses after investigation');
    expect(rendered).toContain('not as a first response to friction');
  });

  it('Earlier-iteration artifacts (v1/v2) are not present', () => {
    const rendered = renderGenerator();
    expect(rendered).not.toContain('_debug.test.ts');
    expect(rendered).not.toContain('three consecutive');
    expect(rendered).not.toContain('Forbidden anti-patterns');
    expect(rendered).not.toContain('targeted piece of evidence');
  });

  it('Discipline block does NOT bleed into non-Generator roles (Scout / Planner / Evaluator)', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    for (const role of ['scout', 'planner', 'evaluator'] as const) {
      const rendered = createRolePrompt(
        role,
        userQuestion,
        decision,
        undefined,
        undefined,
        `kodax/role/${role}`,
        undefined,
        buildContext({ provider: 'p', model: 'm' }),
        undefined,
        false,
      );
      expect(rendered, `role=${role}`).not.toContain('Don\'t retry the identical action blindly');
    }
  });
});
