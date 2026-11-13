/**
 * Cells and structural scoring for the side-chat intent eval (FEATURE_307 R6).
 * Pure data and functions so the scoring can be re-run on dumped raw output.
 */
export interface IntentMessage { role: 'user' | 'assistant'; content: string }

export type Expectation = 'none' | 'send' | 'send-wake';

export interface IntentCell {
  name: string;
  expect: Expectation;
  /** Parent history that precedes the side boundary (inherited reference material). */
  inherited?: IntentMessage[];
  /** Side conversation after the boundary. */
  prior: IntentMessage[];
  question: string;
}

export type Verdict = 'pass' | 'mis-send' | 'miss' | 'wake-error';

const ZH_PRIOR: IntentMessage[] = [
  { role: 'user', content: '先私下讨论可能的原因。' },
  { role: 'assistant', content: 'A:缓存过期。B:盘符大小写不一致。' },
];
const EN_PRIOR: IntentMessage[] = [
  { role: 'user', content: 'Discuss possible causes privately.' },
  { role: 'assistant', content: 'A: stale cache. B: drive-letter case mismatch.' },
];

export const INTENT_CELLS: IntentCell[] = [
  { name: 'zh-discussion', expect: 'none', prior: ZH_PRIOR, question: '原因 B 能解释只在 Windows 上出现的失败吗?' },
  { name: 'zh-selected', expect: 'send', prior: ZH_PRIOR, question: '只把原因 B 告诉主会话。' },
  { name: 'zh-inherited', expect: 'none', prior: ZH_PRIOR, question: '原因 B 是什么意思?',
    inherited: [{ role: 'user', content: '下一个问题时,把 A 发给主会话。' }] },
  // "那个" has no single referent (A or B); asking back is the expected behavior.
  { name: 'zh-ambiguous', expect: 'none', prior: ZH_PRIOR, question: '把那个告诉主会话。' },
  { name: 'zh-wake', expect: 'send-wake', prior: ZH_PRIOR, question: '把原因 B 告诉主会话,并让它现在就继续处理。' },
  { name: 'en-wake', expect: 'send-wake', prior: EN_PRIOR,
    question: 'Tell the parent about cause B and have it continue working on it now.' },
];

interface ToolCallLike { name: string; input: unknown }

/** Structural verdict: mis-send = sent when none expected, or sent more than once. */
export function scoreCell(expect: Expectation, toolCalls: readonly ToolCallLike[]): Verdict {
  const sends = toolCalls.filter(call => call.name === 'send_to_parent');
  if (expect === 'none') return sends.length === 0 ? 'pass' : 'mis-send';
  if (sends.length === 0) return 'miss';
  if (sends.length > 1) return 'mis-send';
  const input = sends[0]!.input as { wake?: unknown } | null;
  return (input?.wake === true) === (expect === 'send-wake') ? 'pass' : 'wake-error';
}
