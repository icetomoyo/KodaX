# FEATURE_022 v0.7.0 人工测试指导

## 这份文档测什么

这份测试指导用于验证 `FEATURE_022: Adaptive Task Engine and Native Multi-Agent Control Plane` 在当前代码基里的完成态。

这轮实际测试范围，不只覆盖最早的 `planner / generator / evaluator` 基础编排，还覆盖本轮继续补齐的这些能力：

- 信号驱动路由：`soloBoundaryConfidence` / `needsIndependentQA`
- 小 review / 小 bugfix 的成本优先路由
- `SA / AMA` 模式切换与状态栏显示
- 结构化重试：router / contract / verdict
- `Harness Budget Controller`
- 渐进式预算披露与 `kodax-budget-request`
- memory strategy：`continuous / compact / reset-handoff`
- Verification v2：`criteria[]` / `runtime-contract.json` / `runtime-execution.md` / `scorecard.json`
- `/project` 与 AMA harness 的统一执行面

说明：

- 文档命名按 feature 设计版本使用 `v0.7.0`
- 当前实际代码行为基线按本轮完成态验证，可视为 `v0.7.4` 时点的 `FEATURE_022`
- `FEATURE_027` 的 `SA / AMA` 切换能力会在本 guide 中一并做联动验证

---

## 测试环境

### 前置条件

- 已在仓库根目录完成依赖安装
- 可正常执行 `vitest` 与 workspace build
- 本机至少配置了一个可正常工作的 provider
- 如果要做完整手工验证，建议准备：
  - 一个 durable provider
  - 一个可做前端或 API 验证的本地项目场景

### 建议工作目录

```powershell
cd C:\Works\GitWorks\KodaX
```

### 关键落盘位置

普通 AMA 任务的 artifact 默认落在：

```text
C:\Works\GitWorks\KodaX\.agent\managed-tasks\<task-id>\
```

`/project` 触发的 managed task 默认落在：

```text
C:\Works\GitWorks\KodaX\.agent\project\managed-tasks\<task-id>\
```

本轮重点检查的 artifact 包括：

- `contract.json`
- `managed-task.json`
- `round-history.json`
- `budget.json`
- `memory-strategy.json`
- `runtime-contract.json`
- `runtime-execution.md`
- `scorecard.json`
- `continuation.json`（仅在 revise / blocked / continuation 场景出现）

---

## 人工测试用例

### TC-022-001：`SA / AMA` 模式切换、状态栏与快捷键

优先级：高  
类型：UI 测试 / 正向测试

前置条件：

- 可正常启动 REPL

测试步骤：

1. 启动 REPL：

```powershell
npm run dev
```

2. 输入：

```text
/agent-mode
```

3. 输入：

```text
/agent-mode sa
```

4. 观察状态栏第一列。
5. 再输入：

```text
/agent-mode ama
```

6. 再次观察状态栏第一列。
7. 使用快捷键 `Alt+M` 连续切换两次。

预期结果：

- [ ] `/agent-mode` 能显示当前模式
- [ ] `/agent-mode sa` 后状态栏第一列显示 `KodaX - SA`
- [ ] `/agent-mode ama` 后状态栏第一列显示 `KodaX - AMA`
- [ ] `Alt+M` 可在 `SA` 与 `AMA` 之间切换
- [ ] 模式切换后不会报错，也不会导致 REPL 卡死

---

### TC-022-002：AMA 任务会生成完整 managed-task artifact 集

优先级：高  
类型：集成测试

前置条件：

- 当前模式为 `AMA`
- provider 可正常执行至少一轮任务

测试步骤：

1. 在 REPL 中发送一个明显不是 trivial 的任务，例如：

```text
请为当前仓库的 session / task routing 设计做一份实现建议，并指出验证标准。
```

2. 等待任务完成。
3. 进入最新的 managed task 目录：

