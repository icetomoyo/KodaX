/**
 * FEATURE_247 (R1) — Partner profile identity + instruction injection.
 *
 * Two behavioral changes are locked here, both gated on an
 * `options.context.agentProfile` being present so the default Coding Agent
 * path stays byte-identical:
 *
 *  - SA path: a profile's `instructions` remain distinct from a complete
 *    `systemPromptOverride` so prompt composition retains the Skill catalog.
 *  - AMA path: the Worker role prompt PREPENDS the profile instructions
 *    (`resolveRoleInstructions`), and only for the primary `worker` role.
 */

import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { dispatchManagedTask } from '../task-engine.js';
import { buildFallbackRoutingDecision } from '../reasoning.js';
import { resolveEffectiveVerification } from '../agent-runtime/effective-config.js';
import type { KodaXEffectiveTaskConfig, KodaXOptions, KodaXResult } from '../types.js';
import {
  resolveRoleInstructions,
  WORKER_INSTRUCTIONS_FALLBACK,
} from './_internal/managed-task/role-prompts.js';
import type { RunnerChainPromptContext } from './_internal/managed-task/types.js';

const OK_RESULT: KodaXResult = {
  success: true,
  lastText: '',
  messages: [],
  sessionId: 's',
};

function saDeps() {
  const runSA = vi.fn().mockResolvedValue(OK_RESULT);
  const runAMA = vi.fn();
  const buildPlan = vi.fn();
  return { runSA, runAMA, buildPlan };
}

describe('FEATURE_247 R1: SA-path profile instructions', () => {
  it('preserves profile instructions separately from a caller prompt override', async () => {
    const deps = saDeps();
    await dispatchManagedTask(
      {
        agentMode: 'sa',
        provider: 'anthropic',
        context: { agentProfile: { surface: 'partner', instructions: 'PARTNER_SYS' } },
      } as KodaXOptions,
      'answer a question',
      deps,
    );
    const [opts] = deps.runSA.mock.calls[0]!;
    expect(opts.context.agentProfile.instructions).toBe('PARTNER_SYS');
    expect(opts.context.systemPromptOverride).toBeUndefined();
  });

  it('lets an explicit systemPromptOverride win over profile instructions', async () => {
    const deps = saDeps();
    await dispatchManagedTask(
      {
        agentMode: 'sa',
        provider: 'anthropic',
        context: {
          systemPromptOverride: 'EXPLICIT',
          agentProfile: { instructions: 'PARTNER_SYS' },
        },
      } as KodaXOptions,
      'answer a question',
      deps,
    );
    const [opts] = deps.runSA.mock.calls[0]!;
    expect(opts.context.systemPromptOverride).toBe('EXPLICIT');
  });

  it('leaves systemPromptOverride undefined for the default Coding Agent (no profile)', async () => {
    const deps = saDeps();
    await dispatchManagedTask(
      { agentMode: 'sa', provider: 'anthropic', context: {} } as KodaXOptions,
      'answer a question',
      deps,
    );
    const [opts] = deps.runSA.mock.calls[0]!;
    expect(opts.context.systemPromptOverride).toBeUndefined();
  });
});

describe('FEATURE_247 R1: AMA-path Worker prompt prepends profile instructions', () => {
  const decision = buildFallbackRoutingDecision('do the task');
  const baseCtx: RunnerChainPromptContext = {
    prompt: 'do the task',
    decision,
    partnerInstructions: 'PARTNER_DIRECTIVE_SENTINEL',
  };

  it('prepends partnerInstructions for the primary worker role', () => {
    const out = resolveRoleInstructions('worker',
'kodax/coding/worker',
WORKER_INSTRUCTIONS_FALLBACK,
baseCtx,
undefined
    );
    expect(out.startsWith('PARTNER_DIRECTIVE_SENTINEL')).toBe(true);
  });

  it('does NOT prepend for a non-worker role (e.g. evaluator)', () => {
    const out = resolveRoleInstructions('evaluator',
'kodax/coding/evaluator',
WORKER_INSTRUCTIONS_FALLBACK,
baseCtx,
undefined
    );
    expect(out.startsWith('PARTNER_DIRECTIVE_SENTINEL')).toBe(false);
  });

  it('produces a byte-identical worker prompt when no profile instructions are set', () => {
    const withProfile = resolveRoleInstructions('worker',
'kodax/coding/worker',
WORKER_INSTRUCTIONS_FALLBACK,
{ ...baseCtx, partnerInstructions: undefined },
undefined
    );
    const withoutField = resolveRoleInstructions('worker',
'kodax/coding/worker',
WORKER_INSTRUCTIONS_FALLBACK,
{ prompt: 'do the task', decision },
undefined
    );
    expect(withProfile).toBe(withoutField);
    expect(withProfile).not.toContain('PARTNER_DIRECTIVE_SENTINEL');
  });
});

