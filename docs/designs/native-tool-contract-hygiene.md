# Native 工具契约精简与规则保留清单

本轮仅精简重复教学和模型侧纯参数别名。保留全部 native 工具、现有 AMA 规划与派发策略、完整 spawn 契约及内部单 Agent 执行器；不引入新的注入模式、任务分类器或参数延迟策略。

## 规则保留清单

| 义务 | 保留位置与范围 | 验证方式 |
|---|---|---|
| 通用 Agent 仅使用显式 instructions 和绑定工具 | agent Runner；admission 的非可信指令包装保持 | 现有 wrapper、layer-independence 回归 |
| 简单任务直接执行；复杂任务按现有策略计划/派发 | Worker 指令不变 | 文件字节核对、Worker/能力分支回归 |
| 计划复用、增量更新、去重、owner、完成 veto、用户语言 | Worker 与现有 Todo 契约均不变 | 字节核对、Todo/恢复回归 |
| 独立工作并行、独占写集合、root 负责整合 | Worker、spawn 全文不变 | 源码字节核对、协作回归 |
| wait acknowledgement 不是 terminal；不轮询、不得遗弃子 Agent | Worker、Actor 工具与状态机不变 | Actor/managed-task 回归 |
| 项目约束、真实用户纠正、可信上下文位置 | 现有 root/child/context builders 不变 | role prompt、compaction/context 回归 |
| 文本分页和超长行精确续读 | read 说明保留 offset/limit/line_offset；参数不变 | 现有 bounded-read 与续读回归 |
| 图像原生视觉；已内联图像不重复读；PDF 走扩展 | read 保留格式、路径条件与 read_pdf 不可用时的指引 | 多模态/工具契约回归、人工逐义务对照 |
| write 用于请求的新文件/完整重写；已有文件用 edit | write 与 Worker；保留 skeleton 恢复、直接 UTF-8、shell 绕过跟踪的说明 | 编辑/编码回归、GLM/Kimi 最终编辑 E2E |
| 精确锚点、顺序编辑、失败不落盘 | edit 契约与 handler 不变 | 原子批量编辑与失败恢复回归 |
| bash 用于命令、计算输出；已知内容走 write/edit | bash 保留后台运行、完整输出/容量溢出后的可恢复 artifact | shell、结果容量及编辑 E2E |
| grep 的非对称上下文、输出模式、分页与扫描续读 | 保留 -A/-B、context、offset、scan_offset、head_limit 及所有运行时约束 | 现有 grep 行为回归 |
| 纯参数别名兼容 | 模型侧只展示 ignore_case/context/character；raw SDK/handler 继续接受 -i/-C/column | projection origin、非修改性及既有 alias 行为测试 |
| LSP 位置为 1-based；compiler-backed 导航与 repo 工具区别 | 四项 LSP 说明精简但保留选择条件、坐标与 server 要求 | LSP 导航回归、契约人工对照 |
| native 参数已可调用，详细指导按需查询 | tool_search 说明明确当前表示；既有 hint/查询范围不扩大 | search/describe/native 的同源投影回归 |
| Goal 必须有授权；完成需证据；blocked 同类障碍连续三轮 | create/update_goal 顶层说明与 handler 保持；status 字段只去重复 | Goal 回归 |
| 权限、只读 child、取消、串行副作用、执行事实与预算 | handlers、调度、permission、bridge 不变 | 既有真实 Runtime E2E |
| Memory、skills、MCP 的 authority 与能力边界 | 相关说明、绑定、目录和执行链不变 | 能力与恢复回归 |
| 如实区分已执行、失败与未验证 | Worker 终止/验证义务不变 | 固定历史配对；真实测试输出与最终报告复核 |

每个独立工具的必要用途与调用前提仍在自身契约中，不依赖一定存在 root Worker。仅隐藏 builtin 的纯参数别名，不改同名 extension/constructed 的参数。grep 的 -A/-B 不能由对称 context 等价覆盖，因此保留；不合并问答的 flat/batch，也不减少 repo/LSP 能力。

## 实施与验证边界

先冻结 baseline 输入与规则/handler 源码哈希，再做 projection 的 RED→GREEN。精简范围为 read/write/bash、四项 LSP、grep 字段说明、update_goal.status、tool_search。暂不改 cyclic_dependencies、Worker、spawn、Todo/Memory 或已有 deferred hints，避免混合行为变量。

零网络验证包括实际 SDK 首轮抓包、现有工具/权限/恢复测试及完整 native 表面的真实 Runtime 脚本化编辑闭环。完成后用已有 GLM-5.3 与 Kimi for Coding：最多8次盲化配对 next-response 探针，再最多8次最终候选编辑 smoke；每条 smoke 为读取→一次双替换 edit→真实 Node 测试→根据结果报告。全量模型工具表保持，工具执行限制到夹具和指定命令，0 child，禁止自动 retry/fallback。

