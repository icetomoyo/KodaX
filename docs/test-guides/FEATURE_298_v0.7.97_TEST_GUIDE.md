# v0.7.97 产品入口自动化验收

本指南验证构建后的产品入口。组件、协议和 SDK 单测继续保留，但不替代这里的真实进程与终端操作。

## 2026-09-14 主线融合复核

完整分析和边界见 [复核报告](../research/product-client-reaudit-2026-09-14.md)。补充以下人工场景，均使用专用测试 HOME 和已有共享 Host：

1. 一个窗口等待问题，第二个客户端回答该问题。classic 窗口应撤掉旧输入；Host 下一问题可立即作答。关闭观察后输入旧答案不得发出 Host 答复。
2. 忙时排入 `说明 @"带空格的图片.png"`，重新挂接同一 Session 后按 ↑ 取回，修改正文再提交。图片引用应可见、仅一份，后续模型请求仍有该图片附件。
3. 在 Host 接受输入期间取消。界面应等待真实 Run 结果；不能把 Stop 接受或 cleanup unknown 显示为已完成取消。
4. one-shot 使用临时模型参数恢复已有 Session，在运行期间由另一客户端改变模型。one-shot 结束不能覆盖新选择；设置恢复冲突需明确报告。
5. ACP 进程与既有 Host 的 repo-intelligence 环境值不同。ACP 发起 prompt 后，Host Session 的模式/trace 开关应采用 ACP 调用配置。

上述公开接缝已有自动回归；真实终端操作通过与否应单独记录，不能以单测成绩代替。

## Windows 终端验收

入口：`tests/repl-pty-acceptance.mjs`。

链路：node-pty 的 Windows ConPTY → 发布入口 `scripts/kodax-bin.cjs` → 构建后的 CLI → 独立 Host → 本地 HTTP SSE Provider。xterm 解析终端实际输出；测试通过键盘输入操作产品，通过公开 Client 接口核对 Host 事实，并核对 Provider 实际收到的正文。

准备并运行（仓库根目录，PowerShell）：

```powershell
npm run build
npm install --prefix "$env:TEMP/kodax-acceptance-tools" --no-audit --no-fund node-pty@1.1.0 @xterm/headless@5.5.0 @xterm/addon-unicode11@0.9.0
npm run test:repl-pty:built
```

可用 `npm run test:repl-pty:built -- ink` 或 `-- classic` 单独运行。Ink 路径明确使用当前 owned 渲染器；`KODAX_FORCE_INK=1` 选择的是旧 legacy 渲染器，不属于这一通过结论。若工具安装在其他位置，以 `KODAX_ACCEPTANCE_TOOLS` 指向包含 `package.json` 和 `node_modules` 的目录；这是验收驱动的位置，不是产品配置。

每次运行创建独立临时 Home、配置、项目和 Provider，只使用本地测试凭据。退出时停止本次创建的 Host；测试证据保留在启动输出的 `Artifacts:` 目录：

- `results.json`：每项结果及失败原因。
- `*-*.txt`：终端屏幕文本；`*-*.ansi`：原始终端输出。
- `*-requests.json`：本地 Provider 收到的请求，用来核对原文与历史。
- `*-host.json`：公开 Client 读取的视图、Run 和事件，区分正常停止与运行失败。

两种终端均验证新会话启动、流式输入/输出、设置往返、完整长输入、提问、停止后继续输入、新建隔离、退出和历史续接。Ink 额外验证忙时排队撤回编辑、搜索旧消息及冻结浏览。Ink 长输入使用 bracketed paste；classic 使用原有反斜杠续行。新建会话沿用各入口原有交互：Ink 确认后创建，classic 直接创建。具体通过项以当次 `results.json` 为准；失败不能以旧测试通过数豁免。

2026-09-09 起，Ink 同一入口额外检查以下回归：

