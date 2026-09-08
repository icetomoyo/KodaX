# v0.7.97 交付复查（2026-09-08）

> 下方首轮评审针对 150e64e3；最新 1a88c401 修复后复核见本文末尾，包含已修项与仍未闭环项。

**当前不能按“35/35 已完成、REPL 能力和体验不退步”验收。** 实现已有实质进展，但完成标记超出了代码和验收证据。应修复现有切片、补齐消费者，不需要再引入恢复框架。

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

本节为上述复查缺口的整改记录；历史评审证据保留，不把旧门禁成绩当作本次验证。代码基点为 `1a88c401`，修复在 `codex/product-client-refactor`，主仓库合并与最终门禁尚未完成。

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
