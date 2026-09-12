import { expect, it } from 'vitest';
import type { CurrentConfig } from '../commands/types.js';
import { applyClientSessionViewSettings, changedClientSessionSettings, clientSessionSettings } from './client-session-settings.js';

const initial: CurrentConfig = { provider: 'anthropic', model: 'startup-model', permissionMode: 'accept-edits',
  agentMode: 'sa', thinking: false, reasoningMode: 'off' };

it('retains unknown Host defaults for display without writing stale local modes on another selection', () => {
  const previous = { ...initial, permissionMode: 'plan' as const, reasoningMode: 'deep' as const, thinking: true, agentMode: 'ama' as const };
  const cleared = applyClientSessionViewSettings(previous, { settings: {} });
  expect(cleared.hostSettings).toEqual({});
  expect(changedClientSessionSettings(clientSessionSettings(cleared), clientSessionSettings({ ...cleared, model: 'next' })))
    .toEqual({ model: 'next' });
  const restored = applyClientSessionViewSettings(cleared, { settings: { permissionMode: 'auto', reasoningMode: 'off', thinking: false, agentMode: 'sa' } });
  expect(restored).toMatchObject({ permissionMode: 'auto', reasoningMode: 'off', thinking: false, agentMode: 'sa' });
});

it('displays another client selection from Host facts', () => {
  const next = applyClientSessionViewSettings(initial, { settings: { model: 'peer-model', permissionMode: 'plan' } });
  expect(next).toMatchObject({ model: 'peer-model', permissionMode: 'plan', provider: 'anthropic' });
  expect(initial).toMatchObject({ model: 'startup-model', permissionMode: 'accept-edits' });
});

it('preserves a local model confirmed after the view arrived while accepting unrelated peer settings', () => {
  const next = applyClientSessionViewSettings({ ...initial, model: 'confirmed-model' }, {
    settings: { model: 'older-model', permissionMode: 'plan', effort: 'low' },
  }, { model: 'confirmed-model' });
  expect(next).toMatchObject({ model: 'confirmed-model', permissionMode: 'plan', effort: 'low', effortOverride: true });
});

it('uses the Host resolved default model and leaves an unresolved new provider model unknown', () => {
  expect(applyClientSessionViewSettings(initial, { settings: {}, contextBudget: {
    provider: 'anthropic', model: 'host-default', scope: 'parent', contextWindow: 100000,
    reservedResponseTokens: 10000, compaction: { enabled: true, triggerPercent: 80 },
  } }).model).toBe('host-default');
  expect(applyClientSessionViewSettings(initial, { settings: { provider: 'unknown-provider' } }))
    .toMatchObject({ provider: 'unknown-provider', model: undefined });
});

it('clears a removed effort override and admits later peer changes to a previously local field', () => {
  const confirmed = applyClientSessionViewSettings(initial, { settings: { model: 'older-model' } }, { model: 'startup-model' });
  const next = applyClientSessionViewSettings({ ...confirmed, effort: 'high', effortOverride: true }, {
    settings: { model: 'later-peer-model' },
  });
  expect(next).toMatchObject({ model: 'later-peer-model', effort: undefined, effortOverride: false });
});
