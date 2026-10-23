# 工具注入模式：源码对标与最小实施边界

2026-10-23。当前默认仍为完整 native；本轮没有新增产品模式开关、通用 JS 工具运行时或付费模型调用。
已实施的是自动仓库上下文去重；Repo 四项与 LSP 八项仅拆成独立的测试投影。
AMA 的规划、派发、结束策略、SDK、专用角色及底层工具能力保持不变。

## 三个独立决定

1. **能力与职责**：宿主注册什么，当前角色实际允许什么。`@kodax-ai/agent` 本来就只接收调用方声明的工具，coding 包负责附加编码能力；不应让通用框架反向认识 Repo/LSP 工具名。
2. **模型呈现**：同一执行集合是完整 native，还是核心 native 加专项目录/按需契约。仅省 schema 时不能用 exclude/visibility policy 删除执行权限，否则 bridge 也不能恢复它。
3. **调用方式**：逐项 native/JSON bridge，还是模型提交 JS，在一次程序内组合工具、分支、并行和筛选输出。这才是通用 Code Mode/PTC 的新增执行能力。

现有 child/specialist 的工具声明和安全上限继续作为职责边界。Plan 是实时权限状态，允许的计划文档/临时文件编辑不能因缩小菜单而丢失；本轮未改 Plan 菜单。

## 本地参考源码的实际行为

固定 Codex `deede7201da27a178c39befa6b4959bb7d451645`，DSH `687f282e8625c6b8d11ff58211a90524be2e4317`；不是远端实时目录或所有安装版本的结论。

| 项目 | 按职责/模式注入 | 程序化调用 | 首轮成本要点 |
| --- | --- | --- | --- |
| Codex | registry exposure 区分 direct/deferred/code-only 等；模型元数据优先于 feature 开关 | async JS isolate、tools SDK、嵌套 executor、yield/wait | Code Mode Only 的常用完整声明仍嵌入 exec；deferred 才延迟，不能只数 wire tools |
| DSH | preset 组成能力，scoped presentAs 选择 native/PTC，同进程可并存 | run_code、生成 SDK、隔离进程、scope 重验与取消排空 | PTC 初始注入全量可见 SDK，含返回类型；Standard/PTC 的 workflow 绑定也不同 |
| KodaX | 已有宿主可用性、child/specialist、profile/policy 边界；AMA 无通用用户可选的 native/deferred/code 呈现模式 | 单目标 checked bridge；另有 Agent Workflow 与 Construction 复合工具 | 目前专项延迟仅测试投影；不能称已提供通用 Code Mode/PTC |

Codex 本地 catalog 的 sol/astra 等指定 `code_mode_only`，因此这些模型常规就选择它；单看默认 false 的 CodeMode feature 会误判。DSH Minimal 确实关闭文本文件工具和许多 harness 组件，不是保持全部能力的轻量呈现基线。

KodaX 并非完全没有代码编排：`run_workflow` 用受限 JS 的 wf API 编排 Agent；Construction handler 的 ctx.tools 可组合白名单工具，但需要安装/验证/激活生命周期。两者都不等于普通模型直接提交临时 JS 调用当前 builtin SDK，也不能默认推导 token 更省。

源码入口：

- Codex：[模式选择](C:/Works/PubProj/codex/codex-rs/core/src/tools/mod.rs:65)、[工具呈现](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:850)、[SDK 披露](C:/Works/PubProj/codex/codex-rs/code-mode-protocol/src/description.rs:321)、[嵌套执行](C:/Works/PubProj/codex/codex-rs/core/src/tools/code_mode/mod.rs:404)。
- DSH：[scope 呈现](C:/Works/PubProj/deepseek-harness/packages/core/agent-tool-presentation/src/index.ts:59)、[SDK 注入](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1019)、[内层执行及排空](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/ptc.ts:686)、[能力组成](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml:11)。
- KodaX：[agent 声明](../../packages/agent/src/primitives/agent.ts)、[child 能力](../../packages/coding/src/child-executor.ts)、[AMA 工具构建](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts)、[单目标 bridge](../../packages/coding/src/tools/tool-bridge.ts)、[Workflow](../../packages/coding/src/tools/run-workflow.ts)、[Construction](../../packages/coding/src/construction/ctx-proxy.ts)。

