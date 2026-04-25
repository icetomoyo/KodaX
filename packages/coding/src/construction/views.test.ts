import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  configureRuntime,
  stage,
  testArtifact,
  activate,
  _resetRuntimeForTesting,
} from './index.js';
import { listConstructed, findByVersion, listAll } from './views.js';
import type { ConstructionArtifact } from './types.js';

let tmpRoot: string;

function buildToolArtifact(name: string, version: string): ConstructionArtifact {
  return {
    kind: 'tool',
    name,
    version,
    content: {
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {}, required: [] },
      capabilities: { tools: [] },
      handler: {
        kind: 'script',
        language: 'javascript',
        code: `export async function handler() { return "${name}@${version}"; }`,
      },
    },
    status: 'staged',
    createdAt: Date.now(),
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-views-'));
  configureRuntime({ cwd: tmpRoot, policy: async () => 'approve' });
});

afterEach(async () => {
  _resetRuntimeForTesting();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('listConstructed()', () => {
  it('returns only registrations whose source.kind === constructed', async () => {
    // Registry already has many builtin tools; listConstructed must
    // exclude them and return only newly activated artifacts.
    const beforeCount = listConstructed().length;

    const a = await stage(buildToolArtifact('viewer-a', '1.0.0'));
    await testArtifact(a);
    await activate(a);

    const b = await stage(buildToolArtifact('viewer-b', '2.0.0'));
    await testArtifact(b);
    await activate(b);

    const constructed = listConstructed();
    expect(constructed.length).toBe(beforeCount + 2);
    for (const reg of constructed) {
      expect(reg.source.kind).toBe('constructed');
    }
    expect(constructed.map((r) => r.name)).toEqual(
      expect.arrayContaining(['viewer-a', 'viewer-b']),
    );
  });
});

describe('findByVersion()', () => {
  it('locates a constructed registration by name + version', async () => {
    const handle = await stage(buildToolArtifact('finder', '1.2.3'));
    await testArtifact(handle);
    await activate(handle);

    const found = findByVersion('finder', '1.2.3');
    expect(found?.name).toBe('finder');
    expect(found?.source.kind).toBe('constructed');
    expect(found?.source.version).toBe('1.2.3');
  });

  it('returns undefined for unknown name', () => {
    expect(findByVersion('does-not-exist', '1.0.0')).toBeUndefined();
  });

  it('returns undefined when version does not match', async () => {
    const handle = await stage(buildToolArtifact('finder-mismatch', '1.0.0'));
    await testArtifact(handle);
    await activate(handle);

    expect(findByVersion('finder-mismatch', '9.9.9')).toBeUndefined();
  });

  it('does not match builtin tools by version (they have no version)', () => {
    // 'read' is a known builtin
    expect(findByVersion('read', '1.0.0')).toBeUndefined();
  });
});

describe('listAll()', () => {
  it('returns every registration including builtin and constructed', async () => {
    const beforeAll = listAll();
    const beforeBuiltin = beforeAll.filter((r) => r.source.kind === 'builtin').length;
    const beforeConstructed = beforeAll.filter((r) => r.source.kind === 'constructed').length;

    const handle = await stage(buildToolArtifact('all-counter', '1.0.0'));
    await testArtifact(handle);
    await activate(handle);

    const after = listAll();
    expect(after.length).toBe(beforeAll.length + 1);
    expect(after.filter((r) => r.source.kind === 'builtin').length).toBe(beforeBuiltin);
    expect(after.filter((r) => r.source.kind === 'constructed').length).toBe(beforeConstructed + 1);
  });
});
