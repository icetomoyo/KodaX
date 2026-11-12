import { getAgentConfigPath, isAutoManagedMemoryFile } from '@kodax-ai/agent';
import { isGovernedMemoryMutationTarget } from '../permissions/agent-home-policy.js';

export function memoryMutationDenial(filePath: string): string | undefined {
  return isAutoManagedMemoryFile(filePath) || isGovernedMemoryMutationTarget(filePath)
    ? '[Tool Error] Memory files are governed by the Memory Control Plane; use an explicit memory command or proposal instead.'
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
  return '[Tool Error] Shell mutation of governed memory is denied; use the Memory Control Plane.';
}

function isReadOnlyInspection(command: string): boolean {
  if (/[;&|><\r\n`]|\$\(/.test(command)) return false;
  return /^\s*(?:get-content|cat|type|rg|grep|select-string|get-childitem|get-child-item|ls|dir|stat|test-path)\b/i
    .test(command);
}
