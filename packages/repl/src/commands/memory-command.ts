/**
 * Natural-language-first Memory escape hatch.
 *
 * The ordinary product surface is conversation. These commands expose accepted
 * Memory, exceptional decisions, diagnostics, and external storage inspection.
 *
 * Compatibility-only diagnostics (`status`, `reviews`, `rebuild`) stay
 * callable but are intentionally absent from normal help.
 *
 * Rebuild contract: ALWAYS preserves topic files; ONLY rewrites
 * `MEMORY.md`. Files whose frontmatter is missing or malformed get a
 * conservative `[<basename>](<file>) — <basename>` line and a stderr
 * warning so the user can spot and fix them rather than silently lose
 * them. `MEMORY.md` itself is excluded from the scan (it's not a topic
 * file). Files outside the configured memory dir are NEVER touched by
 * the rebuild branch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import chalk from 'chalk';

import {
  memoryMutationHandle,
  memoryProposalRevision,
  parseMemoryFile,
  type MemoryActionProposal,
  type MemoryApplyResult,
  type MemoryClaimKind,
  type MemoryController,
  type MemoryManagementController,
  type MemoryRejectResult,
  type MemoryRememberResult,
  type PendingEpisodeReviewSummary,
} from '@kodax-ai/agent';
import { type KodaXOptions } from '@kodax-ai/coding';

import type { Command, CommandCallbacks, MemoryCommandPlane } from './types.js';
import type { InteractiveContext } from '../interactive/context.js';
const PREVIEW_FINGERPRINT_TTL_MS = 15 * 60 * 1000;

interface ProposalPreviewCacheEntry {
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly revision: string;
  readonly createdAtMs: number;
}

const proposalPreviewFingerprints = new Map<string, ProposalPreviewCacheEntry>();

const PUBLIC_MEMORY_COMMANDS = [
  ['/memory', 'Summarize accepted memories'],
  ['/memory list', 'Same as `/memory`'],
  ['/memory remember --key <key> [--kind <kind>] <text>', 'Store one explicit claim'],
  ['/memory forget <ref>', 'Forget one exact memory ref'],
  ['/memory decisions', 'Show mutations that need your decision'],
  ['/memory show <ref>', 'Show one memory or decision'],
  ['/memory approve <ref>', 'Approve one exact decision'],
  ['/memory reject <ref>', 'Reject one exact decision'],
  ['/memory doctor', 'Diagnose background learning'],
  ['/memory open', 'Open Memory externally'],
  ['/memory help', 'Show this help'],
] as const;

async function listAcceptedMemory(controller: MemoryController): Promise<void> {
  const refs = await controller.listRefs({
    kinds: ['memdir'],
    lifecycles: ['active', 'trusted'],
  });
  console.log(chalk.cyan('\n[memory] accepted Memory'));
  if (refs.length === 0) {
    console.log(chalk.dim('  No accepted memories yet.'));
  } else {
    const visible = refs.slice(0, 50);
    for (let index = 0; index < visible.length; index += 1) {
      const ref = visible[index]!;
      const snapshot = await controller.readRef(ref);
      console.log(`  ${chalk.cyan(`[memory:${index + 1}]`)} ${ref.title ?? ref.id}`);
      console.log(chalk.dim(`      ref: ${memoryMutationHandle(ref)}`));
      console.log(`      ${parseMemoryFile(snapshot.body).body.trim().replace(/\s+/g, ' ').slice(0, 360)}`);
    }
    if (visible.length < refs.length) {
      console.log(chalk.dim(`  Showing ${visible.length} of ${refs.length}.`));
    }
  }
  const storageRoots = [...new Set(refs.flatMap((ref) => (
    ref.storageUri === undefined ? [] : [path.dirname(ref.storageUri)]
  )))];
  console.log(chalk.dim(`\n  ${refs.length} accepted across ${storageRoots.length} storage scope${storageRoots.length === 1 ? '' : 's'}`));
  for (const storageRoot of storageRoots) console.log(chalk.dim(`  storage: ${storageRoot}`));
  console.log();
}

interface ParsedRememberCommand {
  readonly statement: string;
  readonly claimKind: MemoryClaimKind;
  readonly claimKey?: string;
  readonly error?: string;
}

function parseRememberCommand(args: readonly string[]): ParsedRememberCommand {
  let claimKind: MemoryClaimKind = 'fact';
  let claimKey: string | undefined;
  const statementParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const part = args[index];
    if (part === '--kind') {
      const value = args[index + 1];
      if (value !== 'fact' && value !== 'policy' && value !== 'preference' && value !== 'procedure') {
        return { statement: '', claimKind, error: '--kind must be fact, preference, policy, or procedure' };
      }
      claimKind = value;
      index += 1;
      continue;
    }
    if (part === '--key') {
      claimKey = args[index + 1]?.trim();
      if (claimKey === undefined || claimKey.length === 0) {
        return { statement: '', claimKind, error: '--key requires a stable semantic identifier' };
      }
      index += 1;
      continue;
    }
    if (part !== undefined) statementParts.push(part);
  }
  return {
    statement: statementParts.join(' ').trim(),
    claimKind,
    ...(claimKey === undefined ? {} : { claimKey }),
  };
}

function formatMemoryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TopicFile {
  readonly filename: string;
  readonly absPath: string;
  readonly mtimeMs: number;
  readonly title: string;
  readonly description: string;
  readonly parseOk: boolean;
}

// Read-only presentation listing for `/memory status`; mutations and identity
// are Host-owned (FEATURE_298 T36).
function readTopicFiles(memoryDir: string): TopicFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.log(chalk.red(`[memory] failed to read memory directory ${memoryDir}: ${formatMemoryError(err)}`));
    }
    return [];
  }
  const result: TopicFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md') continue;
    const absPath = path.join(memoryDir, entry.name);
    try {
      const raw = fs.readFileSync(absPath, 'utf-8');
      const mtimeMs = fs.statSync(absPath).mtimeMs;
      const fm = parseMemoryFile(raw).frontmatter;
      const parseOk = fm.name !== undefined || fm.description !== undefined || fm.type !== undefined;
      const baseTitle = path.basename(entry.name, '.md');
      result.push({
        filename: entry.name, absPath, mtimeMs,
        title: fm.name?.trim() || baseTitle,
        description: fm.description?.trim() || baseTitle,
        parseOk,
      });
    } catch (err) {
      console.log(chalk.red(`[memory] failed to read ${absPath}: ${formatMemoryError(err)}`));
    }
  }
  return result;
}

async function listStorageIndex(memoryDir: string, entrypointPath: string): Promise<void> {
  console.log(chalk.cyan('\n[memory] per-project memory directory'));
  console.log(chalk.dim(`  ${memoryDir}`));

  const files = readTopicFiles(memoryDir);
  const malformed = files.filter((f) => !f.parseOk);
  console.log(
    chalk.dim(
      `  ${files.length} topic file${files.length === 1 ? '' : 's'}` +
        (malformed.length > 0 ? `, ${malformed.length} without parsable frontmatter` : ''),
    ),
  );

  let indexExists = false;
  let indexRaw = '';
  try {
    indexRaw = fs.readFileSync(entrypointPath, 'utf-8');
    indexExists = true;
  } catch {
    indexExists = false;
  }

  if (!indexExists) {
    console.log(chalk.yellow('\n  Derived MEMORY.md index does not exist.'));
    if (files.length > 0) {
      console.log(chalk.dim('  Run `/memory rebuild` to seed it from existing topic files.'));
    } else {
      console.log(chalk.dim('  This is not evidence that accepted Memory is missing; use `/memory list`.'));
    }
    console.log();
    return;
  }

  console.log(chalk.cyan('\n--- MEMORY.md ---'));
  if (indexRaw.trim().length === 0) {
    console.log(chalk.dim('  (empty)'));
  } else {
    console.log(indexRaw.trimEnd());
  }
  console.log(chalk.cyan('--- end ---\n'));
}

/**
 * FEATURE_289 (v0.7.85) §3.5 — `/memory status`. Read-only pipeline
 * observability: memory dir stats, this-session lineage counts, the
 * cross-session tenant review backlog, reviewer configuration, and the
 * capture/review segment break diagnosis. Zero schema changes — every
 * data source already exists.
 */
