import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import type { KodaXSessionArtifactLedgerEntry } from '../types.js';
import {
  buildPostCompactAttachments,
  injectPostCompactAttachments,
  DEFAULT_POST_COMPACT_CONFIG,
} from './post-compact.js';

function createLedgerEntry(
  kind: KodaXSessionArtifactLedgerEntry['kind'],
  target: string,
  overrides?: Partial<KodaXSessionArtifactLedgerEntry>,
): KodaXSessionArtifactLedgerEntry {
  return {
    id: `artifact_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    sourceTool: overrides?.sourceTool ?? 'test',
    action: overrides?.action ?? kind.replace('file_', ''),
    target,
    displayTarget: overrides?.displayTarget ?? target,
    summary: overrides?.summary ?? `${kind} ${target}`,
    timestamp: new Date().toISOString(),
    metadata: overrides?.metadata,
  };
}

describe('buildPostCompactAttachments', () => {
  it('returns null when ledger is empty', () => {
    const result = buildPostCompactAttachments([], 50000);
    expect(result.ledgerMessage).toBeNull();
    expect(result.fileMessages).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
  });

  it('returns null when freed tokens is zero', () => {
    const ledger = [createLedgerEntry('file_modified', 'src/auth.ts')];
    const result = buildPostCompactAttachments(ledger, 0);
    expect(result.ledgerMessage).toBeNull();
  });

  it('renders modified files in ledger summary', () => {
    const ledger = [
      createLedgerEntry('file_modified', 'src/auth.ts', { action: 'edit' }),
      createLedgerEntry('file_modified', 'src/config.ts', { action: 'write' }),
    ];
    const result = buildPostCompactAttachments(ledger, 50000);
    expect(result.ledgerMessage).not.toBeNull();
    const content = result.ledgerMessage?.content as string;
    expect(content).toContain('Modified:');
    expect(content).toContain('src/auth.ts (edit)');
    expect(content).toContain('src/config.ts (write)');
  });

  it('renders read files in ledger summary', () => {
    const ledger = [
      createLedgerEntry('file_read', 'package.json'),
      createLedgerEntry('file_read', 'tsconfig.json'),
    ];
    const result = buildPostCompactAttachments(ledger, 50000);
    const content = result.ledgerMessage?.content as string;
    expect(content).toContain('Read:');
    expect(content).toContain('package.json');
    expect(content).toContain('tsconfig.json');
  });

  it('does not inject when freedTokens is tiny (budget rounds to near zero)', () => {
    const ledger = [
      createLedgerEntry('file_modified', 'src/auth.ts', { action: 'edit' }),
      createLedgerEntry('file_read', 'package.json'),
    ];
    // freedTokens=2 → totalBudget=1 → ledgerBudget=max(1, floor(1*0.15))=1
    // With only 1 token budget, renderLedgerSummary should return null
    const result = buildPostCompactAttachments(ledger, 2);
    expect(result.ledgerMessage).toBeNull();
    expect(result.totalTokens).toBe(0);
  });

  it('renders search and command entries', () => {
    const ledger = [
      createLedgerEntry('search_scope', 'session', {
        sourceTool: 'grep',
        metadata: { path: 'src/auth/' },
      }),
      createLedgerEntry('command_scope', 'test', {
        action: 'npm',
        displayTarget: 'test --coverage',
      }),
    ];
    const result = buildPostCompactAttachments(ledger, 50000);
    const content = result.ledgerMessage?.content as string;
    expect(content).toContain('Search:');
    expect(content).toContain('grep "session"');
    expect(content).toContain('Commands:');
    expect(content).toContain('npm test --coverage');
  });
});

describe('injectPostCompactAttachments', () => {
  it('returns original messages when no attachments', () => {
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'summary' },
      { role: 'user', content: 'hello' },
    ];
    const attachments = { ledgerMessage: null, fileMessages: [], totalTokens: 0 };
    expect(injectPostCompactAttachments(messages, attachments)).toBe(messages);
  });

  it('injects after the compaction summary system message', () => {
    const messages: KodaXMessage[] = [
      { role: 'system', content: '[对话历史摘要]\n\n## Goal\nFix auth' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'working on it' },
    ];
    const ledgerMsg: KodaXMessage = {
      role: 'system',
      content: '[Post-compact: recent operations]\nModified: src/auth.ts',
    };
    const attachments = { ledgerMessage: ledgerMsg, fileMessages: [], totalTokens: 50 };
    const result = injectPostCompactAttachments(messages, attachments);

    expect(result).toHaveLength(4);
    expect(result[0]?.role).toBe('system'); // Original summary
    expect(result[1]?.content).toContain('Post-compact'); // Injected ledger
    expect(result[2]?.role).toBe('user'); // Original tail
  });

  it('prepends when no summary message found', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'hello' },
    ];
    const ledgerMsg: KodaXMessage = {
      role: 'system',
      content: '[Post-compact: recent operations]\nModified: src/auth.ts',
    };
    const attachments = { ledgerMessage: ledgerMsg, fileMessages: [], totalTokens: 50 };
    const result = injectPostCompactAttachments(messages, attachments);

    expect(result).toHaveLength(2);
    expect(result[0]?.content).toContain('Post-compact');
  });
});
