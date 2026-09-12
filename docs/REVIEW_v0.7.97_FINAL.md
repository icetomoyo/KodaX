# v0.7.97 交付复查（2026-09-08）

> 下方保留历次评审，旧段落中的“未修复”只描述该段固定快照。最新修复及验收见文末“GLM 缺口修复与主线融合”；此前通过记录只证明其实际覆盖的场景，不能解释为所有客户端能力已对齐。

**以下初次复查否决的是当时的“35/35 已完成”标记。** 后续修复逐节记录，不用旧结论覆盖新实现，也不把最后一组测试通过扩大为所有客户端能力已验收。

## 范围

- 固定交付：`150e64e3d13535059160643cdfe8ee8e1f09ae91`。开始时主仓库和 features 子模块干净。
- 新增范围：`git diff e6eb7292...150e64e3`，111 文件，10,415 行增加、16,010 行删除。
- 另逐项复核上次 12 个问题；没有把这些全说成本轮 diff 新引入。
- 来源规格：[docs/features/v0.7.97.md:7](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:7)，FEATURE_298。对照上次子模块提交 `364d562d4a0df827295c992c32e4a15c6a515435`，D01、T27 的义务没有取消，变化主要是实施状态和作者记录。
- 使用 code-review 技能：两个独立子 Agent 分查 Standards/Spec，第三个子 Agent 复核旧问题，主 Agent 执行编译、测试并核实证据。
- 没有修改实现、测试、feature 状态，没有提交或发布。本文件是复查产物。
- P1：应在本版验收前修复；P2：正确性/规范问题；P3：维护性建议。静态证据与执行证据分别注明。

## Standards

保持独立评审报告顺序。

1. **[P2 · 成文规范违反] 撤回/状态查询失败被吞掉。** [packages/repl/src/ui/client-plane.ts:175](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/client-plane.ts:175)、[packages/repl/src/ui/client-plane.ts:210](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/client-plane.ts:210) 将 withdraw 失败吞成 undefined；[src/kodax_cli.ts:5464](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/kodax_cli.ts:5464) 将 activeRun 查询失败变成“无活动 Run”。违反 [AGENTS.md:122](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/AGENTS.md:122) 的 “NEVER silently swallow errors”。用户已看到中断或超时，但输入仍可能在 Host 执行。应等待撤回结果并报告失败，传播查询错误，不能将未知当 idle。[src/one-shot-task.ts:204](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/one-shot-task.ts:204) 的 stop 错误也需一起处理。

2. **[P3 · Duplicated Code 判断题] 会话快照应用重复三份。** [packages/repl/src/ui/InkREPL.tsx:10084](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:10084)、[packages/repl/src/ui/InkREPL.tsx:10203](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:10203)、[packages/repl/src/ui/InkREPL.tsx:10305](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:10305) 的新增 hunk 重复恢复 messages、扩展状态、runtime 和 UI 缓存。新增字段会迫使三处同步修改。已满足仓库“3+ concrete use cases”，可抽出共同快照应用函数，命令各自保留 ID/时间戳处理，不增加控制层。

## Spec

前三项保持独立评审顺序，后两项为该 Agent 追加核实的实际消费者缺口。

1. **[P1] 产品仍默认 embedded，独立 Host 迁移没有完成。** [src/kodax_cli.ts:4940](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/kodax_cli.ts:4940) 默认 embedded，[src/kodax_cli.ts:4951](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/kodax_cli.ts:4951) 原地 createKodaXRuntime；[src/sdk-client.ts:70](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-client.ts:70) 把 embedded Runtime 投影为产品 Client。规格 [docs/features/v0.7.97.md:136](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:136) 要求“产品固定独立 Host”，[docs/features/v0.7.97.md:632](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:632) 要求“删除产品 embedded/worker facade、旧 mode/isolation options”。实际只删除 worker，保留 embedded/daemon 双产品模式，并以此证明 T27 完成。底层包可嵌入不等于产品继续双模式。应补迁移真实产品入口后删除其 mode/fallback，不能只改默认值或给旧 façade 换名字。

2. **[P1] 排队提交失败后，原文和 inputId 没有可靠保留。** [packages/repl/src/ui/InkREPL.tsx:9444](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9444) 异步提交后立即清编辑区；[packages/repl/src/ui/InkREPL.tsx:9115](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9115) 创建 ID，[packages/repl/src/ui/InkREPL.tsx:9135](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9135) 只在成功响应后缓存全文，失败仅通知。队列满时用户无法从待确认记录取回全文，确认丢失时也没有原 ID 可查。规格 [docs/features/v0.7.97.md:250](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:250) 要求“保留待确认输入的完整内容及原 inputId”。应发送前保留当前客户端待确认记录；拒绝可取回，确认不明按原 ID 查询；绑定会话和草稿代次即可，无需永久草稿服务。

3. **[P1] ↑ 在 Host 确认撤回前就返回编辑草稿。** [packages/repl/src/ui/InkREPL.tsx:11051](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:11051) 异步 withdraw 后，[packages/repl/src/ui/InkREPL.tsx:11062](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:11062) 立即返回缓存或预览。若已开始执行、conflict 或连接失败，原工作仍可执行，用户却拿到文本并重发；其它客户端的长输入还可能只取回 1KB 预览。规格 [docs/features/v0.7.97.md:245](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:245) 要求“以具体 inputId 原子取出；已开始投递时明确冲突”。应成功后用 Host 返回的完整正文回填，并校验会话/草稿代次，不能把 conflict 当取回成功。

4. **[P1] 图片/附件在新 REPL 输入链上被丢弃。** [packages/repl/src/ui/InkREPL.tsx:8200](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:8200) 忽略 inputArtifacts；classic [packages/repl/src/interactive/repl.ts:865](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/interactive/repl.ts:865) 同样只传 prompt。用户输入“描述 @image.png”或粘贴图片时，[packages/repl/src/common/input-artifacts.ts:46](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/common/input-artifacts.ts:46) 图片锚为空，[packages/repl/src/common/input-artifacts.ts:115](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/common/input-artifacts.ts:115) 从 prompt 移除路径，将图片单独放入 artifacts。[packages/repl/src/ui/InkREPL.tsx:10644](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:10644) 准备完两个参数，新分支却只留正文，Host 连可重解析的图片路径都收不到。规格 [docs/features/v0.7.97.md:254](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:254) 要求不能删除“附件或图片能力”。应贯通既有 Client typed input/附件引用，以真实 Provider 收到 image block 验证，不创建另一套附件服务。

5. **[P1] 有分页/全文接口但 UI 未消费，长历史搜索与复制退步。** [src/session-view.ts:304](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/session-view.ts:304) 最多返回 150 项，单项正文/工具参数最多 8192 字符；[packages/repl/src/ui/InkREPL.tsx:1818](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:1818) 用该窗口整体替换 UI 历史。搜索 [packages/repl/src/ui/InkREPL.tsx:4187](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:4187) 仅索引当前显示项，复制 [packages/repl/src/ui/InkREPL.tsx:5111](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:5111) / [packages/repl/src/ui/InkREPL.tsx:5137](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:5137) 直接读取选择项。生产 REPL 无 readHistory/readHistoryEntry/readViewItem/plane.readItem 调用；CLI 接线和类型声明不等于消费。规格 §3.4 要求“UI 搜索范围不能被首次观察的最近一页无声缩小”“不能以截断预览冒充全文”。应将浏览、搜索、展开、复制接入分页与稳定 ID 全文读取。

## 上次 12 项问题复核

**11 项未修复，1 项部分修复，不能算 12 项闭环。** 第 2/3/4 项有本次实际函数复现，其余是当前调用链证据。

| 原编号 | 结果 | 当前证据与影响 | 最小修复方向 |
|---|---|---|---|
| 1 MCP 配置丢失 · P1 | 未修复 | [src/sdk-runtime.ts:4661](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:4661) 重建失败仍 removeSessionMcpServers；[src/sdk-runtime.ts:4606](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:4606) 删除持久化配置。临时连接失败会变成配置丢失。 | 保留期望配置，报告当前不可用；清理连接资源，不删配置。 |
| 2 工具状态失真 · P2 | 未修复 | [src/client-history.ts:168](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/client-history.ts:168)、[src/session-view.ts:353](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/session-view.ts:353) 历史恢复硬编码 success。执行复现中 “[Tool Error] bad” 仍投影为 success。 | 复用底层已有状态映射，覆盖 error/cancelled。 |
| 3 读错工具全文/参数 · P2 | 未修复 | [src/client-history.ts:136](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/client-history.ts:136) 丢弃 #ordinal，[src/client-history.ts:84](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/client-history.ts:84) 读整个 entry。执行读取第二个工具 #2，text 返回 assistant 的 plan，input 返回两个工具的参数拼接。 | 按显示项定位 block/call，读取相应 result。 |
| 4 分页切开 call/result · P2 | 未修复 | [src/client-history.ts:45](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/client-history.ts:45) 仅同页配对，[src/sdk-runtime.ts:7877](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:7877) 没跨页补取。执行显示 “Session ended before the tool completed.”，实际结果消失。 | 补取边界必要相邻记录，保持项锚点和去重。 |
| 5 rewind 后旧分支输出残留 · P1 | 未修复 | [src/session-view.ts:239](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/session-view.ts:239) 重载历史仍拼旧 state.items；[src/sdk-runtime.ts:4314](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:4314) 对 rewind 只置 history dirty。 | 分支切换使旧运行显示缓存失效，按新活动分支重建。 |
| 6 rewind 缺 stale intent 防护 · P2 | 未修复 | [src/sdk-runtime.ts:1542](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:1542) selector/default 路径无 expectedHead，[src/sdk-runtime.ts:8323](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:8323) 直接执行。可选 historyBoundary.sourceRevision 已有校验，不能说所有路径全无保护。 | 产品 rewind 携带并核验 expectedHead，旧 head 明确 conflict。 |
| 7 compact 破坏提交去重 · P2 | 未修复 | [src/sdk-runtime.ts:11237](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:11237) 先 assertSessionNotCompacting 再查已接受记录。同输入在 compact 时重交会冲突。 | 基本授权后先查原接受意图，仅首次提交检查 admission。 |
| 8 Workflow 丢会话执行设置 · P1 | 未修复 | [src/sdk-runtime.ts:11584](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:11584) 只收 Host 默认值，[src/sdk-runtime.ts:11621](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:11621) 构造 provider/model/project context，不继承发起 Session 的有效设置、权限、MCP/凭据。 | 明确 Session/调用范围，在 Host 解析既有有效选项；测试实际子 Agent。 |
| 9 排队 Skill 丢 metadata · P1 | 未修复 | [src/sdk-runtime.ts:10879](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:10879) 仅留 prompt/skillInvocation 后 startRun；[packages/coding/src/skill-invocation-policy.ts:253](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/skill-invocation-policy.ts:253) 下游只补工具权限与 Pre/PostToolUse，未补 model/fork/SessionStart/UserPromptSubmit。 | Host 消费完整的既有 Skill 执行语义，覆盖前置 hook 拒绝。 |
| 10 Skill 动态上下文全禁 · P2 | 未修复 | [src/runtime-invocations.ts:108](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-invocations.ts:108) 固定 disableDynamicContext:true。 | 绑定已有 Host 受控执行器/授权边界，不用全禁代替迁移。 |
| 11 只读 review RPC 写文件 · P2 | 未修复 | [src/runtime-daemon/server.ts:184](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-daemon/server.ts:184) prepareReview 归 session:observe，[src/runtime-review-preparation.ts:166](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-review-preparation.ts:166) 写 packets；[src/runtime-daemon/protocol.ts:470](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-daemon/protocol.ts:470) mutation 列表未包含它。绕过写 admission/draining。 | 将写文件动作置于正确写入授权/admission，不新增通用账本。 |
| 12 Memory 接线 · P1 | 部分修复 | [packages/repl/src/ui/InkREPL.tsx:9779](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9779)、[packages/repl/src/interactive/repl.ts:1135](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/interactive/repl.ts:1135) 已转发 memory；[src/runtime-daemon/client.ts:936](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-daemon/client.ts:936) 仍抛 “Memory management requires an in-process runtime client.” | 补齐独立 Host 的 Memory 管理，保留精确批准，不靠 embedded 回退。 |

## 追加确认

### 视图 memo 返回过期内容/流式标记 · P2

[packages/repl/src/ui/client-plane.ts:269](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/client-plane.ts:269) 指纹仅比较文本长度，不含实际内容或 streaming 状态；[packages/repl/src/ui/client-plane.ts:325](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/client-plane.ts:325) 在终态复用旧对象。实际函数复现：

1. assistant 文本 abc、activeRunId 存在，保存 memo。
2. 同项 terminal，不传 activeRunId。
3. 同项 text 改为等长 xyz。

三次结果均为 `text: "abc", isStreaming: true`。违反规格 §3.4“当前视图完全覆盖旧视图”。应将影响渲染的字段和 streaming 状态纳入缓存判断，补活跃→终态、等长替换回归；不必删除缓存或引入同步框架。

### /recover 丢失明确继续输入 · P1

[packages/repl/src/ui/InkREPL.tsx:8915](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:8915)、[packages/repl/src/interactive/repl.ts:988](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/interactive/repl.ts:988) 的绑定分支只创建/切换 Session，将 prompt 当 reason 并返回 recovered；Ink 在 [packages/repl/src/ui/InkREPL.tsx:8948](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:8948) 明确不执行 continuation。下方旧路径仍含实际续跑。规格 [docs/features/v0.7.97.md:286](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:286) 保留“安全摘要 → 新 Session → 明确继续输入”。这与崩溃自动恢复无关。应成功创建后经普通 input 提交用户明确的继续输入，失败不盲目重发。

### Workflow S1 超时不是已证实的环境漂移 · P2（验收）

本次 sdk-client.workflow.test.ts 第 86 行的 20 秒终态检查失败。定位：

- sdk-runtime 的 workflows.get 返回 process snapshot。
- [packages/agent/src/workflow/run-manager.ts:409](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/agent/src/workflow/run-manager.ts:409) stop 将 run.status 置 stopped，将 process.status 置 cancelled。
- [src/sdk-client.workflow.test.ts:82](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-client.workflow.test.ts:82) 仅接受 completed/stopped/failed，漏 cancelled。
- 本次纯内存实际管理器输出 `{"runStatus":"stopped","processStatus":"cancelled"}`。

因此超时**不能证明 stop 失效**，但不能像 T27/HANDOFF 归为“环境漂移”而豁免。应按正式 process 状态修正断言，并补实际受控子任务停止/结算验证；修改断言不等于修复产品。

### 完成标记超出验收证据

- T27 的 Status 明写保留 embedded|daemon，范围却要求删产品 embedded/mode；应按原义务复开，不进一步收窄需求。
- [docs/HANDOFF.md:610](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/HANDOFF.md:610) 已记“plane 提交丢 inputArtifacts”“readItem 分页 classic 未做”。这些是迁移缺口，不是可以不影响 Done 的 Low。
- [docs/HANDOFF.md:840](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/HANDOFF.md:840) 仍将人工终端 parity 留到发布前；[docs/features/v0.7.97.md:1176](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:1176) 明确“未验证不能称为已实现的提升”。本次也未做人工终端/安装产物/其它平台验收，不能宣称体验无回退。
- [package.json:18](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/package.json:18)、[package.json:19](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/package.json:19) 仍留 runtimeExitSettlement、sessionEventJournal 版本标记。本次未发现运行时读取路径，作为清理残留，不夸大为实际连接仍广告旧协议。
- 版本仍是 0.7.96-beta.1。bump/发布归后续发布流程，版本没升本身不作为缺陷；本次不发布。

