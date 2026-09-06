/**
 * Public command-system exports.
 */

import * as path from 'path';
import * as os from 'os';

import { emitKodaXDiagnostic, getAgentConfigPath } from '@kodax-ai/agent';

import type { CommandRegistry } from './registry.js';
import { CommandRegistry as ReplCommandRegistry } from './registry.js';
import { registerBuiltinCommands } from './builtin.js';
import { discoverCommands, registerDiscoveredCommands } from './discovery.js';
import type { CommandInfo } from './types.js';

export type {
  CommandSource,
  CommandPriority,
  CurrentConfig,
  CommandCallbacks,
  CommandHandler,
  CommandResult,
  CommandResultData,
  CommandDefinition,
  CommandInfo,
  Command,
} from './types.js';
export { toCommandDefinition } from './types.js';

export { CommandRegistry, globalCommandRegistry } from './registry.js';

export { registerBuiltinCommands, getBuiltinCommandCount } from './builtin.js';

export { copyCommand } from './copy-command.js';
export { learnCommand } from './learn-command.js';
export { memoryCommand } from './memory-command.js';
export { newCommand } from './new-command.js';
export { recoverCommand } from './recover-command.js';
export { agentsCommand } from './agents-command.js';

export { discoverCommands, registerDiscoveredCommands } from './discovery.js';

/**
 * Register all commands (builtin + discovered)
 * 注册所有命令（内置 + 发现的）
 *
 * @param registry - CommandRegistry instance
 * @param projectRoot - Project root directory (optional, defaults to cwd)
 */
export function registerAllCommands(registry: CommandRegistry, projectRoot?: string): void {
  // 1. Register builtin commands first
  registerBuiltinCommands(registry);

  // 2. Discover and register user/project commands
  // Priority: project > ~/.kodax > ~/.agents
  try {
    const home = os.homedir();
    const root = projectRoot ?? process.cwd();

    // Highest priority first: project-level, then the redirectable KodaX
    // agent home (~/.kodax/, FEATURE_145), then the cross-vendor
    // ~/.agents/commands standard. Order owned by commandDiscoveryDirs.
    const discovered = discoverCommands([...commandDiscoveryDirs(root)]);
    registerDiscoveredCommands(discovered, registry);
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'repl:commands',
      level: 'error',
      message: 'Failed to discover commands.',
      detail: error,
    });
  }
}

/**
 * FEATURE_298 T37 — the single source of truth for prompt-command discovery
 * order (project > ~/.kodax > ~/.agents). The Host's prepareCommand consumes
 * this so its trusted discovery can never drift from the REPL registry.
 */
export function commandDiscoveryDirs(
  projectRoot: string,
): readonly { path: string; location: 'user' | 'project' }[] {
  const home = os.homedir();
  return [
    { path: path.join(projectRoot, '.kodax', 'commands'), location: 'project' },
    { path: getAgentConfigPath('commands'), location: 'user' },
    { path: path.join(home, '.agents', 'commands'), location: 'user' },
  ];
}

export function listRegisteredCommands(projectRoot?: string): CommandInfo[] {
  const registry = new ReplCommandRegistry();
  registerAllCommands(registry, projectRoot);
  return registry.getAll();
}
