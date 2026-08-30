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

  it('CANONICAL_PERMISSION_MODES exposes the four v0.7.96 permission profiles', () => {
    expect(CANONICAL_PERMISSION_MODES).toEqual([
      'plan',
      'accept-edits',
      'auto',
      'full-access',
    ]);
    expect(CANONICAL_PERMISSION_MODES).not.toContain('auto-in-project');
  });

  it('isAutoMode returns true for both spellings', () => {
    expect(isAutoMode('auto')).toBe(true);
    expect(isAutoMode('auto-in-project')).toBe(true);
    expect(isAutoMode('plan')).toBe(false);
    expect(isAutoMode('accept-edits')).toBe(false);
    expect(isAutoMode('full-access')).toBe(false);
  });

  it('canonicalizePermissionMode rewrites auto-in-project → auto', () => {
    expect(canonicalizePermissionMode('auto-in-project')).toBe('auto');
    expect(canonicalizePermissionMode('auto')).toBe('auto');
    expect(canonicalizePermissionMode('plan')).toBe('plan');
    expect(canonicalizePermissionMode('accept-edits')).toBe('accept-edits');
    expect(canonicalizePermissionMode('full-access')).toBe('full-access');
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
    expect(isPermissionMode('full-access')).toBe(true);
    expect(isPermissionMode('YOLO')).toBe(false);
  });

  it('normalizePermissionMode folds the compatibility alias at the read boundary', () => {
    expect(normalizePermissionMode('auto-in-project')).toBe('auto');
    expect(normalizePermissionMode('auto')).toBe('auto');
    expect(normalizePermissionMode('full-access')).toBe('full-access');
    expect(normalizePermissionMode('invalid', 'auto-in-project')).toBe('auto');
  });

  it('Full Access has no interactive confirmation tools and renders its product label', async () => {
    expect([...computeConfirmTools('full-access')]).toEqual([]);
    const { permissionModeDisplayName } = await import('./types.js');
    expect(permissionModeDisplayName('full-access')).toBe('Full Access');
  });
});
