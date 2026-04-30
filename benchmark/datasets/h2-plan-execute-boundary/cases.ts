/**
 * H2 Plan-Execute Boundary Eval — dataset for FEATURE_107 (v0.7.32).
 *
 * See ./README.md for the product question. This module exports:
 *
 *   - `H2_BOUNDARY_TASKS`  — 18 H2-class task cases (1 real-replay + 17 hand-curated)
 *   - `EvalVariant`        — ('H2-A' | 'H2-B' | 'H1-ref') the 3 variants under test
 *
 * Cases are designed to be run via worktree isolation (see harness P3) — each
 * case checks out the historical SHA (real-replay) or HEAD (hand-curated) into
 * `/tmp/kodax-eval-<id>/`, runs the task there, then deletes the worktree.
 * Production repos are never touched.
 *
 * Category tags help P5.5 review — eval results sliced by category tell us
 * whether plan/execute boundary loss is uniform or category-specific.
 */

export type EvalVariant = 'H2-A' | 'H2-B' | 'H1-ref';
export type CaseSource = 'real-replay' | 'hand-curated';
export type CaseCategory =
  | 'real-replay'
  | 'multi-file-feature'
  | 'cross-package-refactor'
  | 'multi-file-bugfix'
  | 'tdd-multi-file';

export interface H2BoundaryCase {
  readonly id: string;
  readonly source: CaseSource;
  readonly category: CaseCategory;
  readonly description: string;
  readonly userMessage: string;
  /** null → run at HEAD; string → checkout this historical SHA in worktree. */
  readonly gitHeadSha: string | null;
  /** Files that MUST be touched (modified or created) for the task to count as done. */
  readonly mustTouchFiles: readonly string[];
  /** Files that MUST NOT be touched — guards against blast radius. */
  readonly mustNotTouchFiles: readonly string[];
  /** Natural-language criteria fed to the LLM judge for plan-intent fidelity / final acceptance. */
  readonly acceptanceCriteria: string;
}

const REAL_REPLAY_CASES: readonly H2BoundaryCase[] = [
  {
    id: 'h2-real-001-readonly-child-dispatch',
    source: 'real-replay',
    category: 'real-replay',
    description:
      'Investigation that produced multi-file fix to readOnly child dispatch logic. ' +
      'Original session was tagged H0_DIRECT but ended up editing 2 files across 333 tool calls / 47min — ' +
      'classic should-have-been-H2 case from runner-1777024449767.jsonl.',
    userMessage:
      '当前KodaX在做调研工作时，没有充分利用并行 dispatch 子 Agent。我希望你分析为什么 ' +
      'Scout/Generator 在重型 read-only 调研任务中不主动派发并行子 agent，找出根因并给出修复。' +
      '关注 packages/coding/src/agent-runtime/ 里 dispatch_child_task 的触发逻辑，以及 ' +
      'task-engine 的 fanout-scheduler 决策。如果根因清楚，直接修；不清楚就先讲清楚。',
    gitHeadSha: 'fd75c5d9',
    mustTouchFiles: [
      'packages/ai/src/providers/openai.ts',
      'packages/coding/src/task-engine/runner-driven.ts',
    ],
    mustNotTouchFiles: ['docs/', 'CHANGELOG.md', 'package.json'],
    acceptanceCriteria:
      'Deliverable demonstrates: (1) clear root-cause analysis of why parallel dispatch is suppressed in heavy read-only investigation; (2) targeted fix in the two files that enables single-readOnly-child dispatch without breaking existing parallel paths; (3) no broad refactoring beyond the immediate fix; (4) tests or manual verification reasoning included.',
  },
];

