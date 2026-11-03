# KodaX 通用主动视觉能力：实施交接

> 2026-10-29 续接入口：P0–P2 已完成声明范围内的工程实现，`30310e00` 关闭 PNG IHDR 漏检，44 项视觉回归经独立复验通过。后续请读 [P3–P7 实施要求与验收重点](designs/visual-harness-p3-p7-requirements-2026-10-29.md) 和 [实施记录](designs/visual-harness-implementation-2026-10-28.md)。下文状态、hash 与“从 P0 开始”是本交接创建时的历史记录，不应据此重做已完成切片。

交接日期：2026-10-28，Asia/Shanghai。状态：研究、方案复核与分片计划已完成，视觉生产代码尚未实施。

本文件是恢复索引，不替代设计或正式 feature 状态。用户将自行把交接交给负责 worktree 的线程；本会话没有向其他线程发送消息，也没有创建新线程、切换分支、提交、推送或发布。

## 1. 原始意图与本次交接范围

本会话最初的问题原文：

> 我们最近版本中是不是做了视觉检查能力的改动？

用户随后给出 VISTA 论文并明确希望：

> 比如它里面的图像记忆、主动去看（也就是看像素、看局部等），我觉得这些才是真正意义上极度有价值的部分。

与本次实施位置、范围直接相关的原文：

> 我们能不能把这个方案融合到kodax的首轮优化后？放在KodaX-next-dev 这个worktree上来处理？

> 请你派子Agent一起调研讨论一下，看看这个方案是否完备了，然后也列出实施计划

当前交接请求原文：

> 请你准备完备的handoff文档，我让负责worktree的线程开始实施

意图解释：提升通用 Agent 在 harness 层获取、回看、选择和核实视觉证据的能力，服务静态图片与动态环境；不是只做网页审查，也不是先为 ARC 定制求解器。保持 KodaX 极简、包独立和现有首轮优化收益。HyperFrames 暂作可选后端；ARC、游戏、完整 computer use 不属于主体第一阶段前置。

本次只准备交接。接收线程收到用户的实施指令后，从下述既有设计推进，不需要重新启动一轮完整 VISTA 调研。此文件不扩大到远程发布、全量付费评测或其他线程操作的授权。

## 2. 工作树、基线与必须保留的现场

| 项目 | 交接时实测状态 |
| --- | --- |
| 实施目录 | `C:/Works/GitProj/KodaX-AI/KodaX-next-dev` |
| 当前分支 | `KodaX-next-dev` |
| 当前 HEAD | `1826cc228f299995fe5b22e608c7fbd90c3dc9ee` |
| 主方案源码审读基线 | `2682557e3c3b8d5c8a8dbaf5837b55a220513b82` |
| 两者差异 | `ec442c75` 的工作模式回归 fixture 修订及 `1826cc22` 合并；8 个测试/指南文件变化，无生产源码变化 |
| 写本交接前的工作树 | 仅 `docs/designs/visual-harness-after-first-turn.md` 有未暂存修改 |
| 新视觉 feature 登记 | 本会话未登记，未分配 ID/版本，未改 ADR 或正式 feature 状态 |
| `docs/features` | 独立 Git submodule；交接检查未报告其脏状态，后续编辑应单独核对其分支/状态 |

**必须保留未提交的主设计修改。** 其中包含两轮源码复核和三位子 Agent 讨论后的补充，不能用 HEAD 中较旧版本覆盖。交接快照的主设计 SHA-256：`9b576bac2c9562b98b4415b33f362f63e03652cfb747fa20ce0833114c7d14fd`。它只用于识别交接版本，后续合理修订不要求保持 hash。

本聊天默认目录可能仍显示 `C:/Works/GitProj/KodaX-AI/KodaX`；所有实现命令应显式使用 next-dev，不能只在单个 shell 中 cd 后假定其他工具已跟随。主工作树的 `docs/VISUAL_HARNESS_PROPOSAL.md` 是历史迁移快照，不再作为编辑入口。