## 实际进展与验证

control-journal.ts（418 行）、exit-settlement.ts（1277 行）、runtime-worker 三文件已实际删除，不是移到私有目录。Ink/classic 已有 Client 输入/观察/交互路径；ACP/A2A 等有真实回归覆盖。Memory UI 转发已修。

| 检查 | 本次结果 |
|---|---|
| `node node_modules/typescript/bin/tsc -b tsconfig.build.json --pretty false` | 通过。只证明 package build，不宣称根目录全部类型检查或完整 bundle/native/dts/安装产物通过。 |
| Client/REPL plane/one-shot/生命周期/命令/invocations 定向集（14 文件） | 58 通过、1 失败，失败为上述 workflow 断言。 |
| runtime-daemon、ACP/A2A、SDK 输入/队列/权限/历史/独立性等（45 文件） | 558 通过。 |
| REPL 全源测试（235 文件） | 2669 通过、1 跳过。原有测试通过，仍没有覆盖上述实际消费者缺口。 |
| 实际函数复现 | 工具错误状态、ordinal 全文读取、跨页 call/result、memo terminal/等长替换、workflow run/process 状态差异。 |
| 未执行 | 人工终端 parity、完整安装/打包、其它平台、全仓覆盖率；无外网或真实模型调用。 |

批次有重叠，不把通过次数相加当独立覆盖率。没有重写基线、删除断言或修改实现让复查变绿。

## 收尾建议

1. 复开 T27 的独立 Host 产品迁移，补 Memory 等被 embedded 掩盖的消费者；底层独立嵌入继续保留。
2. 在 T17/T18/T34 原切片修输入待确认/撤回、附件、历史全文、recover 与缓存；使用现有接口和本地 UI 状态。
3. 按旧 12 项清单关闭 MCP、历史、head/去重、Skill/Workflow/权限边界缺口。“本票之前就有”不能豁免本版尚未修复的问题。
4. 修正 workflow 断言与错误环境归因，补真实 UI/Provider/子任务证据及规定终端/安装验收后再更新 Done。

轴内汇总：Standards 主报告 2 项（最高 P2）；Spec 主报告 5 项（最高 P1）。旧问题和追加确认另列，不重复算成本轮新增。

## 2026-09-08 修复后复核：1a88c401

**修复提交和部分改进属实，但“三层修复全部完成”仍不成立。** 特别是 L2 的待确认输入、原子取回、全文复制仍有实际缺口；L3 改了产品连接路径，但没有因此完成所有生产消费者的迁移。旧票的未完成项不能靠“刻意边界”或记录残留变成已验收。

### 范围与已确认修复

本次固定 HEAD：`1a88c401310bf32b5becd61ca0c954d744747b1b`；差异 `150e64e3...1a88c401`，32 文件，630 行新增、266 行删除。提交为 `99ada31a`、`3e9cbb2e`、`ee581a80`、`0f6ee47f`，后续三次文档提交。主 Agent 与 Standards、Spec、原边界核实三个子 Agent 只读检查；仅追加本评审记录，不改实现、测试或票据状态，不提交、不 push。

| 声明 | 本次核实 |
|---|---|
| workflow 超时归因更正 | 成立。断言改为接受 process 的 cancelled，本次真实 Host 测试通过。旧“环境漂移”归因已在追加记录撤回。 |
| 四处静默吞错改 diagnostics | 属实。但 activeRun 查询失败仍返回 undefined，日志明确“当 idle 处理”；解决“不静默”不等于解决“未知被当 idle”的行为。 |
| memo 内容/流式位 | 典型等长替换、活跃→终态路径已修，相关回归通过。 |
| 即时输入附件贯通 | 接线和 digest 已增加，本次新增测试通过；忙时 UI 附件准备仍缺，见下。 |
| /recover 普通明确继续输入 | Ink 与 classic 已接回普通 round，本次未发现原有“只建会话不续跑”的问题仍在。 |
| CLI 固定独立 Host | getCliRuntime 现恒 daemon，旧 CLI mode/env/config 开关确已移除。这一具体修复成立；Memory 等消费者仍未迁完。 |
| 输入保留、↑ 原子取回、全文复制全部修好 | 不成立，见 Spec。 |
| 旧 12 项残留可作为刻意边界关闭 | 不成立，见原边界复核。 |

### Standards

保持独立轴报告的顺序，不与 Spec 混排。

1. **P2 · 成文规范：新增 console.log。** [packages/repl/src/interactive/repl.ts:1028](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/interactive/repl.ts:1028) 在 recover 续跑失败时新增 console.log，违反 AGENTS.md 的“NEVER commit console.log”。应使用既有 logger/展示通道。这是规范问题，不作为核心架构否决理由。
2. **P3 · Duplicated Code 判断题。** [packages/repl/src/ui/InkREPL.tsx:9036](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9036) 新复制 Skill→附件准备→告警→执行流程，与已有两处形成三份。满足仓库 3+ 实际用例后才提取的条件；建议共同执行函数，不增加控制面。
3. **P3 · Speculative Generality 判断题。** [src/kodax_cli.ts:1432](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/kodax_cli.ts:1432) 的三项退出清理回调改为 optional，但唯一产品调用 [src/kodax_cli.ts:5516](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/kodax_cli.ts:5516) 已全部不传；应删除无消费者参数及空退出阶段。daemon 自己的清理仍有真实资源，不应一起删。

四处旧吞错已加诊断；本轮未发现新增 any 或包层级反向依赖。

### Spec

保持独立轴报告的顺序。

1. **P1：待确认输入仍可能丢失或重复提交。** [packages/repl/src/ui/InkREPL.tsx:9254](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9254) 在任何 submit 拒绝后删除原 inputId；[packages/repl/src/ui/InkREPL.tsx:9261](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9261) 只在编辑器仍空时回填。用户已开始写下一条时，旧全文被删除且不回填。响应丢失也走同一拒绝分支，即便 Host 已接受，用户下次仍生成新 ID，失去查询/去重保证。规格 §3.3 要求“保留待确认输入的完整内容及原 inputId”，异步结果不能污染后来草稿。应区分明确拒绝与确认未知，保留发起会话、ID、全文；先查接受状态，草稿有新内容时保留可取回记录。另 [packages/repl/src/ui/InkREPL.tsx:9262](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9262) 用 `text.trim().length > 0` 设置 isInputEmpty，与正常更新的判定方向相反。

2. **P1：↑ 的“只回填已确认撤回内容”并未成立，且新增迟到覆盖。** [src/kodax_cli.ts:5368](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/kodax_cli.ts:5368) 将 conflict 转为 undefined；[packages/repl/src/ui/InkREPL.tsx:11185](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:11185) 用 `text ?? cached` 将这类已投递/已撤回的输入从缓存重新交给编辑器。故之前的重复工作风险仍在。[packages/repl/src/ui/utils/prompt-input-controller.ts:535](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/utils/prompt-input-controller.ts:535) 又在 Promise 完成时不检查会话、当前草稿或代次直接 setText，用户等待期间输入的新内容可能被覆盖。规格 §3.3 要求“已开始投递时明确冲突”“不能覆盖后来输入或切换后的会话”。应传播 conflict，严格只回填 Host 成功返回的全文；迟到结果校验会话和草稿代次，保留取回结果而不覆盖新输入。Promise.all 中按完成时机 push 还会打乱原队列顺序，应保留原索引。

3. **P1：全文复制仍会把预览当全文。** [packages/repl/src/ui/client-plane.ts:419](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/client-plane.ts:419) 映射 assistant 时只保留 item.text，丢 totalTextLength/textOffset 等截断信息；只有 tool output 增加 [truncated] 后缀。[packages/repl/src/ui/InkREPL.tsx:5143](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:5143) 又只通过后缀决定是否调用全文读取。对“总长 9000，视图尾段 8192”的实际 mapper/门控函数执行结果为：
   `{ mappedLength: 8192, mappedTotalTextLength: null, fullCopyReadWillBeTriggered: false }`。
   所以复制助手长回答仍只取得尾段。规格 §3.4 要求“不能以截断预览冒充全文；内容暂不可用时给出明确反馈并保留当前选择”。应保留明确截断元数据，以稳定 ID 读取全文；失败应显示内容不可用，不诊断后仍给用户“复制成功”的假象。

### 全文复制的另外两处生产接线问题

- **工具参数按钮可能在读取之前就返回。** [packages/repl/src/ui/client-plane.ts:405](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/client-plane.ts:405) 仅把 inputText 放入 preview，未填 tool.input；[packages/repl/src/ui/utils/transcript-search.ts:306](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/utils/transcript-search.ts:306) 无 input 就无复制文本；[packages/repl/src/ui/InkREPL.tsx:5190](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:5190) 在 readItem 前直接返回。普通 plane 工具项不能靠本轮新增 readItem 自动补齐。
- **真正进入读取也存在参数形状错误。** [packages/repl/src/ui/InkREPL.tsx:5126](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:5126) 对工具参数传 `{offset, part:'input'}`，但 [src/kodax_cli.ts:5403](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/kodax_cli.ts:5403) 的生产绑定仍将第三参当 number，包装为 `{offset}`。提取当前实际 arrow function 执行，得到 `{offset:{offset:0,part:'input'}}`；再用实际 schema 校验 offset，返回 “must be number”。两份测试绑定已改，生产未改。应使用同一参数契约，并通过真实生产适配器验证，不能只修测试 fake。

以上补充与 Spec 第 3 项属于同一全文/参数复制缺口，不重复计数。

### 附件：即时链已补，忙时链仍未贯通

[packages/repl/src/ui/InkREPL.tsx:9567](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9567) 忙时继续调用 submitHostQueuedFollowUp(fullText)；[packages/repl/src/ui/InkREPL.tsx:9231](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/ui/InkREPL.tsx:9231) 只发送 text/id/delivery，没有 preparePromptInputArtifacts 或 inputArtifacts。Host 在 sdk-runtime.ts 的 drain 只合并已有 input.inputArtifacts，不将 @image 路径重新解析成图片输入。因此“描述 @image.png”在运行中排队时仍只有文本。此处为静态完整调用链证据，未进行真实 Provider image block 端到端实验。

新增 [src/sdk-runtime.test.ts:2899](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.test.ts:2899) 虽名为 product-queue，实际在 idle Session 调用 acceptInput，mock runManagedTask 并读取 options；并未验证真实忙时排队、实际文件可读或 Provider image block。应补忙时 UI 准备/入队/Host 消费的同一条完整测试，不能由此断言附件已全链路验收。

### “刻意边界”与原规格的复核

**动态上下文：可以保持受控执行政策，不能默认全部禁用后宣布保持原能力。**

- 规格 §3.9/T37/US33 要求承接既有动态上下文政策与执行准备。
- [src/runtime-invocations.ts:108](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-invocations.ts:108) 无条件 disableDynamicContext:true，未绑定 Host executor/会话政策。Skill 中 `Workspace root is !\`pwd\`` 会被 resolver 替换成“Dynamic context disabled by host”。
- 旧 UI 准备路径会传递 execute/disable；未禁用时有白名单只读命令路径。旧 Runtime 内部缺 executor 时已有禁用机制，因此不能把旧行为说成“任意 shell 无限制运行”；缺口是迁移没有接回原先可用的受控准备路径。
- 当前测试断言错误占位，只能证明禁用实现了，不能证明 US33 不退步。此项仍应按 T37 未完成处理。

**prepareReview：保留写 packet 能力合理，但 observe-only 获得写能力不等于原设计批准。**

- 旧 /review --workflow 已写 packet；把该工作移到 Host 符合迁移原义。
- [src/runtime-daemon/server.ts:238](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-daemon/server.ts:238) 将 RPC 归 session:observe，之后将 caller 的 projectRoot/sessionId/args 传到 [src/runtime-review-preparation.ts:166](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-review-preparation.ts:166) 写包分支，未核验 Session 存在、所属 cwd 或写 admission。protocol mutation/draining 列表也不包含它。
- 实际写入范围是所选 cwd 内 .agent/tmp/sessions/.../review-packets，目录、文件名及内容受实现约束；**不夸大为任意文件覆盖**。
- 规格 §验收要求“认证按真实权限”。Host 写包本身与给只读 Client 写权限是两个问题；实施状态中的“刻意”注释不能代替批准。应使用准确写授权和 admission；本次仅静态核实调用链，未运行写文件实验。

**Memory：固定 daemon 后，不是 CLI 启动必崩，但非 help 的 /memory 均不可用。**

[src/kodax_cli.ts:5240](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/kodax_cli.ts:5240) 只是创建 lambda，所以不能误报一启动就失败。实际执行 /memory 时，[packages/repl/src/commands/memory-command.ts:707](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/repl/src/commands/memory-command.ts:707) 调用 binding，[src/runtime-daemon/client.ts:936](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/runtime-daemon/client.ts:936) 直接抛 “Memory management requires an in-process runtime client.”；help 提前返回。该入口是 T36/US32 原有真实能力，L3 不能在它未迁移时宣称所有消费者已完成。应补 Host 管理接口，不恢复 embedded fallback。

MCP 配置丢失、历史状态/分页配对、rewind、compact 去重、Workflow/Skill 设置、全历史搜索等原残留，本轮反馈已承认未修；不作为新 diff 的新增问题重计，但仍阻塞原设计完整验收。

### 本次验证及建议

- package 编译：`tsc -b tsconfig.build.json --pretty false` 通过。
- 输入/Client plane/CLI/one-shot/lifecycle/workflow/controller：10 文件、91 通过。
- daemon server/schema/client：3 文件、116 通过。
- 新附件测试：1 通过，文件内其余 286 项因定向过滤未运行。
- 实际函数复现：长助手文本映射/全文读取门控；生产 readItem 绑定参数及 schema。
- 未重跑完整 build/binary、全部 src/REPL、daemon-smoke、人工终端、安装产物或其它平台。GLM 提供的全量门禁成绩是作者记录，不冒充本次独立验证结果。

建议先补齐以上三个 L2 消费链断点，测试直接走生产适配器和 UI 的异步入口；再关闭 busy 附件、Memory 和原票残留。继续使用既有输入身份、普通分页、Host 授权和本地草稿状态即可，无需新建操作账本、恢复状态机或更多配置开关。

本轮主报告统计：Standards 3 项（P2 1、P3 2；最高 P2）；Spec 3 项（P1 3；最高 P1）。原边界与附件补充单列。


## 2026-09-08：按设计修复与验收记录

本节为上述复查缺口的整改记录；历史评审证据保留，不把旧门禁成绩当作本次验证。代码基点为 `1a88c401`，修复在 `codex/product-client-refactor`，主仓库合并与最终门禁已完成，结果及边界见本节收尾记录。

已补齐输入保留/原子撤回、图片队列及模型 wire、完整历史和复制、工具状态及跨页配对、rewind head 检查和视图刷新、compact 去重、MCP 重建配置保留、独立 Host 的 Memory 管理、Workflow 有效执行设置、Skill 模型/hooks/fork/受控动态上下文与 review 写授权。CLI 与测试共用生产 Client 适配器；产品 SDK 不再公开接收 Host Runtime 的内部转换函数。

