import { parentPort } from 'node:worker_threads';
import type { KodaXToolExecutionContext } from '../types.js';
import type * as SemanticIndexModule from './semantic-index.js';
import type { RepoIntelligenceAnalysisProfile } from './semantic-shared.js';
import type { SemanticLookupKind } from './semantic-lookup-query.js';

interface TsxEsmApi {
  tsImport: (specifier: string, options: { parentURL: string }) => Promise<unknown>;
}

type RepoContext = Pick<KodaXToolExecutionContext, 'executionCwd' | 'gitRoot'>;
type IndexOptions = { targetPath?: string; refresh?: boolean; profile?: RepoIntelligenceAnalysisProfile };
type SemanticLookupOptions = IndexOptions & { query: string; lookupKind: SemanticLookupKind; limit: number };

type SemanticWorkerRequest =
  | { id: number; kind: 'buildIndex'; context: RepoContext; options: IndexOptions }
  | { id: number; kind: 'getIndex'; context: RepoContext; options: IndexOptions }
  | { id: number; kind: 'module'; context: RepoContext; options: IndexOptions & { module?: string } }
  | { id: number; kind: 'symbol'; context: RepoContext; options: IndexOptions & { symbol: string; module?: string } }
  | { id: number; kind: 'process'; context: RepoContext; options: IndexOptions & { entry?: string; module?: string } }
  | { id: number; kind: 'impact'; context: RepoContext; options: IndexOptions & { symbol?: string; module?: string; path?: string } }
  | { id: number; kind: 'routing'; context: RepoContext; options: IndexOptions }
  | { id: number; kind: 'semanticLookup'; context: RepoContext; options: SemanticLookupOptions }
  | { id: number; kind: 'cyclicDeps'; context: RepoContext; options: IndexOptions };

type SemanticWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; stack?: string } };

if (!parentPort) {
  throw new Error('semantic-worker must run inside a worker thread.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequest(value: unknown): value is SemanticWorkerRequest {
  return isRecord(value)
    && typeof value.id === 'number'
    && typeof value.kind === 'string'
    && isRecord(value.context)
    && isRecord(value.options);
}

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

async function runRequest(request: SemanticWorkerRequest): Promise<unknown> {
  const semanticIndex = await loadSemanticIndex();
  switch (request.kind) {
    case 'buildIndex':
      return semanticIndex.buildRepoIntelligenceIndex(request.context, request.options);
    case 'getIndex':
      return semanticIndex.getRepoIntelligenceIndex(request.context, request.options);
    case 'module':
      return semanticIndex.getModuleContext(request.context, request.options);
    case 'symbol':
      return semanticIndex.getSymbolContext(request.context, request.options);
    case 'process':
      return semanticIndex.getProcessContext(request.context, request.options);
    case 'impact':
      return semanticIndex.getImpactEstimate(request.context, request.options);
    case 'routing':
      return semanticIndex.getRepoRoutingSignals(request.context, request.options);
    case 'semanticLookup': {
      const index = await semanticIndex.getRepoIntelligenceIndex(request.context, request.options);
      return semanticIndex.collectSemanticLookupItems(
        index,
        request.options.query,
        request.options.lookupKind,
        request.options.limit,
      );
    }
    case 'cyclicDeps': {
      const index = await semanticIndex.getRepoIntelligenceIndex(request.context, request.options);
      return semanticIndex.findCyclicDependencies(index);
    }
  }
}

function post(response: SemanticWorkerResponse): void {
  parentPort?.postMessage(response);
}

let queue = Promise.resolve();
let semanticIndexPromise: Promise<typeof SemanticIndexModule> | undefined;

function loadSemanticIndex(): Promise<typeof SemanticIndexModule> {
  if (!semanticIndexPromise) {
    semanticIndexPromise = import.meta.url.endsWith('.ts')
      ? loadDevSemanticIndex()
      : import('./semantic-index.js') as Promise<typeof SemanticIndexModule>;
  }
  return semanticIndexPromise;
}

async function loadDevSemanticIndex(): Promise<typeof SemanticIndexModule> {
  const tsx = await import('tsx/esm/api') as TsxEsmApi;
  return await tsx.tsImport('./semantic-index.ts', {
    parentURL: import.meta.url,
  }) as typeof SemanticIndexModule;
}

// Mirrors REPO_INTELLIGENCE_STORAGE_ENV in internal.ts; this entry keeps type-only imports.
const STORAGE_ENV = 'KODAX_REPO_INTELLIGENCE_STORAGE_DIR';

// A worker owns a private copy of process.env, so setting it here never leaks to the host thread.
function applyStorageBase(message: SemanticWorkerRequest & { storageBase?: unknown }): void {
  if (typeof message.storageBase === 'string' && message.storageBase.length > 0) {
    process.env[STORAGE_ENV] = message.storageBase;
  }
}

parentPort.on('message', (message: unknown) => {
  const next = queue.then(async () => {
    if (!isRequest(message)) {
      return;
    }
    try {
      applyStorageBase(message);
      post({
        id: message.id,
        ok: true,
        result: await runRequest(message),
      });
    } catch (error) {
      post({
        id: message.id,
        ok: false,
        error: serializeError(error),
      });
    }
  });
  queue = next.catch(() => undefined);
});
