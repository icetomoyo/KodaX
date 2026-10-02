# 当前 worktree 的统一产品契约设计落在哪个版本？

结论摘要：当前分支的统一契约设计是 **v0.7.97 / FEATURE_298**，正式规格在 `docs/features/v0.7.97.md`；实际产品接口及 9 月 26–27 日修补落在当前代码与 `docs/CLIENT_CONTRACT.md`、`docs/SDK_MIGRATION.md`。包版本仍继承主线 **0.7.96-rc.11**，不是 v0.7.97 已发布，也不是 v1.0.0。主线最新源码包版本为 rc.14，主线仍把 FEATURE_298 当作未实施规格，合并不能据此覆盖本分支的实施状态。[来源：`docs/features/v0.7.97.md:164–170`；`docs/DD.md:3–9`；`docs/SDK_MIGRATION.md:3`；`package.json:3`；主线 `cad8b658` 的 `package.json:3`、`docs/FEATURE_LIST.md:18`。]

调研日期：2026-10-02（Asia/Shanghai）。只读核对仓库文档、公开契约源码和 Git 提交；本次未重新运行测试，既有验收数字只作为当时记录，不构成本次验收。源码固定点：`codex/product-client-refactor` 的 `a63feede5f4b2bac8a62ddfa687d9b515d8c2021`；主线读取固定点：`origin/KodaX` 的 `cad8b658797976ce22a4bd70c60d2251d537e542`。文件行号对应这些快照。

## 1. 三种版本各自表示什么

| 层次 | 当前分支落点 | 可核对来源 |
| --- | --- | --- |
| 根包与四 workspace 的源码版本 | `0.7.96-rc.11` | `package.json:3`；`packages/{llm,agent,coding,repl}/package.json:3` |
| 重构设计规划版本 | `v0.7.97`，FEATURE_298，设计基线 beta.1、日期 2026-09-05 | `docs/features/v0.7.97.md:1–9,164–170` |
| 本分支实际实现 | FEATURE_298/299 的开发树；核心与后续消费者/输出修补已实施，人工及跨平台发布验收仍开放 | `docs/DD.md:3–9`；`docs/FEATURE_LIST.md:17–18,519`；`docs/features/v0.7.97.md:909,957–961,985–988,1074` |
| 整体产品契约兼容版本 | `productClient` v1；不是包 semver 或规划版本 | `docs/CLIENT_CONTRACT.md:20`；`src/sdk-client.ts:26–43` |
| 主线最新源码包版本 | `0.7.96-rc.14`，但 FEATURE_298 仍标记为规格/拆票、未实施 | `cad8b658:package.json:3`；`cad8b658:docs/FEATURE_LIST.md:14–18` |

- **不能从“同为 0.7.96”推断两边接口/构建相同。** 当前开发树已新增产品 Client 并移除一些旧产品恢复机制；启动器另以实际构建 origin/fingerprint 核对同版本加载内容。[来源：`docs/SDK_MIGRATION.md:99,105–107`；`docs/features/v0.7.97.md:219`。]
- **不能从仓库 tracker 的 package 行推断实际 npm 发布。** 本分支迁移指南明确不表示 npm 已发布；主线 tracker 的“Current package version”仍写 rc.10，而同快照源 `package.json` 是 rc.14。这是文档/源码指标差异，本次未查询 npm。[来源：`docs/SDK_MIGRATION.md:3`；`cad8b658:docs/FEATURE_LIST.md:15`；`cad8b658:package.json:3`。]

## 2. 设计与实现文档的准确位置

| 用途 | 文件及入口 | 权威范围 |
| --- | --- | --- |
| 用户接受的重构规格、取舍与实施票 | `docs/features/v0.7.97.md`；A0 通俗解释、A2 D01–D08、§3 技术方案、§5 正式实施票 | FEATURE_298 的设计范围；§5 自称实施状态唯一来源（:512） |
| 产品公开接口说明 | `docs/CLIENT_CONTRACT.md` | 面向 CLI/SDK/未来 Web；实际 TypeScript、SDK 入口和适配器为类型/行为依据（:3–7） |
| 从旧 SDK/文件/Runtime 接入迁移 | `docs/SDK_MIGRATION.md` | 当前 FEATURE_298/299 开发树；包 rc.11、目标 v0.7.97（:3） |
| 高层/详细设计当前状态 | `docs/HLD.md:3–6`；`docs/DD.md:3–9` | 清楚区分开发树、目标版本及发布声明 |
| roadmap 进度摘要 | `docs/FEATURE_LIST.md:17–18,519` | 本分支 FEATURE_298 实施摘要；不能替代真实票及验收 |
| 近期修补验收 | `docs/research/unified-contract-fix-verification-2026-09-26.md`；`docs/research/contract-browse-fix-verification-2026-09-26.md` | canonical 来源、交互、订阅、ACP 设置、历史读取及普通浏览的具体修补与有限验证（分别 :5–22、:6–23） |