async function statusMemory(
  runtime: MemoryCommandRuntime,
): Promise<void> {
  const kodaxOptions = runtime.callbacks.createKodaXOptions?.();
  // Section 1: memory directory stats (reuses the existing list path).
  await listStorageIndex(runtime.memoryDir, runtime.entrypointPath);

  // Section 2: this-session pipeline counts from the session lineage.
  // Receipts exist only for COMPLETED reviews, so pending counts must
  // come from the inbox (section 3), never from the lineage.
  const entries = runtime.context.lineage?.entries ?? [];
  let digests = 0;
  let receipts = 0;
  let notices = 0;
  for (const entry of entries) {
    if (entry.type === 'memory_outcome_digest') digests += 1;
    else if (entry.type === 'memory_review_receipt') receipts += 1;
    else if (entry.type === 'client_notice' && entry.source === 'memory-agent') notices += 1;
  }
  console.log(chalk.cyan('\n[memory] this-session pipeline'));
  console.log(chalk.dim(`  outcome digests : ${digests}`));
  console.log(chalk.dim(`  review receipts : ${receipts}`));
  console.log(chalk.dim(`  client notices  : ${notices}`));

  // Section 3: cross-session pending reviews from the tenant inbox
  // (FEATURE_298 T36 — the Host plane always answers; no UI fallback).
  const pending = await runtime.plane.listReviews();
  const pendingCount = pending.length;
  const counts = countReviewStates(pending);
  const oldest = pending[0];
  console.log(chalk.cyan('\n[memory] pending episode reviews (current project, all sessions)'));
  console.log(chalk.dim(`  pending: ${pendingCount}`));
  console.log(chalk.dim(`  automatic queue: ${counts.automatic}`));
  console.log(chalk.dim(`  needs attention: ${counts.attention}`));
  console.log(chalk.dim(`  unknown state: ${counts.unknown}`));
  if (oldest !== undefined) {
    console.log(chalk.dim(`  oldest pending age: ${formatPendingAge(oldest.createdAt, Date.now())}`));
  }

  // Section 4: reviewer configuration state — the most common cause of
  // silent drain skips. The production reviewer is auto-installed at
  // session start when no custom reviewer is bound AND the provider has
  // credentials.
  let reviewerStatus: string;
  let reviewerMissing = false;
  if (kodaxOptions?.learningReviewer !== undefined || kodaxOptions?.memoryReviewer !== undefined) {
    reviewerStatus = 'configured (custom reviewer bound)';
  } else {
    // FEATURE_298 T36 — the Host answers with its own reviewer provider
    // state; the UI no longer resolves providers itself.
    const providerConfigured = runtime.plane.reviewerProviderConfigured();
    reviewerStatus = providerConfigured
      ? 'production reviewer auto-installed at session start'
      : 'MISSING — Host reviewer provider is not configured; episode review cannot run';
    reviewerMissing = !providerConfigured;
  }
  console.log(chalk.cyan('\n[memory] reviewer'));
  console.log(
    reviewerMissing ? chalk.yellow(`  ${reviewerStatus}`) : chalk.dim(`  ${reviewerStatus}`),
  );

  // Diagnosis: locate the broken pipeline segment, if any.
  const warnings: string[] = [];
  if (pendingCount > 0) {
    if (counts.automatic > 0) {
      warnings.push(
        digests === 0
          ? 'review segment: pending reviews from earlier sessions are waiting'
          : receipts === 0
            ? 'review segment: digests captured but no review ever completed; the backlog is growing'
            : 'review segment: pending reviews are still waiting',
      );
    }
    if (counts.attention > 0) {
      warnings.push(
        `review segment: ${counts.attention} job(s) need operator attention and cannot be processed by review-drain`,
      );
    }
    if (counts.unknown > 0) {
      warnings.push(
        `review segment: ${counts.unknown} job(s) have missing or invalid state and require repair`,
      );
    }
  } else if (digests === 0) {
    warnings.push('capture segment: no memory outcome digests recorded in this session yet');
  } else if (receipts === 0) {
    warnings.push('review segment: digests captured but no review completed in this session');
  }
  if (reviewerMissing) {
    warnings.push('reviewer missing: configure a provider (`kodax setup`) to unblock episode review');
  }
  if (warnings.length > 0) {
    console.log();
    for (const warning of warnings) {
      console.log(chalk.yellow(`  ! ${warning}`));
    }
    if (counts.automatic > 0) {
      console.log(chalk.dim('  Run `kodax memory review-drain` to process the backlog in the foreground.'));
    }
  }
  console.log();
}

