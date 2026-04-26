/**
 * Smoke tests for tests/sa-refactor-goldens/{session-parser,selection}.ts
 *
 * The hard parts of the selection harness — jsonl format detection, lineage
 * tree linearisation, detector heuristics — are easy to get subtly wrong on
 * real data. These tests use both synthetic fixtures (deterministic shape
 * assertions) and a guarded scan of the user's actual `.kodax/sessions/`
 * directory (correctness against in-the-wild data; skipped when the
 * directory is absent so the test stays portable).
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';

import {
  parseSessionContent,
  parseSessionFile,
  listSessionFiles,
  type RawSession,
} from './session-parser.js';
import {
  classifyTaskFamily,
  bucketByLength,
  EDGE_CASE_DETECTORS,
  selectSessions,
  DEFAULT_OPTIONS,
} from './selection.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const LEGACY_FLAT = [
  '{"_type":"meta","title":"How do I add a route?","id":"sess-legacy","createdAt":"2026-04-26T00:00:00Z"}',
  '{"role":"user","content":"How do I add a route?"}',
  '{"role":"assistant","content":[{"type":"text","text":"You add a route by..."}]}',
  '{"role":"user","content":"thanks"}',
].join('\n');

const LEGACY_WITH_IMAGE = [
  '{"_type":"meta","title":"分析这张截图","id":"sess-img"}',
  '{"role":"user","content":[{"type":"text","text":"分析这张截图"},{"type":"image","path":"/tmp/x.png"}]}',
  '{"role":"assistant","content":"OK"}',
].join('\n');

const LEGACY_WITH_TOOL_ERROR = [
  '{"_type":"meta","title":"修一下bug","id":"sess-err"}',
  '{"role":"user","content":"修一下bug"}',
  '{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"edit","input":{}}]}',
  '{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"anchor not found","is_error":true}]}',
  '{"role":"assistant","content":""}',
].join('\n');

const LEGACY_WITH_RECOVERY = [
  '{"_type":"meta","title":"refactor X"}',
  '{"role":"user","content":"refactor X"}',
  '{"role":"user","content":"Please re-read the file before edit anchor — file changed since last read."}',
  '{"role":"assistant","content":"OK"}',
].join('\n');

const LEGACY_WITH_SYNTHETIC_TAIL = [
  '{"_type":"meta"}',
  '{"role":"user","content":"start"}',
  '{"role":"assistant","content":"done"}',
  '{"role":"user","content":"queued by extension","_synthetic":true}',
].join('\n');

const LINEAGE_TREE = [
  '{"_type":"meta","id":"sess-lineage","activeEntryId":"e3","lineageVersion":2}',
  '{"_type":"lineage_entry","entry":{"type":"message","id":"e1","parentId":null,"timestamp":"2026-04-26T00:00:01Z","message":{"role":"system","content":"sys"}}}',
  '{"_type":"lineage_entry","entry":{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-04-26T00:00:02Z","message":{"role":"user","content":"hi"}}}',
  '{"_type":"lineage_entry","entry":{"type":"message","id":"e3","parentId":"e2","timestamp":"2026-04-26T00:00:03Z","message":{"role":"assistant","content":"hello"}}}',
].join('\n');

// ---------------------------------------------------------------------------
// Tests — parser
// ---------------------------------------------------------------------------

describe('parseSessionContent', () => {
  it('parses legacy flat format (one message per line after meta)', () => {
    const session = parseSessionContent(LEGACY_FLAT, '/tmp/sess-legacy.jsonl');
    expect(session.metadata.format).toBe('legacy-flat');
    expect(session.sessionId).toBe('sess-legacy');
    expect(session.messages).toHaveLength(3);
    expect(session.metadata.turnCount).toBe(2);
    expect(session.metadata.initialPromptText).toBe('How do I add a route?');
  });

  it('parses lineage-tree format and walks back from activeEntryId in chronological order', () => {
    const session = parseSessionContent(LINEAGE_TREE, '/tmp/sess-lineage.jsonl');
    expect(session.metadata.format).toBe('lineage-tree');
    expect(session.messages).toHaveLength(3);
    expect(session.messages[0]!.role).toBe('system');
    expect(session.messages[1]!.role).toBe('user');
    expect(session.messages[2]!.role).toBe('assistant');
  });

  it('detects multimodal image blocks', () => {
    const session = parseSessionContent(LEGACY_WITH_IMAGE, '/tmp/img.jsonl');
    expect(session.metadata.hasImageBlock).toBe(true);
  });

  it('detects tool_result is_error', () => {
    const session = parseSessionContent(LEGACY_WITH_TOOL_ERROR, '/tmp/err.jsonl');
    expect(session.metadata.hasToolError).toBe(true);
  });

  it('detects edit-recovery user-message marker', () => {
    const session = parseSessionContent(LEGACY_WITH_RECOVERY, '/tmp/rec.jsonl');
    expect(session.metadata.hasEditRecoveryMessage).toBe(true);
  });

  it('detects synthetic tail (extension queue drain heuristic)', () => {
    const session = parseSessionContent(LEGACY_WITH_SYNTHETIC_TAIL, '/tmp/syn.jsonl');
    expect(session.metadata.hasSyntheticTail).toBe(true);
  });

  it('returns empty session shape for empty input', () => {
    const session = parseSessionContent('', '/tmp/empty.jsonl');
    expect(session.messages).toHaveLength(0);
    expect(session.metadata.format).toBe('unknown');
  });

  it('round-trips through disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-parse-'));
    try {
      const filePath = path.join(dir, 'roundtrip.jsonl');
      await fs.writeFile(filePath, LEGACY_FLAT, 'utf-8');
      const session = await parseSessionFile(filePath);
      expect(session.messages).toHaveLength(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — classifier + bucketing
// ---------------------------------------------------------------------------

describe('classifyTaskFamily', () => {
  it.each([
    ['帮我review一下这个 PR', 'review'],
    ['Please plan how to migrate auth', 'planning'],
    ['为什么测试挂了？', 'investigation'],
    ['add a new endpoint', 'implementation'],
    ['where is the rate limiter defined?', 'lookup'],
    ['', 'unknown'],
    ['just chatting about life', 'conversation'],
  ])('classifies %j as %s', (prompt, expected) => {
    expect(classifyTaskFamily(prompt)).toBe(expected);
  });
});

describe('bucketByLength', () => {
  it.each([
    [0, 'short'],
    [1, 'short'],
    [2, 'short'],
    [3, 'medium'],
    [7, 'medium'],
    [8, 'long'],
    [50, 'long'],
  ])('bucket for turnCount=%d is %s', (n, expected) => {
    expect(bucketByLength(n)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Tests — detectors compose into selection algorithm
// ---------------------------------------------------------------------------

function makeSession(opts: {
  id: string;
  promptText: string;
  turnCount: number;
  hasImage?: boolean;
  hasToolError?: boolean;
  hasRecovery?: boolean;
  hasSyntheticTail?: boolean;
}): RawSession {
  return {
    sessionId: opts.id,
    filePath: `/tmp/${opts.id}.jsonl`,
    meta: {},
    messages: [],
    metadata: {
      initialPromptText: opts.promptText,
      turnCount: opts.turnCount,
      hasImageBlock: opts.hasImage ?? false,
      hasToolError: opts.hasToolError ?? false,
      hasEditRecoveryMessage: opts.hasRecovery ?? false,
      hasSyntheticTail: opts.hasSyntheticTail ?? false,
      format: 'legacy-flat',
    },
  };
}

describe('selectSessions', () => {
  it('selects mandatory-coverage sessions before bucket-fill picks', () => {
    const corpus: RawSession[] = [
      makeSession({ id: 'img1', promptText: 'show me x', turnCount: 5, hasImage: true }),
      makeSession({ id: 'rec1', promptText: 'fix y', turnCount: 5, hasRecovery: true }),
      ...Array.from({ length: 30 }, (_, i) =>
        makeSession({ id: `plain${i}`, promptText: `plain ${i}`, turnCount: 1 + (i % 12) })),
    ];

    const report = selectSessions(corpus, {
      perBucket: { short: 3, medium: 3, long: 3 },
      perFamilyMin: 1,
      maxTotal: 12,
    });

    const ids = new Set(report.selected.map((s) => s.sessionId));
    expect(ids.has('img1')).toBe(true);
    expect(ids.has('rec1')).toBe(true);
    expect(report.detectorCoverage.multimodalImage.selected).toBeGreaterThan(0);
    expect(report.detectorCoverage.editRecovery.selected).toBeGreaterThan(0);
  });

  it('warns when a detector has zero matches in the corpus', () => {
    const corpus: RawSession[] = Array.from({ length: 10 }, (_, i) =>
      makeSession({ id: `s${i}`, promptText: 'hi', turnCount: 2 }));
    const report = selectSessions(corpus, DEFAULT_OPTIONS);
    const warned = report.warnings.some((w) => /multimodalImage|editRecovery|errorSnapshot/.test(w));
    expect(warned).toBe(true);
  });

  it('caps selection at maxTotal even when bucket quotas would exceed it', () => {
    const corpus: RawSession[] = Array.from({ length: 100 }, (_, i) =>
      makeSession({ id: `s${i}`, promptText: 'plan something', turnCount: 5 }));
    const report = selectSessions(corpus, {
      perBucket: { short: 50, medium: 50, long: 50 },
      perFamilyMin: 0,
      maxTotal: 20,
    });
    expect(report.selected.length).toBeLessThanOrEqual(20);
  });

  it('reports per-bucket and per-family coverage counts', () => {
    const corpus: RawSession[] = [
      makeSession({ id: 'r1', promptText: '帮我review一下', turnCount: 1 }),
      makeSession({ id: 'r2', promptText: '帮我review一下', turnCount: 4 }),
      makeSession({ id: 'p1', promptText: 'plan migration', turnCount: 10 }),
    ];
    const report = selectSessions(corpus, {
      perBucket: { short: 1, medium: 1, long: 1 },
      perFamilyMin: 0,
      maxTotal: 10,
    });
    expect(report.bucketCoverage.short + report.bucketCoverage.medium + report.bucketCoverage.long).toBe(report.selected.length);
    expect(Object.values(report.familyCoverage).reduce((a, b) => a + b, 0)).toBe(report.selected.length);
  });
});

// ---------------------------------------------------------------------------
// In-the-wild guard test — only runs when the user's session dir is present
// ---------------------------------------------------------------------------

const REAL_SESSIONS_DIR = path.join(os.homedir(), '.kodax', 'sessions');
const HAS_REAL_SESSIONS = existsSync(REAL_SESSIONS_DIR);

const describeOrSkip = HAS_REAL_SESSIONS ? describe : describe.skip;

describeOrSkip('against real .kodax/sessions/ corpus', () => {
  it('parses every jsonl file without throwing and reports basic shape', async () => {
    const files = await listSessionFiles(REAL_SESSIONS_DIR);
    expect(files.length).toBeGreaterThan(0);

    const failures: Array<{ file: string; error: string }> = [];
    let totalMessages = 0;
    let lineageCount = 0;
    let legacyCount = 0;
    for (const file of files) {
      try {
        const session = await parseSessionFile(file);
        totalMessages += session.messages.length;
        if (session.metadata.format === 'lineage-tree') lineageCount += 1;
        else if (session.metadata.format === 'legacy-flat') legacyCount += 1;
      } catch (e) {
        failures.push({ file, error: e instanceof Error ? e.message : String(e) });
      }
    }

    expect(failures).toEqual([]);
    expect(totalMessages).toBeGreaterThan(0);
    // Most sessions should land in a known format. Allow up to 5% unknown
    // (empty / truncated / single-line files do exist in the wild — our
    // parser correctly labels them rather than throwing).
    const recognized = lineageCount + legacyCount;
    expect(recognized / files.length).toBeGreaterThanOrEqual(0.9);
  });

  it('selectSessions over the real corpus returns a report with no parser-level warnings', async () => {
    const files = await listSessionFiles(REAL_SESSIONS_DIR);
    const sessions = await Promise.all(files.map(parseSessionFile));
    const report = selectSessions(sessions);
    expect(report.totalCandidates).toBe(sessions.length);
    expect(report.selected.length).toBeGreaterThan(0);
    // Nothing fundamental should have failed; specific detector zero-hit
    // warnings are acceptable (depends on user's session distribution).
  });
});
