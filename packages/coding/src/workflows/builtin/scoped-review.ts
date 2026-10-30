import { staticText } from '../../prompts/static-text.js';
import type { WorkflowApi, WorkflowModule, WorkflowTaskResult } from '@kodax-ai/agent';

import {
  applyFindingVerification,
  FINDING_VERIFICATION_OUTPUT_SCHEMA,
  mergeScopedReviewResults,
  normalizeScopedReviewResult,
  SCOPED_REVIEW_OUTPUT_SCHEMA,
  type FindingVerificationResult,
  type RawScopedReviewResult,
  type VerifiedScopedReviewResult,
} from '../scoped-review.js';
import type { ReviewPacketMetadata } from '../review-packet.js';
import { validateAgainstSchema } from '../structured-output.js';

export interface ScopedReviewWorkflowArgs {
  readonly packets: readonly ReviewPacketMetadata[];
  readonly lean?: boolean;
  readonly reviewFocus?: string;
}

export interface ScopedReviewWorkflowResult {
  readonly summary: string;
  readonly packetResults: readonly {
    readonly contentHash: string;
    readonly result: VerifiedScopedReviewResult;
  }[];
}

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string' } },
} as const;

function evidencePaths(packet: ReviewPacketMetadata): readonly string[] {
  return [packet.packetPath, ...packet.evidenceChunks.map((chunk) => chunk.path)];
}

function rawReview(value: unknown): RawScopedReviewResult {
  const errors = validateAgainstSchema(value, SCOPED_REVIEW_OUTPUT_SCHEMA);
  if (errors.length > 0) {
    throw new Error(`primary reviewer structured result is invalid: ${errors.join('; ')}`);
  }
  return value as RawScopedReviewResult;
}

function rawVerification(value: unknown): FindingVerificationResult {
  const errors = validateAgainstSchema(value, FINDING_VERIFICATION_OUTPUT_SCHEMA);
  if (errors.length > 0) {
    throw new Error(`finding verifier structured result is invalid: ${errors.join('; ')}`);
  }
  return value as FindingVerificationResult;
}

function resultOrThrow(result: WorkflowTaskResult | null, role: string): WorkflowTaskResult {
  if (result === null || result.status !== 'completed') {
    throw new Error(`${role} did not complete; no verdict was accepted`);
  }
  if (result.verification !== undefined && !result.verification.ok) {
    throw new Error(`${role} did not read every required packet path; no verdict was accepted`);
  }
  return result;
}

export function buildScopedReviewPrimaryPrompt(
  packet: ReviewPacketMetadata,
  extraPrimary: boolean,
  args: ScopedReviewWorkflowArgs,
): string {
  return [
    'Review one immutable KodaX packet as an independent third-party reviewer.',
    `Packet manifest: ${packet.packetPath}`,
    ...packet.evidenceChunks.map((chunk) => `Evidence chunk: ${chunk.path}`),
    `This packet has binding requirements: ${packet.requirementsPresent ? 'yes' : 'no'}.`,
    extraPrimary
      ? 'This is the additional high-risk primary. Actively seek a disagreement with the first reader; do not assume it was correct.'
      : 'Own both specification and implementation-quality verdicts for this scope.',
    args.lean
      ? 'Also identify unnecessary additions, but never remove validation, security, data-loss protection, accessibility, or requested behavior.'
      : '',
    args.reviewFocus ? `Additional user focus: ${args.reviewFocus}` : '',
    'Read the manifest and every listed chunk with the read tool before deciding.',
    'Begin with the required JSON result. No preamble or process narration.',
    'The findings array contains only actionable defects, never approval evidence or positive observations.',
    'When the scope is compliant and approved with no actionable defect, findings must be empty.',
    staticText("t12.workflows/builtin/scoped-review.0"),
    'If requirements are absent, specVerdict must be not-verifiable.',
  ].filter(Boolean).join('\n');
}

export function buildScopedReviewVerificationPrompt(
  packet: ReviewPacketMetadata,
  merged: ReturnType<typeof mergeScopedReviewResults>,
): string {
  return [
    'Independently attempt to refute every candidate finding in this batch.',
    `Packet manifest: ${packet.packetPath}`,
    ...packet.evidenceChunks.map((chunk) => `Evidence chunk: ${chunk.path}`),
    `Canonical candidates: ${JSON.stringify(merged.findings)}`,
    'Read the packet evidence. You may run one focused check after naming the concrete doubt.',
    'Return every findingId exactly once. A severity change requires severityReason.',
    'Begin with the required JSON result; no preamble.',
  ].join('\n');
}

export function buildScopedReviewFinalPrompt(
  packetResults: readonly ScopedReviewWorkflowResult['packetResults'][number][],
): string {
  return [
    'Synthesize the structured review results below without rereading packet bodies.',
    'Lead with confirmed findings, keep unresolved findings visibly unresolved, omit refuted findings from the actionable list, and never silently downgrade severity.',
    'Cite locations and state explicitly when no actionable issue was confirmed.',
    JSON.stringify(packetResults),
  ].join('\n');
}

