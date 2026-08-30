import { describe, expect, it } from 'vitest';

import {
  resolveReplRuntimePermissionDecision,
  toReplRuntimeAutoModeSettings,
  type ReplRuntimePermissionRequest,
} from './runtime-permission.js';

const request: ReplRuntimePermissionRequest = {
  id: 'permission-1',
  toolName: 'bash',
  input: { command: 'npm test' },
  grantSuggestions: [
    { id: 'session-scope', kind: 'session', label: 'This exact command for this session' },
    { id: 'persistent-scope', kind: 'persistent', label: 'Always allow this exact command' },
  ],
};

describe('resolveReplRuntimePermissionDecision', () => {
  it('returns only the Runtime-issued opaque suggestion ID', () => {
    expect(resolveReplRuntimePermissionDecision(request, {
      confirmed: true,
      runtimeGrantKind: 'session',
    })).toEqual({ type: 'allow_session', suggestionId: 'session-scope' });
    expect(resolveReplRuntimePermissionDecision(request, {
      confirmed: true,
      runtimeGrantKind: 'persistent',
    })).toEqual({ type: 'allow_always', suggestionId: 'persistent-scope' });
  });

  it('fails closed when the selected candidate is absent or expired', () => {
    expect(resolveReplRuntimePermissionDecision({ ...request, grantSuggestions: [] }, {
      confirmed: true,
      runtimeGrantKind: 'persistent',
    })).toEqual({ type: 'reject', reason: 'Runtime grant suggestion expired.' });
    expect(resolveReplRuntimePermissionDecision(request, { confirmed: false }))
      .toEqual({ type: 'reject', reason: 'User rejected the tool call.' });
  });

  it('keeps one-time approval independent of grant suggestions', () => {
    expect(resolveReplRuntimePermissionDecision(request, { confirmed: true }))
      .toEqual({ type: 'allow_once' });
  });
});

describe('toReplRuntimeAutoModeSettings', () => {
  it('forwards the fixed reviewer policy to Runtime', () => {
    expect(toReplRuntimeAutoModeSettings({
      reviewPolicy: 'Never publish packages from this machine.',
    })).toEqual({ reviewPolicy: 'Never publish packages from this machine.' });
  });
});
