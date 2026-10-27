/** Offline only. Recount explicitly selected saved inputs; no model, network or capture calls. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { countTokens } from '../packages/agent/src/tokenizer.js';

const MODEL_FIELDS = ['system', 'instructions', 'messages', 'input', 'tools'] as const;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function measure(text: string) {
  return { utf16Chars: text.length, utf8Bytes: Buffer.byteLength(text, 'utf8'),
    estimatedTokens: countTokens(text), sha256: sha256(text) };
}

export function measureTemplate(text: string) {
  return { representation: 'raw-template-text' as const, ...measure(text) };
}

export function measureModelFields(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a request object');
  const body = value as Record<string, unknown>;
  const includedFields = MODEL_FIELDS.filter(key => body[key] != null);
  if (includedFields.length === 0) throw new Error('No model-visible fields');
  const fields = Object.fromEntries(includedFields.map(key => [key, body[key]]));
  // Never inspect/filter nested input: Codex AdditionalTools and inline SDKs are model input too.
  return { representation: 'compact-model-fields-json' as const, ...measure(JSON.stringify(fields)),
    includedFields, excludedFields: Object.keys(body).filter(key => !includedFields.includes(key as typeof MODEL_FIELDS[number])) };
}

interface Entry {
  id: string;
  input: string;
  scope: 'complete-model-fields' | 'base-template';
  sourceRevision: string;
  origin: 'captured-request' | 'source-projection' | 'catalog-template';
  platform: string;
  notes: string;
  modelSlug?: string;
}

/** The manifest is explicit to avoid scanning unrelated sessions/configuration or exposing credentials. */
export async function recount(manifestFile: string) {
  const entries = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as Entry[];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Expected a nonempty manifest array');
  const rows = [];
  for (const entry of entries) {
    if (!entry.id || !entry.input || !entry.sourceRevision || !entry.origin || !entry.platform || !entry.notes) {
      throw new Error('Each entry requires id, input, sourceRevision, origin, platform and notes');
    }
    const file = path.resolve(path.dirname(manifestFile), entry.input);
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (entry.scope === 'complete-model-fields') {
      rows.push({ ...entry, input: file, fileSha256: sha256(raw), ...measureModelFields(parsed) });
    } else if (entry.scope === 'base-template') {
      const catalog = parsed as { models?: { slug?: string; model_messages?: { instructions_template?: string } }[] };
      const template = catalog.models?.find(model => model.slug === entry.modelSlug)?.model_messages?.instructions_template;
      if (typeof template !== 'string') throw new Error(`Missing catalog template for ${entry.modelSlug ?? '(unspecified)'}`);
      rows.push({ ...entry, input: file, fileSha256: sha256(raw), ...measureTemplate(template) });
    } else throw new Error(`Unsupported scope for ${entry.id}`);
  }
  return { method: 'All complete rows: compact JSON of system/instructions/messages/input/tools, retaining nested AdditionalTools and inline SDKs. Base templates: raw text, separate scope. UTF-16 code units, UTF-8 bytes, one KodaX heuristic; not BPE/API usage or equivalent-capability ranking.',
    externalCalls: 0, tokenizerSha256: sha256(await fs.readFile(new URL('../packages/agent/src/tokenizer.ts', import.meta.url), 'utf8')), rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , manifest, output] = process.argv;
  if (!manifest || !output) throw new Error('Usage: npx tsx tests/first-turn-uniform-costs.ts <manifest.json> <report.json>');
  const report = await recount(path.resolve(manifest));
  await fs.writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  process.stdout.write(`${report.rows.length} inputs recounted; report: ${path.resolve(output)}\n`);
}
