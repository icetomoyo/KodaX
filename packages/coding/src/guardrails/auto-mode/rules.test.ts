import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAutoRules,
  parseAutoRules,
  computeRulesFingerprint,
  trustProjectRules,
  readTrustState,
} from './rules.js';

let tmp: string;
let userKodaxDir: string;
let projectRoot: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'kodax-rules-'));
  userKodaxDir = join(tmp, 'user', '.kodax');
  projectRoot = join(tmp, 'project');
  await mkdir(userKodaxDir, { recursive: true });
  await mkdir(join(projectRoot, '.kodax'), { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('parseAutoRules', () => {
  it('parses a minimal valid JSONC file with comments stripped', () => {
    const src = `{
      // top-line comment
      "allow": ["Running tests"],
      "soft_deny": ["Uploading to evil.com"], /* inline block */
      "environment": ["Node monorepo"]
    }`;
    const result = parseAutoRules(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.allow).toEqual(['Running tests']);
      expect(result.rules.soft_deny).toEqual(['Uploading to evil.com']);
      expect(result.rules.environment).toEqual(['Node monorepo']);
    }
  });

  it('treats missing arrays as empty (all fields optional)', () => {
    const result = parseAutoRules('{}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.allow).toEqual([]);
      expect(result.rules.soft_deny).toEqual([]);
      expect(result.rules.environment).toEqual([]);
    }
  });

  it('rejects non-object root', () => {
    const result = parseAutoRules('[]');
    expect(result.ok).toBe(false);
  });

  it('rejects entries that are not strings', () => {
    const result = parseAutoRules('{"allow": [123, "ok"]}');
    expect(result.ok).toBe(false);
  });

  it('rejects malformed JSONC (unclosed brace)', () => {
    const result = parseAutoRules('{"allow": ["x"]');
    expect(result.ok).toBe(false);
  });

  it('strips // line comments and /* block */ comments', () => {
    const src = `// top
    {
      /* multi
         line */
      "allow": [
        "first", // trailing
        "second"
      ]
    }`;
    const result = parseAutoRules(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.allow).toEqual(['first', 'second']);
    }
  });

  it('does not strip "//" inside string literals', () => {
    const src = `{ "allow": ["https://example.com/path"] }`;
    const result = parseAutoRules(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules.allow).toEqual(['https://example.com/path']);
    }
  });
});

describe('computeRulesFingerprint', () => {
  it('returns a 64-char hex sha256', () => {
    const fp = computeRulesFingerprint('hello');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same content → same fingerprint', () => {
    expect(computeRulesFingerprint('abc')).toBe(computeRulesFingerprint('abc'));
  });

  it('differs on any content change', () => {
    expect(computeRulesFingerprint('abc')).not.toBe(computeRulesFingerprint('abcd'));
  });
});

