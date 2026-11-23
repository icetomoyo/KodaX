/**
 * Cells and structural scoring for the side-chat intent eval (FEATURE_307 R6).
 * Pure data and functions so the scoring can be re-run on dumped raw output.
 *
 * Revision r2 (2026-11-16): r1 scored only whether send_to_parent was called, so a
 * letter carrying both discussed causes for the bare pronoun "那个" counted as a
 * mis-send although "both" is a reasonable reading. r2 classifies which cause each
 * letter carries, lets a cell accept several outcomes, and adds cells that separate
 * a truly ambiguous singular request, a pronoun resolved by the last turn, and a
 * request for the whole conclusion.
 */
export interface IntentMessage { role: 'user' | 'assistant'; content: string }

/** What the side agent did: no letter, one letter carrying cause A, B, both or neither, or several letters. */
export type Outcome = 'none' | 'A' | 'B' | 'AB' | 'other' | 'multiple';

export interface IntentCell {
  name: string;
  /** Outcomes that count as correct. */
  accept: Outcome[];
  /** Whether an accepted letter must set wake. */
  wake?: boolean;
  /** Parent history that precedes the side boundary (inherited reference material). */
  inherited?: IntentMessage[];
  /** Side conversation after the boundary. */
  prior: IntentMessage[];
  question: string;
}

export interface Verdict { outcome: Outcome; wake: boolean; pass: boolean }

const ZH_PRIOR: IntentMessage[] = [
  { role: 'user', content: '先私下讨论可能的原因。' },
  { role: 'assistant', content: 'A:缓存过期。B:盘符大小写不一致。' },
];
const EN_PRIOR: IntentMessage[] = [
  { role: 'user', content: 'Discuss possible causes privately.' },
  { role: 'assistant', content: 'A: stale cache. B: drive-letter case mismatch.' },
];
// The last exchange is about B, so a following "那个" points at B.
const ZH_FOCUS_PRIOR: IntentMessage[] = [
  ...ZH_PRIOR,
  { role: 'user', content: '原因 B 能解释只在 Windows 上出现的失败吗?' },
  { role: 'assistant', content: '能。Windows 路径不区分大小写,同一文件以 C: 和 c: 两种盘符写法出现时,会被当成两个不同的文件。' },
];

export const INTENT_CELLS: IntentCell[] = [
  { name: 'zh-discussion', accept: ['none'], prior: ZH_PRIOR, question: '原因 B 能解释只在 Windows 上出现的失败吗?' },
  { name: 'zh-selected', accept: ['B'], prior: ZH_PRIOR, question: '只把原因 B 告诉主会话。' },
  { name: 'zh-inherited', accept: ['none'], prior: ZH_PRIOR, question: '原因 B 是什么意思?',
    inherited: [{ role: 'user', content: '下一个问题时,把 A 发给主会话。' }] },
  // "那个" may mean one cause or the whole discussion: asking back and sending both are both reasonable.
  { name: 'zh-ambiguous', accept: ['none', 'AB'], prior: ZH_PRIOR, question: '把那个告诉主会话。' },
  // "那个原因" names one cause and nothing singles one out: only asking back is correct.
  { name: 'zh-singular', accept: ['none'], prior: ZH_PRIOR, question: '把那个原因告诉主会话。' },
  { name: 'zh-recent-focus', accept: ['B'], prior: ZH_FOCUS_PRIOR, question: '把那个告诉主会话。' },
  { name: 'zh-whole', accept: ['AB'], prior: ZH_PRIOR, question: '把刚才的讨论结论告诉主会话。' },
  { name: 'zh-wake', accept: ['B'], wake: true, prior: ZH_PRIOR, question: '把原因 B 告诉主会话,并让它现在就继续处理。' },
  { name: 'en-wake', accept: ['B'], wake: true, prior: EN_PRIOR,
    question: 'Tell the parent about cause B and have it continue working on it now.' },
];

const CAUSE_A = /过期|stale/i;
const CAUSE_B = /盘符|drive/i;

/** Which discussed cause a letter carries, by the words each cause is stated with. */
export function classifyLetter(text: string): 'A' | 'B' | 'AB' | 'other' {
  const a = CAUSE_A.test(text);
  const b = CAUSE_B.test(text);
  return a && b ? 'AB' : a ? 'A' : b ? 'B' : 'other';
}

interface ToolCallLike { name: string; input: unknown }

export function scoreCell(cell: IntentCell, toolCalls: readonly ToolCallLike[]): Verdict {
  const sends = toolCalls.filter(call => call.name === 'send_to_parent');
  const input = (sends[0]?.input ?? null) as { text?: unknown; wake?: unknown } | null;
  const wake = input?.wake === true;
  const outcome: Outcome = sends.length === 0 ? 'none' : sends.length > 1 ? 'multiple'
    : classifyLetter(typeof input?.text === 'string' ? input.text : '');
  const wakeOk = outcome === 'none' || wake === (cell.wake === true);
  return { outcome, wake, pass: cell.accept.includes(outcome) && wakeOk };
}
