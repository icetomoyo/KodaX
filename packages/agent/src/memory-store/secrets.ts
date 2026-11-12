/**
 * FEATURE_306 — secret detection by token SHAPE. The older sanitizer matches
 * phrases ("api key is ..."), so `sk-live-...` slipped through whenever the
 * surrounding sentence avoided those phrases (Phase 0 case w4).
 *
 * Returns the kind only; never the matched text, so a rejection message cannot
 * itself leak the secret.
 */

export interface SecretFinding {
  readonly kind: string;
}

const SHAPES: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: 'provider API key', pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/ },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { kind: 'AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'bearer credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
];

const CREDENTIAL_ASSIGNMENT =
  /\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY)\b\s*[:=]\s*["']?([^\s"']{8,})/i;

/** 32+ url-safe chars mixing upper, lower and digits (no `/`, so paths do not match). */
const OPAQUE_BLOB = /[A-Za-z0-9_+-]{32,}/g;

function isOpaqueBlob(token: string): boolean {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token);
}

export function findSecret(text: string): SecretFinding | undefined {
  for (const shape of SHAPES) {
    if (shape.pattern.test(text)) return { kind: shape.kind };
  }
  const assigned = CREDENTIAL_ASSIGNMENT.exec(text)?.[1];
  if (assigned !== undefined && (/\d/.test(assigned) || assigned.length >= 16)) {
    return { kind: 'credential assignment' };
  }
  for (const token of text.match(OPAQUE_BLOB) ?? []) {
    if (isOpaqueBlob(token)) return { kind: 'opaque secret-like string' };
  }
  return undefined;
}