另以真实测试修复：Host 报成功但最终快照未保存；既有无路径会话被执行目录隐式改写归属；只为准入而读取整份 transcript 引发检查点竞争；初次 observe 跨分支失效。保留 Storage 的混合桶、跨进程读边界和已删除 Session 防护。

首次完整快速层 1744 通过、15 失败：其中已确认的产品缺口逐项修复；Electron 夹具 CRLF、Windows crash 夹具依赖 tee 改为跨平台表达。单元层首次 10777 通过、222 失败；权限夹具位于受保护 `.codex` 工作树是共同根因，改普通夹具目录后同文件 968/968 通过，未修改产品权限规则。契约层 115 文件、926 通过、21 todo。最终重跑及主仓库合并验证结果在收尾时补录。

### Standards

独立复查未发现新增硬违反或可行动 smell。即时输入复用队列、Host 元数据保留和内部适配器迁出均对应已确认缺陷，无新增通用恢复机制。

### Spec

首轮发现即时输入未保留原身份的 P1，已接入同一队列，并经独立复核关闭；3 文件 57 测试及无 Node 类型消费者检查通过。当前独立复核新增 finding 为 0。

两轴分别统计：Standards 0；Spec 原 1 项 P1 已关闭，剩余 0。最终集成门禁仍在进行，不以此代替完整验收。

### 集成复验补充

快速层最终重跑 1766 通过，完整 build（四包、原生、bundle、SDK 声明及无 Node ambient 的产品消费者）通过。系统层首次 1188 通过、19 失败，已逐项定位：14 项会话/权限夹具与 Host 扩展库存预期按实际边界修正并定向全绿；打包通过现有 npm CLI 重跑通过，未修改产品；Windows daemon 状态原子替换的瞬态 EPERM 真实复现后增加最多 200 ms 的有界重试，状态测试 48/48、真实启动两例通过。

另两项为真实产品缺陷：UI retry 与 child activity 在进入内存状态时就按有效凭据作用域脱敏，避免延迟持久化泄漏；已创建但排队的低层 Run 保留模型快照，实时权限仍生效，尚未消费的产品输入继续读取最新设置。原失败精确回归 3/3、相关设置/产品队列/视图 11/11、跨 scope 子活动回归 2/2 通过。主分支合并后的完整系统层仍须重跑，不将定向结果冒充全量通过。

提交前补充双轴复核：Standards 0；Spec 发现完全缺目录身份的旧 Session 准备 Skill 时可能回退 Host cwd，已改为明确 `session_not_admitted`。保留已有显式 executionCwd 的兼容，不改 Skill 输入语法。独立复核无身份拒绝、三类动态上下文政策及脱敏/原子发布 50 项通过，该项关闭，Spec 剩余 0。

### 主仓库合并

修复独立提交为 `530e0785`，随后合入主仓库 `KodaX` 分支的 `17474b64`。文档子模块先提交修复 `bc812fa`，再以 `31306c7` 合入主仓库子模块 `3a3db0f`。主线 beta.3 的共享凭据作用域、替换连接关闭、长上下文容量恢复、ASRT/WFP 修补、构建与严格类型门禁均保留；版本号继承主线 `0.7.96-beta.3`，不据此声明发布 0.7.97。

冲突按双方意图融合：旧 CLI runner、Runtime Worker 和 exit-settlement 的主线改动仅修补已退役代码的类型，继续保持删除；当前生产适配器保留有效类型修正。Managed compaction 保留主线的容量校准/历史恢复，同一模型继续使用校准值，换模型重新解析容量。文档保留主线发布记录及本分支已批准设计和实施证据，并移除合并产生的重复 Planned 条目。

合并独立评审：Standards 未发现硬违反或可行动 smell。Spec 发现新 `contextOverflow` 未进入 daemon 封闭响应 schema 的 P1，导致真实容量错误被遮蔽为 `internal_error`；已补齐 typed schema，精确值、下界、未知及缺省数字保持原义。真实 pipe 的 get/await/失败事件和非法字段/数值测试 5/5，独立复验通过，P1 关闭。主线旧 bundle 测试迁移到现有 ensure/connect、shutdown、Host 铸造身份与 live subscription，保留真实 v2 broker 和两类压缩验证，不恢复已删除协议。


### 最终验证结果

| 验证 | 结果 |
|---|---|
| 完整 build（packages/native/bundle/dts） | 通过；产品 Client 无 Node ambient 消费者编译通过 |
| 严格 typecheck:src + typecheck:tests | 通过；未放宽 strict |
| 完整快速层 | 166 文件通过、1 跳过；1781 通过、32 跳过 |
| 完整单元层 | 687 文件；11025 通过、3 跳过 |
| 完整契约层 | 115 文件；926 通过、21 todo |
| 系统全范围与修复后复验 | 全范围 57 文件首轮 1220 通过、3 容量 schema 失败、42 跳过；修复后完整 Runtime 文件 291/291，通信/schema/A2A 四文件 193/193，全部失败关闭 |
| 最终构建后的真实打包回归 | 24/24；含 v2 凭据 broker、手动/managed 压缩、ASRT/WFP |
| 合并交叉回归 | daemon 7 文件 176/176；容量/模型切换 6 文件 70/70 |

系统长时运行在容量修复前已载入旧 schema，三个新增用例因此在该轮失败；最终构建后重新运行完整失败文件与受影响通信测试，未重跑全部 57 文件。前述 Runtime 存储夹具统一补齐已存在的 Host 会话：保留删除保护和原有失败/持久化顺序断言；最终单元、契约完整层已重新通过。未运行人工终端手感、跨平台实机、完整 Electron GUI 或发布验收，不以自动门禁替代这些检查。没有执行远程 push 或发布。

### 最终 Standards

剩余硬违反 0、可行动 smell 0。独立合并评审通过；其后的容量 schema 小补丁复用既有领域类型和封闭 schema，夹具修正保留原断言，经主任务增量规范复核未新增问题。

### 最终 Spec

剩余 0。本轮发现的即时输入保留、缺目录回退和容量 wire 缺口均已修复并独立复核关闭。合并保留已批准产品边界和主线有效修复。

## 真实产品入口自动化验收

2026-09-08，在合并提交 `a0ee3390` 基础上增加并执行真实进程验收，同时修复验收暴露的问题。本节更新前文“剩余 0”的适用范围：此前评审关闭了当时发现的缺陷，并不能证明所有终端体验已通过；本轮仍有两项未关闭问题，见下文。

### 验收方式与已修复问题

Windows ConPTY 实际启动构建后的产品 CLI，使用键盘操作 owned Ink 和 classic REPL，经独立 Host 请求本地 HTTP SSE Provider。xterm 解析实际终端输出，公开 Client 读取会话事实，Provider 请求记录核对完整正文和历史隔离。没有以模拟 React 回调或 SDK 单测冒充这一流程。

真实入口与公开契约回归共同暴露并修复了以下问题：

- 冷启动尚未在 Host 建立 Session 就允许输入；`/new` 未等待 Host 创建就切换本地状态。现在先完成创建及设置，再显示可输入的新会话；失败保留原会话。
- CLI 选定设置未完整落到 Host；显式选择与本地相同的值，可能无法覆盖另一客户端已修改的值；异步设置尚未确认就显示成功。现在等待 Host 确认，显式命令提交所选字段，普通本地更新只提交实际变化字段，随后输入等待设置写入完成。
- Ctrl+C 产生的普通 Provider `AbortError` 被替换成一般错误，Run 错报网络失败。修复后普通取消保持 `interrupted`，停止结果确认为 interrupted；真实网络错误与取消并发时仍保留真实失败。
- 普通取消继续生成“恢复耗尽、需要手动继续”的提示，覆盖 classic 下一条输入提示。主动取消现在直接结束该轮，不进入失败恢复提示；实际流中断仍按原有失败恢复契约处理。

Electron 夹具迁移到当前 ensure/connect 与 shutdown 接口。Windows 沙箱夹具只读取 doctor 就绪状态，不再隐式执行全局 setup。PTY 驱动保持 classic 原有续行和直接新建行为；不为通过验收改变产品交互。

### 本轮验证结果

| 验证 | 结果与范围 |
|---|---|
| 真实 owned Ink 终端 | 12 项通过：启动、流式输入、设置、完整长输入、问答、排队撤回编辑、历史搜索/冻结浏览、停止后继续、新建隔离、退出、持久化续接、续接后退出 |
| 真实 classic 终端 | 10 项通过：上述通用场景；不套用 Ink 专属队列编辑与历史 viewport 操作 |
| 打包 Electron 42.5.0 | 最终命令退出 0；20 次工具查询、4 个 Session 并发、重启后查询、Client 连接/分离、独立 Host 生命周期通过 |
| 真实 Windows restricted-user sandbox | Node 与 PowerShell 目标实际在沙箱执行，环境隔离、跨进程并发、不支持的 denyRead 在目标执行前拒绝；未隐式安装或修复全局沙箱 |
| 完整快速层 | 166 文件通过、1 跳过；1781 通过、32 跳过 |
| 完整 REPL 套件 | 236 文件；2694 通过、1 跳过 |
| 最终受影响回归 | 5 文件 30/30：实际 HTTP 取消、Runner、产品 Client plane、Electron 夹具；另有取消/恢复相关 78/78 定向验证 |
| 构建与类型 | 完整 build 通过；最后取消提示修复后重建 packages/bundle，并通过严格 src/tests typecheck |

完整快速层在最后一行取消提示修复前执行；其后对受影响恢复链、HTTP 取消进行了定向复验，并重新执行真实终端与 Electron。未把定向重跑记为所有测试全量再次执行，也未将前文的 11025 单元测试计入本轮 E2E 数量。

可复跑命令与依赖准备见 [验收指南](test-guides/FEATURE_298_v0.7.97_TEST_GUIDE.md)。最终 PTY 证据目录为 `%TEMP%/kodax-repl-acceptance-J7nI3S`，含 `results.json`、逐场景屏幕/ANSI、Host 事实与实际 Provider 请求。Electron 最终日志为 `%TEMP%/kodax-0797-electron-acceptance-final.log`；成功时夹具按原规则清理打包临时目录。快速层、REPL、类型与定向回归日志分别为 `%TEMP%/kodax-0797-acceptance-{fast,repl,typecheck-final,regression-final}.log`。

PTY 驱动依赖 node-pty 1.1.0 在自然退出后仍保留 ConPTY worker 句柄；驱动在等待产品退出、Host 关闭和证据写入后显式结束自身，并保留所有失败退出码。错误参数返回 1 的负向检查通过。此项为测试驱动收尾，不修改产品退出逻辑。

### 独立复核与未关闭项

Standards 最终复核未发现新增可行动问题。Spec 复核发现的两项设置写入/确认 P2 已修复并关闭。以下既有缺口仍未关闭，已同步 [Known Issues](KNOWN_ISSUES.md)：

1. 其他客户端修改模型/权限后，当前 REPL 的本地配置和状态栏未同步刷新。Host 已更新及显式设置能正确往返，并不等于多客户端 UI 显示已经一致。
2. Windows 强制旧 legacy 渲染器时，搜索结果跳转可能把屏幕外历史误判为可见；当前 owned 路径通过不代表 legacy 路径通过。

因此结论为：上述自动化场景通过，不能据此宣布整个 v0.7.97 无条件验收通过。Electron 验收运行真实打包主进程但没有 BrowserWindow，不属于视觉 GUI 点击验收；本地确定性 Provider 也不代表商业模型任务质量。跨平台实机、输入法/真实剪贴板和终端主观手感尚未覆盖。本轮未 push、未发布，版本仍继承主线 `0.7.96-beta.3`。

### 2026-09-08：再次合入主仓库 beta.4

从当前验收修复提交 `0914f589` 合入主仓库 `KodaX` 分支最新的 `7b1d1ffb`，新增提交为 `1762a74d`（统一手动/自动压缩推理策略与摘要请求指标）和 `7b1d1ffb`（beta.4 发布信息）。文档子模块以 `d24175a` 合并主仓库 `041f2c7` 与当前 `93ee740`。本次继承的包版本为 `0.7.96-beta.4`，重构设计仍为 v0.7.97；没有执行发布。

冲突融合保留当前 Host 单写、会话准入、锁外 Provider 调用和异步新建会话；主线新增的压缩设置在准入锁内读取一致快照，再传给锁外压缩。classic 独立使用时通过 `saveClassicSession` 保存准确 lineage，绑定 Host 时继续由 Host 持久化；未恢复已删除的 REPL Runtime runner。文档保留两侧发布记录和重构实施状态，并明确已知验收缺口仍在。

接口复验发现产品 Client 的设置类型及返回白名单遗漏 `compactionReasoning`，已补齐。公开产品 SDK 与真实 Host 的 RED→GREEN 测试覆盖 `low → false → null` 的写入、读取、实时视图更新，并确认主轮 `effort: high` 不受影响。既有 daemon 开放 settings/report 对象可以传输新增字段，无需扩展通用协议或恢复机制。

| 本次合并验证 | 结果 |
|---|---|
| 完整 build 与最终严格 src/tests typecheck | 通过；产品 Client 无 Node ambient 消费者通过 |
| 压缩领域、附件、持久化及 REPL 命令 | 26 文件，356/356 通过 |
| Runtime 压缩和设置 | 9/9 定向通过；同文件其余 282 项未运行 |
| 产品 SDK、协议 schema 与事件 | 36/36 通过 |
| 真实打包 daemon 压缩 | 通过；手动结果和自动 finished 事件均核对 `summaryRequests`、`commitMs`、请求 reasoning、usage，保留 v2 凭据 broker 与失败断言 |
| 合并后真实 Windows REPL | owned Ink 12/12、classic 10/10，命令正常退出 0 |

PTY 证据为 `%TEMP%/kodax-repl-acceptance-uLaeqJ`。构建、类型、压缩回归、真实 daemon 和终端日志为 `%TEMP%/kodax-beta4-merge-{build,typecheck-final,compaction,bundled,pty}.log`。本轮针对新增压缩改动及其交互影响验证；没有将上一轮 Electron 成绩记为本次重跑，也没有重跑全仓全部测试。

#### Standards

独立复核合并 diff 与 Client 增量，未发现新增可行动规范问题；硬违反 0、smell 0。主任务增量核对新增打包断言，复用现有测试进程和报告结构。

#### Spec

独立复核其他合并路径，Host 单写、保存成功后刷新 UI、保存失败恢复 context、摘要推理独立于主轮和指标透传均保留。Client 字段缺口已按公开契约修复并由主任务独立复核；新增未解决 finding 0。上一节的跨客户端状态栏与旧 legacy 搜索两项既有缺口仍未关闭。

## 2026-09-09：真实 REPL 显示与 transcript 回归

用户截图及键盘反馈证明，前一轮 22 项终端验收没有覆盖 AMA、工具摘要、状态栏数值和 Ctrl+E 展开中的流式长回复，不能将其通过结果解释为体验完全等价。本轮以 `f98766e3` 为修复基线，对照主线 `7b1d1ffb` 的交互语义，并扩充同一个真实 PTY 验收入口。

已复现的原因：