- 普通输入和完成回答各显示一次，完成后的连续采样不出现回答重影；状态栏显示夹具的 `60/65.5k`、`50→10 (60)` 和 `1/7`。
- AMA 模式下，一条 query 只显示一次、Provider 也只收到一份；临时 worker 提示不混入历史，上一轮回答保持在下一轮提问之前。
- 实际执行 `echo ACCEPT_TOOL_RESULT`，折叠工具项显示命令摘要，Host 记录成功状态及真实工具输出。
- 生成超过 8192 字符的回复时输入草稿，按 Ctrl+O → Ctrl+E 展开历史，冻结尾部仍在；q 返回后草稿保留。再次进入 transcript，按 `/` 搜索预览窗口之外的早期正文，Enter 跳转，q 返回后草稿仍在。

接口再扫描后，同一场景还在 Ctrl+O 后让 Host 追加独有标记，再选择当前项并按 `v` 展开、`G` 移到底部，断言冻结内容没有混入后来的标记。完整历史展开与单项展开必须同时遵守冻结边界；`c/i` 复用该读取实现，本驱动不读取或改写用户剪贴板来断言复制内容。

真实旧会话残留修复后，另加 240×64 长 AMA 输出（Tab 与中文长行），执行展开/收起、开头/末尾跳转及搜索/取消，逐行检查页脚没有混入正文，然后缩回 110×32。xterm 必须启用 Unicode 11，让 emoji 列宽与产品一致。此场景在旧代码下会出现正文标记错位，不以字符串存在替代页脚行检查。Tab 等控制字符只在显示 cell 转为空格；历史和全文复制保留原始字符。

这里 Ctrl+E 表示展开/折叠完整历史，`/` 表示打开 transcript 搜索。分页期间模型继续追加、旧会话来源歧义和取消读取另有契约/显示函数回归；不把这些单测计为额外真实终端用例。

## 打包 Electron 与沙箱验收

入口：`scripts/test-electron-daemon-smoke.mjs`。配置已有 Electron 和 electron-builder 后执行：

```powershell
$env:KODAX_ELECTRON_DIST = '<electron 包>/dist'
$env:KODAX_ELECTRON_BUILDER_CLI = '<electron-builder 包>/out/cli/cli.js'
npm run test:electron-daemon:built
```

要求本机 Windows restricted-user sandbox 已就绪。验收不会隐式执行全局 sandbox setup 或修复 ACL；前置条件不足时明确失败。不要将真实用户目录传给 `KODAX_ELECTRON_SMOKE_HOME`，因为现有脚本把该参数视为可清理的验收专用目录。

测试实际打包并启动 Electron，检查 20 次工具查询、4 个 Session 并发、Windows 沙箱实际执行、环境隔离、连接/断开、关闭 Host 和重新启动。它运行 Electron 主进程但不创建 BrowserWindow，因此不覆盖视觉界面点击。

## 结果与边界

