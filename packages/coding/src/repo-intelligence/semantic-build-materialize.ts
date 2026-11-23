import path from 'path';
import {
  collectWorkspaceFilesForSource,
  type RepoAreaOverview,
  type RepoOverviewInventory,
  type RepoOverviewSnapshot,
} from './public-bridge.js';
import type {
  ModuleCapsule,
  ProcessCapsule,
  RepoIntelligenceIndex,
  RepoLanguageId,
  RepoLanguageSupport,
  RepoSymbolRecord,
  RepoSymbolReference,
} from './semantic-types.js';
import { analyzePythonFiles, analyzeGoFiles, analyzeRustFiles } from './semantic-lezer-analyzer.js';
import {
  analyzeSourceFile,
  buildModuleAliases,
  buildProcessCapsules,
  resolveImportToModule,
  rankReferenceReason,
} from './semantic-fallback-analyzer.js';
import {
  bucketSourceFiles,
  buildAreaFileLookups,
  collectSourceFileStateMap,
  collectSourceFileStates,
} from './semantic-workspace.js';
import {
  DIRTY_SOURCE_HINT_FILE,
  FILE_ANALYSIS_INDEX_FILE,
  MAX_RELATED_RESULTS,
  QUERY_INDEX_FILE,
  QUERY_MANIFEST_FILE,
  QUERY_SCHEMA_VERSION,
  SOURCE_EXTENSIONS,
  capabilityTierForLanguage,
  computeModuleConfidence,
  computeOverviewFingerprint,
  computePathFingerprint,
  computeSourceFingerprint,
  dedupeStrings,
  ensureStorageDir,
  exists,
  getDirtySourcePathsForInputs,
  normalizeRelativePath,
  shouldPersistRepoIntelligenceBaseline,
  workspaceSnapshotFromOverview,
  writeJsonFileAtomic,
  type FileAnalysis,
  type DirtySourceHintPayload,
  type FileAnalysisIndexPayload,
  type RepoIntelligenceAnalysisProfile,
  type RepoIntelligenceManifest,
  type RepoIntelligencePreflight,
  type RepoIntelligenceWorkspaceInputs,
  type RepoSourceFileState,
  type SourceFileBuckets,
} from './semantic-shared.js';
import { serializeCachedFileAnalysisEntry } from './semantic-workspace.js';

type TypeScriptAnalyzerModule = typeof import('./semantic-typescript-analyzer.js');

export function orderedSourceFilesForBuild(buckets: SourceFileBuckets): string[] {
  return [
    ...buckets.typeScriptFiles,
    ...buckets.pythonFiles,
    ...buckets.goFiles,
    ...buckets.rustFiles,
    ...buckets.fallbackFiles,
  ];
}

export function collectLanguageBreakdown(analyses: FileAnalysis[]): RepoLanguageSupport[] {
  const languageCounts = new Map<RepoLanguageId, number>();
  for (const analysis of analyses) {
    languageCounts.set(analysis.language, (languageCounts.get(analysis.language) ?? 0) + 1);
  }
  return Array.from(languageCounts.entries()).map(([language, fileCount]) => ({
    language,
    capabilityTier: capabilityTierForLanguage(language),
    fileCount,
  }));
}

function calibrateSymbolConfidenceForProfile(
  symbol: RepoSymbolRecord,
  profile: RepoIntelligenceAnalysisProfile,
): RepoSymbolRecord {
  if (profile === 'full') {
    return symbol;
  }
  return {
    ...symbol,
    confidence: Math.min(0.68, Math.max(0.32, symbol.confidence - 0.18)),
  };
}

function calibrateSymbolsForProfile(
  symbols: readonly RepoSymbolRecord[],
  profile: RepoIntelligenceAnalysisProfile,
): RepoSymbolRecord[] {
  return symbols.map((symbol) => calibrateSymbolConfidenceForProfile(symbol, profile));
}

