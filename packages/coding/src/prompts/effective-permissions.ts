import type { KodaXContextOptions, KodaXShellPermissionMode } from '../types.js';

const MODE_GUIDANCE: Record<KodaXShellPermissionMode, string> = {
  plan: 'Read-only planning. Do not perform ordinary file mutations.',
  'accept-edits': 'Text edits use host write roots. External operations require explicit host authorization.',
  auto: 'Auto[LLM] reviews operations requiring host authorization. An allow applies only to that exact operation and target; it is not a directory-wide grant.',
  'full-access': 'Ordinary local text targets may be outside the workspace. Shell runs on the host without sandbox or approval prompts.',
};

/** Request-only live authority: never persist a stale mode into conversation history. */
export function withEffectivePermissionContext(system: string, context: KodaXContextOptions | undefined): string {
  const mode = context?.resolveShellPermissionMode?.();
  if (mode === undefined) return system;
  return `${system}\n\n## Effective permissions (host authority)\nCurrent permission mode: ${mode}\n${MODE_GUIDANCE[mode]}\n`
    + 'This live host context is authoritative for this request. config.json contains defaults, not the current Session mode. '
    + 'The host may change the mode during a Run; use the fresh context on each request. '
    + 'Explicit forbids, protected Runtime/control files, and native file transaction integrity checks still apply. '
    + 'This description does not itself authorize an operation; respect tool refusals.';
}
