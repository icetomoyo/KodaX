# P1 / P2 工具契约实施证据

本文保留切片实施时的记录；后续全量测试、模型评估及提交状态见[汇总报告](first-turn-optimization-implementation-2026-10-14.md)。下文“无付费 eval/无提交”描述本切片最初完成时的状态。

基线 `bd4479d59cab3d082f07c2d34681fff198d82fa0`；产品改动前主 Agent 已冻结 git archive baseline。仅本地测试和静态计数，无付费 eval，无提交。使用 implement/tdd；测试 seam 已由用户确认：registry 真实入口、模型出站与发现、内部 legacy init。

## 改动

- `ask_user_question` 不再错误地要求顶层 `question`，让合法 questions-only 请求进入已有 handler 分支。无问题的非法请求仍由 handler 拒绝；移除误入的 specialist `agent_id` schema。三个 host callbacks 和返回结构不变。
- 独立 AMA builder 在缺 skill runner 或 cwd 时不展示 `run_skill_script`；已有 exclude/visibility policy 仍先于 override 生效。`tool_search` 的 exact lookup 同步能力条件；AMA describe 基于同一 active list。
- coding 内部纯函数 `projectModelToolDefinition` 仅投影 `todo_update`：删除模型 schema 的 `op/items`，要求 `id`，删字段描述中的 legacy `op="update" only.` 前缀。保留原始 registry schema 和 handler 的 init 能力，不改传入对象。未导出新的 package public API。
- SA resolver、AMA override/普通包装、最终 managed adapter、search、SA/AMA describe 复用投影。模型看不到旧 init 教程；SDK/runner 仍能通过真实 registry 执行 init。
- 四个 todo descriptions 去掉重复 Fields/When To/例子教学；局部参数 schema 保留状态枚举、activeForm、metadata shallow merge/key-null/top-level-null、evaluator、description 清空等完整契约。短描述保留稳定 id、增量语义、语言、owner、hook/veto、状态恢复、unknown-id 与 inactive 错误处置。没有更改 todo 状态机或完成执行。

## RED → GREEN

以下命令均在仓库根运行：

| Seam | RED 命令 / 预期失败 | GREEN |
|---|---|---|
| registry batch ask | `npx vitest run packages/coding/src/tools/registry.test.ts -t 'executes questions-only'`：required question 先挡住 handler，返回 Tool Error 而非答案 JSON | registry + ask-user-question 两文件 53 passed |
| 独立 AMA skill capability | `npx vitest run packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts -t 'advertises skill scripts'`：无 runner 仍包含工具 | wiring + tool-search 两文件 58 passed |
| SA model projection / immutability | `npx vitest run packages/coding/src/agent-runtime/__contract-tests__/cap-021-tool-resolution.contract.test.ts -t 'model-visible todo contract'`：required 为 undefined | 此文件 17 passed |
| AMA override、两种发现与 SA describe | `npx vitest run packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts packages/coding/src/agent-runtime/__contract-tests__/tool-dispatch-bridge.contract.test.ts -t 'incremental'`：两项 required undefined | wiring / bridge / search 三文件 68 passed |
| 最终 managed 出站 | `npx vitest run packages/coding/src/task-engine/_internal/managed-task/llm-adapter-tool-contract.test.ts`：SDK 调用者传入原始定义时 required undefined | adapter / registry / todo-update 三文件 105 passed，含 registry init 回归 |

最终合并定向执行 **13 文件 / 250 tests 全通过**，覆盖 registry、ask-user-question、tool-search、feature-259 prompt contract、四种 todo handler、todo-v2 integration、runner wiring、managed adapter model contract、SA resolver 与 bridge。`npx tsc -p packages/coding/tsconfig.json --noEmit --pretty false` 通过；`git diff --check` 无 whitespace error（Git 对已有 CRLF 策略给换行提示）。全仓测试/build 与跨 Agent code review 由主 Agent 汇总。

## 同口径静态收益

计量仍使用旧 inventory 的每工具 `{name,description,parameters}` JSON，与 KodaX `countTokens`。不是 provider BPE/API usage。

| 工具 | 原估算 | 新估算 | 减少 |
|---|---:|---:|---:|
| ask_user_question | 1,319 | 1,258 | 61 |
| todo_create | 1,031 | 538 | 493 |
| todo_get | 346 | 164 | 182 |
| todo_list | 290 | 112 | 178 |
| todo_update | 2,234 | 936 | 1,298 |
| 合计 | 5,220 | 3,008 | **2,212** |

无 runner 的独立 AMA fixture 另移除 `run_skill_script` 的 307 估算 tokens；已绑定真实 runner 的 Runtime 路径不应计这项收益。可复跑脚本与逐项精确字符/UTF8 bytes 位于 `p1-p2-tool-contract-metrics-2026-10-14.ts/.json`。

收尾恢复 todo_create/update 中 `primary natural language of the user's request` 的跨路径语言契约表述后，language-continuity / todo-create / todo-update / todo-list / todo-get / feature-259-prompt-contract 六文件 **110 tests 通过**。上表与 JSON 已按该最终文本重算。

## 风险与边界

- 移除 schema required question 是纠偏，不代表问题可省略；handler 仍校验合法单问/批问分支。未新增 provider-specific anyOf。
- 投影是模型接口，不是权限/执行隔离；内部或旧 caller 仍可显式 init。这是保持 SDK 兼容的预期行为。
- 内容缩短是否改善真实模型任务完成率没有实测；确定性测试验证输入/执行/发现契约，没有把成功率推断成已验证。
- 旧 metadata `type:object` 与 handler 接受 top-level null 的差异未在本次扩成公共 schema 类型变更；其说明仍保留，现有兼容行为未改。
- 当前 keyword search 原本只搜 deferred catalog；本次没有扩大搜索范围、引入新 activation/配置框架或改执行权限机制。
