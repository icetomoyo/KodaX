/**
 * Eval: v0.7.28 constructed-tool input_schema 透传 + dispatch 在 mimo-coding 上的冒烟。
 *
 * docs/features/v0.7.28.md "集成清单 / 集成" 节的 mimo-coding 冒烟项。验证：
 *   L1: mimo gateway 接受携带 constructed-tool schema 的请求（不报 4xx），证明
 *       AnthropicCompat 链路把 input_schema 透传给 mimo gateway 的协议在该 provider
 *       上无 regression
 *   L2: 模型真的能基于 schema 返回 tool_use（非 strict assertion——小模型可能
 *       直接走 text 回复；只 warn，不 fail）
 *
 * 运行：
 *   npm run test:eval -- tests/construction-mimo-smoke.eval.ts
 *
 * 需要：MIMO_API_KEY 环境变量
 * 无 key 时自动 skip（跟 ANTHROPIC eval 同一模式）
 */

import { describe, it, expect } from 'vitest';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax/ai';
import { getProvider } from '@kodax/ai';

/**
 * 一个最小的 constructed-tool schema：声明 path 输入，要求 read 能力。
 * 这正是 docs/features/v0.7.28.md 集成测试范例 "count-lines" 的 schema。
 */
const COUNT_LINES_TOOL: KodaXToolDefinition = {
  name: 'count_lines',
  description: 'Count newline-delimited lines in a file. Internal demo tool — DO NOT use in production.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file.' },
    },
    required: ['path'],
  },
};

describe('Eval: mimo-coding constructed-tool 透传 + dispatch 冒烟', () => {
  const hasKey = Boolean(process.env.MIMO_API_KEY);

  describe.skipIf(!hasKey)('mimo-coding (mimo-v2.5)', () => {
    it('L1: gateway 接受携带 constructed-tool input_schema 的请求 (不报 4xx)', async () => {
      const provider = getProvider('mimo-coding');
      const messages: KodaXMessage[] = [
        {
          role: 'user',
          content:
            'Smoke test: please ACK that you received a request whose tools[] contains a count_lines tool with input_schema.properties.path. Reply with a single word ACK if you can see it, or NOACK if you cannot. No tool call required.',
        },
      ];

      const result = await provider.stream(
        messages,
        [COUNT_LINES_TOOL],
        'You are a smoke-test assistant. Confirm the tool schema is visible. Be terse.',
      );

      // L1 关键断言：调用没抛错（如果 mimo 拒绝 schema，stream() 会以 4xx 抛 KodaXProviderError）
      const text = result.textBlocks.map((b) => b.text).join('').trim();
      expect(text.length).toBeGreaterThan(0);
      // 软日志：模型应该能看到 schema 并 ACK；记 console 不强断言（小模型可能不严格遵循）
      console.log('[mimo L1] response:', text.slice(0, 200));
      console.log('[mimo L1] tool_use blocks:', result.toolBlocks.length);
    }, 60_000);

    it('L2: 模型按 schema 调用 count_lines (期望但不强求 — 小模型可能走 text 回复)', async () => {
      const provider = getProvider('mimo-coding');
      const messages: KodaXMessage[] = [
        {
          role: 'user',
          content:
            'Use the count_lines tool to count lines in /tmp/sample.txt. Call the tool — do not just describe what you would do.',
        },
      ];

      const result = await provider.stream(
        messages,
        [COUNT_LINES_TOOL],
        'You have access to the count_lines tool. When asked to count lines, you MUST call the tool with the requested path. Output a tool_use block, not text.',
      );

      const calledTool = result.toolBlocks.length > 0;
      const calledRightTool = result.toolBlocks.some((b) => b.name === 'count_lines');
      const text = result.textBlocks.map((b) => b.text).join('').trim();

      console.log('[mimo L2] tool_use blocks:', result.toolBlocks.length);
      console.log('[mimo L2] called count_lines:', calledRightTool);
      console.log('[mimo L2] text response:', text.slice(0, 200));
      if (calledRightTool && result.toolBlocks[0]) {
        console.log('[mimo L2] tool input:', JSON.stringify(result.toolBlocks[0].input));
      }

      // 软断言：至少有 text 或 tool 输出。不强求 tool_use（mimo-v2.5 在简单 prompt 下可能直接 text 回复）
      expect(calledTool || text.length > 0).toBe(true);
    }, 60_000);
  });

  it('MIMO_API_KEY is configured (warning only)', () => {
    if (!hasKey) {
      console.warn(
        '[mimo smoke] MIMO_API_KEY not set. Skipping mimo-coding constructed-tool smoke probe.',
      );
    }
    expect(true).toBe(true);
  });
});
