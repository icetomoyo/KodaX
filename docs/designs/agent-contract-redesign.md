# Agent 完整契约重组：比较、假设与验证计划

2026-10-26 设计，2026-10-27 更新：**完整显式候选已实现并验证，生产默认未切换**。
实际净收益、52 次有限模型调用及阻挡采用的行为证据见[实施验收](restructured-contract-validation.md)。
以下研究与设计保留原日期口径；统一字符/token 对标见[计数记录](first-turn-uniform-costs.md)。
本记录修正[上一轮审计](agent-contract-audit.md)的适用范围：那一轮寻找的是可直接证明安全的机械去重，
不是判断现有教学架构是否最优。未找到大量机械重复，不能推导“没有结构性冗余”，也不能推导“高智能必须这么长”。

## 1. 结论

KodaX 有值得整体重组的空间，尤其是分散在 Worker、工具描述、状态提示和收尾指导中的计划与协作教学。
当前较长提示混合了真实能力差异、较强产品策略、协议细节、事故恢复经验和解释性文字，不能把全部差额归为必要成本。
应保持 AMA 的行为义务与执行能力，而不是把现有章节、句子数量和强调次数当成不可改变的策略。

源码不能证明新短契约的模型表现等价；同样，没有证据证明当前篇幅是能力下限。
“Codex 级能力”需要拆成正确性、验证、协作、恢复和完整任务效率来测，不能由提示长度或工具数量推断。

## 2. 本地源码对标及口径

本轮未拉取远端。KodaX HEAD `a349eabb9892f9d62299e95d05b3c5b7f9dd2a98` 加已有工作区机械去重；
Pi `136b87e8a7f5a3e5186de0289523ba327dc592fc`；DSH `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`；
Codex `970111f6cb62cc02fe36a82ea7d71b37a2889c97`。
以下 P/D/C 路径分别相对本地参考仓库 `C:/Works/PubProj/pi`、`deepseek-harness`、`codex`；K 相对本仓库。

### Pi：短核心与工具局部规则值得学，不是只能解释成少工具

Pi 的 system builder 收集有效工具的 snippets/guidelines、精确去重，再加入项目内容、skills 和 cwd。
扩展也能贡献工具与指导，因此其短核心体现的是一种装配选择；不能仅用“默认四工具”解释所有差距。
来源：P `packages/coding-agent/src/core/system-prompt.ts:89–123,149–197`。

但扩展集没有唯一总量：示例 Todo 的 id/text/done 与同步子进程 subagent 不等同于 KodaX 的稳定计划、hook、
活 Actor、共享预算和异步恢复。应学习规则归属，而非直接替换执行协议。
来源：P `packages/coding-agent/examples/extensions/todo.ts`、`examples/extensions/subagent/index.ts`。

### DSH：相近异步能力并不必然需要 KodaX 当前的教学长度

DSH 有异步委派、完成唤醒、消息和中断。其协作 system 将“同响应派发独立任务、继续本地工作、只剩等待时结束 turn”
写成一条规则，具体调用行为由工具契约承担。不能将 KodaX 较长协作 system 全部解释成“因为有异步多 Agent”。
来源：D `packages/subagent/tool-subagent/src/index.ts:363–374`；
`packages/subagent/tool-subagent-control/src/index.ts:30–79`。

也核实了工具成本：用当前提交 `snapshots/web/fresh-round-trip` 的生产 schema 投影、KodaX 同一启发式计数，
六项协作工具约 1,279，共享协作 system 约 67，合并 JSON 约 1,351。
这不是整个 harness：未计全局权限、shell、Skill、Goal 等共享规则；是 Bash 快照离线投影，不是新 Windows 抓包或账单 usage。
它说明 DSH 并非把全部长协作教学原样转移到了工具，却不能当作与 KodaX 的等能力精确差值。
生产参数映射依据 D `packages/llm/llm-deepseek/src/serialize.ts:160–165`；
原始离线输入标识 `dsh-cost-source-22ddee-76ffea41793149248300c289bc5a4c60`，保存在 OS 临时目录。

同时存在真实差别：DSH 的 send_message 可以唤醒 idle child；KodaX 将不唤醒消息与 followup 区分。
KodaX 还详细规定写入所有权、tier、增量计划对账及 parallel-first。
这些解释部分协议成本，却不能证明所有说明和例子都必要。
来源：D `packages/subagent/tool-subagent-control/src/index.ts:30–33`；
K `packages/coding/src/agents/worker-role-prompt.ts:200–266`。

DSH Todo 将“多步先计划、简单任务跳过、进行中状态、完成及时更新”放在短工具说明内，整个列表替换。
KodaX 增量 ID 与 evaluator 的能力应保留，但相同基本行为不必在多个章节重新教授。
来源：D `packages/todo/tool-todo/src/index.ts:43–65,137–161`；
K `packages/coding/src/tools/tool-definitions.ts:1382,1487,1526`。