- AMA 在 Host 已保存输入后又追加同一 prompt，实际 Provider 请求和显示都重复。复用普通 Agent 已有的初始输入处理，保留 Host 接受时的 inputId、时间戳与附件。
- 绑定 Host 的 Ink 仍在本地追加用户和完成后的回答；另有 canonical 保存早于 UI checkpoint 的窗口，使同一回答获得两个显示身份。关闭绑定模式的重复追加，利用已有历史恢复逻辑和当前 live 身份合并，并保持 canonical 中的跨轮位置。
- 工具参数只进入新 preview/inputText 字段，而旧折叠渲染器从 input 提取命令摘要。恢复现有 input 形态，保留原有摘要、详细输出、状态与耗时。
- AMA 临时进度被当作历史项。临时信息保留在 activity；只有明确 persistToHistory 的事件进入 transcript。
- 状态栏没有完整读取 Host 的上下文、API 用量、迭代和管理状态。修复数据接线时保留 worker 与父会话上下文的区别，避免把子任务用量写进父缓存。
- Ctrl+E 和 / 在异步历史读取完成前不切换界面；展开会用保存历史覆盖冻结的流式尾部。恢复即时按键反馈，按来源身份补历史前缀，保留冻结内容；有正文省略时通过既有分页读取补齐。

快捷键原意保持：Ctrl+O 进入/离开 transcript，Ctrl+E 切换完整历史，/ 打开搜索，Enter 跳转命中，q/Esc 返回实时界面。未提交草稿也应在往返时保留。不同轮次的相同正文不是重复记录，不能按文本全局去重。已保存的旧重复会话不自动重写。

截图中的 1M 是当前及合并前主线模型表对 glm-5.3-flash 的既有声明；262144 是用户配置的压缩触发 token 数，两者不是同一个参数。此次不凭截图改写模型容量表；该商业端点的准确容量尚未独立核实。用量停在 0 则属于本轮应修复的显示问题。

### 验证与边界

| 本轮验证 | 结果 |
|---|---|
| 完整 REPL 套件 | 237 文件，2709 通过、1 跳过 |
| 最终受影响回归 | 9 文件，173 通过、2 todo；含真实 Client observe、同文跨轮及 checkpoint 顺序、AMA 输入、全文读取、冻结展开、状态栏 |
| 真实 Windows PTY | owned Ink 15/15、classic 10/10；实际键盘、独立 Host、本地 SSE Provider 和工具执行；命令退出 0 |
| 构建与类型 | 完整 build 通过；最后排序/键盘修复后重建 packages/bundle；最终严格 src/tests typecheck 通过 |

完整 REPL 层执行期间还有最后的读取取消及草稿修复；其后受影响函数回归和真实终端已重新验证，不将全量成绩解释为最后一次逐文件重跑。验收夹具的保存回调一度被放入错误测试作用域，严格类型检查发现后已修正，并重新通过类型及真实 Owner 回归。

完整 PTY 证据为 `%TEMP%/kodax-repl-acceptance-TDKHlu`，含逐场景屏幕、ANSI、Host 事实和 Provider 请求；在此基础上将工具场景加强为 AMA 工具续轮，并重跑 Ink，证据为 `%TEMP%/kodax-repl-acceptance-H6hp9D`。日志为 `%TEMP%/kodax-ui-final-{build,rebuild,typecheck,repl,regression,pty,ama-tool-pty}.log`。没有重跑 Electron、跨平台终端或商业模型任务质量，不累计此前验收数量。

旧会话展开优先使用接受输入的 inputId 或工具 callId；没有这些字段时，仅使用唯一的完整用户正文和明确时间戳来源。无法可靠衔接时保留冻结画面并提示失败，不能猜测来源或灌入其他客户端后来追加的内容。已保存的重复历史不自动删除。前文记录的跨客户端设置刷新与强制 legacy 搜索两项仍未关闭。

### Standards

独立最终复核：硬违反 0、需处理的 smell 0。临时诊断脚本已经删除，正式场景合入已有 PTY 入口；没有新增恢复框架或存储迁移。

### Spec

独立发现的跨轮顺序、旧会话冻结污染和流式多页读取三项均已关闭；验收夹具作用域错误也已修正。运行中 worker 与结束后父上下文、工具展示、预算字段和快捷键含义得到保留。剩余新增 finding 0；这一结论限于本轮修复范围，不宣称整个重构已无任何体验缺口。本轮未 push、未发布。

## 2026-09-09：接口契约与实现一致性再扫描

扫描固定点为主线 `7b1d1ffb` 到修复基线 `45a0bfe9`，依据 `features/v0.7.97.md` 的单 Host 写入、完整当前视图、冻结浏览及体验不退步约束。对该范围的产品 SDK、CLI 适配、当前视图/历史、输入与设置边界作专项扫描；没有把涉及 273 文件的完整差异称为已逐行穷尽审查。本轮新增修复以 `45a0bfe9` 为基线。

| 确定发现 | 修复与防回归 |
|---|---|
| P1：替换失败请求时，旧输出从显示历史缓存复活 | 同一替换边界精确移除旧 assistant/thinking，保留其他响应和 retry；复用已有 generation 与保存等待。三条 RED→GREEN 分别覆盖已保存缓存、旧读取在途、新读取抢在保存前；真实 SDK 观察测试补上重新观察的时间间隔 |
| P2：单项展开/复制绕过冻结读取 | `v/c/i` 复用既有 captured reader，校验 Session、snapshot、选择及取消；实际终端中冻结后追加标记，单项展开不再纳入该标记 |
| P2：CLI 分支/标签操作把所有错误转成“条目不存在” | 移除 catch，保留 Host 原始错误；生产绑定放到已有适配模块，测试直接调用它，删除测试里的镜像实现。覆盖 missing、busy、磁盘失败、断连 |
| P2：产品 SDK 无法导出其公有接口使用的类型 | 真实发布声明消费者复现 10 个类型无法导入；SDK 直接导出同一份纯数据契约，移除手工白名单。消费者验证视图、读取、运行、工作流类型及无 Node ambient 依赖 |
| P3：catalog commands/skills 重复声明 | 删除重复重载，保留单一声明 |

本轮并未为这些问题新增恢复日志、错误文案解析、第二份业务状态或通用协调框架。特别是错误处理不通过匹配字符串猜错误类别，直接沿现有命令失败通道显示原因。

### Standards

初审硬违反 1（CLI 吞错）、smell 1（重复接口声明），均已修复。最终独立复核剩余硬违反 0、需处理 smell 0。

### Spec

新确认的输出替换、单项冻结及 SDK 类型出口缺口已修复。再次真实复现的多 Client 设置反向同步仍未关闭：SDK 改为 `other-client-model` / `plan` 后，Host 已更新，Ink 仍显示原模型 / Edits。证据为 `%TEMP%/kodax-repl-acceptance-Y9VG1i/ink-external-settings.txt`；继续作为验收阻塞，见 `KNOWN_ISSUES.md`。设置提交迟到后覆盖另一会话只是静态候选，缺乏可运行证据，未列为已确认缺陷。原有强制 legacy 搜索问题同样未关闭。

最终独立复核未发现本轮修复新增的可证实问题；不能据此声明全版已无接口或实现问题。

### 本轮验证

- 完整 build 和发布声明消费者通过；最终严格 src/tests typecheck 通过。
- 最终受影响回归 7 文件、61/61 通过；命令测试补齐 UI 夹具后另行 2/2 复跑通过。完整 REPL 套件的 2709 项属于上一轮，本轮未重跑或累计。
- 真实 Windows PTY：owned Ink 15/15、classic 10/10，退出码 0；已加强冻结后追加、单项展开的检查。证据 `%TEMP%/kodax-repl-acceptance-kxOp3i`。
- 日志 `%TEMP%/kodax-contract-scan-{build,regression-final,typecheck-final,commands-final,pty}.log`。初次类型检查发现新增命令夹具缺少必需的 UI 字段，补齐后重新通过；不影响产品代码。
- 临时诊断脚本已删除。未执行 push、发布或主仓库写入。

## 2026-09-09：真实旧会话恢复与 transcript 绘制残留

本轮基线 `da2516d6`。用户提供 Session `20260909_075806_ed59a28bf46b46` 及两张实际终端截图；对原文件和默认 Host 只读检查，将会话复制到临时目录后隔离重放。没有修改用户原始会话、停止其 Host 或执行真实模型请求。

### 恢复 query 与旧 Host

两次用户 query 都已保存。默认 Host PID 58032 的启动时间为 2026-09-09 07:58，早于前两轮修复；退出、重开 REPL 仍会连回该独立进程。只读 observe 返回 74 项，后一次 query 被排在前一次回答之前（index 10/11），不是被删除。当前源码对同一存档经 Runtime observe 隔离重放：前一轮最后输出 index 46，后一次 query index 47，旧 AMA 重复输入 index 48，后一轮首段 thinking index 49，顺序正确。不能仅凭 includes(query) 判断恢复体验通过。

`AMA Worker - Worker analyzing task` 是旧 Host 仍在发布的临时执行状态；运行结束后的实际观察及保存的 uiHistory 均无该行。当前代码只把明确要求持久化的状态事件放进历史，旧进程不会随源码修改自动获得这个修复。原会话已保存的两组重复用户输入保持原状，不按文本删除。

另确认开发入口的 Host 身份默认报告 `0.0.0`，而界面显示实际包版本，导致现有版本比较跳过。修复仅把默认值改为已有 `replApi.KODAX_VERSION`，保留显式构建版本注入；默认与注入版本均经历 RED→GREEN。没有改变被动连接、空闲更新、忙时拒绝或同版本源码的重启策略。该修复不会让当前旧进程自行更新。

### transcript 残留

用隔离的真实会话在 240×64 Windows PTY 中执行 Ctrl+O / Ctrl+E，当前源码也能复现旧正文混入页脚。帧本身的页脚和高度正确，实际终端网格错误；首个坏帧含 50 个原始 Tab。布局把 Tab 放在单列 cell 中，输出字节却让终端跳到制表位，造成光标与局部刷新位置失配。必须修正显示 cell 的字符边界，不能用反复整屏清空掩盖。

诊断期间发现 headless xterm 默认 Unicode 6 与产品的 emoji 宽度不同；使用 Unicode 11 校准后仍可复现真实会话的严重残留。旧验收中的短文本、只检查字符串存在等断言不足以验证整段工具正文及页脚的绘制一致性。

最终产品修复只在 `outputToScreen` 把显示 cell 中的 C0/DEL 控制字符转换为单列空格，与现有测宽和布局一致。换行在更早的分行阶段处理，SGR/OSC 样式与链接继续走原有结构字段；不修改历史和复制原文，不增加整屏重绘机制。三条 Output→LogUpdate→终端网格回归分别复现 Tab、回车和退格造成的错位，修复后通过，相关显示测试 41/41。

原会话副本在修复前残留（证据 `%TEMP%/kodax-repl-acceptance-67Cn3w`），修复后展开、搜索/取消、开头/末尾跳转、长短切换及 110×32↔240×64 缩放六个阶段的实际页脚逐行匹配帧（`JVSYGt`）。永久验收入口增加不含用户正文的长 Tab/中文 AMA 场景：旧代码会把正文标记绘坏并超时（`Mgiyu3`），修复后页脚完整（`6hm1Y0`）。后三个证据目录同样位于 `%TEMP%/kodax-repl-acceptance-<后缀>`。原始会话副本仅用于本地诊断，没有加入仓库。

### 本轮最终验证

| 验证 | 本次结果 |
|---|---|
| Runtime 与 SessionView 完整相关套件 | 2 文件，302/302 |
| 完整 REPL 套件 | 237 文件，2712 通过、1 跳过 |
| 真实 Windows PTY | owned Ink 16/16、classic 10/10，退出码 0 |
| 构建与类型 | 完整 build、发布声明消费者、严格 src/tests typecheck 均通过 |

最终 PTY 证据 `%TEMP%/kodax-repl-acceptance-RcvqbD`；日志 `%TEMP%/kodax-resume-runtime-regression.log`、`%TEMP%/kodax-resume-final-{build,repl,pty,typecheck}.log`。临时绘制探针和诊断脚本已删除。

### Standards

独立最终逐 hunk 复核：硬违反 0、需处理 smell 0。产品仅两处行为改动，沿用现有版本常量与显示转换；没有新建恢复框架、产品配置或依赖。

### Spec

独立最终复核剩余 finding 0，限于本轮修复。旧会话恢复按实际顺序验证，显示修复保持完整内容读取及冻结语义。多 Client 设置反向同步和强制 legacy 搜索仍按前节保留，未以本轮成绩豁免。原默认 Host 未被重启，实际使用本次修复需在任务结束后正常重启 Host 并重开 REPL，见现有测试指南；未 push、未发布。

## 2026-09-10：同版本 Host 更新、统一入口与输出说明书

本轮基线 `28e47ed971`。修复范围是重建后仍连接旧 Host，以及扫描中确认的产品入口和输出契约失配。专门说明书为 [CLIENT_CONTRACT.md](CLIENT_CONTRACT.md)，覆盖全部 71 个域内方法、连接释放及 80 个输出字段，同时说明 Node 启动、未来 Web 类型消费与尚未实现的远程传输边界。

### 实际修复

- Host 在加载时冻结构建身份，按实际生产文件字节区分同版本构建；Node ensure、CLI 普通启动和 daemon start 共用检查。相同来源空闲旧 Host 正常关闭，确认精确原进程退出后由既有锁启动新构建。被动 connect 不更新；忙碌、跨来源、旧调用进程和无法确认身份均明确处理，不引入升级锁或新恢复框架。
- 真实并发启动测试发现：另一启动器可在探测后开始正常关闭，导致 attach 返回 conflict。初版按 daemon.json 的退出状态重试，完整复验再次失败：内存 draining 先于状态文件写入，且 lease acquisition 将退出中的 owner 当作启动中等待。最终修复仅对 ensure 的初始化连接冲突按已有预算退避重试；等待进程时区分启动与退出，不重放业务/管理操作，被动连接仍直接报告错误。
- 连续并发启动第三轮进一步发现 Windows Job 监督进程自然退出时，IPC disconnect 及写入失败可先于 ChildProcess 的 exit 事件。两条真实进程测试分别复现“通道已断”和“状态仍 connected 但写入 EPIPE”，不能把它归为环境抖动，也不能将通道断开当作已退出。修复复用有界退出等待，以原监督进程和子进程真实退出为准；仍存活或无法确认时明确失败。
- ACP 默认使用同一产品 Client；文本、工具详情、Session 私有 MCP、权限及取消走 Host。保留协议并发请求顺序，取消涵盖尚在创建 Session、设置、观察和提交答复中的请求。默认目录交给统一 resolver，保留 KODAX_HOME。通知失败停止本次 Run 并明确报错；全文分页校验进展和连续性，不把截断当全文。
- 输出扫描发现 API 缓存用量的底层 cachedReadTokens/cachedWriteTokens 与 Client 声明 cacheReadTokens/cacheWriteTokens 不同，已在 Host 显式映射；RED 测试确认原投影丢失公开字段。
- 声明构建抓到新增诊断类重导出会将全部 Runtime Node 类型带入产品入口。移除该非必要新出口，错误类仍留原 `/runtime`；ClientInfo 只提取同一份纯数据声明，保留旧出口。未降低 `types: []`、`skipLibCheck: false` 消费者检查。

### 真实用户 Host 与会话

