import { expect, it, vi } from 'vitest';
import { workModeCommand } from './work-mode-command.js';

it.each(['agent', 'coding', 'script'] as const)('applies %s through the Session owner only', async mode => {
  const setWorkMode = vi.fn(async () => undefined);
  const setAgentMode = vi.fn();
  const setPermissionMode = vi.fn();
  const config = { agentMode: 'ama', workMode: 'coding' };
  expect(await workModeCommand.handler([mode], {} as never, { setWorkMode, setAgentMode, setPermissionMode } as never, config as never)).toMatchObject({ success: true });
  expect(setWorkMode).toHaveBeenCalledExactlyOnceWith(mode);
  expect(setAgentMode).not.toHaveBeenCalled();
  expect(setPermissionMode).not.toHaveBeenCalled();
  expect(config).toEqual({ agentMode: 'ama', workMode: 'coding' });
});

it('reports a busy owner refusal without claiming a mode change', async () => {
  const result = await workModeCommand.handler(['script'], {} as never,
    { setWorkMode: async () => { throw new Error('Run active'); } } as never, {} as never);
  expect(result).toMatchObject({ success: false, message: expect.stringContaining('Run active') });
});
