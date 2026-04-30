/**
 * H2 Plan-Execute Boundary Eval — grounded dataset for FEATURE_107 (v0.7.32).
 *
 * **STATUS: ABOVE VIABLE FLOOR — exploratory eval framing still required**
 *
 * **2026-04-30 P2.1 design pass re-framed the eval question**:
 * Original framing assumed A=current=`new-session+plan artifact` (lossy by
 * hypothesis). Code reading revealed all current handoffs are
 * `kind:'continuation'` with `inputFilter: undefined` — A is actually
 * same-session full-transcript. v0.7.16's `new session + plan artifact`
 * design rule was never implemented in the v0.7.26 Layer A rewrite.
 *
 * Re-framed variant semantics (cases stay the same; what variants MEAN flipped):
 *   - H2-A "naked"     — current code, no inputFilter, full Planner transcript flows to Generator
 *   - H2-B "filtered"  — adds inputFilter to plannerHandoffs, Generator sees only plan artifact
 *                        (this is what v0.7.16 design doc *intended*)
 *   - H1-ref           — bypass Planner entirely (Scout→Generator→Evaluator)
 *   - H0-actual        — baseline from session jsonl, no rerun
 *
 * Re-framed question: should v0.7.16's "new session + plan artifact" rule
 * actually be implemented (B), or is the v0.7.26 drift (A) actually fine /
 * better? See `docs/features/v0.7.32.md` §背景 §假设 (re-framed) for full text.
 *
 * Final viable count after P1.5b + post-cases.ts state verification + broader
 * Planned-pool sweep + git-history archaeology: **14 cases**
 *   (6 Planned + 3 Open Issues + 5 Replay).
 *
 * This is **above** the 12-case fallback floor declared in
 * `docs/features/v0.7.32.md` §Dataset 不足 fallback. Per that rule, 12-17 zone
 * runs eval as exploratory with framing caveats. We pulled 3 additional Pool 3
 * cases via git-history archaeology after user pointed out 821-commit history
 * was under-mined by FEATURE_NNN-only grep:
 *   - f6f08cc API error recovery (cross-cutting, 5-phase bug-fix flavor)
 *   - 458f333 FEATURE_074 subagent permission boundary (bug-fix, replace broken set_permission_mode)
 *   - 40ef809 Issue 116 stale-round guard + stream resilience (bug-fix)
 *
 * Decision: proceed with 14 cases under exploratory framing. Cannot claim
 * statistical confirmation; effect-size thresholds (≥10%) are the only valid
 * decision criterion.
 *
 * **Replaces** the speculative cases.ts from commit 165fc0d. Every case here
 * is grounded in either a real KodaX design document, an open KNOWN_ISSUES
 * entry, or a completed-feature git history.
 *
 * Generated 2026-04-30 after FEATURE_107 P1.5b deep-check + codex-rescue
 * second-opinion review + post-cases.ts state verification + broader-pool
 * sweep (per user "look at OTHER unimplemented features" feedback). See
 * `./candidate-inventory.md` for full methodology and demotion rationale.
 *
 * Module exports:
 *   - `H2_BOUNDARY_TASKS`   — 14 grounded H2-class cases
 *   - `H2_BOUNDARY_VARIANTS` — ('H2-A' | 'H2-B' | 'H1-ref') the 3 eval variants
 *
 * Worktree isolation: each case runs in `/tmp/kodax-eval-<id>/` checked out
 * at `gitHeadSha` (or HEAD if null), worktree removed after. Production repos
 * never touched. See FEATURE_107 §Eval 执行隔离 for safeguards.
 *
 * Eval framing: At 14 cases × 4 variants × 8 providers = 448 trials, this is
 * STRICTLY exploratory not confirmatory. Decisions would need to use effect-size
 * thresholds (≥10% delta), NOT statistical significance. Cannot claim "no
 * difference" at this N.
 *
 * Removed during state verification (post-cases.ts authoring):
 *   - I-109 mcp_get_prompt — file already exists at packages/coding/src/tools/mcp-get-prompt.ts (doc-lag)
 *   - I-110 /mcp commands  — already implemented at commands.ts:605 (doc-lag)
 *   - I-112 ask_user_question modes — 3 modes already implemented; remaining UI work below H2 threshold
 *
 * Verified-shipped during broader sweep (FEATURE_LIST.md doc-lag, no inclusion):
 *   - F-087 ConstructionRuntime — packages/coding/src/construction/ exists with 28 files
 *   - F-088 Tool Generation Tier 2 — shipped as part of F-089 admission contract
 *   - F-100 SA Runner Frame — git log shows P3.6a-v complete in commits up to 3758b02
 *   - F-078 Role-Aware Reasoning — shipped at 581c9b8
 *   - F-103 Scout Calibration — shipped at 71a0574
 */

export type EvalVariant = 'H2-A' | 'H2-B' | 'H1-ref';

export type CaseSource = 'planned' | 'open-issue' | 'real-replay';

export type CaseCategory = 'new-feature' | 'refactor' | 'bug-fix' | 'cross-cutting';

