/**
 * Prompt content builder — CAP-009
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-009
 *
 * Pure function that turns the entry user prompt into the right shape for
 * the provider's first message:
 *
 *   - text-only prompt + no input artifacts → return the string as-is
 *     (lets the provider use its compact text-message path)
 *   - text + image artifacts (paste / drag) → return a multimodal content
 *     block array: a text block followed by one image block per artifact
 *
 * Always applied at the SINGLE SA entry-message build site
 * (`agent.ts:1263`); the runner-driven (AMA) path hits the same function via
 * the package re-export.
 *
 * Migration history: extracted from `input-artifacts.ts` to `agent-runtime/`
 * during FEATURE_100 P2. The companion `extractPromptComparableText` /
 * `extractComparableUserMessageText` helpers stay in `input-artifacts.ts`
 * for now; they migrate to `agent-runtime/middleware/auto-resume.ts` when
 * CAP-046 (duplicate-message detection) lands.
 */

import type { KodaXContentBlock, KodaXInputArtifact } from '../types.js';

export function buildPromptMessageContent(
  prompt: string,
  inputArtifacts?: readonly KodaXInputArtifact[],
): string | KodaXContentBlock[] {
  if (!inputArtifacts || inputArtifacts.length === 0) {
    return prompt;
  }

  return [
    { type: 'text', text: prompt },
    ...inputArtifacts.flatMap<KodaXContentBlock>((artifact) => (
      artifact.kind === 'image'
        ? [{
          type: 'image',
          path: artifact.path,
          mediaType: artifact.mediaType,
        }]
        : []
    )),
  ];
}