### Codex：既不是恒定短提示，也没有“长提示产生高智能”的证据

当前模型基础模板来自配置/继承状态或模型 catalog，另有 developer、环境、权限、协作和工具上下文。
本地 gpt-6.1-sol 模板为 21,769 **字符**，不是 token 或完整请求总量；不能与 KodaX 6,326 system token 直接比较。
Code mode 的工具还可能通过 AdditionalTools 进入 developer input，顶层 tools 为空不表示零成本。
来源：C `codex-rs/core/src/session/mod.rs:812–847,4603–4701`；
`codex-rs/models-manager/models.json:250`；`codex-rs/core/src/client.rs:1016–1040`。

当前源码的 update_plan 配置缺省关闭，仅显式 true 开启；关闭时可移除 Codex 自有 checklist 教学，
但不改调用者自定义指令。这说明 checklist 是可选产品协议，不是源码认定的编码智能必要前提。
该缺省不代表所有宿主的实际配置，也不是关闭 KodaX AMA 计划的理由。
来源：C `codex-rs/core/src/config/mod.rs:2790–2796`；
`codex-rs/core/src/session/mod.rs:1618–1636`；`codex-rs/prompts/src/update_plan_instructions.rs`。

模型训练、工具使用适配与运行策略的贡献不能从这些源码定量分离；不能假设 GLM/Kimi/DeepSeek 自动复制 Codex 的表现。

## 3. 哪些是能力，哪些是可重组的表达成本

| 当前区域 | 必须保留的行为 | 可重组的内容 | 首选归属 |
| --- | --- | --- | --- |
| PLAN-FIRST / HYGIENE / SCOPE / TERMINATION / Todo 工具 | 非简单工作先有简明计划；续作复用；及时更新；不虚假完成；状态可能外变才刷新 | 同一更新/语言规则多处出现；重复项的长例子、事故解释、进度维护与任务策略混排 | 核心说何时及为什么维护；工具说字段、副作用、失败恢复 |
| PARALLEL-FIRST / COLLABORATION / STEERING / spawn / wait | 独立工作面及时并行；根保留主线；互斥写集；不重复劳动；整合证据并结清所有权 | 多处重复派发/继续工作/等待；API 行为、模型 tier 和策略穿插 | 核心说分工决策；工具说 send/followup/wait/结果读取的不同语义 |
| 执行与收尾 | 真实检查、如实报告、拒绝后不绕过、合法修复可继续 | 各任务类型的解释性因果句；多处反复强调完成不是质量通过 | 一组完整结果与恢复原则；条件特殊要求保留明确触发 |
| 视觉验收 | 有视觉要求时实际查看产物、修复后复验、不用渲染成功替代验收 | 图像/文档/终端/视频等长枚举和多处重复责任说明 | 同请求内的简短条件规则；不新增 discovery |
| Context trust | 可信宿主上下文、低信任文件/Skill/Memory、最新用户纠正、动态事实更新 | 对信封位置、标记、历史摘要格式的实现课程 | 第一批仍保留边界但简化表达；消息 role 重构不混入本批 |
| 平台与 shell | 实际目录、平台、有效 shell；不混用命令语法 | Environment、workspace discipline、工具中重复平台入门例子 | 一份真实环境事实与调用契约；不是只按 win32 猜固定 shell |
| Memory | 低信任证据、精确授权、禁止绕过治理、真实持久化回执 | system 与工具间重复操作说明 | 跨工具安全原则在核心，操作细节只保留一个可见来源 |
| quality_strategy / activeForm 等 | 现有 SDK/遥测/进度能力可继续使用 | 可选遥测为何不应阻塞派发、UI 字段的多处教学 | 工具参数说明，不再作为高优先级全局课程 |

主要依据：K `packages/coding/src/agents/worker-role-prompt.ts:134–365`；
`packages/coding/src/prompts/{execution-guidance,memory-rules}.ts`；
`packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:110–201`；
`packages/coding/src/tools/tool-definitions.ts:615,808,1382,1487,1526`。

这里不是“全部重复都能无风险删除”的证明，而是有源码支持的完整重组机会。
某个功能有真实收益，不代表模型必须反复阅读它的实现原理；历史 bug 的预防条件应成为验收义务，而非永久冻结原文。

## 4. 新候选应怎样设计

**一个决策有一个主要规则来源，操作前所需契约仍在同一次请求中可见。**

1. **短核心行为契约**：范围与最新用户要求、计划及续作、并行与所有权、验证与诚实交付、拒绝与合法恢复。
   按任务决策组织，合并分散的相同义务；保留触发条件、例外和时序，不把 parallel-first 改成可有可无。
