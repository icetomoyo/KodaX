/**
 * Parse the auto-mode classifier's output — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * Preferred format:
 *   <decision>allow|ask</decision><hazard>...</hazard><reason>...</reason>
 * Legacy `<block>` output remains parseable during the protocol rollout so a
 * valid decision from an older prompt/provider cache is not misreported as an
 * infrastructure failure.
 *
 * Robustness:
 *   - case-insensitive yes/no
 *   - whitespace inside / around tags tolerated
 *   - one valid decision is authoritative; hazard/reason defects are retained
 *     as warnings and never become a second decision mechanism
 *   - reasons longer than 500 chars are truncated (defense against
 *     pathological model outputs)
 *   - missing, invalid, duplicate, or mixed decisions remain contract errors;
 *     surrounding prose and malformed auxiliary fields are diagnostic only
 */

export type ClassifierDecision =
  | {
    readonly kind: 'block'; readonly reason: string; readonly hazard?: ClassifierHazard;
    readonly protocol: ClassifierProtocol;
    readonly warnings?: readonly ClassifierOutputWarningCode[];
  }
  | {
    readonly kind: 'allow'; readonly reason: string; readonly hazard?: 'none';
    readonly protocol: ClassifierProtocol;
    readonly warnings?: readonly ClassifierOutputWarningCode[];
  }
  | {
    readonly kind: 'unparseable'; readonly raw: string;
    readonly failureCode: ClassifierParseFailureCode;
    readonly observedProtocol: ClassifierObservedProtocol;
  };

export type ClassifierProtocol = 'structured_v2' | 'legacy_v1';
export type ClassifierObservedProtocol = ClassifierProtocol | 'unknown';
export type ClassifierParseFailureCode =
  | 'missing_decision'
  | 'invalid_decision'
  | 'ambiguous_decision'
  // Historical 0.7.79 events may contain these former failure codes.
  | 'missing_hazard'
  | 'invalid_hazard'
  | 'decision_hazard_conflict'
  | 'decision_reason_conflict'
  | 'missing_reason'
  | 'structured_format_violation'
  | 'legacy_format_violation';

export type ClassifierOutputWarningCode = Exclude<
  ClassifierParseFailureCode,
  'missing_decision' | 'invalid_decision' | 'ambiguous_decision'
>;

export type ClassifierHazard =
  | 'none'
  | 'protected_read'
  | 'outside_write'
  | 'destructive_loss'
  | 'credential_exposure'
  | 'network_exfiltration'
  | 'remote_code_execution'
  | 'dependency_poisoning'
  | 'production_change'
  | 'privilege_change'
  | 'intent_conflict';

