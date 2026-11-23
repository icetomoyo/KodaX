import type {
  ImpactEstimateResult,
  ModuleContextResult,
  ProcessContextResult,
  SymbolContextResult,
} from './semantic-types.js';
import type { KodaXRepoIntelligenceCapability } from './public-bridge.js';

function confidenceLabel(value: number): string {
  if (value >= 0.8) return 'high';
  if (value >= 0.65) return 'medium';
  return 'low';
}

function moreMarker(omitted: number | undefined): string {
  return omitted ? ` (+${omitted} more not shown)` : '';
}

function capabilityLines(capability: KodaXRepoIntelligenceCapability | undefined): string[] {
  if (!capability || (capability.status === 'ok' && capability.warnings.length === 0)) {
    return [];
  }
  return [
    `Capability: ${capability.engine}/${capability.status}`,
    ...capability.warnings.map((warning) => `Warning: ${warning}`),
  ];
}

export function renderModuleContext(result: ModuleContextResult): string {
  const { module } = result;
  return [
    `Module context for ${module.label}`,
    `Module: ${module.moduleId} [${module.kind}]`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${result.confidence.toFixed(2)})`,
    `Files: ${module.fileCount} total | ${module.sourceFileCount} source | ${module.symbolCount} symbols`,
    `Languages: ${module.languages.map((language) => `${language.language}/${language.capabilityTier}:${language.fileCount}`).join(' | ') || 'none'}`,
    `Dependencies: ${module.dependencies.join(' | ') || 'none'}`,
    `Dependents: ${module.dependents.join(' | ') || 'none'}`,
    `Entry files: ${module.entryFiles.join(' | ') || 'none'}`,
    `Top symbols: ${module.topSymbols.join(' | ') || 'none'}`,
    `Tests: ${module.keyTests.join(' | ') || 'none'}`,
    `Docs: ${module.keyDocs.join(' | ') || 'none'}`,
    `Processes: ${module.processIds.join(' | ') || 'none'}`,
    `Evidence: ${result.evidence.join(' | ') || 'none'}`,
    ...capabilityLines(result.capability),
  ].join('\n');
}

export function renderSymbolContext(result: SymbolContextResult): string {
  const { symbol } = result;
  return [
    `Symbol context for ${symbol.name}`,
    `Definition: ${symbol.filePath}:${symbol.line}`,
    `Module: ${symbol.moduleId} | Kind: ${symbol.kind} | Exported: ${symbol.exported ? 'yes' : 'no'}`,
    `Language: ${symbol.language}/${symbol.capabilityTier}`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${result.confidence.toFixed(2)})`,
    `Signature: ${symbol.signature}`,
    `Possible callees: ${symbol.callTargets.map((target) => `${target.name} -> ${target.filePath}`).join(' | ') || 'none'}`,
    `Possible callers: ${result.callers.map((caller) => `${caller.name} -> ${caller.filePath}`).join(' | ') || 'none'}${moreMarker(result.omitted?.callers)}`,
    `Imports: ${symbol.importPaths.join(' | ') || 'none'}`,
    result.alternatives.length > 0
      ? `Alternatives: ${result.alternatives.map((candidate) => `${candidate.name} @ ${candidate.filePath}:${candidate.line}`).join(' | ')}${moreMarker(result.omitted?.alternatives)}`
      : 'Alternatives: none',
    ...capabilityLines(result.capability),
  ].join('\n');
}

export function renderProcessContext(result: ProcessContextResult): string {
  const { process } = result;
  return [
    `Process context for ${process.label}`,
    `Module: ${process.moduleId}`,
    `Entry: ${process.entryFile}${process.entrySymbol ? ` -> ${process.entrySymbol}` : ''}`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${result.confidence.toFixed(2)})`,
    `Summary: ${process.summary}`,
    'Steps:',
    ...process.steps.map((step) => `- ${step.kind} ${step.symbolName} @ ${step.filePath}${step.line ? `:${step.line}` : ''} | ${step.note}`),
    result.alternatives.length > 0
      ? `Alternatives: ${result.alternatives.map((candidate) => candidate.label).join(' | ')}`
      : 'Alternatives: none',
    ...capabilityLines(result.capability),
  ].join('\n');
}

export function renderImpactEstimate(result: ImpactEstimateResult): string {
  return [
    `Impact estimate for ${result.target.label}`,
    `Target: ${result.target.kind}${result.target.moduleId ? ` | module=${result.target.moduleId}` : ''}${result.target.filePath ? ` | file=${result.target.filePath}` : ''}`,
    `Freshness: ${result.freshness}`,
    `Confidence: ${confidenceLabel(result.confidence)} (${result.confidence.toFixed(2)})`,
    `Summary: ${result.summary}`,
    `Impacted modules: ${result.impactedModules.map((module) => `${module.label}(${module.moduleId})`).join(' | ') || 'none'}`,
    `Impacted symbols: ${result.impactedSymbols.map((symbol) => `${symbol.name} -> ${symbol.filePath}:${symbol.line}`).join(' | ') || 'none'}${moreMarker(result.omitted?.impactedSymbols)}`,
    `Possible callers: ${result.callers.map((caller) => `${caller.name} -> ${caller.filePath}:${caller.line}`).join(' | ') || 'none'}${moreMarker(result.omitted?.callers)}`,
    result.changedScope
      ? `Changed-scope overlap: ${result.changedScope.files.filter((file) =>
        result.impactedModules.some((module) => module.moduleId === file.areaId)
        || result.impactedSymbols.some((symbol) => symbol.filePath === file.path),
      ).length} file(s)`
      : 'Changed-scope overlap: unavailable',
    ...capabilityLines(result.capability),
  ].join('\n');
}