async function runPrimary(
  wf: WorkflowApi,
  packet: ReviewPacketMetadata,
  extraPrimary: boolean,
  args: ScopedReviewWorkflowArgs,
): Promise<RawScopedReviewResult> {
  const result = resultOrThrow(await wf.runAgent({
    name: `${extraPrimary ? 'high-risk-' : ''}primary-${packet.partitionKey}`,
    phase: 'primary-review',
    prompt: buildScopedReviewPrimaryPrompt(packet, extraPrimary, args),
    scopeSummary: `${packet.partitionKey}: ${packet.scopePaths.join(', ')}`,
    constraints: ['read every required packet path', 'return both verdicts', 'cite evidence at each finding'],
    readOnly: true,
    modelHint: extraPrimary ? 'deep' : 'balanced',
    verification: { enforcement: 'hard', requiredReadPaths: evidencePaths(packet) },
    outputSchema: SCOPED_REVIEW_OUTPUT_SCHEMA,
    terseResult: true,
  }), 'primary reviewer');
  wf.log({
    message: `primary read accepted for ${packet.partitionKey}`,
    data: { kind: 'review_packet_read', role: 'primary', contentHash: packet.contentHash },
  });
  return rawReview(result.structured);
}

async function verifyFindings(
  wf: WorkflowApi,
  packet: ReviewPacketMetadata,
  merged: ReturnType<typeof mergeScopedReviewResults>,
): Promise<VerifiedScopedReviewResult> {
  if (merged.findings.length === 0) {
    return {
      specVerdict: merged.specVerdict,
      qualityVerdict: merged.qualityVerdict,
      unverifiedRequirements: merged.unverifiedRequirements,
      actionable: [],
      audit: { findings: [] },
      unqualifiedApprovalAllowed:
        merged.unverifiedRequirements.length === 0 &&
        merged.specVerdict === 'compliant' &&
        merged.qualityVerdict === 'approved',
    };
  }
  const result = resultOrThrow(await wf.runAgent({
    name: `verify-${packet.partitionKey}`,
    phase: 'verifier',
    prompt: buildScopedReviewVerificationPrompt(packet, merged),
    scopeSummary: `verify ${merged.findings.length} candidate finding(s) in ${packet.partitionKey}`,
    constraints: ['fresh context', 'attempt refutation', 'one disposition per findingId'],
    readOnly: true,
    modelHint: 'deep',
    verification: { enforcement: 'hard', requiredReadPaths: evidencePaths(packet) },
    outputSchema: FINDING_VERIFICATION_OUTPUT_SCHEMA,
    terseResult: true,
  }), 'finding verifier');
  wf.log({
    message: `verification read accepted for ${packet.partitionKey}`,
    data: {
      kind: 'review_packet_read',
      role: 'verification',
      contentHash: packet.contentHash,
      reason: 'candidate findings',
    },
  });
  return applyFindingVerification(merged, rawVerification(result.structured));
}

async function reviewPacket(
  wf: WorkflowApi,
  packet: ReviewPacketMetadata,
  args: ScopedReviewWorkflowArgs,
): Promise<ScopedReviewWorkflowResult['packetResults'][number]> {
  const rawPrimaries = [await runPrimary(wf, packet, false, args)];
  if (packet.riskFlags.includes('routing-high')) {
    rawPrimaries.push(await runPrimary(wf, packet, true, args));
  }
  const primaries = rawPrimaries.map((result) =>
    normalizeScopedReviewResult(packet.contentHash, packet.requirementsPresent, result)
  );
  const merged = mergeScopedReviewResults(primaries);
  const result = await verifyFindings(wf, packet, merged);
  wf.log({
    message: `quality gate completed for ${packet.partitionKey}`,
    data: {
      kind: 'review_quality_gate',
      contentHash: packet.contentHash,
      actionableFindings: result.actionable.length,
      unresolvedFindings: result.actionable.filter((item) => item.disposition === 'unresolved').length,
      unqualifiedApprovalAllowed: result.unqualifiedApprovalAllowed,
    },
  });
  return { contentHash: packet.contentHash, result };
}

async function runScopedReview(
  wf: WorkflowApi,
  args: ScopedReviewWorkflowArgs,
): Promise<ScopedReviewWorkflowResult> {
  if (!Array.isArray(args.packets) || args.packets.length === 0) {
    throw new Error('scoped-review requires at least one review packet');
  }
  const packetResults = await wf.parallel(
    args.packets.map((packet) => () => reviewPacket(wf, packet, args)),
    { concurrency: 4 },
  );
  if (packetResults.some((result) => result === null)) {
    throw new Error('one or more scope packets failed review; no final verdict was accepted');
  }
  const completedPacketResults = packetResults.filter(
    (result): result is ScopedReviewWorkflowResult['packetResults'][number] => result !== null,
  );

  await wf.artifact('scoped-review-audit', completedPacketResults);
  const final = resultOrThrow(await wf.runAgent({
    name: 'final-review-synthesis',
    phase: 'final-synthesis',
    prompt: buildScopedReviewFinalPrompt(completedPacketResults),
    scopeSummary: `cross-scope synthesis for ${completedPacketResults.length} packet(s)`,
    constraints: ['preserve severity', 'preserve unresolved uncertainty', 'do not invent evidence'],
    readOnly: true,
    modelHint: 'deep',
    outputSchema: SUMMARY_SCHEMA,
    terseResult: true,
  }), 'final synthesis');
  const structured = final.structured as { readonly summary?: unknown } | undefined;
  const summary = typeof structured?.summary === 'string' ? structured.summary : final.finalText;
  return { summary, packetResults: completedPacketResults };
}

export const scopedReview: WorkflowModule<ScopedReviewWorkflowArgs, ScopedReviewWorkflowResult> = {
  meta: {
    name: 'scoped-review',
    description: 'Review immutable scope packets once, verify only candidate findings, then synthesize.',
    readOnly: true,
    phases: ['primary-review', 'verifier', 'final-synthesis'],
    maxAgents: 64,
    maxConcurrency: 4,
  },
  run: runScopedReview,
};
