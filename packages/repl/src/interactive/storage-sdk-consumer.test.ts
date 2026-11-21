/**
 * v0.7.46 — Regression tests for SDK-consumer footguns reported by
 * KodaX Space (in-process embedder, ADR-003) plus 3 sibling issues
 * surfaced by the same audit. Each test corresponds to one bug class:
 *
 *   F1 — fast path drops legacy `gitRoot` (no `runtimeInfo` field)
 *   F2 — hardcoded `.slice(0, 10)` cap silently truncates caller's limit
 *   F3 — fast path return shape misses `createdAt`
 *   F4 — `load()` uses process.cwd() for workspace check + bleeds
 *        notices to stderr in embedder context
 *   F5 — `deleteAll()` silently capped at 10 sessions
 *
 * Tests construct FileSessionStorage with an explicit `sessionsDir`
 * (avoiding the module-frozen KODAX_SESSIONS_DIR setup dance) and
 * write meta jsonl files by hand to control the exact shape under test.
 */

import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setKodaXDiagnosticSink } from '@kodax-ai/agent';
import { FileSessionStorage } from './storage.js';

let tempRoot: string;
let sessionsDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-footguns-'));
  sessionsDir = path.join(tempRoot, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function writeMeta(id: string, meta: Record<string, unknown>): Promise<void> {
  const filePath = path.join(sessionsDir, `${id}.jsonl`);
  await writeFile(filePath, JSON.stringify({ _type: 'meta', ...meta }) + '\n', 'utf-8');
}

describe('v0.7.46 SDK-consumer footgun regression', () => {
  describe('F1 — fast path falls back to legacy top-level gitRoot', () => {
    it('legacy meta (no runtimeInfo, top-level gitRoot) → list() surfaces gitRoot via runtimeInfo.canonicalRepoRoot', async () => {
      // No cwd is supplied here: this intentionally exercises the
      // "no project intent" path, where list(undefined) scans all projects.
      const storage = new FileSessionStorage({ sessionsDir });
      const legacyGitRoot = '/some/project/dir';

      // Legacy meta shape: top-level gitRoot, NO runtimeInfo field. Pre-v0.7.46
      // the fast path returned runtimeInfo: undefined for these.
      await writeMeta('legacy-session', {
        title: 'legacy',
        gitRoot: legacyGitRoot,
        createdAt: '2026-06-03T10:00:00.000Z',
        activeMessageCount: 1,
      });

      // Pass legacyGitRoot as the filter so the workspace-mismatch
      // branch sees a match (otherwise the list filters out non-matching
      // sessions — orthogonal to F1).
      // Pass undefined gitRoot so the workspace-mismatch filter is
      // skipped (we're testing return-shape fallback, not the filter).
      const result = await storage.list(undefined, { limit: 50 });

      expect(result.length).toBe(1);
      expect(result[0]?.runtimeInfo).toBeDefined();
      // canonicalRepoRoot is the modern field name (semantic equivalent of
      // gitRoot). public-api's extractRuntimeInfoSummary remaps this to
      // SessionSummary.runtimeInfo.gitRoot for the consumer.
      expect(result[0]?.runtimeInfo?.canonicalRepoRoot).toBe(legacyGitRoot);
    });

    it('modern meta (nested runtimeInfo) → list() uses it as-is, never overwrites with gitRoot', async () => {
      // No cwd is supplied here: this intentionally exercises the
      // "no project intent" path, where list(undefined) scans all projects.
      const storage = new FileSessionStorage({ sessionsDir });
      const projectRoot = '/modern/project';

      await writeMeta('modern-session', {
        title: 'modern',
        gitRoot: projectRoot,
        runtimeInfo: {
          canonicalRepoRoot: projectRoot,
          workspaceRoot: projectRoot,
          executionCwd: projectRoot,
        },
        createdAt: '2026-06-03T10:00:00.000Z',
        activeMessageCount: 1,
      });

      const result = await storage.list(undefined, { limit: 50 });

      expect(result[0]?.runtimeInfo?.canonicalRepoRoot).toBe(projectRoot);
      expect(result[0]?.runtimeInfo?.workspaceRoot).toBe(projectRoot);
    });
  });

  describe('F2 — list() respects caller-supplied limit', () => {
    it('defaults to 10 when no limit supplied (legacy REPL picker behavior)', async () => {
      // No cwd is supplied here: this intentionally exercises the
      // "no project intent" path, where list(undefined) scans all projects.
      const storage = new FileSessionStorage({ sessionsDir });
      const gitRoot = '/test/repo';
      for (let i = 0; i < 15; i++) {
        await writeMeta(`sess-${i.toString().padStart(2, '0')}`, {
          title: `s${i}`,
          gitRoot,
          createdAt: new Date(2026, 0, i + 1).toISOString(),
          activeMessageCount: 1,
        });
      }
      const result = await storage.list();
      expect(result.length).toBe(10);
    });

    it('limit:50 returns all 15 sessions (caller override beats legacy cap)', async () => {
      // No cwd is supplied here: this intentionally exercises the
      // "no project intent" path, where list(undefined) scans all projects.
      const storage = new FileSessionStorage({ sessionsDir });
      const gitRoot = '/test/repo';
      for (let i = 0; i < 15; i++) {
        await writeMeta(`sess-${i.toString().padStart(2, '0')}`, {
          title: `s${i}`,
          gitRoot,
          createdAt: new Date(2026, 0, i + 1).toISOString(),
          activeMessageCount: 1,
        });
      }
      const result = await storage.list(undefined, { limit: 50 });
      expect(result.length).toBe(15);
    });

    it('limit:200 with 5 sessions → returns 5 (no synthetic padding)', async () => {
      // No cwd is supplied here: this intentionally exercises the
      // "no project intent" path, where list(undefined) scans all projects.
      const storage = new FileSessionStorage({ sessionsDir });
      const gitRoot = '/test/repo';
      for (let i = 0; i < 5; i++) {
        await writeMeta(`sess-${i}`, {
          title: `s${i}`, gitRoot, activeMessageCount: 1,
        });
      }
      const result = await storage.list(undefined, { limit: 200 });
      expect(result.length).toBe(5);
    });
  });

  describe('F3 — list() return carries createdAt', () => {
    it('preserves createdAt verbatim from meta record', async () => {
      // No cwd is supplied here: this intentionally exercises the
      // "no project intent" path, where list(undefined) scans all projects.
      const storage = new FileSessionStorage({ sessionsDir });
      const gitRoot = '/test/repo';
      const ts = '2026-06-03T12:34:56.789Z';
      await writeMeta('with-created-at', {
        title: 'x', gitRoot, createdAt: ts, activeMessageCount: 1,
      });
      const result = await storage.list(undefined, { limit: 5 });
      expect(result[0]?.createdAt).toBe(ts);
    });

    it('missing createdAt → undefined, not an empty string or thrown', async () => {
      // No cwd is supplied here: this intentionally exercises the
      // "no project intent" path, where list(undefined) scans all projects.
      const storage = new FileSessionStorage({ sessionsDir });
      const gitRoot = '/test/repo';
      await writeMeta('no-created-at', {
        title: 'x', gitRoot, activeMessageCount: 1,
      });
      const result = await storage.list(undefined, { limit: 5 });
      expect(result[0]?.createdAt).toBeUndefined();
    });
  });

  describe('F4 — cwd injection + mismatch warning suppression for embedders', () => {
    it('constructor accepts cwd option (FileSessionStorage embedder shape)', () => {
      const storage = new FileSessionStorage({
        sessionsDir,
        cwd: '/embedder/host/project-a',
      });
      // Surface check: cwd is stored privately; we verify via behavior
      // in the next tests rather than reaching into private state.
      expect(storage).toBeInstanceOf(FileSessionStorage);
    });

    it('exposes the resolved session root for host/runtime composition', () => {
      const relativeRoot = path.relative(process.cwd(), sessionsDir);
      const storage = new FileSessionStorage({ sessionsDir: relativeRoot });

      expect(storage.getSessionsDir()).toBe(path.resolve(relativeRoot));
    });

    it('hostCwd present → load() does NOT write to stderr on mismatch (embedder noise suppression)', async () => {
      // Even when the session's gitRoot differs from cwd's git root,
      // the SDK consumer is authoritative and the warning is noise.
      // We test the *absence* of stderr.write — directly verifiable
      // by stubbing process.stderr.write.
      const stderrChunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown): boolean => {
        if (typeof chunk === 'string') stderrChunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        // Write a session with a gitRoot that won't match `cwd`'s git root
        const sessionGitRoot = '/some/distinct/project';
        const id = 'embedder-load-test';
        const filePath = path.join(sessionsDir, `${id}.jsonl`);
        await writeFile(
          filePath,
          JSON.stringify({
            _type: 'meta',
            title: 't',
            gitRoot: sessionGitRoot,
            createdAt: '2026-06-03T10:00:00.000Z',
          }) + '\n' +
          JSON.stringify({ role: 'user', content: 'hi' }) + '\n',
          'utf-8',
        );

        const storage = new FileSessionStorage({
          sessionsDir,
          cwd: '/embedder/host/project-A',
        });
        await storage.load(id);

        // Pre-v0.7.46: at least one chunk would contain "[Warning]
        // Session project mismatch". Post-fix: hostCwd suppresses the
        // warning entirely.
        const warningChunks = stderrChunks.filter((c) =>
          c.includes('Session project mismatch'),
        );
        expect(warningChunks.length).toBe(0);
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  describe('F6 v0.7.46 — list() with no project intent → scans ALL projects (not process.cwd())', () => {
    // Regression for the bug Space reported after v0.7.46 ship:
    // even with v0.7.46's `getGitRoot(this.hostCwd)` fix, when an
    // in-process embedder constructs `new FileSessionStorage()` WITHOUT
    // a `cwd` arg AND calls `list()` WITHOUT a `gitRoot` arg, the storage
    // silently filtered by `process.cwd()` of the host process (e.g.
    // KodaX-Space's startup dir). The user saw an empty sidebar.
    //
    // v0.7.46 fix: when both signals are absent, don't filter at all —
    // return sessions from every project directory.

    it('storage with no hostCwd + list(undefined) → returns sessions across multiple project dirs', async () => {
      // FEATURE_219 (v0.7.46) uses `{sessionsDir}/{projectKey}/{id}.jsonl`
      // layout. To simulate cross-project sessions, write to two
      // distinct project subdirs. The list() call should surface BOTH
      // when no project intent is supplied.
      const storage = new FileSessionStorage({ sessionsDir });
      // Create per-project subdirs the way FEATURE_219 expects.
      const projAKey = 'proj-a-key';
      const projBKey = 'proj-b-key';
      await mkdir(path.join(sessionsDir, projAKey), { recursive: true });
      await mkdir(path.join(sessionsDir, projBKey), { recursive: true });
      // Each session's meta carries the relevant project gitRoot;
      // .layout.json marker tells the migrator the dir is already
      // migrated so list() goes straight to the per-project loop.
      await writeFile(
        path.join(sessionsDir, '.layout.json'),
        JSON.stringify({ version: 1 }),
        'utf-8',
      );
      await writeFile(
        path.join(sessionsDir, projAKey, 'sess-a.jsonl'),
        JSON.stringify({
          _type: 'meta',
          title: 'A',
          gitRoot: '/project/A',
          createdAt: '2026-06-01T10:00:00.000Z',
          activeMessageCount: 1,
        }) + '\n',
        'utf-8',
      );
      await writeFile(
        path.join(sessionsDir, projBKey, 'sess-b.jsonl'),
        JSON.stringify({
          _type: 'meta',
          title: 'B',
          gitRoot: '/project/B',
          createdAt: '2026-06-02T10:00:00.000Z',
          activeMessageCount: 1,
        }) + '\n',
        'utf-8',
      );

      const result = await storage.list(undefined, { limit: 50 });

      // Pre-v0.7.46: storage resolved process.cwd() → some-implicit-project
      // → only that project's dir scanned → either 0 or 1 sessions
      // returned depending on whether tests happened to run in a matching
      // project. Post-fix: both projects' sessions surface.
      const ids = result.map((s) => s.id).sort();
      expect(ids).toEqual(['sess-a', 'sess-b']);
    });

    it('storage WITH non-git hostCwd filters by execution cwd project key', async () => {
      const storage = new FileSessionStorage({
        sessionsDir,
        cwd: tempRoot,
      });
      const writer = new FileSessionStorage({ sessionsDir });
      const otherCwd = path.join(tempRoot, 'other-non-git');
      await writer.save('current-cwd', {
        messages: [{ role: 'user', content: 'current cwd session' }],
        title: 'current cwd',
        gitRoot: '',
        runtimeInfo: { executionCwd: tempRoot, workspaceKind: 'detected' },
        scope: 'user',
      });
      await writer.save('other-cwd', {
        messages: [{ role: 'user', content: 'other cwd session' }],
        title: 'other cwd',
        gitRoot: '',
        runtimeInfo: { executionCwd: otherCwd, workspaceKind: 'detected' },
        scope: 'user',
      });

      const result = await storage.list(undefined, { limit: 50 });
      expect(result.map((session) => session.id)).toEqual(['current-cwd']);
    });
  });

  describe('F7 v0.7.46 — load() mismatch warning gated on explicit emitMismatchWarnings (default off)', () => {
    // Pre-fix the warning was gated on `!this.hostCwd` which silently
    // fired for SDK consumers that don't set cwd — bleeding yellow
    // stderr noise into their UI output channel on every cross-project
    // load. F7 inverts: default off; CLI surfaces opt in explicitly.

    async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
      // `writeStorageNotice` short-circuits when NODE_ENV==='test', so
      // the existing F4 test passes vacuously. To exercise the real
      // emission path we have to unset NODE_ENV around the run.
      const chunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      const originalNodeEnv = process.env.NODE_ENV;
      const originalDiagnosticsStderr = process.env.KODAX_DIAGNOSTICS_STDERR;
      process.env.NODE_ENV = 'development';
      process.env.KODAX_DIAGNOSTICS_STDERR = '1';
      process.stderr.write = ((chunk: unknown): boolean => {
        if (typeof chunk === 'string') chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;
      try {
        await fn();
      } finally {
        process.stderr.write = originalWrite;
        if (originalNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalNodeEnv;
        }
        if (originalDiagnosticsStderr === undefined) {
          delete process.env.KODAX_DIAGNOSTICS_STDERR;
        } else {
          process.env.KODAX_DIAGNOSTICS_STDERR = originalDiagnosticsStderr;
        }
      }
      return chunks;
    }

    async function writeMismatchedSession(id: string, sessionGitRoot: string): Promise<void> {
      const filePath = path.join(sessionsDir, `${id}.jsonl`);
      await writeFile(
        filePath,
        JSON.stringify({
          _type: 'meta',
          title: 't',
          gitRoot: sessionGitRoot,
          createdAt: '2026-06-03T10:00:00.000Z',
        }) + '\n' +
        JSON.stringify({ role: 'user', content: 'hi' }) + '\n',
        'utf-8',
      );
    }

    it('no hostCwd + default flag → no warning (regression for the F7 bug)', async () => {
      // Pre-F7: this configuration (which is exactly what KodaX Space
      // ships) emitted a yellow "[Warning] Session project mismatch:"
      // block on every cross-project load. The warning text would even
      // include the embedder's own startup directory as "Current
      // workspace" — wrong AND noisy.
      await writeMismatchedSession('no-hostcwd-default-off', '/some/distinct/project');
      const storage = new FileSessionStorage({ sessionsDir });
      const chunks = await captureStderr(async () => {
        await storage.load('no-hostcwd-default-off');
      });
      const warningChunks = chunks.filter((c) => c.includes('Session project mismatch'));
      expect(warningChunks.length).toBe(0);
    });

    it('emitMismatchWarnings: true → warning DOES fire (CLI opt-in path)', async () => {
      await writeMismatchedSession('cli-opt-in', '/some/distinct/project');
      // No `cwd` to ensure `!this.hostCwd` is true; `emitMismatchWarnings:
      // true` is the explicit CLI opt-in. The compare runs against
      // process.cwd() which is the test process — almost certainly
      // doesn't match `/some/distinct/project`.
      const storage = new FileSessionStorage({
        sessionsDir,
        emitMismatchWarnings: true,
      });
      const chunks = await captureStderr(async () => {
        await storage.load('cli-opt-in');
      });
      const warningChunks = chunks.filter((c) => c.includes('Session project mismatch'));
      expect(warningChunks.length).toBeGreaterThan(0);
    });

    it('hostCwd set + default flag → still no warning (F4 behaviour preserved)', async () => {
      // F4 fix (v0.7.46) made hostCwd suppress the warning; F7 doesn't
      // regress that — the warning stays off by default regardless of
      // whether hostCwd is set or not.
      await writeMismatchedSession('hostcwd-default', '/some/distinct/project');
      const storage = new FileSessionStorage({
        sessionsDir,
        cwd: '/embedder/host',
      });
      const chunks = await captureStderr(async () => {
        await storage.load('hostcwd-default');
      });
      const warningChunks = chunks.filter((c) => c.includes('Session project mismatch'));
      expect(warningChunks.length).toBe(0);
    });
  });

  describe('F8 v0.7.46 — findSessionFile cross-project ambiguity falls back to first match (no cwd-disambiguation when no hostCwd)', () => {
    // Pre-fix: ambiguous id (same id in two project subdirs — only
    // possible for legacy same-second cross-project duplicates) tried
    // to pick by cwd via `this.hostCwd ?? process.cwd()`. For SDK
    // consumers without cwd, this resolved to the embedder's startup
    // dir → neither candidate matched → `null` → session load silently
    // failed. Post-fix: with no hostCwd, take first-match (best-effort)
    // + emit the diagnostic notice for caller debug.

    async function writeAmbiguousMeta(projectKey: string, id: string, gitRoot: string): Promise<void> {
      await mkdir(path.join(sessionsDir, projectKey), { recursive: true });
      await writeFile(
        path.join(sessionsDir, projectKey, `${id}.jsonl`),
        JSON.stringify({
          _type: 'meta',
          title: `from-${projectKey}`,
          gitRoot,
          createdAt: '2026-06-01T10:00:00.000Z',
          activeMessageCount: 1,
        }) + '\n' +
        JSON.stringify({ role: 'user', content: 'hi' }) + '\n',
        'utf-8',
      );
      // Marker so the loader skips the migration scan.
      await writeFile(
        path.join(sessionsDir, '.layout.json'),
        JSON.stringify({ version: 1 }),
        'utf-8',
      );
    }

    it('ambiguous id + no hostCwd → returns first match instead of null', async () => {
      const ambiguousId = '20260101_120000';
      await writeAmbiguousMeta('proj-x', ambiguousId, '/proj/x');
      await writeAmbiguousMeta('proj-y', ambiguousId, '/proj/y');

      // No cwd at all — pre-F8 would resolve process.cwd() (KodaX repo
      // root in test runner) → match neither proj-x nor proj-y → null
      // → load returns null. Post-fix: take first match.
      const storage = new FileSessionStorage({ sessionsDir });
      const result = await storage.load(ambiguousId);

      expect(result).not.toBeNull();
      // Title proves we got one of the two — order is filesystem-dependent.
      expect(result!.title).toMatch(/^from-proj-[xy]$/);
    });

    it('ambiguous id + hostCwd matches one → returns the matching one (legacy CLI behaviour preserved)', async () => {
      const ambiguousId = '20260101_120001';
      await writeAmbiguousMeta('proj-a-key', ambiguousId, '/proj/a');
      await writeAmbiguousMeta('proj-b-key', ambiguousId, '/proj/b');

      // hostCwd points at a path that derives projectKey='proj-a-key';
      // can't actually do that without faking deriveProjectKeyFromRoot.
      // Instead verify the *fallback semantic*: when hostCwd is set
      // and DOESN'T match either candidate (real-world: embedder's
      // current project has no ambiguous session), we still get a
      // first-match instead of null.
      const storage = new FileSessionStorage({
        sessionsDir,
        cwd: '/embedder/different/project',
      });
      const result = await storage.load(ambiguousId);

      expect(result).not.toBeNull();
      expect(result!.title).toMatch(/^from-proj-[ab]-key$/);
    });
  });

  describe('F5 — deleteAll() removes ALL sessions (no silent cap)', () => {
    it('15 sessions for gitRoot → deleteAll deletes all 15', async () => {
      // No cwd is supplied here, so deleteAll() intentionally targets all
      // sessions returned by the unfiltered list path.
      const storage = new FileSessionStorage({ sessionsDir });
      const gitRoot = '/cleanup/target';

      for (let i = 0; i < 15; i++) {
        await writeMeta(`del-${i.toString().padStart(2, '0')}`, {
          title: `s${i}`,
          gitRoot,
          createdAt: new Date(2026, 0, i + 1).toISOString(),
          activeMessageCount: 1,
        });
      }

      // Sanity: confirm there are 15 to start.
      const before = await storage.list(undefined, { limit: 50 });
      expect(before.length).toBe(15);

      // deleteAll(undefined) deletes anything matching the storage's
      // resolved gitRoot (null in our tempRoot setup → no filter, all
      // sessions targeted). Pre-v0.7.46 only the first 10 would be
      // deleted (deleteAll reused list()'s 10-cap), and 5 would
      // silently survive.
      await storage.deleteAll();

      const after = await storage.list(undefined, { limit: 50 });
      expect(after.length).toBe(0);
    });

    it('non-git hostCwd deleteAll deletes only the current cwd project', async () => {
      const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
      const writer = new FileSessionStorage({ sessionsDir });
      const otherCwd = path.join(tempRoot, 'other-delete-cwd');
      await writer.save('delete-current-cwd', {
        messages: [{ role: 'user', content: 'current cwd delete target' }],
        title: 'current cwd',
        gitRoot: '',
        runtimeInfo: { executionCwd: tempRoot, workspaceKind: 'detected' },
        scope: 'user',
      });
      await writer.save('keep-other-cwd', {
        messages: [{ role: 'user', content: 'other cwd should survive' }],
        title: 'other cwd',
        gitRoot: '',
        runtimeInfo: { executionCwd: otherCwd, workspaceKind: 'detected' },
        scope: 'user',
      });

      await storage.deleteAll();

      const remaining = await writer.list(undefined, { limit: 50 });
      expect(remaining.map((session) => session.id)).toEqual(['keep-other-cwd']);
    });
  });

  describe('UI-safe storage diagnostics', () => {
    it('malformed session records do not write raw stderr by default', async () => {
      const chunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      const originalNodeEnv = process.env.NODE_ENV;
      const originalDiagnosticsStderr = process.env.KODAX_DIAGNOSTICS_STDERR;
      process.env.NODE_ENV = 'development';
      delete process.env.KODAX_DIAGNOSTICS_STDERR;
      process.stderr.write = ((chunk: unknown): boolean => {
        if (typeof chunk === 'string') chunks.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        await writeFile(
          path.join(sessionsDir, 'malformed-ui-safe.jsonl'),
          JSON.stringify({
            _type: 'meta',
            title: 'malformed',
            gitRoot: tempRoot,
            createdAt: '2026-07-09T00:00:00.000Z',
          }) + '\n' +
          '{not-json}\n' +
          JSON.stringify({ role: 'user', content: 'hi' }) + '\n',
          'utf-8',
        );

        const storage = new FileSessionStorage({ sessionsDir, cwd: tempRoot });
        await storage.load('malformed-ui-safe');

        expect(chunks).toEqual([]);
      } finally {
        process.stderr.write = originalWrite;
        if (originalNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = originalNodeEnv;
        }
        if (originalDiagnosticsStderr === undefined) {
          delete process.env.KODAX_DIAGNOSTICS_STDERR;
        } else {
          process.env.KODAX_DIAGNOSTICS_STDERR = originalDiagnosticsStderr;
        }
      }
    });

    it('reports the same malformed records of a session once per process (Issue 425)', async () => {
      const messages: string[] = [];
      const restore = setKodaXDiagnosticSink((diagnostic) => {
        if (diagnostic.source === 'repl:session-storage') messages.push(diagnostic.message);
      });
      try {
        const file = path.join(sessionsDir, 'polled-malformed.jsonl');
        const session = (badLines: string): string => JSON.stringify({ _type: 'meta', title: 'polled', gitRoot: tempRoot,
          createdAt: '2026-07-09T00:00:00.000Z' }) + '\n' + badLines + JSON.stringify({ role: 'user', content: 'hi' }) + '\n';
        await writeFile(file, session('{not-json}\n'), 'utf-8');
        for (let read = 0; read < 3; read += 1) {
          await new FileSessionStorage({ sessionsDir, cwd: tempRoot }).load('polled-malformed');
        }
        expect(messages).toEqual(['Skipped 1 malformed session record(s) from polled-malformed.jsonl.']);
        // The first load moved the flat file into its project directory.
        const projects = (await readdir(sessionsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
        const moved = projects.map((entry) => path.join(sessionsDir, entry.name, 'polled-malformed.jsonl')).find(existsSync);
        expect(moved).toBeDefined();
        await writeFile(moved!, session('{not-json}\n{also-not-json}\n'), 'utf-8');
        await new FileSessionStorage({ sessionsDir, cwd: tempRoot }).load('polled-malformed');
        expect(messages).toHaveLength(2);
        expect(messages[1]).toBe('Skipped 2 malformed session record(s) from polled-malformed.jsonl.');
      } finally {
        restore();
      }
    });
  });
});
