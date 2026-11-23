import type {
  ChangedScopeReport,
  KodaXRepoIntelligenceCapability,
  KodaXRepoIntelligenceTrace,
  RepoAreaKind,
} from './public-bridge.js';

export type RepoLanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'cpp'
  | 'unknown';

export type LanguageCapabilityTier = 'high' | 'medium' | 'low';
export type RepoSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'method'
  | 'constant';

export interface RepoLanguageSupport {
  language: RepoLanguageId;
  capabilityTier: LanguageCapabilityTier;
  fileCount: number;
}

export interface RepoSymbolReference {
  symbolId: string;
  name: string;
  filePath: string;
  moduleId: string;
  reason: 'same-module' | 'imported-module' | 'name-match';
}

export interface RepoSymbolRecord {
  id: string;
  name: string;
  qualifiedName: string;
  kind: RepoSymbolKind;
  filePath: string;
  moduleId: string;
  language: RepoLanguageId;
  capabilityTier: LanguageCapabilityTier;
  line: number;
  signature: string;
  exported: boolean;
  calls: string[];
  callTargets: RepoSymbolReference[];
  importPaths: string[];
  confidence: number;
}

export interface ModuleCapsule {
  moduleId: string;
  label: string;
  kind: RepoAreaKind;
  root: string;
  fileCount: number;
  sourceFileCount: number;
  symbolCount: number;
  languages: RepoLanguageSupport[];
  topSymbols: string[];
  dependencies: string[];
  dependents: string[];
  entryFiles: string[];
  keyTests: string[];
  keyDocs: string[];
  sampleFiles: string[];
  processIds: string[];
  confidence: number;
}

export interface ProcessStep {
  kind: 'entry' | 'imports' | 'calls';
  symbolName: string;
  symbolId?: string;
  filePath: string;
  note: string;
  line?: number;
}

export interface ProcessCapsule {
  id: string;
  label: string;
  moduleId: string;
  entryFile: string;
  entrySymbol?: string;
  summary: string;
  steps: ProcessStep[];
  confidence: number;
}

export interface RepoIntelligenceIndex {
  schemaVersion: number;
  workspaceRoot: string;
  generatedAt: string;
  overviewGeneratedAt: string;
  sourceFileCount: number;
  sourceFingerprint: string;
  languages: RepoLanguageSupport[];
  modules: ModuleCapsule[];
  symbols: RepoSymbolRecord[];
  processes: ProcessCapsule[];
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface ModuleContextResult {
  module: ModuleCapsule;
  freshness: string;
  confidence: number;
  evidence: string[];
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface SymbolContextResult {
  symbol: RepoSymbolRecord;
  alternatives: RepoSymbolRecord[];
  callers: RepoSymbolRecord[];
  /** Entries left out of the lists above; absent when nothing was cut. */
  omitted?: { callers?: number; alternatives?: number };
  freshness: string;
  confidence: number;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface ProcessContextResult {
  process: ProcessCapsule;
  alternatives: ProcessCapsule[];
  freshness: string;
  confidence: number;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}

export interface ImpactEstimateResult {
  target: {
    kind: 'symbol' | 'module' | 'path';
    label: string;
    moduleId?: string;
    filePath?: string;
  };
  summary: string;
  impactedModules: ModuleCapsule[];
  impactedSymbols: RepoSymbolRecord[];
  callers: RepoSymbolRecord[];
  /** Entries left out of the lists above; absent when nothing was cut. */
  omitted?: { impactedSymbols?: number; callers?: number };
  changedScope?: ChangedScopeReport;
  freshness: string;
  confidence: number;
  capability?: KodaXRepoIntelligenceCapability;
  trace?: KodaXRepoIntelligenceTrace;
}
