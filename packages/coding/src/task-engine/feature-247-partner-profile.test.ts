/**
 * FEATURE_247 (R1) — Partner profile identity + instruction injection.
 *
 * Two behavioral changes are locked here, both gated on an
 * `options.context.agentProfile` being present so the default Coding Agent
 * path stays byte-identical:
 *
 *  - SA path: a profile's `instructions` map to the already-honored
 *    `systemPromptOverride` (an explicit caller override still wins).
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
import { emitEffectiveTaskConfig, resolveEffectiveVerification } from '../agent-runtime/effective-config.js';
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

describe('FEATURE_247 R1: SA-path profile instructions → systemPromptOverride', () => {
  it('maps agentProfile.instructions to systemPromptOverride when the caller did not set one', async () => {
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
    expect(opts.context.systemPromptOverride).toBe('PARTNER_SYS');
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
  it('reports the assembled scope, model projection and merged profile verification', () => {
    const configs: KodaXEffectiveTaskConfig[] = [];
    const options: KodaXOptions = { provider: 'fixture', agentMode: 'ama', workMode: 'agent',
      context: { workModePolicy: 'intersect', agentProfile: { id: 'partner',
        verification: { rubricFamily: 'partner-research', summary: 'profile' } },
        taskVerification: { summary: 'task' } },
      events: { onEffectiveConfig: config => configs.push(config) } };
    emitEffectiveTaskConfig(options, { agentMode: 'ama', toolScope: ['read', 'skill'], modelToolScope: ['skill'] });
    expect(configs).toEqual([{ agentMode: 'ama', workMode: 'agent', agentProfile: options.context!.agentProfile,
      toolScope: ['read', 'skill'], modelToolScope: ['skill'],
      verification: { rubricFamily: 'partner-research', summary: 'task' } }]);
    expect(() => emitEffectiveTaskConfig({ ...options, events: { onEffectiveConfig: () => { throw new Error('observer'); } } },
      { agentMode: 'ama', toolScope: [] })).not.toThrow();
  });

  it('does not invent an effective scope when execution has not assembled tools', async () => {
    const onEffectiveConfig = vi.fn();
    await dispatchManagedTask({ provider: 'fixture', agentMode: 'sa', events: { onEffectiveConfig } }, 'Inspect', saDeps());
    expect(onEffectiveConfig).not.toHaveBeenCalled();
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

  it('resolveEffectiveVerification: per-task verification is retained with or without a persona', () => {
    expect(
      resolveEffectiveVerification({
        provider: 'x',
        context: { taskVerification: { summary: 'coder-only standard' } },
      } as KodaXOptions),
    ).toEqual({ summary: 'coder-only standard' });
    // Adding a persona does not replace the explicit per-task standard.
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
