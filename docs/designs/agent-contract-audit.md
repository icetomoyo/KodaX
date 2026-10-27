# Agent 契约整体审计与后续边界

日期：2026-10-26。源码基线：KodaX `a349eabb9892f9d62299e95d05b3c5b7f9dd2a98`。
本记录区分已采用、当前工作区改动与待验证建议，不将研究候选写成默认行为。

范围澄清：本轮主要审计可直接证明的机械去重。其“未找到显著安全删除项”不表示现有教学架构最优，
也不证明当前篇幅是能力下限。后续针对 Pi/DSH/Codex 的整体设计重评见
[完整契约重组提案](agent-contract-redesign.md)，其中区分保留 AMA 行为与保留原有文字。

## 1. 当前交付与成本

Agent / Coding / Script 三模式已实现；Coding 默认，AMA、SDK、专用角色和底层能力保留。
普通 managed root 的 32 项工具文字投影已提交；整段 Worker 重写没有采用。
四项协作/Todo 教学去重实验已撤回，不能计入当前收益。

完整 Windows Host、OpenAI 序列化模型字段的冻结抓包估算：

| 模式 | 前一完整 Host 基线 | 当前默认 | 已确认减少 |
| --- | ---: | ---: | ---: |
| Agent | 16,498 | 14,403 | 2,095（12.7%） |
| Coding | 20,129 | 18,035 | 2,094（10.4%） |
| Script | 22,100 | 22,100 | 本批首轮无变化 |

这些是同方法启发式估算，不是 provider tokenizer 或界面上下文百分比；也不是项目最初版本至今的总降幅。
原始冻结抓包标识为 `kodax-first-turn-wire-PXqoPq`，前序为 `fGXqAA`，存于 OS 临时目录。
可长期引用的验收与限制见[已交付工具契约](managed-tool-contract-validation.md)及[撤回的教学实验](worker-teaching-dedup-validation.md)。

Agent 14,403 中，工具约 6,967，system 约 6,326，其余模型输入约 1,110。
工具中协作约 1,753、Todo 984、交互 924、文件/搜索/命令 1,307、其余约 1,999。
这些分项是成本定位，不能直接解释为冗余。诊断性地删除所有工具说明、注释和 title 后，工具仍约 2,480，
合计约 9,916；该输入不可作为可用候选。仅靠继续删工具文字达到 10K，几乎需要去掉全部工具教学。

独立源码诊断中的 Worker 稳定教学约 4,618 token、当前 Memory 规则约 696，解释了 system 的主要来源。
这两个数来自诊断构造，不与上述抓包逐项直接相加；也不表示每句话都是最优表达。
已有 stable/context 分离、能力条件装配、Skill 目录/全文分离和 changed-only delta，不能再次算作待实现收益。

## 2. Pi、Codex、DSH 的实际可借鉴部分

