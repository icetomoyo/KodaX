/**
 * Construction approvals — machine-local evidence that this user approved
 * a constructed artifact for one project root (Issue 419).
 *
 * The manifest under `<project>/.kodax/constructed/` is repository data:
 * a cloned repository can ship `status: 'active'` with a self-consistent
 * `contentHash`. Rehydrate therefore trusts only this record, which lives
 * in Agent Home `runtime/` (protected from tool writes) and is keyed by
 * project root, kind, name, version and content hash.
 */

import fs from 'fs/promises';
import path from 'path';
import { acquireKodaXFileLock, emitKodaXDiagnostic, getAgentConfigPath } from '@kodax-ai/agent';
import type { ConstructionArtifact } from './types.js';

interface ConstructionApproval {
  readonly root: string;
  readonly kind: ConstructionArtifact['kind'];
  readonly name: string;
  readonly version: string;
  readonly contentHash: string;
  readonly approvedAt: string;
}

interface ApprovalFile {
  readonly version: 1;
  readonly approvals: readonly ConstructionApproval[];
}

function approvalsPath(): string {
  return getAgentConfigPath('runtime', 'construction-approvals.json');
}

async function canonicalRoot(cwd: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(cwd));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameArtifact(
  approval: ConstructionApproval,
  root: string,
  artifact: ConstructionArtifact,
): boolean {
  return approval.root === root
    && approval.kind === artifact.kind
    && approval.name === artifact.name
    && approval.version === artifact.version;
}

function isApprovalFile(value: unknown): value is ApprovalFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; approvals?: unknown };
  return candidate.version === 1 && Array.isArray(candidate.approvals);
}

/** Missing file → no approvals. Unreadable file → throws. */
async function readApprovalFile(file: string): Promise<ApprovalFile> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, approvals: [] };
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isApprovalFile(parsed)) {
    throw new Error(`unexpected shape in ${file}`);
  }
  return parsed;
}

/**
 * Load the approvals visible from `cwd`. An unreadable record is reported
 * and treated as empty, so rehydrate refuses everything rather than
 * guessing; the next activation rewrites the file.
 */
export async function loadConstructionApprovals(
  cwd: string,
): Promise<(artifact: ConstructionArtifact, contentHash: string) => boolean> {
  const root = await canonicalRoot(cwd);
  let approvals: readonly ConstructionApproval[] = [];
  try {
    approvals = (await readApprovalFile(approvalsPath())).approvals;
  } catch (err) {
    emitKodaXDiagnostic({
      source: 'coding:construction',
      level: 'warn',
      message: `Ignoring the construction approval record at ${approvalsPath()} because it cannot be read; constructed artifacts stay unloaded until activated again.`,
      detail: err,
    });
  }
  return (artifact, contentHash) => approvals.some(
    (approval) => sameArtifact(approval, root, artifact) && approval.contentHash === contentHash,
  );
}

/**
 * Record that the user approved `artifact` with `contentHash` for the
 * project at `cwd`. Replaces any earlier approval of the same
 * name@version. A corrupt record is replaced, not merged.
 */
export async function recordConstructionApproval(
  cwd: string,
  artifact: ConstructionArtifact,
  contentHash: string,
): Promise<void> {
  const root = await canonicalRoot(cwd);
  const file = approvalsPath();
  const release = await acquireKodaXFileLock(`${file}.lock`, 5_000);
  try {
    let existing: readonly ConstructionApproval[] = [];
    try {
      existing = (await readApprovalFile(file)).approvals;
    } catch (err) {
      emitKodaXDiagnostic({
        source: 'coding:construction',
        level: 'warn',
        message: `Replacing the unreadable construction approval record at ${file}; earlier approvals must be given again.`,
        detail: err,
      });
    }
    const next: ApprovalFile = {
      version: 1,
      approvals: [
        ...existing.filter((approval) => !sameArtifact(approval, root, artifact)),
        {
          root,
          kind: artifact.kind,
          name: artifact.name,
          version: artifact.version,
          contentHash,
          approvedAt: new Date().toISOString(),
        },
      ],
    };
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  } finally {
    await release();
  }
}
