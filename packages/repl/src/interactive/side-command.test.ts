import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_COMMANDS } from './commands.js';
import type { CommandCallbacks, CurrentConfig, InteractiveContext } from '../commands/types.js';

const side = BUILTIN_COMMANDS.find(command => command.name === 'side');

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

it('registers /side with the /btw alias so it is listed and completed', () => {
  expect(side?.aliases).toContain('btw');
});

it('tells a classic-renderer user that side chat needs the fullscreen UI instead of reporting an unknown command', async () => {
  await side!.handler(['why?'], {} as InteractiveContext, {} as CommandCallbacks, {} as CurrentConfig);
  const printed = vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n');
  expect(printed).toContain('Side chat needs the fullscreen UI');
  expect(printed).toContain('KODAX_FORCE_CLASSIC_REPL');
});
