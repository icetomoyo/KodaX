# KodaX 运行中侧聊与定向回传

2026-11-10 · 设计与实现验收记录 · 设计基线 `c0fb41cc8`。首个交付面为 Host、产品 SDK 和 Ink REPL。以下保留设计与验收目标，已执行的验证见文末。

## 1. 用户要完成什么

主 Agent 正在运行测试。用户输入 `/side 为什么先查路径分隔符？`，在另一个输入框里追问“盘符大小写呢？”。两轮讨论只进入侧聊。用户再说“只把盘符这个可能性告诉主会话”，主 Agent 就能在下次推理时看到一条署名为侧 Agent 的消息。原来的测试继续执行。用户切换到其他聊天，也不会改变这条消息的收件人。

采用**独立侧 Session、一次父历史快照、显式单条回传**。参考 Codex 在 fork 后声明继承历史的用途，以及 pi 同仓 p2 把回传定向到原发起会话的做法。KodaX 负责定义自己的忙闲交付语义。上游核对点为 `openai/codex@b32ada5320` 的 `codex-rs/context-fragments/src/side_conversation.rs`，以及 `pi@6273031b0` 的 `apps/p2/plugins/subagents/tools.ts` 和 `apps/p2/test/p2/tree.test.ts`。

## 2. 首版交互

| 用户动作 | 可观察结果 |
| --- | --- |
| 在主会话输入 `/side [问题]` | 为当前主分支打开或恢复一个侧聊；有问题就提交到侧 Session。无参数只切换焦点，不产生模型调用。`/btw` 作为同一入口的别名。创建失败时保留草稿。 |
| 在侧聊追问 | 同一侧 Session 保存自己的用户、助手、工具调用与结果。模型可以解释父历史，也可以按当前侧聊权限做只读核查。用户看得到侧聊来源和快照截至哪条消息。 |
| 在侧聊输入 `/side` | 回到原主会话；再次打开可继续。主、侧分别保留草稿、运行状态及取消目标。侧聊不再派生下一层侧聊。首版采用焦点切换，终端宽度不影响可用性。 |
| 只讨论，或离开侧聊 | 主 transcript 不加入旁问、侧答或完成摘要。主会话的待审批请求仍有提示，用户回到所属会话处理；侧聊中的输入或 Esc 只作用于当前焦点。 |
| 说“把这个发现告诉主会话” | 侧 Agent 只转述所指的内容，界面显示正文、来源和投递状态。授权范围明确时一次完成，所指不明时先在侧聊问清。普通讨论不触发发送。 |
| 说“告诉它，并让它现在继续查” | 主会话在跑时按同一安全点交付。若已空闲，按用户明确意图申请一个正常的新主 Run；沿用主会话当前权限与预算。单纯“告诉它”在空闲时只留言。 |

首版面向同 Host、同授权主体的一对主侧会话。多侧聊管理、与其他任意 Session 自由通信、自动同步主线进度、独立工作树以及 Space 的侧栏界面留待后续。现有普通 `/fork`、后台 Worker 和单轮 `sideQuery` 各自维持原有用途。

## 3. Host 怎样建立侧会话

**身份与历史。** Host 建立独立的 `sideSessionId`，保存父 Session、来源分支身份以及创建时的 canonical 历史边界。来源字段由 Host 写入。侧会话继续对话复用现有 Session 输入、Run、历史与观察接口。重复打开只恢复已有会话，不重新取样；两个窗口同时打开同一分支时得到同一个侧 ID。侧会话在父项下可恢复，普通主聊天列表不重复展示它。旧 Session 缺少侧聊元数据时按普通 Session 读取。

**忙时取样。** 复用存储层一致读取和 lineage 规则，从同一已提交修订取得可重放的消息前缀。可包含当前轮已提交的用户提问和已经配对的工具结果；若末尾有悬空工具调用，退至之前的合法边界。未提交 token、thinking、排队输入、UI 预览都不拼入。压缩历史沿用已有摘要，媒体沿用有权限、能校验的引用与既有 fork 所需的所有权处理。首次主轮尚无可用前缀时允许空背景侧聊，并显示“主会话尚无已提交上下文”。读取遇到变更时走有界重读或明确的重试结果。缺失或损坏的已引用证据不能冒充空历史。[存储快照与既有 fork](../../packages/repl/src/interactive/storage.ts) · [Host 的普通 fork 保护](../../src/sdk-runtime.ts) · [历史修订与工具配对契约](../CLIENT_CONTRACT.md)

**建立顺序。** 捕获前缀后，Host 在子 Session 写入参考历史、边界与父绑定，再公布子 ID 并接受第一问。借用现有 Session 原子写入、派生清理与去重机制。写入中断或媒体准备失败不留下可打开的半成品。父 Session 继续在原 Run 上产生新历史；快照成功后，后续追加不会使子会话失效。

**指令与权限。** 侧聊启动指令把边界以前的计划、授权和工具结果标为参考。首版侧 Run 沿用模型选择与项目访问边界，独立取得执行授权；工作区工具限于当前策略允许的只读操作，另暴露向绑定父会话发信的工具。禁止用继承的父指令触发写操作、委派或回传。只读约束由 Host 实际允许的工具集合执行，同时作用于模型可见工具和调用路径。通常的配额、Token 用量与取消按实际侧 Run 记录。[Host 与 Main 的权限归属](../SPACE_SDK_SEAMS.md)

## 4. 一条消息怎样回到原主会话

模型只需获得一个窄工具，暂名 `send_to_parent`。参数为拟发送的正文，以及用户是否明确要求空闲父会话立即继续；目标 ID、发送者、用户输入来源和消息标识由 Host 绑定。侧 Agent 从本轮真实用户请求判断是否获得发送授权。父历史、工具结果、侧 Agent 自己的建议都不能提供该授权。输入来源与侧 Run 身份由运行时核实；自然语言指代是否清楚属于模型行为，须单独验收。