const MULTI_FILE_FEATURE_CASES: readonly H2BoundaryCase[] = [
  {
    id: 'h2-hc-invariant-temporal',
    source: 'hand-curated',
    category: 'multi-file-feature',
    description: 'Add a new admission invariant `temporalConsistency` checking admit timestamps monotonic.',
    userMessage:
      '给 admission contract 加一个新 invariant `temporalConsistency`：在 admit 阶段，' +
      '检查同一 agent 的 admit 时间戳不能回退（防止 manifest 被注入伪造的旧时间戳来绕过 ratchet 类规则）。' +
      '这个 invariant 应该和现有 7 项一样注册到 invariant runtime，写完整的 admit hook，' +
      '加到 requiredInvariants 默认集，并补单元测试和集成测试。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/core/src/invariants/',
      'packages/core/src/admission.ts',
      'packages/core/src/index.ts',
    ],
    mustNotTouchFiles: ['packages/coding/src/agent-runtime/', 'packages/repl/'],
    acceptanceCriteria:
      'New invariant file under packages/core/src/invariants/temporal-consistency.ts; admit hook rejects manifests with backwards timestamps; registered to invariant runtime; default set includes it; unit tests cover both pass and reject paths; no changes outside packages/core.',
  },
  {
    id: 'h2-hc-judge-token-budget',
    source: 'hand-curated',
    category: 'multi-file-feature',
    description: 'Add a token-budget judge to benchmark/harness/judges.ts with full integration.',
    userMessage:
      '给 benchmark/harness/judges.ts 加一个新 judge 类型 `tokenBudgetWithin(maxTokens)`，' +
      '检查模型输出 token 数不超阈值。要做完整集成：在 `runJudges` 聚合里能正确分类（category=`safety`），' +
      '在 self-test.test.ts 里加测试覆盖通过 / 失败两种情况，' +
      '并在 ama-harness-selection 数据集里示范用法（给一个现有 case 加上这个 judge）。',
    gitHeadSha: null,
    mustTouchFiles: [
      'benchmark/harness/judges.ts',
      'benchmark/harness/self-test.test.ts',
      'benchmark/datasets/ama-harness-selection/cases.ts',
    ],
    mustNotTouchFiles: ['packages/'],
    acceptanceCriteria:
      'New `tokenBudgetWithin` factory exported; integrates with runJudges; tests cover pass/fail; one ama-harness-selection case demonstrates usage; no changes outside benchmark/.',
  },
  {
    id: 'h2-hc-policy-gate-rate-limit',
    source: 'hand-curated',
    category: 'multi-file-feature',
    description: 'Add rate limiting to policy gate (e.g., max 5 ask-user prompts per minute).',
    userMessage:
      '给 policy gate 加一个 rate limit：单个 session 内同类 ask-user prompt 1 分钟内最多触发 5 次，' +
      '超限自动 reject 并提示用户调整 policy。需要：rate limit 状态持久化（per-session）、' +
      '配置项暴露（默认 5/min，可调）、对 ToolGuardrail 路径透明、单元测试覆盖正常+超限+边界场景、' +
      '集成测试验证多个 session 隔离。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/agent-runtime/',
      'packages/coding/src/agent-runtime/policy-gate.ts',
    ],
    mustNotTouchFiles: ['packages/core/', 'packages/ai/'],
    acceptanceCriteria:
      'Rate limit enforces 5/min default; per-session isolated; config option exposed and documented; tests cover normal/limit-hit/cross-session; no leakage to core or ai packages.',
  },
  {
    id: 'h2-hc-eval-dataset-prompt-drift',
    source: 'hand-curated',
    category: 'multi-file-feature',
    description: 'Add a new eval dataset for prompt drift detection across releases.',
    userMessage:
      '加一个新 eval dataset `benchmark/datasets/prompt-drift-baseline/`，' +
      '用来检测某次 release 的 system prompt 相比上一个 release 的语义漂移。' +
      '需要：dataset README 解释产品问题、cases.ts 列 5 个 baseline prompt + 期望响应骨架、' +
      'judge 用 mustMatch 验证骨架结构、tests/prompt-drift.eval.ts 跑全套 8 alias、' +
      'README 写运行说明。沿用 ama-harness-selection 的格式。',
    gitHeadSha: null,
    mustTouchFiles: [
      'benchmark/datasets/prompt-drift-baseline/README.md',
      'benchmark/datasets/prompt-drift-baseline/cases.ts',
      'tests/prompt-drift.eval.ts',
    ],
    mustNotTouchFiles: ['packages/', 'docs/'],
    acceptanceCriteria:
      'Dataset directory created with README + cases.ts; cases.ts follows ama-harness-selection pattern (typed exports, judges, variants); .eval.ts test file gracefully skips when API keys absent; full set of 5 cases authored.',
  },
  {
    id: 'h2-hc-replay-cache-format',
    source: 'hand-curated',
    category: 'multi-file-feature',
    description: 'Add session replay cache format to session-lineage with golden tests.',
    userMessage:
      '在 session-lineage 包里实现一个 replay cache：把一个 session 的 lineage entries ' +
      '编译成一个紧凑的 replay 格式（去掉 thinking content，保留 tool calls + 结果），存到磁盘。' +
      '需要：编译函数、读回函数、版本化的格式 schema（zod）、golden tests 用至少 3 个真实 session 样本、' +
      '处理 schema 升级的迁移逻辑骨架。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/session-lineage/src/replay-cache.ts',
      'packages/session-lineage/src/replay-cache.test.ts',
      'packages/session-lineage/src/index.ts',
    ],
    mustNotTouchFiles: ['packages/coding/', 'packages/repl/'],
    acceptanceCriteria:
      'New replay-cache module exports compile/read functions; zod schema with version field; golden tests with 3+ samples covering both directions; migration scaffold present; index.ts re-exports the public API.',
  },
];

