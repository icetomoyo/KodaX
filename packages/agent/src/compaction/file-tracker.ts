/**
 * @kodax/agent File Tracking
 */

import { randomUUID } from 'node:crypto';
import type { KodaXContentBlock, KodaXMessage, KodaXToolUseBlock } from '@kodax/ai';
import type { FileOperations } from './types.js';
import type { KodaXJsonValue, KodaXSessionArtifactLedgerEntry } from '../types.js';

const LEDGER_MAX_ENTRIES = 256;
const PATH_LIKE_KEYS = [
  'path',
  'file',
  'files',
  'outputPath',
  'cwd',
  'target_path',
  'scenePath',
  'scriptPath',
  'resourcePath',
  'module',
  'entry',
  'url',
] as const;

function isToolUseBlock(block: KodaXContentBlock): block is KodaXToolUseBlock {
  return block.type === 'tool_use';
}

function createLedgerId(): string {
  return `artifact_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFirstString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim());
    return typeof first === 'string' ? first.trim() : undefined;
  }
  return undefined;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function pickPathLikeTarget(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_LIKE_KEYS) {
    const value = readFirstString(input, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseCommandTarget(command: string): { action: string; target: string } {
  const normalized = compactWhitespace(command);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const action = tokens[0] ?? 'command';
  const target = tokens.slice(1).find((token) => {
    if (!token || token.startsWith('-')) {
      return false;
    }
    if (token.includes('=') && !token.includes('/') && !token.includes('.')) {
      return false;
    }
    return true;
  }) ?? action;

  return { action, target };
}

function toLedgerMetadata(
  input: Record<string, unknown>,
  keys: string[],
): Record<string, KodaXJsonValue> | undefined {
  const metadata: Record<string, KodaXJsonValue> = {};
  for (const key of keys) {
    const value = input[key];
    if (
      value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || (Array.isArray(value)
        && value.every((item) =>
          item === null
          || typeof item === 'string'
          || typeof item === 'number'
          || typeof item === 'boolean'))
    ) {
      metadata[key] = value as KodaXJsonValue;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function createLedgerEntry(
  kind: KodaXSessionArtifactLedgerEntry['kind'],
  sourceTool: string,
  action: string | undefined,
  target: string,
  summary: string,
  metadata?: Record<string, KodaXJsonValue>,
): KodaXSessionArtifactLedgerEntry {
  return {
    id: createLedgerId(),
    kind,
    sourceTool,
    action,
    target,
    displayTarget: target,
    summary,
    timestamp: new Date().toISOString(),
    metadata,
  };
}

function buildArtifactEntry(block: KodaXToolUseBlock): KodaXSessionArtifactLedgerEntry | null {
  const input = block.input as Record<string, unknown>;

  if (block.name === 'read') {
    const target = readString(input, 'path');
    return target
      ? createLedgerEntry('file_read', block.name, 'read', target, `Read ${target}`)
      : null;
  }

  if (block.name === 'write' || block.name === 'edit') {
    const target = readString(input, 'path');
    return target
      ? createLedgerEntry(
        'file_modified',
        block.name,
        block.name,
        target,
        `${block.name === 'write' ? 'Wrote' : 'Edited'} ${target}`,
      )
      : null;
  }

  if (block.name === 'glob') {
    const pattern = readString(input, 'pattern') ?? readString(input, 'glob');
    const scope = readString(input, 'path') ?? '.';
    return pattern
      ? createLedgerEntry(
        'path_scope',
        block.name,
        'glob',
        scope,
        `Glob ${pattern} in ${scope}`,
        toLedgerMetadata(input, ['pattern']),
      )
      : null;
  }

  if (block.name === 'grep' || block.name === 'code_search' || block.name === 'web_search') {
    const query = readString(input, 'pattern') ?? readString(input, 'query');
    const scope = readString(input, 'path') ?? readString(input, 'provider') ?? 'default';
    return query
      ? createLedgerEntry(
        'search_scope',
        block.name,
        block.name,
        query,
        `${block.name} ${query} (${scope})`,
        toLedgerMetadata(input, ['path', 'provider', 'provider_id']),
      )
      : null;
  }

  if (block.name === 'semantic_lookup') {
    const query = readString(input, 'query') ?? readString(input, 'symbol');
    const scope = readString(input, 'module') ?? readString(input, 'target_path') ?? 'workspace';
    return query
      ? createLedgerEntry(
        'search_scope',
        block.name,
        'semantic_lookup',
        query,
        `Semantic lookup ${query} (${scope})`,
        toLedgerMetadata(input, ['module', 'target_path']),
      )
      : null;
  }

  if (block.name === 'web_fetch') {
    const url = readString(input, 'url');
    return url
      ? createLedgerEntry(
        'path_scope',
        block.name,
        'fetch',
        url,
        `Fetched ${url}`,
        toLedgerMetadata(input, ['format', 'provider_id', 'capability_id']),
      )
      : null;
  }

  if (block.name === 'bash') {
    const command = readString(input, 'command');
    if (!command) {
      return null;
    }
    const parsed = parseCommandTarget(command);
    return createLedgerEntry(
      'command_scope',
      block.name,
      parsed.action,
      parsed.target,
      `Ran ${parsed.action} on ${parsed.target}`,
      toLedgerMetadata(input, ['timeout']),
    );
  }

  const target = pickPathLikeTarget(input);
  if (!target) {
    return null;
  }

  return createLedgerEntry(
    'path_scope',
    block.name,
    block.name,
    target,
    `${block.name} ${target}`,
  );
}

function ledgerDedupKey(entry: KodaXSessionArtifactLedgerEntry): string {
  return [
    entry.kind,
    entry.sourceTool ?? '',
    entry.action ?? '',
    entry.target,
  ].join('::');
}

export function extractFileOps(messages: KodaXMessage[]): FileOperations {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (!isToolUseBlock(block)) {
        continue;
      }

      const input = block.input as Record<string, unknown>;
      if (block.name === 'read' && typeof input.path === 'string') {
        readFiles.add(input.path);
      } else if ((block.name === 'write' || block.name === 'edit') && typeof input.path === 'string') {
        modifiedFiles.add(input.path);
      }
    }
  }

  return {
    readFiles: [...readFiles],
    modifiedFiles: [...modifiedFiles],
  };
}

export function mergeFileOps(
  ops1: FileOperations,
  ops2: FileOperations,
): FileOperations {
  return {
    readFiles: [...new Set([...ops1.readFiles, ...ops2.readFiles])],
    modifiedFiles: [...new Set([...ops1.modifiedFiles, ...ops2.modifiedFiles])],
  };
}

export function extractArtifactLedger(
  messages: KodaXMessage[],
): KodaXSessionArtifactLedgerEntry[] {
  const entries: KodaXSessionArtifactLedgerEntry[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (!isToolUseBlock(block)) {
        continue;
      }

      const entry = buildArtifactEntry(block);
      if (entry) {
        entries.push(entry);
      }
    }
  }

  return mergeArtifactLedger([], entries);
}

export function mergeArtifactLedger(
  existing: KodaXSessionArtifactLedgerEntry[],
  next: KodaXSessionArtifactLedgerEntry[],
): KodaXSessionArtifactLedgerEntry[] {
  const merged = new Map<string, KodaXSessionArtifactLedgerEntry>();

  for (const entry of [...existing, ...next]) {
    merged.set(ledgerDedupKey(entry), {
      ...entry,
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    });
  }

  return Array.from(merged.values()).slice(-LEDGER_MAX_ENTRIES);
}
