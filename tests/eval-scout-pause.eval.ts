/**
 * Eval: Scout "One Pause" Mechanism — Harness Decision at Write-Tool Moment
 *
 * Tests two scenarios:
 * A. "Full tools" (Solution 1): Scout has full tools, classifies the task
 * B. "One pause" (new proposal): Scout tried a write tool and was paused —
 *    does it correctly decide to retry (H0) or escalate (H1/H2)?
 *
 * Both scenarios give the Scout the CONTEXT of having already investigated.
 * This simulates the moment AFTER investigation, when Scout is about to act.
 *
 * Run: npx vitest run tests/eval-scout-pause.eval.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════
// Scenario A: Full tools — classify after investigation
// ═══════════════════════════════════════════════════

const FULL_TOOLS_SYSTEM_PROMPT = `You are the Scout role in a multi-agent coding system. You have FULL access to all tools (read, write, edit, bash). Your job is to assess the task and decide the harness level.

## Three Harness Levels

Think of yourself as a senior engineer who just received this task. Ask yourself: "What would I do before starting?"

**H0_DIRECT** — "I'd just do this myself. It's simple enough that no one needs to check my work."
Examples: fixing a typo, answering a question, git commit, one-line change.

**H1_EXECUTE_EVAL** — "I know how to do this, but I'd want someone to review my work before shipping."
Examples: fixing a specific bug, focused code change across a few files, code review.

**H2_PLAN_EXECUTE_EVAL** — "I need to think about the approach first."
Examples: new feature from scratch, cross-module refactoring, system design.

IMPORTANT: Even though you CAN do everything with your tools, you must still honestly assess whether the task SHOULD have review (H1) or planning (H2). Having the ability to do something doesn't mean it should skip quality checks.

Respond with ONLY a JSON object:
{"harness": "H0_DIRECT" | "H1_EXECUTE_EVAL" | "H2_PLAN_EXECUTE_EVAL", "reasoning": "<one sentence>"}`;

// ═══════════════════════════════════════════════════
// Scenario B: One pause — decision at write-tool moment
// ═══════════════════════════════════════════════════

const ONE_PAUSE_SYSTEM_PROMPT = `You are the Scout role in a multi-agent coding system. You were investigating a task using read-only tools. You just attempted to use a WRITE tool, and the system paused you with a harness check.

## Your Situation

You have already investigated the task (read files, checked status, understood scope). Now you tried to execute a write operation, and the system is asking you to make a conscious harness decision before proceeding.

## Three Harness Levels

**H0_DIRECT** — "I'd just do this myself. It's simple enough that no one needs to check my work."
→ If you choose H0: respond with {"action": "retry", ...} and the write tool will be allowed.

**H1_EXECUTE_EVAL** — "I know how to do this, but I'd want someone to review my work before shipping."
→ If you choose H1: respond with {"action": "escalate", ...} and a dedicated Generator+Evaluator pipeline will handle it.

**H2_PLAN_EXECUTE_EVAL** — "I need to think about the approach first."
→ If you choose H2: respond with {"action": "escalate", ...} and a Planner+Generator+Evaluator pipeline will handle it.

## Decision Rule

Ask yourself honestly: "Now that I've seen the code and understand the scope — should someone check my work on this?"
- No, it's trivial → H0 → retry
- Yes, it matters → H1 or H2 → escalate

Respond with ONLY a JSON object:
{"action": "retry" | "escalate", "harness": "H0_DIRECT" | "H1_EXECUTE_EVAL" | "H2_PLAN_EXECUTE_EVAL", "reasoning": "<one sentence>"}`;

// ═══════════════════════════════════════════════════
// Test cases — same tasks, different framing
// ═══════════════════════════════════════════════════

interface PauseTestCase {
  id: string;
  /** Task description */
  task: string;
  /** What Scout found during investigation (context for the pause scenario) */
  investigation: string;
  /** What write tool Scout tried */
  attemptedTool: string;
  /** Expected harness level */
  expected: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
  /** For pause scenario: expected action */
  expectedAction: 'retry' | 'escalate';
  reason: string;
}