function formatPendingAge(createdAt: string, nowMs: number): string {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return 'unknown';
  const minutes = Math.max(0, Math.floor((nowMs - parsed) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function countReviewStates(reviews: readonly PendingEpisodeReviewSummary[]): {
  readonly automatic: number;
  readonly attention: number;
  readonly unknown: number;
} {
  let automatic = 0;
  let attention = 0;
  let unknown = 0;
  for (const review of reviews) {
    if (review.status === 'attention') attention += 1;
    else if (review.status === 'unknown') unknown += 1;
    else automatic += 1;
  }
  return { automatic, attention, unknown };
}

function parseReviewListLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return 20;
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 200
    ? parsed
    : undefined;
}

function formatReviewAttempts(review: PendingEpisodeReviewSummary): string {
  if (review.providerAttempts === undefined) return 'legacy review job';
  return [
    `provider=${review.providerAttempts}`,
    `apply=${review.applyAttempts ?? 0}`,
    `completion=${review.completionAttempts ?? 0}`,
  ].join(', ');
}

async function listEpisodeReviews(
  runtime: MemoryCommandRuntime,
  rawLimit: string | undefined,
): Promise<void> {
  const limit = parseReviewListLimit(rawLimit);
  if (limit === undefined) {
    console.log(chalk.yellow('\n[memory] review list limit must be an integer from 1 to 200.\n'));
    return;
  }
  const reviews = await runtime.plane.listReviews();
  const visible = reviews.slice(0, limit);
  const counts = countReviewStates(reviews);
  console.log(chalk.cyan('\n[memory] episode-review jobs'));
  console.log(chalk.dim(`  showing ${visible.length} of ${reviews.length} (oldest first)`));
  console.log(chalk.dim(
    `  automatic queue: ${counts.automatic}, needs attention: ${counts.attention}, unknown state: ${counts.unknown}`,
  ));
  if (visible.length === 0) console.log(chalk.dim('  (none)'));
  for (const review of visible) {
    const job = review.jobId?.slice(0, 12) ?? `legacy:${review.reviewKey}`;
    console.log(`  ${chalk.cyan(job)} ${chalk.dim(`[${review.status}]`)} ${review.reviewKey}`);
    console.log(chalk.dim(
      `    age=${formatPendingAge(review.createdAt, Date.now())}, session=${review.ownerSessionRef}, attempts: ${formatReviewAttempts(review)}`,
    ));
    if (review.nextAttemptAt !== undefined) {
      console.log(chalk.dim(`    next provider attempt: ${review.nextAttemptAt}`));
    }
    if (review.nextApplyAttemptAt !== undefined) {
      console.log(chalk.dim(`    next apply attempt: ${review.nextApplyAttemptAt}`));
    }
    if (review.nextCompletionAttemptAt !== undefined) {
      console.log(chalk.dim(`    next completion attempt: ${review.nextCompletionAttemptAt}`));
    }
    if (review.lastError !== undefined) {
      console.log(chalk.yellow(`    last error: ${review.lastError.slice(0, 160)}`));
    }
  }
  if (counts.automatic > 0) {
    console.log(chalk.dim('\n  Process the automatic queue with `kodax memory review-drain [--max N]`.'));
  }
  if (counts.attention > 0) {
    console.log(chalk.yellow('  Attention jobs require operator intervention and are not auto-drained.'));
  }
  if (counts.unknown > 0) {
    console.log(chalk.yellow('  Unknown-state jobs require persisted-state repair before draining.'));
  }
  console.log();
}
async function runRebuild(plane: MemoryCommandPlane): Promise<void> {
  const result = await plane.rebuild();
  if (result.status === 'missing-dir') {
    console.log(chalk.yellow('\n[memory] memory directory does not exist yet — nothing to rebuild.'));
    console.log(chalk.dim(`  ${result.memoryRoot}`));
    console.log(chalk.dim('  This repairs a derived index only; use `/memory list` for accepted Memory.\n'));
    return;
  }
  if (result.status === 'no-topics') {
    console.log(chalk.yellow('\n[memory] no topic files found — nothing to rebuild.'));
    console.log(chalk.dim(`  ${result.memoryRoot}\n`));
    return;
  }
  console.log(chalk.green(`\n[memory] rebuilt MEMORY.md with ${result.entryCount} entries (newest first).`));
  console.log(chalk.dim(`  ${result.entrypointPath}`));
  if (result.malformedFiles.length > 0) {
    console.log(chalk.yellow(`  ${result.malformedFiles.length} file(s) had no parsable frontmatter — used filename as fallback:`));
    for (const filename of result.malformedFiles) {
      console.log(chalk.dim(`    - ${filename}`));
    }
    console.log(chalk.dim('  Tip: add `---\nname: ...\ndescription: ...\ntype: ...\n---` at the top of those files.'));
  }
  for (const warning of result.warnings) {
    console.log(chalk.red(`  [memory] ${warning}`));
  }
  console.log();
}
async function openMemory(
  runtime: MemoryCommandRuntime,
  token: string | undefined,
  openExternalPath?: (targetPath: string) => Promise<void>,
): Promise<void> {
  const controller = runtime.controller;
  const refs = await controller.listRefs({ kinds: ['memdir'], lifecycles: ['active', 'trusted'] });
  const selected = token === undefined ? undefined : await resolveAcceptedRef(controller, token, true);
  if (token !== undefined && selected === undefined) {
    console.log(chalk.yellow('\n[memory] choose one memory:<number> or exact ref from `/memory list`.\n'));
    return;
  }
  const storagePaths = [...new Set((selected === undefined ? refs : [selected])
    .flatMap((ref) => ref.storageUri === undefined ? [] : [ref.storageUri]))];
  const storageRoots = [...new Set(storagePaths.map((storagePath) => path.dirname(storagePath)))];
  if (selected === undefined && storageRoots.length > 1) {
    console.log(chalk.yellow('\n[memory] accepted Memory spans multiple scopes; choose one item to open:'));
    for (let index = 0; index < refs.length; index += 1) {
      console.log(chalk.dim(`  /memory open memory:${index + 1}  ${refs[index]?.title ?? refs[index]?.id}`));
    }
    console.log();
    return;
  }
  const targetPath = selected?.storageUri
    ?? (storageRoots[0] === undefined
      ? runtime.memoryDir
      : fs.existsSync(path.join(storageRoots[0], 'MEMORY.md'))
        ? path.join(storageRoots[0], 'MEMORY.md')
        : storageRoots[0]);
  let trustedPath: string;
  try {
    trustedPath = await runtime.plane.ensureOpenTarget(targetPath);
  } catch (error) {
    console.log(chalk.red(`\n[memory] ${error instanceof Error ? error.message : String(error)}\n`));
    return;
  }
  if (openExternalPath !== undefined) await openExternalPath(trustedPath);
  else await launchExternalPath(trustedPath);
  console.log(chalk.green('\n[memory] opened in your external editor/file browser.'));
  console.log(chalk.dim(`  ${trustedPath}\n`));
}
async function launchExternalPath(targetPath: string): Promise<void> {
  const { executable, args } = externalOpenInvocation(process.platform, targetPath);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', rejectOpen);
    child.once('close', (code) => {
      if (code === 0) resolveOpen();
      else rejectOpen(new Error(`external opener exited with code ${code ?? 'unknown'}`));
    });
    child.unref();
  });
}

