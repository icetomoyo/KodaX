import { describe, expect, it, vi } from 'vitest';
import { toolExitPlanMode } from './exit-plan-mode.js';
import type { KodaXToolExecutionContext } from '../types.js';

function createCtx(overrides: Partial<KodaXToolExecutionContext> = {}): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    ...overrides,
  };
}

describe('toolExitPlanMode (FEATURE_074)', () => {
  it('returns an error when plan parameter is missing', async () => {
    const ctx = createCtx({ exitPlanMode: vi.fn().mockResolvedValue(true) });
    const result = await toolExitPlanMode({}, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Missing required parameter: plan');
  });

  it('returns an error when plan parameter is empty or whitespace', async () => {
    const ctx = createCtx({ exitPlanMode: vi.fn().mockResolvedValue(true) });
    const result = await toolExitPlanMode({ plan: '   ' }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Missing required parameter: plan');
  });

  it('returns an error when exitPlanMode callback is not wired (non-REPL run)', async () => {
    const ctx = createCtx();
    const result = await toolExitPlanMode({ plan: 'Step 1: do X' }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Only available in interactive REPL sessions');
  });

  it('returns approved=true and a proceed note when user approves', async () => {
    const exitPlanMode = vi.fn().mockResolvedValue(true);
    const ctx = createCtx({ exitPlanMode });
    const result = await toolExitPlanMode({ plan: 'Step 1: do X' }, ctx);
    const parsed = JSON.parse(result);
    expect(parsed.approved).toBe(true);
    expect(parsed.note).toContain('accept-edits');
    expect(exitPlanMode).toHaveBeenCalledWith('Step 1: do X');
  });

  it('returns approved=false and a revise note when user rejects', async () => {
    const exitPlanMode = vi.fn().mockResolvedValue(false);
    const ctx = createCtx({ exitPlanMode });
    const result = await toolExitPlanMode({ plan: 'Step 1: do X' }, ctx);
    const parsed = JSON.parse(result);
    expect(parsed.approved).toBe(false);
    expect(parsed.note).toContain('Remain in plan mode');
    expect(exitPlanMode).toHaveBeenCalledWith('Step 1: do X');
  });

  it('returns a Tool Error when the session is not in plan mode', async () => {
    const exitPlanMode = vi.fn().mockResolvedValue('not-in-plan-mode');
    const ctx = createCtx({ exitPlanMode });
    const result = await toolExitPlanMode({ plan: 'Step 1: do X' }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Not currently in plan mode');
    expect(result).toContain('proceed directly');
  });

  it('returns an error when plan parameter has wrong type', async () => {
    const ctx = createCtx({ exitPlanMode: vi.fn().mockResolvedValue(true) });
    const result = await toolExitPlanMode({ plan: 42 as unknown as string }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Missing required parameter: plan');
  });
});
