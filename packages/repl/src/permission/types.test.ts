import { describe, expect, it } from 'vitest';
import {
  PERMISSION_MODES,
  CANONICAL_PERMISSION_MODES,
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
