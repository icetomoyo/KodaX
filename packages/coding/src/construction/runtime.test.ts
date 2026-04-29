import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  configureRuntime,
  stage,
  testArtifact,
  activate,
  revoke,
  listArtifacts,
  readArtifact,
  rehydrateActiveArtifacts,
  _resetRuntimeForTesting,
} from './index.js';
import { getRegisteredToolDefinition, getToolRegistrations } from '../tools/registry.js';
import type { ConstructionArtifact, ToolArtifact } from './types.js';

let tmpRoot: string;

function buildToolArtifact(overrides: Partial<ToolArtifact> = {}): ToolArtifact {
  return {
    kind: 'tool',
    name: overrides.name ?? 'echo',
    version: overrides.version ?? '1.0.0',
    content: overrides.content ?? {
      description: 'Echoes input back',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      capabilities: { tools: [] },
      handler: {
        kind: 'script',
        language: 'javascript',
        code: 'export async function handler(input, ctx) { return "echo:" + input.value; }',
      },
    },
    status: overrides.status ?? 'staged',
    createdAt: overrides.createdAt ?? Date.now(),
    testedAt: overrides.testedAt,
    activatedAt: overrides.activatedAt,
    revokedAt: overrides.revokedAt,
    signedBy: overrides.signedBy,
    sourceAgent: overrides.sourceAgent,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-'));
  configureRuntime({
    cwd: tmpRoot,
    policy: async () => 'approve', // tests assume approval; revoke / reject paths flip explicitly
  });
});

afterEach(async () => {
  _resetRuntimeForTesting();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('stage()', () => {
  it('persists the artifact to .kodax/constructed/tools/<name>/<version>.json', async () => {
    const artifact = buildToolArtifact();
    const handle = await stage(artifact);

    expect(handle.artifact.status).toBe('staged');
    const filePath = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'echo', '1.0.0.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe('echo');
    expect(parsed.status).toBe('staged');
  });

  it('fills createdAt when missing', async () => {
    const artifact = buildToolArtifact({ createdAt: 0 });
    const before = Date.now();
    const handle = await stage(artifact);
    const after = Date.now();
    expect(handle.artifact.createdAt).toBeGreaterThanOrEqual(before);
    expect(handle.artifact.createdAt).toBeLessThanOrEqual(after);
  });
});

describe('testArtifact()', () => {
  it('returns ok=true and persists testedAt to disk for a valid tool', async () => {
    const handle = await stage(buildToolArtifact());
    const result = await testArtifact(handle);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
    // Disk is the source of truth — testedAt is persisted, not mutated
    // onto the in-memory handle.artifact (immutable update).
    const persisted = await readArtifact('echo', '1.0.0');
    expect(persisted?.testedAt).toBeGreaterThan(0);
  });

  it('rejects non-javascript handler language', async () => {
    const base = buildToolArtifact();
    const artifact = {
      ...base,
      content: {
        ...base.content,
        handler: {
          kind: 'script' as const,
          language: 'typescript' as never,
          code: 'export async function handler() {}',
        },
      },
    };
    const handle = await stage(artifact);
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/javascript/);
  });

  it("flags non-string entries in capabilities.tools", async () => {
    const artifact = buildToolArtifact();
    (artifact.content.capabilities as { tools: unknown }).tools = ['read', 42];
    const handle = await stage(artifact);
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/non-empty string/);
  });

  it('does NOT import the handler during test() (top-level effects must wait for policy gate)', async () => {
    // A handler whose top-level body throws would crash test() if loadHandler
    // ran here. With the v0.7.28 ordering fix, test() is static-only —
    // import (and thus top-level execution) is deferred to activate(),
    // which runs only after the policy verdict. Here we confirm test()
    // returns ok=true on a body that WOULD fail to import.
    const base = buildToolArtifact();
    const artifact = {
      ...base,
      name: 'static-only-test',
      content: {
        ...base.content,
        handler: {
          kind: 'script' as const,
          language: 'javascript' as const,
          // Valid signature; throws at top level if imported.
          code: 'export async function handler(input, ctx) { return "ok"; }\nthrow new Error("must NOT execute during test()");',
        },
      },
    };
    const handle = await stage(artifact);
    const result = await testArtifact(handle);
    expect(result.ok).toBe(true);
    // Persisted testedAt confirms the AST/schema chain ran to completion.
    const persisted = await readArtifact('static-only-test', '1.0.0');
    expect(persisted?.testedAt).toBeGreaterThan(0);
  });
});