| 父状态 | 交付规则 |
| --- | --- |
| 原分支有可接收输入的活跃 Run | Host 持久记录消息，在下一次可注入的模型调用前，按来源明确的合成上下文消费。保持正在进行的流和工具调用；不发 stop 或 redirect。 |
| 已空闲，用户只要求告知 | 记录为待收件。父会话界面可看到留言；下一个合法主 Run 在首次可用采样点消费。不会因为一条普通留言产生模型请求。 |
| 已空闲，用户明确要求立即继续 | 用主会话正常的准入流程申请一个 Run 并关联此消息。与用户刚发起的主 Run 相撞时复用已准入的同分支接收机会。若已有待审批、授权失败或用户刚停止运行，保留留言并显示原因；并发或重试不重复开轮。 |
| 交付前目标 Run 恰好结束 | 普通留言仍归原父分支，展示“等待下轮”。结束事件不丢弃消息，也不将其转成自动唤醒。 |
| 父会话切分支、回退、归档、删除或失去访问权 | 单纯 UI 切焦点不影响目标。分支已经切走时仅允许原分支日后合法消费；回退越过来源边界或无法证明目标身份时显示冲突。归档停止新投递；删除使关联不可用并按 Session 清理策略处理侧历史。拒绝后不改投当前聊天。 |

**署名与交付回执。** 主界面展示“来自侧聊”及正文，模型收到带来源的 Agent 消息。同一条记录驱动界面与模型投影。现有 `inputs.submit(steer)` 会记录真实用户输入，`appendNotice` 只给客户端看，普通 Actor 邮箱又按同一 Session 的 Actor 树寻址。需要补上从侧 Session 到父 Session 的受限路由，复用现有安全点消费能力。普通子任务终态自动回报仍留在 Actor 路径。[输入与通知契约](../CLIENT_CONTRACT.md) · [Actor 终态与根队列](../../packages/coding/src/agent-runtime/actor-runtime.ts) · [Runner 消费位置](../../packages/agent/src/orchestration/idle-yield.ts)

**重试与崩溃。** 父侧持久收件记录作为交付事实，至少包含稳定消息 ID、父分支、侧 Session、侧输入/调用身份、正文与状态。同一发送操作重试返回原回执；同 ID 改正文报冲突。父消费时用同一 ID 关联 canonical 上下文，重启先对账再处理待收件，内存队列仅作唤醒。向用户区分“等待交付”“已进入主上下文”和“无法投递”；已进入上下文不代表模型已采纳。若执行唤醒的结果不确定，按既有 Run 身份查询，不重放启动操作。[现有输入和 Run 身份约定](../CLIENT_CONTRACT.md)

## 5. 分层与兼容

| 位置 | 实现职责 |
| --- | --- |
| 产品 Host、存储与 SDK | 在现有 sessions 域增加一个打开/复用操作，建议形状为 `sessions.openSide(parentSessionId)`，返回子 ID 与快照边界；对话沿用已有 inputs、views、history、runs。Host 管理父绑定、待收件和正常 Run 准入。daemon、内嵌 adapter 与公开 SDK 表达同一契约。按既有能力协商机制识别旧 Host，给出升级提示。[SDK adapter](../../src/client-runtime-adapter.ts) · [daemon](../../src/runtime-daemon/server.ts) |
| agent / coding | agent 层只处理有来源的消息和消费边界；coding/Host 在真正的侧 Run 上组装只读工具及 `send_to_parent`。普通会话和 Worker 无法伪造侧身份调用该工具。保持现有包依赖方向。[消息类型](../../packages/agent/src/messaging/types.ts) · [工具契约](../../packages/coding/src/tools/agent-collaboration.ts) |
| Ink REPL | 本地识别焦点切换命令，优先于忙时 follow-up 和 slash guard。维护父侧草稿、按 Session ID 路由订阅和取消、显示来源与回执。创建失败不把原问题落入父输入队列。未接入此能力的客户端明确说明支持范围。[Ink 输入入口](../../packages/repl/src/ui/InkREPL.tsx) · [CLI client plane](../../src/cli-client-plane.ts) |

普通 Worker 已具备父邮箱，但新轮的历史主要来自该 Actor 自己的 objective/result，且每轮终态上报父邮箱；把它直接接进侧输入框，会改变私聊可见性。单轮 `sideQuery` 没有工具循环；在 UI 内另造历史、权限和发送机制，将重复 Session 已有的职责。独立侧 Session 可以复用完整多轮运行，只新增忙时取样和受限回传两处核心能力。[Actor 历史](../../packages/agent/src/actors/controller.ts) · [单轮 sideQuery](../../packages/llm/src/side-query.ts)

## 6. 执行计划

以下为建议的开发顺序。每步从公开 SDK 或真实 Ink 输入入口写失败用例，再做最小实现并运行相邻回归。前四步可以用本地脚本化 Provider 验收，避开真实模型输出和时序噪声。