本轮执行与修复记录见 [真实产品入口自动化验收](../REVIEW_v0.7.97_FINAL.md#真实产品入口自动化验收)。确定性 Provider 让输入与交互断言可重复，不代表真实商业模型的任务质量验收。本指南也不替代 macOS/Linux 实机、剪贴板/输入法、视觉 GUI 和主观终端手感检查。

多客户端设置反向同步已通过真实 Ink/classic 验收，包括清除覆盖与 Host 默认值变化。仍有一项已知缺口：强制 legacy 渲染器的搜索结果跳转可能无法显示屏幕外的历史消息。详见 [Known Issues](../KNOWN_ISSUES.md)。因此本指南的通过结果不代表整个 v0.7.97 无条件验收通过。

## 开发代码更新后验证旧会话

REPL 和 Host 是两个进程；界面的包版本不能证明后台进程已加载本次修复。启动器现在比较运行中 Host 与本次启动实际代码的构建身份：同版本、同入口、不同字节且旧 Host 空闲时，正常关闭旧进程、确认退出后启动新构建。`npm run dev`、`daemon start`、SDK ensure 和默认 ACP 共用这一规则；被动 connect 不更新进程。

没有构建身份的历史 Host 需要一次明确的正常迁移。在任务结束后退出旧 REPL，从本 worktree 停止、启动 Host，再恢复会话：

```powershell
npm run dev -- daemon stop
npm run dev -- daemon start
npm run dev -- -r 20260909_075806_ed59a28bf46b46
```

这些命令不使用 force。若 Host 报忙，先结束或由用户停止对应任务后重试，不强停。跨安装来源、较新版本或安装正在变化时，按具体诊断处理；不循环重启，不降级。已加载旧 SDK 的长寿命调用进程需要重开。

恢复验证要检查后一轮 query 位于前一轮最后输出和后一轮首段输出之间，而不只查找正文是否存在。历史中已保存的重复输入不自动清理；测试副本可以隔离重放，但不得重写用户原会话来让验收通过。

## 构建更新与统一产品接口自动验收

接口说明见 [CLIENT_CONTRACT.md](../CLIENT_CONTRACT.md)。执行完整 `npm run build` 后运行 `node tests/host-build-acceptance.mjs`。脚本在临时安装副本中使用真正的独立 Host 和公开 SDK，覆盖同版本字节更新、相同内容复用、被动连接、真实观察者阻止更新、空闲后重试、旧调用进程拒绝更新，以及 `daemon start` 一致性。

脚本通过删除/复制隔离 dist 和添加合法 JavaScript 注释模拟 clean/build 的文件替换效果，验证旧 PID 真实退出及 Session 保留；不声称在副本中再次运行了编译器。它不会修改用户安装、用户会话或调用商业模型。

ACP 的共享 Host、文本/工具、Session MCP、权限、取消、并发请求和提交竞态由 `src/acp_server.daemon.test.ts`、`src/acp_server.admission.test.ts` 与投影测试覆盖。发布声明通过真实 `/client` 消费者在 `types: []`、`skipLibCheck: false` 下检查，不能靠注入 Node 全局类型掩盖产品契约泄漏。

## Host 执行归属与统一业务入口回归

这组验收对应 [Host 审查 H1–H5](../HOST_ARCHITECTURE_REVIEW.md) 和 [产品接口说明](../CLIENT_CONTRACT.md)。使用临时项目、独立 Host 与可计数离线 Provider；不重写用户的旧 Session，不把方法存在或类型通过当作实际执行通过。

| 验收入口 | 必须核对的行为 |
| --- | --- |
| `src/sdk-invocations.test.ts`、`src/sdk-runtime.skill-lifecycle.test.ts` | Skill 的输入保存和 Run 准入先于动态工具执行；忙时及保存失败零执行；准备中 stop/close 传播取消并等待退出；同 inputId 不重新执行；Plan 不执行动态命令。 |
| `src/sdk-client.domains.test.ts` | 两个 ProductClient 实际调用 compact、Memory、Learning、注册命令、review 和 agents lean；核对 Provider 请求、落盘正文、领域版本及客户端通知作用域。手动草稿可编辑且不执行 hook、不继承可信调用元数据；无输出命令不伪造 user 或模型轮次。 |
| `src/sdk-client.steer.test.ts` | steer 图片等附件进入实际模型消息和保存的输入；同 ID 换附件产生 conflict，沿用已有媒体能力校验。 |
| `src/session-view.tool-results.test.ts` | 结构化工具失败、成功正文含错误字样、取消和非文本结果在实时与恢复后保持一致，不靠新正文格式猜状态。 |
| `src/sdk-client.observe.test.ts`、`src/runtime-daemon/client.resubscribe.test.ts` | Host 读取失败和传输断连均可观察；先交付恢复后的完整 view 再通知 live；恢复观察不重新提交输入或工具调用。 |
| `src/sdk-client.history.test.ts`、`src/session-view.test.ts` | 当前设置预算与实际执行预算分开；父/worker 及不同 contextId 不混用；搜索命中通过同一全文 reader 打开，快照失效明确失败。 |
| `src/sdk-client.test.ts` | 缺少统一产品契约的旧 Host 在被动连接时明确拒绝；不借连接错误关闭或替换其进程。 |

上述文件可用 `node node_modules/vitest/vitest.mjs run <文件...> --maxWorkers=1` 定向执行。之后运行完整构建、类型检查、完整离线测试与前述 PTY 验收；每次报告应分别给出定向与完整测试结果，不能把不同快照的通过数相加冒充最终门禁。

终端还须核对：注册命令启动后只跟随已返回的 Run，不再次提交同一正文；`disableModelInvocation` 不阻止用户显式执行注册命令；`/review` 无改动时仅显示结果，有改动时使用同一 Host 的项目内容。SDK 的 `commands.readPrompt` 是明确的草稿读取，不据此增加 CLI 开关或改变旧命令行为。已有忙时命令限制、输入草稿、冻结 transcript 和返回编辑器行为均须保留。

Bash/sandbox 的回归继续使用 `src/sandbox-runtime.test.ts`、`packages/coding/src/tools/bash.test.ts` 和 `packages/coding/src/skill-invocation-policy.test.ts`。本轮接口迁移不能引入新的 shell 执行路径、沙箱失败后自动本机执行、批准后修改整个 Session 权限，或无法确认执行状态时自动重跑。原生平台前置条件导致的跳过必须单独报告。

## 长会话显示预算耗尽与工具分组

短回答、单条长文本及展开后的全文读取不能替代这个验收。必须让多个工具结果的有界预览合计超过 131,072 个 UTF-16 码元，并在普通 live 界面重绘后检查早期内容。

```bash
node tests/repl-pty-acceptance.mjs ink --source --long-history-only
```

该入口使用与 `npm run dev` 相同的 production-env、tsx 和源码 bootstrap，在独立临时 HOME/项目和离线 Provider 上启动。夹具先生成早期 query、Thinking、正式回答及两个 Bash 调用，再产生多批真实 read 结果填满预算。核对普通界面上的早期 query 整行、Thinking/回答正文、Bash 参数仍可见，相邻工具按批次显示；不要先用 Ctrl+O 展开全文来掩盖普通显示的空白。另检查原文 reader 仍可读取、总预览不超限。

`src/session-view.preview.test.ts` 覆盖正文、参数双字段和完整 150 项窗口；`client-plane.test.ts` 与 transcript 布局/滚动测试覆盖单项原身份、相邻合并、非首项搜索定位、展开和复制。分组只能改变展示，不能把多个 Host item 合成无法分别读取的新业务身份。

## 队列在下一次模型沟通时交付

```bash
node tests/repl-pty-acceptance.mjs ink --source --queue-boundary-only
```

该场景暂时切换为 AMA 并在结束后恢复原设置。离线 Provider 暂停第一次请求，真实终端输入普通 follow-up，确认 Host 和终端都显示排队；随后让第一次请求返回工具调用。在第二次模型请求尚未结束时，检查其中已且仅已包含一次 follow-up，原 Run 仍在运行，Host 队列和终端排队行已清除，普通界面还须显示 query 完整正文行。不能先让整个任务结束，再把新 Run 收到文字当作通过。完整 PTY 套件另以 SA 注册命令验证原 Run 内续答和双 Esc 停止。

SDK 对应 `src/sdk-client.queue-boundary.test.ts`，须覆盖 SA 与 AMA：消费前 withdraw 返回完整原文和附件，撤回项不进入模型；重新排队使用新 inputId；消费后的 read 指向执行 Run，withdraw 明确 conflict，canonical 输入不重复。Skill 位于队首时仍需走 Host 的可信准备，不让后续普通输入越过；stop/failed 保留尚未交付的队列。此验收不改变 Esc、↑、权限或 sandbox 的既有语义。

## 启动碰撞与终态后的稳定读取

`src/sdk-runtime.launcher.test.ts` 在真实 IPC 层固定制造四轮临时 launcher 同时连接旧 Host，再检查两个调用连接同一个新 owner、旧进程正常退出、原 Session 保留。`src/sdk-runtime-daemon-upgrade.test.ts` 检查同一个启动期限内退避、取消后释放连接、永久忙碌时不 shutdown，以及期限耗尽后不跳过退出确认。不得通过忽略名称为 launcher 的连接来通过测试。

`src/sdk-client.derive.test.ts` 在 Host 显示 checkpoint 内持有真实 Session 写锁，直接调用会话、lineage、设置、auto stats、fork/recover 接口。请求应等待自身 checkpoint；保存失败必须传递，外部写锁仍明确拒绝。不要在目标调用前额外 readHistory 来预热或同步，也不要增加固定 sleep。Run 终态与显示保存是不同边界，所有出口应在 Host 内复用已有等待机制。


## FEATURE_299 融合后的消费者验收

完整 PTY 增加 `host-diagnostics-and-manual-shell`：客户端不加载扩展，`/mcp` 和 `/extensions` 必须显示 Host 诊断；`!echo` 必须产生 Host 的 bash 工具结果、一次原 query、零模型请求。主线已要求 effectful extension 命令具有工具 Run，所以无输出命令改为核对真实 Run 完成、一次输入、零模型调用，不能继续断言不存在 Run。只读帮助仍不能执行 handler。

| 自动测试 | 真实验证范围 |
| --- | --- |
| `src/sdk-client.repl-activity.test.ts` | 真实 Host/IPC、ProductClient、CLI plane 与 Ink/classic 渲染入口；替换终端 streams 和执行器事件夹具，核对 Todo、child、AMA 工作条、workflow、完整摘要、附着忙 Run 排队与停止、两端 cost。该测试不是原生 PTY。 |
| `src/sdk-client.domains.test.ts` | 实际离线 Provider 与共享 Host；扩展 command scope、受检工具、两 Session 隔离、原输入身份、同 Run 模型接续、只读帮助及诊断命令。 |
| `src/sdk-client.interactions.test.ts` | 实际 IPC；显式工具身份、完整长计划、首答、拒绝/取消/Stop；不把直接赋予组件 props 当作协议验证。 |
| `src/one-shot-permissions.test.ts` | 无交互 CLI 及时拒绝自己 Run 的权限，处理 view 早于接收回复；其他 Run 不被误拒，不修改全局模式。 |
| `src/one-shot-questions.test.ts` | 真实 IPC 单选、多选、自由输入及共享 stdio MCP 表单及时取消；固定 view 先于接收回复，不代填默认值，其他 Session 仍待答，观察器正常关闭。 |
| `packages/coding/src/agent-runtime/input-identity.test.ts` | SA/AMA 首次 Provider 请求复用已接受 query，保持 tool call/result 顺序；不同 inputId 的同文输入仍是新输入。 |
| `packages/repl/src/ui/client-plane.stop-control.test.ts` | Stop 请求失败可按同身份重试；自然终态及迟到 ACK 不丢失确认，旧 Run 不确认新目标。 |
| `src/sdk-client.integration-diagnostics.test.ts` | 无本地 runtime 的扩展/MCP 命令；lazy 查询不唤醒；真实初始化暂停时，另一客户端 reload 必须等待目录读取结束。 |
| `src/sdk-client.command-mcp-elicit.test.ts` | command 受检工具与 SA 模型接续两条路径，真实共享 MCP 表单必须归属本 Session，另一 Session 无交互，双客户端可以正常批准。 |
| `tests/repl-legacy-search-acceptance.mjs` | 强制 legacy 渲染器的真实 Windows PTY：长历史搜索编辑区可见、Enter 目标在屏内、Ctrl+E、草稿恢复、退出。 |

扩展接续还须在 handler 暂停期间真实 reload，再检查当轮 Provider 使用旧贡献、下一个 Run 使用新贡献；SA 与 AMA 都要覆盖。MCP 初始化被 dispose 时应保留关闭原因，不能启动备用握手进程。对应 domains、MCP runtime 与 extension runtime 测试均保留，不以静态接线检查替代。

还需运行 FEATURE_299 回归指南的原生边界与真实 Shell 清理测试。`npm run build` 包含不安装 Node 类型的 ProductClient 使用者编译检查，防止诊断字段泄漏 Host 执行类型；不得添加 Node 类型依赖来掩盖失败。


## T38–T42 消费者归口补齐

```bash
npx vitest run src/sdk-client.catalog.test.ts src/sdk-client.repl-activity.test.ts src/sdk-client.capabilities.test.ts src/sdk-session-commands.test.ts src/sdk-goal-binding.test.ts
node tests/repl-pty-acceptance.mjs --consumer-only
```

consumer-only 在真实 Ink/classic 终端验证 Host probe/forget、模型与设置命令、fallback/log 控制、按项目列会话、加载目标会话不覆盖设置、rewind 后历史可见、Host tree，以及已有 Host 下明确 `-r <id>` 和 repo-intelligence 启动参数。启动只提交显式参数；未显式指定的 permission/thinking 等字段保持 Host 默认，不强行写成客户端默认。

`src/sdk-client.repl-activity.test.ts` 给客户端注入禁止 load/list/save 的 storage，实际 Host 仍使用 canonical 存储；从两个真实 REPL 入口验证 startup/load/status/tree label/select/rewind/fork/recover、目标设置保留，并验证 Ink 设置写入失败后仍可 load。恢复命令保留原有确认及 Continue 行为。`src/sdk-client.catalog.test.ts` 另验证保存前失败、保存后报错、实际 Session 应用失败分别如实呈现，以及真实 Workflow fallback 与 verifier/stall sidecar 日志开关。

裸 `-r` 继续从 bootstrap 公开入口验收：空目录、旧布局和缺索引时读取不创建目录、迁移文件或写索引；超过 1000 个候选仍能选旧会话；选中后已删除/归档应由 Host 拒绝，不能误建新会话。普通 Host 列表只在索引缺失或无效时维护，热索引路径不重复扫描 canonical 正文。保留旧 worktree 路径映射与 Esc 输入所有权测试。

人工补验：Host 与客户端 home/profile 分开时，Host 独有模型仍可选择；从工作区 A 加载 B 后，相对附件按 B 的实际路径解析；旧会话迟到更新不得覆盖新页。既有冻结浏览、展开、复制、外部编辑器和独立 REPL 入口继续按前文回归，不能用本节自动化替代跨平台及视觉验收。

长历史预算夹具显式在 Host 设置 full-access，仅授权夹具中的受控本地工具，避免默认权限批准阻塞显示验收；既有正文、工具参数、分组和预算断言不变。失败清理覆盖待批准/等待子 Agent/恢复中的 Run。

## T43–T47 体验承接回归

使用隔离 profile；优先从真实 Product Client → IPC Host 和生产 Ink/classic 入口观察行为。T43 的 `src/sdk-client.interactions.test.ts` 验证无配置新会话、无模式旧会话、清除 override 及显式 accept-edits/plan 的 AskUser 直接出现 question，同时原始 Session/config 仍未写入默认。底层 SDK 未声明权限仍须走原 permission broker。原生终端验收中的 question 场景显式清除 profile/Session 权限覆盖后再发起请求，不能用 full-access 绕过这个回归。

观察可用性须分别验证：首次失败、已成功后的短暂 interrupted、明确 closed；失败后原始长稿及附件引用可恢复，读设置与 Stop 继续可用；同会话重新订阅不吞或重复正文/问题，迟到的旧会话回调不污染新会话。提交结果未知不得自动重发输入。普通输入、显式工具、注册命令及 workflow 的新执行入口均须覆盖就绪检查。

会话信息仅依据 Host 元数据：classic /load 显示目标工作区、消息数及切换提示，/sessions 显示工作区标注；目标设置、实际执行 cwd 和 raw Session 文件不因显示而改变。

effort 必须区分拒绝事实与随后发送的参数；sentEffort 不表示模型强度已验证，不写回用户默认。SA/AMA 与双端消费者都需验证。流式活动按请求身份归属，覆盖 thinking 完整长度、同名交错工具、缺 ID、child 隔离、迟到事件和 replace/stop/reset。保留 80ms 合并、长历史预算、空闲 API 上下文真值和共享进程快照测试，不能用扩大预算或逐 delta RPC 换取通过。

本轮不新增 Memory 写入、不恢复退役 Scout、不改 classic 工具全文约定，不将名称/计数反馈冒充逐字 JSON 预览。人工跨平台与终端操作手感仍按前文验收。

新增定向自动化入口：

```bash
npx vitest run src/sdk-client.interactions.test.ts src/sdk-client.repl-observation.test.ts src/sdk-client.repl-activity.test.ts src/sdk-client.capabilities.test.ts src/sdk-client.streaming.test.ts src/session-view.streaming.test.ts src/session-view.reasoning.test.ts
```

`sdk-client.streaming` 使用本地 HTTP SSE 夹具、真实 Provider parser 和 IPC Host，分别暂停 thinking 与工具参数片段，证明两阶段确实可观察；不是对真实模型能力的验证。局部 streaming 用例还覆盖 A/B/A 同名工具分开累计、缺调用 ID 不计数、旧请求同 callId 的迟到工具启动、取消和 reset。classic 在连续流式活动期间按请求/阶段/调用去重提示，计数为首次看到的快照；活动消失后清空去重状态，重新进入可以再次提示。Ink 计数实时更新，冻结浏览不跟随更新。

夹具同步也属于验收可信度：等待实际 Provider 请求进入后才断开或排队，不把默认 1 秒轮询当作产品性能承诺；fallback 统计应区分当前 child 请求与沿用历史的后台摘要；自然完成后清理临时目录前，等待已有 Memory review drain，并取消、等待测试自身额外创建的 Run。HTTP PTY 夹具先做健康检查，仅 Fetch 明确拒绝端口时重选，其他错误继续失败。不要通过跳过断言、增加生产重试或扩大历史预算消除这些夹具故障。

MCP 冷启动/全局重载和私有会话资源隔离分别验收，保留真实工具调用；setup、测试体和 teardown 分别受现有 30 秒限制。不能把拆分后的组合墙钟时间描述为仍有单个 30 秒上限。setup 部分失败也要释放本次已创建的资源，Provider 回调只捕获本次 fixture，避免误清理或污染下一例。

本轮原生 Windows PTY：主矩阵 43/43、consumer 14/14、长历史 7/7，退出码均 0。完整测试的首轮失败、定位及最终复验另见 v0.7.97 设计块的本轮证据；不将定向测试或带重试运行描述成一次无重试全量通过。检查全量结果时同时读取退出码、失败列表和未处理错误；JSON 的测试成功字段不能单独证明运行器无错。

最终快照 `c94d73ab` 的完整默认测试集合使用 `--maxWorkers=1 --retry=0 --reporter=dot --reporter=json`：16140 测试通过、零测试失败，但仍有一次 Vitest `onTaskUpdate` 未处理超时，退出码为 1，**全量验收尚未通过**。类型检查、构建和 PTY 通过不能替代这个失败门禁。下一步先定位报告通道的具体任务与处理延迟，不以忽略错误、扩大时限或重复无定位的整套运行结案。
