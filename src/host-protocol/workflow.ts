/**
 * Workflows: scripted runs of many Agents that a Session starts. Each belongs
 * to the Session that started it and is read and steered through it. A
 * workflow started with `workflow.start` is the work of one Run of the
 * Session, and `runId` names it.
 *
 * The Host keeps workflows in memory: after a Host restart the Session's Runs
 * remain, its workflows are gone.
 *
 * Where a workflow keeps its files, and the files it wrote, are named by paths
 * on the Host, so only a role that reaches the local plane is sent them.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { RunLeases } from './lease.js';
import { SessionRef } from './session.js';

const WorkflowId = z.string().min(1).max(256);

const Summary = {
  id: z.string(),
  /** The workflow's name, such as a saved workflow's. */
  name: z.string(),
  displayName: z.string().optional(),
  /** `running`, `paused`, `completed`, `failed`, `denied` or `stopped`. */
  status: z.string(),
  /** A Stop was asked for. `confirmed` once all the work it owned had ended. */
  stop: z.object({ state: z.string() }).optional(),
  /** How many Agents the workflow started so far. */
  spawnedAgents: z.int(),
  error: z.string().optional(),
  startedAt: z.int(),
  updatedAt: z.int().optional(),
  endedAt: z.int().optional(),
};

/** A workflow as `workflow.list` and the Session's view show it. */
export const WorkflowSummary = z.object(Summary);

/** One step of a workflow: a `phase`, an `agent`, a `step` or an `artifact`. */
const Item = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  /** `pending`, `running`, `completed`, `failed`, `cancelled` or `skipped`. */
  status: z.string(),
  phaseId: z.string().optional(),
  parentId: z.string().optional(),
  agentId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.int().optional(),
  endedAt: z.int().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  /** `replayed-from-cache` when a resumed workflow took the step's answer from the run it resumed. */
  origin: z.string().optional(),
});

const Artifact = z.object({ name: z.string(), description: z.string().optional() });

const detail = <Shown extends z.ZodType, Local extends z.ZodRawShape>(artifact: Shown, local: Local) => hostResult({
  workflow: z.object({
    ...Summary,
    /** The Run of the Session whose work the workflow is. Absent when no Run started it. */
    runId: z.string().optional(),
    goal: z.string().optional(),
    /** Where it started: `command`, `review`, `sdk`, `capsule`, `extension` or `automation`. */
    source: z.string().optional(),
    savedWorkflowName: z.string().optional(),
    /** The workflow this one resumed, taking the answers of the steps it had finished. */
    resumedFromId: z.string().optional(),
    activePhaseId: z.string().optional(),
    phaseCount: z.int().optional(),
    items: z.array(Item),
    counts: z.object({
      pending: z.int(), running: z.int(), completed: z.int(), failed: z.int(), cancelled: z.int(), skipped: z.int(),
    }),
    progress: z.object({
      spawnedAgents: z.int(),
      finishedAgents: z.int(),
      activeAgents: z.int(),
      failedAgents: z.int(),
      stoppedAgents: z.int(),
      /** The most Agents the workflow may start. */
      agentCap: z.int().optional(),
      plannedItems: z.int().optional(),
    }),
    tokens: z.object({ spent: z.number(), total: z.number().optional() }).optional(),
    latestMessage: z.string().optional(),
    /** The workflow's answer. */
    result: z.string().optional(),
    artifacts: z.array(artifact).optional(),
    ...local,
  }),
});

const Target = { sessionId: SessionRef, workflowId: WorkflowId };

/** A workflow command answers once the Host took it. What it led to shows in `workflow.get`. */
const command = {
  primitive: 'command',
  plane: 'data',
  params: hostCommandParams(Target),
  result: hostResult({}),
} as const;

export const WORKFLOW_METHODS = {
  /** The Session's workflows, newest first. */
  'workflow.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({
      sessionId: SessionRef,
      /** Only those still running or paused. */
      activeOnly: z.boolean().optional(),
      limit: z.int().min(1).max(200).optional(),
      cursor: z.string().min(1).max(256).optional(),
    }),
    result: hostList(WorkflowSummary),
  },
  'workflow.get': {
    primitive: 'query',
    plane: 'data',
    params: hostParams(Target),
    result: detail(Artifact, {}),
    localResult: detail(Artifact.extend({ path: z.string().optional() }), {
      /** Where the Host keeps the workflow's files. */
      runDir: z.string().optional(),
    }),
  },
  /**
   * Starts a workflow as a Run of the Session, by its name or by a request the
   * Host writes the script for. Only a trusted role may send its own `script`:
   * the Host runs it without a sandbox around it.
   */
  'workflow.start': {
    primitive: 'command',
    plane: 'data',
    params: hostCommandParams({
      sessionId: SessionRef,
      /** A built-in or saved workflow. */
      name: z.string().min(1).max(256).optional(),
      /** What the workflow should do, for the Host to write a script for. */
      request: z.string().min(1).max(32_768).optional(),
      script: z.strictObject({ manifest: z.record(z.string(), z.unknown()), source: z.string().min(1).max(1_048_576) }).optional(),
      args: z.record(z.string(), z.unknown()).optional(),
      provider: z.string().min(1).max(128).optional(),
      model: z.string().min(1).max(256).optional(),
      leases: RunLeases.optional(),
    }),
    restricted: { script: 'trusted', leases: 'trusted' },
    result: hostResult({ workflowId: z.string(), runId: z.string() }),
  },
  /** Keeps the workflow from starting more Agents. Those running go on. */
  'workflow.pause': command,
  /** Lets a paused workflow start Agents again. */
  'workflow.resume': command,
  /** Asks the workflow to stop; `stop.state` says when all its work has ended. One that already ended is left as it is. */
  'workflow.stop': command,
} as const satisfies HostMethodRegistry;