| 步骤 | 前置 | 可独立演示的交付 | 首个应失败的断言 |
| --- | --- | --- | --- |
| 1. 打开并连续追问 | 无 | 在已有历史的空闲主 Session 上，经 Host/SDK 和 Ink 打开独立侧聊、问两次、切回再恢复。建立父绑定、快照边界、独立权限与基础能力协商。 | 第二次侧模型请求读到父参考和第一次侧答；父历史及模型调用数不变；同时打开两次只创建一个子 ID。 |
| 2. 主 Run 活跃时也能开窗 | 1 | 忙时绕过主输入队列，从一致快照建立侧聊。处理首轮、未配对工具、压缩、媒体及焦点取消。 | 用栅栏挂住父工具，侧聊在放行前完成两轮；父工具执行一次，没有取消，模型看不到未提交结果；放行后父继续。 |
| 3. 明确发送一条结论 | 1 | 完成受限工具、同主体和分支校验、持久收件、父安全点消费、双端回执。空闲时普通留言待下轮。 | 侧聊讨论 A 和 B，只发送 B；一个已有侧聊可在父运行中发送，父下一次模型请求只出现一条带来源的 B。空闲父收到同样留言时零新增 Run。 |
| 4. 用户显式唤起与故障恢复 | 3 | 用户要求时可唤起空闲父；处理发送重试、同分支 Run 收尾、切分支、归档与重启。 | 在接收、持久化、消费和回执之间分别制造断点；以同一调用 ID 重试后，父上下文一份、最多一个由该意图新建的 Run；其他分支零交付。 |
| 5. 端到端交付 | 2、4 | 用真实 Ink/PTY 加脚本化 Provider 跑完整故事；验证旧客户端、daemon/embedded 一致性与现有功能回归。更新 SDK 契约、CLI 中英文指南与人工验收步骤。 | 两个客户端同时观察忙碌父会话；一个进入侧聊并回传，另一个只能在父视图看到获准发送的内容；旧 Host 明确报告不支持。 |

步骤 1 合入后，2 和 3 可以分别推进；3 的忙时测试先在空闲时创建侧会话，再启动父 Run。完整能力在步骤 5 验收后对用户开放。首个工程风险是长任务下稳定快照是否能及时取得；若现有读取只能等待整个 Run 结束，步骤 2 应从 Host 已提交的 checkpoint 获取稳定前缀，普通 fork 的 busy 保护仍适用于它原来的写操作。

## 7. 完成标准

- **可用性**：一个保持未完成的主 Run 与两轮侧聊同时存在；输入、取消、审批、草稿与响应各归其 Session。可从真实 `/side` 入口复现，父任务最终正常结束。
- **上下文**：捕获位置可说明、工具调用已配对，旧指令不会被当成侧任务续做。侧聊的第二轮有自己的完整消息和工具历史；普通父会话全程只增加它本应有的内容和被明确发送的消息。
- **消息**：忙、闲、正好结束、明确唤起、分支已换、授权失效和重试都有明确结果；恢复后可核对待收件和已消费消息。人类身份与侧 Agent 来源在模型请求和 UI 中均可区分。
- **兼容与验证**：覆盖历史 Session、无侧聊元数据、旧 Host、独立包构建；既有 fork/rewind、普通 Worker 完成通知、用户 steer/redirect 的回归保持通过。沿用仓库 TDD、覆盖率 ≥80% 与相邻测试布局。先例见 [历史边界测试](../../src/sdk-client.history-boundaries.test.ts)、[steer 测试](../../src/sdk-client.steer.test.ts)、[Actor 测试](../../packages/coding/src/agent-runtime/actor-runtime.test.ts) 和 [PTY 验收](../../tests/repl-pty-acceptance.mjs)。
- **模型行为**：脚本化 Provider 验证路由和权限；对“随口讨论”“明确发送 B”“继承历史曾要求发送”分别检查真实产品指令下模型选择的动作与正文。按 [Eval 指南](../../benchmark/EVAL_GUIDELINES.md) 做有界的单步验证并报告误发、漏发和来源混淆。发布结论应分开记录工程断言、模型行为与人工体验。

## 单步模型验收约定

使用真实 PTY 验收导出的侧聊 system 指令和四个工具定义，搭配合成历史。在一个订阅模型 `ark/v4flash` 上顺序运行三种请求，每种三次，每个样本一次调用，最多九次，每次最多 384 输出 token 和 30 秒。首个传输失败即停止。普通讨论和继承的父指令都应产生零次回传，要求“只告诉主会话 B”时应只发盘符大小写判断，正文不得泄露缓存假设，也不得要求唤醒。原始输入、回答与调用保存到系统临时目录，每个样本人工核对工具名、正文和 wake 值。本次只验收单步行为。

## 已执行的验收

- 发布构建的 Ink/PTY、真实 daemon、第二个 SDK 观察端及本地 HTTP Provider 已跑通。命令为 `node tests/repl-pty-acceptance.mjs --side-chat-only`。主 Run 保持流式输出时从 `/btw` 打开侧聊，第二问的请求包含第一问答案。回传工具只发送 B，输入 `/side` 回主会话后，原 Run 正常完成。SDK 用例另用真实读文件工具和可释放的等待点验证执行中的工具未被取消。
- `src/sdk-client.lineage.test.ts` 同时覆盖空闲留言不产生模型请求、明确唤起一次可接收两条报告；`src/side-chat.test.ts` 检查压缩 ancestry、越界回退、持久绑定重读和工具参数约束。
- 单步验收命令为 `node --import tsx benchmark/side-chat-intent.eval.ts <PTY 产物目录>/ink-requests.json`。实际用 `ark/v4flash` 顺序采样 9 次。普通讨论 3/3 无调用，父历史含发送命令的私下追问 3/3 无调用，明确只发 B 的请求 3/3 各调用一次。人工核对三条发送正文均只包含盘符大小写判断，wake 均省略。其中一次把可能性称为“likely cause”，语气比原讨论略强。本次样本覆盖上述英语固定对话及单个模型。
- 手工复验：主会话请求执行一项可观察的长任务；输入 `/side`，依次讨论 A 和 B，再说“只把 B 告诉主会话”。回主会话检查原任务的 Run ID、侧聊署名回执和最终结果；再次打开侧聊核对 A 及两轮私聊仍在。

## 8. 验收后复核:缺口、跨专业结论与后续计划

