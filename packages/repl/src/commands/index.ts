/**
 * Public command-system exports.
 */

import * as path from 'path';
import * as os from 'os';
import type { CommandRegistry } from './registry.js';
import { registerBuiltinCommands } from './builtin.js';
import { discoverCommands, registerDiscoveredCommands } from './discovery.js';

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
export { newCommand } from './new-command.js';

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

    const discovered = discoverCommands([
      // Highest priority: project-level commands
      { path: path.join(root, '.kodax', 'commands'), location: 'project' },
      // User-level: ~/.kodax/commands/
      { path: path.join(home, '.kodax', 'commands'), location: 'user' },
      // User-level: ~/.agents/commands/ (AgentSkills standard)
      { path: path.join(home, '.agents', 'commands'), location: 'user' },
    ]);
    registerDiscoveredCommands(discovered, registry);
  } catch (error) {
    console.error('Failed to discover commands:', error);
  }
}