const BLOCK_RE = /<block>\s*([^<]+?)\s*<\/block>/i;
const LEGACY_CONTRACT_RE = /^\s*<block>\s*([^<]+?)\s*<\/block>(?:\s*<reason>\s*([^<]*?)\s*<\/reason>)?\s*$/i;
const STRUCTURED_CONTRACT_RE = /^\s*<decision>\s*([^<]+?)\s*<\/decision>\s*<hazard>\s*([^<]+?)\s*<\/hazard>\s*<reason>\s*([^<]*?)\s*<\/reason>\s*$/i;
const DECISION_MARKER_RE = /<\s*\/?\s*decision(?=\s|\/?>)/i;
const BLOCK_MARKER_RE = /<\s*\/?\s*block(?=\s|\/?>)/i;
const STRUCTURED_MARKER_RE = /<\s*\/?\s*(?:decision|hazard)(?=\s|\/?>)/i;
const HAZARD_RE = /<hazard>\s*([^<]+?)\s*<\/hazard>/i;
const REASON_RE = /<reason>\s*([\s\S]*?)\s*<\/reason>/i;
const MAX_REASON_LEN = 500;
const ASK_REASON_FALLBACK = 'Auto[LLM] reviewer raised a concrete concern.';
const NO_HAZARD_REASON = /\b(?:blocking (?:this action )?is unnecessary|(?:this\s+action\s+)?should not be blocked|does not require (?:user )?(?:confirmation|approval|permission)|no (?:user )?(?:confirmation|approval|permission) (?:is )?(?:needed|required)|(?:proceed|continue) without (?:user )?(?:confirmation|approval|permission)|no (?:concrete |material )?(?:hazard|risk|danger)|(?:this|the)?\s*(?:action|operation|command|request|it)\s+(?:is|appears|seems|looks)\s+(?:safe|harmless)|not (?:dangerous|harmful))\b|(?:无需|不需要)(?:用户)?(?:确认|授权|许可)|没有(?:明确|具体|实质)?(?:危害|危险|风险)|(?:操作|动作|命令|请求)?(?:是|看起来)?(?:安全|无害)|并不危险/i;
const NEGATED_CONFIRMATION_REASON = /\b(?:(?:(?:does|do)\s+not|doesn't|don't)\s+(?:require|need)\s+(?:user\s+)?(?:confirmation|approval|permission)|(?:user\s+)?(?:confirmation|approval|permission)\s+is\s+not\s+required|no\s+(?:user\s+)?(?:confirmation|approval|permission)\s+(?:is\s+)?(?:needed|required))\b/gi;
const REQUIRES_CONFIRMATION_REASON = /\b(?:(?:requires?|needs?)\s+(?:user\s+)?(?:confirmation|approval|permission)|(?:should|must)\s+(?:be\s+)?(?:blocked|confirmed)|ask\s+(?:the\s+)?user(?:\s+first)?|(?:await|wait\s+for)\s+(?:the\s+)?(?:user(?:'s)?\s+)?(?:confirmation|approval|permission)|(?:request|obtain)\s+(?:the\s+)?(?:user(?:'s)?\s+)?(?:confirmation|approval|permission)|confirm\s+before\s+(?:proceeding|continuing)|(?:confirmation|approval|permission)\s+(?:is\s+recommended|(?:should|must|needs?\s+to)\s+(?:be\s+)?(?:requested|obtained|required|recommended)))\b|(?:需要|应当|必须)(?:用户)?(?:确认|授权|许可)|(?:询问|等待).{0,8}(?:用户)?(?:确认|授权|许可)/i;
const HAZARD_REASON = /\b(?:(?:this|it|the\s+(?:action|operation|command|request))\s+(?:is|appears|seems|looks)\s+(?!not\b)(?:(?:potentially\s+)?(?:dangerous|unsafe|hazardous|risky|harmful))|(?:could|may|might|can)\s+(?!not\b)(?:(?:be\s+)?(?:dangerous|unsafe|hazardous|risky|harmful|expose|leak|disclose)\b|(?:delete|destroy|overwrite|erase|remove|wipe|corrupt)\b[\s\S]{0,24}\b(?:data|files?|repository|repo|configuration|config)\b|cause\b[\s\S]{0,16}\bdata\s+loss\b|(?:send|transmit|upload|exfiltrate|leak|disclose|expose|reveal|publish)\b[\s\S]{0,32}\b(?:secrets?|credentials?|tokens?|keys?)\b)|(?:poses?|creates?|introduces?)\s+(?:a\s+)?(?:material\s+)?(?:hazard|risk|danger)|(?:risk|hazard|danger)\s+of)\b|(?:存在|造成|引入)(?:明确|具体|实质)?(?:危害|危险|风险)|(?:操作|动作|命令|请求)(?:很|是)?(?:危险|不安全)/i;

function reasonRequiresConfirmation(reason: string): boolean {
  return REQUIRES_CONFIRMATION_REASON.test(reason.replace(NEGATED_CONFIRMATION_REASON, ' '));
}
const CLASSIFIER_HAZARDS = new Set<ClassifierHazard>([
  'none',
  'protected_read',
  'outside_write',
  'destructive_loss',
  'credential_exposure',
  'network_exfiltration',
  'remote_code_execution',
  'dependency_poisoning',
  'production_change',
  'privilege_change',
  'intent_conflict',
]);

export function parseClassifierOutput(raw: string): ClassifierDecision {
  const contract = unwrapExclusiveMarkdownFence(raw);
  const decision = parseClassifierContract(contract);
  return decision.kind === 'unparseable' && contract !== raw
    ? { ...decision, raw }
    : decision;
}

function parseClassifierContract(raw: string): ClassifierDecision {
  const hasStructuredMarker = STRUCTURED_MARKER_RE.test(raw);
  if (!DECISION_MARKER_RE.test(raw) && BLOCK_RE.test(raw)) return parseLegacyDecision(raw);
  return parseStructuredDecision(raw, hasStructuredMarker ? 'structured_v2' : 'unknown');
}