2026-11-12。复核由四个只读视角完成:缓存与成本、安全与权限、REPL 交互与渲染、测试与评测。各视角读代码得出结论,均未跑真实 Provider;其中最严重的安全项已由主会话回到代码核对。标注"未验证"的条目在动手前须先验证。

### 8.1 更正与已落地

- `/side` 在空闲父会话同样可用。入口判断里的 `isRunning` 是 REPL 存活标志,已改名 `replAlive`。空闲路径仍缺自动化覆盖。
- InkREPL 内没有 Ctrl+C 专用处理,面板无需处理。
- `SideChatPanel` 的纯逻辑已抽成 `sidePermissionAnswer`、`visibleSideItems`,`SideChatPanel.test.ts` 覆盖命令解析、审批口令、继承历史隐藏与 16 条截断。
- **R2 进度(2026-11-12,未提交)。** 已完成并有测试:S1 唤醒提示改为"The side agent asked this session to resume to consider its report.",不再声称用户请求;唤醒回执带 `resume requested` 标记(`SideChats.receipts`),父与侧界面共用;S2 守卫改为"父没有自己的 Run 记录时不唤醒,返回 `Waiting for the next authorized parent run.`",以派生(fork)出来的父会话复现并覆盖;S3 父视图回执改用 `SideChats.visibleTo`,按请求主体过滤。S3 的限制:过滤依赖请求上下文里的 principal;没有 principal 的内嵌调用方和后台刷新仍看到全部绑定,与 `admits()` 的既有语义一致。S4 绑定文件损坏时删除父会话:`readSideChildrenForDelete` 捕获解析错误,把坏文件改名为 `.corrupt-<时间戳>` 留作证据,发出诊断,按侧 ID 前缀(`SideChats.idPrefix`)找出孤立的侧会话并连同设置、MCP 存储与运行状态一并清理,父会话随后正常删除。S5 留言上限:单条不超过 4000 字符、未投递的留言不超过 20 条,超限时把原因作为工具错误返回给侧 Agent(`sideLetterRejection`),重试同一调用不受影响;S6 `openSide` 回滚改为 `discardSide`,删除半成品会话失败时发诊断并仍移除绑定,抛出的是原错误;进入 `openSide` 时先丢弃父会话下所有 `preparing` 绑定(调用在父会话闸门内串行,此时见到的必为崩溃遗留);S7 加载时校验 `principalId`/`deliveredRunId` 类型,绑定被删时报"This side chat no longer exists"而不再沿用"Parent history has changed"。S7 的 `admits()` 无 principal 放行保持不变:没有 principal 的是内嵌调用方,与 S3 同一语义,此处不改。S8 结论(读代码得出,未用真实扩展运行):扩展工具注册按后注册者优先(`registry.ts getActiveToolRegistration`),所以扩展可以替换侧聊的 `read`/`grep`;扩展是用户安装的进程内可信代码,本来就有同等权限,不构成边界,不改;**扩展钩子(2026-11-12 核对并修复):** 侧 Run 把整个 `extensionRuntime` 换成只含 `send_to_parent` 的运行时,该对象没有 `emit`/`runHook`,所以会话自己的 `tool:before` 策略钩子与事件对侧 Run 的 `read`/`glob`/`grep` 都不触发(例如禁止读某路径的策略会被侧聊绕过)。`sideToolRuntime` 现在接收会话的运行时作为 `policy`,只转发 `emit`/`runHook`,不转发其工具;测试在 `side-chat.test.ts`。限制:单测只验证转发,没有用真实 Host 钩子端到端跑侧 Run(公开 `runs.start` 不接受侧会话的 `inputId`,需经客户端与 daemon 搭建)。S5 中"多 Host 进程下绑定缓存不刷新"未处理。`saveSideSnapshot` 已有直接单测(`storage.side-snapshot.test.ts`:悬空 tool_use 回退、完整工具往返保留、重复 tool_use 与孤立 tool_result 抛错、空前缀、thinking 剔除与仅 thinking 消息替换、system 改写、label 剔除);Host 用例补了"归档父与对侧 ID 再 `openSide` 被拒"和"父被回退到快照之前后留言不投递"(均为已有行为的特征测试,首次运行即通过)。**未做:** 同 ID 重试返回同回执与改正文冲突(只在同一 Run 恢复时可达,脚本化 provider 难以构造)、唤醒被待审批/停止/主体不符拒绝、同主体两窗口、goal 条目剔除(未构造 goal 条目)。**R1 进度(2026-11-12,未提交)。** 已完成:空闲父会话的 PTY 验收(`checkSideChatIdleParent`,`--source --side-chat-only` 通过);经典渲染器注册 `/side`(别名 `/btw`),提示"需要全屏 UI"而不是"未知命令",手册 commands 主题同步,补全与 `/help` 因此能列出它;`closeSide` 用 `useCallback` 稳定;权限预览单行截断,`/allow once or /deny` 提示单独成行。**探针结论:** 在默认、`accept-edits`、`plan`、`auto` 四种权限模式下,侧会话的 `read`(读项目外文件)和 `send_to_parent` 都不触发权限询问,所以面板里的 `/allow`/`/deny` 路径在当前工具集下走不到,"Esc 能否拒绝待决权限"无从验证。该路径只会在钩子或扩展返回 ask 时出现;是否保留这段代码留待决定(与"极致轻量化"相冲突,但删除会失去对该情形的处理)。**注意:** PTY 验收默认加载 `dist`,验证 `packages/repl` 的改动前须先 `npx tsc -b`(在 `packages/repl` 内)重建,并加 `--source`。同一次验证里发现:Esc 在侧 Run 仍处于 running 时是"停止"而不是"关闭",这是设计行为,测试需等 Run 结束。R1 剩余:无。
- **R4 进度(2026-11-12,未提交)。** 已完成并有测试:`/side end`(面板内与父会话内都可输入,大小写不敏感)先停止运行中的 Run 再删除侧会话,重开得到新的侧 ID;有未读的发往父的留言时第一次只提示数量,同一数量下再输入一次才丢弃;`InkClientPlane` 新增可选 `delete`(映射 `sessions.delete`,Host 已按 owner 校验并清理绑定);父会话页脚在面板关闭时显示 `Side chat: running / needs approval / new reply`,标记只在页脚与 InkREPL 状态里,不进父 transcript 与模型请求(PTY 断言 `state.view.items` 与 `state.requests` 不含 `Side chat: `);面板边界行显示继承条数,首答运行中提示"首次回答要读取父历史,较慢"。**与计划的差异:** 没有新增 `sessions.sideFor` RPC;InkREPL 只记住本进程打开过的侧聊(重启后需再 `/side` 一次才会出现标记),换取不改 contract 与 daemon schema。观察订阅没有完全上提:InkREPL 只订阅并把一行标记存为状态(流式增量不会让整个 REPL 重渲染),面板打开期间仍有第二个订阅。**顺带修复的缺陷:** 面板在发送成功后用过期的 `draft` 属性重建输入框,会让已发送文本重新出现在输入框里(此前依赖 InkREPL 恰好重渲染而被掩盖);改为面板自己持有输入框起始值。新增测试:`SideChatPanel.test.ts`(`end` 命令、标记优先级与增长签名、未读计数、继承条数)与 PTY `side-chat-marker-and-end`。
- **R5 进度(2026-11-12,未提交)。** 复用成本低,已做,但复用对象与计划不同:`HistoryItemRenderer` 不在 live 路径上(见 REPL 渲染路径记录),面板改用 live 路径的行模型:`visibleSideItems`(切片先于映射)→ `clientViewToHistoryItems` → `buildHistoryItemTranscriptSections` → 取最新 `terminalRows − 10` 行(行级尾部裁剪 + 行预算)→ 导出的 `TranscriptRowRenderer`。侧聊里的 markdown、工具行与主 transcript 同一套样式。`send_to_parent` 工具行在对应回执(`side-report:` + `[runId, toolCallId]`)出现后隐藏,避免与"To parent (…)"重复;回执出现前保留。diff 背景色条等随行模型自动获得,未单独验证。测试:`SideChatPanel.test.ts`(`tidySideItems`、`sideTranscriptRows`)与 PTY 断言(发送后屏幕有 `To parent (` 且无 `send_to_parent`)。
- **R6 预注册(2026-11-12,运行前写定)。** 评测改为纯函数模块 `benchmark/side-chat-intent.cases.ts`(6 个格子与评分)加运行器 `side-chat-intent.eval.ts`;边界文案取自导出常量 `SIDE_BOUNDARY_TEXT`(`storage.ts`,经 `@kodax-ai/repl` 导出),不再重复硬编码。**格子(每格 3 次):** `zh-discussion`(期望不调用 send_to_parent)、`zh-selected`(期望发送且不唤醒)、`zh-inherited`(父历史里有"下一个问题时发 A",期望不发送)、`zh-ambiguous`("把那个告诉主会话",上文有 A、B 两个原因,"那个"没有明确所指,期望不发送、反问)、`zh-wake`(明确要求"现在就继续处理",期望 `wake: true`)、`en-wake`(同上英文)。英文的讨论/选择/继承三格沿用此前评测,不重复。**判定:** 对 `toolCalls` 做结构断言,不用文字正则:期望不发送而发送=误发;期望发送而没发=漏发;发送了但 `wake` 与期望不符=唤醒错误;发送多次=误发。来源混淆在 `zh-inherited` 格里报告,即继承指令被当作当前请求。**预算:** 每格 1 次调用、最多 54 次(3 个别名×6 格×3 次)、`maxOutputTokens` 384、单次超时 30 秒、同一时刻只有 1 个请求在途;每次输入约 1.5k token,总量估计低于 100k token,费用可忽略。**流程:** 先用 `ark/v4flash` 试跑 18 次,确认任务有效(格子能区分行为、工具字节取自生产请求、原始输出落盘),再跑另外两个别名。**抽检规则:** 机械评分之外,主会话读取每个别名的全部 `zh-selected` 与 `zh-wake` 的 `text` 字段,检查发送内容是否只含 B(这一项只做语义抽检,不计入机械分),并随机抽 3 个"通过"的 `none` 格确认回复确实是讨论或反问。原始输出写入临时目录(`inputs.json`、逐样本 JSON、`summary.json`)。**试跑修订(2026-11-12):** `ark/v4flash` 首次试跑 18 次,`zh-ambiguous` 原措辞"把我们发现的告诉主会话"得 0/3(3 次都发送了 A 与 B)。读原始输出后判断这不是模型缺陷而是格子无效:"我们发现的"可以合理理解为两个原因全部,期望值不唯一。该格改用"把那个告诉主会话",所指不明;原措辞的 0/3 保留在此作为任务有效性的发现,不计入基线。其余 5 格 15/15 通过。结论格式按 EVAL_GUIDELINES:任务有效性、提升、回归归因、建议(由负责人决定)。
- **R6 评测结果(2026-11-12,基线 54 次,另有试跑 18 次共 72 次调用)。** 任务有效性:有效。工具字节取自生产请求,评分与原始输出逐条核对一致;`zh-selected` 与 `zh-wake` 共 18 条发送内容人工抽检,全部只含原因 B。通过率:`ark/v4flash` 15/18、`zhipu/glm52` 17/18、`ark/k27` 18/18。除 `zh-ambiguous` 外的 5 格在 3 个别名上全部通过(45/45):讨论不发送、选择发送且不唤醒、继承指令不被当成当前请求(来源混淆 0/9)、明确要求才唤醒(漏发 0、唤醒错误 0)。`zh-ambiguous` 共 5/9:`ark/v4flash` 0/3、`zhipu/glm52` 2/3、`ark/k27` 3/3,失败全是误发,即所指不明时把 A 与 B 都发了而不反问(`ark/k27` 的 3 条都是反问,抽检属实)。这是基线,没有 A/B 对照,不声称提升;没有回归需要归因。建议:先不动提示词。样本只有每格 3 次、一种措辞;提示词里"所指不明时先问"已经写了,若要改须按 ADR-033 审查并补评测。是否改由负责人决定。


