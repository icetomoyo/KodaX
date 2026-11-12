/**
 * FEATURE_124 (v0.7.43) — Memory frontmatter parser.
 *
 * Minimal YAML frontmatter subset for memory files:
 *
 *   ---
 *   name: User role
 *   description: Senior backend engineer, Go/PostgreSQL focus
 *   type: user
 *   ---
 *
 *   <body markdown>
 *
 * Why a hand-rolled parser instead of `yaml` dep:
 *   - `@kodax-ai/agent` is the substrate package; adding a runtime YAML
 *     dependency would propagate to every consumer (kodax CLI, downstream
 *     `@kodax-ai/data-analysis-agent`, etc.). Frontmatter has only 3
 *     scalar string fields — a 40-line regex parser is the appropriate
 *     scope.
 *   - Degraded-tolerant: corrupt YAML / unknown type / missing
 *     frontmatter MUST NOT throw — the file remains readable as
 *     `{ raw: <full content>, type: undefined }`. Memory directories
 *     accumulate files over months; one bad file cannot break session
 *     startup.
 *
 * Contract guarantees (verified by frontmatter.test.ts):
 *   - Parser NEVER throws.
 *   - Unknown / mistyped `type:` → `type: undefined` (still readable).
 *   - Missing frontmatter → `{ name: undefined, description: undefined,
 *     type: undefined, body: <full content> }`.
 *   - Body extraction strips the frontmatter block + leading newlines.
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryFrontmatter {
  /** Human-readable short title. May be undefined when frontmatter is malformed or missing. */
  readonly name: string | undefined;
  /** One-line search hint. May be undefined when frontmatter is malformed or missing. */
  readonly description: string | undefined;
  /** 4-type taxonomy; undefined for unknown / missing types (degraded tolerant). */
  readonly type: MemoryType | undefined;
}

export interface ParsedMemoryFile {
  readonly frontmatter: MemoryFrontmatter;
  /** Body content WITHOUT the frontmatter block. May be empty. */
  readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Coerce a raw frontmatter value to the closed 4-type taxonomy.
 * Returns `undefined` for unknown types — degraded tolerance lets the
 * file remain in the directory without breaking the index or session
 * startup.
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (raw === 'user' || raw === 'feedback' || raw === 'project' || raw === 'reference') {
    return raw;
  }
  return undefined;
}

/**
 * Split a file into its raw scalar frontmatter fields and body. NEVER throws.
 * No frontmatter block → no fields, body = full input. Used by readers that
 * need fields beyond the 4-type `parseMemoryFile` shape (e.g. `memory-store`).
 */
export function parseFrontmatterFields(raw: string): {
  readonly fields: Record<string, string>;
  readonly body: string;
} {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { fields: {}, body: raw };
  return {
    fields: parseScalarFields(match[1]),
    body: raw.slice(match[0].length).replace(/^\r?\n+/, ''),
  };
}

/**
 * Parse a memory file's raw text into frontmatter + body. NEVER throws.
 *
 * Behavior:
 *   - No frontmatter block → all fields undefined, body = full input.
 *   - Frontmatter present + parseable → fields populated where possible,
 *     unknown / mistyped fields → undefined. Body = content after the
 *     closing `---` line.
 *   - Frontmatter block syntactically present but no parseable
 *     `key: value` lines → all fields undefined, body = content after
 *     closing `---`. (Garbage frontmatter is not an error.)
 */
export function parseMemoryFile(raw: string): ParsedMemoryFile {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return {
      frontmatter: { name: undefined, description: undefined, type: undefined },
      body: raw,
    };
  }

  const yamlBlock = match[1];
  const body = raw.slice(match[0].length).replace(/^\r?\n+/, '');
  const fields = parseScalarFields(yamlBlock);

  return {
    frontmatter: {
      name: typeof fields.name === 'string' ? fields.name : undefined,
      description: typeof fields.description === 'string' ? fields.description : undefined,
      type: parseMemoryType(fields.type),
    },
    body,
  };
}

/**
 * Parse `key: value` scalar lines from a YAML block. Supports:
 *   - bare strings: `name: Hello world`
 *   - single-quoted strings: `name: 'Hello: world'`
 *   - double-quoted strings: `name: "Hello: world"`
 *
 * Does NOT support: nested objects, sequences (lists), multiline scalars,
 * YAML anchors / aliases / tags. Lines that don't match the simple
 * scalar shape are silently skipped (degraded tolerance).
 *
 * Visibility: exported only for testing; consumers use `parseMemoryFile`.
 */
export function parseScalarFields(yamlBlock: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = yamlBlock.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    const rawValue = line.slice(colonIdx + 1).trim();
    const value = unquote(rawValue);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Strip matching surrounding single or double quotes from a YAML scalar.
 * Returns the raw string if not quoted. Returns `undefined` for empty /
 * whitespace-only inputs (treated as "no value provided").
 */
function unquote(raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    const last = raw.charAt(raw.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}
