import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyToolResultGuardrail } from './tool-result-policy.js';
import { DEFAULT_TOOL_OUTPUT_MAX_BYTES } from './truncate.js';
import { toolRead } from './read.js';
import { getToolDefinition } from './registry.js';
import {
  createTransientTextArtifact,
  deleteTransientTextArtifact,
} from '../transient-text-artifacts.js';

describe('toolRead', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-read-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('streams a bounded first chunk for large files and hints continuation', async () => {
    const filePath = path.join(tempDir, 'large.txt');
    const content = Array.from({ length: 4000 }, (_, index) => `line-${index + 1}-${'x'.repeat(90)}`).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-1');
    expect(result).toContain('Use offset=');
    expect(result).toContain('Large file:');
  });

  it('keeps the exact continuation hint after the global read guardrail runs', async () => {
    const filePath = path.join(tempDir, 'guarded-large.txt');
    const content = Array.from(
      { length: 2200 },
      (_, index) => `line-${index + 1}-${'x'.repeat(120)}`,
    ).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    const guarded = await applyToolResultGuardrail('read', result, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_MAX_BYTES);
    expect(result).toContain('Use offset=');
    expect(guarded.truncated).toBe(false);
    expect(guarded.content).toContain('Use offset=');
  });

  it('supports offset-based continuation', async () => {
    const filePath = path.join(tempDir, 'offset.txt');
    const content = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n');
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await toolRead({ path: filePath, offset: 10, limit: 3 }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-10');
    expect(result).toContain('line-12');
    expect(result).not.toContain('line-9');
  });

  it('rejects an already cancelled read before accessing content', async () => {
    const filePath = path.join(tempDir, 'cancelled.txt');
    await fs.writeFile(filePath, 'must not be delivered');
    const controller = new AbortController();
    controller.abort();
    await expect(toolRead({ path: filePath }, {
      backups: new Map(), abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reads a giant line and giant lookahead within a bounded child heap', async () => {
    const giantPath = path.join(tempDir, 'giant.txt');
    const lookaheadPath = path.join(tempDir, 'lookahead.txt');
    await fs.writeFile(giantPath, 'x'.repeat(8 * 1024 * 1024));
    await fs.writeFile(lookaheadPath, 'first\n' + 'x'.repeat(8 * 1024 * 1024));
    const childPath = path.join(tempDir, 'read-child.mjs');
    await fs.writeFile(childPath, `
      import assert from 'node:assert/strict';
      import { toolRead } from ${JSON.stringify(new URL('./read.ts', import.meta.url).href)};
      const first = await toolRead({ path: ${JSON.stringify(giantPath)}, limit: 1 }, { backups: new Map() });
      assert.equal(typeof first, 'string');
      assert.ok(first.includes('line_offset=2000'));
      assert.ok(!first.includes('of 8388608'));
      const next = await toolRead({ path: ${JSON.stringify(lookaheadPath)}, limit: 1 }, { backups: new Map() });
      assert.ok(next.includes('Use offset=2'));
      assert.ok(!next.includes('xxxx'));
    `);
    const child = spawnSync(process.execPath, ['--max-old-space-size=96', '--import', 'tsx', childPath], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    expect({ status: child.status, error: child.error, stderr: child.stderr }).toEqual({
      status: 0, error: undefined, stderr: '',
    });
  }, 30_000);

  it('pages opaque process-memory artifacts without filesystem access', async () => {
    const artifactPath = createTransientTextArtifact('one\ntwo\nthree\nfour');
    const recordToolResultArtifact = vi.fn();
    try {
      const result = await toolRead({ path: artifactPath, offset: 2, limit: 2 }, {
        backups: new Map(),
        toolCallId: 'transient-read-1',
        recordToolResultArtifact,
        assertReadablePath: () => {
          throw new Error('filesystem policy must not receive transient capabilities');
        },
      });

      expect(result).toContain('two\nthree');
      expect(result).toContain('Use offset=4');
      expect(result).not.toContain('one');
      expect(recordToolResultArtifact).toHaveBeenCalledWith(
        'transient-read-1',
        artifactPath,
      );
    } finally {
      deleteTransientTextArtifact(artifactPath);
    }
  });

  it('pages one long Unicode line in a transient capability with the normal read bound', async () => {
    const artifactPath = createTransientTextArtifact('🙂'.repeat(4_500));
    try {
      const first = await toolRead({ path: artifactPath, limit: 1 }, {
        backups: new Map(),
      });
      const second = await toolRead({
        path: artifactPath,
        offset: 1,
        limit: 1,
        line_offset: 2_000,
      }, {
        backups: new Map(),
      });

      expect(first).toContain('Unicode characters 0-1999 of 4500');
      expect(first).toContain('line_offset=2000');
      expect(first).not.toContain('End of file');
      expect(second).toContain('Unicode characters 2000-3999 of 4500');
      expect(second).toContain('line_offset=4000');
      expect(Buffer.byteLength(first, 'utf-8')).toBeLessThanOrEqual(
        DEFAULT_TOOL_OUTPUT_MAX_BYTES,
      );
    } finally {
      deleteTransientTextArtifact(artifactPath);
    }
  });

  it('caps a hostile transient line limit before collecting output', async () => {
    const artifactPath = createTransientTextArtifact('x\n'.repeat(10_000));
    try {
      const result = await toolRead({
        path: artifactPath,
        limit: Number.MAX_SAFE_INTEGER,
      }, { backups: new Map() });

      expect(result.split('\n').filter((line) => line === 'x')).toHaveLength(2_000);
      expect(result).toContain('Use offset=2001 limit=2000');
      expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(
        DEFAULT_TOOL_OUTPUT_MAX_BYTES,
      );
    } finally {
      deleteTransientTextArtifact(artifactPath);
    }
  });

  it('pages near the end of a giant Unicode line without corrupting the cursor', async () => {
    const artifactPath = createTransientTextArtifact('🙂'.repeat(1_000_000));
    try {
      const result = await toolRead({
        path: artifactPath,
        offset: 1,
        limit: Number.MAX_SAFE_INTEGER,
        line_offset: 999_000,
      }, { backups: new Map() });

      expect(result).toContain('🙂'.repeat(1_000));
      expect(result).toContain('[End of file - 1 lines total]');
      expect(result).not.toContain('\uFFFD');
    } finally {
      deleteTransientTextArtifact(artifactPath);
    }
  });

  it('continues a long Unicode line exactly without claiming end-of-file early', async () => {
    const filePath = path.join(tempDir, 'long-line.txt');
    const content = '🙂'.repeat(4500);
    await fs.writeFile(filePath, content, 'utf-8');

    const first = await toolRead({ path: filePath, limit: 1 }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    const second = await toolRead({ path: filePath, offset: 1, limit: 1, line_offset: 2000 }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    const third = await toolRead({ path: filePath, offset: 1, limit: 1, line_offset: 4000 }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(typeof first).toBe('string');
    expect(typeof second).toBe('string');
    expect(typeof third).toBe('string');
    if (typeof first !== 'string' || typeof second !== 'string' || typeof third !== 'string') {
      throw new Error('Expected text read results');
    }

    const body = (value: string): string =>
      (value.split('\n\n')[0] ?? '').replace(/^\s*1\t/, '');

    expect(body(first) + body(second) + body(third)).toBe(content);
    expect(first).toContain(
      '[Line 1 is partial: showing Unicode characters 0-1999. Continue with offset=1 limit=1 line_offset=2000.]',
    );
    expect(second).toContain(
      '[Line 1 is partial: showing Unicode characters 2000-3999. Continue with offset=1 limit=1 line_offset=4000.]',
    );
    expect(first).not.toContain('[End of file');
    expect(second).not.toContain('[End of file');
    expect(third).toContain('[End of file - 1 lines total]');
    expect(first + second + third).not.toContain('\uFFFD');
  });

  it('documents line_offset as the exact continuation cursor for partial lines', () => {
    const definition = getToolDefinition('read');
    const schema = definition?.input_schema as {
      properties?: Record<string, { description?: string }>;
    } | undefined;

    expect(definition?.description).toContain('partial-line continuation marker');
    expect(schema?.properties?.line_offset?.description).toContain('Unicode character offset');
    expect(schema?.properties?.line_offset?.description).toContain('continuation marker');
  });

  it.each([
    ['UTF-8', 'x'.repeat(65_534) + '\n', '🙂e\u0301'],
    ['CRLF', 'x'.repeat(65_535) + '\r\n', '🙂e\u0301'],
  ])('preserves %s chunk boundaries and structured next cursors', async (_name, prefix, unit) => {
    const filePath = path.join(tempDir, 'boundary.txt');
    const content = unit.repeat(900);
    await fs.writeFile(filePath, prefix + content + '\r\nlast');
    const projection = vi.fn();
    const ctx = { backups: new Map(), toolCallId: 'read-page', recordToolResultProjection: projection };
    const first = await toolRead({ path: filePath, offset: 2, limit: 2 }, ctx);
    expect(first).not.toContain('\uFFFD');
    const firstData = projection.mock.calls[0]?.[1].data;
    expect(firstData.next).toEqual({ offset: 2, limit: 2, line_offset: 2000 });
    await toolRead({ path: filePath, ...firstData.next }, ctx);
    const secondData = projection.mock.calls[1]?.[1].data;
    expect(firstData.text + secondData.text).toBe(content + '\nlast');
    expect(secondData.next).toBeUndefined();
    expect(secondData.lineCount).toBe(2);
  });

  it.each([
    ['', '[End of file]'],
    ['\n', '     1\t\n\n[End of file - 1 lines total]'],
    ['a\r\nb\rc\n', '     1\ta\n     2\tb\n     3\tc\n\n[End of file - 3 lines total]'],
  ])('keeps small-file newline behavior for %j', async (content, expected) => {
    const filePath = path.join(tempDir, 'newlines.txt');
    await fs.writeFile(filePath, content);
    expect(await toolRead({ path: filePath }, { backups: new Map() })).toBe(expected);
  });

  it('cancels while skipping a giant line without returning or caching a page', async () => {
    const filePath = path.join(tempDir, 'cancel-during-read.txt');
    await fs.writeFile(filePath, 'x'.repeat(16 * 1024 * 1024) + '\ntail');
    const controller = new AbortController();
    const projection = vi.fn();
    const reading = toolRead({ path: filePath, offset: 2 }, {
      backups: new Map(), abortSignal: controller.signal,
      toolCallId: 'cancelled', recordToolResultProjection: projection,
    });
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
      expect(projection).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
    }
  });

  it('rejects binary files', async () => {
    const filePath = path.join(tempDir, 'binary.bin');
    await fs.writeFile(filePath, Buffer.from([0, 159, 146, 150]));

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Binary file not supported');
  });

  it('routes PDF files toward the read_pdf extension instead of generic binary fallback', async () => {
    const filePath = path.join(tempDir, 'sample.pdf');
    await fs.writeFile(filePath, Buffer.from('%PDF-1.4\n%binary-ish\n'));

    const result = await toolRead({ path: filePath }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('PDF files are not parsed by the built-in read tool');
    expect(result).toContain('read_pdf');
    expect(result).not.toContain('Binary file not supported');
  });

  // 2026-05-20 — claudecode parity: `read` on image extensions returns a
  // multimodal `tool_result` content array (text descriptor + image block)
  // instead of the legacy `[Tool Error] Binary file not supported`. This
  // is the fail-safe that lets the model actually see attached images
  // even when it routes through the read tool (e.g., post-compaction
  // when the original inline image block was stripped to a marker).
  describe('image branch (claudecode parity)', () => {
    it('returns a multimodal content array for PNG files (not a Binary-error string)', async () => {
      const filePath = path.join(tempDir, 'pic.png');
      await fs.writeFile(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAKAAAAAuCAYAAACvdRKFAAAAhUlEQVR4Ae3BQQGAMADEsO6kIG5q8QQy+mlynvt+JJKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiH7i7gKvb5ZrbwAAAABJRU5ErkJggg==', 'base64'));

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      // Critical: must NOT hit the binary-error fallback.
      expect(typeof result).not.toBe('string');
      expect(Array.isArray(result)).toBe(true);

      const items = result as ReadonlyArray<{ type: string; text?: string; path?: string; mediaType?: string }>;
      expect(items).toHaveLength(2);

      expect(items[0]).toMatchObject({ type: 'text' });
      expect(items[0].text).toContain('image/png');
      expect(items[0].text).toContain(filePath);

      expect(items[1]).toMatchObject({
        type: 'image',
        path: filePath,
        mediaType: 'image/png',
      });
    });

    it.each<[string, string]>([
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.gif', 'image/gif'],
      ['.webp', 'image/webp'],
    ])('handles %s as %s', async (ext, expectedMime) => {
      const filePath = path.join(tempDir, `pic${ext}`);
      await fs.copyFile(new URL(`../../../../tests/fixtures/images/valid.${ext === '.jpeg' ? 'jpg' : ext.slice(1)}`, import.meta.url), filePath);

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(Array.isArray(result)).toBe(true);
      const items = result as ReadonlyArray<{ type: string; mediaType?: string }>;
      expect(items[1]).toMatchObject({ type: 'image', mediaType: expectedMime });
    });

    it('returns an actionable text error for a JPEG with headers but no image frame', async () => {
      const filePath = path.join(tempDir, 'broken.jpg');
      await fs.copyFile(new URL('../../../../tests/fixtures/images/missing-sof.jpg', import.meta.url), filePath);
      const result = await toolRead({ path: filePath }, { backups: new Map(), executionCwd: tempDir });
      expect(typeof result).toBe('string');
      expect(result).toContain('cannot be decoded');
      expect(result).toContain('Re-extract');
    });

    it('returns a text error (not the multimodal array) for images over the 10 MB cap', async () => {
      const filePath = path.join(tempDir, 'huge.png');
      // 11 MB > READ_IMAGE_MAX_BYTES (10 MB)
      await fs.writeFile(filePath, Buffer.alloc(11 * 1024 * 1024, 0xff));

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(typeof result).toBe('string');
      expect(result).toContain('Image too large to inline');
      expect(result).toContain('Resize before reading');
    });
  });

  // FEATURE_125 v0.7.41 — Read tool records the on-disk content hash
  // when `ctx.contentHashCache` is wired, so a subsequent
  // Edit/Write tool's `checkStale` can detect cross-session races.
  describe('FEATURE_125 — contentHashCache integration', () => {
    it('records the content hash after a successful read when ctx.contentHashCache is wired', async () => {
      const { createContentHashCache } = await import('../multi-instance/content-hash-cache.js');
      const cache = createContentHashCache();
      const filePath = path.join(tempDir, 'hashed.txt');
      await fs.writeFile(filePath, 'hello world\n', 'utf-8');

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
        contentHashCache: cache,
      });

      // Tool output is unchanged by the hash recording.
      expect(result).toContain('hello world');
      // After read, the cache holds the hash → checkStale returns 'fresh'.
      expect(cache.checkStale(filePath).kind).toBe('fresh');

      // A peer modifies the file → cache flips to 'stale'.
      await fs.writeFile(filePath, 'hello world v2\n', 'utf-8');
      expect(cache.checkStale(filePath).kind).toBe('stale');
    });

    it('is a no-op when ctx.contentHashCache is absent (no regression on solo mode)', async () => {
      const filePath = path.join(tempDir, 'unhashed.txt');
      await fs.writeFile(filePath, 'content', 'utf-8');

      // No contentHashCache on ctx → tool path proceeds unchanged.
      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
      });
      expect(result).toContain('content');
    });

    it('swallows hash-recording errors so a transient I/O failure never breaks the tool', async () => {
      const filePath = path.join(tempDir, 'ok.txt');
      await fs.writeFile(filePath, 'good', 'utf-8');

      // Inject a cache whose recordRead throws — the tool must still return.
      const fakeCache = {
        recordRead: () => {
          throw new Error('synthetic recordRead failure');
        },
        checkStale: () => ({ kind: 'no-read', stale: false }) as const,
        recordWrite: () => undefined,
        forget: () => undefined,
        getReadAt: () => undefined,
        getRecordedHash: () => undefined,
      };

      const result = await toolRead({ path: filePath }, {
        backups: new Map(),
        executionCwd: tempDir,
        contentHashCache: fakeCache,
      });
      expect(result).toContain('good');
    });

    it('skips recording for files above READ_HASH_MAX_BYTES (5 MB)', async () => {
      const { createContentHashCache } = await import('../multi-instance/content-hash-cache.js');
      const cache = createContentHashCache();
      const filePath = path.join(tempDir, 'huge.txt');
      // 6 MB of one-char lines.
      const bigContent = ('x\n'.repeat(3_000_000));
      await fs.writeFile(filePath, bigContent, 'utf-8');

      await toolRead({ path: filePath, limit: 10 }, {
        backups: new Map(),
        executionCwd: tempDir,
        contentHashCache: cache,
      });

      // File > 5 MB threshold → recordRead skipped → no hash captured.
      expect(cache.getRecordedHash(filePath)).toBeUndefined();
      expect(cache.checkStale(filePath).kind).toBe('no-read');
    });
  });
});