export function externalOpenInvocation(
  platform: NodeJS.Platform,
  targetPath: string,
): { readonly executable: string; readonly args: readonly string[] } {
  if (platform === 'win32') {
    return {
      executable: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'),
      args: [targetPath],
    };
  }
  return { executable: platform === 'darwin' ? 'open' : 'xdg-open', args: [targetPath] };
}

function proposalLabel(proposal: MemoryActionProposal): string {
  const targets = proposal.targetRefs.map((ref) => ref.title ?? ref.id).join(', ');
  return `${proposal.action} ${targets || '(report only)'}`;
}

function printMemoryInbox(proposals: readonly MemoryActionProposal[]): void {
  console.log(chalk.cyan('\n[memory] decisions that need you'));
  if (proposals.length === 0) {
    console.log(chalk.dim('  (none)\n'));
    return;
  }
  for (let index = 0; index < proposals.length; index += 1) {
    const proposal = proposals[index]!;
    console.log(`  ${chalk.cyan(`[decision:${index + 1}]`)} ${proposal.preview.summary}`);
    console.log(chalk.dim(`      ${proposalLabel(proposal)}; risk=${proposal.risk}`));
    console.log(chalk.dim(`      why: ${proposal.rationale}`));
    if (proposal.preview.diff !== undefined) {
      const candidate = parseMemoryFile(proposal.preview.diff).body.trim().replace(/\s+/g, ' ');
      if (candidate.length > 0) console.log(`      proposed: ${candidate.slice(0, 360)}`);
    }
    console.log(chalk.dim(`      ref: ${proposal.id}`));
  }
  console.log(chalk.dim('\n  Use /memory show decision:<number>, then approve or reject the exact decision ref shown.\n'));
}

