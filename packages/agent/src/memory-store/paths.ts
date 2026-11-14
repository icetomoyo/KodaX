/**
 * FEATURE_308 — where the new note stores live. Deliberately NOT the legacy
 * `memory/` directory, so both systems can coexist until the old one is removed.
 *
 *   project scope: <agentConfigHome>/projects/<project-key>/notes/
 *   user scope:    <agentConfigHome>/notes/
 */
import * as path from 'node:path';

import { getAgentConfigHome } from '../runtime/agent-home.js';
import { resolveProjectKey } from '../memory/paths.js';
import type { NoteScope } from './record.js';

/** `home` is the config home of the runtime that owns the run; it defaults to the process's agent home. */
export function resolveNoteRoot(cwd: string, scope: NoteScope, home: string = getAgentConfigHome()): string {
  return scope === 'user'
    ? path.join(home, 'notes')
    : path.join(home, 'projects', resolveProjectKey(cwd), 'notes');
}