新实验物理调用上限16、tokens上限500,000、冻结费率参考成本上限$0.05；每调用最多2,048输出tokens/120秒，单模型smoke最多300秒。沿用历史累计登记，raw/账本/盲审存OS Temp。离线检查不能回答模型选择/参数质量，所以仅这些问题进入付费probe。E2E验证最终接线，不作为A/B质量证明；本轮不据小样本声称全局智能非劣。规则或能力确定性回退须修复；语义回退由主会话读取配对raw归因，不使用aggregate pass rate替代判断。

专项参数按需披露不在本轮实现。待上述证据明确后，再独立评估是否值得减少常驻参数；首轮变小但全任务更贵或专业能力选择变弱的方案不进入默认。

## 结果登记

同一Windows夹具、实际Runtime/Host/ClientPlane与SDK序列化边界，完整请求测量如下；全部计数是统一启发式估算，不是API usage或界面上下文。

| AMA协议 | 优化前 bytes / 估算tokens | 最终 bytes / 估算tokens |
|---|---:|---:|
| OpenAI | 88,518 / 22,204 | 83,419 / 20,926 |
| Anthropic | 86,939 / 21,809 | 81,840 / 20,531 |

每请求减少5,099 bytes、约1,278估算tokens，OpenAI约5.8%。16个抓包场景的native名单相同；常规AMA Runtime/Host仍58工具。剔除描述并仅归一化已登记的纯别名后，schema完全一致；仅归一化夹具路径、session id与快照时间后，其他请求字段完全一致。Worker、runner、child executor和既有deferred hints源文件哈希保持。

验证记录：projection测试先出现5项预期失败，再14项通过；最终工具/真实Runtime编辑定向104项通过，两指定模块行覆盖95.87%、分支94%，不冒称全仓覆盖。最终read与SDK抓包23项通过；类型检查和完整构建通过。仓库没有lint脚本，执行`git diff --check`。

全量运行记录16,700通过、2失败、89跳过、19 todo，不能写成全绿：read说明的续读marker断言已在最终文案恢复并通过整个read文件重验；后台审阅测试`agent.extension-runtime.test.ts:630`的completedReviews预期1/实际2，在原基线d60c1c91三个产品文件的只读源码覆盖重放中相同复现，本轮不修改该链路或放宽其断言。

按用户指定的真实路由`zai-coding/glm-5.3`和`kimi-code/kimi-for-coding`完成8次配对probe及8次最终候选编辑smoke，共16次物理请求、279,633已知usage tokens，无retry、fallback、child或未知usage，达到预定调用上限即停止。按冻结coding-plan参考费率登记$0.00795726，不代表实际增量账单。历史29次调用、546,881保守tokens、$0.02024321及1次未知usage继续保留；累计45次、826,514保守tokens、$0.02820047，累计值不能冒称全部为已测usage。

主会话先盲审4组配对，再揭盲：两模型两臂均提出一次正确的双替换edit，并如实报告给定的失败测试、未擅自重跑或宣称验证成功。Kimi候选对“缺少此前修改证据”的说明比基线少，属于轻微措辞差异、归因不确定；GLM候选把单次结果称为可复现，基线也推断了未读取的实现。保留这些差异，不将结果概括成完全等价，不为追逐措辞差异扩大调用。

在固定历史的batch_edit配对中，API input usage为Kimi基线17,452→候选16,263（减少1,189），GLM基线18,811→候选17,588（减少1,223）；另一case的输入差值相同。这支持契约输入减少，不代表空会话界面数值、完整任务成本或速度改善。

最终两条真实Runtime编辑链均4轮完成：read→单次双替换edit→真实`node --test sum.test.js`→报告；文件精确一致、注释和格式保留，Node实际退出0、pass 1/fail 0，主会话读取原始响应与工具结果确认报告属实。Kimi耗66,678 tokens，GLM耗71,357 tokens。这是限定轮次的接线smoke，不作为自主任务能力或A/B优劣证明。

受控probe使用完整57项Runtime表面，Runtime/Host场景另有58项；两者按实际绑定保留，未隐藏工具。fixture的原options.initialMessages由Runtime接管，因此probe显式加入冻结的read/失败测试历史，不假称它们由真实工具执行生成。raw响应、工具调用/结果、夹具、输入哈希及盲审在OS Temp保存并核对三份副本；真实smoke未单独保留每轮完整输入，不声称可逐字重放动态session上下文。实验标识为`native-contract-hygiene-75e428aa8a414f41944f4b4a4ee5cde1`。

本轮结论为`recommend-ship`，仅适用于这次保留全部native的契约精简：确定性边界保持、首轮负担下降，受控任务未发现可确认的实质退化。仅4组配对、每cell单样本，不能证明全局智能非劣；LSP选用、复杂review及AMA派发质量不在这些模型样本的覆盖内。专项参数按需披露仍未实施，需要独立验证后再决定。

## Standards

独立规范轴未发现可行动问题。builtin-only浅投影保留raw和同名扩展；未新增依赖、公开配置、领域抽象或执行链。

## Spec

独立需求轴未发现可行动问题。规则清单、全部native保留与既有AMA策略符合范围；最终模型结果支持窄范围实施，不作全局智能非劣结论。规范轴0项、需求轴0项，各轴均无严重项。
