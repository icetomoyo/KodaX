const RUNTIME_EVIDENCE_MARKERS = [
  'failing test',
  'tests fail',
  'test failed',
  'tests failed',
  'stack trace',
  'runtime error',
  'exception',
  'assertion failed',
  'traceback',
  'stderr',
  'error log',
  '[tool error]',
  '[stderr]',
  'exit: 1',
  'exit code 1',
  'timeout',
  '\u8d85\u65f6',
  '\u6d4b\u8bd5\u5931\u8d25',
  '\u62a5\u9519',
  '\u9519\u8bef',
  '\u5f02\u5e38',
];

const TRANSIENT_RETRY_MARKERS = [
  'timeout',
  'timed out',
  'stream stalled',
  'delayed response',
  '\u8d85\u65f6',
];

const EXIT_CODE_PATTERN = /\bexit:\s*[1-9]\d*\b|\bexit code\s*[1-9]\d*\b/i;

export function hasTransientRetryEvidence(text: string): boolean {
  const normalized = text.toLowerCase();
  return TRANSIENT_RETRY_MARKERS.some((marker) => normalized.includes(marker));
}

export function hasNonTransientRuntimeEvidence(text: string): boolean {
  const normalized = text.toLowerCase();
  return RUNTIME_EVIDENCE_MARKERS
    .filter((marker) => !TRANSIENT_RETRY_MARKERS.includes(marker))
    .some((marker) => normalized.includes(marker));
}

export function looksLikeActionableRuntimeEvidence(text: string): boolean {
  return hasNonTransientRuntimeEvidence(text) || EXIT_CODE_PATTERN.test(text);
}