已有 [docs/HANDOFF.md](HANDOFF.md) 是另一个 v0.7.97 历史任务的交接，含旧工作目录和停止指令。它不代表本次视觉任务状态，本次没有覆盖它。本文按项目文档规范放在 docs/，不采用技能默认的根目录或 `.agent/handoff/`。

首轮优化已被用户接受并收口，依据 [accepted phase baseline](designs/agent-under-10k-next-plan.md)。不要重开旧候选或等待旧优化分支完成；P0 应冻结接手时真实 HEAD 和当前 fixtures，不能沿用旧成本数字。

## 3. 必读顺序与事实源

1. [AGENTS.md](../AGENTS.md)：最小实现、独立包、无循环依赖、TDD、覆盖率、文档规范。
2. [主设计](designs/visual-harness-after-first-turn.md)：先读开头的适配修订，再读 §12.1–12.3 的收口决定和 **P0–P7** 计划，然后按所做切片读相关合同。
3. [首轮已接受基线](designs/agent-under-10k-next-plan.md)、[工作面分配](designs/tool-mode-allocation.md)、[共享合同验证](designs/managed-tool-contract-validation.md)、[统一计数](designs/first-turn-uniform-costs.md)。这些是现有默认的依据，不是重新比较旧架构的任务单。
4. [FEATURE_LIST.md](FEATURE_LIST.md) 与 [features 目录](features/)：按接收线程当前授权/开发流程对接正式 feature/spec；不要把既有 Artifact/visual-review 功能的完成状态当成本次能力已完成，也不要凭本交接猜一个 feature ID 或版本。
5. 在设计或执行任何 benchmark/eval 前读 [EVAL_GUIDELINES.md](../benchmark/EVAL_GUIDELINES.md)。

主设计已经直接保存必要合同、限制和验收，不依赖 ignored 调研笔记才能实施。三位 reviewer 的原始说明仅供需要追溯时参考：

- [能力覆盖与必要性](research/visual-completeness-capabilities-2026-10-28.md)
- [生命周期与 owner](research/visual-completeness-lifecycle-2026-10-28.md)
- [性能与验证](research/visual-completeness-performance-2026-10-28.md)

这些笔记本地存在但被 Git 忽略。不要 `git add -f`；换机器缺少它们也不影响依据主设计实施。笔记内早期 V/S 切片编号是讨论过程，最终编号以主设计 §12 的 P0–P7 为准。

研究结论：通用机制覆盖已足够进入分片实现，没有发现必须再加的框架层；这不是准确率提升、全部 provider 兼容或运行性能的实测结论。

## 4. 已确定接口、职责和实现接缝索引

不在交接内另建第二份 schema/spec。以下只标示合同入口和代码落点；参数、返回语义、边界条件以主设计为准。