`docs/features` 是独立 Git 子模块，来源为 `https://github.com/icetomoyo/KodaX-Feature-Design.git`，不能把普通 `docs/` 文件和它视为同一提交历史。[来源：`.gitmodules:1–3`。]

| 历史身份 | 固定提交 | 意义/来源 |
| --- | --- | --- |
| 本分支 `docs/features` gitlink | `fd73eb81d274cc7dc47bc5d2c1c79928c11c4eaf` | 根 `a63feede` 的树记录；子模块该提交为 2026-09-24 合入 rc.9–rc.11 发布与 Git 执行设计 |
| 主线 `docs/features` gitlink | `664d8ba0365776b15764e33da8e47a65ee2366ae` | 根 `cad8b658` 的树记录；子模块该提交为 rc.14 文档发布 |
| 本分支 v0.7.97 规格最近编辑 | `2b720da798038b5ede50cedbbc36e5d34c2a3d90` | 子模块 2026-09-20 提交：specify output ownership and verified handoff；`git log fd73eb81 -- v0.7.97.md` |
| 主线 v0.7.97 规格最近编辑 | `dc0540c7263fe8e3d4b836aff208b4171e2394e0` | 子模块 2026-09-07 提交：add FEATURE_298 specification and index entry；`664d8ba0:v0.7.97.md:3–8` 仍写 Planned/implementation has not started |
| 最新整合接口/迁移文档 | 根 `eecbbf9b11e4315d860680f1da62b4f56d88f101` | 2026-09-27 `docs(sdk): document unified product client migration`；不在子模块里 |

### 2.1 v1.0.0 与 ADR 编号

- 本次设计的 Feature 编号明确是 **298**，正式票由用户确认目标为 **0.7.97**；它没有落在 v1.0.0。[来源：`docs/features/v0.7.97.md:4,167,510`。]
- 仓库所提的历史 v1.0.0 staging 文档已删除，关联的是 **FEATURE_030 Multi-Surface Delivery**。该项当前落在 `docs/features/v0.9.5.md`：头部说明先 v0.8.0→v0.8.5，再 v0.8.5→v0.9.5；不能拿正文历史“移到 v0.8.0”覆盖现标题/当前 tracker，更不能把它当 FEATURE_298 的版本。[来源：`docs/features/v0.9.5.md:1–10,33,3020`；`docs/FEATURE_LIST.md:1858,1998`。]
- FEATURE_298 没有另列一条专属新 ADR 编号；它明确把本版范围/取舍集中在 v0.7.97 本文，并按明确替代范围处理旧 ADR 冲突。ADR-054 是旧 shared-runtime 底座决策，含 durable operations/event replay 等历史承诺；不能合并时据这些历史条款恢复已退役机制。FEATURE_299 的已发布 Stop/extension/execution 约束仍另有 ADR 附录。[来源：`docs/features/v0.7.97.md:170`；`docs/ADR.md:4643–4675,6397–6423`；`docs/SDK_MIGRATION.md:105–107`。]

## 3. 实施到了哪里，哪些表述不能当现状

