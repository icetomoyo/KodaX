/**
 * FEATURE_309 reviewer A/B cases. w1 to w4 are the FEATURE_308 write cases, unchanged.
 * m1 and m2 are episodes the old reviewer could route to a learned Skill: a repeated,
 * verified multi-step method, and a user asking to save a procedure "as a skill".
 * With the Skill decision gone, the method has to survive as Memory.
 */
import type { KodaXMemoryOutcomeDigest } from '@kodax-ai/agent';

import { FEATURE_308_WRITE_CASES, type WriteCase } from '../feature-308-baseline/cases.js';

export interface ReviewerCase {
  readonly id: string;
  readonly family: string;
  readonly digest: KodaXMemoryOutcomeDigest;
  /** Earlier digests of the same project, as production reads them from session storage. */
  readonly priorDigests: readonly KodaXMemoryOutcomeDigest[];
  readonly oracle: WriteCase['oracle'];
}

const CREATED_AT = '2026-11-01T09:00:00.000Z';

function methodDigest(
  id: string,
  sequence: number,
  fields: Pick<KodaXMemoryOutcomeDigest, 'objective' | 'approach' | 'summary' | 'actionSignature'>
    & Partial<Pick<KodaXMemoryOutcomeDigest, 'lesson' | 'preconditions'>>,
): KodaXMemoryOutcomeDigest {
  return {
    id: `memory-outcome:${id}`,
    reviewKey: `f309-${id}`,
    episodeId: `episode-${id}`,
    sessionId: `f309-session-${id}`,
    branchId: `f309-session-${id}`,
    sequence,
    outcome: 'succeeded',
    evidenceRefs: ['tool:bash-1'],
    evidence: [{ ref: 'tool:bash-1', grade: 'verified', source: 'host', verdict: 'passed', observedAt: CREATED_AT }],
    visibility: 'prompt_safe',
    createdAt: CREATED_AT,
    ...fields,
  };
}

const RELEASE_SIGNATURE = 'release:patch';

export const FEATURE_309_REVIEWER_CASES: readonly ReviewerCase[] = [
  ...FEATURE_308_WRITE_CASES.map((item) => ({ ...item, priorDigests: [] })),
  {
    id: 'm1',
    family: 'repeated verified multi-step method',
    digest: methodDigest('m1', 2, {
      objective: 'Publish the 2.4.1 patch release of the CLI.',
      approach: 'bump the version, regenerate prompt text, run the fast check, tag and push',
      actionSignature: RELEASE_SIGNATURE,
      summary: 'Published 2.4.1 the same way as 2.4.0: `npm version patch --no-git-tag-version`, then `npm run prompts:text` (the build check fails on a stale static-text.json otherwise), then `make check-fast` (42 passed), then `git tag v2.4.1 && git push --tags`. The release workflow went green.',
      lesson: 'Run `npm run prompts:text` before `make check-fast`; a stale static-text.json fails the build check.',
      preconditions: 'A release is cut from a clean main branch.',
    }),
    priorDigests: [methodDigest('m1-prior', 1, {
      objective: 'Publish the 2.4.0 release of the CLI.',
      approach: 'bump the version, regenerate prompt text, run the fast check, tag and push',
      actionSignature: RELEASE_SIGNATURE,
      summary: 'Published 2.4.0: bumped the version, the first `make check-fast` failed on a stale static-text.json, ran `npm run prompts:text`, re-ran `make check-fast` (41 passed), tagged v2.4.0 and pushed.',
      lesson: 'Run `npm run prompts:text` before `make check-fast`.',
    })],
    oracle: { kind: 'saves-convention', required: 'prompts:text' },
  },
  {
    id: 'm2',
    family: 'user asks to save a procedure as a skill',
    digest: methodDigest('m2', 1, {
      objective: 'Regenerate the API client after the OpenAPI spec changed, and save this procedure as a skill so next time it is one step.',
      approach: 'pull the spec, generate, re-apply the local patch, type check',
      actionSignature: 'codegen:api-client',
      summary: 'Regenerated the API client: `npm run spec:pull` fetched openapi.yaml, `npx openapi-generator-cli generate -c codegen.yaml` rebuilt src/client, then `git apply patches/auth-interceptor.patch` re-applied the auth interceptor because the generator overwrites it, and `npm run typecheck` passed. The user asked to keep this procedure for next time.',
      lesson: 'After regenerating the client, re-apply patches/auth-interceptor.patch; the generator overwrites it.',
    }),
    priorDigests: [],
    oracle: { kind: 'saves-convention', required: 'auth-interceptor.patch' },
  },
];
