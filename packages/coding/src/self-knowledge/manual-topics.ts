import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type manualData from './manual-topics.json';
import type { KodaXManualTopic } from './types.js';

/** Versioned, package-owned data; never resolved from the workspace or user config. */
export function loadManualTopics(): readonly (Omit<KodaXManualTopic, 'body'> & { body: readonly string[] })[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = process.env.KODAX_BUNDLED === 'true'
    ? [path.join(path.dirname(process.execPath), 'manual-topics.json')]
    : [path.join(here, 'manual-topics.json'), path.join(here, '..', 'manual-topics.json')];
  const data: typeof manualData = JSON.parse(readFileSync(candidates.find(existsSync) ?? candidates[0]!, 'utf8'));
  return data as readonly (Omit<KodaXManualTopic, 'body'> & { body: readonly string[] })[];
}