describe('FEATURE_247 R4: onEffectiveConfig snapshot', () => {
  it('SA path emits agentMode=sa, echoes the profile, excludes SA-solo + caller tools, reports merged verification', async () => {
    const configs: KodaXEffectiveTaskConfig[] = [];
    const deps = saDeps();
    await dispatchManagedTask(
      {
        agentMode: 'sa',
        provider: 'anthropic',
        context: {
          agentProfile: {
            surface: 'partner',
            verification: { summary: 'profile-default', rubricFamily: 'partner-research' },
          },
          taskVerification: { summary: 'per-task-wins' },
          excludeTools: ['read'],
        },
        events: { onEffectiveConfig: (c) => configs.push(c) },
      } as KodaXOptions,
      'answer a question',
      deps,
    );
    expect(configs).toHaveLength(1);
    const c = configs[0]!;
    expect(c.agentMode).toBe('sa');
    expect(c.agentProfile?.surface).toBe('partner');
    expect(c.toolScope).not.toContain('read'); // caller-excluded
    expect(c.toolScope).not.toContain('spawn_agent'); // SA-solo excluded
    expect(c.toolScope).toContain('glob'); // a normal readonly tool stays visible
    // per-task wins over the profile default; profile default fills the gap.
    expect(c.verification?.summary).toBe('per-task-wins');
    expect(c.verification?.rubricFamily).toBe('partner-research');
    // R4: the snapshot reports the verifier that will actually enforce
    // (inherit-main resolves to the caller's provider), not always undefined.
    expect(c).not.toHaveProperty('verifier');
  });

  it('AMA path emits agentMode=ama and keeps multi-agent tools visible', async () => {
    const configs: KodaXEffectiveTaskConfig[] = [];
    const deps = {
      runSA: vi.fn(),
      runAMA: vi.fn().mockResolvedValue(OK_RESULT),
      buildPlan: vi.fn().mockResolvedValue({ effort: 'none', decision: {}, promptOverlay: '' }),
    };
    await dispatchManagedTask(
      {
        agentMode: 'ama',
        provider: 'anthropic',
        context: {},
        events: { onEffectiveConfig: (c) => configs.push(c) },
      } as KodaXOptions,
      'answer a question',
      deps,
    );
    expect(configs).toHaveLength(1);
    expect(configs[0]!.agentMode).toBe('ama');
    expect(configs[0]!.toolScope).toContain('spawn_agent');
    expect(configs[0]!.toolScope).toContain('wait_agent');
  });

  it('does not fire (and never throws) when no subscriber is set', async () => {
    const deps = saDeps();
    await expect(
      dispatchManagedTask(
        { agentMode: 'sa', provider: 'anthropic', context: {} } as KodaXOptions,
        'answer a question',
        deps,
      ),
    ).resolves.toBeDefined();
  });

  it('R2: a toolVisibilityPolicy narrows the reported toolScope (readonly-only Partner)', async () => {
    const configs: KodaXEffectiveTaskConfig[] = [];
    const deps = saDeps();
    await dispatchManagedTask(
      {
        agentMode: 'sa',
        provider: 'anthropic',
        context: {
          agentProfile: { surface: 'partner' },
          // Partner sees only read-only + read-network tools.
          toolVisibilityPolicy: (t) =>
            t.sideEffect === 'readonly' || t.sideEffect === 'reads-network',
        },
        events: { onEffectiveConfig: (c) => configs.push(c) },
      } as KodaXOptions,
      'answer a question',
      deps,
    );
    const scope = configs[0]!.toolScope;
    expect(scope).toContain('read');
    expect(scope).toContain('web_search');
    expect(scope).not.toContain('write'); // mutates-fs hidden by the policy
    expect(scope).not.toContain('bash'); // mutates-shell hidden by the policy
  });

  it('resolveEffectiveVerification: per-task wins, profile fills gaps, undefined when neither', () => {
    expect(
      resolveEffectiveVerification({ provider: 'x', context: {} } as KodaXOptions),
    ).toBeUndefined();
    const merged = resolveEffectiveVerification({
      provider: 'x',
      context: {
        agentProfile: { verification: { summary: 'p', rubricFamily: 'partner-research' } },
        taskVerification: { summary: 't' },
      },
    } as KodaXOptions);
    expect(merged?.summary).toBe('t');
    expect(merged?.rubricFamily).toBe('partner-research');
  });

  it('resolveEffectiveVerification: taskVerification WITHOUT a profile does not reach the sidecar (returns undefined)', () => {
    expect(
      resolveEffectiveVerification({
        provider: 'x',
        context: { taskVerification: { summary: 'coder-only standard' } },
      } as KodaXOptions),
    ).toEqual({ summary: 'coder-only standard' });
    // But WITH a profile (even if the profile itself declares no verification),
    // the per-task standard reaches the sidecar.
    const partnerPerTask = resolveEffectiveVerification({
      provider: 'x',
      context: {
        agentProfile: { surface: 'partner' },
        taskVerification: { summary: 'partner per-task standard' },
      },
    } as KodaXOptions);
    expect(partnerPerTask?.summary).toBe('partner per-task standard');
  });
});