const TEST_CASES: PauseTestCase[] = [
  // ─── H0: Should retry after pause ───
  {
    id: 'git-commit',
    task: '提交当前改动并推送远端',
    investigation: 'git status shows 2 modified files (agent.ts, task-engine.ts) with 8 lines changed. Changes are prompt text improvements.',
    attemptedTool: 'bash: git add -A && git commit -m "fix: improve protocol prompt"',
    expected: 'H0_DIRECT',
    expectedAction: 'retry',
    reason: 'Trivial git operation, no review needed',
  },
  {
    id: 'edit-gitignore',
    task: '把 node_modules 加入 .gitignore',
    investigation: 'Read .gitignore — 39 lines, standard Python project ignores. node_modules is not listed.',
    attemptedTool: 'edit: append "node_modules/" to .gitignore',
    expected: 'H0_DIRECT',
    expectedAction: 'retry',
    reason: 'Single-line addition to config file',
  },
  {
    id: 'fix-typo',
    task: 'src/utils.ts 第 42 行 "recieve" 改成 "receive"',
    investigation: 'Read src/utils.ts — confirmed typo on line 42.',
    attemptedTool: 'edit: replace "recieve" with "receive" in src/utils.ts',
    expected: 'H0_DIRECT',
    expectedAction: 'retry',
    reason: 'Obvious single-character fix',
  },
  {
    id: 'update-version',
    task: '把 package.json 里的 version 从 0.7.17 改成 0.7.18',
    investigation: 'Read package.json — version is "0.7.17".',
    attemptedTool: 'edit: replace "0.7.17" with "0.7.18" in package.json',
    expected: 'H0_DIRECT',
    expectedAction: 'retry',
    reason: 'Single-field version bump',
  },
  {
    id: 'delete-temp-file',
    task: '删除 tmp/debug.log',
    investigation: 'File exists, 234 lines of debug output. Not tracked by git.',
    attemptedTool: 'bash: rm tmp/debug.log',
    expected: 'H0_DIRECT',
    expectedAction: 'retry',
    reason: 'Delete a temp file, no risk',
  },
  {
    id: 'add-copyright',
    task: '给 src/index.ts 头部加上 MIT license 注释',
    investigation: 'Read src/index.ts — no license header. Project uses MIT license per package.json.',
    attemptedTool: 'edit: prepend MIT license comment to src/index.ts',
    expected: 'H0_DIRECT',
    expectedAction: 'retry',
    reason: 'Boilerplate addition to one file',
  },
  {
    id: 'docs-update',
    task: '更新 README 加上新的安装说明',
    investigation: 'Read README.md — missing installation section. Have the install steps ready.',
    attemptedTool: 'edit: add installation section to README.md',
    expected: 'H0_DIRECT',
    expectedAction: 'retry',
    reason: 'Documentation update, low risk',
  },

  // ─── H1: Should escalate after pause ───
  {
    id: 'fix-null-bug',
    task: '修复 validateToken 函数的空指针异常',
    investigation: 'Read src/auth.ts — validateToken does not check for undefined token. Also found 3 callers that pass unvalidated input. Need to fix the function AND update callers.',
    attemptedTool: 'edit: add null check to validateToken in src/auth.ts',
    expected: 'H1_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'Multi-site fix with behavior change needs review',
  },
  {
    id: 'add-timeout-handling',
    task: '给所有 provider 的 stream 方法添加超时处理',
    investigation: 'Found 4 provider files (anthropic.ts, openai.ts, kimi.ts, gemini.ts). Each has a stream method. Need to add consistent timeout pattern to all 4.',
    attemptedTool: 'edit: add timeout wrapper to anthropic.ts stream method',
    expected: 'H1_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'Multi-file consistent change needs review for correctness',
  },
  {
    id: 'rename-across-project',
    task: '把所有 getUserInfo 重命名为 fetchUserProfile',
    investigation: 'grep found 23 occurrences across 12 files including tests, imports, and JSDoc comments.',
    attemptedTool: 'edit: rename getUserInfo to fetchUserProfile in src/user.ts',
    expected: 'H1_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'Cross-file rename across 12 files needs review to catch misses',
  },
  {
    id: 'perf-optimize',
    task: '优化 fetchAllUsers 的 N+1 查询',
    investigation: 'Found the N+1 pattern in src/api/users.ts line 45. Each user triggers a separate DB call for profile data. Need to rewrite as a batch query.',
    attemptedTool: 'edit: rewrite query logic in src/api/users.ts',
    expected: 'H1_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'Performance optimization with behavior change needs verification',
  },
  {
    id: 'security-fix',
    task: '修复 SQL 注入漏洞',
    investigation: 'Found raw string interpolation in src/db/queries.ts line 28. User input goes directly into SQL string.',
    attemptedTool: 'edit: replace string interpolation with parameterized query in queries.ts',
    expected: 'H1_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'Security fix needs review to confirm all injection points are covered',
  },

  // ─── H2: Should definitely escalate after pause ───
  {
    id: 'new-auth-system',
    task: '实现一套新的认证系统，支持 JWT + OAuth2',
    investigation: 'Scanned the codebase — no existing auth module. Need new models, middleware, routes, token management, refresh logic, OAuth2 flow.',
    attemptedTool: 'write: create src/auth/jwt.ts',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'New system with multiple components needs planning',
  },
  {
    id: 'monorepo-split',
    task: '把 packages/coding 拆分成 tools, orchestration, context 三个包',
    investigation: 'packages/coding has 45 files with complex internal dependencies. Module graph shows 3 clusters but with 12 cross-cluster imports.',
    attemptedTool: 'bash: mkdir -p packages/tools/src',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'Cross-module restructuring with dependency management needs planning',
  },
  {
    id: 'plugin-system',
    task: '添加插件系统，支持第三方插件注册、生命周期管理、权限隔离',
    investigation: 'No existing plugin infrastructure. Need: plugin registry, lifecycle hooks, sandboxed execution, permission model, API surface.',
    attemptedTool: 'write: create src/plugins/registry.ts',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'Major feature with architecture decisions needs planning',
  },
  {
    id: 'db-migration',
    task: '从 MongoDB 迁移到 PostgreSQL',
    investigation: 'Found 8 model files with Mongoose schemas, 15 query functions, and 3 migration scripts. Need schema conversion, data migration, and rollback strategy.',
    attemptedTool: 'write: create migrations/001_create_users.sql',
    expected: 'H2_PLAN_EXECUTE_EVAL',
    expectedAction: 'escalate',
    reason: 'High-risk data migration needs careful planning',
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

function parseFullToolsResponse(text: string): { harness: Harness; reasoning: string } | null {
  const cleaned = text.replace(/```json\n?|\n?```/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.harness) return { harness: parsed.harness as Harness, reasoning: parsed.reasoning ?? '' };
  } catch { /* continue */ }
  const jsonMatch = cleaned.match(/\{[\s\S]*?"harness"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (jsonMatch?.[1]) {
    const harness = jsonMatch[1] as Harness;
    const reasonMatch = jsonMatch[0].match(/"reasoning"\s*:\s*"([^"]*?)"/);
    return { harness, reasoning: reasonMatch?.[1] ?? '' };
  }
  const harnessMatch = text.match(/H([012])_(?:DIRECT|EXECUTE_EVAL|PLAN_EXECUTE_EVAL)/);
  if (harnessMatch?.[0]) {
    return { harness: harnessMatch[0] as Harness, reasoning: `[text-extract] ${text.slice(0, 150)}` };
  }
  return null;
}

function parsePauseResponse(text: string): { action: 'retry' | 'escalate'; harness: Harness; reasoning: string } | null {
  const cleaned = text.replace(/```json\n?|\n?```/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.action && parsed.harness) {
      return { action: parsed.action, harness: parsed.harness as Harness, reasoning: parsed.reasoning ?? '' };
    }
  } catch { /* continue */ }
  const jsonMatch = cleaned.match(/\{[\s\S]*?"action"\s*:\s*"([^"]+)"[\s\S]*?"harness"\s*:\s*"([^"]+)"[\s\S]*?\}/);
  if (jsonMatch?.[1] && jsonMatch?.[2]) {
    const reasonMatch = cleaned.match(/"reasoning"\s*:\s*"([^"]*?)"/);
    return { action: jsonMatch[1] as 'retry' | 'escalate', harness: jsonMatch[2] as Harness, reasoning: reasonMatch?.[1] ?? '' };
  }
  // Fallback: check for action/harness separately
  const actionMatch = text.match(/"action"\s*:\s*"(retry|escalate)"/);
  const harnessMatch = text.match(/H([012])_(?:DIRECT|EXECUTE_EVAL|PLAN_EXECUTE_EVAL)/);
  if (actionMatch?.[1] && harnessMatch?.[0]) {
    return { action: actionMatch[1] as 'retry' | 'escalate', harness: harnessMatch[0] as Harness, reasoning: `[text-extract] ${text.slice(0, 150)}` };
  }
  return null;
}