describe('activate() + revoke()', () => {
  it('registers the tool into TOOL_REGISTRY with constructed source kind', async () => {
    const handle = await stage(buildToolArtifact({ name: 'reg-test', version: '1.0.0' }));
    await testArtifact(handle);
    await activate(handle);

    const registration = getRegisteredToolDefinition('reg-test');
    expect(registration?.source.kind).toBe('constructed');
    expect(registration?.source.version).toBe('1.0.0');
    expect(registration?.source.manifestPath).toMatch(/reg-test[\\/]1\.0\.0\.json$/);
    // Disk is source of truth (DD §14.1) — activate() does not mutate the
    // in-memory handle.artifact, the persisted record carries the new state.
    const persisted = await readArtifact('reg-test', '1.0.0');
    expect(persisted?.status).toBe('active');
    expect(persisted?.activatedAt).toBeGreaterThan(0);
    expect(persisted?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('throws when policy returns reject', async () => {
    configureRuntime({ cwd: tmpRoot, policy: async () => 'reject' });
    const handle = await stage(buildToolArtifact({ name: 'rejected' }));
    await testArtifact(handle);
    await expect(activate(handle)).rejects.toThrow(/policy rejected/i);
  });

  it("throws on policy 'ask-user' (Phase 1 has no built-in prompt UI)", async () => {
    configureRuntime({ cwd: tmpRoot, policy: async () => 'ask-user' });
    const handle = await stage(buildToolArtifact({ name: 'ask-user-fail' }));
    await testArtifact(handle);
    await expect(activate(handle)).rejects.toThrow(/'ask-user'/);
  });

  it('revoke removes the registration and updates status on disk', async () => {
    const handle = await stage(buildToolArtifact({ name: 'rev-test', version: '1.0.0' }));
    await testArtifact(handle);
    await activate(handle);

    expect(getRegisteredToolDefinition('rev-test')).toBeDefined();

    await revoke('rev-test', '1.0.0');

    expect(getRegisteredToolDefinition('rev-test')).toBeUndefined();

    const filePath = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'rev-test', '1.0.0.json');
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(persisted.status).toBe('revoked');
    expect(persisted.revokedAt).toBeGreaterThan(0);
  });

  it('idempotent re-activate: same name+version does not double-register', async () => {
    const handle = await stage(buildToolArtifact({ name: 'idem' }));
    await testArtifact(handle);
    await activate(handle);
    await activate(handle); // second time

    const stack = getToolRegistrations('idem');
    expect(stack).toHaveLength(1);
  });

  it('refuses to activate a revoked artifact (lifecycle guard)', async () => {
    const handle = await stage(buildToolArtifact({ name: 'lifecycle-guard' }));
    await testArtifact(handle);
    await activate(handle);
    await revoke('lifecycle-guard', '1.0.0');

    // activate() now re-reads from disk, so it sees the revoked status
    // regardless of what the in-memory handle reports.
    await expect(activate(handle)).rejects.toThrow(/revoked.*terminal/);
  });

  it('refuses to activate an artifact that has not passed test() (skip-test bypass)', async () => {
    const handle = await stage(buildToolArtifact({ name: 'skip-test' }));
    // Deliberately skip testArtifact(handle) — simulate an LLM that calls
    // stage_tool then activate_tool directly.
    await expect(activate(handle)).rejects.toThrow(/has not passed test/);
  });

  it('throws when activate is called for a name+version that is not on disk', async () => {
    const handle = {
      artifact: buildToolArtifact({ name: 'not-on-disk', version: '9.9.9' }),
      stagedAt: Date.now(),
    };
    await expect(activate(handle)).rejects.toThrow(/not found on disk/);
  });

  it('surfaces handler module-load failures at activate() (after policy gate)', async () => {
    // A handler with a syntactically valid signature whose top-level body
    // throws on import. test() is static-only — the failure surfaces only
    // at activate() time, AFTER the policy gate has approved.
    const base = buildToolArtifact();
    const artifact = {
      ...base,
      name: 'late-fail',
      content: {
        ...base.content,
        handler: {
          kind: 'script' as const,
          language: 'javascript' as const,
          code: 'export async function handler(input, ctx) { return "ok"; }\nthrow new Error("module-load failure");',
        },
      },
    };
    const handle = await stage(artifact);
    const test1 = await testArtifact(handle);
    expect(test1.ok).toBe(true);
    await expect(activate(handle)).rejects.toThrow(/module-load failure/);
  });
});

describe('testArtifact() Phase 2 static-check pipeline', () => {
  it('rejects handlers that violate AST hard rules (eval)', async () => {
    const base = buildToolArtifact();
    const artifact = {
      ...base,
      name: 'has-eval',
      content: {
        ...base.content,
        handler: {
          kind: 'script' as const,
          language: 'javascript' as const,
          code: 'export async function handler(input, ctx) { return eval(input.code); }',
        },
      },
    };
    const handle = await stage(artifact);
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /no-eval/.test(e))).toBe(true);
  });

  it('rejects schemas that violate Anthropic constraints ($ref)', async () => {
    const base = buildToolArtifact();
    const artifact = {
      ...base,
      name: 'bad-schema',
      content: {
        ...base.content,
        inputSchema: {
          type: 'object',
          properties: { x: { $ref: '#/defs/X' } },
        },
      },
    };
    const handle = await stage(artifact);
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /\$ref/.test(e))).toBe(true);
  });

  it("dispatches LLM verdict 'safe' → ok=true with no extra warnings", async () => {
    const llmReviewer = vi.fn(async () =>
      '{"verdict":"safe","concerns":[],"suggested_capabilities":["read"]}',
    );
    const handle = await stage(buildToolArtifact({ name: 'llm-safe' }));
    const result = await testArtifact(handle, { llmReviewer });
    expect(result.ok).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
    expect(llmReviewer).toHaveBeenCalledOnce();
  });

  it("dispatches LLM verdict 'suspicious' → ok=true with concerns surfaced as warnings", async () => {
    const llmReviewer = vi.fn(async () =>
      '{"verdict":"suspicious","concerns":["touches process.env","string-concat require"],"suggested_capabilities":[]}',
    );
    const handle = await stage(buildToolArtifact({ name: 'llm-suspicious' }));
    const result = await testArtifact(handle, { llmReviewer });
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => /touches process\.env/.test(w))).toBe(true);
    expect(result.warnings?.some((w) => /string-concat require/.test(w))).toBe(true);
  });

  it("dispatches LLM verdict 'dangerous' → ok=false; activate cannot proceed", async () => {
    const llmReviewer = vi.fn(async () =>
      '{"verdict":"dangerous","concerns":["aliased eval"],"suggested_capabilities":[]}',
    );
    const handle = await stage(buildToolArtifact({ name: 'llm-dangerous' }));
    const result = await testArtifact(handle, { llmReviewer });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /dangerous/.test(e))).toBe(true);
    expect(result.errors?.some((e) => /aliased eval/.test(e))).toBe(true);
  });

  it('treats LLM client failure as dangerous (defense in depth)', async () => {
    const llmReviewer = vi.fn(async () => {
      throw new Error('API timeout');
    });
    const handle = await stage(buildToolArtifact({ name: 'llm-failed' }));
    const result = await testArtifact(handle, { llmReviewer });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/LLM review failed/);
  });

  it('treats LLM output without parseable JSON as dangerous', async () => {
    const llmReviewer = vi.fn(async () => 'I refuse to review this.');
    const handle = await stage(buildToolArtifact({ name: 'llm-unparsable' }));
    const result = await testArtifact(handle, { llmReviewer });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/LLM review failed/);
  });

  it('does not call the LLM reviewer when AST rules already failed', async () => {
    const llmReviewer = vi.fn();
    const base = buildToolArtifact();
    const artifact = {
      ...base,
      name: 'short-circuit-ast',
      content: {
        ...base.content,
        handler: {
          kind: 'script' as const,
          language: 'javascript' as const,
          code: 'export async function handler(input, ctx) { return eval("1"); }',
        },
      },
    };
    const handle = await stage(artifact);
    const result = await testArtifact(handle, {
      llmReviewer: llmReviewer as never,
    });
    expect(result.ok).toBe(false);
    expect(llmReviewer).not.toHaveBeenCalled();
  });

  it('passes provider warnings (e.g. oneOf) through TestResult.warnings without blocking', async () => {
    const base = buildToolArtifact();
    const artifact = {
      ...base,
      name: 'schema-warn-only',
      content: {
        ...base.content,
        inputSchema: {
          type: 'object',
          properties: {
            x: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
      },
    };
    const handle = await stage(artifact);
    const result = await testArtifact(handle);
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((w) => /oneOf/.test(w))).toBe(true);
  });
});

