import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  appendAuditEntry,
  computeDiffHash,
  readAuditEntries,
  type AuditEntry,
} from './audit-log.js';
import type { AgentContent } from './types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-audit-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function buildEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: overrides.ts ?? new Date().toISOString(),
    event: overrides.event ?? 'self_modify_staged',
    agentName: overrides.agentName ?? 'alpha',
    toVersion: overrides.toVersion ?? '1.1.0',
    ...(overrides.fromVersion !== undefined ? { fromVersion: overrides.fromVersion } : {}),
    ...(overrides.diffHash !== undefined ? { diffHash: overrides.diffHash } : {}),
    ...(overrides.llmSummary !== undefined ? { llmSummary: overrides.llmSummary } : {}),
    ...(overrides.severity !== undefined ? { severity: overrides.severity } : {}),
    ...(overrides.flaggedConcerns !== undefined ? { flaggedConcerns: overrides.flaggedConcerns } : {}),
    ...(overrides.policyVerdict !== undefined ? { policyVerdict: overrides.policyVerdict } : {}),
    ...(overrides.budgetRemaining !== undefined ? { budgetRemaining: overrides.budgetRemaining } : {}),
    ...(overrides.rejectRule !== undefined ? { rejectRule: overrides.rejectRule } : {}),
    ...(overrides.rejectReason !== undefined ? { rejectReason: overrides.rejectReason } : {}),
    ...(overrides.user !== undefined ? { user: overrides.user } : {}),
  };
}

describe('appendAuditEntry', () => {
  it('creates the audit file on first call and writes one JSON line', async () => {
    const entry = buildEntry({ event: 'self_modify_staged' });
    await appendAuditEntry(entry, { cwd: tmpRoot });

    const filePath = path.join(tmpRoot, '.kodax', 'constructed', '_audit.jsonl');
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').filter(Boolean).length).toBe(1);
    expect(JSON.parse(raw.trim())).toMatchObject({
      event: 'self_modify_staged',
      agentName: 'alpha',
    });
  });

  it('appends successive entries on separate lines', async () => {
    await appendAuditEntry(buildEntry({ event: 'self_modify_staged' }), { cwd: tmpRoot });
    await appendAuditEntry(buildEntry({ event: 'self_modify_tested' }), { cwd: tmpRoot });
    await appendAuditEntry(buildEntry({ event: 'self_modify_activated' }), { cwd: tmpRoot });

    const entries = await readAuditEntries({ cwd: tmpRoot });
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.event)).toEqual([
      'self_modify_staged',
      'self_modify_tested',
      'self_modify_activated',
    ]);
  });

  it('omits undefined optional fields from the JSON line', async () => {
    await appendAuditEntry(buildEntry({ event: 'self_modify_staged' }), { cwd: tmpRoot });
    const filePath = path.join(tmpRoot, '.kodax', 'constructed', '_audit.jsonl');
    const raw = (await fs.readFile(filePath, 'utf8')).trim();
    expect(raw).not.toContain('"diffHash"');
    expect(raw).not.toContain('"llmSummary"');
  });
});

describe('readAuditEntries', () => {
  it('returns an empty array when the file does not exist', async () => {
    const entries = await readAuditEntries({ cwd: tmpRoot });
    expect(entries).toEqual([]);
  });

  it('filters by agentName', async () => {
    await appendAuditEntry(buildEntry({ agentName: 'alpha', event: 'self_modify_staged' }), { cwd: tmpRoot });
    await appendAuditEntry(buildEntry({ agentName: 'beta', event: 'self_modify_staged' }), { cwd: tmpRoot });
    await appendAuditEntry(buildEntry({ agentName: 'alpha', event: 'self_modify_activated' }), { cwd: tmpRoot });

    const alpha = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(alpha).toHaveLength(2);
    expect(alpha.every((e) => e.agentName === 'alpha')).toBe(true);
  });

  it('filters by event kinds', async () => {
    await appendAuditEntry(buildEntry({ event: 'self_modify_staged' }), { cwd: tmpRoot });
    await appendAuditEntry(buildEntry({ event: 'self_modify_activated' }), { cwd: tmpRoot });
    await appendAuditEntry(buildEntry({ event: 'self_modify_rejected' }), { cwd: tmpRoot });

    const filtered = await readAuditEntries({
      cwd: tmpRoot,
      events: ['self_modify_activated', 'self_modify_rejected'],
    });
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.event).sort()).toEqual([
      'self_modify_activated',
      'self_modify_rejected',
    ]);
  });

  it('skips malformed lines with a stderr warning and continues', async () => {
    const filePath = path.join(tmpRoot, '.kodax', 'constructed', '_audit.jsonl');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        JSON.stringify(buildEntry({ event: 'self_modify_staged' })),
        '{ this is not json',
        JSON.stringify(buildEntry({ event: 'self_modify_activated' })),
        '',
      ].join('\n') + '\n',
      'utf8',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const entries = await readAuditEntries({ cwd: tmpRoot });
      expect(entries).toHaveLength(2);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('computeDiffHash', () => {
  function buildContent(overrides: Partial<AgentContent> = {}): AgentContent {
    return {
      instructions: overrides.instructions ?? 'You are alpha.',
      ...(overrides.tools ? { tools: overrides.tools } : {}),
      ...(overrides.guardrails ? { guardrails: overrides.guardrails } : {}),
    };
  }

  it('produces the same hash for byte-identical content pairs', () => {
    const prev = buildContent({ instructions: 'a' });
    const next = buildContent({ instructions: 'b' });
    expect(computeDiffHash(prev, next)).toBe(computeDiffHash(prev, next));
  });

  it('is order-independent across object key ordering', () => {
    const prev = buildContent({
      instructions: 'a',
      guardrails: [{ kind: 'input', ref: 'no-secrets' }],
    });
    const nextA = {
      instructions: 'b',
      guardrails: [{ kind: 'input' as const, ref: 'no-secrets' }],
    };
    const nextB = {
      guardrails: [{ ref: 'no-secrets', kind: 'input' as const }],
      instructions: 'b',
    };
    expect(computeDiffHash(prev, nextA)).toBe(computeDiffHash(prev, nextB));
  });

  it('produces different hashes when prev/next are swapped', () => {
    const a = buildContent({ instructions: 'a' });
    const b = buildContent({ instructions: 'b' });
    expect(computeDiffHash(a, b)).not.toBe(computeDiffHash(b, a));
  });
});
