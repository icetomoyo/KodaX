# pi 与 KodaX Agent 工作面的复核：事实、差距与未实施候选

2026-10-25。本轮由三个子 Agent 分别审计 pi 完整装配链、执行可靠性、KodaX
额外契约的价值，并交叉讨论。结论：**pi 的完整 coding-agent 确实可以保持很短的默认输入；
加入官方规划、Todo、子 Agent 和交互扩展，也没有接近 KodaX Agent 的 16k。
因此不能用“我们有 AMA”解释全部差距。** 但目前没有同模型、同任务的行为等价证明。

本文记录研究结果和实验建议，**不是已接受或已实施的产品变更**。
本轮生产代码未修改，真实模型调用为 0。

这里的“0调用”指本篇源码调研批次；后续已有受控配对及4次真实Coding复杂编辑，见
[最终验证](compact-teaching-validation.md#9-最终完整编辑-e2e-结果)。不能把它写成pi与KodaX的
同模型能力对比：pi未在该评测中执行。

后续执行结果见[紧凑教学验证](compact-teaching-validation.md)：补回continued计划条件后
v3净差为857；15次有限配对已完成，默认保持不变。下文874仍作为原v2研究记录保留。

## 1. 来源和计量边界

- pi 本地源码固定为 `136b87e8a7f5a3e5186de0289523ba327dc592fc`，目录
  `C:/Works/PubProj/pi`，未更新、安装扩展或执行 provider 请求。
- KodaX 为 `5ebfbc0c` 加当前工作区。完整三模式输入及历史基线见
  [成本复核](first-turn-mode-cost-review.md)，不能把分支 HEAD 当作全部待提交实现。
- 以下使用同一字节启发式估算，非 provider tokenizer、API usage 或账单。
  KodaX 数据来自已保存的真实序列化请求；pi 是生产 system renderer 加源码 schema
  的投影，采用合成 function wrapper，未验证 provider 的进一步 schema 转换。
- 两者均取干净配置：无个人/项目说明、额外 MCP 和用户扩展；KodaX 保留官方 builtin 目录。
  pi 的增强配置额外计入下述官方扩展。不能将此表当成完整能力、任务质量或费用排名。

## 2. pi 的计划、多 Agent、协作和交互实际存在于哪里

| 能力 | 默认与官方扩展的实际边界 |
| --- | --- |
| 自然语言规划、解释、向用户发问 | 默认即可；没有计划工具不等于模型不会规划 |
| Plan 模式 | 官方 plan-mode 扩展；支持进入/退出、只读工具约束、执行阶段和恢复；不是默认常驻模式 |
| Todo | 官方扩展，一个工具的 list/add/toggle/clear；状态可从会话分支恢复 |
| 子 Agent | 官方 subagent 扩展；独立进程/上下文、single/parallel/chain、流式输出、取消和用量统计 |
| 持续协作 | 上述示例未提供与 KodaX 相同的 live mailbox、followup 和责任收尾协议；不能扩大为整个 pi 生态没有 |
| 结构化交互 | question / questionnaire 官方扩展；选项与自由文本，多问题可用后一种；非 TUI 有能力限制 |
| 用户中途纠正、取消、恢复和压缩 | 核心 AgentSession/执行循环支持，并非靠大量首轮教学才存在 |
| Skills、MCP、Code mode | 当前源码具备；配置会增加输入。Code mode 默认 inactive，MCP 默认脚本暴露可自动激活它 |

源码：pi `packages/coding-agent/src/core/settings-manager.ts:85`、
`src/core/agent-session.ts:1547,1595,1922,2275`、`src/core/system-prompt.ts:60,128`；
`examples/extensions/{plan-mode/index.ts,todo.ts,subagent/index.ts,questionnaire.ts}`；
`src/extensions/mcp/index.ts:496,508,519`。短路径均相对 pi 的 `packages/coding-agent/`。
官方来源：[coding-agent](https://github.com/earendil-works/pi/tree/136b87e8a7f5a3e5186de0289523ba327dc592fc/packages/coding-agent)、
[subagent](https://github.com/earendil-works/pi/tree/136b87e8a7f5a3e5186de0289523ba327dc592fc/packages/coding-agent/examples/extensions/subagent)。

扩展可在启动时以 `-e` 静态装配，不要求先用一次模型调用发现它们。
但 subagent 的角色目录在调用时发现，首轮未枚举全部角色；未知角色可能产生恢复步骤。
子 Agent 自己的角色说明、工具和请求也必须计入完整任务，不能因父首轮小而忽略。

## 3. 加上这些能力以后，仍然多大

| 配置 | 模型输入字段估算 | 方法 |
| --- | ---: | --- |
| pi 默认 read/bash/edit/write | 1,414 | coding-agent 生产 renderer + 四工具源码投影 |
| pi 四工具 + Todo + subagent + question | 2,122 | 同上，计划扩展关闭态不增加计划教学 |
| pi 四工具 + Todo + subagent + questionnaire | 2,282 | 多问题替换单问题工具，不同时累计 |
| 上项进入两步计划执行态 | 2,347 | 当前执行状态；不同时累计只读计划阶段文本 |
| KodaX Agent | 16,379 | 当前 normalized wire；36 原生入口 |

独立扩展契约约为 Todo 96、question 154、questionnaire 315、subagent 457。
这些定义来自实际 TypeBox 表达式的等价投影；不是在本机安装后的抓包。
计划执行夹具只有 `Inspect the failing boundary` 和 `Fix it and run the relevant tests`
两项；真实长计划会增长。未额外虚构技能或角色目录。
2,347 对应恢复原工具集后的执行态；只读 Plan 态会移除 edit/write 并加入
grep/find/ls/questionnaire，本轮未计算该态完整总量。

因此应同时保留两个结论：增强后的 pi 确实仍然很小；它也没有自动承担 KodaX 的全部
共享预算、所有权、审批、SDK 交互和恢复语义。能力不同不能成为忽略数量级差距的理由。

## 4. 为什么短输入仍可能有较好的任务表现

源码支持的工程解释是：模型负责选择方法，执行器负责稳定落地，会话层负责状态；
模型无需在每轮理解所有内部机制。这不是“短提示词本身让模型更聪明”的因果结论。

- pi edit 做唯一/重叠校验、原文件快照批编辑、换行/BOM 处理和同路径写入队列；
  取消不能提前释放仍在 I/O 中的锁。见 `src/core/tools/edit.ts:112,174,215`、
  `file-mutation-queue.ts:1`。KodaX 已有 anchor 容错、锁和 CAS，不能重复造一套。
- read/bash 有结果上限、后续读取路径、错误和退出状态；模型能根据真实反馈继续。
  见 `src/core/tools/{read.ts:170,bash.ts:39,truncate.ts:10}`。
- UI 的 diff/details 可保留在会话中而不自动发送模型。真正 Responses/Anthropic
  序列化取 content；不是 `convertToLlm` 删除了 details。见 pi
  `packages/ai/src/api/openai-responses-shared.ts:410`、`anthropic-messages.ts:1355`。
- Plan 扩展只在当前阶段追加相应状态；会话队列、恢复、压缩由运行时管理。
  压缩和子任务仍有后续模型费用，不能当作零成本。

作者的[第一方介绍](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
主张利用模型已有知识、减少固定工作流；也发布了
[TerminalBench 运行记录](https://gist.github.com/badlogic/f45e8f6e481e5ab7d3a50659da84edaa)。
这支持极简 harness 可完成真实任务，但不是当前 KodaX 与 pi 的同模型消融实验。
旧文的 MCP 等能力状态已经变化，当前功能以本次固定源码为准。

## 5. KodaX 哪些成本应当重新证明价值

Agent 当前工具约 9,062，system 约 6,194，其他消息/包装约 1,123。
所以只删 builtin Skill 或继续挑一两个小工具，不足以解决主要差距。
计划/协作能力本身与其当前表示成本应分开评估：

| 研究范围 | KodaX 现状 | 值得审计的内容 |
| --- | ---: | --- |
| 协作工具族 | 约 2,122 | 生命周期各入口、参数和 system 是否重复解释同一义务；不把单次 subagent 当作 live 协作等价替换 |
| Todo 工具族 | 约 1,113 | 更新/创建共通参数与里程碑规则的重复；保留 owner、已有进度和完成检查 |
| ask_user_question | 约 801 | 单问/批问结构和 UI 可选参数的表达成本；保留 SDK 与交互语义 |
| 常驻 Worker 教学 | 稳定段约 4,535 | 原子义务是否多处重复，模型是否需要实现细节；不是全部 system 的数字 |

这些数值是审计范围，不是可删除额度。仅仅“有内部引用”不足以证明必须首轮声明；
仅仅“host 会拒绝错误”也不足以证明可以删除预防教学，因为拒绝会增加往返。
跨平台 grep/glob 的可预测性、只读隔离、预算、取消、持久状态有实际价值，不能为了模仿
pi 的四工具清单而要求模型先探测 shell/依赖或用文件手工重建框架状态。

### 已做的最小反事实

KodaX `worker-role-prompt.ts:307–350` 已有较短教学分支。本轮只在临时文件中重写模型文本，
保留全部 36 工具、parallel-first 原文和原有执行链。直接切短分支会丢义务，因此未采用。
补回初始计划去重豁免、父/叶区别、owner、容量满不重试、wait/mailbox、子 Agent 收尾等后：

- Worker 稳定段：4,535 → 3,673。
- 完整 Agent 输入反事实：16,379 → 15,505，约少 **874（5.3%）**。

这证明存在紧凑表达的候选空间，不证明实际模型行为保持。没有修改默认分支，未把它计为已实现收益。
交叉复核进一步补回 evaluator 的节制使用、严重性校准、源语言/引文和简单调查豁免，
因此最终数值为 874；中间版本的 916 不作为最终收益。
子 Agent 交叉审计纠正了一项归属：每 owner 仅一个 in_progress 当前靠模型教学，
不是可以直接删除的 host 硬约束。双方也保留了满容量避免重试的教学。

## 6. 下一步建议及停止条件

1. **先保留全部工具与 AMA，只比较紧凑教学。** 将候选逐条映射到现有义务及历史失败轨迹，
   验证空计划、恢复计划、子 Agent 容量/证据/收尾、只读拒绝、编辑失败及真实报告。
   宿主回归只能证明机制，不能替代模型决策验证。
2. **之后单独审计模型契约的表达。** SDK/handler 保留不是隐藏入口无损的充分条件；
   不做需要额外 tool_describe、模式切换或故意失败才能继续的精简。
   对确实重复的参数/说明先做独立候选，不同时改变工具和策略。
3. **把全任务输出也纳入优化。** 审查重复的 UI/回执字段实际是否进入模型，保留错误、
   截断、部分副作用和验证证据；不能只按日志大小宣称 token 节省。
4. **有意义的候选才做有限真实模型配对。** 先完成现有三模式评测守卫的叶执行覆盖，
   冻结版本、任务与合理预算，再用 GLM/Kimi 核对质量、往返、root/child/辅助全部 token、
   费用与耗时。不得通过增加拒绝重试、漏报测试、牺牲协作或扩大预算掩盖回退。

Agent 应向 pi 的轻量表达与模型自主性靠拢；不把 1.4k 设成必须达成的指标，
也不把 16k 视为保留 AMA 的必然成本。本轮不新增第四模式，不改变 Coding 默认。
当前没有充分证据宣布最终三模式的智能与全任务效率验收完成。

## 7. 可复核证据与未验证范围

临时证据（不提交）为 OS Temp 下 `pi-extensions-cost-20261025/` 的 report 与完整投影、
同名 `.cjs` 提取脚本，以及 `kodax-compact-existing-guidance-vVvSDP/` 的
`candidate-restored-v2.txt`、逐项恢复记录及 `restored-result-v2.json`。
完整装配、工程价值、反方审计笔记在 ignored `docs/research/`；本文独立保留决策必要事实。

未验证：pi 增强配置的实际 provider wire/本机运行；两个产品同模型同任务的能力差异；
紧凑教学候选的模型行为等价；其他操作系统与所有第三方 pi 扩展。