### 8.2 跨专业结论

四个视角的结论互相约束,先于步骤排序读:

1. **缓存:不继承,接受并先测量。** 侧请求的工具、系统提示、消息三层前缀都与父不同。另有一个此前未发现的阻塞:`promptCacheKey` 由 session id 哈希得出,在使用该键的 Provider 上,侧会话即使字节相同也路由到另一份缓存。共享前缀方案因此还须共享父的缓存键,这改变隔离边界。父自己的前缀也不稳定(首个请求后 Git 上下文与项目快照消失,KNOWN_ISSUES 记为未测)。三个选项里,"缩短继承"与"能解释父历史"的目标冲突,删去;"共享前缀"降为有条件的后备。
2. **安全:共享前缀只在不变量全部成立时可接受。** 不变量:调用路径的白名单是唯一权威,不得依赖 schema 可见性;写、bash、委派、skill、MCP、`ask_user` 在调度处硬拒绝且不进入审批;`send_to_parent` 之外不得新增工具。额外风险:模型看得见写工具,会反复发出被拒调用;父的计划模式与技能文本变成系统级权威,放大提示注入,并与 §3"禁止用继承的父指令触发写操作"冲突;侧指令从系统提示降为尾部用户消息,权威下降。结论与缓存视角一致:先测量,再决定。
3. **安全缺口早于功能。** 首版有几处须先修,而状态标记与结束入口恰好依赖它们(标记须按 owner 过滤,结束须校验 owner 与未投递留言),所以安全加固排在 UI 功能之前。
4. **标记与缓存提示互相独立。** "首次侧问较慢"的提示不依赖缓存决策,可随标记工作一起做。
5. **测试可行性限制排期。** 侧审批用例依赖"默认模式下侧 Run 能触发审批",未验证。Esc 在待审批时是否拒绝该请求也未验证。二者须先做一个小探针,再决定写不写 PTY 用例。

