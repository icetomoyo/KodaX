/**
 * Admission and rendering for `context.prompt`, the application prompt
 * customization of a managed Run. Rules and references render as Managed Run
 * Context sections, one per entry, so retention can diff them by key.
 */
import type { KodaXPromptContextEntry, KodaXPromptSpec } from '../execution-profile-contract.js';
import { staticText } from './static-text.js';

/** Total entry text a spec may carry; the Managed Run Context itself is capped at 32,000. */
export const PROMPT_SPEC_TEXT_LIMIT = 8_000;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Envelope trust is positional, but a forged marker inside an entry would still read as a boundary.
// Spacing and '=' count vary because models read near-miss markers as the real one.
const ENVELOPE_MARKER = /=+\s*(End\s+)?Managed\s+Run\s+Context\s*=+/i;
const SPEC_FIELDS = new Set(['kodaxGuidance', 'context']);
const ENTRY_FIELDS = new Set(['key', 'kind', 'text']);
const SECTION_PREFIX = { rule: 'app-rule:', reference: 'app-reference:' } as const;

function invalid(message: string): Error {
  return Object.assign(new Error(`Invalid context.prompt: ${message}`), { code: 'invalid_params' as const });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKnownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown !== undefined) throw invalid(`unknown field ${where}${unknown}`);
}

function assertEntry(value: unknown, index: number, keys: Set<string>): KodaXPromptContextEntry {
  const where = `context[${index}]`;
  if (!isRecord(value)) throw invalid(`${where} must be an object`);
  assertKnownFields(value, ENTRY_FIELDS, `${where}.`);
  const { key, kind, text } = value;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw invalid(`${where}.key must match ${KEY_PATTERN.source}`);
  if (keys.has(key)) throw invalid(`duplicate key ${key}`);
  keys.add(key);
  if (kind !== 'rule' && kind !== 'reference') throw invalid(`${where}.kind must be rule or reference`);
  if (typeof text !== 'string' || text.trim().length === 0) throw invalid(`${where}.text must be a nonempty string`);
  if (ENVELOPE_MARKER.test(text)) throw invalid(`${where}.text contains a Managed Run Context marker`);
  return { key, kind, text };
}

/** Reject malformed specs at admission, so errors surface as request errors rather than at prompt build. */
export function assertKodaXPromptSpec(value: unknown): asserts value is KodaXPromptSpec {
  if (!isRecord(value)) throw invalid('must be an object');
  assertKnownFields(value, SPEC_FIELDS, '');
  const { kodaxGuidance, context } = value;
  if (kodaxGuidance !== undefined && kodaxGuidance !== 'keep' && kodaxGuidance !== 'omit') {
    throw invalid('kodaxGuidance must be keep or omit');
  }
  if (context === undefined) return;
  if (!Array.isArray(context)) throw invalid('context must be an array');
  const keys = new Set<string>();
  const total = context.reduce<number>((sum, entry, index) => sum + assertEntry(entry, index, keys).text.length, 0);
  if (total > PROMPT_SPEC_TEXT_LIMIT) throw invalid(`entry text totals ${total} characters; the limit is ${PROMPT_SPEC_TEXT_LIMIT}`);
}

/** The leaf executor has no Managed Run Context or tagged Worker sections to apply a spec to. */
export function assertPromptSpecOnManagedRun(spec: KodaXPromptSpec | undefined): void {
  if (spec === undefined) return;
  throw Object.assign(new Error(
    'context.prompt applies to root Runs only (runKodaX, runManagedTask or runs.start), not to a leaf Agent.',
  ), { code: 'prompt_spec_requires_managed_run' as const });
}

export function omitsKodaXGuidance(spec: KodaXPromptSpec | undefined): boolean {
  return spec?.kodaxGuidance === 'omit';
}

/** One rendered entry, keyed for retention. */
export interface ApplicationContextSection {
  readonly id: string;
  readonly kind: KodaXPromptContextEntry['kind'];
  readonly content: string;
}

function renderEntry({ key, kind, text }: KodaXPromptContextEntry): string {
  return kind === 'rule'
    ? `## Application rule: ${key}\n${staticText('application-context.rule')}\n${text.trim()}`
    : `## Application reference: ${key}\n${staticText('application-context.reference')}\n${text.trim()}`;
}

export function renderApplicationContextSections(spec: KodaXPromptSpec | undefined): readonly ApplicationContextSection[] {
  return (spec?.context ?? []).map(entry => ({
    id: `${SECTION_PREFIX[entry.kind]}${entry.key}`,
    kind: entry.kind,
    content: renderEntry(entry),
  }));
}

/** Rule entries for a write child's system prompt; references stay with the root. */
export function renderApplicationRules(spec: KodaXPromptSpec | undefined): string | undefined {
  const rules = renderApplicationContextSections(spec).filter(section => section.kind === 'rule');
  return rules.length > 0 ? rules.map(section => section.content).join('\n\n') : undefined;
}

/** Retirement label for a retained application section id; undefined for other ids. */
export function applicationContextLabel(id: string): string | undefined {
  if (id.startsWith(SECTION_PREFIX.rule)) return `application rule ${id.slice(SECTION_PREFIX.rule.length)}`;
  if (id.startsWith(SECTION_PREFIX.reference)) return `application reference ${id.slice(SECTION_PREFIX.reference.length)}`;
  return undefined;
}
