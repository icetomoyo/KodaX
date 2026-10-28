import { describe, expect, it } from 'vitest';
import { withEffectivePermissionContext } from './effective-permissions.js';

describe('effective task permission context', () => {
  it('shows the read-only task ceiling instead of unrestricted host mutation teaching', () => {
    const text = withEffectivePermissionContext('Specialist review instructions', {
      resolveShellPermissionMode: () => 'full-access',
      permissionIntent: { readOnly: true },
    });
    expect(text).toContain('Specialist review instructions');
    expect(text).toContain('Current permission mode: full-access');
    expect(text).toContain('Current task scope: read-only');
    expect(text).toContain('does not authorize mutation or writable delegation');
    expect(text).not.toContain('Ordinary local text targets may be outside the workspace');
    expect(text).not.toContain('Shell runs on the host without sandbox or approval prompts');
  });

  it('does not require a host-mode resolver to disclose a known read-only scope', () => {
    const text = withEffectivePermissionContext('SDK instructions', { permissionIntent: { readOnly: true } });
    expect(text).toContain('Current task scope: read-only');
    expect(text).not.toContain('Current permission mode:');
  });

  it('retains normal host guidance and refreshes task scope on the next request', () => {
    const permissionIntent = { readOnly: true };
    const context = { resolveShellPermissionMode: () => 'full-access' as const, permissionIntent };
    expect(withEffectivePermissionContext('Base', context)).toContain('Current task scope: read-only');
    permissionIntent.readOnly = false;
    const text = withEffectivePermissionContext('Base', context);
    expect(text).not.toContain('Current task scope: read-only');
    expect(text).toContain('Shell runs on the host without sandbox or approval prompts');
    expect(withEffectivePermissionContext('Base', undefined)).toBe('Base');
  });
});