describe('loadAutoRules — three-layer merge', () => {
  it('returns empty rules when no files exist', async () => {
    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual([]);
    expect(result.merged.soft_deny).toEqual([]);
    expect(result.merged.environment).toEqual([]);
    expect(result.sources).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('loads the user-level file unconditionally (always trusted)', async () => {
    await writeFile(
      join(userKodaxDir, 'auto-rules.jsonc'),
      JSON.stringify({ allow: ['user-rule'] }),
    );
    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual(['user-rule']);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.origin).toBe('user');
  });

  it('loads the project-local file unconditionally (always trusted, gitignored)', async () => {
    await writeFile(
      join(projectRoot, '.kodax', 'auto-rules.local.jsonc'),
      JSON.stringify({ allow: ['local-rule'] }),
    );
    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual(['local-rule']);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.origin).toBe('local');
  });

  it('skips the project-shared file when no trust entry exists (first-checkout opt-in required)', async () => {
    await writeFile(
      join(projectRoot, '.kodax', 'auto-rules.jsonc'),
      JSON.stringify({ allow: ['untrusted-rule'] }),
    );
    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual([]);
    expect(result.sources).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.origin).toBe('project');
    expect(result.skipped[0]!.reason).toBe('untrusted');
  });

  it('loads the project-shared file when its fingerprint is trusted', async () => {
    const projectRulesPath = join(projectRoot, '.kodax', 'auto-rules.jsonc');
    const content = JSON.stringify({ allow: ['shared-rule'] });
    await writeFile(projectRulesPath, content);
    const fp = computeRulesFingerprint(content);
    await trustProjectRules(projectRulesPath, fp, { userKodaxDir });

    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual(['shared-rule']);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.origin).toBe('project');
  });

  it('skips the project-shared file when fingerprint changed since last trust', async () => {
    const projectRulesPath = join(projectRoot, '.kodax', 'auto-rules.jsonc');
    const oldContent = JSON.stringify({ allow: ['old-rule'] });
    await writeFile(projectRulesPath, oldContent);
    await trustProjectRules(projectRulesPath, computeRulesFingerprint(oldContent), { userKodaxDir });

    // Now the file changes
    const newContent = JSON.stringify({ allow: ['injected-evil-rule'] });
    await writeFile(projectRulesPath, newContent);

    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual([]);
    expect(result.sources).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('fingerprint-changed');
  });

  it('merges all three layers with later layers appended after earlier (user → project → local)', async () => {
    await writeFile(
      join(userKodaxDir, 'auto-rules.jsonc'),
      JSON.stringify({ allow: ['user-A'], environment: ['user-env'] }),
    );
    const projectRulesPath = join(projectRoot, '.kodax', 'auto-rules.jsonc');
    const projectContent = JSON.stringify({ allow: ['project-A'], soft_deny: ['project-deny'] });
    await writeFile(projectRulesPath, projectContent);
    await trustProjectRules(projectRulesPath, computeRulesFingerprint(projectContent), { userKodaxDir });
    await writeFile(
      join(projectRoot, '.kodax', 'auto-rules.local.jsonc'),
      JSON.stringify({ allow: ['local-A'] }),
    );

    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual(['user-A', 'project-A', 'local-A']);
    expect(result.merged.environment).toEqual(['user-env']);
    expect(result.merged.soft_deny).toEqual(['project-deny']);
    expect(result.sources.map((s) => s.origin)).toEqual(['user', 'project', 'local']);
  });

  it('deduplicates identical rule strings across layers (later layer wins on dedup)', async () => {
    await writeFile(
      join(userKodaxDir, 'auto-rules.jsonc'),
      JSON.stringify({ allow: ['shared-rule', 'user-only'] }),
    );
    await writeFile(
      join(projectRoot, '.kodax', 'auto-rules.local.jsonc'),
      JSON.stringify({ allow: ['shared-rule', 'local-only'] }),
    );

    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual(['user-only', 'shared-rule', 'local-only']);
  });

  it('treats a malformed file as a load error, not a silent empty', async () => {
    await writeFile(join(userKodaxDir, 'auto-rules.jsonc'), '{ broken json');
    const result = await loadAutoRules({ userKodaxDir, projectRoot });
    expect(result.merged.allow).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toContain('auto-rules.jsonc');
  });
});

describe('trustProjectRules + readTrustState', () => {
  it('persists fingerprint to ~/.kodax/trusted-project-rules.json', async () => {
    const path = '/some/project/.kodax/auto-rules.jsonc';
    const fp = 'a'.repeat(64);
    await trustProjectRules(path, fp, { userKodaxDir });
    const state = await readTrustState(userKodaxDir);
    expect(state.trusted[path]).toBe(fp);
  });

  it('preserves prior trust entries when adding a new one', async () => {
    const pathA = '/proj/A/.kodax/auto-rules.jsonc';
    const pathB = '/proj/B/.kodax/auto-rules.jsonc';
    await trustProjectRules(pathA, 'a'.repeat(64), { userKodaxDir });
    await trustProjectRules(pathB, 'b'.repeat(64), { userKodaxDir });
    const state = await readTrustState(userKodaxDir);
    expect(Object.keys(state.trusted).sort()).toEqual([pathA, pathB].sort());
  });

  it('overwrites the entry for the same path on re-trust', async () => {
    const path = '/proj/.kodax/auto-rules.jsonc';
    await trustProjectRules(path, 'a'.repeat(64), { userKodaxDir });
    await trustProjectRules(path, 'b'.repeat(64), { userKodaxDir });
    const state = await readTrustState(userKodaxDir);
    expect(state.trusted[path]).toBe('b'.repeat(64));
  });

  it('returns empty trust state when no file exists', async () => {
    const state = await readTrustState(userKodaxDir);
    expect(state.trusted).toEqual({});
  });

  it('returns empty trust state on malformed file (fail-safe untrusted)', async () => {
    const trustFile = join(userKodaxDir, 'trusted-project-rules.json');
    await writeFile(trustFile, '{ malformed');
    const state = await readTrustState(userKodaxDir);
    expect(state.trusted).toEqual({});
  });

  it('produces a trust file with stable shape', async () => {
    await trustProjectRules('/x/.kodax/auto-rules.jsonc', 'c'.repeat(64), { userKodaxDir });
    const raw = await readFile(join(userKodaxDir, 'trusted-project-rules.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ trusted: { '/x/.kodax/auto-rules.jsonc': 'c'.repeat(64) } });
  });
});
