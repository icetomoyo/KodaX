/**
 * FEATURE_306 — one memory = one markdown file with self-contained frontmatter
 * (no sidecar). A hand-edited file with only a `description:` is a valid active
 * note; an unrecognised `status:` never activates a note.
 */
import { parseFrontmatterFields } from '../memory/frontmatter.js';

export type NoteType = 'user' | 'feedback' | 'project' | 'reference' | 'procedure';
export type NoteScope = 'user' | 'project';
export type NoteStatus = 'candidate' | 'active' | 'disputed' | 'archived';

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
  readonly used: number;
  readonly lastUsedAt?: string;
  readonly body: string;
}

const TYPES: readonly NoteType[] = ['user', 'feedback', 'project', 'reference', 'procedure'];
const SCOPES: readonly NoteScope[] = ['user', 'project'];
const STATUSES: readonly NoteStatus[] = ['candidate', 'active', 'disputed', 'archived'];

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined): T | undefined {
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
  const lastUsedAt = fields.lastUsedAt !== undefined && !Number.isNaN(Date.parse(fields.lastUsedAt))
    ? fields.lastUsedAt
    : undefined;
  return {
    id,
    type: oneOf(TYPES, fields.type) ?? 'project',
    scope: oneOf(SCOPES, fields.scope) ?? defaultScope,
    description: fields.description ?? fields.name ?? firstLine(body) ?? id,
    ...(fields.why === undefined ? {} : { why: fields.why }),
    ...(fields.check === undefined ? {} : { check: fields.check }),
    // Absent status = hand-written = active. Present but unknown = not trusted.
    status: fields.status === undefined ? 'active' : oneOf(STATUSES, fields.status) ?? 'candidate',
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
    `used: ${note.used}`,
    ...field('lastUsedAt', note.lastUsedAt),
  ];
  return `---\n${lines.join('\n')}\n---\n\n${note.body}`;
}
