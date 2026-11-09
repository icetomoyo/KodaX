# FEATURE_184 v0.7.42 — Sidecar Verifier 人测指引

> **目的**：验证 (1) chain Evaluator 已退役，Worker/Generator text-only 终止后由 Sidecar Verifier Stop hook 接管；(2) 三态 verdict (accept/revise/blocked) 正确映射到 main agent reanimate / 终止 / surface 给用户；(3) 默认 inherit-main provider，env vars opt-in cross-family override；(4) Phase D.3 UI affordance — sidecar 跑期间 spinner 显示 `[AMA Verifying]`；(5) `EVALUATOR_AGENT_NAME` / role-prompt evaluator case / F167 B0/B1/B2 fallback 死代码已彻底删除。
>
> **前置**：
> - 任意可用 provider API key（推荐 anthropic / ark-coding，main + sidecar 都能跑）
> - KodaX v0.7.42 已构建（`npm run build`）
> - 测试在任意有少量代码的 git 仓库下做（KodaX 自身仓库即可）

---

## Test 1 — 死代码结构性回归保险

### 步骤

1. grep `EVALUATOR_AGENT_NAME` 在生产代码（去掉 test 文件）：
   ```bash
   grep -rn "EVALUATOR_AGENT_NAME" packages/coding/src/ --include="*.ts" --exclude="*.test.ts"
   ```
2. grep evaluator role-prompt branch：
   ```bash
   grep -n "case 'evaluator'" packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts
   ```
3. grep F167 B0/B1/B2 fallback:
   ```bash
   grep -rn "B0_SKIP\|B1_RETRY\|B2_SYNTH\|EvaluatorFallbackSynthesizedInfo" packages/coding/src/ --include="*.ts" --exclude="*.test.ts"
   ```

### 期望结果

- Test 1.1 **无输出**（C.3 已删 EVALUATOR_AGENT_NAME 常量 + 所有 import）。
- Test 1.2 **无输出**（C.3 已删 role-prompt evaluator case）。
- Test 1.3 **无输出**（C.2/C.3 已删 F167 三层兜底；retry 逻辑搬到 Sidecar Verifier 自己的 timeout）。

### 失败排查

| 现象 | 诊断 |
|---|---|
| grep 命中 `.ts` 生产代码 | C.3 漏删 — 用 `git log -p` 看哪个 commit 没清 |
| 命中 `*.test.ts` | 正常 — 历史回归测试可以保留 `EVALUATOR_AGENT_NAME` 字符串用于"删除生效"断言 |

---

## Test 2 — Sidecar Verifier 默认 inherit-main provider

### 步骤

1. 启动 KodaX（**不设** `KODAX_VERIFIER_PROVIDER` / `KODAX_VERIFIER_MODEL` env var）。
2. 发一个**触发 Worker text-only 终止**的任务：
   ```
   读 README.md 然后总结成 3 个 bullet point。
   ```
3. 观察 transcript：worker 读完后会输出 3 个 bullet（text-only 终止）。
4. 看 spinner 在 worker 终止后是否显示 `[AMA Verifying] checking agent output...`（Phase D.3 — 3-10s 窗口）。
5. 等 sidecar 结果出来：要么直接 accept（loop 终止 → 任务完成），要么 revise（main agent 收到合成 user msg 继续），要么 blocked（surface 错误给用户）。

### 期望结果

- Test 2.3 spinner **必然**在 sidecar 跑的时间窗口显示 `[AMA Verifying]` 前缀（Phase D.3 新增）。**不能**显示 `[AMA H2 - Worker]` 或之前的 worker label。
- Test 2.5 sidecar verdict=accept 时 loop 干净终止；verdict=revise 时 main agent 收到 reanimate（spinner 回到 Worker label）；verdict=blocked 时 transcript 显示 sidecar 的 reason 文本然后任务 abort。

### 失败排查

| 现象 | 诊断 |
|---|---|
| spinner 仍显 `[AMA Worker]` 不变 | observer.sidecarStarted() 没接进 composedStopHook — 看 `runner-driven.ts` 1612 行附近的 `observer.sidecarStarted();` 调用 |
| spinner 显 `[AMA Verifying]` 但 sidecar 永远不返回 | 多半是 inherit-main provider 出错 — sidecar 默认 15s timeout 走 fail-open accept。看是否 worker 终止后 spinner 卡 ≥15s |
| sidecar 似乎根本没跑 | composedStopHook 的 isExecutionRole gate 或 isIdleYieldTurn gate 把它 skip 了 — 用 `KODAX_VERIFIER_PROVIDER=anthropic KODAX_VERIFIER_MODEL=claude-haiku-4-5-20251001` 强制 explicit 路径再试 |

---

## Test 3 — Cross-family opt-in（KODAX_VERIFIER_PROVIDER + KODAX_VERIFIER_MODEL）

### 步骤

1. 启 KodaX 时设 env vars 走异族验证：
   ```bash
   KODAX_VERIFIER_PROVIDER=anthropic \
   KODAX_VERIFIER_MODEL=claude-haiku-4-5-20251001 \
   kodax
   ```
2. 用一个 main provider 不同 family 的任务（如果主 provider 是 zhipu/glm-5.1，那 sidecar 走 anthropic claude；这样能确认 cross-family 路径活了）。
3. 触发同 Test 2.2 的 worker text-only 终止任务。

### 期望结果

- spinner 走 `[AMA Verifying]`，但 verifier 的实际调用应该走的是 anthropic claude（看 trace / billing 能确认）。
- 行为与 Test 2 一致（accept/revise/blocked 三态）。

### 失败排查

- env var 拼写正确但仍走主 provider：看 `packages/coding/src/agent-runtime/middleware/sidecar-verifier/verifier-provider-resolver.ts` 的 `source: 'explicit-env'` 分支是否生效。

---

## Test 4 — Phase D.3 UI affordance unit test 检查

### 步骤

```bash
npx vitest run packages/repl/src/ui/utils/transcript-layout.test.ts \
              packages/coding/src/task-engine/_internal/managed-task/observer-bridge.test.ts
```

### 期望结果

- transcript-layout：71 tests pass，含 "renders a Verifying prefix while the sidecar verifier is running (FEATURE_184 D.3)"
- observer-bridge：3 tests pass，含 sidecarStarted 的 emit 形状 + NULL_OBSERVER 完整性。

---

## Test 5 — Sidecar verifier unit + Phase D.4 prompt eval

### 步骤

```bash
npx vitest run packages/coding/src/agent-runtime/middleware/sidecar-verifier/
```

可选（有 API key + ≥ $0.5 预算）：
```bash
KODAX_F184_PROBE=pilot npx vitest run -c tests/config/vitest.eval.config.ts \
  tests/feature-184-sidecar-verifier.eval.ts
```

### 期望结果

- 35 unit test pass（verifier / verifier-provider-resolver / verifier-recorder-bridge）。
- pilot 模式 (1 alias × 1 case × 1 run = 2 calls): baseline + treatment 各 1 cell PASS（case B intent-vs-action floor）。

---

## 设计参考

- ADR-030：claudecode-Shape Main Agent + Sidecar Verifier Substrate
- v0.7.45.md §FEATURE_184（feature 计划文档，commit message 用 v0.7.45 来源）
- 注：本 feature **架构变更已 land 进 0.7.42 主线**；commit message / docs 路径里 v0.7.45 是规划文档名，**不**等同于 release 版本号。