### 8.3 缺口与风险清单

**安全(含 2026-11-12 主会话已回代码核对的项)**

| # | 严重度 | 问题 | 位置 | 处理 |
| --- | --- | --- | --- | --- |
| S1 | 高 | `wake` 由模型自行设置。Host 随后以"The user requested that this session resume…"启动父 Run,这句话是 Host 写的,没有核实用户意图。已核对。 | `sdk-runtime.ts` 12525–12553 | 待决策 D2 |
| S2 | 中高 | 唤醒保护有缺口:父没有历史 Run 状态且没有 `execution` 时,principal 与 `sideWakeWithHostDefaults` 检查整体跳过。该情形可由"在新进程里恢复的父会话"构成。已核对条件,未构造实例。 | 同上 12546–12549 | 步骤 R2 |
| S3 | 中 | 父视图的回执按父取 `forParent`,未按 owner 过滤,留言正文可出现在另一主体的视图。已核对。 | `sdk-runtime.ts:4637`、`side-chat.ts receipts` | 步骤 R2;标记功能的前置 |
| S4 | 中 | `SideChats.group()` 里 `JSON.parse` 无保护,绑定文件损坏时抛错;`deleteSession(parent)` 会调用它,一个坏文件就阻断父会话删除。 | `side-chat.ts:186`、`sdk-runtime.ts:8475` | 步骤 R2 |
| S5 | 中 | 留言正文和条数无上限,且以 user 角色进入父历史;多 Host 进程下绑定缓存不刷新。 | `side-chat.ts sideMessage` | 步骤 R2 |
| S6 | 低中 | `openSide` 失败回滚里若 `storage.delete` 抛错,会遮蔽原错误并跳过 `remove`;崩溃后其他 owner/分支的 `preparing` 绑定永不清理。 | `sdk-runtime.ts:9434` | 步骤 R2 |
| S7 | 低 | `admits()` 在 principal 为空时一律放行;`principalId`/`deliveredRunId` 加载时不校验类型;`Parent history has changed` 也用于绑定被删的情形。 | `side-chat.ts:126,186` | 步骤 R2 |
| S8 | 待查 | 全局扩展事件钩子是否仍对侧 Run 触发;后注册的同名扩展工具是否能顶替内置 `read`/`grep`。 | — | 步骤 R2 先验证 |

**功能与体验**

