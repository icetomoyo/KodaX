/**
 * FEATURE_306 — where the new note stores live. Deliberately NOT the legacy
 * `memory/` directory, so both systems can coexist until the old one is removed.
 *
 *   project scope: <agentConfigHome>/projects/<project-key>/notes/
 *   user scope:    <agentConfigHome>/notes/
 */
import * as path from 'node:path';

import { getAgentConfigPath } from '../runtime/agent-home.js';
import { resolveMemoryRoot } from '../memory/paths.js';
import type { NoteScope } from './record.js';

export function resolveNoteRoot(cwd: string, scope: NoteScope): string {
  return scope === 'user'
    ? getAgentConfigPath('notes')
    : path.join(path.dirname(resolveMemoryRoot(cwd)), 'notes');
}