- 核心实施计划为 T01–T37，其中 35 张核心票、2 张未选 Windows 可选支线；后者不阻塞核心完成。[来源：`docs/features/v0.7.97.md:510`。]
- 消费者归口 T38–T42 已 Done，含会话发现、加载/切换/派生刷新、模型/设置默认、Provider 能力、fallback/log 有效值。[来源：`docs/features/v0.7.97.md:909–949,1050–1055`。]
- 体验承接 T43–T47 已 Done，含产品默认权限、观察恢复、会话信息、effort 反馈、流式活动反馈，并记录各票提交；T47 没有承诺逐字工具参数 JSON 预览。[来源：`docs/features/v0.7.97.md:1020–1028`。]
- UI 暴露面 T48–T52 已 Done；输出单一所有权 T53–T56 也已 Done。后者把 outputId 从生成串到 canonical 保存及多消费者读屏，已超出 tracker 只提 T43–T47 的摘要粒度。[来源：`docs/features/v0.7.97.md:957–961,985–988`。]
- 9 月 26–27 日仍在同一设计下继续修补：`6e5d6298` 维护 canonical 与生命周期，`394d4134` 补普通历史浏览，`8685057c` 保留命令通知并恢复历史读取，`eecbbf9b` 完成接入文档；没有据这些修补改称新设计版本。[来源：上述根仓库提交消息；`docs/SDK_MIGRATION.md:3`；`docs/CLIENT_CONTRACT.md:110,292–296`。]
- **明确文档冲突：** v0.7.97 头部 :3 仍写 T38–T42 Planned/implementation open，而 :9、:166、:909 及本分支 FEATURE_LIST 已写实施完成。按本文 :512 的“实施状态唯一来源”及具体提交/源码，采用 §5 逐票状态，不采用陈旧头部推断未实施；发布验收开放仍一致。[来源：`docs/features/v0.7.97.md:3,9,166,512,909`；`docs/FEATURE_LIST.md:18,519`；`src/sdk-client.ts:26–43`。]
- 自动化记录具有明确快照和范围；人工终端手感、其它操作系统实机与发布验收仍待完成。当前代码实施不等于本轮重新验证，Windows/确定性 Provider 结果不等于跨平台/商业模型/GUI 完整验收。[来源：`docs/features/v0.7.97.md:1012,1063–1076`；`docs/test-guides/FEATURE_298_v0.7.97_TEST_GUIDE.md:71`。]

## 4. 合并主线时必须保留的契约不变量

1. **一个 Host 拥有产品执行与 canonical 事实。** 独立 Host 保留后台运行、多 Client；同一真实 Session 存储根只能有一个产品写入宿主。客户端提交意图、读取纯数据，不能重新引入私有运行器或可写 Session 副本；低层库仍可显式独立嵌入。[来源：`docs/features/v0.7.97.md:112,137–140,196–205,213`；`docs/CLIENT_CONTRACT.md:3,13–18`。]
2. **connect/ensure/disconnect/shutdown 的含义不同。** connect 被动校验，ensure 复用正常空闲升级并确认进程退出；disconnect 仅释放连接，不自动停止共享 Run；shutdown acceptance 不等于清理完成。不能恢复 embedded/daemon 自动 fallback、强停更新或退出恢复票据。[来源：`src/sdk-client.ts:26–43`；`docs/features/v0.7.97.md:215–227`；`packages/coding/src/client-contract.ts:99–101`。]
3. **事实权威按领域划分。** 输入接受记录、canonical user entry、Run 终态、Session lineage 各自裁定其事实。事件与索引仅作诊断/缓存；不能用 assistant 文本、terminal event 或通用 operation receipt 裁定真实成功。[来源：`docs/features/v0.7.97.md:233–246`；`docs/SDK_MIGRATION.md:105`。]
4. **输入身份与停止边界由 Host 决定。** inputId 重交仅承诺同 Host 存活期；不能透明跨重启重放 mutation。Session Stop 用 `sessions.cancel` 的 requestId/expectedRunId 固定顺序边界，单 Run 用 `runs.stop`，receipt 接受和真实终态分开；客户端 list/abort 循环不是等价替代。[来源：`docs/features/v0.7.97.md:250–259`；`docs/CLIENT_CONTRACT.md:143,411–415`；`packages/coding/src/client-contract.ts:660–685`。]
5. **observe 是有界完整当前视图替换，历史另读。** 不恢复持久 cursor/journal/replay。较早历史、正文、工具参数仍要通过历史/内容接口完整可达；UI 冻结浏览不能被实时帧覆写，150 项实时限制不能裁剪 canonical 消息的完整内容块。[来源：`docs/features/v0.7.97.md:267–295`；`docs/CLIENT_CONTRACT.md:292–296`；`docs/research/contract-browse-fix-verification-2026-09-26.md:11–23`。]
6. **canonical 输出只拥有一份正文。** outputId 表示一条生成消息而非整个 Turn；draft→committed 保持来源，正式保存后 retired draft 不可复活；outputState/textRevision 联合判断，committed revision 为 0。多个块可共享 outputId，不能用它独自作显示项 ID，更不能按文本相等去重不同消息。[来源：`docs/features/v0.7.97.md:271–279`；`packages/coding/src/client-contract.ts:558–573`；`docs/CLIENT_CONTRACT.md:294`。]
7. **有效设置、能力目录与执行规则归 Host。** 原始覆盖和有效值区分，null 清除继承 Host；产品普通输入/工具/工作流共用产品有效默认，底层未指定权限不因此获产品授权。新领域能力经现有握手显式协商，不虚构旧 Host 支持，也不提升整个 productClient 版本。[来源：`docs/CLIENT_CONTRACT.md:75–100`；`packages/coding/src/client-contract.ts:481–482`；`docs/SDK_MIGRATION.md:97–99`。]
8. **交互验证后才消费、故障不可静默。** 精确 requestId 的首个有效答复生效；完整 plan 和 typed question 能力保留。订阅 ready/失败/关闭可观察，重连先注册后刷新快照，不重放 mutation；保存失败不能被读屏障或关闭吞掉。[来源：`docs/features/v0.7.97.md:313`；`docs/CLIENT_CONTRACT.md:83–88,98,108`；`docs/research/unified-contract-fix-verification-2026-09-26.md:7–20,85–94`。]
9. **真实执行只作一次明确路线决定。** 保留具体动作的单次 host 授权、Auto 策略、sandbox 身份/路径/containment/CAS 防护；只有确证目标未启动才允许切换路线，目标已启动或效果未知不自动重跑。`!command` 与 effectful extension 经 Host 正常工具 Run，不恢复客户端 exec 或第二套权限引擎。[来源：`docs/features/v0.7.97.md:142,200,361`；`docs/ADR.md:6406–6423`；`docs/CLIENT_CONTRACT.md:108,411`。]
10. **归口不能靠功能回退达成。** 既有输入、附件、显示、复制、搜索、队列、MCP/Workflow/Learning 能力必须有真实消费者承接；裸 `-r` 启动前只读候选是特定例外，不是另造离线 SDK。[来源：`docs/features/v0.7.97.md:133,188,259–263,283–295,503`。]