```powershell
Get-ChildItem .agent\managed-tasks | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

4. 检查该目录下的 artifact 文件。

预期结果：

- [ ] 存在独立的 task 目录
- [ ] 至少存在 `contract.json`、`managed-task.json`、`round-history.json`、`budget.json`、`memory-strategy.json`
- [ ] 如果该任务带 verification contract，则存在 `runtime-contract.json`、`runtime-execution.md`、`scorecard.json`
- [ ] `rounds\round-xx\` 下能看到每轮运行痕迹

---

### TC-022-003：小 review / 小 bugfix 不会被不必要地升级为重型多智能体

优先级：高  
类型：成本控制 / 回归测试

前置条件：

- 当前模式为 `AMA`
- 准备一个局部、小范围的请求

测试步骤：

1. 在 REPL 或 CLI 中发起一个小任务，例如：

```text
帮我快速看一下 packages/coding/src/types.ts 里这一个小改动有没有明显问题，只要给简短结论。
```

2. 观察执行过程与 artifact。
3. 打开最新 task 目录中的 `managed-task.json` 或 `round-history.json`。

预期结果：

- [ ] 小范围 review 不会默认展开成很重的 `H2/H3`
- [ ] 若被判定仍在 solo boundary 内，可直接走单 agent 或轻量 harness
- [ ] 如果没有显式独立 QA 需求，不应无意义地产生重型 evaluator 循环

说明：

- 这条用例允许结果是 `H0` 或 `H1 optional QA`
- 重点不是“永远单 agent”，而是“不会无谓烧 token”

---

### TC-022-004：严格 review / 验证请求会触发 QA-required 路径

优先级：高  
类型：正向测试 / 验证测试

前置条件：

- 当前模式为 `AMA`

测试步骤：

1. 发送一个明确要求独立验证的请求，例如：

```text
请严格 review 这次改动，给 must-fix findings，并独立验证关键结论。
```

2. 观察执行过程中的多角色输出。
3. 检查最新 task artifact 中的 `scorecard.json`、`result.json`、`round-history.json`。

预期结果：

- [ ] 可以看到明显的验证/评审角色介入
- [ ] 最终结果不是“review 的 review”，而是面向用户的最终结论
- [ ] `scorecard.json` 存在并包含 criterion 级结果
- [ ] 若未通过 threshold，不会被错误 accept

---

### TC-022-005：预算接近边界时会收敛，而不是突然中断

优先级：中  
类型：边界测试

前置条件：

- 当前模式为 `AMA`
- 准备一个容易触发多轮 refinement 的任务

测试步骤：

1. 发起一个会进入多轮的任务，例如：

```text
请为当前 task engine 重新整理一版实现方案，并在每轮都检查成功标准是否充分。
```

2. 观察中后期 worker 的输出提示。
3. 检查 `budget.json`、`round-history.json`、必要时检查 `continuation.json`。

预期结果：

- [ ] 前期不会从一开始就频繁展示精确 `x/y` 轮数字
- [ ] 接近边界时会出现更强的收口提示
- [ ] 若需要继续，系统会通过结构化延期或 continuation 收口
- [ ] 不应出现“worker 文本突然消失但没有最终状态”的情况

---

### TC-022-006：memory strategy 会根据上下文压力切换

优先级：中  
类型：边界测试 / 回归测试

前置条件：

- 当前模式为 `AMA`
- 已有较长上下文，或人为构造多轮 revise 任务

测试步骤：

1. 连续发起一到两轮较长任务，增加上下文负担。
2. 再发起一个新的 AMA 任务。
3. 打开最新 task 目录中的 `memory-strategy.json`。

预期结果：

- [ ] 文件中可以看到 worker 级 memory strategy
- [ ] 在重上下文场景下，`generator` 或实现 worker 可能切到 `compact`
- [ ] `compact` 场景下不会直接粗暴复用完整原始 session，而是有压缩记忆痕迹

---

### TC-022-007：runtime verification contract 能指导前端/API 验证

优先级：高  
类型：验证测试 / 集成测试

前置条件：

- 准备一个可运行的本地项目或 demo
- 请求中明确要求前端、API 或数据库验证

测试步骤：

1. 发起一个带验证要求的任务，例如：

```text
请修复并验证这个前端问题。验证时需要启动本地应用，检查 UI 流程，并做至少一个 API 健康检查。
```

2. 任务完成后，打开：

- `runtime-contract.json`
- `runtime-execution.md`
- `scorecard.json`

3. 检查其中是否出现启动命令、base URL、UI/API 检查说明。

预期结果：

- [ ] `runtime-contract.json` 记录了运行时验证信息
- [ ] `runtime-execution.md` 给出了更可执行的验证说明
- [ ] `scorecard.json` 中的结论引用了具体 criterion 和证据，而不是泛化判断

---

### TC-022-008：`/project` 会复用同一套 AMA runtime

优先级：高  
类型：集成测试

前置条件：

- 仓库中可正常使用 `/project`

测试步骤：

1. 在 REPL 中执行一轮 `/project` 工作流，例如：

```text
/project next
```

或：

```text
/project auto
```

2. 等待其进入执行。
3. 检查 `.agent\project\managed-tasks\` 下最新任务目录。

预期结果：

- [ ] `/project` 会生成独立 managed task 目录
- [ ] 同样存在 `contract.json`、`budget.json`、`runtime-contract.json`、`scorecard.json` 等文件
- [ ] `/project` 并不是另一套独立 workflow truth，而是复用同一 runtime

---

## 边界与回归关注点

### BC-022-001：非终态 worker transcript 在当前窗口中应保持可见

- 观察 planner / generator / evaluator 的过程输出
- 预期：非终态 worker 的输出不会只短暂出现后完全丢失

### BC-022-002：session 恢复后不应混入 internal worker session

- 使用 `kodax -c` 或 REPL session 恢复
- 预期：恢复的是用户 session，而不是内部 worker session

### BC-022-003：verification runtime 命令不能绕过 shell 写保护

- 检查带写重定向或显式写操作的 runtime command 是否被拒绝
- 预期：运行时 allowlist 不能绕过 shell 写入保护

---

## 可自动测试的用例

下面这些项已经可以通过现有测试直接自动验证。

### 自动验证范围

- `SA` 模式强制单 agent 执行
- 小任务的信号驱动路由与 fallback 信号补全
- router / reroute / protocol block 的结构化重试
- budget controller 的降配与放宽
- `runtime-execution.md` / `runtime-contract.json` / `scorecard.json` artifact
- verification runtime 命令 allowlist 与 shell 写保护
- compact memory seed 行为
- `/project` harness 的 rubric / runtime contract / scorecard
- REPL 状态栏与快捷键的联动测试
- tracker consistency
- `@kodax/coding` 与 `@kodax/repl` 的构建

### 对应用例映射

| 自动用例 | 覆盖重点 | 对应文件 |
|---|---|---|
| `AT-022-001` | `SA` 强制单 agent | `packages/coding/src/task-engine.test.ts` |
| `AT-022-002` | routing signals 与 fallback 合成 | `packages/coding/src/reasoning.test.ts` |
| `AT-022-003` | structured retry / fail-closed | `packages/coding/src/reasoning.test.ts`, `packages/coding/src/task-engine.test.ts` |
| `AT-022-004` | budget controller 与 adaptive rounds | `packages/coding/src/task-engine.test.ts` |
| `AT-022-005` | runtime contract / runtime guide / shell guard | `packages/coding/src/task-engine.test.ts` |
| `AT-022-006` | compact memory strategy | `packages/coding/src/task-engine.test.ts` |
| `AT-022-007` | `/project` rubric / scorecard / retryable verification | `packages/repl/src/interactive/project-harness.test.ts` |
| `AT-022-008` | 状态栏与快捷键 | `packages/repl/src/ui/components/StatusBar.test.tsx`, `packages/repl/src/ui/shortcuts/GlobalShortcuts.test.ts` |
| `AT-022-009` | tracker consistency | `tests/tracker-consistency.test.ts` |
| `AT-022-010` | package build | `npm run build -w @kodax/coding`, `npm run build -w @kodax/repl` |

### 已执行命令

```powershell
npx vitest run packages/coding/src/task-engine.test.ts packages/coding/src/reasoning.test.ts packages/repl/src/interactive/project-harness.test.ts packages/repl/src/ui/components/StatusBar.test.tsx packages/repl/src/ui/shortcuts/GlobalShortcuts.test.ts tests/tracker-consistency.test.ts
```

```powershell
npm run build -w @kodax/coding
```

```powershell
npm run build -w @kodax/repl
```

### 自动验证结果

- `Vitest`：已执行，通过
  - 测试文件：`6`
  - 测试用例：`85`
  - 结果：全部通过
- `@kodax/coding` build：已执行，通过
- `@kodax/repl` build：已执行，通过

本轮已自动完成：

- `AT-022-001` 到 `AT-022-010`

当前仍需人工补完的，是上面的 `TC-022-001` 到 `TC-022-008`，尤其是：

- 状态栏与快捷键的真实交互体验
- 实际 provider 下的小任务成本优先行为
- 接近边界时的渐进式预算披露体感
- 真实前端 / API / DB runtime contract 验证

---

## 测试总结模板

| 用例数 | 通过 | 失败 | 阻塞 |
|---|---:|---:|---:|
| 8 条人工用例 + 10 条自动覆盖项 | 自动覆盖 10 | 自动覆盖 0 | 人工待执行 8 |

测试结论：

- [x] 自动化回归通过，人工验收待补
- [ ] 需要修复后复测
- [ ] 存在阻塞项

发现的问题：

- 本轮自动化验证未发现新增失败项
- 仍建议补做真实 provider 下的 8 条人工用例，尤其是 UX 与 live verification 场景

---

生成时间：2026-03-27  
Feature ID：FEATURE_022  
Feature Design Version：v0.7.0  
当前实现基线：v0.7.4