export async function prepareRepoIntelligenceBuildInputsFromSnapshot(
  snapshot: RepoOverviewSnapshot,
  options: {
    preflight?: RepoIntelligencePreflight;
    profile?: RepoIntelligenceAnalysisProfile;
  } = {},
): Promise<RepoIntelligenceWorkspaceInputs> {
  const overview = snapshot.overview;
  const workspaceRoot = snapshot.workspaceRoot;
  const profile = options.profile ?? options.preflight?.analysisProfile ?? 'full';
  const preflight = options.preflight;
  const storageRoot = preflight?.storageRoot ?? await ensureStorageDir(workspaceRoot, profile);
  const inventory = snapshot.inventory;
  const fallbackFiles = inventory
    ? null
    : await collectWorkspaceFilesForSource(workspaceRoot, overview.source);
  const dirtyPaths = preflight?.dirtyPaths ?? snapshot.dirtyPaths;
  const allFileSet = new Set(
    (inventory?.allFiles ?? fallbackFiles?.files ?? [])
      .map((filePath) => normalizeRelativePath(filePath)),
  );
  if (dirtyPaths && dirtyPaths.length > 0) {
    for (const filePath of dirtyPaths) {
      const absolutePath = path.join(workspaceRoot, filePath);
      if (await exists(absolutePath)) {
        allFileSet.add(filePath);
      } else {
        allFileSet.delete(filePath);
      }
    }
  }
  const allFiles = Array.from(allFileSet).sort((left, right) => left.localeCompare(right));
  const {
    areaByFile,
    filesByAreaId,
    testFilesByAreaId,
    docFilesByAreaId,
  } = buildAreaFileLookups(allFiles, overview.areas);
  const sourceFiles = allFiles.filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const sourceFileSet = new Set(sourceFiles);
  const dirtyPathsFingerprint = preflight?.dirtyPathsFingerprint ?? (dirtyPaths ? computePathFingerprint(dirtyPaths) : undefined);
  const dirtySourceFiles = preflight?.dirtySourcePaths
    ? preflight.dirtySourcePaths.filter((filePath) => sourceFileSet.has(filePath))
    : dirtyPaths
      ? dirtyPaths.filter((filePath) => sourceFileSet.has(filePath))
    : [];
  const dirtySourceStateMap = preflight?.dirtySourceStateMap
    ?? (dirtySourceFiles.length > 0
      ? await collectSourceFileStateMap(
        workspaceRoot,
        dirtySourceFiles,
        areaByFile,
        overview.areas,
        profile,
      )
      : undefined);
  const dirtySourceFingerprint = preflight?.dirtySourceFingerprint
    ?? (dirtyPaths
      ? computeSourceFingerprint(
        dirtySourceStateMap
          ? Array.from(dirtySourceStateMap.values()).sort((left, right) => left.filePath.localeCompare(right.filePath))
          : [],
      )
      : undefined);
  return {
    analysisProfile: profile,
    overview,
    overviewFingerprint: computeOverviewFingerprint(overview, allFiles),
    workspaceSnapshot: preflight?.workspaceSnapshot ?? workspaceSnapshotFromOverview(overview),
    inventory,
    workspaceRoot,
    storageRoot,
    allFiles,
    areaByFile,
    filesByAreaId,
    testFilesByAreaId,
    docFilesByAreaId,
    sourceFiles,
    sourceFileSet,
    dirtyPaths,
    dirtyPathsFingerprint,
    dirtySourceFingerprint,
    dirtySourceStateMap,
    moduleAliases: buildModuleAliases(overview.areas),
    buckets: bucketSourceFiles(sourceFiles),
  };
}

export function finalizeRepoIntelligenceBuildInputs(
  base: RepoIntelligenceWorkspaceInputs,
  sourceStates: RepoSourceFileState[],
): RepoIntelligenceWorkspaceInputs {
  return {
    ...base,
    sourceStates,
    sourceFingerprint: computeSourceFingerprint(sourceStates),
  };
}