2. **工具局部契约**：完整参数、返回值、副作用与 API 语义。已存在的规则可以成为唯一来源；
   从 system 移到 tools 而总字节没少，不算优化。禁止为了省文字让模型先发现、读 Skill 或失败一次才学会调用。
3. **真实运行事实**：权限、当前容量、cwd/shell、已有进度和验证义务保持现有装配；不新建状态服务，
   不让 Runtime 猜 Todo 语义完成，不新增每轮分类器。
4. **已有工具回执内的针对性恢复**：原始错误和当前可行路径随本来就会返回的失败回执提供。
   安全/权限和高频错误的预防规则仍操作前可见；不是用首次失败换取短首轮。

Agent/Coding/Script、AMA、SDK 与专用角色保留。第一候选只改普通 managed root 的教学及归属，
复用现有投影/装配和执行链；不同时重构消息角色、统一 Actor API、删除 Todo hook 或自动同步计划。
这些更深的产品协议问题可以另行讨论，不能混进“文案精简”而悄悄改变策略。

## 5. 10K 的实际难度与已有证据

当前完整 Windows Host 的启发式估算为 14,403：tools 6,967、system 6,326、其余 1,110。
若完全不动工具表达，10K 留给 system 的预算只有 **1,923**。因此只改 system 几句话或只去掉容量重复不会达标；
需要 system 与 tool 教学一起设计，按完整请求计算。
来源：[当前交付口径](managed-tool-contract-validation.md)、[整体成本审计](agent-contract-audit.md)。

旧整体候选曾将当时的 16,352 降至 10,689，说明较大幅度的表达压缩实际做得到；
但 Kimi 完整任务多出请求、GLM 未使用 Todo等问题，使其没有采用。
这证明的是该候选尚未满足条件，不是每条长教学都必要。较小的 254-token 实验每臂一次，
撤回是收益与不确定性的权衡，也不是对整个重组方向的因果否定。
来源：[整体候选结果](compact-contract-validation.md)、[小幅去重撤回记录](worker-teaching-dedup-validation.md)。

旧 Kimi 反复换命令清理的问题，两臂原来都缺少专门拒绝恢复原则；后来已补。
不能把这个已确认的共同缺口全部归因于压缩，也不能忽略候选的迟建计划与额外工作风险。
新候选应在当前修复后的共同基线上验证，不能直接恢复旧候选或重跑旧 revision。
来源：`compact-contract-validation.md` 的“重复拒绝恢复的离线诊断”及“最小修复实施”两节。

10K 保留为设计目标。下一步先交付真实完整候选及规则矩阵，再抓包测净收益；
若只能到 11K 但质量与全任务效率更好，仍有产品价值，不为硬凑阈值删安全边界或有用能力。

## 6. 验证与采用计划

1. **先固定行为验收，而非固定旧文字。** 保留简单直接完成、复杂工作规划、已有计划续作、
   及时并行、互斥写入、证据整合、拒绝后合法恢复、真实验证、准确报告和 AMA 收尾。
   每项标明当前来源、新候选来源、历史失败和反例；独立审查遗漏与冲突。
2. **一次完整候选、零模型离线审计。** 核对全部工具/参数/权限/预算/取消/恢复；SDK、专用角色、
   宿主覆盖保持兼容。捕获实际模型请求，算完整净收益；不以 system 变短掩盖 tools 或上下文变长。
3. **有限真实检查点配对。** 在同一当前基线上比较 GLM/Kimi/DeepSeek：计划续作、明确范围后的分派、
   子任务已完成但综合未完成、拒绝与合法修复、测试失败后的修复、准确收尾。输入来自实际 Runtime，
   不拼接冲突的短 routing 与虚构计划。用语义评审区分合理不同路径与多余工作，不锁定唯一工具序列。
4. **再做有界完整任务。** 固定调用与费用上限，每格一次；原始错误与隔离保持，禁止改写参数或输出。
   同时比较成果、有效测试、策略履行、无效/发现/重试、关键路径往返、根/子/辅助调用、全任务 token/费用/耗时。
   不用一次下一步响应直接断言整个任务更快，也不用最终测试绿灯掩盖反复试探。
5. **按证据采用或修正。** 明确的共同基线缺陷单独修；确定的候选遗漏修正后创建新 revision，
   只验证受影响场景。无解释的重大退化保持候选，不重跑到成功。优先采用可验证的完整收益，不再逐句小收益付费。

## 7. 设计阶段状态（2026-10-26，非当前实施结论）

本轮完成三路独立源码研究及整体设计重评，未改变生产提示、工具或模型路由；零新增付费模型调用。
上一轮已有的 Script 回执去重及 verification 同源去重仍在工作区；本记录不宣称首轮已经进一步下降。
源码支持“值得整体重组”，尚不支持“已经保证智能不降或 10K 必达”。
