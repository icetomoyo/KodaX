/**
 * FEATURE_080 + FEATURE_081 (v0.7.23) — embedded agent example.
 *
 * Two ways to run an agent against the KodaX Layer A primitives:
 *
 *  1. Generic path — define an Agent, run it against your own LLM callback.
 *     Useful for SDK consumers who want the Agent / Runner / Session data
 *     shapes without pulling in the full KodaX coding runtime.
 *
 *  2. Preset path — use `createDefaultCodingAgent()` + pass `KodaXOptions`
 *     via `presetOptions`. Runner delegates to the built-in `runKodaX`
 *     pipeline (tools, reasoning, compaction, session persistence, ...).
 *
 * Run with tsx or after `npm run build`:
 *
 *     npx tsx examples/embedded-agent.ts
 */

import {
  createAgent,
  createDefaultCodingAgent,
  createInMemorySession,
  DefaultSummaryCompaction,
  Runner,
  type AgentMessage,
} from '@kodax/coding';

async function main(): Promise<void> {
  // ---------- Generic path: your own agent + your own LLM ----------
  const haiku = createAgent({
    name: 'haiku-writer',
    instructions: 'You write a single short haiku in response to any prompt.',
  });

  // Pluggable LLM callback. External consumers wire this to any provider.
  const mockLlm = async (messages: readonly AgentMessage[]): Promise<string> => {
    const lastUser = messages[messages.length - 1];
    const subject = typeof lastUser?.content === 'string' ? lastUser.content : 'the morning';
    return [
      `soft light on ${subject}`,
      `a bird moves between branches`,
      `the day begins slow`,
    ].join('\n');
  };

  const session = createInMemorySession();
  const haikuResult = await Runner.run(haiku, 'autumn leaves', { llm: mockLlm, session });
  console.log('--- generic path ---');
  console.log(haikuResult.output);

  // ---------- Compaction: standalone, no KodaX runtime needed ----------
  const compaction = new DefaultSummaryCompaction({ thresholdRatio: 0.8, keepRecent: 5 });
  if (compaction.shouldCompact(session, 10_000, 10_000)) {
    await compaction.compact(session, {
      tokensUsed: 10_000,
      budget: 10_000,
      summarize: async () => 'previously: wrote an autumn haiku',
    });
  }

  // ---------- Preset path: dog-food through runKodaX ----------
  //
  // Uncomment + configure a provider to run the real pipeline. Kept guarded
  // so this file can be type-checked / skimmed without provider setup.
  //
  // const codingAgent = createDefaultCodingAgent();
  // const codingResult = await Runner.run(codingAgent, 'explain this repo', {
  //   presetOptions: {
  //     provider: 'anthropic',
  //     context: { gitRoot: process.cwd() },
  //   },
  // });
  // console.log('--- preset path ---');
  // console.log(codingResult.output);
  void createDefaultCodingAgent;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
