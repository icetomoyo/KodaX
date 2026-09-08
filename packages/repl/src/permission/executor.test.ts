import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
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

  it('bypasses legacy helper-script and protected-path gates', async () => {
    const target = path.join(os.tmpdir(), 'user', '.kodax', 'temporary-helper.ps1');
    const coreContext: KodaXToolExecutionContext = { backups: new Map() };
    const permission = createPermissionContext({
      permissionMode: 'full-access',
      gitRoot: 'C:\\workspace',
      onConfirm: vi.fn(async () => ({ confirmed: false })),
    });

    await expect(executeWithPermission(
      'write',
      { path: target, content: 'ok' },
      coreContext,
      permission,
    )).resolves.toBe('executed');

    expect(codingMock.executeTool).toHaveBeenCalledOnce();
    expect(permission.onConfirm).not.toHaveBeenCalled();
    expect(codingMock.executeTool.mock.calls[0]?.[2].approvedTextMutationPath)
      .toBe(target);
    expect(coreContext).not.toHaveProperty('approvedTextMutationPath');
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