本次延续本地源码审计，未拉取远端：Pi `136b87e8a7f5a3e5186de0289523ba327dc592fc`，
Codex `970111f6cb62cc02fe36a82ea7d71b37a2889c97`，DSH `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。

| 参考 | 真实差别 | KodaX 的取舍 |
| --- | --- | --- |
| Pi | 默认 read/bash/edit/write；system 根据实际工具加入短指导并去重。示例 Todo 和子进程 subagent 协议较轻 | 学习单一规则来源、模型输出与 UI 细节分离；不把同步子任务示例等同于 Actor 邮箱、共享预算和增量计划 |
| Codex | 模型配置可选择 code_mode_only；完整签名也会作为额外工具上下文发送。update_plan 比 KodaX Todo 的 hook/恢复协议简单 | 保留完整调用契约并复用执行链；不能用工具数组为空或后续增量包小来证明完整首轮低 |
| DSH | Standard 与 Minimal 的能力/上下文装配不同；PTC 是执行方式，完整工具参数仍有成本 | 继续按工作面装配；不以去掉协作、计划、Goal 等能力后的 Minimal 成本作为等能力目标 |

源码定位：Pi `packages/coding-agent/src/core/system-prompt.ts`、Todo/subagent 示例；
Codex `codex-rs/core/src/tools/mod.rs` 和模型目录；DSH 的 Standard/Minimal/PTC prompt 与工具装配。
历史数值来自不同源码版本或源码投影：Pi 默认约 1,414、扩展示例约 2,122–2,347；
当前 DSH 源码投影 Standard 约 9,499、PTC 约 11,326、Minimal 约 463–477。
这些不是当前 KodaX 的同能力配对抓包，不能直接计算“智能不变还能省多少”。旧 Codex 抓包也不代表上述新版本默认。

结论不是“Pi 的能力不够”，而是其较少的契约不能证明 KodaX 现有协议可无损删除。
本轮源码审计没有测量三者智能强弱，不以工具数量推断质量。

## 3. 整套规则与状态的归属

| 内容 | 当前拥有者与消费者 | 审计结论 |
| --- | --- | --- |
| 规划、必要委派、证据整合、完成判断 | Worker 模型策略；Runtime 提供工具和状态 | 仍是语义决策。保留触发条件、时序、恢复和例外，不用自动完成 Todo 替代 |
| Actor 身份、所有权、准入、预算、取消与终态 | Actor Runtime；spawn / mailbox / wait 回执 | 已由程序维护，不是尚待实现的省 token 新机制 |
| Todo ID、增量存储、hook、no-op | Todo store 与工具执行链 | 有真实历史恢复收益；不能退回整表覆盖或将 hook 变成 UI 装饰 |
| 用户问题与选择意义 | 模型提出，宿主处理回答/取消/格式 | 批量与多选有实际语义；删参数可能反而增加问答次数 |
| 初始 routing 分类 | 初始启发式；动态 context 注入一次 | 不是重复 system。保留风险/assurance/review fan-out；`new` 是修改意图，不是强制重新规划 |
| 当前用户指令、既有计划 | 用户历史与 Worker 恢复规则 | 已有新用户指令优先与复用计划；未证明 routing 导致生产恢复缺陷 |
| 验证证据列表 | `verification.requiredEvidence` | 当前发现两次同源装配，可保留完整 verification、删除空壳 preview contract |
| Actor 当前容量 | Runtime snapshot / changed-only delta | 已存在；每次变化重发五条教学可进一步检查，但不是首轮大收益 |
| Memory / Skill / 项目规则 | 稳定能力段及显式选中 Skill | 不等于冗余；selectedSkillText 的预算分类不代表再次注入。Memory 旧注释的约 3.1K 节省已过时 |

主要代码：`agents/worker-role-prompt.ts`、`task-engine/_internal/managed-task/{role-prompt,role-prompts,formatting}.ts`、
`task-engine/runner-driven.ts`、`task-engine/todo-store.ts`、`task-engine/todo-drift-reminder.ts`、
`tools/{agent-collaboration,todo-create,todo-update,ask-user-question}.ts`、`agent-runtime/actor-runtime.ts`。
语义 routing 的保留决定见 [ADR-043](../ADR.md)；历史 eval 的 prompt 装配与当前不同，不能断言每项永远不可删，
也不能将旧检查点夹具的冲突当成当前生产缺陷。

## 4. 本轮最小实施

只移除 `createRolePrompt` 临时构造的 preview task contract。它没有自己的 summary、successCriteria、constraints，
唯一可见内容是从 verification 原样复制的 requiredEvidence；完整 `Verification contract` 保留。

- 不改 `formatTaskContract`、SDK contract 数据、验证器、工具执行、权限、预算或 AMA 决策。
- stable prompt 不变；没有显式 evidence 的普通首轮字节不变。
- combined/context 渲染均只发送一次同源 evidence；当前轮指令、metadata、tool policy 和其他验证字段保留。
- 不增加发现、压缩器、配置项、模型调用或运行时状态。
- 收益随显式证据长度变化；普通 14,403 基线收益为零，不包装成首轮突破。

上一批 [Script 同响应结果去重](script-result-projection.md) 同样保留：完整叶工具回执与动态参数仍在，
只引用同一响应中完全相等的返回值，并计算说明开销。它改善命中任务的全任务输入，首轮不变。

## 5. 后续顺序与停止条件

1. **完成机械去重交付。** 离线证明内容保留、无新增执行步骤；不为这点收益运行模型。
2. **有证据再处理动态重复。** 如继续容量 delta，先核实初始化、压缩、恢复都保留完整教学，
   再只压缩 changed-only 事实。先不同时去掉后续派发前的 list_agents 要求；SDK 不一定有同等新鲜的状态。
   若需新同步系统才能成立，则停止，不能为小收益引入基础设施。
3. **10K 作为新的整体候选验收目标，不是默认承诺。** 从 14,403 到 10K 还需约 4,403 token。
   大幅收益主要需要更短的完整 Worker/协议表达；目前没有已证明行为等价的候选。
   不再把逐句小改动分别送模型。先在一个候选内交付完整规则保留矩阵、生产装配净收益与兼容验证，
   再决定是否值得有限配对。任何需要隐藏全部能力、额外发现或改变 AMA 才达标的方案不默认实施。

若形成足够有价值的整体候选，验证场景至少包括：简单直接修复、陌生仓库定位、已有 Todo 续作、
中途用户纠正、只读子 Agent 拒绝后的自主恢复、并发耗尽后的复用/等待、编辑失败后合法恢复、测试失败后修复、
完整报告与 AMA 收尾。使用真实执行链的检查点，不把无关 routing 与手写计划拼成伪生产状态。
固定输入与调用预算后才做 GLM/Kimi/DeepSeek 有限配对；先分析差异，不以反复重跑获得通过。
同时报告质量、关键路径往返、根/子/辅助调用、全任务 token/费用/耗时；少做测试不能算效率提升。

当前没有新模型调用，不能声称新方案已证明智能非劣，也不能声称 10K 已完成。
采用的是可核实的机械去重；行为改写、容量教学和 routing 澄清仍是候选。

## 6. 验证记录

- 新回归先 RED：显式 requiredEvidence 出现两次；最小改动后 GREEN。
- role-prompt、managed-run-context、worker-role-prompt 三组共 75 项通过。
- `npm run typecheck` 源码与测试类型检查通过；`git diff --check` 通过。
- 本轮未运行付费模型，未刷新原生跨平台二进制，未提交或推送。

### Standards

独立评审 0 项发现。删除重复构造符合极简原则；未增加抽象、权限分支或跨层依赖。

### Spec

独立评审 0 项发现。删除部分只输出同源 requiredEvidence，完整 verification 和其他上下文保留；
无 evidence 请求和 stable 渲染不受影响。评审不代替模型行为验证。
