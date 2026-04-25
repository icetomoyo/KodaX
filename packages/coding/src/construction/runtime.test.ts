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
  rehydrateActiveArtifacts,
  _resetRuntimeForTesting,
} from './index.js';
import { getRegisteredToolDefinition, getToolRegistrations } from '../tools/registry.js';
import type { ConstructionArtifact } from './types.js';

let tmpRoot: string;

function buildToolArtifact(overrides: Partial<ConstructionArtifact> = {}): ConstructionArtifact {
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
  it('returns ok=true and writes testedAt for a valid tool', async () => {
    const handle = await stage(buildToolArtifact());
    const result = await testArtifact(handle);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
    expect(handle.artifact.testedAt).toBeGreaterThan(0);
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

  it('reports handler materialize failures (module-load throws)', async () => {
    const base = buildToolArtifact();
    const artifact = {
      ...base,
      content: {
        ...base.content,
        handler: {
          kind: 'script' as const,
          language: 'javascript' as const,
          // Valid signature (passes ast-rules) but the module body throws
          // at import time, so loadHandler() will reject.
          code: 'export async function handler(input, ctx) { return "ok"; }\nthrow new Error("module-load failure");',
        },
      },
    };
    const handle = await stage(artifact);
    const result = await testArtifact(handle);
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/Handler materialize failed/);
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
    expect(handle.artifact.status).toBe('active');
    expect(handle.artifact.activatedAt).toBeGreaterThan(0);
  });

  it('throws when policy returns reject', async () => {
    configureRuntime({ cwd: tmpRoot, policy: async () => 'reject' });
    const handle = await stage(buildToolArtifact({ name: 'rejected' }));
    await expect(activate(handle)).rejects.toThrow(/policy rejected/i);
  });

  it("throws on policy 'ask-user' (Phase 1 has no built-in prompt UI)", async () => {
    configureRuntime({ cwd: tmpRoot, policy: async () => 'ask-user' });
    const handle = await stage(buildToolArtifact({ name: 'ask-user-fail' }));
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

    // handle.artifact.status is now 'revoked' (mutated in place by revoke()
    // since stage returns a reference to the same artifact object).
    // Wait — actually revoke() reads from disk, not the in-memory handle.
    // Manually flip status to mirror what a fresh-load handle would show.
    handle.artifact.status = 'revoked';

    await expect(activate(handle)).rejects.toThrow(/revoked.*terminal/);
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
    ).rejects.toThrow(/active version already exists/);
  });

  it('allows re-staging when prior status is staged (not yet activated)', async () => {
    await stage(buildToolArtifact({ name: 'restage-staged', version: '1.0.0' }));
    // Second stage at the same version should succeed (prior status='staged').
    const handle = await stage(buildToolArtifact({ name: 'restage-staged', version: '1.0.0' }));
    expect(handle.artifact.status).toBe('staged');
  });

  it('allows re-staging at the same version after revoke (caller accepts cache risk)', async () => {
    const handle = await stage(buildToolArtifact({ name: 'restage-after-revoke', version: '1.0.0' }));
    await testArtifact(handle);
    await activate(handle);
    await revoke('restage-after-revoke', '1.0.0');
    // Now status === 'revoked'; re-stage permitted (caller has explicitly revoked).
    const next = await stage(buildToolArtifact({ name: 'restage-after-revoke', version: '1.0.0' }));
    expect(next.artifact.status).toBe('staged');
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
});
