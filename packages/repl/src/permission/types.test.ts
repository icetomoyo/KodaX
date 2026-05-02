import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_IN_PROJECT_DEPRECATION_MSG,
  PERMISSION_MODES,
  CANONICAL_PERMISSION_MODES,
  createAutoInProjectDeprecationEmitter,
  isAutoMode,
  canonicalizePermissionMode,
  computeConfirmTools,
  isPermissionMode,
  normalizePermissionMode,
} from './types.js';

describe('PermissionMode v0.7.33 — auto + auto-in-project alias', () => {
  it('PERMISSION_MODES includes both auto (canonical) and auto-in-project (alias)', () => {
    expect(PERMISSION_MODES).toContain('auto');
    expect(PERMISSION_MODES).toContain('auto-in-project');
  });

  it('CANONICAL_PERMISSION_MODES excludes the deprecated auto-in-project alias', () => {
    expect(CANONICAL_PERMISSION_MODES).toEqual(['plan', 'accept-edits', 'auto']);
    expect(CANONICAL_PERMISSION_MODES).not.toContain('auto-in-project');
  });

  it('isAutoMode returns true for both spellings', () => {
    expect(isAutoMode('auto')).toBe(true);
    expect(isAutoMode('auto-in-project')).toBe(true);
    expect(isAutoMode('plan')).toBe(false);
    expect(isAutoMode('accept-edits')).toBe(false);
  });

  it('canonicalizePermissionMode rewrites auto-in-project → auto', () => {
    expect(canonicalizePermissionMode('auto-in-project')).toBe('auto');
    expect(canonicalizePermissionMode('auto')).toBe('auto');
    expect(canonicalizePermissionMode('plan')).toBe('plan');
    expect(canonicalizePermissionMode('accept-edits')).toBe('accept-edits');
  });

  it('computeConfirmTools returns identical empty set for auto and auto-in-project', () => {
    const a = computeConfirmTools('auto');
    const b = computeConfirmTools('auto-in-project');
    expect([...a]).toEqual([...b]);
    expect(a.size).toBe(0);
  });

  it('isPermissionMode accepts both spellings', () => {
    expect(isPermissionMode('auto')).toBe(true);
    expect(isPermissionMode('auto-in-project')).toBe(true);
    expect(isPermissionMode('YOLO')).toBe(false);
  });

  it('normalizePermissionMode preserves both spellings without forcing canonical', () => {
    // canonicalization is an explicit boundary call, not implicit on normalize
    expect(normalizePermissionMode('auto-in-project')).toBe('auto-in-project');
    expect(normalizePermissionMode('auto')).toBe('auto');
  });
});

describe('auto-in-project deprecation emitter (FEATURE_092 phase 2b.7b slice E)', () => {
  it('AUTO_IN_PROJECT_DEPRECATION_MSG mentions both the alias and the canonical name + a removal version', () => {
    expect(AUTO_IN_PROJECT_DEPRECATION_MSG).toContain('auto-in-project');
    expect(AUTO_IN_PROJECT_DEPRECATION_MSG).toContain('auto');
    expect(AUTO_IN_PROJECT_DEPRECATION_MSG).toMatch(/v0\.7\.\d+/);
  });

  it('emits the message on the first call', () => {
    const printer = vi.fn();
    const emit = createAutoInProjectDeprecationEmitter(printer);
    emit();
    expect(printer).toHaveBeenCalledOnce();
    expect(printer).toHaveBeenCalledWith(AUTO_IN_PROJECT_DEPRECATION_MSG);
  });

  it('does NOT emit again on subsequent calls (once-per-session contract)', () => {
    const printer = vi.fn();
    const emit = createAutoInProjectDeprecationEmitter(printer);
    emit();
    emit();
    emit();
    expect(printer).toHaveBeenCalledOnce();
  });

  it('two distinct emitters maintain independent state', () => {
    const printer1 = vi.fn();
    const printer2 = vi.fn();
    const emit1 = createAutoInProjectDeprecationEmitter(printer1);
    const emit2 = createAutoInProjectDeprecationEmitter(printer2);
    emit1();
    emit1(); // suppressed
    emit2();
    expect(printer1).toHaveBeenCalledOnce();
    expect(printer2).toHaveBeenCalledOnce();
  });

  it('default printer routes through console.warn (stderr, not piped stdout)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const emit = createAutoInProjectDeprecationEmitter();
      emit();
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(AUTO_IN_PROJECT_DEPRECATION_MSG);
    } finally {
      spy.mockRestore();
    }
  });
});
