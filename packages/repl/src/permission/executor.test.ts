import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXToolExecutionContext } from '@kodax-ai/coding';
import { createPermissionContext, executeWithPermission } from './executor.js';

const codingMock = vi.hoisted(() => ({ executeTool: vi.fn() }));

vi.mock('@kodax-ai/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  return { ...actual, executeTool: codingMock.executeTool };
});

describe('executeWithPermission MCP tool annotations', () => {
  beforeEach(() => {
    codingMock.executeTool.mockReset();
    codingMock.executeTool.mockResolvedValue('executed');
  });

  const contextFor = (annotations: Record<string, unknown>): KodaXToolExecutionContext => ({
    backups: new Map(),
    extensionRuntime: { describeCapability: async () => ({ annotations }) } as unknown as KodaXToolExecutionContext['extensionRuntime'],
  });
  const call = { id: 'mcp:docs:tool:search', args: { query: 'x' } };

  it('runs a readOnlyHint MCP tool in plan and accept-edits without asking', async () => {
    for (const permissionMode of ['plan', 'accept-edits'] as const) {
      const permission = createPermissionContext({ permissionMode, gitRoot: process.cwd(), onConfirm: vi.fn(async () => ({ confirmed: false })) });
      await expect(executeWithPermission('mcp_call', call, contextFor({ readOnlyHint: true }), permission)).resolves.toBe('executed');
      expect(permission.onConfirm).not.toHaveBeenCalled();
    }
  });

  it('asks before an unannotated MCP tool in accept-edits and blocks it in plan', async () => {
    const edits = createPermissionContext({ permissionMode: 'accept-edits', gitRoot: process.cwd(), onConfirm: vi.fn(async () => ({ confirmed: false })) });
    await expect(executeWithPermission('mcp_call', call, contextFor({}), edits)).resolves.toContain('[Cancelled]');
    expect(edits.onConfirm).toHaveBeenCalledOnce();
    const plan = createPermissionContext({ permissionMode: 'plan', gitRoot: process.cwd() });
    await expect(executeWithPermission('mcp_call', call, contextFor({}), plan)).resolves.toContain('[Blocked]');
    expect(codingMock.executeTool).not.toHaveBeenCalled();
  });
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