先只读确认旧 `rt_43c668f1e1e1` / PID 58032 空闲、无其他连接和待答交互；再次验证 owner/lock/processStartIdentity 后，通过正常 shutdown 迁移，确认原进程退出。新 Host 通过公开 observe 读取用户 Session `20260909_075806_ed59a28bf46b46`：76 项，后一轮 query 位于 index 47/48，前项为 assistant，后项为 thinking，没有临时 AMA Worker 提示。已保存的重复输入保持原样，没有按文本清理历史。

随后因最终并发修复产生实际源码变化，使用新的 ensure 调用验证同版本自动更新：`rt_933fb6ca5026` → `rt_2ba1b95353d2`，版本均为 0.7.96-beta.4，指定 Session 保留。这次走普通自动更新，没有手工 stop/force；一次性缺身份旧 Host 迁移与后续自动更新分别验证。

Windows 清理竞态修复并完成最终构建后，再用同一 ensure 将 `rt_2ba1b95353d2` 正常更新为 `rt_3db3cdbd8346`，版本保持 0.7.96-beta.4，最终 source fingerprint 为 `c76f95cac1f26f86389e49fb9f58fcfa0c87098882d689b90131fc6825dea934`。公开 Session view 仍为 76 项，user 索引为 0/1、47/48、74/75，临时 AMA Worker 提示为 0；仅观察并释放本连接，没有提交新输入或改写历史。

### 验证

第一轮全量 1,034 文件：15,019 passed、3 failed、77 skipped、21 todo。并发启动失败是已复现的产品竞态，已修；另外两项涉及压缩及后台学习请求的测试归属，单独核实后处理，不能称为环境漂移。

测试归属修正保留原业务断言：压缩测试按实际压缩请求指令分开统计主请求与摘要请求，分别核对设置；steer 测试为真实后台 learning-review 请求返回合法空审查结果，不把它算成下一次主请求，也不禁用后台学习。第三轮全量 15,032 passed，唯一失败是执行途中新增的 Windows disconnect RED 用例；该轮用于补强竞态证据，不能标为最终全绿。

最终冻结代码门禁记录：

| 验证 | 结果 |
|---|---|
| 完整 `npm test` | 1,034 文件通过、1 文件跳过；15,035 passed、0 failed、77 skipped、21 todo；退出码 0 |
| 完整 build、src/tests typecheck | 通过；真实 `/client` 发布声明消费者保持无 Node ambient types |
| Windows Job/启动进程/owner 退出/真实并发 launcher 定向 | 39/39，通过；其中三个新用例覆盖两种自然退出竞态与断通道但仍存活 |
| 真实并发 launcher 连续复测 | 3 轮均通过 |
| 最终 dist Host 构建更新验收 | 7/7，退出码 0 |
| 最终 dist 真实 Windows PTY | owned Ink 16/16、classic 10/10，退出码 0 |
| 新增构建身份、ACP 投影、产品 SDK 入口模块覆盖率 | statements/lines 99.52%、branches 92%、functions 94.11%；仅这三个模块，不是全仓覆盖率 |

证据：`%TEMP%/kodax-host-contract-full-release.log`、`kodax-host-contract-build-release.log`、`kodax-host-contract-types-release.log`、`kodax-supervisor-fixed-launcher-stress-{1,2,3}.log`、`kodax-host-build-oUPVQd/report.json`、`kodax-repl-acceptance-p47vNd/results.json`、`kodax-host-contract-coverage/coverage-summary.json`。覆盖率运行早于最后的 supervisor 修复，但上述三个被计量模块此后未改动。本轮无 lint script，不虚构 lint 通过记录；未执行真实商业模型任务质量或独立二进制实机验收。

### Standards

独立逐 hunk 复核：硬违反 0；初审两个局部命名建议已修，最终需处理 smell 0。并发退出重试及最终 Windows Job 自然退出修复分别经独立复核通过。

### Spec

初审发现 ACP 默认目录与取消准入窗口两项 P1，均经历 RED→GREEN 并经独立复核关闭。最终本轮修复剩余 finding 0。先前已记录的多 Client 设置反向同步与强制 legacy 搜索仍未关闭，不据本轮门禁宣称整个版本无条件验收通过。未 push、未发布。

## 2026-09-10：统一接口说明书独立复审

审查对象为 `99ad85e3` 的 `CLIENT_CONTRACT.md`，新增文档基线为 `28e47ed971`；历史能力以 `7b1d1ffb`（beta.4 主线）及 FEATURE_298 规格为对照。三名独立子 Agent 分别检查文档事实、历史能力/Spec、抽象边界/Standards，再交叉质询；主 Agent 复读关键传递链。本次不修改产品代码。

**结论更正：71 个域方法的清单与当前 ProductClient 类型相符，但不证明原有产品能力已完整进入这套契约。当前实现统一了业务 Host，产品接口仍有未闭合的业务面和观察/读取出口。说明书可作现状导览，尚不能作为“统一访问、体验不退步”的完整验收规范。** 上一节的构建和回归成绩仍有效；此前针对实现 diff 的零 finding 不能替代本次跨历史能力的复审。

### 已确认问题与最小处理方向

以下行号均对应 `99ad85e3`；历史位置以 `提交:path:行` 表示。

| 编号/优先级 | 问题、证据与实际影响 | 最小处理方向 |
|---|---|---|
| R1 / P1 | **业务面未闭合。** 文档 52–69 列出当前方法，但 CLI 仍通过 `src/kodax_cli.ts:5178–5206` 旁接 Runtime Memory、Learning、注册命令/review/agents lean，通过 5227–5234 调用手动 compact。纯 `KodaXProductClient` 与 adapter 没有这些操作。Spec 334 要求手动压缩、710 要求 Memory list/show/doctor/reviews/remember/forget/approve/reject/rebuild、718 要求注册命令与 review 普通/工作流路径。历史 `7b1d1ffb:packages/repl/src/interactive/commands.ts:596` 已支持带指令压缩；`memory-command.ts:862/876/922/929` 有记忆写入、忘记及精确批准/拒绝；`review-command.ts:306/319/359` 有真实 diff 与 review packet 准备。第二 UI 不能仅凭纯 Client 完成这些动作。 | 投影确有产品消费者的现有业务面；注册命令/review 传名称和参数，由 Host 准备并执行。CLI 也改为消费同一产品契约。现有 Skill 原文 submit 已在 Host prepare，不能因缺少 prepareSkill 方法而再造一条入口；不回传可执行对象或把全部 Runtime 公开。 |
| R2 / P1 | **观察失效对消费者不可见。** 文档 226 承认 `ClientObservation` 仅有 close；类型在 `packages/coding/src/client-contract.ts:206–208`，daemon 的 `src/runtime-daemon/client.ts:1659–1681` 在不可恢复断连后仅关闭观察。空闲页面没有在途 RPC/await，Host 异常退出或传输永久断开时，页面无法得知旧 view 已失效。文档要求调用方显示断连，却没有提供相应事实。 | 在观察结果中暴露一个结束/失效结果或回调，转发现有 transport 生命周期；包含主动关闭与失效的区别即可。无需事件回放、自动恢复执行、重连账本。 |
| R3 / P2 | **有效上下文预算缺失被误归为未来需求。** 文档 183–187 说缺窗口、响应预留、完整阈值。当前 `InkREPL.tsx:2046–2051`、`compaction-info.ts:40–68` 已依赖本地 Provider 与启动快照解析这些信息；纯 `ClientModelCatalog` 只有模型字符串列表，ClientConfig 不含完整 compaction 覆盖，不能据当前接口重算。Spec 266 明确要求上下文预算/压缩结果，858 要求显示信息不退步。 | 由 Host 投影已解析的有效窗口、响应预留、压缩开关/阈值及适用模型，复用现有数据结构；UI 只计算展示比例。区分 Session 覆盖、当前选择与有效配置，不增加新用户配置。 |
| R4 / P2 | **搜索命中无法通过同一契约读取原文。** 文档 212 承认 search hit 是 transcript 索引；`sdk-runtime.ts:8055–8072` 返回该索引，8026–8052 的 history/entry reader 却只接受 conversation 身份；readItem 接受 view itemId。旧 `7b1d1ffb:src/sdk-runtime.test.ts:7628–7643` 已验证搜索压缩前条目后用 revision+entryIndex 读取原文。纯 Client 搜到压缩前命中后不能可靠打开/复制该条全文。 | 返回可读取的稳定命中引用，由现有全文 reader 或一个小型命中 reader 解析，复用 Host 已有 transcript 读取能力。不能用全文匹配或把 transcript 索引当 conversation 下标。此问题不等于所有 Ink 本地搜索都失效。 |
| R5 / P1 | **steer 接受附件身份却丢失实际附件。** 文档 88 与 ClientSubmitInput 未排除 steer 附件。`sdk-runtime.ts:11443–11448` 保留 inputArtifacts，但 `11268–11274` 只构造 text 输入；`11167–11172` 标准化它，`18814–18824` 对 text 产生空附件，`11184–11189` 向执行队列传空附件。同一附件仍参与 `session-input-queue.ts:28–35` 的意图摘要。结果是身份已接收、内容未交付。 | 把附件贯通已有中断输入路径；不能支持时在接收前明确拒绝。优先测试真实执行端收到的附件内容，不能只测 schema 和摘要。不能把静默丢失写成接口限制。 |
| R6 / P2 | **unknown 被错误等同于断连。** 文档 92、时序及 SDK 示例据 unknown 提示重新连接。`sdk-runtime.ts:9182/9512` 会在终态持久化失败或 Actor 结算不确定时返回 unknown，连接可以仍健康；daemon `client.ts:2164` 直接转发 run.await，`transport.ts:331/749` 对断连中的请求执行 reject，并不转换成 unknown。 | unknown 定义为终态无法确认，保留 error 原因；单独处理 Promise rejection 的连接错误。不要以重新连接承诺解决持久化失败，不增加恢复票据。 |
| R7 / P2 | **Run 模型被误写为不可变执行事实。** 文档 118、179 把 runs.provider/model 用作实际执行选择，并称设置变化不会改写。`sdk-runtime.ts:10605–10615` 在活动 Run 收到 Session 设置变化时立即改 record.provider/model，10631 发布更新；4316–4324 直接生成 view。因此模型 A 的物理请求尚在运行时，view 可已经显示 B。 | 更正文档为 Run 当前可变选择，不能当作已发送请求或全部 worker 的模型证据。现有状态栏若显示当前选择应明确命名；不为修正文案建立请求级账本。 |
| R8 / P2 | **输入生命周期与多对一身份说明不完整。** `sdk-runtime.ts:11089–11119` 将多条 after_turn 合批，11001–11007 只给合并 user 项首个 inputId，其他身份存内部 inputIds；`message-utils.ts:531–532` 仅投影单数 inputId。文档 194 的逐项乐观确认建议不充分。此外普通 stop/failed 不自动 drain（8947–8963）；steer 返回 queued 但不在可撤回 view.queue 中（11281、`session-input-queue.ts:94–102/124–143/178–184`）。 | 文档增加 delivery 行为表和多 Input 对一 user 项关系。先利用现有 inputs.read 确认各已知 ID 的 submitted/runId；若 UI 确需逐展示项关联全部输入，再投影已有 inputIds。说明 stop/failed 后队列保留、steer 不可 withdraw，不能从 view.queue 为空推断全部已投递；不按全文去重。 |

### Standards

独立报告：纯类型依赖边界成立。发现文档对 Run 模型的事实错述；观察失效缺口为 P1；有效 compaction 仍由 UI 私有解析为 P2 抽象边界问题。后两项是有实际消费场景的判断性缺口，不以 Fowler 标签作为硬性加抽象依据。icon、compactText、breadcrumb 是合理共享展示投影，不应仅因格式化而删除。

本轴 3 项可行动发现，最高 P1。与其他轴重复的问题仅在上表保留一次，独立报告计数不作相加。

### Spec

独立报告：P1 业务面未闭合，对应规格的手动 compact、Memory、注册命令/review 保留要求；P2 搜索命中到原文的链路缺失；P2 有效上下文预算缺失。Skill 文本提交已经实现，不列为缺项；旧 Runtime 的全部服务不应自动升级成产品承诺。

本轴 3 项发现，最高 P1。详细历史动作与原文依据见上表 R1/R3/R4。

### 事实核对与验证边界

文档事实轴另核实 R5/R6/R7/R8。现有两个测试经过定向重跑：终态保存失败仍返回 unknown、关闭 transport 后 pending 请求 reject，**2 passed、306 未匹配而跳过**；这不是新一轮全量回归。steer 附件为完整可达静态传递链结论，尚未在本轮新增执行探针；原有合批及 stop 后保留队列测试提供 R8 行为证据。

没有把以下候选升级成确定缺陷：任意同 ID 等长正文替换造成混页（缺少充分真实触发证据）、退出时 owned-resource 清理、全部附件类型支持情况。这些需要专项验证。ACP 全文 reader 的 ID/跨页长度校验差异也是后续定向验证点，不能据合成坏页就宣称正常 Host 已产生错页。

### 建议的收敛顺序

1. 先修 R5 的静默附件丢失，以及 R6/R7/R8 的错误消费说明。
2. 以当前纯 Client 为唯一产品入口补齐 R1/R2/R3/R4；复用已有 Host 业务实现，保持启动器/进程诊断的低层边界，不公开整个 Runtime。
3. 用纯 Client 类型编写“立即压缩、命令/review、记忆精确批准、断连可见、压缩历史命中全文、有效窗口、带附件 steer、合批确认”行为验收，再让 CLI 绑定接受同一 ProductClient。把需要 Runtime 旁路才能通过的产品验收视为尚未完成。
4. 最后同步说明书：区分稳定契约、当前实现行为、未完成缺口及有意不承诺的能力。没有依据要求恢复递归执行、批准回流、通用 mutation 回执、退出恢复票据或事件回放框架。

## 2026-09-12：统一契约最小收敛方案与主线回归边界

**后续 Host 对照补充：** [HOST_ARCHITECTURE_REVIEW.md](HOST_ARCHITECTURE_REVIEW.md) 对 Codex、deepseek-harness、pi 的实际源码进行独立研究与交叉复核。确认 Skill 动态准备早于输入/Run 准入保存，且准备方法的观察/取消/draining 分类与真实执行不一致；另确认工具结构化结果在显示事件中丢失。以下方案不作废，但实施顺序调整为先闭合这些 Host 边界，再补产品接口；具体顺序、手动草稿及无 LLM 命令保护见该报告。

本节是方案复核，不是修复完成记录。基线为 `f43f149a`，三名子 Agent 分别复查业务入口、输出与读取、Bash/sandbox 回归边界，并交叉讨论准备阶段的副作用与输入身份。主 Agent 核对关键源码后作以下取舍；本轮没有修改产品代码、运行验收、重启用户 Host 或合并分支。

### 分支与已合入工作

当前仍为 `codex/product-client-refactor`，没有合回 `KodaX`。本地 `KodaX` 及已抓取的 `origin/KodaX` 都在 `6886f96f`，`KodaX...HEAD` 的主线独有/当前分支独有提交数为 **0 / 179**。因此是独立开发分支，但当前提交关系不是双向分叉：本分支包含上述主线的全部提交，包括 beta.5–beta.8。此次没有 fetch，不据此判断远端是否又有新提交。

