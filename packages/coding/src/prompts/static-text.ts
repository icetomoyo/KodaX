import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type textData from './static-text.json';

let data: typeof textData | undefined;
/** Versioned package data, with the same dev/package/bundle layout as the manual. */
export function staticText(key: keyof typeof textData): string {
  if (!data) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = process.env.KODAX_BUNDLED === 'true' ? [path.join(path.dirname(process.execPath), 'static-text.json')]
      : [path.join(here, 'static-text.json'), path.join(here, '..', 'static-text.json')];
    data = JSON.parse(readFileSync(candidates.find(existsSync) ?? candidates[0]!, 'utf8')) as typeof textData;
  }
  const text = data[key];
  if (typeof text !== 'string') throw new Error(`Missing package prompt text: ${key}`);
  return text;
}