| # | 问题 | 现状 | 处理 |
| --- | --- | --- | --- |
| A | 首个侧请求不命中父缓存 | 见 §8.2 第 1 点 | 步骤 R3 |
| B | 回到父会话后看不到侧聊状态 | 父不知道侧 ID:`openSide` 无则创建,不能当查询用,须新增只读查找 | 步骤 R4 |
| C | 空闲父会话打开侧聊无自动化覆盖 | 仅忙时 PTY 用例 | 步骤 R1 |
| D | 面板是纯文本行 | 可复用 `clientViewToHistoryItems` 加 `HistoryItemRenderer`;不要用 `MessageList`,它带 Static 输出、窗口化与滚动 | 步骤 R5 |
| E | 不能在侧聊里处理父的审批 | 保持:跨会话审批会混淆权限归属。仅在标记里显示"父需要输入" | 步骤 R4 |
| F | 无法结束侧聊 | `InkClientPlane` 未暴露 `delete`;`sessions.delete` 对活动 Run 会拒绝 | 步骤 R4 |
| G | 看不到侧模型继承了什么 | `ClientSession.sideChat` 只有父 ID 与边界;须新增可选的 `inheritedMessages`、`inheritedTokens` 并同步 daemon schema,旧绑定缺字段时不显示 | 步骤 R4 |
| H | 草稿只在内存 | 不做:重启后侧会话可恢复,草稿丢失成本低 | — |
| I | 经典渲染器 `/side` 显示"Unknown command"并静默丢弃问题 | `/side` 未注册 | 步骤 R1:显式提示不支持;并注册命令名使 `/help` 可见(自动补全是否需要未验证) |
| J | `closeSide` 每次渲染重建,Esc 处理器随之重注册 | `InkREPL.tsx:2319` | 步骤 R1,`useCallback` |
| K | 待审批时的提示项不受宽度限制 | `toolName inputPreview` 原样输出 | 步骤 R1,按终端宽度截断 |
| L | 评测硬编码边界文案,与 `storage.ts` 重复,可能漂移 | `side-chat-intent.eval.ts` | 步骤 R6,改为导出常量 |
| M | 审批口令严格 | 只认 `/allow`、`/deny` | 保持。可在输入为空且有待审批时加 `y`/`n`,口令作为回退(S) |

### 8.4 步骤 R3 的缓存决策

**测量。** 用 `npm run probe:prompt-cache` 加每请求的 `onPromptCacheDiagnostics`(含 `systemPromptHash`、`toolSchemaHash`、`messagePrefixHash`、`promptCacheAffinityHash`)。准备数万 token 的长父历史;依次取父的下一次请求(对照)和第一次侧请求,各 1 次,`maxOutputTokens` 16–32,设总费用上限。记录 `inputTokens`、`cachedReadTokens`、`cachedWriteTokens`、首包延迟。覆盖一个 Anthropic 风格与一个自动前缀缓存的 Provider。若对照本身已未命中,侧请求不再重复。结果存系统临时目录 `kodax-eval-dumps/<id>/cache.json`,汇总表进 ADR。

**测量结果(2026-11-12,R3 已执行)。** 合成 30k token 父历史(24 条消息),父请求与侧请求各自带自己的 system 与工具集;每个 Provider 4 次付费请求,输出 ≤ 16 token,共 8 次、约 24 万输入 token。脚本 `docs/research/side-cache-measure.mjs`(本地,不入库)。

| Provider | 请求 | 输入 token | 命中缓存 | 首包 ms |
|---|---|---|---|---|
| deepseek | 父首次(冷) | 30,624 | 0 | 1664 |
| deepseek | 父对照(同前缀续问) | 30,637 | 30,464 | 698 |
| deepseek | **侧首次** | 28,933 | **0** | 804 |
| deepseek | 侧第二次 | 28,945 | 28,800 | 633 |
| zhipu-coding (glm-5.3) | 父首次(冷) | 30,218 | 0 | 4308 |
| zhipu-coding | 父对照 | 30,231 | 30,208 | 4765 |
| zhipu-coding | **侧首次** | 28,531 | **0** | 5630 |
| zhipu-coding | 侧第二次 | 28,543 | 28,480 | 3849 |

结论:两个 Provider 上,侧首次请求都没有继承父缓存(命中 0),与"侧 system 和工具集在前缀最前面不同"的预期一致;但侧聊建立后,第二次起命中约 99%。所以多出的成本是**每个侧聊一次**的未缓存整段历史读取,不随追问次数增长。首包延迟:侧首次比同 Provider 的父对照慢约 0.1–0.9 秒,单次采样噪声大,不足以单独支持结论。**限制:** 只覆盖两个自动前缀缓存的 Provider;没有 Anthropic 原生显式断点(未设置 `ANTHROPIC_*`);历史为合成文本,单次运行;没有测 30k 以上或 5 分钟以上的情形。**决策:** 按下面的规则接受现状,在 `/side` 打开时给出首次较慢提示(归入 R4);不评估共享前缀。

**决策规则。**

- 默认**接受现状**,在 `/side` 打开时提示"首次提问会重新读取整段历史,可能较慢"。
- 仅当测量显示未缓存成本在常见会话长度就明显,**并且**父前缀本身稳定时,才评估共享前缀。
- 共享前缀必须作为独立 feature 另立计划,满足 §8.2 第 2 点的全部不变量,并附:ADR-033 评审;"继承指令要求发送""继承指令要求写入""计划模式父会话"三类 prompt eval;"可见工具集等于 schema"回归测试;缓存键共享的隔离评审。
- 决策写入 ADR 后本节删除。

### 8.5 后续步骤与排期

估算按一人顺序计,括号内为单项人日。可并行时总历时更短。