function printMemoryProposal(proposal: MemoryActionProposal): void {
  console.log(chalk.cyan(`\n[memory] ${proposal.id}`));
  console.log(chalk.dim(`  action : ${proposal.action}`));
  console.log(chalk.dim(`  risk   : ${proposal.risk}`));
  console.log(chalk.dim(`  reason : ${proposal.rationale}`));
  console.log(chalk.dim(`  summary: ${proposal.preview.summary}`));
  if (proposal.preview.changedPaths.length > 0) {
    console.log(chalk.dim('  changed paths:'));
    for (const changedPath of proposal.preview.changedPaths) {
      console.log(chalk.dim(`    - ${changedPath}`));
    }
  }
  if (proposal.preview.warnings.length > 0) {
    console.log(chalk.yellow('  warnings:'));
    for (const warning of proposal.preview.warnings) {
      console.log(chalk.yellow(`    - ${warning}`));
    }
  }
  if (proposal.preview.diff !== undefined && proposal.preview.diff.trim().length > 0) {
    console.log(chalk.cyan('\n--- preview ---'));
    console.log(proposal.preview.diff.trimEnd());
    console.log(chalk.cyan('--- end ---'));
  }
  console.log();
}

function printApplyResult(result: MemoryApplyResult): void {
  if (!result.applied) {
    console.log(chalk.yellow(`\n[memory] ${result.proposalId} was not applied.`));
    console.log(chalk.dim(`  ${result.skippedReason ?? 'no reason provided'}\n`));
    return;
  }
  console.log(chalk.green(`\n[memory] approved and applied ${result.proposalId}.`));
  if (result.changedPaths.length > 0) {
    console.log(chalk.dim(`  changed: ${result.changedPaths.join(', ')}`));
  }
  console.log();
}