已有修复验证记录按所有者列出了后续合并的首选公开入口回归：canonical/视图、checkpoint、交互、订阅、ACP、三种消费者；触及相应边界应重跑正向与失败序列，不能仅凭接口数量或类型通过判定语义保留。[来源：`docs/research/unified-contract-fix-verification-2026-09-26.md:85–94`。]

## 未证实

- 本分支 FEATURE_298 的新 API 已发布到 npm：当前资料明确不作该声明；本次没有外部 npm 核验。[来源：`docs/SDK_MIGRATION.md:3`；`docs/CLIENT_CONTRACT.md:5`。]
- 整个 v0.7.97 已无条件完成发布验收，或所有平台无回退：已有资料明确人工/跨平台边界；本次没有运行新验证。[来源：`docs/features/v0.7.97.md:159,1074`。]
- 历史自动化日志的原始临时文件当前仍完整存在：本次仅读取引用它们的仓库记录，未枚举用户 Temp 文件。[来源：`docs/features/v0.7.97.md:1012,1076`。]
- 除本笔记指出的状态冲突外，所有旧 ADR/feature 与当前代码均已全面对齐：本次是版本与约束定位，不是全仓设计审计。[本次研究范围。]

## 未解问题

1. 合并完成后是否立即将包版本切到 v0.7.97，还是继续继承 rc.14 并保持开发树？现存规格不自动授权发布，需根据集成验收与用户发布安排判断。[来源：`docs/features/v0.7.97.md:6,154–161`；`docs/SDK_MIGRATION.md:3`。]
2. v0.7.97 头部陈旧 Planned 与 §5 Done 冲突应在实际整合子模块时一并纠正；该文档维护属于下一步合并工作，本笔记不修改规格。[来源：`docs/features/v0.7.97.md:3,512,909`。]
3. 本次新主线 26 个提交触及哪些 owner、哪些失败/跨平台序列需要补验？本笔记给出不变量及既有回归表；具体增量影响由主线 diff 研究与实际集成验证回答。[来源：`docs/research/unified-contract-fix-verification-2026-09-26.md:85–94`。]
