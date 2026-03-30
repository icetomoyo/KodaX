import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_DEFAULT_FALLBACK = 'gpt-5.4';
const GEMINI_DEFAULT_FALLBACK = 'auto-gemini-3';

const CODEX_KNOWN_MODELS = [
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
];

const GEMINI_KNOWN_MODELS = [
  'auto-gemini-3',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function readCodexConfiguredModel(): string | null {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function readGeminiConfiguredModel(): string | null {
  const configPath = path.join(os.homedir(), '.gemini', 'settings.json');

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      model?: unknown;
      general?: {
        model?: unknown;
      };
    };

    const direct = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    if (direct) return direct;

    const general = typeof parsed.general?.model === 'string'
      ? parsed.general.model.trim()
      : '';
    return general || null;
  } catch {
    return null;
  }
}

export function getCodexCliDefaultModel(): string {
  return readCodexConfiguredModel() || CODEX_DEFAULT_FALLBACK;
}

export function getGeminiCliDefaultModel(): string {
  return readGeminiConfiguredModel() || GEMINI_DEFAULT_FALLBACK;
}

export function getCodexCliKnownModels(): string[] {
  return dedupePreserveOrder([
    getCodexCliDefaultModel(),
    ...CODEX_KNOWN_MODELS,
  ]);
}

export function getGeminiCliKnownModels(): string[] {
  return dedupePreserveOrder([
    getGeminiCliDefaultModel(),
    ...GEMINI_KNOWN_MODELS,
  ]);
}
