/**
 * FEATURE_217 (v0.7.49) Phase D — Durable workflow run graph.
 *
 * Persists a workflow run as `run.json` + append-only `events.jsonl` +
 * `artifacts/` under a caller-supplied run directory (the REPL points
 * this at `~/.kodax/workflow-runs/<project-key>/<runId>/` via
 * `getAgentConfigPath`). Modelling the run as an event stream — not a
 * single summary blob — keeps the agent relationships (spawn / message /
 * complete / synthesize) inspectable after the fact.
 *
 * `appendFileSync` is used for events so the on-disk order matches the
 * recorder's `seq` order with no async interleave.
 */

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeHostMetadata } from '@kodax-ai/agent';
import type {
  WorkflowArtifactRef,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowProcessTrackerOptions,
  WorkflowRunState,
  WorkflowScriptManifest,
} from '@kodax-ai/agent';
import { buildWorkflowCostReport } from './cost-report.js';
import { writeWorkflowJson } from './persistence.js';

export type WorkflowRunProcessMetadata = Pick<
  WorkflowProcessTrackerOptions,
  | 'displayName'
  | 'goal'
  | 'source'
  | 'savedWorkflowName'
  | 'sourceRunId'
  | 'sourceWorkflowName'
  | 'revisionOf'
  | 'resumedFromRunId'
  | 'hostMetadata'
>;

export interface RunGraphWriterDeps {
  /** Clock for the per-event `ts` stamp. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface RunJsonInput {
  readonly meta: WorkflowMeta;
  readonly args: unknown;
  readonly state: WorkflowRunState;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly scriptSnapshot?: WorkflowScriptSnapshotRef;
  readonly resultSummary?: string;
  /** Complete script return value; the summary is only a display projection. */
  readonly result?: unknown;
  readonly processMetadata?: WorkflowRunProcessMetadata;
}

export interface WorkflowScriptSnapshotInput {
  readonly source: string;
  readonly manifest?: WorkflowScriptManifest;
}

export interface WorkflowScriptSnapshotRef {
  readonly scriptPath: string;
  readonly manifestPath?: string;
}

export interface RunGraphWriter {
  readonly runDir: string;
  /** Append one event to `events.jsonl`. */
  onEvent(event: WorkflowEvent): void;
  /** Persist an artifact under `artifacts/<safe-name>.json`. */
  writeArtifact(name: string, value: unknown): WorkflowArtifactRef;
  /** Persist generated workflow source + optional manifest beside run.json. */
  writeScriptSnapshot(input: WorkflowScriptSnapshotInput): WorkflowScriptSnapshotRef;
  /** Write the terminal `run.json` summary. */
  writeRunJson(input: RunJsonInput): void;
}

export function safeWorkflowArtifactName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'artifact';
}

export function createRunGraphWriter(runDir: string, deps: RunGraphWriterDeps = {}): RunGraphWriter {
  const now = deps.now ?? (() => Date.now());
  const artifactsDir = join(runDir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const eventsPath = join(runDir, 'events.jsonl');

  return {
    runDir,
    onEvent: (event) => {
      appendFileSync(eventsPath, `${JSON.stringify({ ...event, ts: now() })}\n`, 'utf8');
    },
    writeArtifact: (name, value) => {
      const path = join(artifactsDir, `${safeWorkflowArtifactName(name)}.json`);
      writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
      return { name, path };
    },
    writeScriptSnapshot: (input) => {
      const scriptPath = join(runDir, 'script.js');
      writeFileSync(scriptPath, input.source, 'utf8');
      if (!input.manifest) return { scriptPath };
      const manifestPath = join(runDir, 'manifest.json');
      writeFileSync(manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`, 'utf8');
      return { scriptPath, manifestPath };
    },
    writeRunJson: (input) => {
      // Publish the original before the manifest can advertise it. Existing
      // results remain readable if final manifest publication fails.
      const hasResult = Object.prototype.hasOwnProperty.call(input, 'result');
      if (hasResult) writeWorkflowJson(join(runDir, 'result.json'), input.result === undefined
        ? { version: 1, kind: 'undefined' } : { version: 1, value: input.result });
      const hostMetadata = normalizeHostMetadata(input.processMetadata?.hostMetadata);
      const runJson = {
        runId: input.state.runId,
        workflow: input.meta.name,
        status: input.state.status,
        totalSpawned: input.state.totalSpawned,
        artifacts: input.state.artifacts.map((a) => a.name),
        eventCount: input.state.events.length,
        efficiencyReport: {
          ...buildWorkflowCostReport(input.state.events),
          wallClockDurationMs: Math.max(0, input.endedAt - input.startedAt),
        },
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        args: input.args,
        ...(input.resultSummary !== undefined ? { resultSummary: input.resultSummary } : {}),
        ...(hasResult ? { resultPath: 'result.json' } : {}),
        ...(input.processMetadata?.displayName !== undefined
          ? { displayName: input.processMetadata.displayName }
          : {}),
        ...(input.processMetadata?.goal !== undefined ? { goal: input.processMetadata.goal } : {}),
        ...(input.processMetadata?.source !== undefined ? { source: input.processMetadata.source } : {}),
        ...(input.processMetadata?.savedWorkflowName !== undefined
          ? { savedWorkflowName: input.processMetadata.savedWorkflowName }
          : {}),
        ...(input.processMetadata?.sourceRunId !== undefined
          ? { sourceRunId: input.processMetadata.sourceRunId }
          : {}),
        ...(input.processMetadata?.sourceWorkflowName !== undefined
          ? { sourceWorkflowName: input.processMetadata.sourceWorkflowName }
          : {}),
        ...(input.processMetadata?.revisionOf !== undefined
          ? { revisionOf: input.processMetadata.revisionOf }
          : {}),
        ...(input.processMetadata?.resumedFromRunId !== undefined
          ? { resumedFromRunId: input.processMetadata.resumedFromRunId }
          : {}),
        ...(hostMetadata !== undefined ? { hostMetadata } : {}),
        ...(input.scriptSnapshot
          ? {
              scriptSnapshotPath: input.scriptSnapshot.scriptPath,
              ...(input.scriptSnapshot.manifestPath
                ? { manifestSnapshotPath: input.scriptSnapshot.manifestPath }
                : {}),
            }
          : {}),
      };
      writeWorkflowJson(join(runDir, 'run.json'), runJson);
    },
  };
}