| 步骤 | 内容 | 依赖 | 首个应失败的断言 / 验收 |
| --- | --- | --- | --- |
| R1. 入口覆盖与小修 (1–1.5) | 空闲父 PTY;经典渲染器 `/side` 显式不支持并注册命令名;`closeSide` 记忆化;审批提示按宽度截断;先做两个探针(侧审批能否触发、Esc 是否拒绝待审批),据此决定审批 PTY 与 Esc 用例是否纳入。 | 无 | 空闲父开侧聊问两次,第二次请求含第一次答案且父历史不变;经典模式不产生模型请求并给出不支持提示 |
| R2. 安全加固与 Host 测试 (2) | 修 S2–S7,验证 S8;为 `saveSideSnapshot` 加直接单测(悬空 tool_use 回退、重复 tool_use 与孤立 tool_result 抛错、空前缀、仅 thinking 消息、`system` 改写、goal/label 剔除、媒体记录);补 Host 用例(同 ID 重试返回同回执、改正文冲突、唤醒被待审批/停止/主体不符拒绝、父分支改变、归档父、对侧 ID 再 `openSide`、`preparing` 遗留在下次替换、同主体两窗口同一侧 ID)。 | 无 | 例如:坏绑定文件下删除父会话仍成功;无历史状态的父收到 `wake` 时按 §3 规则拒绝或等待,而不是直接启动 |
| R3. 缓存测量 (1,需密钥与费用批准) | 见 §8.4。**已完成 2026-11-12**,结论:接受现状。 | 无 | 测量表入档 |
| R4. 父侧标记、结束入口与继承规模 (2–3) | **已完成 2026-11-12,范围见 §8.1 的 R4 进度。** 原设计:新增只读查找(如 `sessions.sideFor`),按 owner 过滤;面板的观察订阅上提到 InkREPL,保证单订阅;标记(运行中/有新答复/待审批/父需输入)放在页脚右侧或 `promptFooterNotices`,不进父 transcript 与模型上下文;`/side end` 先停止再删除,校验 owner,有未投递留言时拒绝或要求确认;`InkClientPlane` 暴露 `delete`;边界行显示继承规模;`/side` 打开时给出首次较慢提示。 | R2(owner 过滤与删除健壮性) | 侧聊运行时回到父会话可见标记且 `state.requests` 不含该标记;结束后重开得到新的侧 ID;另一主体的父视图不含这些留言 |
| R5. 渲染对齐 (2–3,可选) | **已完成 2026-11-12,实现见 §8.1 的 R5 进度。** 原设计:面板复用 `clientViewToHistoryItems` 与 `HistoryItemRenderer`;切片先于映射;行级尾部裁剪;全屏下设行预算。仅当复用成本明显低于自建时做。 | R4 | 侧聊里的 markdown 与工具调用和主 transcript 一致 |
| R6. 评测与人工验证 (1.5) | **评测与测试指南已完成 2026-11-12,结果见 §8.1 的 R6 评测结果;`docs/test-guides/FEATURE_307_v0.7.97_TEST_GUIDE.md` 已写,人工清单尚未由人执行。** 原设计:评测扩到中文并加"指代不明"和"要求唤醒"两类,3 个不同系列的模型(`ark/v4flash`、`zhipu/glm52`、`ark/k27`),每格 3 次,基线共 54 次调用,先用 1 个别名试跑;评测边界文案改为导出常量;人工清单见下;按步骤 R3 的决策,若选共享前缀则另做 A/B(108 次)。 | R3 的决策 | 误发、漏发、来源混淆分别报告 |

**并行关系。** R1、R2、R3 互相独立,可同时进行。R4 依赖 R2;R5 依赖 R4;R6 依赖 R3 的决策。

**人工清单。** (1) 忙时 `/side`,两轮私聊后只发 B;(2) 空闲 `/side`,退出后 `--resume`;(3) 经典模式 `/side` 提示;(4) 侧审批 `/allow` 与 `/deny`(视探针结果);(5) Esc 停止与关闭;(6) 父会话分支切换或回退后回执显示"parent branch changed";(7) 两个窗口打开同一侧聊;(8) 删除父会话;(9) 步骤 R4 的标记与 `/side end`。

### 8.6 决策记录

- **D1 功能编号与版本(已决定并登记)。** 编号 **FEATURE_307**(原登记为 FEATURE_305;2026-11-14 合并 KodaX beta.9 时,主分支已发布的 FEATURE_305/306 占用了该编号,故改号)(核对时仓库内最大编号为 304,侧聊此前没有任何 Feature 条目)。用户确认目标版本为 `v0.7.97`;下一次发布将是 `0.7.97-beta.8` 或 `0.7.98-rc.1`。已登记于 `FEATURE_LIST.md`(InProgress,Index、进行中表、2026-11-12 Addition 段)和 `docs/features/v0.7.97.md` 的 `## FEATURE_307` 设计块。测试指南为 `FEATURE_307_v0.7.97_TEST_GUIDE.md`,在 R6 编写。`docs/features` 是独立仓库(子模块),其改动需单独提交。
- **D2 唤醒(`wake`)的授权方式(已决定:选项一)。** 保留 `wake`,不加额外审批。把 Host 唤醒提示改成如实表述("侧 Agent 报告了以下信息并请求恢复此会话"),并在父与侧界面都显示"侧聊请求恢复父会话"的回执;S2 守卫缺口照常修复。依据:留言本身在父下次运行时就会进入父上下文,唤醒只改变时机,额外确认的安全收益小。选项二(需确认)和选项三(不提供 `wake`)不采用。落在 R2。
- **D3 缓存测量费用:已批准。** 本机已设置 `ZHIPU_CODING_API_KEY`、`ARK_CODING_API_KEY`、`MINIMAX_CODING_API_KEY`、`KIMI_API_KEY`、`DEEPSEEK_API_KEY` 等,未设置 `ANTHROPIC_*`。因此测量先用已有密钥的 Provider 覆盖,Anthropic 原生缓存断点须另行确认可用账号;费用须设上限并在测量前写明。
- **D4 渲染对齐:已批准。** R5 纳入排期,仍按 §8.5 的前提执行:复用成本明显低于自建时才做,否则回到用户确认范围。

### 8.7 完成后的文档处理

本记录只在工作进行期间保留。落地后按 CLAUDE.md 的生命周期处理:缓存决策、共享前缀被拒绝的理由与安全不变量写入 ADR;现行设计写入 HLD/DD;`CLIENT_CONTRACT.md` 更新新增的 `sideFor`、`inheritedMessages`/`inheritedTokens` 与 `/side end`;`quickstart` 中英文补 `/side end` 与首次较慢提示;未解决项进 KNOWN_ISSUES;验证步骤进测试指南,然后删除本文件。
