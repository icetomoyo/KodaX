/**
 * Eval: Scout Harness Decision Quality
 *
 * Tests whether an LLM can correctly classify tasks into H0/H1/H2
 * using the three-level quality framework (senior engineer mental model).
 *
 * Run: npx vitest run tests/eval-scout-harness.test.ts
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════
// Three-level quality framework — the prompt under test
// ═══════════════════════════════════════════════════

const SCOUT_HARNESS_SYSTEM_PROMPT = `You are the Scout role in a multi-agent coding system. Your job is to assess a user's task and decide the appropriate harness level.

## Three Harness Levels

Think of yourself as a senior engineer who just received this task. Before writing any code, ask yourself:

**H0_DIRECT** — "I'd just do this myself. It's simple enough that no one needs to check my work."
Examples of this feeling: fixing a typo, answering a question, looking up a config value, writing a one-line change.

**H1_EXECUTE_EVAL** — "I know how to do this, but I'd want someone to review my work before shipping."
Examples of this feeling: fixing a specific bug, making a focused code change across a few files, doing a code review where my conclusions matter.

**H2_PLAN_EXECUTE_EVAL** — "I need to think about the approach first, maybe sketch it out or discuss with the team, before I start coding."
Examples of this feeling: building a new feature from scratch, refactoring across multiple modules, designing a new system, implementing something with multiple architectural decisions.

## Decision Process

1. Read the task description (and conversation context if provided)
2. Imagine you're a senior engineer at this company
3. Ask: "What would I do before starting?"
   - Just do it → H0_DIRECT
   - Do it then get review → H1_EXECUTE_EVAL
   - Plan first then do → H2_PLAN_EXECUTE_EVAL

## Output Format

Respond with ONLY a JSON object:
{"harness": "H0_DIRECT" | "H1_EXECUTE_EVAL" | "H2_PLAN_EXECUTE_EVAL", "reasoning": "<one sentence>"}`;

// ═══════════════════════════════════════════════════
// Test cases
// ═══════════════════════════════════════════════════

interface HarnessTestCase {
  id: string;
  prompt: string;
  context?: string;
  expected: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
  reason: string;
}

const TEST_CASES: HarnessTestCase[] = [
  // ─── H0: Trivial, no review needed ───
  {
    id: 'greeting',
    prompt: '你好',
    expected: 'H0_DIRECT',
    reason: 'Pure greeting, no task',
  },
  {
    id: 'branch-query',
    prompt: '当前处于哪个 git 分支？',
    expected: 'H0_DIRECT',
    reason: 'Simple lookup, one command',
  },
  {
    id: 'config-lookup',
    prompt: '帮我查一下 tsconfig.json 里的 target 配置是什么',
    expected: 'H0_DIRECT',
    reason: 'Read one file, report value',
  },
  {
    id: 'typo-fix',
    prompt: 'src/utils.ts 第 42 行 "recieve" 改成 "receive"',
    expected: 'H0_DIRECT',
    reason: 'Single character fix, obvious correctness',
  },
  {
    id: 'add-import',
    prompt: '在 src/index.ts 里加一行 import { foo } from "./foo"',
    expected: 'H0_DIRECT',
    reason: 'One-line addition, trivial',
  },
  {
    id: 'explain-code',
    prompt: '解释一下 packages/ai/src/providers/anthropic.ts 的 stream 方法做了什么',
    expected: 'H0_DIRECT',
    reason: 'Read and explain, no modification',
  },
  {
    id: 'git-status',
    prompt: '看一下当前有哪些未提交的改动',
    expected: 'H0_DIRECT',
    reason: 'Run git status, report results',
  },

  // ─── H1: Clear execution, needs review ───
  {
    id: 'focused-bugfix',
    prompt: '修复 src/auth.ts 中 validateToken 函数的空指针异常，当 token 为 undefined 时应该返回 false 而不是抛出错误',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Clear bug with clear fix, but behavior change needs verification',
  },
  {
    id: 'code-review',
    prompt: '帮我 review 一下当前分支的所有改动，给出具体的问题和建议',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Review conclusions need independent verification',
  },
  {
    id: 'add-error-handling',
    prompt: '给 packages/ai/src/providers/ 下所有 provider 的 stream 方法添加超时处理，超时时间从 config 读取',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Multi-file change with clear pattern, needs review',
  },
  {
    id: 'write-tests',
    prompt: '给 src/scorer.py 的 score_region 函数写单元测试，覆盖正常情况、空输入、异常输入',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Test writing is clear in scope but needs review for coverage quality',
  },
  {
    id: 'rename-refactor',
    prompt: '把项目里所有的 getUserInfo 重命名为 fetchUserProfile，包括函数名、变量名、注释和测试',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Mechanical refactor across files, needs review to catch missed references',
  },
  {
    id: 'security-audit',
    prompt: '检查 packages/coding/src/tools/ 目录下所有工具的输入验证是否完善，列出安全隐患',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Investigation with judgment calls, conclusions need verification',
  },
  {
    id: 'perf-fix',
    prompt: '用户反馈列表页加载很慢，profile 显示 fetchAllUsers 函数调用了 N+1 查询，优化一下',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Performance fix with known root cause, but optimization needs verification',
  },

  // ─── H2: Needs planning before execution ───
  {
    id: 'new-project',
    prompt: '用 Python 实现一个城市安全评分系统，用 kimi k2.5 做主评分，minimax M2.7 做交叉验证',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    reason: 'New project with architecture decisions, multiple files, multiple providers',
  },
  {
    id: 'new-feature-complex',
    prompt: '给 KodaX 添加一个插件系统，支持第三方开发者编写和发布插件，需要有插件注册、生命周期管理、权限隔离',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    reason: 'Major new feature with architectural decisions',
  },
  {
    id: 'cross-module-refactor',
    prompt: '把现在的单体 packages/coding 拆分成 packages/tools、packages/orchestration、packages/context 三个包',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    reason: 'Cross-module restructuring needs careful planning',
  },
  {
    id: 'migration',
    prompt: '把项目的数据库从 MongoDB 迁移到 PostgreSQL，保证零停机和数据一致性',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    reason: 'High-risk migration needs planning and phased execution',
  },
  {
    id: 'new-api',
    prompt: '设计并实现一套 RESTful API，包含用户认证、权限管理、数据 CRUD、文件上传、WebSocket 实时通知',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    reason: 'Multi-component system design from scratch',
  },
  {
    id: 'implement-from-prd',
    prompt: '按照 PRD 文档的要求实现这个功能，你先实现吧',
    context: '前几轮对话中讨论了一个包含双 Provider 架构、7 维评分、交叉验证的系统设计，PRD 已写好',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    reason: 'Implementation of a full system design discussed in context',
  },

  // ─── Edge cases ───
  {
    id: 'ambiguous-fix',
    prompt: '这个页面有 bug，用户点击提交按钮后没反应',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Bug report without clear cause — needs investigation then fix then review',
  },
  {
    id: 'ambiguous-implement-short',
    prompt: '你先实现吧',
    context: '前面讨论了一个需要 10 个文件的 Python 项目',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    reason: 'Short prompt but conversation context reveals complex implementation',
  },
  {
    id: 'docs-update',
    prompt: '更新 README.md，加上新的安装说明和 API 使用示例',
    expected: 'H0_DIRECT',
    reason: 'Documentation update, low risk',
  },
  {
    id: 'multi-file-but-mechanical',
    prompt: '给项目下所有 .ts 文件的头部加上 copyright 注释',
    expected: 'H1_EXECUTE_EVAL',
    reason: 'Touches many files but purely mechanical — needs review to catch misses',
  },
];

// ═══════════════════════════════════════════════════
// Multi-model eval runner
// ═══════════════════════════════════════════════════

type Harness = 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';

interface ProviderConfig {
  name: string;
  model: string;
  baseURL: string;
  apiKeyEnv: string;
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: 'kimi-code',
    model: 'k2.5',
    baseURL: 'https://api.kimi.com/coding/',
    apiKeyEnv: 'KIMI_API_KEY',
  },
  {
    name: 'zhipu-coding',
    model: 'glm-5.1',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    apiKeyEnv: 'ZHIPU_API_KEY',
  },
  {
    name: 'minimax-coding',
    model: 'MiniMax-M2.7',
    baseURL: 'https://api.minimaxi.com/anthropic',
    apiKeyEnv: 'MINIMAX_API_KEY',
  },
];

function createClient(provider: ProviderConfig): Anthropic | null {
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) return null;
  return new Anthropic({
    apiKey,
    baseURL: provider.baseURL,
    defaultHeaders: { 'User-Agent': 'KodaX' },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseHarnessResponse(text: string): { harness: Harness; reasoning: string } | null {
  // Strategy 1: Direct JSON parse
  const cleaned = text.replace(/```json\n?|\n?```/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.harness) return { harness: parsed.harness as Harness, reasoning: parsed.reasoning ?? '' };
  } catch { /* continue */ }

  // Strategy 2: Extract JSON object from surrounding text
  const jsonMatch = cleaned.match(/\{[\s\S]*?"harness"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (jsonMatch?.[1]) {
    const harness = jsonMatch[1] as Harness;
    const reasonMatch = jsonMatch[0].match(/"reasoning"\s*:\s*"([^"]*?)"/);
    return { harness, reasoning: reasonMatch?.[1] ?? '' };
  }

  // Strategy 3: Look for harness value anywhere in text
  const harnessMatch = text.match(/H([012])_(?:DIRECT|EXECUTE_EVAL|PLAN_EXECUTE_EVAL)/);
  if (harnessMatch?.[0]) {
    return { harness: harnessMatch[0] as Harness, reasoning: `[text-extract] ${text.slice(0, 150)}` };
  }

  return null;
}

