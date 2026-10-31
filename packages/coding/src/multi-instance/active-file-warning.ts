import { staticText } from '../prompts/static-text.js';
/**
 * FEATURE_125 (v0.7.41) — Team Mode Layer 3: tool-time soft warning.
 *
 * Detects overlap between this session's intended file mutation and
 * any sibling session's `activeFiles` set, then renders a short
 * banner the tool prepends to its `tool_result`. This layer NEVER
 * blocks — the LLM sees both the warning and the actual edit result
 * and self-decides whether to proceed, undo, or rework. The hard
 * block lives in Layer 4 (`content-hash-cache.ts`).
 *
 * Pure module: no fs, no clock, no globals. Sibling state comes from
 * Layer 2 (`discoverInstances` in `@kodax-ai/agent`); the caller
 * passes the snapshot in. Tests inject fixtures directly.
 *
 * Design point: matching is **exact-path equality**, NOT prefix /
 * directory containment. Per spec, `activeFiles` is the path the
 * sibling tool was invoked with; we compare verbatim. Path
 * normalization (case-folding on Windows, symlink resolution) is the
 * caller's responsibility — both sides should already be operating
 * on canonical paths.
 */

import type { DiscoveredInstance } from '@kodax-ai/agent';

export interface ActiveFileOverlap {
  readonly filePath: string;
  readonly conflictingPeers: readonly ConflictingPeer[];
}

export interface ConflictingPeer {
  readonly pid: number;
  readonly intent?: string;
  readonly cwd: string;
}

/**
 * Compute the overlap between `filePath` and any sibling's
 * `activeFiles`. Returns `null` when no peer is currently editing the
 * path — the caller can short-circuit without rendering a banner.
 *
 * Pure / synchronous / no I/O. Safe to call on every tool execution.
 */
export function detectActiveFileOverlap(
  filePath: string,
  siblings: readonly DiscoveredInstance[],
): ActiveFileOverlap | null {
  if (siblings.length === 0) return null;
  const conflicting: ConflictingPeer[] = [];
  for (const sibling of siblings) {
    const active = sibling.state.activeFiles;
    if (!active || active.length === 0) continue;
    if (!active.includes(filePath)) continue;
    conflicting.push({
      pid: sibling.pid,
      cwd: sibling.state.meta.cwd,
      ...(sibling.state.currentIntent !== undefined ? { intent: sibling.state.currentIntent } : {}),
    });
  }
  if (conflicting.length === 0) return null;
  return { filePath, conflictingPeers: conflicting };
}

/**
 * Render the warning banner that prefixes a tool_result. Format mirrors
 * the v0.7.41 design doc example so the LLM sees stable wording
 * across mutation tools.
 *
 * Lead line: `[Warning: Another session is editing this file]`.
 * Per-peer line: ` - pid <N> is editing <path>; intent: "<short>"`.
 * Trailing prompt: tells the LLM the edit was still applied and
 * suggests recovery options (re-read, work elsewhere).
 *
 * Returns a bare string (no trailing newline) so the caller controls
 * the join with the tool's real output.
 */
export function buildActiveFileWarningBanner(overlap: ActiveFileOverlap): string {
  const lines: string[] = ['[Warning: Another session is editing this file]'];
  for (const peer of overlap.conflictingPeers) {
    let line = `- pid ${peer.pid} is editing ${overlap.filePath}`;
    if (peer.intent) {
      line += `; intent: "${peer.intent}"`;
    }
    lines.push(line);
  }
  lines.push(
    staticText("t12.multi-instance/active-file-warning.0"),
  );
  return lines.join('\n');
}

/**
 * One-shot convenience: detect + format. Returns `null` when there's
 * no overlap so the caller can splice unconditionally:
 *
 *   const banner = formatActiveFileWarning(filePath, siblings);
 *   const result = banner ? `${banner}\n\n${realToolResult}` : realToolResult;
 *
 * This is the API S6 wires into Edit / MultiEdit / Write tool handlers.
 */
export function formatActiveFileWarning(
  filePath: string,
  siblings: readonly DiscoveredInstance[],
): string | null {
  const overlap = detectActiveFileOverlap(filePath, siblings);
  if (!overlap) return null;
  return buildActiveFileWarningBanner(overlap);
}