主仓库另有未提交的 `src/sdk-conversation-history.test.ts` 改动，不在已合入提交范围内。features 子模块处于同名开发分支，HEAD 为 `dc1e54f`。本工作树原有的本报告修改继续保留。

`31b3aed1` 已补重订阅重试、连接代次隔离、旧快照清除及显示身份修复，方案复用它们。前述 R2 剩余缺口是向产品消费者公开观察失效，不是再造重连系统。R8 所需逐 inputId 查询已在 Ink 的队列消费链中实现，主要补说明与行为验证，不预先增加 `inputIds` 展示字段。

### 设计取舍：统一业务事实，不统一成万能操作

产品客户端继续只有一套 `KodaXProductClient`；CLI、SDK 和未来 Web 使用相同业务意图与输出事实。Node 启动器负责启动/更新，被动连接不承担更新；浏览器 transport 仍不是本次新增目标。

1. **复用已有领域服务。** 手动压缩、Memory、Learning、注册命令、review 等已有产品能力补到纯 Client，Host 执行，CLI 移除对应 Runtime 旁路。只开放已有用户动作需要的方法，不将整个 Runtime、Controller、执行函数或可信权限对象导出。
2. **保留 Input 的含义。** 普通输入和现有 delivery 继续使用 inputId、现有队列与 Run。注册命令及 review 使用具体业务接口；手动草稿、空结果、领域失败不强行转换为用户输入。暂不采用把所有业务操作塞进 Input 并增加 `preparing/handled` 通用状态的方案，也不新增通用操作账本。
3. **承认副作用的不确定性。** 连接恢复只重开观察，不重放提交、命令、hook、review 或 Memory 修改。已有 Run 可承载的准备/执行优先归入其生命周期；不能绑定已有 Run 的领域操作保留具体结果和错误，丢失回复不能冒充未执行或成功。此处不承诺跨 Host 重启的 exactly-once。
4. **准备窗口必须验证，不能用原则代替修复。** 当前即时 Skill 在 `prepareSkillInput` 后才 `startRun`，准备可能先执行动态上下文。重复相同 inputId 是否再次产生副作用，需要失败注入验证。若已产生副作用但尚无 Run 接受事实，不可盲目重提。优先调整现有 Run 内的执行顺序；只有具体用例证明现有生命周期不足，才补局部领域事实，不先扩大全部 Input 状态。

### R1：补齐已有业务面，保留原交互

以下是能力分组，新增方法最终以纯类型及实际调用点为准，不将候选命名视为已实现 API。

| 能力 | 最小产品边界 | 必须保留的行为 |
| --- | --- | --- |
| 手动 compact | Session 域调用已有压缩服务，接受现有自定义指令 | 运行准入、失败结果及压缩后视图保持统一 |
| Memory | 公开现有 refs/inbox/proposal/reviews/status、remember/forget/approve/reject/rebuild 等所需查询与操作 | Host 校验项目归属；精确 fingerprint/revision；过期批准冲突；doctor/open 等原命令仍可用，本地编辑器由 UI 打开 |
| Learning | 复用现有快照、记录查询、订阅和具体治理动作 | acknowledge/snooze 等原作用域不扩大；不暴露内部授权构造；不并列增加重复事件流 |
| 注册 prompt/extension 命令 | 传注册名称及参数，Host 从受信任注册表解析并执行 | 参数、model、allowedTools、hooks、fork、manual 等现有行为；不把所有内置 slash 命令塞进字符串分发器 |
| review、agents lean | 复用已有 git 捕获、packet 准备和普通/工作流执行路径 | Host 保存准备产物，沿用写权限；取消和错误清楚可见；不把可信准备对象交给 UI 后再回传执行 |
| 手动 prompt 草稿 | 返回可编辑的纯文本及必要标题，用户确认后按普通输入提交 | 不自动发模型，不从草稿携带 hooks 或权限升级；后续主动执行注册命令仍由 Host 重新解析 |

Skill 原文提交已在 Host 准备，不为“方法看起来齐全”再公开一套 prepareSkill。注册 extension 的实际 handler 仍在 UI 的残留必须迁移，不能仅转发现有 `prepareCommand` 就宣称 R1 完成。

### R2–R8：输出与身份的最小补充

| 项目 | 选定方案 | 不应引入的额外机制 |
| --- | --- | --- |
| R2 观察失效 | 现有 observe 增加状态回调：`live`、`interrupted`、`closed`；closed 区分主动关闭与不可用。首次建立失败仍 reject。只有完整新 view 已交付才恢复 live；重订阅耗尽明确关闭。 | 不新增连接 owner、第二套重试、事件回放或执行恢复。UI 保留正文/草稿但标明旧状态；本地弹窗等待结束不等于向 Host 回答取消。 |
| R3 有效预算 | 在现有 Session view 投影 Host 解析后的模型、窗口、响应预留及压缩阈值，复用现有预算/压缩策略。 | 不新增压缩开关或独立预算服务。当前压缩常开，不能照旧方案增加可写 enabled。 |
| R4 搜索全文 | search hit 提供不透明 itemId；现有 history entry reader 按身份命名空间读取 transcript，复用已有 revision/快照和正文分页。 | 不把 transcript index 当 conversation index；不新增随机读取索引、租约或全文匹配身份。快照失效明确要求重新搜索。 |
| R5 steer 附件 | 将 inputArtifacts 贯通现有中断输入及实际 Provider 请求；不支持的附件在接受前明确拒绝。 | 不把附件路径/OCR 文本冒充原附件；不只修 digest/schema 而遗漏执行内容。 |
| R6 unknown | 更正为终态无法确认，保留原因；连接错误的 Promise rejection 单独处理。 | 不把 unknown 等同断连，也不承诺重连解决保存失败。 |
| R7 Run 模型 | 明确 provider/model 是 Run 当前可变选择，不是每次物理请求的历史凭证。 | 不为了改正文案建立请求级账本。 |
| R8 合批身份 | 记录多 inputId 可对应一个 user 展示项和 Run；复用 inputs.read 确认每个已知 ID。普通 stop/failed 保留队列；steer 不在可撤回队列。 | 不按文本去重、不由 queue 为空推断全部已投递、不无条件扩展展示字段。 |

R3 的预算还需区分已解析配置和实际执行容量：Memory evidence reserve、provider/system/tool envelope 会影响可用空间。Host 有实际事实时才提供最终触发容量；UI 不自行用窗口减最大输出冒充精确预算。worker 的用量只可与相同 scope 的预算计算比例，匹配预算未知时显示数量及归属，不除以父 Session 的窗口。跨客户端设置变化必须刷新同一 view，不能继续显示启动时的私有快照。

### Bash、sandbox、权限与主线修复的保护条件

- 新业务入口继续走既有 Host Session 准入、实时权限、Bash 工具及沙箱执行链。动态上下文没有受控 executor 时保持禁用，不恢复 execSync 直连；Plan 限制仍生效，不能统一粗暴改成只有 FullAccess 才能使用。
- 沙箱失败后的 Host 执行仅允许沿用既有“可证明尚未开始”的条件及明确批准。已开始或是否开始不明时不重跑；批准后不循环回退。此次不重写 Bash 分类器、shell 拼接、批准或 sandbox fallback。
- review 捕获/packet 准备涉及写入，不能因名称含 prepare 降为只读权限。Memory 的精确批准保留 fingerprint/revision，客户端提供的权限 metadata 不构成授权。
- 继续覆盖 beta.5 的 Windows 沙箱 profile/SSH ACL 修复与 setup generation 11：只处理自身权限项，不触及其他主体或所有者，不追随重解析点扩大写域。
- 保留主线已合入的 Provider 缓存统计、typed multimodal tool result 和 interrupt identity/legacy alias 确认行为。输入身份确认不构成工具权限提升。

### 实现顺序与可判定验收

1. **输入完整性与事实说明：R5、R6/R7/R8。** 先写真实 Host → 离线 Provider 探针，检查 steer 附件内容、inputId、同 ID 冲突及不支持时零接受；补合批三个输入逐 ID submitted、stop 留队验证。同步修正文档事实。
2. **观察与读取：R2、R4。** 空闲永久断连也通知关闭；临时中断经既有重订阅后交付新 view 才恢复；旧代次不能覆盖；主动 close 不报失联。压缩前长正文经 search hit 完整读取/复制；相同数字 index 不串源，过期引用明确失败。
3. **有效预算与设置同步：R3。** 两客户端修改模型/窗口/阈值后得到一致 view；覆盖默认模型、用户窗口覆盖、Memory 预留、worker scope 和未知预算。CLI 状态栏消费这份事实，再删除重复预算解析。
4. **逐业务迁移：R1。** compact → Memory/Learning → 注册命令/review/agents lean；每个切片先以纯 ProductClient 在真实 daemon 上完成原动作，再替换 CLI 旁路。手动编辑、fork、工作流、hooks、取消和失败均有行为对照，不以方法存在作为完成标准。
5. **副作用与安全回归。** 注入 review packet 已写但回复丢失、hook 已执行而启动失败、Run 已接受但确认丢失、观察重连四个场景，核对实际执行次数和错误/不确定结果；另验过期 Memory 批准、只读身份 review 零写入、实时权限变化及 sandbox 已开始后断连不重跑。准备窗口问题在此闭合前不能宣称安全验收通过。
6. **端到端门禁与说明书同步。** build、无 Node ambient types 的发布声明消费者、相关 Runtime/权限/沙箱套件及完整测试通过后，执行真实 Windows PTY：resume 用户 query、临时 AMA 提示、工具正文/状态栏、Ctrl+O/Ctrl+E、搜索/取消/复制、缩放后页脚无残留。保留之前已记录的多 Client 设置同步及强制 legacy 搜索问题，逐项有证据才能关闭。

现有定向测试优先扩展 `sdk-runtime.test.ts`、`sdk-invocations.test.ts`、`sdk-client.permissions.test.ts`、`runtime-daemon/client.resubscribe.test.ts`、`sdk-runtime.memory.test.ts`、`standalone-shell-boundary.test.ts`、`sandbox-runtime.test.ts` 及 identity 相关套件。测试必须穿过被修改的公开契约和实际消费链，避免只验证 mock 返回同一字段。最后在 [CLIENT_CONTRACT.md](CLIENT_CONTRACT.md) 区分已实现行为、稳定保证和明确限制；未完成项不能提前写成产品承诺。

## 2026-09-12：Host 与统一产品接口实施及验收

本节记录用户批准后的实际实施，基线为 `f43f149a`；上面的审查和方案保留为修改前证据。H1–H5 与 R1–R8 的实现说明见 [Host 审查的实施记录](HOST_ARCHITECTURE_REVIEW.md#实施记录2026-09-12以上审查保留为修改前证据)，对外接口以 [CLIENT_CONTRACT.md](CLIENT_CONTRACT.md) 为准。

### 本次闭合的执行与消费链

- Skill 元数据读取与动态执行分开。先接受、保存输入并建立 Run，才执行动态准备；取消、关闭及工具收尾沿既有生命周期完成，保存失败和忙时拒绝不会先执行动态工具。
- CLI 交互、单次输入、Session/Goal/Workflow、Auto 诊断、compact、Memory、Learning、注册命令、review 和 agents lean 使用 ProductClient 的现有领域划分。单次 CLI 的流式格式转换保留只读进度适配，不再负责准备、提交或结算。
- 注册命令保留 alias、help、Tab、原忙时限制及与同名 Skill 的优先级。没有输出的命令不制造 user/模型轮次；命令已启动的 Run 由 UI 跟随。真实 IPC 在 handler 已写文件后断开回复连接，第二客户端继续观察原 Run，验证 handler 和模型均只执行一次。
- 工具结构化结果贯通实时显示及历史；当前配置预算与实际执行预算按 scope/contextId 区分。观察中断明确可见，恢复新快照前不清除草稿或代用户回答交互。搜索命中可由同一全文 reader 读取。
- 两客户端设置同步覆盖显式设置、清除覆盖后继承 profile、没有 profile 默认三种情况。UI 显示 Host 的有效设置；未指定权限显示 `Host default`，不凭空构造执行权限，也不把显示默认值写回 Host。

### 真实终端验收中追加修复

1. **取消等待的竞态。** 下一 Run 已显示时，上一 Run 的 await 回复可能仍在传递。按键时冻结当前显示的 Run 身份，stop 和 await 只针对该身份；拒绝或迟到回复不能追停其他 Run。尚未准入时只撤回自身输入。失败结果优先于残留的 result，不能显示为成功。
2. **中断后的 query/partial 排序。** 在较长历史中，未完成回答可能被显示检查点放到自己的 query 之前。复用已证明的 inputId，在输出开始时记录 `afterInputId`；Host 合并及恢复按身份放置 partial，客户端直接消费 Host 顺序，不按文字或时间猜测。
3. **同一 Run 的 steer。** steer 已交付后，新 segment/tool 捕获新输入来源；旧 segment、迟到 delta/toolResult 保留原来源。真实 IPC 覆盖 steer → partial → stop → 关闭 Host → 新 Host 恢复。没有已知来源时保持未知，不在后续更新中补猜。

验收脚本也更正了两处测试假设：110 列状态栏会正常折行，应在宽屏核对设置并另测窄屏；原有停止手势是双 Esc，不能把单 Esc 无动作判为产品缺陷。脚本继续测试原快捷键，不修改产品手势迎合验收。

### 门禁与验证边界

| 门禁 | 结果与证据 |
| --- | --- |
| 最终 `npm run build` | 通过，包括原生组件、14 个 SDK 声明及不依赖 Node ambient types 的真实 `/client` 类型消费者。日志 `.verified-build.log`。 |
| 最终 `npm run typecheck` | src 和 tests 均通过。日志 `.verified-typecheck.log`。仓库没有 lint script，另执行 `git diff --check`。 |
| 最终构建的 Windows PTY | **32/32 通过：Ink 19、classic 13**。覆盖 query/resume、AMA 提示、工具显示、设置同步、交互、排队撤回、transcript 冻结/搜索/快捷键/控制字符重绘、中断排序、命令续跑停止及新 Session 隔离。日志 `.verified-pty.log`；临时产物目录 `kodax-repl-acceptance-LPDbgJ`。 |
| Host 构建身份与更新 | **7/7 通过**，在最后的 steer 来源锚增量之前运行；该增量不改启动/更新链。覆盖空闲更新、连接观察者时拒绝替换、旧 launcher、普通 CLI 及唯一写入所有者。冻结 dist 副本以合法 JS 注释模拟文件字节替换，不宣称执行了第二次编译。日志 `.verified-host-build.log`；临时产物目录 `kodax-host-build-wj9qgD`。 |
| 最终完整离线 Vitest | **1,056 文件通过、1 文件跳过；15,560 passed、77 skipped、21 todo；0 failed、0 unhandled errors**。运行 666.31 秒，exit 0。包括 src、全部 workspace 与默认离线 tests/benchmark harness 自测，不调用付费模型。日志 `.verified-full.log`。 |

开发中曾有一轮全套测试跨越源码/构建修改且继承外层 `KODAX_HOME`，出现 50 项失败；该次结果不作为最终门禁，也不笼统归因于环境。首次冻结全套为 15,536 passed、23 failed、77 skipped、21 todo，另有一个 Vitest `onTaskUpdate` RPC 超时；日志保留为 `.verified-full-first.log`。逐项排查结果：

- 20 项权限断言：验收 HOME 放在系统 Temp，测试用 HOME 构建的“非 Temp 路径”实际落入临时目录豁免。改用 Temp 外的专用 HOME；权限分析 968 项对照全部通过，不修改生产权限规则。
- 1 项 NUL ACE 断言：FNM 的 Node 链接路径与生产代码的真实路径不同；原 HOME 通过、Temp HOME 失败、相同隔离 HOME 配合真实 Node 可执行路径通过。最终使用 canonical Node，不改变 native 路径保护。
- 1 项 config daemon 清理：测试只等状态文件消失就删除目录，进程仍在写退出 outcome/log。单项定向重现，改用已有精确 owner 与 shutdown outcome verifier 后再清理，不加 sleep 或删除重试。
- 1 项 extension 工具列表：上一持久化用例的后台 Learning review 混入静态前景调用统计；落盘 review 的 provider、objective 和时间确认其身份。测试 fixture 应答合法 review，并等待既有 review drain 后再清理；保留前景调用次数和工具列表断言。

最终运行固定构建，移除外层 `KODAX_HOME`，使用系统 Temp 外的专用 HOME/USERPROFILE 与真实 Node 路径。上述失败在最终完整套件中均通过，Vitest RPC 超时也未复现；没有跳过失败用例或放宽业务断言。最后两项改动仅为测试修复，因此继续使用已通过 build/PTY 的相同生产构建，另重跑 src/tests typecheck 通过。PTY 与 Host 构建验收也使用独立临时配置和离线 Provider，不使用用户 API key 或会话。

独立评审固定在同一基线至冻结工作树的 diff，评审者不参与相应修复：

#### Standards

硬违反 0；可行动 smell 0。复用现有身份、生命周期及领域服务；没有新增恢复 owner、操作账本、追停状态机、shell backend 或 sandbox fallback。评审建议的 metadata 命名与 getter 单一形式已落实。最后两项测试清理增量另经复查，仍为 0；后台 drain 仅证明等待结束，不独自证明 review 业务成功。

#### Spec

发现 0；此前业务旁路、设置同步和同 Run steer 来源锚问题已关闭。最后两项测试增量未修改生产行为、未删除或放宽原前景断言，独立复查仍为 0。该独立结论来自源码及测试接缝核验；实际构建、完整回归和 PTY 由主 Agent 执行，分别记录，不把静态评审当作运行验收。

仍保留明确边界：强制 legacy renderer 的历史搜索跳转问题见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)，不由默认 owned renderer 验收豁免；缺少可证明来源的旧历史不按文本自动修复；未来 Web transport、远程认证、多租户隔离未实现。本轮使用离线 Provider，不认证商业模型回答质量，未做 macOS/Linux 实机及 Electron GUI 验收，也未重新测量覆盖率。用户原有 Host/session 没有重启或改写，没有推送、发布或版本号变更。