export async function analyzeSourceFilesForBuild(
  inputs: RepoIntelligenceWorkspaceInputs,
  sourceFiles: string[],
): Promise<Map<string, FileAnalysis | null>> {
  const analysisEntries = new Map<string, FileAnalysis | null>(
    sourceFiles.map((filePath) => [filePath, null]),
  );
  const buckets = bucketSourceFiles(sourceFiles);

  if (inputs.analysisProfile === 'full' && buckets.typeScriptFiles.length > 0) {
    const { analyzeTypeScriptFiles } = await import('./semantic-typescript-analyzer.js') as TypeScriptAnalyzerModule;
    const analyses = await analyzeTypeScriptFiles(
      inputs.workspaceRoot,
      buckets.typeScriptFiles,
      inputs.overview.areas,
      inputs.sourceFileSet,
      inputs.moduleAliases,
    );
    for (const analysis of analyses) {
      analysisEntries.set(analysis.filePath, analysis);
    }
  }

  if (buckets.pythonFiles.length > 0) {
    const analyses = await analyzePythonFiles(
      inputs.workspaceRoot,
      buckets.pythonFiles,
      inputs.overview.areas,
    );
    for (const analysis of analyses) {
      analysisEntries.set(analysis.filePath, analysis);
    }
  }

  if (buckets.goFiles.length > 0) {
    const analyses = await analyzeGoFiles(
      inputs.workspaceRoot,
      buckets.goFiles,
      inputs.overview.areas,
    );
    for (const analysis of analyses) {
      analysisEntries.set(analysis.filePath, analysis);
    }
  }

  if (buckets.rustFiles.length > 0) {
    const analyses = await analyzeRustFiles(
      inputs.workspaceRoot,
      buckets.rustFiles,
      inputs.overview.areas,
    );
    for (const analysis of analyses) {
      analysisEntries.set(analysis.filePath, analysis);
    }
  }

  const fallbackFiles = inputs.analysisProfile === 'light'
    ? [...buckets.typeScriptFiles, ...buckets.fallbackFiles]
    : buckets.fallbackFiles;
  if (fallbackFiles.length > 0) {
    const analyses = await Promise.all(
      fallbackFiles.map((filePath) => analyzeSourceFile(
        inputs.workspaceRoot,
        filePath,
        inputs.areaByFile.get(filePath)?.id ?? inputs.overview.areas[0]!.id,
      )),
    );
    for (const [index, analysis] of analyses.entries()) {
      analysisEntries.set(fallbackFiles[index]!, analysis ?? null);
    }
  }

  return analysisEntries;
}

export function collectOrderedAnalyses(
  inputs: RepoIntelligenceWorkspaceInputs,
  analysisEntries: Map<string, FileAnalysis | null>,
): FileAnalysis[] {
  return orderedSourceFilesForBuild(inputs.buckets)
    .flatMap((filePath) => {
      const analysis = analysisEntries.get(filePath) ?? null;
      return analysis ? [analysis] : [];
    });
}