describe('stage() version immutability', () => {
  it('refuses to overwrite an active artifact at the same name+version', async () => {
    const handle = await stage(buildToolArtifact({ name: 'immut', version: '1.0.0' }));
    await testArtifact(handle);
    await activate(handle);

    await expect(
      stage(buildToolArtifact({ name: 'immut', version: '1.0.0' })),
    ).rejects.toThrow(/manifest already exists/);
  });

  it('refuses to re-stage at the same version when prior status is staged (cache integrity)', async () => {
    await stage(buildToolArtifact({ name: 'restage-staged', version: '1.0.0' }));
    // Same version is immutable on disk regardless of status — the ESM
    // module cache keys by file URL, so re-writing the .js silently
    // shadows previously-loaded code. Bump semver to update.
    await expect(
      stage(buildToolArtifact({ name: 'restage-staged', version: '1.0.0' })),
    ).rejects.toThrow(/manifest already exists/);
  });

  it('refuses to re-stage at the same version after revoke (cache integrity)', async () => {
    const handle = await stage(buildToolArtifact({ name: 'restage-after-revoke', version: '1.0.0' }));
    await testArtifact(handle);
    await activate(handle);
    await revoke('restage-after-revoke', '1.0.0');
    // Even after revoke the manifest+.js remain on disk for audit, and the
    // ESM module cache still holds the old export. The only safe-by-
    // construction update is to bump the semver.
    await expect(
      stage(buildToolArtifact({ name: 'restage-after-revoke', version: '1.0.0' })),
    ).rejects.toThrow(/manifest already exists/);
  });

  it('clears stale lifecycle timestamps even if caller threaded them in', async () => {
    // Defends against an LLM-supplied artifact pre-stamping testedAt to
    // bypass the activate() gate.
    const tampered = buildToolArtifact({
      name: 'stamp-defense',
      version: '1.0.0',
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    await stage(tampered);
    const persisted = await readArtifact('stamp-defense', '1.0.0');
    expect(persisted?.testedAt).toBeUndefined();
    expect(persisted?.activatedAt).toBeUndefined();
    expect(persisted?.revokedAt).toBeUndefined();
  });
});

describe('stage() identifier validation', () => {
  it.each([
    '../escape',
    '..\\escape',
    'foo/../bar',
    'foo/bar',
    'foo\\bar',
    '.dot-prefix',
    'sp ace',
    'ctrl\x00null',
    '',
  ])('rejects unsafe name %j', async (badName) => {
    await expect(
      stage(buildToolArtifact({ name: badName, version: '1.0.0' })),
    ).rejects.toThrow(/Invalid artifact\.name|≤ 128 chars/);
  });

  it.each([
    '../1.0.0',
    'foo/bar',
    '..',
  ])('rejects unsafe version %j', async (badVersion) => {
    await expect(
      stage(buildToolArtifact({ name: 'ok', version: badVersion })),
    ).rejects.toThrow(/Invalid artifact\.version/);
  });

  it('rejects names longer than 128 chars', async () => {
    const tooLong = 'a'.repeat(129);
    await expect(
      stage(buildToolArtifact({ name: tooLong, version: '1.0.0' })),
    ).rejects.toThrow(/≤ 128 chars/);
  });
});

describe('listArtifacts()', () => {
  it('returns all artifacts on disk regardless of status', async () => {
    await stage(buildToolArtifact({ name: 'a', version: '1.0.0' }));
    const handleB = await stage(buildToolArtifact({ name: 'b', version: '1.0.0' }));
    await testArtifact(handleB);
    await activate(handleB);

    const all = await listArtifacts();
    expect(all.map((a) => `${a.name}@${a.version}:${a.status}`).sort()).toEqual([
      'a@1.0.0:staged',
      'b@1.0.0:active',
    ]);
  });

  it('filters by kind when provided', async () => {
    await stage(buildToolArtifact({ name: 'only-tool' }));
    const all = await listArtifacts('tool');
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('tool');
  });

  it('returns empty array when constructed root does not exist', async () => {
    const all = await listArtifacts();
    expect(all).toEqual([]);
  });
});

describe('rehydrateActiveArtifacts()', () => {
  it('restores active artifacts to TOOL_REGISTRY without going through policy', async () => {
    // Activate two tools, then "restart" by resetting in-memory state
    // while leaving disk intact.
    const a = await stage(buildToolArtifact({ name: 'reh-a', version: '1.0.0' }));
    await testArtifact(a);
    await activate(a);
    const b = await stage(buildToolArtifact({ name: 'reh-b', version: '1.0.0' }));
    await testArtifact(b);
    await activate(b);

    // Sanity: both registered
    expect(getRegisteredToolDefinition('reh-a')).toBeDefined();
    expect(getRegisteredToolDefinition('reh-b')).toBeDefined();

    // Simulate restart: drop in-memory registrations only.
    _resetRuntimeForTesting();
    configureRuntime({
      cwd: tmpRoot,
      // Importantly: `reject` policy. Rehydrate must NOT call it.
      policy: async () => 'reject',
    });

    expect(getRegisteredToolDefinition('reh-a')).toBeUndefined();

    const result = await rehydrateActiveArtifacts();
    expect(result.loaded).toBe(2);
    expect(result.failed).toBe(0);

    expect(getRegisteredToolDefinition('reh-a')).toBeDefined();
    expect(getRegisteredToolDefinition('reh-b')).toBeDefined();
  });

  it('skips artifacts with status revoked', async () => {
    const handle = await stage(buildToolArtifact({ name: 'reh-rev' }));
    await testArtifact(handle);
    await activate(handle);
    await revoke('reh-rev', '1.0.0');

    _resetRuntimeForTesting();
    configureRuntime({ cwd: tmpRoot });

    const result = await rehydrateActiveArtifacts();
    expect(result.loaded).toBe(0);
    expect(getRegisteredToolDefinition('reh-rev')).toBeUndefined();
  });

  it('continues past a single bad manifest', async () => {
    const good = await stage(buildToolArtifact({ name: 'good' }));
    await testArtifact(good);
    await activate(good);

    // Plant a malformed manifest beside the good one.
    const badPath = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'bad', '1.0.0.json');
    await fs.mkdir(path.dirname(badPath), { recursive: true });
    await fs.writeFile(badPath, '{this is not valid json', 'utf8');

    _resetRuntimeForTesting();
    configureRuntime({ cwd: tmpRoot });

    // Silence expected console.warn so test output stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await rehydrateActiveArtifacts();
      expect(result.loaded).toBe(1);
      expect(getRegisteredToolDefinition('good')).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refuses to rehydrate when contentHash mismatches (cross-session manifest tampering)', async () => {
    const handle = await stage(buildToolArtifact({ name: 'tampered', version: '1.0.0' }));
    await testArtifact(handle);
    await activate(handle);

    // Simulate an LLM (or attacker) editing the persisted manifest's
    // handler.code via the Write tool but NOT recomputing contentHash.
    const manifestPath = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'tampered', '1.0.0.json');
    const persisted = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as ToolArtifact;
    const tampered: ToolArtifact = {
      ...persisted,
      content: {
        ...persisted.content,
        handler: {
          ...persisted.content.handler,
          code: 'export async function handler(input, ctx) { return "tampered code"; }',
        },
      },
    };
    // Note: do NOT recompute contentHash — this is the realistic naive
    // tampering scenario the fingerprint defends against.
    await fs.writeFile(manifestPath, JSON.stringify(tampered, null, 2), 'utf8');

    _resetRuntimeForTesting();
    configureRuntime({ cwd: tmpRoot });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await rehydrateActiveArtifacts();
      expect(result.loaded).toBe(0);
      expect(result.tampered).toBe(1);
      expect(getRegisteredToolDefinition('tampered')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/contentHash mismatch/));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rehydrates artifacts written before contentHash existed (legacy compat)', async () => {
    // Simulate a manifest persisted by an older KodaX version (pre-v0.7.28
    // hardening) — no contentHash field at all. Must still rehydrate so
    // upgrades do not break previously-approved tools.
    const dir = path.join(tmpRoot, '.kodax', 'constructed', 'tools', 'legacy', '1.0.0.json');
    await fs.mkdir(path.dirname(dir), { recursive: true });
    const legacy: ConstructionArtifact = {
      ...buildToolArtifact({ name: 'legacy', version: '1.0.0' }),
      status: 'active',
      testedAt: Date.now() - 1000,
      activatedAt: Date.now() - 500,
      // no contentHash
    };
    await fs.writeFile(dir, JSON.stringify(legacy, null, 2), 'utf8');

    _resetRuntimeForTesting();
    configureRuntime({ cwd: tmpRoot });

    const result = await rehydrateActiveArtifacts();
    expect(result.loaded).toBe(1);
    expect(result.tampered).toBe(0);
    expect(getRegisteredToolDefinition('legacy')).toBeDefined();
  });
});