function printRejectResult(result: MemoryRejectResult): void {
  if (!result.rejected) {
    console.log(chalk.yellow(`\n[memory] ${result.proposalId} was not rejected.`));
    console.log(chalk.dim(`  ${result.skippedReason ?? 'no reason provided'}\n`));
    return;
  }
  console.log(chalk.dim(`\n[memory] rejected ${result.proposalId}.`));
  if (result.review !== undefined) {
    console.log(chalk.dim(`  review actions: ${result.review.actions.length}`));
  }
  for (const warning of result.warnings) {
    console.log(chalk.dim(`  review warning: ${warning}`));
  }
  console.log();
}

function printHelp(): void {
  console.log(chalk.cyan('\n/memory - View and manage durable Memory'));
  for (const [usage, summary] of PUBLIC_MEMORY_COMMANDS) {
    console.log(chalk.dim(`  ${usage.padEnd(48)}${summary}`));
  }
  console.log();
}

function printRememberResult(result: MemoryRememberResult): void {
  if (result.status === 'remembered') {
    console.log(chalk.green(`\n[memory] Memory remembered: ${result.changedRefIds.join(', ')}.\n`));
    return;
  }
  if (result.status === 'updated') {
    console.log(chalk.green(`\n[memory] Memory updated: ${result.changedRefIds.join(', ')}.\n`));
    return;
  }
  if (result.status === 'already_known') {
    console.log(chalk.dim(`\n[memory] Already remembered: ${result.changedRefIds.join(', ')}.\n`));
    return;
  }
  if (result.status === 'needs_review' && result.proposalIds.length > 0) {
    console.log(chalk.yellow(
      `\n[memory] This claim conflicts with existing Memory and needs your decision: ${result.proposalIds.join(', ')}.\n`
      + 'Use `/memory decisions` to inspect it, then approve or reject it.\n',
    ));
    return;
  }
  console.log(chalk.yellow(`\n[memory] Memory was not changed: ${result.reason ?? result.status}.\n`));
}

async function resolveAcceptedRef(
  controller: MemoryController,
  token: string | undefined,
  allowOrdinal = false,
) {
  if (token === undefined) return undefined;
  const refs = await controller.listRefs({
    kinds: ['memdir'],
    lifecycles: ['active', 'trusted'],
  });
  const numbered = /^memory:([1-9]\d*)$/.exec(token);
  if (allowOrdinal && numbered !== null) return refs[Number(numbered[1]) - 1];
  return refs.find((ref) => memoryMutationHandle(ref) === token || ref.id === token);
}

async function resolveProposal(
  controller: MemoryController,
  token: string | undefined,
  allowOrdinal = false,
): Promise<MemoryActionProposal | undefined> {
  if (token === undefined) return undefined;
  const numbered = /^decision:([1-9]\d*)$/.exec(token);
  if (allowOrdinal && numbered !== null) return (await controller.listInbox())[Number(numbered[1]) - 1];
  return controller.showProposal(token);
}

function printDetailedHelp(): void {
  console.log(chalk.bold('\n/memory - View and manage durable Memory\n'));
  console.log('Usage:');
  for (const [usage, summary] of PUBLIC_MEMORY_COMMANDS) {
    console.log(chalk.cyan(`  ${usage.padEnd(48)}`) + chalk.dim(summary));
  }
  console.log('Description:');
  console.log(
    chalk.dim(
      '  Normal use is conversational: ask KodaX what it remembers, tell it\n' +
        '  to remember something, or ask it to forget one item. Slash commands\n' +
        '  are the explicit inspection and recovery escape hatch. MEMORY.md is\n' +
        '  a derived storage index, not the user-visible source of truth.\n',
    ),
  );
  console.log('Notes:');
  console.log(chalk.dim('  - Ordinary explicit remember/forget operations apply immediately.'));
  console.log(chalk.dim('  - Conflicts become readable decisions; broad requests ask for clarification.'));
  console.log(chalk.dim('  - Restricted content is rejected, and background learning runs automatically.\n'));
}