async function queryScoutHarness(
  client: Anthropic,
  model: string,
  testCase: HarnessTestCase,
  retryDelayMs = 3000,
): Promise<{ harness: Harness; reasoning: string }> {
  const userMessage = testCase.context
    ? `[Conversation context: ${testCase.context}]\n\nCurrent user message: ${testCase.prompt}`
    : testCase.prompt;

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 300,
        system: SCOUT_HARNESS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      const parsed = parseHarnessResponse(text);
      if (parsed) return parsed;

      // All parse strategies failed — log raw output for debugging
      return {
        harness: 'H0_DIRECT',
        reasoning: `[UNPARSEABLE] raw=${text.slice(0, 300)}`,
      };
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      const isRetryable = status === 529 || status === 429 || status === 500 || status === 503;
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = retryDelayMs * (attempt + 1); // Linear backoff
        console.warn(`  [${model}] ${status} on attempt ${attempt + 1}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  return { harness: 'H0_DIRECT', reasoning: '[MAX_RETRIES_EXCEEDED]' };
}

interface EvalResult {
  id: string;
  expected: Harness;
  actual: Harness;
  correct: boolean;
  reasoning: string;
}

function printSummary(providerName: string, model: string, results: EvalResult[]): void {
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const accuracy = correct / total;

  const byLevel: Record<Harness, { total: number; correct: number }> = {
    H0_DIRECT: { total: 0, correct: 0 },
    H1_EXECUTE_EVAL: { total: 0, correct: 0 },
    H2_PLAN_EXECUTE_EVAL: { total: 0, correct: 0 },
  };
  for (const r of results) {
    byLevel[r.expected].total++;
    if (r.correct) byLevel[r.expected].correct++;
  }

  console.log(`\n── ${providerName} / ${model} ──`);
  console.log(`Overall: ${correct}/${total} (${(accuracy * 100).toFixed(0)}%)`);
  for (const [level, stats] of Object.entries(byLevel)) {
    const pct = stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(0) : 'N/A';
    console.log(`  ${level}: ${stats.correct}/${stats.total} (${pct}%)`);
  }
  const mismatches = results.filter((r) => !r.correct);
  if (mismatches.length > 0) {
    console.log('Mismatches:');
    for (const m of mismatches) {
      console.log(`  ${m.id}: expected ${m.expected}, got ${m.actual} — ${m.reasoning}`);
    }
  }
}

// ═══════════════════════════════════════════════════
// Tests — one describe per provider
// ═══════════════════════════════════════════════════

const allProviderResults: Array<{ provider: string; model: string; results: EvalResult[] }> = [];

for (const provider of PROVIDERS) {
  describe(`Eval: ${provider.name} / ${provider.model}`, () => {
    const client = createClient(provider);
    if (!client) {
      it.skip(`${provider.apiKeyEnv} not set`, () => {});
      return;
    }

    const results: EvalResult[] = [];

    let requestCount = 0;
    for (const testCase of TEST_CASES) {
      it(`[${testCase.expected}] ${testCase.id}`, async () => {
        // Stagger requests to avoid rate limits (especially MiniMax)
        if (requestCount > 0) await sleep(1500);
        requestCount++;
        const result = await queryScoutHarness(client, provider.model, testCase);
        const correct = result.harness === testCase.expected;
        results.push({
          id: testCase.id,
          expected: testCase.expected,
          actual: result.harness,
          correct,
          reasoning: result.reasoning,
        });

        if (!correct) {
          console.error(
            `\n  MISMATCH [${provider.name}/${testCase.id}]` +
            `\n    Expected: ${testCase.expected}` +
            `\n    Actual:   ${result.harness}` +
            `\n    Reason:   ${result.reasoning}`,
          );
        }

        expect(result.harness).toBe(testCase.expected);
      }, 90_000);
    }

    it(`summary: ${provider.name} accuracy >= 80%`, () => {
      if (results.length === 0) return;
      allProviderResults.push({ provider: provider.name, model: provider.model, results: [...results] });
      printSummary(provider.name, provider.model, results);
      const accuracy = results.filter((r) => r.correct).length / results.length;
      expect(accuracy).toBeGreaterThanOrEqual(0.8);
    });
  });
}

// Cross-model comparison
describe('Eval: Cross-model comparison', () => {
  it('comparison table', () => {
    if (allProviderResults.length === 0) return;

    console.log('\n══════════════════════════════════════════════════');
    console.log('Cross-Model Scout Harness Decision Comparison');
    console.log('══════════════════════════════════════════════════');

    // Header
    const names = allProviderResults.map((p) => `${p.provider}/${p.model}`);
    console.log(`${'Test Case'.padEnd(30)} ${names.map((n) => n.padEnd(20)).join('')}`);
    console.log('─'.repeat(30 + names.length * 20));

    // Per-case comparison
    for (const testCase of TEST_CASES) {
      const cells = allProviderResults.map((p) => {
        const r = p.results.find((r) => r.id === testCase.id);
        if (!r) return '?'.padEnd(20);
        const icon = r.correct ? '✓' : '✗';
        const short = r.actual.replace('_EXECUTE_EVAL', '').replace('_PLAN_EXECUTE_EVAL', '').replace('_DIRECT', '');
        return `${icon} ${short}`.padEnd(20);
      });
      console.log(`${testCase.id.padEnd(30)} ${cells.join('')}`);
    }

    // Summary row
    console.log('─'.repeat(30 + names.length * 20));
    const summaries = allProviderResults.map((p) => {
      const acc = p.results.filter((r) => r.correct).length;
      return `${acc}/${p.results.length}`.padEnd(20);
    });
    console.log(`${'TOTAL'.padEnd(30)} ${summaries.join('')}`);
    console.log('══════════════════════════════════════════════════\n');
  });
});
