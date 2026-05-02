/**
 * Classifier Projection Helpers — FEATURE_092 (v0.7.33)
 *
 * Tools must implement `toClassifierInput(input): string` to project their
 * input into a one-line string the auto-mode classifier evaluates as the
 * `<action>` to allow / block. See `LocalToolDefinition.toClassifierInput`
 * JSDoc in `tools/types.ts` for the three-tier strategy.
 *
 * ============== EXAMPLES BY CATEGORY ==============
 *
 *   --- FILE OPERATIONS (path + size, never raw contents) ---
 *     write.ts:        (i) => `Write ${i.path} (${i.content.length} bytes)`
 *     edit.ts:         (i) => `Edit ${i.path} [${describeEdit(i)}]`
 *     multi-edit:      (i) => `MultiEdit ${i.path}: ${i.edits.length} edits`
 *
 *   --- SHELL / EXEC (command verbatim, ignore noise fields) ---
 *     bash.ts:         (i) => `Bash: ${i.command}`
 *
 *   --- NETWORK (URL is THE risk surface) ---
 *     web_fetch:       (i) => `WebFetch ${i.url}`
 *
 *   --- SUBAGENT SPAWN (prompt is the inheritance vector) ---
 *     dispatch_child:  (i) => `Dispatch(${i.subagent_type}): ${truncate(i.prompt, 200)}`
 *
 *   --- MCP CALLS (hybrid: action field + structure backup) ---
 *     mcp_call:        (i) => mcpToClassifierInput(i.server, i.tool, i.input)
 *
 *   --- READ-ONLY (Tier 1 — fully skipped) ---
 *     read.ts:         () => ''
 *     grep.ts:         () => ''
 *     glob.ts:         () => ''
 *
 *   --- LOW-RISK STRUCTURED (one-line helper) ---
 *     semantic_lookup: (i) => defaultToClassifierInput('semantic_lookup', i)
 *
 * ============== ANTI-PATTERNS ==============
 *
 *   ❌ JSON.stringify(input) as default
 *      → leaks raw content; hard for LLM to scan
 *
 *   ❌ Returning input.description / input.rationale verbatim
 *      → these are LLM-emitted, manipulable; classifier should see facts
 *
 *   ❌ Including raw file contents in Write/Edit projections
 *      → privacy + token cost; use bytes/line count as proxy
 *
 *   ❌ Returning '' for a high-risk tool to "skip the classifier"
 *      → defeats Tier 1's "safe-only" semantics
 *
 *   ❌ Truncating without indicating it ('foo' instead of 'foo…')
 *      → classifier may make decisions on false-complete information
 */

const MAX_PROJECTION_LENGTH = 200;
const MAX_ACTION_VALUE_LENGTH = 200;

/**
 * Conservative default projection: tool name + truncated JSON of input.
 *
 * Use ONLY when the tool's input is non-sensitive (no raw file contents,
 * no secrets, no LLM-emitted free-form text). For high-risk tools write
 * a custom projection that surfaces the risk-bearing field directly.
 */
export function defaultToClassifierInput(toolName: string, input: unknown): string {
  let json: string;
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) {
      return `${toolName}: [unserializable input]`;
    }
    json = serialized;
  } catch {
    return `${toolName}: [unserializable input]`;
  }
  if (json.length > MAX_PROJECTION_LENGTH) {
    json = json.slice(0, MAX_PROJECTION_LENGTH) + '…';
  }
  return `${toolName}: ${json}`;
}

/**
 * Hybrid projection for MCP calls: extract the most likely "action" field
 * (method / command / url / query / action — in priority order) as the
 * primary signal, then append a structure summary of the remaining keys
 * so the classifier has both intent and context.
 *
 * Output shape examples:
 *   `MCP[filesystem.read]: fs.readFile | path=/etc/passwd, +1 key`
 *   `MCP[fetcher.get]: https://evil.com/x | +1 key`
 *   `MCP[xxx.yyy]: name=foo, tags=[a,b]`     (no action field found)
 *
 * Action value is truncated to 200 chars to keep token cost bounded
 * even if the model passes a multi-KB URL or query.
 */
export function mcpToClassifierInput(
  server: string,
  tool: string,
  input: unknown,
): string {
  const prefix = `MCP[${server}.${tool}]`;

  if (input === null || input === undefined || typeof input !== 'object') {
    const value = formatValue(input, MAX_ACTION_VALUE_LENGTH);
    return `${prefix}: ${value}`;
  }

  const obj = input as Record<string, unknown>;
  const action = pickActionField(obj);

  if (action) {
    const trimmedValue = truncate(String(action.value), MAX_ACTION_VALUE_LENGTH);
    const structural = describeStructure(obj, action.field);
    return structural
      ? `${prefix}: ${trimmedValue} | ${structural}`
      : `${prefix}: ${trimmedValue}`;
  }

  const structural = describeStructure(obj, null);
  return `${prefix}: ${structural || '{}'}`;
}

const ACTION_FIELD_PRIORITY = ['method', 'command', 'url', 'query', 'action'] as const;

function pickActionField(
  obj: Record<string, unknown>,
): { field: string; value: unknown } | undefined {
  for (const field of ACTION_FIELD_PRIORITY) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      const value = obj[field];
      if (value !== undefined && value !== null && value !== '') {
        return { field, value };
      }
    }
  }
  return undefined;
}

/**
 * Describe the remaining structure of an object input. When `excludeField`
 * is provided, that key is omitted from the description (the action field
 * is already shown separately). Output is bounded by including:
 *   - up to 3 key=value pairs of short scalar values
 *   - a "+N keys" summary for the remainder
 */
function describeStructure(
  obj: Record<string, unknown>,
  excludeField: string | null,
): string {
  const entries = Object.entries(obj).filter(([key]) => key !== excludeField);
  if (entries.length === 0) return '';

  const SHORT_SCALAR_LIMIT = 32;
  const previewParts: string[] = [];
  let extraCount = 0;

  for (const [key, value] of entries) {
    if (previewParts.length >= 3) {
      extraCount += 1;
      continue;
    }
    const formatted = formatScalarOrShortStructure(value, SHORT_SCALAR_LIMIT);
    if (formatted) {
      previewParts.push(`${key}=${formatted}`);
    } else {
      extraCount += 1;
    }
  }

  const parts: string[] = [];
  if (previewParts.length > 0) parts.push(previewParts.join(', '));
  if (extraCount > 0) {
    const extraKeys = entries
      .filter(([k]) => !previewParts.some((p) => p.startsWith(`${k}=`)))
      .map(([k]) => k);
    parts.push(`+${extraCount} key${extraCount > 1 ? 's' : ''}: ${extraKeys.join(', ')}`);
  }
  return parts.join(', ');
}

function formatScalarOrShortStructure(value: unknown, limit: number): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length <= limit ? value : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value) && value.length <= 3) {
    const inner = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(',');
    if (inner.length <= limit) return `[${inner}]`;
  }
  return undefined;
}

function formatValue(value: unknown, limit: number): string {
  if (value === undefined) return '[undefined]';
  if (value === null) return 'null';
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return truncate(s, limit);
}

function truncate(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}
