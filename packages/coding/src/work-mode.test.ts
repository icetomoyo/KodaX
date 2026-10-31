import { expect, it } from 'vitest';
import { resolveWorkMode } from './index.js';
import type { KodaXContextOptions } from './types.js';

it.each(['agent', 'coding', 'script'] as const)('resolves %s without changing Coder defaults or specialist children', workMode => {
  expect(resolveWorkMode({})).toBe('coding');
  expect(resolveWorkMode({ workMode })).toBe(workMode);
  const declarations: KodaXContextOptions[] = [
    { agentProfile: { id: 'partner' } },
    { toolVisibilityPolicy: () => true },
    { systemPromptOverride: 'Host instructions' },
  ];
  for (const context of declarations) {
    expect(resolveWorkMode({ workMode, context })).toBe('coding');
    expect(resolveWorkMode({ workMode, context: { ...context, workModePolicy: 'intersect' } })).toBe(workMode);
    expect(resolveWorkMode({ workMode, context: {
      ...context, workModePolicy: 'intersect', currentAgentId: '/root/expert',
    } })).toBe('coding');
  }
});

it('rejects unknown composition policies instead of silently retaining Coding', () => {
  expect(() => resolveWorkMode({ workMode: 'agent', context: {
    workModePolicy: 'replace' as 'intersect',
  } })).toThrow('Unsupported work mode policy');
});
