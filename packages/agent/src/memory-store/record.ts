/**
 * FEATURE_308 — one memory = one markdown file with self-contained frontmatter
 * (no sidecar). A hand-edited file with only a `description:` is a valid active
 * note; an unrecognised `status:` never activates a note.
 */
import { parseFrontmatterFields } from '../memory/frontmatter.js';

export type NoteType = 'user' | 'feedback' | 'project' | 'reference' | 'procedure';
export type NoteScope = 'user' | 'project';
export type NoteStatus = 'candidate' | 'active' | 'disputed' | 'archived';
/** Who established the note: the user (quoted) or a model inference. Absent (hand-written, converted) counts as the user. */
export type NoteSource = 'user' | 'inferred';

export interface MemoryNote {
  /** File name without `.md`. */
  readonly id: string;
  readonly type: NoteType;
  readonly scope: NoteScope;
  /** One line, shown in the index. */
  readonly description: string;
  /** Evidence and how it is known. */
  readonly why?: string;
  /** For mutable facts: how to verify instead of trusting the value. */
  readonly check?: string;
  readonly status: NoteStatus;
  readonly source?: NoteSource;
  /** Session that wrote the note; an inferred note needs a different session to corroborate it. */
  readonly session?: string;
  readonly used: number;
  readonly lastUsedAt?: string;
  readonly body: string;
}

export const NOTE_TYPES: readonly NoteType[] = ['user', 'feedback', 'project', 'reference', 'procedure'];
export const NOTE_SCOPES: readonly NoteScope[] = ['project', 'user'];
const STATUSES: readonly NoteStatus[] = ['candidate', 'active', 'disputed', 'archived'];
const SOURCES: readonly NoteSource[] = ['user', 'inferred'];

/** The value when it is one of `allowed`, else undefined; for parsing untyped input. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

function firstLine(body: string): string | undefined {
  const line = body.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0);
  return line?.slice(0, 160);
}

/** Never throws; any file parses to some note. */
export function parseNote(id: string, raw: string, defaultScope: NoteScope): MemoryNote {
  const { fields, body } = parseFrontmatterFields(raw);
  const used = Number.parseInt(fields.used ?? '', 10);
  const source = oneOf(fields.source, SOURCES);
  const lastUsedAt = fields.lastUsedAt !== undefined && !Number.isNaN(Date.parse(fields.lastUsedAt))
    ? fields.lastUsedAt
    : undefined;
  return {
    id,
    type: oneOf(fields.type, NOTE_TYPES) ?? 'project',
    scope: oneOf(fields.scope, NOTE_SCOPES) ?? defaultScope,
    description: fields.description ?? fields.name ?? firstLine(body) ?? id,
    ...(fields.why === undefined ? {} : { why: fields.why }),
    ...(fields.check === undefined ? {} : { check: fields.check }),
    // Absent status = hand-written = active. Present but unknown = not trusted.
    status: fields.status === undefined ? 'active' : oneOf(fields.status, STATUSES) ?? 'candidate',
    ...(source === undefined ? {} : { source }),
    ...(fields.session === undefined ? {} : { session: fields.session }),
    used: Number.isInteger(used) && used > 0 ? used : 0,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    body,
  };
}

/**
 * Values are always double-quoted on one line. The shared parser strips only the
 * outer pair and does not unescape, so inner quotes and colons round-trip as-is.
 */
function field(key: string, value: string | undefined): string[] {
  if (value === undefined) return [];
  const line = value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return line.length === 0 ? [] : [`${key}: "${line}"`];
}

export function serializeNote(note: MemoryNote): string {
  const lines = [
    ...field('type', note.type),
    ...field('scope', note.scope),
    ...field('description', note.description),
    ...field('why', note.why),
    ...field('check', note.check),
    ...field('status', note.status),
    ...field('source', note.source),
    ...field('session', note.session),
    `used: ${note.used}`,
    ...field('lastUsedAt', note.lastUsedAt),
  ];
  return `---\n${lines.join('\n')}\n---\n\n${note.body}`;
}
