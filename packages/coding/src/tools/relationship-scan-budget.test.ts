import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  getImpactEstimate: vi.fn(),
  getModuleContext: vi.fn(),
  getProcessContext: vi.fn(),
  getSymbolContext: vi.fn(),
  readRepoIntelligenceToolWaitMs: vi.fn(() => 1),
}));

const grepMocks = vi.hoisted(() => ({
  toolGrep: vi.fn(),
}));

vi.mock('../repo-intelligence/runtime.js', () => runtimeMocks);
vi.mock('./grep.js', () => grepMocks);

import { toolRelationshipScan } from './relationship-scan.js';
import { RepoIntelligenceUnavailableError } from '../repo-intelligence/internal.js';

describe('relationship_scan budget behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { input: undefined, requestedDepth: undefined },
    { input: 1, requestedDepth: undefined },
    { input: 2, requestedDepth: 2 },
    { input: 3, requestedDepth: 3 },
  ])('preserves numeric depth $input and the default direct-edge scan', async ({ input, requestedDepth }) => {
    runtimeMocks.getModuleContext.mockResolvedValueOnce(undefined);
    runtimeMocks.getImpactEstimate.mockResolvedValueOnce(undefined);

    const result = await toolRelationshipScan({ module: 'example-module', depth: input }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    expect(result).toContain('Relationship scan for example-module');
    if (requestedDepth === undefined) {
      expect(result).not.toContain('Requested depth');
    } else {
      expect(result).toContain(`Requested depth ${requestedDepth};`);
    }
  });

  it('stops indexed follow-up calls after the index reports it is warming', async () => {
    runtimeMocks.getSymbolContext.mockRejectedValueOnce(
      new RepoIntelligenceUnavailableError('warming', 'Repo intelligence symbol context is still warming; retry shortly.'),
    );

    const result = await toolRelationshipScan({ symbol: 'NameService' }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    expect(result).toContain('Relationship scan for NameService');
    expect(result).toContain('still warming');
    expect(runtimeMocks.getSymbolContext).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.getModuleContext).not.toHaveBeenCalled();
    expect(runtimeMocks.getProcessContext).not.toHaveBeenCalled();
    expect(runtimeMocks.getImpactEstimate).not.toHaveBeenCalled();
  });

  it('renders a clean warming response without false-negative edge claims', async () => {
    runtimeMocks.getSymbolContext.mockRejectedValueOnce(
      new RepoIntelligenceUnavailableError('warming', 'Repo intelligence symbol context is still warming; retry shortly.'),
    );

    const result = await toolRelationshipScan({ symbol: 'NameService' }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    // The warming response must NOT assert that no relationships exist —
    // the empty edge lists are an artifact of an unbuilt index, not a finding.
    expect(result).not.toContain('No direct callers found');
    expect(result).not.toContain('No direct callees found');
    expect(result).not.toContain('No module dependents found');
    // It must explicitly flag the warming state and that this is not a result.
    expect(result).toContain('Structural relationships unavailable');
    expect(result).toContain('NOT a "no relationships found" result');
    expect(result).toContain('Retry relationship_scan shortly');
  });

  it('reports an unavailable index without suggesting a retry', async () => {
    runtimeMocks.getModuleContext.mockRejectedValueOnce(
      new RepoIntelligenceUnavailableError('unavailable', 'Repo intelligence module context is unavailable because the index worker did not respond.'),
    );

    const result = await toolRelationshipScan({ module: 'example-module' }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    expect(result).toContain('Status: index unavailable');
    expect(result).toContain('NOT a "no relationships found" result');
    expect(result).not.toContain('Retry relationship_scan');
    expect(runtimeMocks.getImpactEstimate).not.toHaveBeenCalled();
  });

  it('says how many callers the index left out', async () => {
    const record = {
      id: 'NameService',
      name: 'NameService',
      qualifiedName: 'NameService',
      kind: 'function',
      filePath: 'src/name.ts',
      moduleId: 'src',
      language: 'typescript',
      capabilityTier: 'high',
      line: 3,
      signature: 'function NameService()',
      exported: true,
      calls: [],
      callTargets: [],
      importPaths: [],
      confidence: 0.9,
    };
    runtimeMocks.getSymbolContext.mockResolvedValueOnce({
      symbol: record,
      alternatives: [],
      callers: [{ ...record, id: 'caller', name: 'caller', filePath: 'src/caller.ts' }],
      omitted: { callers: 5 },
      freshness: 'now',
      confidence: 0.9,
    });
    runtimeMocks.getModuleContext.mockResolvedValueOnce(undefined);
    runtimeMocks.getProcessContext.mockResolvedValueOnce(undefined);
    runtimeMocks.getImpactEstimate.mockResolvedValueOnce(undefined);

    const result = await toolRelationshipScan({ symbol: 'NameService' }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    expect(result).toContain('- ... 5 more caller(s) not shown');
  });

  it('preserves grep evidence already bounded by head_limit without a second lossy clip', async () => {
    const evidenceLines = Array.from(
      { length: 16 },
      (_, index) => `grep-evidence-${index + 1}-${'x'.repeat(180)}`,
    );
    grepMocks.toolGrep.mockResolvedValueOnce(evidenceLines.join('\n'));
    runtimeMocks.getModuleContext.mockResolvedValueOnce(undefined);
    runtimeMocks.getImpactEstimate.mockResolvedValueOnce(undefined);

    const result = await toolRelationshipScan({
      module: 'example-module',
      direction: 'upstream',
      include_text_search: true,
    }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    expect(grepMocks.toolGrep).toHaveBeenCalledWith(
      expect.objectContaining({ head_limit: 16 }),
      expect.any(Object),
    );
    for (const evidenceLine of evidenceLines) {
      expect(result).toContain(evidenceLine);
    }
  });

  it('renders every process step instead of silently clipping downstream evidence at eight', async () => {
    runtimeMocks.getModuleContext.mockResolvedValueOnce(undefined);
    runtimeMocks.getProcessContext.mockResolvedValueOnce({
      process: {
        id: 'process:entry',
        label: 'entry',
        moduleId: '.',
        entryFile: 'src/entry.ts',
        summary: 'test process',
        steps: Array.from({ length: 12 }, (_, index) => ({
          kind: index === 0 ? 'entry' : 'calls',
          symbolName: `step${index + 1}`,
          filePath: `src/step-${index + 1}.ts`,
          note: 'evidence',
          line: index + 1,
        })),
        confidence: 0.9,
      },
      alternatives: [],
      freshness: 'fresh',
      confidence: 0.9,
    });
    runtimeMocks.getImpactEstimate.mockResolvedValueOnce(undefined);

    const result = await toolRelationshipScan({
      entry: 'entry',
      direction: 'downstream',
    }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    expect(result).toContain('Process entry: step1');
    expect(result).toContain('Process calls: step12');
  });
});
