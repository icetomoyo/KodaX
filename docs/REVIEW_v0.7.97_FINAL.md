# v0.7.97 交付复查（2026-09-08）

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