export interface H2BoundaryCase {
  readonly id: string;
  readonly source: CaseSource;
  readonly category: CaseCategory;
  /** One-line summary for reports. */
  readonly description: string;
  /**
   * Source document citation (design doc / issue body). Format:
   * "docs/features/v0.7.X.md#feature_NNN" or "docs/KNOWN_ISSUES.md ISSUE_NNN".
   * Eval reproducer uses this to verify text didn't drift since dataset locked.
   */
  readonly sourceCitation: string;
  /**
   * Paraphrased user request, in the user's voice, derived from sourceCitation.
   * Length capped to keep prompt token cost predictable across providers.
   */
  readonly userMessage: string;
  /**
   * Replay anchor. `null` = checkout HEAD-at-eval-time; `string` = pin to
   * specific historical SHA (real-replay cases only).
   */
  readonly gitHeadSha: string | null;
  /**
   * Files that MUST be modified or created for the task to count as done.
   * For real-replay cases: from `git show <impl-sha> --stat` (objective).
   * For planned/open-issue cases: from design-doc Context or issue body
   * (predicted; LLM judge has tolerance for paths agent finds equivalent).
   */
  readonly mustTouchFiles: readonly string[];
  /** Files that MUST NOT be touched — guards blast radius. */
  readonly mustNotTouchFiles: readonly string[];
  /**
   * Verbatim or closely-paraphrased acceptance criteria from sourceCitation.
   * Fed to LLM judge for plan-intent fidelity / final acceptance scoring.
   * Prefixed with [verbatim] or [paraphrased] tag for transparency.
   */
  readonly acceptanceCriteria: string;
  /**
   * Optional case-specific eval limitation that judges should account for.
   * E.g., visual UI rendering not directly verifiable in worktree.
   */
  readonly evalLimitations?: string;
}

// ---------------------------------------------------------------------------
// Pool 1 — Unimplemented Planned Features (post-v0.7.31)
// All run at HEAD-at-eval-time.
// ---------------------------------------------------------------------------