## 2026-09-12：长会话空白、工具分组与队列交付时机复查

用户实际使用再次暴露了此前验收缺口。上节 15,560 项通过仅属于当时快照，不能证明本节行为正确：短会话、单条长文本、展开全文，以及队列撤回/整轮结束后续跑，都没有覆盖本次失败条件。

### 已复现的原因

1. **Host 预览预算让旧正文变空。** `session.view` 保留最近 150 项，却从最新项向前分配 131,072 个 UTF-16 码元。多个长结果耗尽预算后，较早的 query、Thinking、assistant 正文及工具参数被截成空串，标题与身份仍存在。只读检查用户 Session 时，原 query 长 21，view 长 0；12 个原本非空字段预览为空，全文 reader 仍有内容。这是统一输出投影的问题，SDK 同样能观察到，不能归因为终端或旧 Host。观察时该 Run 仍在执行、尚无 assistant 项；该次观察不能证明模型已给出正式回答却被丢弃。
2. **保留工具业务身份后遗漏展示分组。** 每个 Host 工具项映射成独立 UI 工具组，原有合并算法只作用于单组，导致每次调用各有 Tools 标题。修复仅合并相邻展示段，保留原 itemId 和全文读取身份。独立复查进一步发现：合并后搜索非首项不能只定位段首；须核对目标工具行的实际可见性，以及同摘要折叠成员的展开/复制身份。
3. **可撤回队列失去下一次模型调用前的交付点。** 旧版 SA/AMA 在工具完成后的安全点消费输入；当前 Host 的普通队列仅在整个 Run 结束后 drain。真实 IPC 和 Windows PTY 均复现：原 Run 的第二次 Provider 请求已到达，排队文字出现次数仍为 0，Host 队列仍保留该输入。用户要求的是下一次模型沟通及时包含输入，不能用终态后新 Run 能消费来代替。

### 本轮验收接缝

- `session-view.preview.test.ts`：多项长输出和完整 150 项窗口下，各保留正文/工具参数仍有可读预览，预算不增加，原文 reader 和 suffix offset 保持一致。
- 实际用户 Session 的被动读取加本地无写入投影：旧 query 0 → 修正投影 21，合计仍为 131,072；不重跑用户任务，不改写会话。
- `client-plane.test.ts`、transcript 布局/滚动及 row memo：实际 UI section 路径的相邻工具合并、非首成员搜索定位、展开和复制。
- `sdk-client.queue-boundary.test.ts`：真实 ProductClient/IPC 到受控 Provider，覆盖 SA/AMA 下交付时机、输入身份、附件、撤回及去重。
- `repl-pty-acceptance.mjs`：真实键盘排队并检查下一次 Provider 请求；多批工具结果填满预算后在普通 live 界面重绘检查早期内容。`--source` 走 `npm run dev` 的源码入口，不能用展开全文掩盖普通预览空白。

### 修复范围

Host 在现有预览总预算内先为每个保留字段预留可读片段，再将剩余额度分给近期内容；不扩大协议负载预算或把全文塞回 view。工具合并只在 UI 布局层发生，长段定位与折叠成员读取均保留原身份。

普通队列通过既有 `interruptInput` 执行边界进入 SA/AMA，正文仍由唯一 `SessionInputQueue` 持有。Host 与 withdraw 共用 Session 操作锁，在成功保存后提交原队列批次；没有第二套执行队列或 claim/ack 账本。canonical 保存后的可抛通知在队列提交后执行，不能因通知异常将已保存输入误留队。steer 与普通输入在同一安全点依次交付，后续输出来源跟随最后已交付输入；旧工具的迟到结果仍保留原来源。

排队 Skill 保留可信准备和顺序屏障；停止、失败或没有下一执行额度时保留尚未交付的普通队列。SA 使用原有绝对迭代额度，AMA 复用 Runner 原有许可判断，不增加无限续跑。fork 保留原来的中断窗口控制，仅禁止它消费所属 Session 的普通队列。没有修改 Bash 执行、sandbox 选择或权限批准路径。

### 验证记录

长会话实际 Windows PTY 的旧构建复现目录为 `kodax-repl-acceptance-HH3jwH`：早期正文/参数在普通界面重绘后为空，全文 reader 仍能读出。队列实际 PTY 的旧构建复现目录为 `kodax-repl-acceptance-JbQtXK`：第二次 Provider 请求中的排队文字计数为 0，原 Run 仍 running、队列未清除。两者均为真实失败信号，不以“进程能启动”代替。

本轮冻结构建和类型检查已通过。源码长会话 PTY 已通过（`kodax-repl-acceptance-kYyrKq`），预算饱和后 query、Thinking、已发出的正式回答与旧 Bash 参数仍可见，相邻批次共 9 个工具标题。初次全交互源码 PTY 在命令续答检查失败（`kodax-repl-acceptance-mF5GfF`）：续答已经在原 Run 流式显示，测试却仍等待与原 Run 不同的 ID。已按本次交付语义改为检查原 inputId 接收记录、原 Run 仍 running、队列消失，再双 Esc 验证该 Run interrupted；保留命令 handler 仅执行一次及后续输入验证，不修改产品迎合旧断言。失败清理时的 node-pty `AttachConsole failed` 来自库的异步清理，不是这次超时的原因。

独立 SA 迭代上限测试 2/2 通过：前 8 个输入各在下一请求出现，既有绝对上限的第 9 个待交付输入保持排队且未写入正文。该项在补齐 guard 后验证，不能宣称已经取得单独的生产 RED。

#### Standards

硬违反 0；可行动 smell 0。复用现有 Session 锁、执行边界、持久化和输入身份，没有新队列 owner、恢复状态机、shell backend 或 sandbox fallback。根 Agent 另核新增测试没有把“找不到输入”的 index=-1 当成顺序通过。

#### Spec

最终发现 0。长工具段非首项定位、同点 steer/普通输入交付、SA 最后执行额度与 fork 原中断窗口控制均已复查。曾提出的 dequeue 并发删除疑虑经读取既有 predicate 实现后撤回：它捕获固定输入 ID 集合，后来输入不匹配，无需额外逐 ID 删除补丁。

首轮冻结全套为 **1,058 文件通过、2 文件失败、1 文件跳过；15,579 passed、2 failed、77 skipped、21 todo**（714.90 秒，`.regression-full.log`）。两个失败均逐项复核：

- `sdk-client.queue.test.ts` 仍要求最后一条 user 消息是带分隔符的整批文字。旧版 `6886f96f` 的 SA 安全点本来就逐 queued 输入保留 message；分隔符合并属于终态后新 Run 路径，本次未删除该路径。设计要求同批及时交付，没有规定只能一条 user。测试改为第二次 Provider 请求中 second/third 全文、inputId、顺序及次数完全匹配，两条 receipt 指向原 Run；保留模型 a→b 生效、撤回、去重和请求次数断言。
- 新增 AMA 顺序强断言在首个 partial 帧找不到 query。仅通过已有观察器、保持第二次 Provider 请求暂停，测得 firstPartialInputIndex=-1 后 **100ms 自然收敛**到用户项 index 2 且先于 partial；没有额外 read、新输入或释放 Provider 触发刷新。这是既有 80ms 异步刷新窗口，不是持续丢失。测试改为有界等待正文与顺序同时成立，仍强制 index≥0 和完整原文，不增加生产事务或恢复补丁。最初缺少诊断的探针被清理异常掩盖，不能当作长期缺失证据。

上述断言修正后，队列/steer/迭代上限定向 **5 文件 25/25 通过**（`.regression-queue-final.log`），生产构建未变。最终全交互 PTY 增强为真实 AMA 排队后在普通界面看到 query 整行，SA 注册命令续答场景另行保留。

第二轮完整测试仍有两处失败，不能把它们归为环境问题。并发 launcher 的两份真实 preflight 均只有两个临时 launcher 连接，Run、任务、权限与队列全部空闲；三个短退避回合仍互相触发 `connected_clients`。保留该保护，改为在原始启动截止时间内先释放临时连接、有限退避并重探测，竞争等待不消耗实际升级次数上限。没有新锁、选举、持久票据或客户端名称豁免。真实 IPC 测试固定制造四轮碰撞（八份 Host 快照），修后连接同一新 owner，旧进程正常退出、原 Session 保留；升级定向 33/33 通过，另覆盖期限耗尽、取消及 shutdown 后无法确认退出，不启动第二 owner。

另一处是 `readLineage` 与 Host 自有显示 checkpoint 争用 Session 写锁。最初怀疑后台 Learning，受控写入堆栈已排除：持锁者为 `SessionViewOwner.save → mutateUiHistory`。历史 capture 已等待这个 checkpoint，lineage、派生与设置读却遗漏，且 IPC 准入还会先调用 `sessions.load`。因此没有让测试先读一次历史来掩盖差异，而是给 load、lineage、fork、recover、settings 及 auto stats 接入既有 flush（load 保留原读取预算，stats 复用 settings），保留准入、idle、owner、revision 和外部写入检查。真实 IPC 回归 **15/15**（`.derive-final-green.log`）：六个入口等待自身 checkpoint、六个入口传播保存失败、外部写锁仍报 data_changed，以及原 fork/recover 用例。多个受控入口在接线前确实 RED；最后增量 Standards、Spec 分别为 0 项发现。

| 最终门禁 | 结果 |
| --- | --- |
| `npm run build` | 最后竞态修复后重新通过；SDK 声明及无 Node ambient types 的纯 Client 消费者通过，`.regression-build-final.log`。 |
| `npm run typecheck` | 最后竞态修复后 src/tests 均通过，`.regression-typecheck-complete.log`；`git diff --check` 通过。 |
| 源码长会话 PTY | 最后竞态修复后 startup、预算饱和普通显示、正常退出 **3/3**，`kodax-repl-acceptance-Sj3Lbq`，`.regression-long-pty-complete.log`。 |
| 源码入口完整 PTY | 最后竞态修复后 **33/33：Ink 20、classic 13**，`kodax-repl-acceptance-8Zxv0v`，`.regression-source-pty-complete.log`。 |
| 打包入口完整 PTY | 最后竞态修复后 **33/33：Ink 20、classic 13**，`kodax-repl-acceptance-d6vyOW`，`.regression-built-pty-complete.log`。 |
| 最后修复后的完整 Vitest | **1,060 文件通过、1 文件跳过；15,596 passed、77 skipped、21 todo，零失败**；719.72 秒，exit 0，`.regression-full-complete.log`。第二轮的两个失败均已修复并在本轮通过。 |

以上 PTY 结果均核对 `results.json` 的通过/失败计数及进程 exit 0。源码与打包入口分别验收，不以一个入口替代另一个；不把启动、退出与单元测试数相加冒充功能覆盖率。最后生产增量经独立 Standards、Spec 复查，各为 0 项发现，随后冻结生产代码，重新构建、类型检查、完整 Vitest 与三组 PTY 均通过。临时诊断和专用验证 HOME 已清理，用户原有 Host/Session 未重启或改写；本节不豁免上节记录的强制 legacy renderer 搜索、跨平台实机和覆盖率等验收边界。

## 2026-09-12：GLM 扫描报告的当前快照复核

本节只复核报告，没有修改产品代码或正式测试。固定实现 `2c6cbffb`；本地主分支 `c61914bf`（12:52 的 FEATURE_299），共同基线 `6886f96f`。当前提交关系为主线独有 1 / 本分支独有 181，未 fetch、未合并。三路只读复核分别检查显示链、命令/计划交互和执行/one-shot，主 Agent 核对历史状态及队列产物。

