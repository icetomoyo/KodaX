/**
 * FEATURE_247 (R1) — Partner profile identity + instruction injection.
 *
 * The behavior is gated on an `options.context.agentProfile` being present so
 * the default Coding Agent path stays byte-identical: the Worker role prompt
 * PREPENDS the profile instructions (`resolveRoleInstructions`), and only for
 * the primary `worker` role.
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

function amaDeps() {
  const runAMA = vi.fn().mockResolvedValue(OK_RESULT);
  const buildPlan = vi.fn().mockResolvedValue({ effort: 'none', decision: {}, promptOverlay: '' });
  return { runAMA, buildPlan };
}

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
    await dispatchManagedTask({ provider: 'fixture', events: { onEffectiveConfig } }, 'Inspect', amaDeps());
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
