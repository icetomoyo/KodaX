import { expect, it, vi } from 'vitest';
import { executeShellCommand } from './shell-executor.js';

it('passes the exact manual command to the execution owner and preserves its refusal', async () => {
  const command = 'Remove-Item -LiteralPath ./temporary.txt -Force';
  const execute = vi.fn(async () => ({ success: true, lastText: 'done' }));
  await expect(executeShellCommand(command, { execute, onOutput: () => {} })).resolves.toContain('[Shell command executed:');
  expect(execute).toHaveBeenCalledWith(command);
  execute.mockResolvedValueOnce({ success: false, lastText: '{"denialSource":"explicit_rule","code":"exec_policy_forbidden"}' });
  await expect(executeShellCommand(command, { execute, onOutput: () => {} })).resolves.toContain('"denialSource":"explicit_rule"');
  expect(execute).toHaveBeenCalledTimes(2);
});

it('reports a missing execution owner without launching an unmanaged process', async () => {
  await expect(executeShellCommand('echo harmless', { onOutput: () => {} })).resolves.toContain('runtime_execution_unavailable');
});