const CROSS_PACKAGE_REFACTOR_CASES: readonly H2BoundaryCase[] = [
  {
    id: 'h2-hc-extract-session-snapshot-util',
    source: 'hand-curated',
    category: 'cross-package-refactor',
    description: 'Extract session-snapshot utility from coding to core (used by both).',
    userMessage:
      '`packages/coding/src/agent-runtime/middleware/session-snapshot.ts` 里有几个工具函数 ' +
      '（serialize / restore / diff）现在只在 coding 包里用，但 core 的 admission-session 也需要类似功能。' +
      '请把这些函数抽到 `packages/core/src/session-snapshot.ts`，让 coding 和 core 都从 core import。' +
      '保留 coding 里的 middleware 包装（business logic 不变），只把纯工具函数下沉。' +
      '更新所有 import；测试不能 break。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/core/src/session-snapshot.ts',
      'packages/core/src/index.ts',
      'packages/coding/src/agent-runtime/middleware/session-snapshot.ts',
    ],
    mustNotTouchFiles: ['packages/repl/', 'packages/agent/'],
    acceptanceCriteria:
      'Pure utility functions moved to core; coding imports from core; middleware wrapper retained in coding; all tests pass; no circular dependency introduced; no API surface change for downstream consumers.',
  },
  {
    id: 'h2-hc-rename-harness-id',
    source: 'hand-curated',
    category: 'cross-package-refactor',
    description: 'Rename H1_EXECUTE_EVAL → H1_VERIFIED across all packages.',
    userMessage:
      '我决定把 harness id `H1_EXECUTE_EVAL` 改名为 `H1_VERIFIED`（更短更清晰）。请扫全 monorepo ' +
      '把所有出现替换掉：types 定义、role-prompt 文本、role-prompt 注释、prompt eval datasets、' +
      'README 文档、CHANGELOG 引用都要改。注意 emit_scout_verdict 工具的 schema 也要更新。' +
      '改完跑全测，确保没有遗漏。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/types.ts',
      'packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts',
      'benchmark/datasets/ama-harness-selection/cases.ts',
    ],
    mustNotTouchFiles: ['CHANGELOG_ARCHIVE.md'],
    acceptanceCriteria:
      'All H1_EXECUTE_EVAL occurrences renamed to H1_VERIFIED; emit_scout_verdict schema updated; no stale references remain; all tests pass; CHANGELOG entry added documenting the rename.',
  },
  {
    id: 'h2-hc-unify-tool-error-codes',
    source: 'hand-curated',
    category: 'cross-package-refactor',
    description: 'Unify per-tool error codes into a shared enum across coding/tools/*.',
    userMessage:
      '`packages/coding/src/tools/` 下每个工具自己定义 error codes（write 的 EWRITE_DENIED、' +
      'edit 的 EEDIT_NOT_FOUND 等），格式不一致。请抽取一个 shared enum `ToolErrorCode`，' +
      '统一格式（按 tool category + 错误类型组织），更新每个工具的 throw 路径用新 enum，' +
      '保持错误信息文案不变（只统一 code）。补充类型测试。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/tools/errors.ts',
      'packages/coding/src/tools/index.ts',
    ],
    mustNotTouchFiles: ['packages/core/', 'packages/ai/', 'packages/repl/'],
    acceptanceCriteria:
      'New ToolErrorCode enum exported; all tools use it; error messages unchanged; type tests cover all codes; no breaking change to public tool API.',
  },
  {
    id: 'h2-hc-move-admission-types',
    source: 'hand-curated',
    category: 'cross-package-refactor',
    description: 'Move admission types from core to a types-only sub-entry to avoid runtime coupling.',
    userMessage:
      'admission contract 的 type 定义（AgentManifest / InvariantId / ToolCapability 等）现在 ' +
      '住在 `packages/core/src/admission.ts` 里，但 coding 包只需要 type 不需要 runtime。' +
      '请抽出一个 types-only entry `packages/core/src/admission-types.ts`，让 coding 用 ' +
      '`import type` 形式引用，避免拖入 runtime 副作用。验证 coding 包构建后不再依赖 core 运行时模块。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/core/src/admission-types.ts',
      'packages/core/src/admission.ts',
      'packages/core/src/index.ts',
      'packages/coding/src/',
    ],
    mustNotTouchFiles: ['packages/repl/', 'packages/agent/'],
    acceptanceCriteria:
      'Types extracted to admission-types.ts; coding imports use `import type`; build verifies no runtime dep on admission.ts module from coding; all tests pass.',
  },
];