async function queryWithRetry<T>(
  client: Anthropic,
  model: string,
  system: string,
  userMessage: string,
  parser: (text: string) => T | null,
): Promise<T> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: userMessage }],
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const parsed = parser(text);
      if (parsed) return parsed;
      return { action: 'retry', harness: 'H0_DIRECT', reasoning: `[UNPARSEABLE] raw=${text.slice(0, 300)}` } as T;
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      const isRetryable = status === 529 || status === 429 || status === 500 || status === 503;
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = 3000 * (attempt + 1);
        console.warn(`  [${model}] ${status} on attempt ${attempt + 1}, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  return { action: 'retry', harness: 'H0_DIRECT', reasoning: '[MAX_RETRIES_EXCEEDED]' } as T;
}

// ═══════════════════════════════════════════════════
// Result tracking and summary
// ═══════════════════════════════════════════════════

interface EvalResult {
  id: string;
  scenario: 'full-tools' | 'one-pause';
  expected: Harness;
  actual: Harness;
  action?: 'retry' | 'escalate';
  expectedAction?: 'retry' | 'escalate';
  correct: boolean;
  reasoning: string;
}

function printScenarioSummary(
  providerName: string,
  model: string,
  scenario: string,
  results: EvalResult[],
): void {
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

  console.log(`\n── ${providerName} / ${model} [${scenario}] ──`);
  console.log(`Overall: ${correct}/${total} (${(accuracy * 100).toFixed(0)}%)`);
  for (const [level, stats] of Object.entries(byLevel)) {
    const pct = stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(0) : 'N/A';
    console.log(`  ${level}: ${stats.correct}/${stats.total} (${pct}%)`);
  }
  const mismatches = results.filter((r) => !r.correct);
  if (mismatches.length > 0) {
    console.log('Mismatches:');
    for (const m of mismatches) {
      const actionNote = m.action ? ` [action=${m.action}]` : '';
      console.log(`  ${m.id}: expected ${m.expected}, got ${m.actual}${actionNote} — ${m.reasoning}`);
    }
  }
}

// ═══════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════

for (const provider of PROVIDERS) {
  describe(`Eval: ${provider.name} / ${provider.model}`, () => {
    const client = createClient(provider);
    if (!client) {
      it.skip(`${provider.apiKeyEnv} not set`, () => {});
      return;
    }

    const fullToolsResults: EvalResult[] = [];
    const onePauseResults: EvalResult[] = [];

    let requestCount = 0;

    // ─── Scenario A: Full tools ───
    describe('Scenario A: Full tools (Solution 1)', () => {
      for (const tc of TEST_CASES) {
        it(`[${tc.expected}] ${tc.id}`, async () => {
          if (requestCount > 0) await sleep(1500);
          requestCount++;

          const userMessage = `Task: ${tc.task}\n\nYou have already investigated and found: ${tc.investigation}`;
          const result = await queryWithRetry(
            client, provider.model,
            FULL_TOOLS_SYSTEM_PROMPT, userMessage,
            parseFullToolsResponse,
          );
          const correct = result.harness === tc.expected;
          fullToolsResults.push({
            id: tc.id, scenario: 'full-tools',
            expected: tc.expected, actual: result.harness,
            correct, reasoning: result.reasoning,
          });
          expect(correct, `${tc.id}: expected ${tc.expected}, got ${result.harness} — ${result.reasoning}`).toBe(true);
        }, 30_000);
      }
    });

    // ─── Scenario B: One pause ───
    describe('Scenario B: One pause (new proposal)', () => {
      for (const tc of TEST_CASES) {
        it(`[${tc.expectedAction}→${tc.expected}] ${tc.id}`, async () => {
          if (requestCount > 0) await sleep(1500);
          requestCount++;

          const userMessage = [
            `Task: ${tc.task}`,
            `\nYou investigated and found: ${tc.investigation}`,
            `\nYou attempted: ${tc.attemptedTool}`,
            `\nThe system paused you with a HARNESS CHECK. Make your decision now.`,
          ].join('\n');
          const result = await queryWithRetry(
            client, provider.model,
            ONE_PAUSE_SYSTEM_PROMPT, userMessage,
            parsePauseResponse,
          );
          const correct = result.harness === tc.expected;
          const actionCorrect = result.action === tc.expectedAction;
          onePauseResults.push({
            id: tc.id, scenario: 'one-pause',
            expected: tc.expected, actual: result.harness,
            action: result.action, expectedAction: tc.expectedAction,
            correct: correct && actionCorrect, reasoning: result.reasoning,
          });
          expect(correct && actionCorrect,
            `${tc.id}: expected ${tc.expectedAction}→${tc.expected}, got ${result.action}→${result.harness} — ${result.reasoning}`,
          ).toBe(true);
        }, 30_000);
      }
    });

    // ─── Summary ───
    it('prints summary', () => {
      if (fullToolsResults.length > 0) {
        printScenarioSummary(provider.name, provider.model, 'Full Tools', fullToolsResults);
      }
      if (onePauseResults.length > 0) {
        printScenarioSummary(provider.name, provider.model, 'One Pause', onePauseResults);
      }
    });
  });
}
