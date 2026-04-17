import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import type { KodaXSessionArtifactLedgerEntry } from '../types.js';
import {
  buildFileContentMessages,
  buildPostCompactAttachments,
  injectPostCompactAttachments,
  DEFAULT_POST_COMPACT_CONFIG,
  POST_COMPACT_TOKEN_BUDGET,
  POST_COMPACT_MAX_TOKENS_PER_FILE,
} from './post-compact.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

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

describe('buildFileContentMessages', () => {
  let tmpDir: string;

  async function createTmpFile(name: string, content: string): Promise<string> {
    const filePath = path.join(tmpDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-postcompact-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns empty array when budget is 0', async () => {
    const ledger = [createLedgerEntry('file_modified', '/some/file.ts')];
    const result = await buildFileContentMessages(ledger, 0);
    expect(result).toEqual([]);
  });

  it('returns empty array when ledger has no modified/created files', async () => {
    const ledger = [
      createLedgerEntry('file_read', '/some/file.ts'),
      createLedgerEntry('search_scope', 'query'),
    ];
    const result = await buildFileContentMessages(ledger, 10000);
    expect(result).toEqual([]);
  });

  it('reads a modified file and creates a system message', async () => {
    const filePath = await createTmpFile('test.ts', 'const x = 1;\nconst y = 2;\n');
    const ledger = [createLedgerEntry('file_modified', filePath)];
    const result = await buildFileContentMessages(ledger, 10000);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('system');
    expect(typeof result[0]?.content === 'string' && result[0].content).toContain('const x = 1');
    expect(typeof result[0]?.content === 'string' && result[0].content).toContain(filePath);
  });

  it('skips files that do not exist', async () => {
    const ledger = [createLedgerEntry('file_modified', '/nonexistent/file.ts')];
    const result = await buildFileContentMessages(ledger, 10000);
    expect(result).toEqual([]);
  });

  it('deduplicates files by path (keeps most recent)', async () => {
    const filePath = await createTmpFile('dup.ts', 'content');
    const ledger = [
      createLedgerEntry('file_modified', filePath, { timestamp: '2026-01-01T00:00:00Z' } as Partial<KodaXSessionArtifactLedgerEntry>),
      createLedgerEntry('file_modified', filePath, { timestamp: '2026-01-02T00:00:00Z' } as Partial<KodaXSessionArtifactLedgerEntry>),
    ];
    const result = await buildFileContentMessages(ledger, 10000);
    expect(result).toHaveLength(1);
  });

  it('respects maxFiles from config', async () => {
    const files = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createTmpFile(`f${i}.ts`, `file ${i}`)),
    );
    const ledger = files.map((f) => createLedgerEntry('file_modified', f));
    const result = await buildFileContentMessages(ledger, 100000, {
      ...DEFAULT_POST_COMPACT_CONFIG,
      maxFiles: 3,
    });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('caps per-file tokens at POST_COMPACT_MAX_TOKENS_PER_FILE even with huge budget', async () => {
    // 400 KB of content ≈ 100k tokens — far above the 5k per-file cap.
    const bigContent = 'a '.repeat(200_000);
    const filePath = await createTmpFile('big.ts', bigContent);
    const ledger = [createLedgerEntry('file_modified', filePath)];
    // Pass a huge budget to prove the absolute per-file cap wins.
    const result = await buildFileContentMessages(ledger, 1_000_000);
    expect(result).toHaveLength(1);
    // Rough token estimate: body should be bounded by the absolute cap
    // (plus a small frame for path prefix / truncation marker).
    const content = result[0]!.content as string;
    const estimated = Math.ceil(content.length / 4);
    expect(estimated).toBeLessThanOrEqual(POST_COMPACT_MAX_TOKENS_PER_FILE + 100);
  });
});

describe('buildPostCompactAttachments absolute budget cap', () => {
  it('respects POST_COMPACT_TOKEN_BUDGET even when freedTokens is enormous', () => {
    const ledger = [
      createLedgerEntry('file_modified', 'src/a.ts'),
      createLedgerEntry('file_modified', 'src/b.ts'),
      createLedgerEntry('search_scope', 'pattern1'),
    ];
    // freedTokens=500k would normally yield a 250k budget (freedTokens*0.5).
    // The absolute cap must clamp to POST_COMPACT_TOKEN_BUDGET (50k).
    const freedTokens = 500_000;
    const result = buildPostCompactAttachments(ledger, freedTokens);
    // Ledger share is 15% of clamped total (50k*0.15 = 7.5k cap on ledger).
    // The returned ledger message must fit under the ceiling regardless of
    // freedTokens.
    expect(result.totalTokens).toBeLessThanOrEqual(POST_COMPACT_TOKEN_BUDGET);
  });
});

describe('injectPostCompactAttachments idempotence', () => {
  it('strips existing [Post-compact: ...] messages before injecting new ones', () => {
    const oldLedger: KodaXMessage = {
      role: 'system',
      content: '[Post-compact: recent operations]\nOLD ledger content',
    };
    const oldFile: KodaXMessage = {
      role: 'system',
      content: '[Post-compact: file content] /path/old.ts\nold body',
    };
    const summary: KodaXMessage = {
      role: 'system',
      content: '[对话历史摘要]\n\nolder summary body',
    };
    const tail: KodaXMessage = {
      role: 'user',
      content: 'recent turn',
    };
    const messages: KodaXMessage[] = [summary, oldLedger, oldFile, tail];

    const newLedger: KodaXMessage = {
      role: 'system',
      content: '[Post-compact: recent operations]\nNEW ledger content',
    };
    const newFile: KodaXMessage = {
      role: 'system',
      content: '[Post-compact: file content] /path/new.ts\nnew body',
    };

    const result = injectPostCompactAttachments(messages, {
      ledgerMessage: newLedger,
      fileMessages: [newFile],
      totalTokens: 100,
    });

    const postCompactMessages = result.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[Post-compact:'),
    );
    expect(postCompactMessages).toHaveLength(2);
    expect(postCompactMessages[0]).toBe(newLedger);
    expect(postCompactMessages[1]).toBe(newFile);
    // Old post-compact messages must be gone — otherwise monotonic growth
    // would accumulate across iterations.
    expect(result.some((m) => m === oldLedger)).toBe(false);
    expect(result.some((m) => m === oldFile)).toBe(false);
    // Summary and tail must be preserved.
    expect(result[0]).toBe(summary);
    expect(result).toContain(tail);
  });

  it('strips prior attachments even when the new injection is empty', () => {
    const oldLedger: KodaXMessage = {
      role: 'system',
      content: '[Post-compact: recent operations]\nstale ledger',
    };
    const tail: KodaXMessage = { role: 'user', content: 'later turn' };
    const messages: KodaXMessage[] = [oldLedger, tail];

    const result = injectPostCompactAttachments(messages, {
      ledgerMessage: null,
      fileMessages: [],
      totalTokens: 0,
    });

    expect(result).toEqual([tail]);
  });
});