interface MemoryCommandRuntime {
  readonly cwd: string;
  readonly memoryDir: string;
  readonly entrypointPath: string;
  readonly controller: MemoryManagementController;
  readonly plane: MemoryCommandPlane;
  readonly context: InteractiveContext;
  readonly callbacks: CommandCallbacks;
}

function resolveCwd(context: InteractiveContext): string {
  return (
    context.runtimeInfo?.workspaceRoot
    ?? context.runtimeInfo?.executionCwd
    ?? process.cwd()
  );
}

// FEATURE_298 T36 — the Host owns the Memory identity, storage root, control
// plane, index rebuild, and open-target trust; the command only presents and
// launches the editor. Undefined means no Host binding: report unavailable,
// never fall back to a self-built plane.
function createMemoryCommandRuntime(
  context: InteractiveContext,
  callbacks: CommandCallbacks,
): MemoryCommandRuntime | undefined {
  const cwd = resolveCwd(context);
  const options = callbacks.createKodaXOptions?.();
  const identityCwd = options?.context?.executionCwd ?? context.runtimeInfo?.executionCwd ?? cwd;
  const plane = callbacks.memory?.(identityCwd);
  if (plane === undefined) return undefined;
  return {
    cwd,
    memoryDir: plane.memoryRoot,
    entrypointPath: plane.entrypointPath,
    controller: plane.controller,
    plane,
    context,
    callbacks,
  };
}

async function runRememberCommand(
  runtime: MemoryCommandRuntime,
  args: readonly string[],
): Promise<void> {
  const parsed = parseRememberCommand(args);
  if (parsed.error !== undefined || parsed.statement.length === 0) {
    console.log(chalk.yellow(`\n[memory] ${parsed.error ?? 'missing text to remember'}.\n`));
    return;
  }
  if (parsed.claimKey === undefined) {
    console.log(chalk.yellow(
      '\n[memory] `/memory remember` requires --key so future corrections and conflicts address the same claim.\n',
    ));
    return;
  }
  printRememberResult(await runtime.controller.remember({
    statement: parsed.statement,
    claimKind: parsed.claimKind,
    claimKey: parsed.claimKey,
    evidenceRef: `user-command:${runtime.context.sessionId ?? 'interactive'}`,
  }));
}

async function runForgetCommand(runtime: MemoryCommandRuntime, token: string | undefined): Promise<void> {
  const target = await resolveAcceptedRef(runtime.controller, token);
  if (target === undefined || token === undefined) {
    console.log(chalk.yellow('\n[memory] use the exact ref from `/memory list`; numbered aliases are read-only.\n'));
    return;
  }
  const result = await runtime.controller.forgetRef(token, target.bodyFingerprint);
  console.log(result.acknowledged
    ? chalk.green(`\n[memory] Memory forgotten: ${target.title ?? target.id}.\n`)
    : chalk.yellow(`\n[memory] Memory was not forgotten: ${result.warnings[0] ?? target.id}.\n`));
}

async function runShowCommand(runtime: MemoryCommandRuntime, token: string | undefined): Promise<void> {
  if (token === undefined) {
    console.log(chalk.yellow('\n[memory] choose memory:<number>, decision:<number>, or an exact ref.\n'));
    return;
  }
  const accepted = await resolveAcceptedRef(runtime.controller, token, true);
  if (accepted !== undefined) {
    const snapshot = await runtime.controller.readRef(accepted);
    console.log(chalk.cyan(`\n[memory] ${accepted.title ?? accepted.id}`));
    console.log(chalk.dim(`  ref: ${memoryMutationHandle(accepted)}`));
    console.log(`\n${parseMemoryFile(snapshot.body).body.trim()}\n`);
    return;
  }
  const proposal = await resolveProposal(runtime.controller, token, true);
  if (proposal === undefined) {
    console.log(chalk.yellow(`\n[memory] Memory or decision not found: ${token}\n`));
    return;
  }
  printMemoryProposal(proposal);
  cacheProposalPreview(runtime.cwd, proposal);
}

