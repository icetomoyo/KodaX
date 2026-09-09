# v0.7.97 交付复查（2026-09-08）

> 下方保留历次评审。最新结论见文末“真实产品入口自动化验收”；此前 build/单测通过不等于实际 REPL 已验收。

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
