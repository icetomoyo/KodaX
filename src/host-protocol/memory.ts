/**
 * Memory: the notes the agent keeps about a person and a project, and reads
 * at the start of each Run. A `user` note follows the person into every
 * project; a `project` note stays with the project named by `project` or
 * `projectRoot`, as the catalogs name it.
 *
 * The agent writes a note it inferred as a `candidate`; it is not read into a
 * Run until the person approves it. Forgetting a candidate rejects it. A note
 * the person writes or edits counts as theirs.
 *
 * A note's `revision` changes with what it says. `ifRevision` makes a change
 * apply only to the note the client read; one that changed meanwhile fails
 * with `conflict` (`revision_mismatch`): read it again. A note holds no
 * secrets: one that looks like a key or token fails with `invalid_params`
 * (`secret_in_note`).
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { PROJECT_CHOICE_RESTRICTED, ProjectChoice } from './session.js';

const Scope = z.enum(['user', 'project']);
/** Letters, digits, `-` and `_`, starting with a letter or digit. */
const NoteId = z.string().min(1).max(64);
/** `user`, `feedback`, `project`, `reference` or `procedure`. */
const NoteType = z.enum(['user', 'feedback', 'project', 'reference', 'procedure']);
const Revision = z.string().min(1).max(64);

const Note = z.object({
  id: NoteId,
  scope: Scope,
  type: NoteType,
  /** `candidate`, `active`, `disputed` or `archived`. Only `active` notes are read into a Run. */
  status: z.string(),
  /** `user` when the person wrote or approved it, `inferred` when the agent did. */
  source: z.string().optional(),
  /** One line: what the note is about. Runs see it in the index. */
  description: z.string(),
  why: z.string().optional(),
  /** How to tell the note still holds. */
  check: z.string().optional(),
  /** How many times a Run read it. */
  used: z.int(),
  lastUsedAt: z.int().optional(),
  revision: Revision,
});

const NoteWithBody = Note.extend({ body: z.string() });
const NoteResult = hostResult({ note: NoteWithBody });
const LocalNoteResult = hostResult({ note: NoteWithBody.extend({ path: z.string() }) });

const Text = z.string().max(64 * 1024);
const Description = z.string().min(1).max(1024);
const NoteRef = { ...ProjectChoice, scope: Scope, id: NoteId };

export const MEMORY_METHODS = {
  /** Every note of both scopes, of every status, without their bodies. */
  'memory.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams(ProjectChoice),
    restricted: PROJECT_CHOICE_RESTRICTED,
    result: hostList(Note),
  },
  /** Fails with `not_found` (`note_not_found`). */
  'memory.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams(NoteRef),
    restricted: PROJECT_CHOICE_RESTRICTED,
    result: NoteResult,
    localResult: LocalNoteResult,
  },
  /**
   * Writes a new active note. An `id` taken by another note fails with
   * `conflict` (`note_exists`); one that is not a valid id fails with
   * `invalid_params` (`invalid_note_id`).
   */
  'memory.create': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      ...NoteRef, type: NoteType, description: Description, body: Text.optional(), why: Text.optional(), check: Text.optional(),
    }),
    restricted: PROJECT_CHOICE_RESTRICTED,
    result: NoteResult,
    localResult: LocalNoteResult,
  },
  /** Changes the fields given and keeps the rest. */
  'memory.update': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({
      ...NoteRef,
      ifRevision: Revision.optional(),
      type: NoteType.optional(),
      description: Description.optional(),
      body: Text.optional(),
      why: Text.optional(),
      check: Text.optional(),
    }),
    restricted: PROJECT_CHOICE_RESTRICTED,
    result: NoteResult,
    localResult: LocalNoteResult,
  },
  /** Makes a note active and the person's own, so Runs read it. */
  'memory.approve': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ ...NoteRef, ifRevision: Revision.optional() }),
    restricted: PROJECT_CHOICE_RESTRICTED,
    result: NoteResult,
    localResult: LocalNoteResult,
  },
  /** Removes a note. A note that is not there is forgotten already, so this succeeds. */
  'memory.forget': {
    primitive: 'command',
    resend: 'auto',
    plane: 'data',
    params: hostCommandParams({ ...NoteRef, ifRevision: Revision.optional() }),
    restricted: PROJECT_CHOICE_RESTRICTED,
    result: hostResult({}),
  },
} as const satisfies HostMethodRegistry;