| 接口/职责 | 必须读取的合同与现有接缝 |
| --- | --- |
| `visual_history`、`visual_inspect`、`visual_read_pixels` | 主设计 §6；名称/参数是拟实现合同，当前没有这些已发布 API。工具工厂放 agent 的可选 media 能力，存储与容量由 owner 注入 |
| 观察事件与原件身份 | 主设计 §5.1：事件身份与内容 hash 分开；源事件和检查派生分开；不透明 ID 受 owner/lineage 约束 |
| 初始图片与输入重试 | 主设计 §5.2；[Runtime canonicalInputId 检查](../src/sdk-runtime.ts#L12329)、[Runtime storage 注入](../src/sdk-runtime.ts#L14829) |
| 原件固定、provisional/durable 与恢复 | 主设计 §5.2、§9；[required snapshot](../packages/coding/src/agent-runtime/middleware/session-snapshot.ts#L342)、[managed commit](../packages/coding/src/task-engine/runner-driven.ts#L2568)、[Runner 结果提交顺序](../packages/agent/src/primitives/runner.ts#L1452) |
| 新 tool image 接纳 | 主设计 §5.3；[read 持有 bytes](../packages/coding/src/tools/read.ts#L370)、[图片准备](../packages/llm/src/providers/image-serialization.ts)、[MCP runtime](../packages/agent/src/capabilities/mcp/runtime.ts) |
| Script 叶和外层回图 | 主设计 §5.3、§11.1；[Script model](../packages/coding/src/agent-runtime/script/model.ts)、[叶回执提交](../packages/coding/src/agent-runtime/script/run.ts#L85)、[明确叶白名单](../packages/coding/src/agent-runtime/script/pilot.ts)。原件应先于 leaf call.settled 固定 |
| 生成前预留与最终容量接纳 | 主设计 §6.3；[共用容量 options](../packages/coding/src/task-engine/runner-driven.ts#L2172)、[batch transform](../packages/coding/src/task-engine/runner-tool-result-batch.ts)、[最终结果策略](../packages/coding/src/tools/tool-result-policy.ts) |
| 三工作面/工具合同 | 主设计 §4、§11；[managed projection](../packages/coding/src/tools/managed-tool-contract.ts)、[最终请求装配](../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts)、[checked bridge](../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts) |
| 裁剪/像素与媒体生命周期 | 主设计 §5.2、§6.1–6.3；[现有媒体入口](../packages/agent/src/media/index.ts)、[现有粘贴变换](../packages/agent/src/media/image-normalize.ts)、[Session 删除](../packages/repl/src/interactive/storage.ts#L6304) |
| 动态环境 | 主设计 §8；[Runner serial 声明](../packages/agent/src/primitives/runner-tool-loop.ts)、[Host invocation](../src/client-host-authorization.ts)、[reverse bridge](../src/runtime-daemon/reverse-bridge.ts)。通用检查工具不承担具体环境动作 |
| Artifact 当前验证与历史回看 | 主设计 §10；[Artifact SDK](ARTIFACT_SDK.md)、[readEvidence](../packages/artifacts/src/evidence-files.ts) |

架构与支持范围的完整决定见主设计 §4、§11、§14；特别区分 `packages/agent` 与产品 `workMode=agent`。P1 的 Runtime 持久保证不能自动推广到 standalone SDK、child 或 fork。

## 5. 避坑墓碑

以下是恢复工作时容易误用的历史结论；均不是待重新尝试的优化候选。

- **旧成本数字已退役。** 773–795、54、800/1000 等来自旧草案/估算，不是当前完整请求成本或统一发布门槛。参见主设计 §11.4；当前 HEAD 没有新视觉工具的 B/V 实测。
- **图片路径与 checkpoint digest 不等于原件保留。** prepared-image 缓存只解决对应运行范围的传输复用，不能代替持久 bytes；task report/UI 也不是观察目录。参见 §5、§9。
- **不能把 toolCallId 当唯一事件身份。** provider ID 可重复；同 inputId 重试、Script 叶和外层重交付也有各自幂等边界。参见 §5 和 §13.1。
- **不能把所有回图再归档一遍。** inspect 派生回显不得增加源事件或刷新 current；包装也不能把所有 bridge 图片一律忽略。参见 §5.3。
- **不能只在最终 batch transform 后限流。** 最小共享输出预留随 P1 交付；最终 capacityDebt/已执行事实仍由原 owner 管。参见 §6.3。
- **PNG fixture 不是上传格式退回 PNG-only。** 全图回取可以先用固定 bytes；派生测量再冻结 decoder/profile。粘贴归一化会转码，不能直接当无损采样。参见 §6.1–6.2。
- **三模式支持不等于所有协议/宿主组合已支持。** Script 首版不自动增加视觉叶；离线真实 serializer 测试不证明远端收到或模型用对图片。参见 §11.1–11.2。
- **互斥不等于现实环境新鲜。** serial predicate 不是跨 Run 环境锁；动作执行后采图失败不能当未执行重放。参见 §8。
- **VISTA 消融不能直接转成 KodaX 提升百分比。** 部分实验同时改变默认输入帧数；GameWorld 的暂停语义不能外推持续运行桌面。具体出处见主设计 §2。
- **临时研究副本可能已清理。** 本轮复核时旧 VISTA 临时源码目录仅剩占位，PDF 已不存在；需要追溯时使用主设计 §15 的固定 GitHub revision 与论文 v1，不把旧本地路径当必需输入。

## 6. 接收线程的下一步

1. 收到用户开始实施的指令后，在 next-dev 检查 HEAD、工作树和 `docs/features` submodule 状态。保留主设计未提交修改及他人新改动；不要 reset、覆盖或批量暂存无关文件。
2. 读主设计 §12.2。**从 P0 → P1 → P2 推进**，不要把 A–E 的概览表误认为另一套票，也不要把 P1 的内部贯通测试宣称完整主动视觉能力已经完成。完整后续依赖和可并行范围直接使用 §12.2，不另开相冲突的计划。
3. 按接收线程的正式开发流程连接 feature/spec 与实现记录。这里没有已分配的 feature，也没有用户逐票批准记录；不要伪造这些状态。已有明确的范围/设计无需重复访谈；只处理实施中真正改变行为或范围的决策。
4. 做 P0 时使用 **当前真实 HEAD** 和已合入的工作模式 fixture。冻结完整模型字段和支持矩阵，保留普通 root 投影资格；先离线核对，无需外部模型调用。
5. P1 先为主设计 §13.1 中对应的用户入口、重复输入、原件覆盖、保存失败、目录授权、并行输出及重启回取写 RED，再贯通实际 Runtime → tool → serializer。不要仅直接调用内存 store 的单测就宣布闭环成功。
6. P2 开工时确定真实 decoder/profile，用机械 fixture 证明方向/颜色/alpha/坐标语义；实际支持不足就按合同明确 unsupported。沿原 read/Script 接纳点固定原件，不等外层返回才读取路径。
7. 每片保留 RED/GREEN、支持范围、失败证据和成本增量。相关回归通过后推进下一片；按正式实施流程做 code-review 与集成检查。付费行为验证只处理机械测试不能回答的问题，先完成规程要求的预算、输入和停止条件。

仍需在对应片内决定的技术细节：receipt 的最小持久表示/具体媒体布局（P1）、实际 decoder 与支持 profile（P2/P3）、第一个受控动态消费者（P6）。这些是有既定约束的实施选择，不是重新建设平台或扩展 ARC/桌面项目的理由。

## 7. 已验证什么，尚未验证什么

| 证据 | 范围与限制 |
| --- | --- |
| 同日适配阶段既有回归 | 在 `2682557e` 上运行 Script model 与 managed bridge boundary 两个测试文件，36 项通过；只证明原接线可复用，不是新视觉实现验收 |
| 三位子 Agent 复核 | 能力、生命周期、性能三个方向独立读源并交叉讨论；架构/性能 reviewer 复核最终 P0–P7 未发现新的阻塞遗漏。研究笔记已落盘 |
| 主设计文档检查 | 完备性修订后 80 个本地链接存在、fence 配对、`git diff --check` 通过；本交接新增后另行检查文档 |
| 新 HEAD 差异检查 | `2682557e..1826cc22` 仅测试/指南变化；未据此宣称这些新测试已由本会话运行 |
| 未做 | 新视觉代码、端到端图片归档恢复、模型主动取证实验、当前视觉 token 增量、速度/质量收益、全 provider/宿主验收 |

需要复现上一轮既有回归时，从 next-dev 使用以下命令；它不是 P0/P1 的替代验收，不必仅为了读交接而重复运行：

```powershell
node node_modules/vitest/vitest.mjs run packages/coding/src/agent-runtime/script/model.test.ts packages/coding/src/task-engine/_internal/managed-task/agent-chain.bridge-boundary.test.ts --reporter=dot
```

模型/eval raw 按规程放 OS 临时目录；必要的采用结论、契约和验收证据进入正式设计/测试指南，不能只留聊天或 ignored research。

## 8. 文件操作日志（追加记录）

后续接手者在本节追加，不改写既有历史为“已完成实施”。只列恢复所需文件，源码阅读细目可由主设计引用追溯。

| 日期/阶段 | 操作 | 文件与状态 |
| --- | --- | --- |
| 2026-10-18 至迁入阶段 | 研究与迁移 | 主工作树 `docs/VISUAL_HARNESS_PROPOSAL.md` 后标记为历史快照；next-dev 主方案成为后续入口。本交接没有改旧快照 |
| 2026-10-28 适配与完备性复核 | 读/改 | [主设计](designs/visual-harness-after-first-turn.md)；保留两轮未提交修订，未改生产源码 |
| 2026-10-28 适配复核 | 建 | `docs/research/visual-proposal-{tool,media,budget}-delta-2026-10-28.md`，三个本地 ignored 笔记；仅追溯用途 |
| 2026-10-28 完备性讨论 | 建 | 本文 §3 链接的三个 `visual-completeness-*` 笔记；全部 ignored |
| 2026-10-28 两轮复核 | 读 | 本文 §4 所列 Runtime/Runner/media/read/Script/容量/Host/Artifact 源码；AGENTS、EVAL_GUIDELINES、首轮设计、主设计。按章节定位，无需重扫全仓 |
| 2026-10-28 交接准备 | 读 | 现有 [HANDOFF.md](HANDOFF.md)、[FEATURE_LIST.md](FEATURE_LIST.md)、`.gitmodules`；确认旧交接不同任务、feature 未登记及 features submodule |
| 2026-10-28 交接准备 | 核对外部已有提交 | `ec442c75`、`1826cc22` 已包含其他线程的测试/指南修订；本会话未改写、撤销或重新提交它们 |
| 2026-10-28 交接准备 | 建 | 本文件 `docs/HANDOFF_VISUAL_HARNESS_2026-10-28.md`；未提交、不覆盖旧 HANDOFF |
| 2026-10-29 后续要求整理 | 建/追加状态 | 新增 [P3–P7 续接要求](designs/visual-harness-p3-p7-requirements-2026-10-29.md)，在主设计与本交接开头追加最新状态；保留旧研究/实施历史。仅文档修改，未实施后续代码或执行模型评测 |

## 9. 建议技能与执行规范

技能路径以接收线程当前技能目录为准；以下是建议，不是自动调用全部技能的指令。

- `feature-manager`：开始正式功能开发时对接现有 tracker、设计块、ID/版本，防止把推荐方案冒称已实施功能。
- `to-spec` / `to-tickets`：需要将现有设计纳入正式 spec/票据时使用；复用主设计合同和 P0–P7，避免复制出第二份漂移的设计。属于人驱动入口，按用户实际调用和当前授权处理。
- `implement`：接收线程按用户实施指令逐片构建时使用；消费既有 spec/票据与接缝，配合 `tdd` 和 `code-review`。
- `tdd`：仓库要求先 RED 后 GREEN，特别覆盖真实输入、恢复和并发反例。
- `code-review`：切片/集成完成后从 Standards 与 Spec 两轴检查，先解决实质缺陷再宣称完成。
- `research`：仅在 codec、provider 或动态来源出现不能由现有依据回答的事实缺口时追加一手调研；不重跑整个 VISTA 研究。
- `diagnosing-bugs`：发生难定位的恢复、性能或跨模式回归时使用，保留最小复现。

包层次与最小性遵循 AGENTS；不添加假想配置、不使用 `any`、不提交 `console.log`、不静默吞错。GitHub HTTPS 若确有需要，按用户约定使用现有 `GITHUB_TOKEN` 非交互认证，不读取/输出其值，不先尝试其他登录方式。

接手成功的标志：明确当前工作树和未提交设计已保留，能从 P0/P1 开始写真实入口的验收与最小实现；不需要重新询问整个目标，也不把研究结论当作已经交付的智能提升。
