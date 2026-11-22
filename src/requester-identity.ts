/**
 * Two identities travel with a request and answer different questions.
 *
 * `subject` is who the request acts for: the person this Host belongs to, or a
 * named backend service. Authorization compares it.
 *
 * `principalId` is which client instance sent it. Cleanup on client exit, lease
 * ownership and reverse-call routing use it.
 */
export interface RuntimeRequester {
  readonly principalId?: string;
  readonly subject?: string;
}

/**
 * Whether two requests act for the same party. Records written before subjects
 * existed carry only `principalId`, so a pair with a missing subject falls back
 * to comparing the client instance, which is what those records were checked
 * against when they were written.
 */
export function sameRequester(a: RuntimeRequester | undefined, b: RuntimeRequester | undefined): boolean {
  if (a?.subject !== undefined && b?.subject !== undefined) return a.subject === b.subject;
  return a?.principalId === b?.principalId;
}