const PLANNED_CASES: readonly H2BoundaryCase[] = [
  {
    id: 'h2-planned-090-self-modify-role-spec',
    source: 'planned',
    category: 'cross-cutting',
    description: 'Tier 4 self-construction — agent modifies its own role spec with reflexive safeguards',
    sourceCitation: 'docs/features/v0.7.32.md#feature_090',
    userMessage:
      '实装 KodaX Tier 4 self-construction：让一个 constructed agent 能在运行中修改自己的 role spec（reasoning profile / instructions / handoffs / guardrails）。' +
      '配 5 条反身稳定保障：(1) 当前 run 不 swap 自己（新 manifest activate 后下一次 Runner.run 才生效）(2) divergence 检测（instructions 相似度低于阈值 reject）(3) modification budget 默认 N=3 (4) rollback 旧版本保留 (5) 审计日志写入 .kodax/constructed/_audit.jsonl。' +
      'policy gate 强制 ask-user，永远不 auto-approve。修改边界：instructions/reasoning/tools/handoffs/guardrails 允许改（guardrails 只能加不能减），name 不允许改。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/construction/runtime.ts',
      'packages/coding/src/construction/sandbox-runner.ts',
      'packages/coding/src/agent-runtime/middleware/self-modify-guardrail.ts',
      'packages/coding/src/cli/constructed.ts',
    ],
    mustNotTouchFiles: ['packages/repl/', 'packages/ai/', 'packages/agent/', 'docs/', 'CHANGELOG.md'],
    acceptanceCriteria:
      '[verbatim §Release criteria] 所有 5 条反身稳定保障机制实装 + 测试绿；至少一组端到端 self-modify scenario 跑通（如 evaluator 自升 reasoning 档位）；至少 3 组 adversarial case 被拦截（prompt injection / 越权 / 无限反身）；_audit.jsonl 格式稳定能 replay/rollback；CLI 命令 `kodax constructed rollback|audit|disable-self-modify` 可用。',
  },
  {
    id: 'h2-planned-092-auto-mode-classifier-core',
    source: 'planned',
    category: 'cross-cutting',
    description: 'Auto Mode Classifier — 3-tier permission pyramid with LLM-reviewed Tier 3 (core only, NOT tool migration)',
    sourceCitation: 'docs/features/v0.7.33.md#feature_092',
    userMessage:
      '把 KodaX auto 模式从规则围栏升级为规则+LLM 双层审查。3 层金字塔：' +
      'Tier 1 read-only tools（toClassifierInput 返回空字符串）跳过分类器；' +
      'Tier 2 path-inside-project 写入 + bash readonly 命令跳过分类器；' +
      'Tier 3 调用 classify() 返回 <block>yes</block> 或 <block>no</block>。' +
      '8s timeout，10min 5 错触发 circuit breaker 自动降级到 engine=rules。Mode (plan/accept-edits/auto) × Engine (rules/llm) 二维分离。' +
      '本 task 只做 guardrail+classifier 核心实装（auto-mode-guardrail.ts + Tool 接口加 toClassifierInput 字段 required + /auto-engine 命令），' +
      '**不要**给现有 ~20 个工具批量补 toClassifierInput——那是 follow-on，scope 外。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/agent-runtime/middleware/auto-mode-guardrail.ts',
      'packages/coding/src/tools/types.ts',
      'packages/repl/src/interactive/commands.ts',
    ],
    mustNotTouchFiles: ['packages/coding/src/tools/read.ts', 'packages/coding/src/tools/grep.ts', 'packages/coding/src/tools/bash.ts', 'packages/coding/src/tools/write.ts', 'packages/coding/src/tools/edit.ts'],
    acceptanceCriteria:
      '[paraphrased v0.7.33.md] auto-mode-guardrail 实装 3-tier 决策链；Tool interface required `toClassifierInput`；classifier 用 provider-qualified id 复用主会话或独立 model；8s timeout / 10min 5 错 circuit break；deny pattern 3 连转用户确认；输出不可解析 fail-closed；engine=rules 跳过 classify() 其他 Tier 1/2 逻辑相同；`/auto-engine` 命令切换。',
    evalLimitations: 'Scope-restricted to classifier core; per-tool toClassifierInput migration explicitly excluded to keep this case bounded for H2 eval. Judge should not penalize agent for not migrating ~20 tool files.',
  },
  {
    id: 'h2-planned-097-realtime-todo-list',
    source: 'planned',
    category: 'new-feature',
    description: 'Claude-style Realtime Todo List for AMA Runner with content+activeForm dual format',
    sourceCitation: 'docs/features/v0.7.34.md#feature_097',
    userMessage:
      '在 AMA spinner 下方加一个 Claude Code 风格的实时计划列表（TodoListSurface）。' +
      '数据模型：TodoItem { id, content (指令形如 "Run tests"), activeForm (进行时如 "Running tests"), status (pending/in_progress/completed/failed/skipped), owner?, sourceObligationId? }。' +
      '后端 todo-store 接收 todo_write 工具更新 + Evaluator verdict 自动收尾。' +
      'UI 视觉：符号 ☐ pending / ⏺ in_progress / ✓ completed；状态颜色 dim / cyan bold / green；左侧装订线 + 右上角 N/M counter。' +
      '显示策略：0-1 todo 不渲染（简单任务自然不出现），2+ 渲染。所有 completed 后 5 秒延迟隐藏。每个 owner 一个 in_progress（按 owner 分组允许跨 owner 并行 child task）。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/types.ts',
      'packages/coding/src/task-engine/todo-store.ts',
      'packages/coding/src/tools/todo_write.ts',
      'packages/repl/src/ui/components/TodoListSurface.tsx',
    ],
    mustNotTouchFiles: ['packages/ai/', 'packages/agent/'],
    acceptanceCriteria:
      '[verbatim §设计] TodoStatus = pending | in_progress | completed | failed | skipped; content/activeForm 双形式必填; 0-1 不渲染 / 2+ 展开; 5 秒延迟隐藏; per-owner in_progress 约束走 prompt 层（代码层不 enforce 与 Claude Code 对齐）; failed 在下一轮可重置 pending; skipped 用于 Planner 合并 obligation 场景。',
    evalLimitations: 'UI rendering not directly verifiable in worktree (no React runtime). Judge can verify component file structure + props shape + import wiring, but NOT actual visual output. Treat structural completeness as proxy for visual correctness.',
  },
  {
    id: 'h2-planned-094-anti-escape-guardrail',
    source: 'planned',
    category: 'bug-fix',
    description: 'Anti-Escape Hardening — runtime guardrail blocks generative large-file writes via bash heredoc',
    sourceCitation: 'docs/features/v0.7.36.md#feature_094',
    userMessage:
      '中档模型（Kimi-Code / MiniMax-Coding / GLM-Coding）在大文件任务上有 ~15% bash-heredoc 绕行率，绕开 write 工具的 P0/P2a/P2b 三层防御。' +
      '加一个新的 ToolGuardrail (anti-escape-guardrail) 挂 bash 工具的 beforeTool。' +
      '检测 generative-large-file-write 4 条签名：(1) heredoc 边界标记 (<<EOF/<<\'EOF\'/<<PY/<<\'PY\'); (2) heredoc body ≥80 行或 ≥3000 字符 (3) 写入文件系统 (cat>/tee/python open) (4) 路径命中项目 tree (非 /tmp 临时调试)。' +
      '命中则 block 并返回 structured retry contract hint，引导改用 write 或 multi_edit。env-var KODAX_DISABLE_ANTI_ESCAPE_GUARDRAIL=1 可关闭。' +
      '白名单：heredoc body 含 ${VAR} 内插 / `...` / $(...) 子进程的"计算性"模板放行。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/tools/anti-escape-guardrail.ts',
      'packages/coding/src/tools/anti-escape-guardrail.test.ts',
      'packages/coding/src/tools/index.ts',
    ],
    mustNotTouchFiles: ['packages/core/', 'packages/ai/', 'packages/repl/'],
    acceptanceCriteria:
      '[verbatim §设计] 4 条签名检测准确；白名单（计算性 heredoc）放行；retry contract hint 包含工具名 + 参数名 + 原路径；env-var 关闭路径可用；测试覆盖 (a) 正向命中 (b) 白名单放行 (c) 阈值边界 (79 行/3000 字符) (d) env-var 关闭。',
  },
  {
    id: 'h2-planned-102-orchestration-phase0-telemetry',
    source: 'planned',
    category: 'cross-cutting',
    description: 'Multi-Provider Orchestration Phase 0 — telemetry/trace infrastructure (no derived metrics yet)',
    sourceCitation: 'docs/features/v0.7.45.md#feature_102 §Phase-0',
    userMessage:
      '实装 FEATURE_102 Phase 0 — Instrumentation/Trace 基础设施。**只做 Phase 0，不做 Phase 1/2/3/4**。' +
      '目标：让所有 LLM 调用 + subagent 行为可被本地查询、回放、比较，但暂不定义 derived metric（"成功/失败/返工"信号噪声大，等数据攒齐再说）。' +
      '记录字段（建议最小集）：task_id / trace_id / parent_trace_id / stage (scout|planner|generator|evaluator|reviewer|classifier) / subagent_role / provider / model / capability_request / ' +
      'prompt_tokens / completion_tokens / cache_hit / cache_write / latency_ms / cost_usd / tool_call_total / tool_call_failed / tool_call_failure_reason / ' +
      'fallback_count / retry_count / triggered_rework / objective_signals (test/lint/typecheck/build pass|fail|n_a) / user_outcome_event。' +
      '存储：本地 JSONL 或 SQLite，**不要引入 OTel**（单用户 CLI 不需要企业基础设施）。复用现有 @kodax/tracing 的 Tracer/Span 抽象（FEATURE_083 v0.7.24 已落地），新增本地 TracingProcessor 子类做持久化。' +
      '注入层：调用层强制打基础字段（provider/model/tokens/latency/tool_result），subagent 提供 stage tag。' +
      '隐私 / 本地优先：trace 数据完全 local-only，默认不上报；提供配置开关（默认开，可关闭）。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/tracing/src/processors/local-persistence.ts',
      'packages/coding/src/agent-runtime/run-substrate.ts',
      'packages/coding/src/agents/protocol-emitters.ts',
      'src/cli_option_helpers.ts',
    ],
    mustNotTouchFiles: ['packages/ai/src/providers/', 'packages/repl/'],
    acceptanceCriteria:
      '[verbatim v0.7.45.md §Phase-0 验收标准] 所有 subagent / LLM 调用都被 trace 记录，可通过本地存储查询；Trace schema 文档化，且支持后续追加字段而不破坏旧数据；至少能回答两个问题：(1) 各 stage 实际使用了哪些 model；(2) tool-call 在不同 provider 上的失败率分布；配置中提供 telemetry 开关（默认开，可关闭）。',
    evalLimitations: 'Phase 0 deliberately omits derived metrics (success/failure/rework) per design intent — judge should NOT penalize agent for not computing aggregate signals; the explicit goal is "记原始事件，不急定义 derived metric". Schema completeness + storage roundtrip + 2-question answerability are the only acceptance signals.',
  },
  {
    id: 'h2-planned-105-advisor-consult-phase1',
    source: 'planned',
    category: 'cross-cutting',
    description: 'Verifiable Advisor Consult Primitive (Phase 1 only — single-advisor MVP, no Council)',
    sourceCitation: 'docs/features/v0.7.46.md#feature_105',
    userMessage:
      '实装 Verifiable Advisor Consult Primitive 的 Phase 1（MVP，不做 Council/specialty 扩展）。' +
      '新增 consult-advisor 工具：' +
      '入参 ConsultAdvisorInput { mode: "architecture" | "debug", question, context? }；' +
      '出参 AdvisorAdvice { recommendation: "continue"|"correct"|"pivot"|"stop", advice, verification?: { command?, expected? }, risk? }（强类型，runtime validator 验证）。' +
      '默认偏好：跨 provider 家族（cross_family_preferred）；' +
      'max_uses=2 per task，禁递归 consult，禁 advisor 调用任何 tool。' +
      '2 份 system prompt 模板（architecture/debug 各一）告知 advisor "你是被咨询方，不接管 driving"。' +
      'trace span 14 字段全收（task_id/parent_trace_id/executor 与 advisor provider/model/tokens/latency/recommendation/verification_outcome/cross_family/fallback_triggered 等）。' +
      'MVP 总量 < 800 LOC。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/tools/consult-advisor.ts',
      'packages/coding/src/tools/consult-advisor.test.ts',
      'packages/coding/src/tools/index.ts',
      'packages/coding/src/agents/protocol-emitters.ts',
      'packages/tracing/src/spans/advisor-span.ts',
    ],
    mustNotTouchFiles: ['packages/coding/src/orchestration.ts', 'benchmark/'],
    acceptanceCriteria:
      '[verbatim §核心判断] MVP 是 primitive 不是 Council; 跨 provider 异构是 default preference 不是硬约束; AdvisorAdvice 4 字段强类型; advisor 不能 consult 第二个 advisor; advisor 不能调任何 tool; trace span 14 字段全收; "advice not instruction" 防御标记防 prompt injection; verification.command 字段鼓励填（executor 跑后回灌 trace）。',
  },
];

