import { getAgentConfigPath, isAutoManagedMemoryFile } from '@kodax-ai/agent';
import { isGovernedMemoryMutationTarget } from '../permissions/agent-home-policy.js';

const MEMORY_TOOL_HINT = 'use the memory tool you were given (memory, or memory_intent in the legacy memory), which checks the user\'s authorization and secrets.';
export const MEMORY_FILE_DENIAL = `[Tool Error] Memory files cannot be changed with file tools; ${MEMORY_TOOL_HINT}`;
export const MEMORY_SHELL_DENIAL = `[Tool Error] Shell mutation of memory files is denied; ${MEMORY_TOOL_HINT}`;

export function memoryMutationDenial(filePath: string): string | undefined {
  return isAutoManagedMemoryFile(filePath) || isGovernedMemoryMutationTarget(filePath)
    ? MEMORY_FILE_DENIAL
    : undefined;
}

export function shellMemoryMutationDenial(command: string): string | undefined {
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  const scopedRoot = getAgentConfigPath('memory-scopes').replaceAll('\\', '/').toLowerCase();
  const projectsRoot = getAgentConfigPath('projects').replaceAll('\\', '/').toLowerCase();
  const targetsScoped = normalized.includes(scopedRoot)
    || /(?:^|[\s/'"])(?:\.kodax\/)?memory-scopes(?:\/|[\s'"]|$)/.test(normalized);
  const targetsLegacy = (normalized.includes(projectsRoot)
      || /(?:\.kodax|kodax_config_home|userprofile|\$home|~).*\/projects(?:\/|\b)/.test(normalized))
    && /(?:^|[\s/'"])(?:memory|notes)(?:\/|[\s'"]|$)/.test(normalized);
  const userNotesRoot = getAgentConfigPath('notes').replaceAll('\\', '/').toLowerCase();
  const targetsUserNotes = normalized.includes(`${userNotesRoot}/`) || normalized.endsWith(userNotesRoot);
  if (!targetsScoped && !targetsLegacy && !targetsUserNotes) return undefined;
  if (isReadOnlyInspection(command)) return undefined;
  return MEMORY_SHELL_DENIAL;
}

function isReadOnlyInspection(command: string): boolean {
  if (/[;&|><\r\n`]|\$\(/.test(command)) return false;
  return /^\s*(?:get-content|cat|type|rg|grep|select-string|get-childitem|get-child-item|ls|dir|stat|test-path)\b/i
    .test(command);
}
