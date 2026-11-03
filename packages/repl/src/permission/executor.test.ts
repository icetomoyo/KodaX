import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXToolExecutionContext } from '@kodax-ai/coding';
import { createPermissionContext, executeWithPermission } from './executor.js';

const codingMock = vi.hoisted(() => ({ executeTool: vi.fn() }));

vi.mock('@kodax-ai/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  return { ...actual, executeTool: codingMock.executeTool };
});

describe('executeWithPermission Full Access', () => {
  beforeEach(() => {
    codingMock.executeTool.mockReset();
    codingMock.executeTool.mockResolvedValue('executed');
  });

  it('directs a blocked plan write to the existing approval tool without executing or approving it', async () => {
    const permission = createPermissionContext({ permissionMode: 'plan', gitRoot: process.cwd(), onConfirm: vi.fn(async () => ({ confirmed: false })) });
    const result = await executeWithPermission('write', { path: 'src/fixture-plan-write.ts', content: 'must not write' }, { backups: new Map() }, permission);
    expect(result).toContain('exit_plan_mode');
    expect(result).not.toContain('set_permission_mode');
    expect(codingMock.executeTool).not.toHaveBeenCalled();
    expect(permission.onConfirm).not.toHaveBeenCalled();
  });

  it('bypasses legacy helper-script and protected-path gates', async () => {
    const coreContext: KodaXToolExecutionContext = { backups: new Map() };
    const permission = createPermissionContext({
      permissionMode: 'full-access',
      gitRoot: 'C:\\workspace',
      onConfirm: vi.fn(async () => ({ confirmed: false })),
    });

    await expect(executeWithPermission(
      'write',
      { path: 'C:\\Users\\ADMIN\\.kodax\\temporary-helper.ps1', content: 'ok' },
      coreContext,
      permission,
    )).resolves.toBe('executed');

    expect(codingMock.executeTool).toHaveBeenCalledOnce();
    expect(permission.onConfirm).not.toHaveBeenCalled();
  });

  it('leaves Auto host-path judgment to the Auto reviewer', async () => {
    const coreContext: KodaXToolExecutionContext = { backups: new Map() };
    const permission = createPermissionContext({
      permissionMode: 'auto',
      gitRoot: 'C:\\workspace',
      onConfirm: vi.fn(async () => ({ confirmed: false })),
    });

    await expect(executeWithPermission(
      'write',
      { path: 'C:\\outside\\temporary-helper.ps1', content: 'ok' },
      coreContext,
      permission,
    )).resolves.toBe('executed');
    expect(permission.onConfirm).not.toHaveBeenCalled();
  });
});