// ---------------------------------------------------------------------------
// Pool 2 — Open Issues from KNOWN_ISSUES.md
// All run at HEAD-at-eval-time. Bug-fix tasks; agent must reproduce + fix.
// ---------------------------------------------------------------------------

const OPEN_ISSUE_CASES: readonly H2BoundaryCase[] = [
  {
    id: 'h2-issue-105-resume-history-not-injected',
    source: 'open-issue',
    category: 'bug-fix',
    description: 'kodax -c continues session but LLM does not see history — gitRoot filter / initialMessages drift bug',
    sourceCitation: 'docs/KNOWN_ISSUES.md#issue-105',
    userMessage:
      'Bug：用户用 kodax -c 继续会话后 LLM 似乎"忘记"了之前的对话内容，表现为不认识之前讨论过的话题。' +
      '预期行为：(1) kodax -c 自动加载当前目录最近的会话历史 (2) 历史消息作为 initialMessages 注入 LLM 上下文 (3) UI 显示 [Continuing session: xxx] 横幅。' +
      '怀疑路径在 cli_option_helpers.ts:295（设 resume=true）/ InkREPL.tsx:3527（用 storage.list(gitRoot) 过滤）/ agent.ts:959（runKodaX 调 storage.list 不传 gitRoot）/ agent.ts:979（initialMessages 优先级）/ task-engine.ts:4091（managed task worker 路径下 compact 策略可能让 initialMessages 设 undefined）。' +
      '请定位真实漏洞点并修复，加回归测试覆盖 (a) clean resume (b) gitRoot 切换 (c) compact 路径下 history 不丢。',
    gitHeadSha: null,
    mustTouchFiles: [
      'src/cli_option_helpers.ts',
      'packages/coding/src/agent.ts',
      'packages/coding/src/task-engine.ts',
    ],
    mustNotTouchFiles: ['packages/ai/', 'docs/'],
    acceptanceCriteria:
      '[verbatim §Expected Behavior] kodax -c 应该自动加载当前目录最近的会话历史；历史消息应该作为 initialMessages 注入 LLM 上下文；UI 应显示 [Continuing session: xxx] 横幅。修复后回归测试通过且不引入新 regression。',
  },
  {
    id: 'h2-issue-107-harness-profile-rename',
    source: 'open-issue',
    category: 'refactor',
    description: 'Rename harnessProfile {H0_DIRECT|H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL} to workerChain composition (237 refs)',
    sourceCitation: 'docs/KNOWN_ISSUES.md#issue-107',
    userMessage:
      'FEATURE_061 移除了预 Scout 状态机和 Tactical Flow，但 harnessProfile 类型命名 (H0_DIRECT/H1_EXECUTE_EVAL/H2_PLAN_EXECUTE_EVAL) 残留在 237 处引用、10 个文件中：types.ts(5) / reasoning.ts(29) / task-engine.ts(106) / provider-policy.ts(4) / agent.ts(1) / 测试文件(~90)。' +
      '当前 harnessProfile 实际只是 worker chain 的标签：H0_DIRECT → [scout]，H1_EXECUTE_EVAL → [generator, evaluator]，H2_PLAN_EXECUTE_EVAL → [planner, generator, evaluator]。buildManagedTaskWorkers 已经做这个映射。' +
      '步骤：(1) 在 KodaXTaskRoutingDecision 用 workerChain: KodaXTaskRole[] 替代 harnessProfile (2) 保留 harnessProfile 作为 derived label 向后兼容导出类型 (3) 内部路由逻辑改为基于 workerChain 而非 harnessProfile (4) 逐步更新 237 处引用。' +
      '完成后所有测试绿。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/types.ts',
      'packages/coding/src/reasoning.ts',
      'packages/coding/src/task-engine.ts',
      'packages/coding/src/provider-policy.ts',
      'packages/coding/src/agent.ts',
    ],
    mustNotTouchFiles: ['packages/ai/', 'packages/repl/', 'packages/agent/'],
    acceptanceCriteria:
      '[verbatim §Planned Resolution] 1. KodaXTaskRoutingDecision 中用 workerChain 替代 harnessProfile；2. 保留 harnessProfile 作为 derived label（向后兼容）；3. 内部路由逻辑改为基于 workerChain；4. 逐步更新 237 处引用。完成后所有 vitest 测试通过、不引入循环依赖、derived label 正确反向计算。',
  },
  // I-109 mcp_get_prompt — REMOVED 2026-04-30
  //   Verification at HEAD: file packages/coding/src/tools/mcp-get-prompt.ts exists
  //   (created Apr 13), registered in index.ts:75. KNOWN_ISSUES doc-lag.
  //
  // I-110 /mcp commands — REMOVED 2026-04-30
  //   Verification at HEAD: commands.ts:605 has `usage: '/mcp [status|refresh]'`
  //   with status + refresh subcommands wired to extensionRuntime.
  //
  // I-112 ask_user_question modes — REMOVED 2026-04-30
  //   Verification at HEAD: tool docstring says "Supports: single-select,
  //   multi-select, free-text input, and multi-question modes." All 3 modes
  //   implemented. Remaining UI gap (number-vs-arrow nav) is single-file <H2 scope.

  {
    id: 'h2-issue-124-ama-dispatch-rate',
    source: 'open-issue',
    category: 'bug-fix',
    description: 'AMA child agent dispatch trigger rate too low — fanout gate + H1 tool whitelist over-restrictive',
    sourceCitation: 'docs/KNOWN_ISSUES.md#issue-124',
    userMessage:
      'dispatch_child_task 工具（FEATURE_067）和 fan-out scheduler（FEATURE_047）已落地并通过测试，但真实运行中子 Agent 派发频率明显低于预期。具体表现：' +
      '(1) H1 read-only 调研：Scout 升级到 H1 后 controller 的 fanout.admissible 立刻变 false，Scout fan-out 提示被关闭。' +
      '(2) H1 普通改代码任务：Generator 看不到 dispatch_child_task 工具（白名单未包含），无法并行修改多个独立模块。' +
      '(3) H2 写多模块任务：hypothesis-check fanout class 在 controller 里硬编码 return false。' +
      '(4) Plan / systemic 任务的调研阶段：profile === "tactical" 一刀切，managed profile 完全没有 fan-out 路径。' +
      '请修：让 H1 read-only / H2 write / managed plan 调研都能在合适场景拿到 fan-out 提示，但保持 LLM 自主判断（gate 只负责 capability available 不强制并行）。',
    gitHeadSha: null,
    mustTouchFiles: [
      'packages/coding/src/orchestration.ts',
      'packages/coding/src/task-engine.ts',
      'packages/coding/src/agents/protocol-emitters.ts',
    ],
    mustNotTouchFiles: ['packages/ai/', 'packages/repl/'],
    acceptanceCriteria:
      '[verbatim §Expected Behavior] H1 read-only 调研：Scout 和 Generator 都能在多目标场景派 read-only child；H2 多模块写入：Generator 能在独立模块改动时派 write child（已有 worktree 隔离机制）；Plan / systemic 调研：Scout / Planner 能并行调研多个模块作为决策输入。Rule A/B/C prompt 仍由 LLM 自主判断，gate 只负责 "capability available"。',
  },
];