function unwrapExclusiveMarkdownFence(raw: string): string {
  const match = /^\s*```(?:xml)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(raw);
  return match?.[1] ?? raw;
}

function parseLegacyDecision(raw: string): ClassifierDecision {
  const blockValues = collectTagValues(raw, 'block');
  if (blockValues.length !== 1 || countTagMarkers(raw, 'block') !== 2) {
    return unparseable(raw, 'ambiguous_decision', 'legacy_v1');
  }
  const verdict = blockValues[0]!;
  if (verdict !== 'yes' && verdict !== 'no') {
    return unparseable(raw, 'invalid_decision', 'legacy_v1');
  }
  const warnings: ClassifierOutputWarningCode[] = [];
  const reason = readReason(raw.match(REASON_RE), warnings);
  if (!LEGACY_CONTRACT_RE.test(raw)) addWarning(warnings, 'legacy_format_violation');
  const reasonConflicts = verdict === 'yes'
    ? NO_HAZARD_REASON.test(reason)
    : reasonRequiresConfirmation(reason) || HAZARD_REASON.test(reason);
  if (reasonConflicts) addWarning(warnings, 'decision_reason_conflict');
  return parsedDecision(
    verdict === 'yes' ? 'block' : 'allow',
    verdict === 'yes' && (!reason || reasonConflicts) ? ASK_REASON_FALLBACK : reason,
    'legacy_v1',
    undefined,
    warnings,
  );
}

function parseStructuredDecision(
  raw: string,
  observedProtocol: ClassifierObservedProtocol,
): ClassifierDecision {
  const decisionValues = collectTagValues(raw, 'decision');
  if (decisionValues.length === 0) {
    return unparseable(raw, 'missing_decision', observedProtocol);
  }
  if (
    decisionValues.length !== 1
    || countTagMarkers(raw, 'decision') !== 2
    || BLOCK_MARKER_RE.test(raw)
  ) {
    return unparseable(raw, 'ambiguous_decision', 'structured_v2');
  }
  const decision = decisionValues[0]!;
  if (decision !== 'allow' && decision !== 'ask') {
    return unparseable(raw, 'invalid_decision', 'structured_v2');
  }
  const warnings: ClassifierOutputWarningCode[] = [];
  const hazardMatch = raw.match(HAZARD_RE);
  const hazardValue = hazardMatch?.[1]?.trim().toLowerCase();
  let hazard: ClassifierHazard | undefined;
  if (!hazardMatch) {
    addWarning(warnings, 'missing_hazard');
  } else if (!hazardValue || !CLASSIFIER_HAZARDS.has(hazardValue as ClassifierHazard)) {
    addWarning(warnings, 'invalid_hazard');
  } else {
    hazard = hazardValue as ClassifierHazard;
  }
  const reasonMatch = raw.match(REASON_RE);
  const reason = readReason(reasonMatch, warnings);
  if (hazardMatch && reasonMatch && !STRUCTURED_CONTRACT_RE.test(raw)) {
    addWarning(warnings, 'structured_format_violation');
  }
  if (hazard !== undefined && (
    (decision === 'allow' && hazard !== 'none')
    || (decision === 'ask' && hazard === 'none')
  )) {
    addWarning(warnings, 'decision_hazard_conflict');
  }
  const reasonConflicts = decision === 'allow'
    ? reasonRequiresConfirmation(reason) || HAZARD_REASON.test(reason)
    : NO_HAZARD_REASON.test(reason);
  if (reasonConflicts) addWarning(warnings, 'decision_reason_conflict');
  return parsedDecision(
    decision === 'ask' ? 'block' : 'allow',
    decision === 'ask' && (!reason || reasonConflicts) ? ASK_REASON_FALLBACK : reason,
    'structured_v2',
    hazard,
    warnings,
  );
}

function collectTagValues(raw: string, tag: 'block' | 'decision'): string[] {
  const pattern = new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, 'gi');
  return [...raw.matchAll(pattern)].map((match) => match[1]!.trim().toLowerCase());
}

function countTagMarkers(raw: string, tag: 'block' | 'decision'): number {
  const pattern = new RegExp(`<\\s*\\/?\\s*${tag}(?=\\s|/?>)`, 'gi');
  return [...raw.matchAll(pattern)].length;
}

function readReason(
  match: RegExpMatchArray | null,
  warnings: ClassifierOutputWarningCode[],
): string {
  const reason = truncateReason(match?.[1]?.trim() ?? '');
  if (!reason) addWarning(warnings, 'missing_reason');
  return reason;
}

function addWarning(
  warnings: ClassifierOutputWarningCode[],
  warning: ClassifierOutputWarningCode,
): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function parsedDecision(
  kind: 'allow' | 'block',
  reason: string,
  protocol: ClassifierProtocol,
  hazard: ClassifierHazard | undefined,
  warnings: readonly ClassifierOutputWarningCode[],
): ClassifierDecision {
  const common = {
    reason,
    protocol,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  if (kind === 'allow') {
    return {
      kind: 'allow',
      ...common,
      ...(hazard === 'none' ? { hazard } : {}),
    };
  }
  return {
    kind: 'block',
    ...common,
    ...(hazard !== undefined ? { hazard } : {}),
  };
}

function unparseable(
  raw: string,
  failureCode: ClassifierParseFailureCode,
  observedProtocol: ClassifierObservedProtocol,
): ClassifierDecision {
  return { kind: 'unparseable', raw, failureCode, observedProtocol };
}

function truncateReason(reason: string): string {
  return reason.length > MAX_REASON_LEN
    ? `${reason.slice(0, MAX_REASON_LEN - 1)}…`
    : reason;
}