const MULTI_FILE_BUGFIX_CASES: readonly H2BoundaryCase[] = [
  {
    id: 'h2-hc-fix-budget-snapshot-drift',
    source: 'hand-curated',
    category: 'multi-file-bugfix',
    description: 'Fix synthetic bug: budget snapshot diverges between core and coding consumers.',
    userMessage:
      'Bug: 我观察到在长任务里 budget snapshot 在 core 和 coding 看到的值不一致——' +
      'core 的 budget controller 减了 10 个 token，但 coding 的 status panel 还是显示扣减前的值。' +
      '怀疑是某个地方 cache 了旧 snapshot 没刷新。请追根因，修掉漂移点。' +
      '可能涉及 budget controller、status event publishing、repl 的状态订阅链路。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/task-engine/',
      'packages/repl/src/',
    ],
    mustNotTouchFiles: ['packages/ai/', 'packages/agent/', 'packages/skills/'],
    acceptanceCriteria:
      'Root cause identified and explained; fix in the right layer (likely status event publishing); regression test added; no broad refactor; original bug reproducible before fix and not after.',
  },
  {
    id: 'h2-hc-fix-handoff-cycle-detection',
    source: 'hand-curated',
    category: 'multi-file-bugfix',
    description: 'Fix synthetic bug: transitive handoff cycles slip through admission.',
    userMessage:
      'Bug: FEATURE_101 的 handoffLegality invariant 检查 handoff DAG 无环，但我发现 ' +
      'A→B / B→C / C→A 这种 transitive cycle 在某些 manifest 顺序下能 slip through。' +
      '怀疑 admission 时只检查了"加入本 manifest 后"的局部图，没考虑已激活 agents 的全局图。' +
      '请定位漏洞并修，加针对 transitive cycle 的回归测试。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/core/src/invariants/handoff-legality.ts',
      'packages/core/src/invariants/handoff-legality.test.ts',
    ],
    mustNotTouchFiles: ['packages/coding/'],
    acceptanceCriteria:
      'Transitive cycle case identified; admission rejects A→B/B→C/C→A; test case for 3-cycle and 4-cycle added; existing direct-cycle tests still pass.',
  },
  {
    id: 'h2-hc-fix-evaluator-context-leak',
    source: 'hand-curated',
    category: 'multi-file-bugfix',
    description: 'Fix synthetic bug: Evaluator session inherits Generator reasoning despite design.',
    userMessage:
      'Bug: 设计上 Evaluator 应该 fresh session（只看 task + deliverable），' +
      '但我观察到某些情况下 Evaluator 的 prompt 里出现了 Generator 的 thinking 文本。' +
      '怀疑 H1 revise 路径里 session resumption 把 Generator 的 reasoning 漏出去给了 Evaluator。' +
      '请定位漏洞并修。需要修 task-engine 的 revise 路径 + 加 prompt-content 隔离测试。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/task-engine/',
      'packages/coding/src/task-engine.test.ts',
    ],
    mustNotTouchFiles: ['packages/core/', 'packages/ai/'],
    acceptanceCriteria:
      'Leak path identified in revise resumption logic; fix isolates Generator thinking from Evaluator prompt; test verifies Evaluator prompt does NOT contain Generator reasoning markers; no regression in revise success rate.',
  },
  {
    id: 'h2-hc-fix-tool-permission-clamp',
    source: 'hand-curated',
    category: 'multi-file-bugfix',
    description: 'Fix synthetic bug: tool permission clamp does not propagate to subagent.',
    userMessage:
      'Bug: parent agent 的 toolPermissions 被 admission clamp 后（比如 bash:network 被剥离），' +
      'subagent 通过 dispatch_child_task spawn 出来时仍然能调 bash:network——clamp 没传下去。' +
      '请追源码，找到 subagent 创建时的 permission 继承逻辑，修掉漂移。' +
      '加测试覆盖 parent clamp 后 subagent 不能越权的场景。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/agent-runtime/',
      'packages/coding/src/agent-runtime/policy-gate.ts',
    ],
    mustNotTouchFiles: ['packages/core/', 'packages/repl/'],
    acceptanceCriteria:
      'Root cause in subagent permission inheritance fixed; test covers parent-clamped → subagent-cannot-bypass; no regression in normal subagent dispatch; clear explanation of where the leak was.',
  },
];