async function runDecisionCommand(
  runtime: MemoryCommandRuntime,
  operation: 'approve' | 'reject',
  token: string | undefined,
  reason: string,
): Promise<void> {
  const proposal = await resolveProposal(runtime.controller, token);
  if (proposal === undefined) {
    console.log(chalk.yellow('\n[memory] use the exact decision ref from `/memory show`; numbered aliases are read-only.\n'));
    return;
  }
  const cached = readCachedProposalPreview(runtime.cwd, proposal.id);
  if (cached === undefined) {
    console.log(chalk.yellow(`\n[memory] preview required before ${operation}: /memory show ${token ?? proposal.id}\n`));
    return;
  }
  proposalPreviewFingerprints.delete(previewCacheKey(runtime.cwd, proposal.id));
  if (operation === 'approve') {
    printApplyResult(await runtime.controller.approveProposal(
      proposal.id,
      cached.fingerprints,
      cached.revision,
    ));
    return;
  }
  printRejectResult(await runtime.controller.rejectProposal(proposal.id, reason, cached.revision));
}

async function runMemorySubcommand(
  runtime: MemoryCommandRuntime,
  sub: string,
  args: readonly string[],
): Promise<void> {
  if (sub === 'help' || sub === '--help' || sub === '-h') return printHelp();
  if (sub === 'list') return listAcceptedMemory(runtime.controller);
  if (sub === 'remember') return runRememberCommand(runtime, args.slice(1));
  if (sub === 'forget') return runForgetCommand(runtime, args[1]);
  if (sub === 'doctor' || sub === 'status') {
    return statusMemory(runtime);
  }
  if (sub === 'reviews') return listEpisodeReviews(runtime, args[1]);
  if (sub === 'pending' || sub === 'inbox') {
    console.log(chalk.dim('[memory] `pending` is a compatibility alias for /memory decisions.'));
    return printMemoryInbox(await runtime.controller.listInbox());
  }
  if (sub === 'decisions' || sub === 'proposals') return printMemoryInbox(await runtime.controller.listInbox());
  if (sub === 'show') return runShowCommand(runtime, args[1]);
  if (sub === 'approve' || sub === 'reject') {
    return runDecisionCommand(runtime, sub, args[1], args.slice(2).join(' ').trim());
  }
  if (sub === 'rebuild') return runRebuild(runtime.plane);
  if (sub === 'open') {
    return openMemory(runtime, args[1], runtime.callbacks.openExternalPath);
  }
  console.log(chalk.yellow(`\n[memory] unknown subcommand: ${sub}`));
  printHelp();
}

/**
 * `/memory` command definition.
 */
export const memoryCommand: Command = {
  name: 'memory',
  description: 'View or manage durable Memory',
  usage: '/memory [list|remember|forget|decisions|show|approve|reject|doctor|open|help]',
  argumentHint: 'list | remember <text> | forget <ref> | decisions | show <ref> | approve <ref> | reject <ref> [reason] | doctor | open | help',
  handler: async (args, context, callbacks) => {
    const subcommand = (args[0] ?? 'list').toLowerCase();
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      printHelp();
      return;
    }
    const runtime = createMemoryCommandRuntime(context, callbacks);
    if (runtime === undefined) {
      console.log(chalk.yellow('\n[memory] Memory controls are unavailable in this runtime.\n'));
      return;
    }
    await runMemorySubcommand(runtime, subcommand, args);
  },
  detailedHelp: printDetailedHelp,
};

function previewCacheKey(cwd: string, proposalId: string): string {
  return `${cwd}\0${proposalId}`;
}

function cacheProposalPreview(
  cwd: string,
  proposal: MemoryActionProposal,
): void {
  pruneExpiredPreviewFingerprints(Date.now());
  proposalPreviewFingerprints.set(previewCacheKey(cwd, proposal.id), {
    fingerprints: proposal.expectedFingerprints,
    revision: memoryProposalRevision(proposal),
    createdAtMs: Date.now(),
  });
}

function readCachedProposalPreview(
  cwd: string,
  proposalId: string,
): ProposalPreviewCacheEntry | undefined {
  const key = previewCacheKey(cwd, proposalId);
  const cached = proposalPreviewFingerprints.get(key);
  if (cached === undefined) return undefined;
  if (Date.now() - cached.createdAtMs > PREVIEW_FINGERPRINT_TTL_MS) {
    proposalPreviewFingerprints.delete(key);
    return undefined;
  }
  return cached;
}

function pruneExpiredPreviewFingerprints(nowMs: number): void {
  for (const [key, cached] of proposalPreviewFingerprints) {
    if (nowMs - cached.createdAtMs > PREVIEW_FINGERPRINT_TTL_MS) {
      proposalPreviewFingerprints.delete(key);
    }
  }
}
