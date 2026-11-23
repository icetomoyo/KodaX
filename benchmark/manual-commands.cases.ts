/**
 * Cases for the manual commands eval (benchmark/manual-commands.eval.ts). Each case is a user question about the
 * KodaX CLI. The model has already called kodax_manual for one topic; the eval adds that topic as the tool result
 * and records the answer.
 */
export interface ManualCase {
  readonly name: string;
  readonly question: string;
  /** The topic the model asked kodax_manual for. */
  readonly topic: 'commands' | 'troubleshooting';
  /** What a useful answer contains, for the reviewer. */
  readonly useful: string;
}

export const CASES: readonly ManualCase[] = [
  {
    name: 'proxy-restart',
    question: 'I set HTTPS_PROXY for our company network, but KodaX requests still fail. What do I run so KodaX picks it up, and where can I see whether a request bypasses the proxy?',
    topic: 'troubleshooting',
    useful: 'Restart the Host with `kodax host restart`, then read `kodax host logs` for a `[runtime:network]` warning.',
  },
  {
    name: 'host-control',
    question: 'How do I check from the terminal whether the KodaX background Host is running, and how do I stop it?',
    topic: 'commands',
    useful: '`kodax host status` to check and `kodax host stop` to stop.',
  },
  {
    name: 'delete-session',
    question: '怎么在终端里删除一个旧的 KodaX 会话？',
    topic: 'commands',
    useful: '`kodax sessions delete <id>`, with `kodax sessions list` to find the id; `/delete` inside the REPL also works.',
  },
  {
    name: 'reasoning-off',
    question: 'In the KodaX REPL, how do I turn reasoning off? And is /thinking a different command from /reasoning?',
    topic: 'commands',
    useful: '`/reasoning off` (or `/effort off`), only where the model supports it; `/thinking` is an alias of `/reasoning`.',
  },
];