## 本轮已经实施与验证

真实 Runtime 首请求的离线回归先失败：同一个 managed-run-context 的 overview/scope 各出现两次。根因是自动 context builder 同时追加当前 baseline 和 preturn bundle 内同源的缓存 baseline；不是两个独立语义引擎提供额外证据。

最小修复在 [repo-intelligence middleware](../../packages/coding/src/agent-runtime/middleware/repo-intelligence.ts)：优先当前请求的 baseline，失败时用 bundle 回退。调用方 context 不解析、不改写；module、impact、低置信度指导和冷启动预算保留。续会话尊重原有 overview gate，当前变更范围不会被旧缓存覆盖。未删除后台索引或更改缓存生命周期。

测试覆盖真实 SDK 首轮、caller 原文保留、当前/缓存新旧证据、失败回退、续会话 scope，以及既有预算/compaction 回归。只有这一处去重进入生产源码；没有合并或删除工具。

独立 $0 Runtime 抓取（54 个原生工具）与测试投影：

| 呈现 | 首轮原生数量 | 相同 countTokens 估算 | 相对同次 native |
| --- | ---: | ---: | ---: |
| 完整 native | 54 | 19,732 | 0 |
| 仅详细 Repo 四项延迟 | 50 | 19,192 | -540 |
| 仅 LSP 八项延迟 | 46 | 18,756 | -976 |
| 十二项一起延迟 | 42 | 18,149 | -1,583 |

旧冻结输入中被重复追加的 baseline 片段约 405 估算 token。本次路径/时间戳不同，不能把新旧抓取总量的全部差额归于修复；以上也不是新 API usage 或与 Codex/DSH 同能力的对照。
旧 r3 两个冻结输入的十二项投影逐字节保持一致；新 family 选择仅用于测试，保留原实验解释。原 r3 GLM/Kimi 结果仍为修复前证据，不冒称本次修复后已重新跑过模型。
原始离线输入与度量位于 OS Temp `kodax-eval-dumps/context-modes-20261023-r1`。

## 后续实施顺序，尚未默认启用

1. 保留 **Native** 兼容路径；沿用既有角色和宿主能力，先验证同一 inventory 的 **核心 Native + 专项 Deferred**。分开 Repo 与 LSP，继续用批量 tool_search/checked tool_call，不新增路由 Agent、阶段工作流或业务分类器。
2. 先补无工具名提示的自然发现和真实语言服务器。当前本机未发现安装的 TypeScript LSP；已有协议 fixture 不能代替编译器语义。发现、错误参数、拒绝恢复、只读及动态撤销均需真实 executor 证据。
3. 若进入产品，呈现、完整 discovery 集合、上下文/compaction 预算和 child briefing 必须由同一次可信请求绑定产生；不能只在 provider 边界隐藏，仍按旧完整 schemas 预留。专用角色原声明不变，权限仍在执行时重验。
4. 小规模 GLM/Kimi 固定任务配对比较完成质量、完整任务 token、费用、缓存和耗时，再候选复杂 E2E。保留上轮 Kimi 多一轮反而更贵及报告措辞偏差，不因首轮降量直接启用；遵循 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md)，不为重算指标重跑生成。
5. **通用 Code Mode 单独立项验证**：先证明存在有价值的工具往返/大结果筛选成本。可研究复用现有受限 runtime、capability proxy 和 executor，但不能直接把 node:vm 当安全隔离，或放开现有 Workflow/Construction gate。必须保证逐个内层权限/预算/来源、部分成功后不自动重放、错误可恢复、输出有界、取消排空和 Windows 子进程清理；无收益证据时不新增运行时依赖。

这三个呈现候选不是新的 AMA/SA 执行策略。是否需要用户可选的产品开关，等兼容性与收益明确后再收敛；当前不加入未验证配置，也不承诺 Code Mode 会让 GLM/Kimi 更强或让首轮自然更小。