// ---------------------------------------------------------------------------
// Pool 3 — Real Replays of Completed Features
// gitHeadSha pinned to parent of first impl commit. mustTouchFiles from
// `git show <impl-sha> --stat` (objective ground truth, not predicted).
// ---------------------------------------------------------------------------

const REAL_REPLAY_CASES: readonly H2BoundaryCase[] = [
  {
    id: 'h2-replay-feat104-prompt-eval-harness',
    source: 'real-replay',
    category: 'cross-cutting',
    description: 'Build benchmark/harness/ prompt-eval module — alias table + harness + judges + persistence',
    sourceCitation: 'docs/features/v0.7.29.md#feature_104 (impl commits c68ddee → 5873dde)',
    userMessage:
      'KodaX 当前 7 个 tests/*.eval.ts 各自 inline (provider, model, apiKeyEnv) 三元组，没有共享 harness。' +
      '实装 prompt-eval 测试基础设施模块化：' +
      '(1) 建 benchmark/harness/aliases.ts，收敛到 8 个用户指定 coding-plan 短名 (zhipu/glm51, kimi, mimo/v25, mimo/v25pro, mmx/m27, ark/glm51, ds/v4pro, ds/v4flash)；' +
      '(2) benchmark/harness/judges.ts 提供共享 judges (mustContainAll, mustContainAny, mustNotContain, mustMatch, mustNotMatch, lengthWithin, parseAndAssert, runJudges) 含 5 类 category (format/correctness/style/safety/custom)；' +
      '(3) benchmark/harness/harness.ts 提供 runOneShot / runABComparison / runBenchmark 量化版（multi-run + variance + decomposed quality + 9 段 REPORT.md）；' +
      '(4) benchmark/harness/persist.ts 把结果存 benchmark/results/<timestamp>/；' +
      '(5) 41 个 zero-LLM self-test 锁住 alias 表 + judge category + benchmark 矩阵 + REPORT.md 渲染 + persistence + quality-only 设计；' +
      '(6) npm run test:eval 跑真实 *.eval.ts，缺 API key auto-skip。folder 结构 benchmark/{harness,datasets,results}，harness+datasets 进 git，results 不进。' +
      'KodaX 唯一 deviation 是 quality 是唯一打分维度（latency 仅诊断不打分）。',
    gitHeadSha: '71a0574',
    mustTouchFiles: [
      'benchmark/harness/aliases.ts',
      'benchmark/harness/harness.ts',
      'benchmark/harness/judges.ts',
      'benchmark/harness/persist.ts',
      'benchmark/harness/report.ts',
      'benchmark/harness/self-test.test.ts',
      'benchmark/datasets/README.md',
      'benchmark/datasets/.gitkeep',
      'benchmark/results/.gitignore',
      'benchmark/README.md',
      'tests/prompt-eval-harness.test.ts',
      'vitest.config.ts',
    ],
    mustNotTouchFiles: ['packages/'],
    acceptanceCriteria:
      '[verbatim v0.7.29.md FEATURE_104] aliases 表 8 个 coding-plan provider/model；harness 三函数 runOneShot/runABComparison/runBenchmark；judges 5 类 category；persist 写 results.json + REPORT.md + codes/；41 个 self-test 跑在默认 npm test 零 LLM 成本；npm run test:eval 跑真实 .eval.ts；quality-only ranking 不含 speedScore/composite。',
  },
  {
    id: 'h2-replay-recovery-comprehensive-error-recovery',
    source: 'real-replay',
    category: 'cross-cutting',
    description: 'Comprehensive API error recovery: cleanup incomplete tool calls + classification + retry + session recovery',
    sourceCitation: 'commit f6f08cc "feat(recovery): comprehensive API error recovery mechanism" (2026-03-07)',
    userMessage:
      '当前 KodaX 在 LLM API 出错时容易陷入死循环 ——"tool_call_id not found" 反复触发，错误消息对用户也不友好。' +
      '请实装一套完整的 API 错误恢复机制（5 phase）：' +
      '(1) Phase 1：任何错误发生时**总是**清理未完成的 tool call，避免下一轮 prompt 携带 dangling tool_call_id；' +
      '(2) Phase 2：错误分类系统 (TRANSIENT / PERMANENT / TOOL_CALL_ID / USER_ABORT)，新建 error-classification 模块；' +
      '(3) Phase 3：把 retry + jittered exponential backoff 接入 transient error 路径，新建 retry-handler 模块；' +
      '(4) Phase 4：session 级 consecutiveErrors 计数 + SessionErrorMetadata，crash 后能自动恢复；' +
      '(5) Phase 5：用户友好错误消息——把分类结果转成 actionable guidance，REPL 端通过 onError/onRetry callback 反馈给用户。' +
      '原 bug 信号：用户报告"卡住后只能 Ctrl+C，再启动还是同样错误"；预期行为：transient error auto-retry，permanent error 给用户清晰指引。',
    gitHeadSha: 'afc0cd4',
    mustTouchFiles: [
      'packages/coding/src/agent.ts',
      'packages/coding/src/error-classification.ts',
      'packages/coding/src/retry-handler.ts',
      'packages/coding/src/types.ts',
      'packages/agent/src/types.ts',
      'packages/ai/src/errors.ts',
      'packages/repl/src/interactive/storage.ts',
      'packages/repl/src/ui/InkREPL.tsx',
    ],
    mustNotTouchFiles: ['packages/skills/'],
    acceptanceCriteria:
      '[paraphrased from commit body] (1) 任何错误路径都清理 incomplete tool call，杜绝 "tool_call_id not found" 死循环；(2) error-classification 模块提供 4 类分类 (TRANSIENT/PERMANENT/TOOL_CALL_ID/USER_ABORT)；(3) retry-handler 模块对 transient 错误做 jittered exponential backoff，对 permanent 错误不重试；(4) SessionErrorMetadata 跟踪跨 session 的 consecutiveErrors 计数；(5) REPL 通过 onError/onRetry callback 给用户友好提示并提供 actionable guidance。',
  },
  {
    id: 'h2-replay-feat074-subagent-permission-boundary',
    source: 'real-replay',
    category: 'bug-fix',
    description: 'FEATURE_074: replace broken set_permission_mode with exit_plan_mode + propagate plan-mode to children via live closure',
    sourceCitation: 'commit 458f333 "feat(permission): FEATURE_074 subagent permission boundary hardening" (2026-04-18)',
    userMessage:
      'set_permission_mode 工具自引入以来 callback 从未被 wire，整个工具是坏的。请：' +
      '(1) 删除 set_permission_mode（broken since introduction）；' +
      '(2) 引入 exit_plan_mode 作为规范的 plan-exit 工具，tri-state callback 返回 true | false | "not-in-plan-mode"；exit_plan_mode 是 parent-only 工具（CHILD_EXCLUDE_TOOLS_BASE 过滤）；' +
      '(3) plan-mode 约束传给 child agent 走 live predicate closure 不是 snapshot——这样 mid-run 用户切 plan↔accept-edits，下一次 child tool call 就能感知到；' +
      '(4) buildToolConfirmationDisplay 给 exit_plan_mode 单独 case：plan 拆成 detail line；超过 15 行时 head(12) + ellipsis + tail(2)，让用户在 InkREPL 高度受限下也能看到首尾；' +
      '(5) 顺手修一个 scope-adjacent bug——isAlwaysConfirmPath 把 system temp (os.tmpdir / $TEMP / $TMP / $TMPDIR) 排除出"项目外路径必确认"规则，accept-edits 和 auto-in-project 不再为 /tmp 写入弹 dialog（.kodax/ 和 ~/.kodax/ 仍然永远保护）。',
    gitHeadSha: 'c70d8e0',
    mustTouchFiles: [
      'packages/coding/src/agent.ts',
      'packages/coding/src/child-executor.ts',
      'packages/coding/src/tools/exit-plan-mode.ts',
      'packages/coding/src/tools/registry.ts',
      'packages/coding/src/tools/index.ts',
      'packages/coding/src/types.ts',
      'packages/repl/src/common/tool-confirmation.ts',
      'packages/repl/src/permission/permission.ts',
      'packages/repl/src/interactive/repl.ts',
      'packages/repl/src/ui/InkREPL.tsx',
    ],
    mustNotTouchFiles: ['packages/ai/', 'packages/skills/'],
    acceptanceCriteria:
      '[verbatim commit body] set_permission_mode 删除；exit_plan_mode 实装 tri-state callback (true|false|"not-in-plan-mode") 且 parent-only via CHILD_EXCLUDE_TOOLS_BASE；plan-mode 约束走 live predicate closure 不是 snapshot；buildToolConfirmationDisplay 对 plan>15 行 head(12)+ellipsis+tail(2)；isAlwaysConfirmPath 把 os.tmpdir/$TEMP/$TMP/$TMPDIR 从 confirm 规则中豁免；.kodax/ 和 ~/.kodax/ 仍永远保护。',
  },
  {
    id: 'h2-replay-issue116-stream-resilience-stale-round-guard',
    source: 'real-replay',
    category: 'bug-fix',
    description: 'Stream resilience + Issue 116 stale-round guard: generation counter + bufferSealed flag + onStreamEnd guard',
    sourceCitation: 'commit 40ef809 "feat: stream resilience improvements, Issue 116 stale-round guard, child-agent prompt refinement" (2026-04-14)',
    userMessage:
      'Issue 116：用户 Ctrl+C abort 当前轮次后，旧轮次的 streaming 结果还会回灌到下一轮，污染新轮 state（用户看见上一轮残留内容飘进新输入）。' +
      '请加 stream resilience：' +
      '(1) Issue 116 核心：promptGenerationRef generation counter，Ctrl+C 后 increment；旧 round 的 stream 结果被识别为 stale 直接 discard；StreamingContext 加 bufferSealed flag，abort 后拒绝写入；onStreamEnd 加 guard 防止旧 round 污染新 round state；' +
      '(2) Stream stall detection：Anthropic / OpenAI provider 检测 SSE gap >30s，passive logging（不 abort，仅诊断）；' +
      '(3) Heartbeat idle timer：onHeartbeat callback 在 content_block boundary 支持 pause；idle timer 默认关，env/config opt-in；' +
      '(4) max_tokens retry cap：thinking 吃掉输出预算时，auto-continue 重试有上限 KODAX_MAX_MAXTOKENS_RETRIES (default 2)，防死循环；' +
      '(5) Provider recovery UX：recovery info inline 渲染在 streaming 区域内，不再作为独立 history item（修一个 positioning bug）；' +
      '(6) Child agent dispatch：prompt 加更强的 anti-pattern guidance（never dispatch exactly 1 child）。',
    gitHeadSha: '51c0836',
    mustTouchFiles: [
      'packages/coding/src/agent.ts',
      'packages/coding/src/task-engine.ts',
      'packages/coding/src/resilience/config.ts',
      'packages/ai/src/providers/anthropic.ts',
      'packages/ai/src/providers/openai.ts',
      'packages/ai/src/types.ts',
      'packages/repl/src/ui/InkREPL.tsx',
      'packages/repl/src/ui/contexts/StreamingContext.tsx',
    ],
    mustNotTouchFiles: ['packages/skills/'],
    acceptanceCriteria:
      '[paraphrased commit body] Issue 116: promptGenerationRef counter + bufferSealed flag + onStreamEnd guard 共同 fail-closed 拦截 stale-round 污染；stream stall detection 在 Anthropic/OpenAI 上 passive logging（>30s gap，不 abort）；heartbeat idle timer 默认关 env opt-in；max_tokens retry 默认 cap=2 (KODAX_MAX_MAXTOKENS_RETRIES env override)；provider recovery info 渲染在 streaming 区域 inline；child-agent prompt 加 "never dispatch exactly 1" 反 anti-pattern。',
  },
  {
    id: 'h2-replay-feat098-per-model-context-window',
    source: 'real-replay',
    category: 'refactor',
    description: 'Wire KodaXModelDescriptor.contextWindow / maxOutputTokens through to compaction trigger and wire-level max_tokens',
    sourceCitation: 'docs/features/v0.7.28.md#feature_098 (impl commits dc7c38b → 482c2c4)',
    userMessage:
      'KodaXModelDescriptor.contextWindow 和 maxOutputTokens 这两个字段在 KodaX 已声明但运行时**全代码无人读取**——是死字段。' +
      '把它们接通运行时：' +
      '(1) 让 compaction trigger 用当前激活 model 的真实 contextWindow 算（之前硬编码默认值）；' +
      '(2) wire-level max_tokens 用 maxOutputTokens 不是硬编码默认；' +
      '(3) 升级自定义 provider 的 models[] 字段支持描述符对象格式（兼容旧字面量）；' +
      '(4) 修正已知偏差：kimi.k2.5 实际是 256K 不是 128K；zhipu.glm-5-turbo 是 128K；' +
      '(5) compaction 调用点（packages/coding 和 packages/repl 各自的 compaction caller）传入 active model。' +
      '加测试覆盖 cost-rates / base provider 的查找逻辑。',
    gitHeadSha: '1e7f9a1',
    mustTouchFiles: [
      'packages/ai/src/providers/base.ts',
      'packages/ai/src/providers/base.test.ts',
      'packages/ai/src/providers/registry.ts',
      'packages/ai/src/providers/registry.test.ts',
      'config.example.jsonc',
    ],
    mustNotTouchFiles: ['packages/agent/', 'packages/skills/', 'packages/session-lineage/'],
    acceptanceCriteria:
      '[verbatim v0.7.28.md FEATURE_098] contextWindow / maxOutputTokens 死字段接通运行时；compaction trigger 与 wire-level max_tokens 都按当前激活 model 的真实窗口算；自定义 provider models[] 支持描述符对象格式（兼容旧字面量）；kimi.k2.5 = 256K (post-correction)；zhipu.glm-5-turbo = 128K；测试通过。',
  },
];

// ---------------------------------------------------------------------------
// Final dataset (14 cases — comfortably above exploratory floor)
// ---------------------------------------------------------------------------

export const H2_BOUNDARY_TASKS: readonly H2BoundaryCase[] = Object.freeze([
  ...PLANNED_CASES,
  ...OPEN_ISSUE_CASES,
  ...REAL_REPLAY_CASES,
]);

export const H2_BOUNDARY_VARIANTS: readonly EvalVariant[] = Object.freeze([
  'H2-A',
  'H2-B',
  'H1-ref',
]);

// Sanity check at module load — fail fast if dataset shape drifts
if (H2_BOUNDARY_TASKS.length !== 14) {
  throw new Error(
    `FEATURE_107 dataset locked at 14 cases; found ${H2_BOUNDARY_TASKS.length}. ` +
      'See ./candidate-inventory.md if adding/removing cases.',
  );
}