const TDD_MULTI_FILE_CASES: readonly H2BoundaryCase[] = [
  {
    id: 'h2-hc-tdd-divergence-score-threshold',
    source: 'hand-curated',
    category: 'tdd-multi-file',
    description: 'TDD impl divergence score threshold tuning logic for self-modify.',
    userMessage:
      'TDD 实装：FEATURE_090 self-modify 的 divergence score 当前是固定阈值。请改成可配置 + 根据修改字段类型分级' +
      '（instructions 改动阈值严格、reasoning 宽松）。' +
      '严格 TDD 流程：先写 4 个测试用例覆盖各 tier 通过/拒绝场景（RED），' +
      '再写最小实装让测试 GREEN，最后 refactor。' +
      '所有改动在 packages/coding/src/construction/ 下完成。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/construction/divergence-score.ts',
      'packages/coding/src/construction/divergence-score.test.ts',
    ],
    mustNotTouchFiles: ['packages/core/', 'packages/ai/'],
    acceptanceCriteria:
      'Test file written FIRST (visible in commit history or in deliverable narrative); 4+ test cases per tier; impl is minimal; tier-specific thresholds work; default config sane; refactor pass cleaned up duplication.',
  },
  {
    id: 'h2-hc-tdd-fanout-scheduler-fairness',
    source: 'hand-curated',
    category: 'tdd-multi-file',
    description: 'TDD impl fairness in fanout-scheduler dispatch ordering.',
    userMessage:
      'TDD 实装：fanout-scheduler 当前按 FIFO 派发子 agent，多个 parent role 同时 spawn 时存在饥饿。' +
      '请实装 fair dispatch（round-robin per parent role）。' +
      'TDD：先写测试覆盖（1）单 parent 多子任务、（2）多 parent 公平轮转、（3）一 parent 阻塞不影响其他、' +
      '（4）饥饿避免（time-bounded）。再写最小实装。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/fanout-scheduler.ts',
      'packages/coding/src/fanout-scheduler.test.ts',
    ],
    mustNotTouchFiles: ['packages/core/', 'packages/repl/'],
    acceptanceCriteria:
      'Tests authored before impl; 4+ test cases as specified; fair round-robin verifiable; starvation bounded; existing FIFO behavior preserved as fallback when single-parent.',
  },
  {
    id: 'h2-hc-tdd-judges-decomposed-aggregation',
    source: 'hand-curated',
    category: 'tdd-multi-file',
    description: 'TDD impl decomposed quality aggregation in benchmark runJudges.',
    userMessage:
      'TDD 实装：当前 `runJudges` 只返回总 pass/fail。请扩展成 decomposed 聚合——按 category ' +
      '（format / correctness / style / safety / custom）分别 reduce。' +
      'TDD：先写测试覆盖（1）单 category 全 pass、（2）混合 pass/fail、（3）空 category、' +
      '（4）category 优先级（safety > correctness > style）。再写最小实装。' +
      '保证现有 caller 不破。',
    gitHeadSha: null,
    mustTouchFiles: [
      'benchmark/harness/judges.ts',
      'benchmark/harness/self-test.test.ts',
    ],
    mustNotTouchFiles: ['packages/'],
    acceptanceCriteria:
      'Tests written first; 4+ cases as specified; backward compat verified for existing callers; category priority correct; output type extended without breaking change.',
  },
  {
    id: 'h2-hc-tdd-replay-cache-migration',
    source: 'hand-curated',
    category: 'tdd-multi-file',
    description: 'TDD impl replay cache schema migration logic.',
    userMessage:
      'TDD 实装：session-lineage 的 replay cache 升级 schema 时需要迁移老数据。' +
      '请实装 migration framework：版本号比较、ordered migration steps、rollback safety。' +
      'TDD：先写测试覆盖（1）v1→v2 直升、（2）v1→v3 多步、（3）目标版本相同 no-op、' +
      '（4）migration 中途失败回滚。再写最小实装。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/session-lineage/src/migrations.ts',
      'packages/session-lineage/src/migrations.test.ts',
      'packages/session-lineage/src/index.ts',
    ],
    mustNotTouchFiles: ['packages/coding/', 'packages/repl/'],
    acceptanceCriteria:
      'Tests authored before impl; 4+ cases as specified; migration framework supports skip/multi-step/rollback; index.ts exports public API; no shared state between test runs.',
  },
];

export const H2_BOUNDARY_TASKS: readonly H2BoundaryCase[] = Object.freeze([
  ...REAL_REPLAY_CASES,
  ...MULTI_FILE_FEATURE_CASES,
  ...CROSS_PACKAGE_REFACTOR_CASES,
  ...MULTI_FILE_BUGFIX_CASES,
  ...TDD_MULTI_FILE_CASES,
]);

export const H2_BOUNDARY_VARIANTS: readonly EvalVariant[] = Object.freeze([
  'H2-A',
  'H2-B',
  'H1-ref',
]);