| GLM 项目 | 当前判断 | 核验依据与最小处理方向 |
| --- | --- | --- |
| A Todo、children、AMA 后台条、cost、模型 workflow | **存在实质遗漏**，但不能全部归为 Ink 没消费 | `session-view.ts:301/353/383` 已投 cost/children/todos；Ink 的对应面板与 `/cost` 仍依赖旧本地 refs/state（`InkREPL.tsx:2286/2437/4178/10641`），plane 分支绕过其更新。AMA 后台条还缺旧展示必需的 childFanoutClass；模型 `run_workflow` 的进度只到 workflow 事件域、digest 只到外部 callback（`sdk-runtime.ts:18770/18777`），未进入对应产品展示链。应复用已有面板和 workflow 订阅，补事实及接线。AMA 主状态栏和显式 `/workflow` 已有消费，不能称全部失效。 |
| B UI idle、Host busy | **存在 UI 事实消费缺口**；Host 忙时保护仍正确 | `InkREPL.tsx:1830–1838` observe 更新 view/history，却不更新本地 isLoading；输入提示及提交分支仍读该状态（3754/9638）。重新挂接或另一 Client 启动同 Session 可显示 idle；后继 Run 晚于 `client-plane.ts:300–309` 的 600ms 观察窗也有同类条件窗口，尚未复现 GLM 所指具体自动续跑时序。Host-only 命令帮助另被放在 idle gate 内。应消费 Host 活跃事实、分开帮助读取与执行；不能删除 review/compact/goal 修改的 busy 保护。 |
| C `/mcp`、`/extensions` 不可用 | **成立** | `commands.ts:844/1003` 仍读客户端本地 extension runtime，旧默认 CLI 的初始化已迁到 Host。MCP 已有 ProductClient face（`client-runtime-adapter.ts:188`），需接消费者；扩展诊断须承接 Host 的现有注册事实，不能在 CLI 再建 runtime。 |
| D `!command` 回退直连 exec | **当前与新主线有差异，回归归因错误** | 当前 `shell-executor.ts` 与共同基线完全相同；主分支 FEATURE_299 才新增 owner callback/bash 工具轮。本版原设计 344 仍描述本地只读捷径。将其列为待合入主线能力和合并保护项，不能把它算成本轮删除旧实现；合并时应保持新主线执行、权限、记录语义。 |
| E one-shot | **需拆开判断** | busy immediate 在 `sdk-runtime.ts:10934` 已直接 conflict，并非先接受后丢 runId；现契约明确此边界，主线本身会排队，也非无限制直跑。无交互审批等待则成立：旧默认 CLI 立即拒绝，当前 `run-progress-events.ts:381` 不应答，one-shot 只 await；确需人工、无人回答/停止且未覆盖超时时会等默认五分钟。应明确无交互处理，不能自动放行或修改全局权限。 |
| F 计划批准正文 | **能力承接不足，比单一正文映射更深** | inputPreview 已投射，但 Ink/classic 将其包装为 input 字段，旧确认渲染器读取 plan（`tool-confirmation.ts:225`）。上游 `sdk-runtime.ts:13088/13280` 还因没有 exitPlanMode callback 隐藏官方工具；旧默认入口有真实批准处理。需要把计划审批与正文承接到已有 Host Interaction，并由 Host 改模式；仅解析截断 preview 不足以修复。 |
| G 队列两路径竞争 | **当前证据不足，不能确认为仍存竞态** | 两份 GLM 产物生成于 12:38/13:01，跨越修复过程，未记录可比的构建身份。当前明确存在 `consumePendingInputs → SessionInputQueue.consumePlainBatch` 的 SA/AMA 交付链，不再是找不到路径。当前固定构建下的重复结果见下文。 |

### Standards

D 的回归归因不成立；E 的无交互审批等待是一个已确认行为风险。未发现需要增加锁、升级选举或第二执行器的理由。此轴确认 1 组当前行为问题（E 的无交互审批），优先级 P1；该计数不把已合规的 busy 拒绝算作问题。

### Spec

确认 A/B/C/F 共 4 组当前缺口，最高 P1。对应 FEATURE_298 的显示不退步（266/448/819）、批准计划后由 Host 改模式（459）与 MCP/extensions 实际资源承接（1091）。这些接线大多不在上一轮修复 diff 内；上一轮两轴对该 diff 的 0 finding，不能覆盖此次跨主线行为复核。

### 队列复验与旧台账更正

原脚本在当前 110 列 standalone 模式的一次失败产物为 `kodax-repl-acceptance-cwmOVO`：Host 已是 AMA，终端页脚只显示 `AM`，等待完整 `AMA` 字样超时；尚无 Run、无排队输入。该失败不是消费失败。诊断副本仅固定 160 列，保留全部队列断言，连续三次 startup / 同 Run 下一模型请求收到且仅收到一次输入 / 正常退出均通过：`dlXuM2`、`fEl7AQ`、`3f7yc5`。执行前后 HEAD 一致，`dist/sdk-runtime.js` SHA-256 均为 `494C445D4066FDAE29E0DAF6C22ACB655E23AE2BDA647F64E87F75491742B1ED`。没有修改正式脚本；其 standalone 窄屏前置检查仍需修正。三次通过不能证明不存在任何竞态，但不能用此次宽度失败支持 G 的“两路径竞争”推断。

报告所列“约 15 项仍未修复”不能整体沿用。例如 R2 观察状态、R3 上下文预算、R4 搜索全文和 R5 steer 附件已接入当前契约，`2c6cbffb` 完整测试中的 observe/history/steer 用例分别 5/5 通过，另有 resubscribe 7/7、tool-results 5/5。unknown、Run 模型可变性、stop/failed 保留队列和 steer 不可撤回也已写入当前说明；跨页 call/result 已有相邻读取。其余旧台账应逐项对当前实现核销，不能据此声称全部关闭；legacy renderer 历史跳转仍保留原记录。

后续应先将新主线 FEATURE_299 列入合并基线，再按 A/B/C/E/F 的真实消费者逐项补最小接线及端到端验收。尤其补 Todo/children/cost、模型 workflow、重新挂接活动 Run、MCP/extensions、计划批准正文和 headless 权限的实际出口；不再以“字段到达 SDK”或手工 props 的组件测试替代整链行为验证。

## 2026-09-12：GLM 缺口修复与主线融合

本轮基于 `03f31864`，融合主线 `c61914bf` 的 FEATURE_299。实现保持一个 Host、同一 ProductClient 契约和既有执行边界；没有增加恢复状态机、第二队列或客户端 Shell 执行器。包版本继承主线，不发布 v0.7.97。此前 GLM D、E busy、G 的归因更正继续有效。

| 范围 | 已修复与验证的行为 |
| --- | --- |
| A 显示 | Todo、子代理、AMA 工作条、cost 消费 Host 事实；模型内 workflow 进度进入视图，完整摘要进入可读历史。实际 Host/IPC→CLI plane→Ink/classic 渲染入口验证，不只检查 DTO 字段。 |
| B 忙闲 | 输入、排队与停止根据 Host 活跃 Run 工作；重新附着不误发 immediate；只读帮助不要求 Session 空闲。实际修改仍保持 Host busy 保护。 |
| C 集成 | /mcp、/extensions 使用 Host 诊断；扩展 DTO 不泄漏 Node/处理函数。status 不唤醒 lazy server，显式 refresh 才刷新目录。 |
| FEATURE_299 融合 | 手动 Shell 使用 `runs.startTool`，真实工具权限、记录、取消与零模型调用；Session Stop 使用主线固定顺序边界，redirect 仍是单 Run Stop。保留 Full Access 与显式 forbidden 规则。 |
| E 无交互 | one-shot 订阅后提交，及时拒绝本 Run 无人处理的权限请求；视图先于接收回复也能处理，不误拒其他 Run，不改全局审批策略。 |
| F 计划 | 完整 plan 经现有 Interaction 到两个 UI；有效首答由 Host 改模式；拒绝、取消、Stop 均不改。真实 IPC 覆盖长正文。 |
| 接续与身份 | effectful extension handler 在真实工具 Run 内执行；模型在该 Run 继续。复用已接受 inputId 与工具历史，SA/AMA 原 query 只出现一次；同文新 inputId 仍是新输入。 |
| legacy 浏览 | transcript 使用已有行窗口，搜索编辑区与跳转目标可见；真实 legacy PTY 验证 Ctrl+E、草稿恢复、正常退出，普通输入保留原生 scrollback。 |

进一步复核发现并修复了三类额外问题：

- MCP 目录读取绕过 provider 使用保护，显式 reload/热更新可能销毁正在初始化的连接。真实 IPC 将 initialize 固定暂停，再由第二客户端替换 provider，旧实现明确 timeout。修复复用现有使用计数和 drain，读取/刷新结束后才销毁；同类 `refreshCapabilityProviders` 一并接入。初始化 dispose 原先还会进入协议 fallback 并再起一个进程；专用关闭错误现在直接传播，真实进程计数测试先 RED 后 GREEN。
- 独立 Spec 评审发现，handler 返回到模型开始之间会释放贡献快照，热更新可改变同一 Run 的实现。真实 SA/AMA IPC 两项均复现当轮误读新贡献。复用已有 runtimeRunId 在整个接续中固定原贡献，只有相同且未关闭的 Run 复用上下文；之后的新 Run 读取新贡献。没有新增输入恢复语义。
- 同条接续漏了共享 MCP Session 上下文，表单直接被取消。整个工具→模型路径现在使用既有 `runWithMcpCallContext`；真实 shared stdio MCP 和双 Product 客户端验证 command 受检工具、SA 模型接续均可回答，另一 Session 无交互。

### Standards

首次独立评审 2 项：新增 console 输出不符合项目规范；主线带入的 `requestSessionWorkflowStop` 只有测试调用，实际 Host 另有归属检查。已保持用户可见 stdout 提示，删除无生产调用的辅助函数及镜像测试；归属校验改用真实 Product→IPC→Host 测试。增量独立复查 **剩余 0 项**；复用了既有上下文、provider 使用保护和 MCP 调用上下文，没有新锁、控制面或配置。

### Spec

首次独立评审 2 项 P1：同 Run 贡献寿命与 MCP 交互归属，均已用上述真实失败场景修复。增量独立复查 **剩余 0 项**；核对 SA/AMA 当轮旧贡献、下一轮新贡献以及独立 Session 隔离。此计数只覆盖固定融合修复及其增量，不是全仓所有历史问题的清零声明。

首份评审固定补丁 SHA-256 为 `519E608594963EFE72F64062247E24002B4DC63410B088F14A112B555260B39F`（119 文件）；随后两轴各自复查修复增量。完整测试及最终构建结果在完成后追加，不将阶段性通过当作最终门禁。

首轮完整 Vitest 为 **1,073 文件通过、2 文件失败、1 跳过；15,679 passed、5 failed、77 skipped、21 todo**（719.34 秒，`.repair-full-suite.log`）。失败均保留归因：新增 dispose 测试的一秒准备期限先于满负载子进程进入初始化，尚未执行 dispose；四个旧 CLI 生命周期夹具未提供 one-shot 新消费的 `observeView`。前者只调整测试准备期限，仍断言关闭原因与恰好一个进程；后者补充观察器测试替身，未增加产品兼容回退。两个完整文件复跑 **63/63**（`.repair-fixture-rerun.log`）；没有将首轮称作全绿。

最终融合 `6fcba6df`（beta.9 发布）后重新构建及严格 src/tests 类型检查通过（`.release-merge-build.log`、`.release-merge-types.log`）；纯 ProductClient 仍通过无 Node ambient types 编译。发布增量两轴各 **0 项发现**，FEATURE_298 仍在独立开发分支，未将它标为主线已发布。

beta.9 融合后的完整 Vitest **1,075 文件通过、1 跳过；15,684 passed、77 skipped、21 todo，零失败**，707.83 秒，exit 0（`.release-merge-full-suite.log`）。此运行先于下述最终无头提问增量，不把它称作该增量后的完整验证。首轮的两个失败文件均在此次完整运行中通过。原生 Rust/Node 门禁在 FEATURE_299 融合后通过（`.merge-native-test.log`），native 源码此后未变；`cargo fmt --check` 通过。所有测试使用专用临时 HOME、真实本地 IPC 或离线 Provider，未停止或改写用户原 Host/Session。

同一 beta.9 融合状态下，真实 Windows 终端验收结果如下，均核对产物和 exit 0：

| 入口 | 结果与产物 |
| --- | --- |
| 源码完整 PTY | Ink 21、classic 14，**35/35**；`kodax-repl-acceptance-uULQoK`，`.release-pty-source.log`。 |
| 打包完整 PTY | Ink 21、classic 14，**35/35**；`kodax-repl-acceptance-he08qV`，`.release-pty-built.log`。 |
| 源码长会话 PTY | startup、预算饱和历史、正常退出 **3/3**；`kodax-repl-acceptance-WOzHg9`，`.release-pty-long.log`。 |
| 强制 legacy PTY | 搜索编辑区、旧目标跳转、Ctrl+E 折叠/展开、退出恢复草稿及正常关闭全部通过；`kodax-legacy-search-PeH3gX`，`.release-pty-legacy.log`。 |

最后按 Interaction 的全部已用类型继续检查，发现 one-shot 及时拒绝权限之后，普通人工提问和共享 MCP 表单仍会等待。该缺口在主线 `c61914bf` 也存在，不能归为本次新回归。最小修复只扩展 one-shot 原观察器：本 Run 权限继续 reject，其他人工问题使用既有 cancel；不默认作答，不改变 Host 超时或交互协议，不影响另一 Run。取消结果回到工具，后续 Run 结果仍由正常执行决定。

新增真实 IPC 测试覆盖 askUser、askUserMulti、askUserInput 和共享 stdio MCP 表单，前三类均先复现已进入待答状态后超时；修复后连同既有 one-shot 测试 **3 文件 14/14** 通过。每例检查自身取消、另一 Session 保持待答、不代填默认值、观察器关闭。独立 Standards 增量复核发现 1 项 P2：固定等待不能保证 view 先于 receipt；已改成放行 receipt 前断言观察回调到达，复查 **0 项剩余**。Spec 增量复核 **0 项发现**，同时核对普通 prompt 的实际 CLI 入口。最后生产增量不涉及任何交互式 REPL 代码，上述 PTY 仍覆盖最终交互式实现；无头路径使用新的真实 IPC 回归验证。

最终无头提问修复后，构建及严格 src/tests 类型检查再次通过（`.headless-final-build.log`、`.headless-final-types.log`）。完整 Vitest **1,076 文件通过、1 跳过；15,688 passed、77 skipped、21 todo，零失败**，718.07 秒，exit 0（`.headless-final-suite.log`）。新增四项真实提问用例在完整运行中通过；该运行包含最后加强的回执顺序断言。

文档终检同时核销 `KNOWN_ISSUES.md` 中 FEATURE_299 实施前的三条 Full Access/手动 Shell 旧记录，保留保护路径、no-follow 与 CAS 边界；更正 Host 自动更新与客户端进程重启的区别。尚未测量本次全仓覆盖率，也未执行其他操作系统实机、真实模型服务联调或正式发布验收；既有 skipped/todo 不计为通过。这些属于明确的验收边界，不以两轴对当前补丁无阻断发现替代。

最后另合入主线 `7a82b0dc`、`d6a7be32`，仅修改三个发布脚本：从源码读取可信文本协议，避免原来的固定协议 4 与当前协议 5 冲突。两轴只读复核无阻断项；Spec 提醒的成功日志旧值已改为实际期望值。Standards 提出三处短解析代码重复的非阻断 P3 建议，本轮保留主线的直接实现，不为构建脚本新增公共模块；该维护建议不计为已修复的功能缺陷。

此增量无运行时改动，未再次重复全仓测试；三个脚本语法检查通过，发布工作流与最终 one-shot **4 文件 31/31**（23.41 秒，exit 0，`.final-merge-targeted.log`）通过。`--skip-build --pack-only` 生成本机测试包并通过 sidecar 内容审计（`.final-local-pack.log`）；随后离线安装到专用临时目录，实际安装入口的 ASRT 检查和 native text doctor 均通过，明确加载 **protocol 5**（exit 0，`.final-packed-native.log`）。测试包保持 `private: true`，没有发布或推送。此处补足本机安装检查，其他平台和正式通用发布仍未验收。
