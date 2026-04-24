/**
 * Shared YAML frontmatter parsing helpers.
 *
 * These primitives are consumed by both SKILL.md loading
 * (`@kodax/skills/skill-loader.ts`) and user/project markdown command
 * discovery (`@kodax/repl/commands/discovery.ts`). Both paths read the
 * same frontmatter shape (description + hook entries), so the
 * tolerant YAML sanitizer, the hook/tool normalizers, and the
 * frontmatter splitter all live here instead of being copy-pasted.
 *
 * Extracted per FEATURE_086 子任务 B 第 5 条 (GLM F-6).
 */

import YAML from 'yaml';

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'Notification',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export interface YamlHookEntry {
  command: string;
  matcher?: string;
}

export type YamlHookMap = Partial<Record<HookEventName, YamlHookEntry[]>>;

/**
 * Tolerant pass for YAML that may contain unquoted colons in values
 * (common in hand-written SKILL.md / command frontmatter). Converts
 * such lines to block-scalar format so `YAML.parse` can accept them.
 */
export function sanitizeYaml(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      if (
        value.includes(':')
        && !value.startsWith('"')
        && !value.startsWith("'")
        && !value.startsWith('[')
        && !value.startsWith('|')
        && !value.startsWith('>')
      ) {
        result.push(`${key}: |-`);
        result.push(`  ${value}`);
        continue;
      }
    }
    result.push(line);
  }

  return result.join('\n');
}

/**
 * Split a markdown document into (YAML frontmatter, body).
 * Returns `[null, originalContent]` when no frontmatter is present;
 * returns `[null, body]` when frontmatter is present but invalid and
 * callers want to continue with the body anyway.
 *
 * When `options.throwOnMissing = true`, callers that require
 * frontmatter (e.g. SKILL.md) receive descriptive errors rather than
 * a silent fallback.
 */
export function parseYamlFrontmatter(
  content: string,
  options: { throwOnMissing?: boolean } = {},
): [Record<string, unknown> | null, string] {
  const normalizedContent = content
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimStart();

  if (!normalizedContent.startsWith('---\n')) {
    if (options.throwOnMissing) {
      throw new Error('Invalid markdown: missing YAML frontmatter');
    }
    return [null, content];
  }

  let closeIndex = normalizedContent.indexOf('\n---\n', 4);
  if (closeIndex === -1) {
    const endMarkerIndex = normalizedContent.indexOf('\n---', 4);
    if (endMarkerIndex !== -1 && endMarkerIndex === normalizedContent.length - 4) {
      closeIndex = endMarkerIndex;
    }
  }

  if (closeIndex === -1) {
    if (options.throwOnMissing) {
      throw new Error('Invalid markdown: unclosed YAML frontmatter');
    }
    return [null, content];
  }

  const frontmatterText = normalizedContent.slice(4, closeIndex);
  const body = normalizedContent.slice(closeIndex + 5).trim();

  let parsed: unknown;
  try {
    parsed = YAML.parse(frontmatterText) ?? {};
  } catch {
    parsed = YAML.parse(sanitizeYaml(frontmatterText)) ?? {};
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (options.throwOnMissing) {
      throw new Error('Invalid markdown: YAML frontmatter must be an object');
    }
    return [null, body];
  }

  return [parsed as Record<string, unknown>, body];
}

/**
 * Accepts either a string (comma-separated allowlist already) or an
 * array of names, returning the normalized comma-separated form.
 * Empty / whitespace-only inputs collapse to undefined so callers can
 * distinguish "no allowlist" from "empty allowlist".
 */
export function normalizeAllowedToolsString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
    return normalized.length > 0 ? normalized.join(', ') : undefined;
  }

  return undefined;
}

/**
 * Accepts either a bare command string or an object with
 * `{ command, matcher? }`. Returns undefined for malformed inputs so
 * the caller can drop them silently (matching the pre-extraction
 * behavior of both loaders).
 */
export function normalizeYamlHookEntry(value: unknown): YamlHookEntry | undefined {
  if (typeof value === 'string') {
    const command = value.trim();
    return command ? { command } : undefined;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (!command) {
      return undefined;
    }

    const matcher = typeof record.matcher === 'string' && record.matcher.trim()
      ? record.matcher.trim()
      : undefined;

    return { command, matcher };
  }

  return undefined;
}

export function normalizeYamlHookEntryList(value: unknown): YamlHookEntry[] | undefined {
  if (value == null) {
    return undefined;
  }

  const items = Array.isArray(value) ? value : [value];
  const normalized = items
    .map((item) => normalizeYamlHookEntry(item))
    .filter((item): item is YamlHookEntry => item !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeYamlHookMap(value: unknown): YamlHookMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const hooks: YamlHookMap = {};

  for (const eventName of HOOK_EVENT_NAMES) {
    const normalized = normalizeYamlHookEntryList(record[eventName]);
    if (normalized) {
      hooks[eventName] = normalized;
    }
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}