export async function materializeRepoIntelligenceIndex(
  inputs: RepoIntelligenceWorkspaceInputs,
  analysisEntries: Map<string, FileAnalysis | null>,
): Promise<RepoIntelligenceIndex> {
  if (!inputs.sourceStates || !inputs.sourceFingerprint) {
    throw new Error('materializeRepoIntelligenceIndex requires source state metadata.');
  }
  const analyses = collectOrderedAnalyses(inputs, analysisEntries);
  const symbols = analyses.flatMap((analysis) => analysis.symbols);
  const symbolsByName = new Map<string, RepoSymbolRecord[]>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    const bucket = symbolsByName.get(key) ?? [];
    bucket.push(symbol);
    symbolsByName.set(key, bucket);
  }

  const symbolsWithTargetsRaw = symbols.map((symbol) => {
    const importedModules = new Set<string>();
    for (const importPath of symbol.importPaths) {
      const resolvedModule = resolveImportToModule(
        importPath,
        symbol.filePath,
        inputs.sourceFileSet,
        inputs.overview.areas,
        inputs.moduleAliases,
      );
      if (resolvedModule) {
        importedModules.add(resolvedModule);
      }
    }

    const resolvedTargets = symbol.calls
      .flatMap((callName) => (symbolsByName.get(callName.toLowerCase()) ?? []).map((candidate) => ({
        candidate,
        reason: rankReferenceReason(symbol.moduleId, candidate.moduleId, importedModules),
      })))
      .filter(({ candidate }) => candidate.id !== symbol.id)
      .sort((left, right) => {
        if (left.reason !== right.reason) {
          const order = ['same-module', 'imported-module', 'name-match'];
          return order.indexOf(left.reason) - order.indexOf(right.reason);
        }
        return left.candidate.filePath.localeCompare(right.candidate.filePath);
      });

    const deduped = new Map<string, RepoSymbolReference>();
    for (const { candidate, reason } of resolvedTargets) {
      if (!deduped.has(candidate.id)) {
        deduped.set(candidate.id, {
          symbolId: candidate.id,
          name: candidate.name,
          filePath: candidate.filePath,
          moduleId: candidate.moduleId,
          reason,
        });
      }
      if (deduped.size >= MAX_RELATED_RESULTS) {
        break;
      }
    }
    return {
      ...symbol,
      callTargets: Array.from(deduped.values()),
    };
  });
  const symbolsWithTargets = calibrateSymbolsForProfile(symbolsWithTargetsRaw, inputs.analysisProfile);

  const moduleDrafts = new Map<string, {
    dependencies: Set<string>;
    dependents: Set<string>;
    languageCounts: Map<RepoLanguageId, number>;
    sourceFileCount: number;
    symbolCount: number;
    entryFiles: string[];
  }>();

  for (const area of inputs.overview.areas) {
    moduleDrafts.set(area.id, {
      dependencies: new Set<string>(),
      dependents: new Set<string>(),
      languageCounts: new Map<RepoLanguageId, number>(),
      sourceFileCount: 0,
      symbolCount: 0,
      entryFiles: [],
    });
  }

  for (const analysis of analyses) {
    const moduleDraft = moduleDrafts.get(analysis.moduleId);
    if (!moduleDraft) {
      continue;
    }
    const nextLanguageCounts = new Map(moduleDraft.languageCounts);
    nextLanguageCounts.set(
      analysis.language,
      (nextLanguageCounts.get(analysis.language) ?? 0) + 1,
    );
    const nextDependencies = new Set(moduleDraft.dependencies);
    const nextEntryFiles = /\/(?:index|main|app|server|cli)\.[^.]+$/.test(analysis.filePath) || /^(index|main|app|server|cli)\.[^.]+$/.test(analysis.filePath)
      ? dedupeStrings([...moduleDraft.entryFiles, analysis.filePath], 4)
      : moduleDraft.entryFiles;

    for (const importPath of analysis.importPaths) {
      const resolvedModule = resolveImportToModule(
        importPath,
        analysis.filePath,
        inputs.sourceFileSet,
        inputs.overview.areas,
        inputs.moduleAliases,
      );
      if (resolvedModule && resolvedModule !== analysis.moduleId) {
        nextDependencies.add(resolvedModule);
      }
    }
    moduleDrafts.set(analysis.moduleId, {
      ...moduleDraft,
      sourceFileCount: moduleDraft.sourceFileCount + 1,
      symbolCount: moduleDraft.symbolCount + analysis.symbols.length,
      languageCounts: nextLanguageCounts,
      dependencies: nextDependencies,
      entryFiles: nextEntryFiles,
    });
  }

  for (const [moduleId, draft] of moduleDrafts.entries()) {
    for (const dependency of draft.dependencies) {
      const dependencyDraft = moduleDrafts.get(dependency);
      if (!dependencyDraft) {
        continue;
      }
      moduleDrafts.set(dependency, {
        ...dependencyDraft,
        dependents: new Set([...dependencyDraft.dependents, moduleId]),
      });
    }
  }

  const modules = Array.from(moduleDrafts.entries())
    .map(([moduleId, draft]) => {
      const area = inputs.overview.areas.find((candidate) => candidate.id === moduleId);
      if (!area) {
        return null;
      }
      const dependencies = Array.from(draft.dependencies).sort((left, right) => left.localeCompare(right));
      const dependents = Array.from(draft.dependents).sort((left, right) => left.localeCompare(right));
      const languages = Array.from(draft.languageCounts.entries())
        .map(([language, fileCount]) => ({
          language,
          capabilityTier: capabilityTierForLanguage(language),
          fileCount,
        }))
        .sort((left, right) => right.fileCount - left.fileCount);
      const symbolsInModule = symbolsWithTargets.filter((symbol) => symbol.moduleId === moduleId);
      return {
        moduleId: area.id,
        label: area.label,
        kind: area.kind,
        root: area.root,
        fileCount: inputs.filesByAreaId.get(area.id)?.length ?? 0,
        sourceFileCount: draft.sourceFileCount,
        symbolCount: draft.symbolCount,
        languages,
        topSymbols: symbolsInModule
          .sort((left, right) => Number(right.exported) - Number(left.exported) || right.confidence - left.confidence)
          .slice(0, 6)
          .map((symbol) => symbol.name),
        dependencies,
        dependents,
        entryFiles: draft.entryFiles,
        keyTests: (inputs.testFilesByAreaId.get(moduleId) ?? []).slice(0, 4),
        keyDocs: (inputs.docFilesByAreaId.get(moduleId) ?? []).slice(0, 4),
        sampleFiles: area.sampleFiles.slice(0, 5),
        processIds: [] as string[],
        confidence: computeModuleConfidence(symbolsInModule, languages),
      } satisfies ModuleCapsule;
    })
    .filter((module): module is ModuleCapsule => module !== null)
    .sort((left, right) => right.symbolCount - left.symbolCount || left.moduleId.localeCompare(right.moduleId));

  const processes = buildProcessCapsules(modules, symbolsWithTargets);
  const processIdsByModule = new Map<string, string[]>();
  for (const process of processes) {
    const bucket = processIdsByModule.get(process.moduleId) ?? [];
    bucket.push(process.id);
    processIdsByModule.set(process.moduleId, bucket);
  }
  const modulesWithProcesses = modules.map((module) => ({
    ...module,
    processIds: processIdsByModule.get(module.moduleId) ?? [],
  }));

  const index: RepoIntelligenceIndex = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: inputs.workspaceRoot,
    generatedAt: new Date().toISOString(),
    overviewGeneratedAt: inputs.overview.generatedAt,
    sourceFileCount: inputs.sourceFiles.length,
    sourceFingerprint: inputs.sourceFingerprint,
    languages: collectLanguageBreakdown(analyses),
    modules: modulesWithProcesses,
    symbols: symbolsWithTargets,
    processes,
  };

  const manifest: RepoIntelligenceManifest = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: inputs.workspaceRoot,
    generatedAt: index.generatedAt,
    overviewGeneratedAt: inputs.overview.generatedAt,
    overviewFingerprint: inputs.overviewFingerprint,
    workspaceSnapshot: inputs.workspaceSnapshot,
    sourceFileCount: inputs.sourceFiles.length,
    sourceFingerprint: inputs.sourceFingerprint,
    languageBreakdown: index.languages,
    sourceStates: inputs.sourceStates,
  };

  const fileAnalysisIndex: FileAnalysisIndexPayload = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: inputs.workspaceRoot,
    generatedAt: index.generatedAt,
    sourceFingerprint: inputs.sourceFingerprint,
    analyses: Object.fromEntries(inputs.sourceFiles.map((filePath) => [
      filePath,
      serializeCachedFileAnalysisEntry(analysisEntries.get(filePath) ?? null),
    ])),
  };
  const dirtySourcePaths = getDirtySourcePathsForInputs(inputs);
  const dirtySourceHint: DirtySourceHintPayload = {
    schemaVersion: QUERY_SCHEMA_VERSION,
    workspaceRoot: inputs.workspaceRoot,
    branch: inputs.workspaceSnapshot.branch,
    head: inputs.workspaceSnapshot.head,
    queryGeneratedAt: index.generatedAt,
    overviewFingerprint: inputs.overviewFingerprint,
    sourceFingerprint: inputs.sourceFingerprint,
    sourceFileCount: inputs.sourceFiles.length,
    dirtyPathsFingerprint: inputs.dirtyPathsFingerprint ?? computePathFingerprint(inputs.dirtyPaths ?? []),
    dirtySourceFingerprint: inputs.dirtySourceFingerprint ?? computeSourceFingerprint([]),
    dirtySourcePaths,
  };

  await writeJsonFileAtomic(path.join(inputs.storageRoot, QUERY_INDEX_FILE), index);
  await writeJsonFileAtomic(path.join(inputs.storageRoot, DIRTY_SOURCE_HINT_FILE), dirtySourceHint);
  if (shouldPersistRepoIntelligenceBaseline(inputs)) {
    await writeJsonFileAtomic(path.join(inputs.storageRoot, QUERY_MANIFEST_FILE), manifest);
    await writeJsonFileAtomic(path.join(inputs.storageRoot, FILE_ANALYSIS_INDEX_FILE), fileAnalysisIndex);
  }

  return index;
}
