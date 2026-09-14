# KodaX Client 接口契约

本文面向 CLI、SDK 和未来 Web 客户端。产品客户端通过 `KodaXProductClient` 读取 Host 事实、提交意图；Host 执行并保存工作。显示层不读取或写入 Session 文件，不另建运行状态权威。

类型与行为以 [client-contract.ts](../packages/coding/src/client-contract.ts)、[SDK 入口](../src/sdk-client.ts)、[运行时适配器](../src/client-runtime-adapter.ts) 为准；产品决策见 [FEATURE_298 D01/T02](features/v0.7.97.md)。本文覆盖公开产品接口，不把 `/runtime` 的全部底层管理、执行和诊断 API 提升为产品承诺。

## 连接、启动与所有权

| 层 | 入口/职责 | 边界 |
| --- | --- | --- |
| 纯类型 | `@kodax-ai/coding/client-contract` | `KodaXProductClient` 和数据类型；无 Host 实例、存储对象、执行回调或 Node 启动代码 |
| Node 产品 SDK | `@kodax-ai/kodax/client` 的 `connectKodaXClient(options)` | 被动连接现有兼容 Host；不会启动、升级或替换进程 |
| Node 产品启动器 | `/client` 的 `ensureKodaXClient(options)` | 委托统一 `ensureKodaXRuntime` 并返回同一产品投影；启动和更新不复制到 UI |
| Node 启动器 | `@kodax-ai/kodax/runtime` 的 `ensureKodaXRuntime(options)` | 负责本机启动、兼容性校验和必要更新；返回底层 Runtime |
| 底层被动连接 | `/runtime` 的 `connectKodaXRuntime(options)` | `autoStart: true` 明确拒绝；启动必须使用 ensure |
| 显式嵌入 | `/runtime` 的 `createKodaXRuntime({ mode: 'embedded' })` | 独立库/受信任宿主的执行接缝；不能作为产品连接失败后的私有 owner 回退 |

两个产品入口都返回 `Promise<KodaXProductClient>`；选项可以全部省略。连接时要求 Host 宣告整体 `productClient` v1 契约，覆盖统一业务入口和输出事实；不按单个方法维护客户端能力矩阵。旧 Host 缺少该契约时被动 connect 明确拒绝，ensure 仅沿用现有空闲升级机制，不能强停忙碌 Host 或回退私有执行。

| 选项 | `connectKodaXClient` | `ensureKodaXClient` | 含义 |
| --- | --- | --- | --- |
| `homeDir?: string` | 支持 | 支持 | 包含 `.kodax` 的目录，与 CLI `--home` 的基础目录含义一致 |
| `profile?: string` | 支持 | 支持 | 本地配置/连接 profile |
| `clientInfo?: RuntimeClientInfo` | 支持 | 支持 | 客户端元数据及可选的 Host 颁发身份凭据 |
| `endpoint?: string` | 支持 | 不支持 | 指定本地 socket/Windows named pipe；省略时从本地 profile 解析 |
| `token?: string` | 支持 | 不支持 | 显式 Host token；省略时从所选本地 profile 读取 |
| `daemonStartupTimeoutMs?: number` | 不支持 | 支持 | 本机 Host 启动等待期限，单位毫秒；省略时采用运行时默认值 |

`EnsureKodaXClientOptions` 扩展 `Omit<ConnectKodaXClientOptions, 'endpoint' | 'token'>`，避免把任意远端连接当作可由本机更新的安装。`RuntimeClientInfo` 在提供时要求 `name`，其可选字段是 `title`、`version`、`clientType`、`instanceId`、`instanceSecret`。clientType 为 app/cli/diagnostic/automation/unknown，仅供展示；name/title/version 也不证明权限。instanceId/instanceSecret 是 Host 颁发的身份与凭据，应按底层身份契约保管，不能通过自填展示元数据获取管理权限。

`endpoint` 不是 HTTP/WebSocket URL。运行时连接实现依赖 Node；浏览器可通过 `import type` 使用纯契约，但当前没有可直接在浏览器运行的远程 transport 或已实现 Web 服务。

同一实际 sessions 存储根只能由一个独立 Host 写入；profile 是连接/配置名称，不是绕过存储所有权的手段。启动器需要区分包版本、运行中的 Host 实例以及实际加载的构建：相同版本号并不证明 clean/build 前后的代码相同。内部 `RuntimeIdentity.build` 的 origin/fingerprint 用于启动器比较与诊断，不进入业务 view，UI 不据每次补丁维护能力矩阵。

启动器先验证当前磁盘构建与自身加载时冻结的构建一致；长寿命旧 SDK 在磁盘被重建后明确拒绝代为更新。相同版本、相同 origin、不同 fingerprint 的 Host 才可据构建差异执行正常空闲更新。相同版本但 origin 不同的 Host 归属另一安装，即使 fingerprint 相同也明确拒绝由本启动器接管；缺少构建身份的同版本旧 Host 同样须明确报错。能够证明语义版本较旧的原更新路径仍保留。被动 connect 不因本机构建不同要求替换兼容 Host，从而允许其他版本客户端及未来 Web 连接。

构建身份按实际文件字节计算，不判定代码是否语义等价。origin 是实际启动入口的规范路径（Windows 统一大小写），fingerprint 是有序运行文件路径、大小和内容的 SHA-256。源码启动覆盖 `src` 生产代码、四个 workspace 的实际 `dist`、当前平台的 native 产物、包及锁文件和运行所需配置模板/启动脚本；dist 启动覆盖实际 bundle、分块与随附运行资产；binary 启动覆盖实际可执行文件及 builtin/vendor/native/worker 等 sidecar。它不读取用户配置，不创建 build manifest 或新配置。

哈希跳过测试、文档、声明文件、source map 和构建元数据/缓存；源码模式读取已编译 native 候选，不扫描 Rust 源码或其编译缓存。实现用固定 64 KiB 缓冲区分块读取；缺失必需文件、读取失败或目录循环明确报错。字节相同的重建可复用 Host；字节不同即使语义相同仍是不同构建。该身份不是文件监视器：重建后的旧 SDK 需重新加载，磁盘被并发修改不构成任意时点原子安装保证。

自动更新仅适用于可验证身份、可正常管理且空闲的旧 Host：请求正常 shutdown，等待原进程真实退出，然后启动并连接目标构建。需要更新但 Host 忙碌、身份变化或不能确认退出时明确失败并给出重试入口；较新且兼容的 Host 可直接连接，较新但不兼容时明确拒绝，不降级。并发启动的初始化连接冲突按既有预算短暂退避后重试，不依赖可能滞后的状态文件猜测接入是否开放；管理或业务操作失败不因此重放。启动中的 owner 等待就绪，退出中的 owner 等待精确进程退出后再进入原有锁竞争。整个过程不强停工作、不启动第二个写入者。普通 connect 保持被动，即使启动器能够更新也不替用户执行更新。

多个启动器同时刷新时，临时连接也受 `connected_clients` 保护。失败者先释放连接，在同一个启动截止时间内退避并重新探测；重试不重置期限，也不因客户端自称 launcher 而忽略它。底层启动取消信号会终止退避。竞争持续到期限时明确失败，不保证任意竞争都能收敛，不新增跨进程选举或恢复票据。

`disconnect()` 仅释放本连接；`ClientObservation.close()` 仅结束一个观察。它们不表示 Run 停止或 Host 退出。`host.shutdown()` 请求空闲 Host 正常关闭，返回 `{ accepted: true }` 只代表接收请求，不能替代启动器对退出和清理完成的确认。

## 公开域与全部方法

下表的方法名对应 `KodaXProductClient`；具体参数联合、可选字段和返回类型直接引用 TypeScript 定义。

| 域 | 方法 | 语义与结果 |
| --- | --- | --- |
| `host` | `shutdown` | 请求正常关闭空闲 Host |
| `commands` | `execute`, `readPrompt` | 按注册名称/参数执行，或只取可编辑纯文本；可信 hooks/model/tools/fork 元数据不返回客户端 |
| `review` | `start` | Host 捕获 git diff、构造普通 review 或既有 scoped-review workflow，并返回对应 Run |
| `agents` 审查 | `reviewLean` | Host 读取该 Session 项目的 AGENTS.md 并启动精简审查；缺文件明确返回失败消息 |
| `sessions` 压缩 | `compact` | 手动压缩接受自定义指令；Host 检查 idle、执行并提交，返回 tokens/messages/report 或明确失败原因 |
| `memory` | `forProject` | Host 派生项目身份；返回 refs/inbox/proposal/reviews 查询、remember/forget/approve/reject、rebuild 和可信 open target |
| `learning` | `list`, `get`, `getSnapshot`, `events`, `subscribe`, `acknowledge`, `snooze`, `reject`, `disable`, `rollback`, `promote`, `review`, `trust` | 客户端通知状态保持原作用域；治理动作修改 Host 共享事实，沿用已有订阅流 |
| `sessions` 基本管理 | `create`, `list`, `read`, `delete`, `archive`, `unarchive` | 创建、查询、删除和归档 Host 所有的 Session；`list` 接受项目、scope、归档、分页、tag、surface 过滤 |
| `sessions` 设置 | `getSettings`, `updateSettings` | 返回原始 Session 覆盖；下一次物理请求采用新选择，patch 的 `null` 清除覆盖并恢复 Host profile 配置，缺失不制造新的执行默认值 |
| `sessions` 条件设置 | `getSettingsVersioned`, `updateSettingsVersioned` | 读取 `{ revision, value }`；更新必须携带 `{ expectedRevision }`，过期时 `conflict` 且不写入。复用 Host 既有设置 CAS，普通编辑无需使用，不新增操作回执或恢复协议 |
| `sessions` Auto 诊断 | `getAutoModeStats` | 返回现有 Host Auto 拒绝、熔断和分类器健康事实；非 Auto 为 undefined，不创建第二套权限状态 |
| `sessions` 显示 | `observe`, `readItem` | 当前显示视图及其替换；补读显示项的完整正文或工具输入 |
| `sessions` 历史 | `readHistory`, `readHistoryEntry`, `searchHistory` | 规范对话分页、超大项正文和全 Session 搜索 |
| `sessions` 目标 | `readGoal`, `createGoal`, `pauseGoal`, `resumeGoal`, `clearGoal` | 读取及修改共享持久目标；创建、状态转换和预算遵守领域约束 |
| `sessions` 通知 | `appendNotice` | 由 Host 保存通知正文及可选来源 |
| `sessions` 分支 | `readLineage`, `labelEntry`, `selectBranch`, `rewindSession`, `forkSession`, `recoverSession` | 读取分支、标签、选择头、回退，以及派生新 Session |
| `inputs` | `submit`, `read`, `withdraw` | 提交有身份的用户意图、查询接收状态、撤回队列项并取回原始输入 |
| `runs` | `startTool`, `read`, `stop`, `await` | 显式工具执行、读取生命周期、停止单 Run、等待真实终态 |
| `sessions` 停止 | `cancel` | 固定已有 Run 的 Session 顺序边界，停止边界内的排队及活动 Run，返回请求接收与清理确认事实 |
| `workflows` | `start`, `list`, `get`, `subscribe`, `pause`, `resume`, `stop` | Host 内启动和控制声明式工作流；读取完整进度快照，订阅既有工作流事件；控制方法返回是否成功 |
| `interactions` | `list`, `respond` | 查询待答请求，以精确 requestId 回答；首个有效答案生效 |
| `permissions` | `listGrants`, `revokeGrant` | 读取显式授权和 revision；按 grantId + expectedRevision 撤销 |
| `registrations` | `list`, `upsert`, `setEnabled`, `remove` | 管理外部 Agent 注册；保留领域配置 revision 和管理归属约束 |
| `agents` | `tree`, `detail`, `spawn`, `send`, `followup`, `interrupt`, `output`, `wait` | 查询和控制 Session Actor；`wait` 按 sequence 等待一个事件或超时，支持调用侧 AbortSignal |
| `config` | `read`, `patch`, `reload` | 读取、修改及重载用户默认配置；独立于 Session 覆盖 |
| `catalog` | `extensions`, `providers`, `models`, `reasoningEfforts`, `probeReasoningEfforts`, `forgetCapabilities`, `commands`, `skills` | Host 已加载扩展的诊断及发现的 Provider/模型/推理档位/命令/技能；probe 明确发起 Provider 请求，连接与普通发现不隐式探测 |
| `mcp` | `status`, `listServers`, `getServer`, `validateServer`, `upsertServer`, `deleteServer`, `reloadServers`, `listTools` | 管理纯 MCP 配置、读取 Host 当前连接状态和查询工具；可执行连接留在 Host |
| 连接 | `disconnect` | 释放本连接及其资源，保留共享 Host 和工作 |

`workflows.start` 接收 `inline`（manifest + source）、`request` 或 `name` 声明式来源，返回 `declined` 原因或 `started` 的 runId。它不接收预执行模块或函数。MCP 配置允许 stdio、SSE、HTTP 等 MCP transport；这不意味着产品 Client transport 已支持这些协议。

`workflows.get` 返回现有工作流进程的完整数据快照，包括 items、counts、progress 与 lineage；`list` 保留计数、起止时间和 runDir，不让 UI 从摘要推算进度。`subscribe` 复用已有事件流，返回可关闭的订阅，不代表断线期间事件会无限重放。客户端重新连接后应重新读取快照。所有这些类型都是数据，不暴露 Host 执行对象。

`catalog.commands/skills` 的 `source` 是 Host 解析出的注册来源字符串。Provider 的 capabilityProfile 描述后端执行特点；客户端不自行猜测 Provider 行为，不将探测失败伪装成不支持。config/Session 设置可选字段及默认规则由类型与 Host 解析决定，不应靠 UI 复制默认值逻辑。

`catalog.extensions()` 返回 Host 已加载的扩展和注册诊断，只有纯数据，不包含处理函数或 Node 运行时对象。`mcp.status()` 只读当前连接状态，不唤醒 lazy server；`reloadServers()` 明确重建连接集合，`listTools({forceRefresh:true})` 明确刷新目录。REPL 的 `/extensions`、`/mcp` 使用这些相同入口，客户端无需另建 extension runtime。

无交互的 one-shot CLI 在订阅视图后提交输入：属于本次 Run 的权限请求及时拒绝；单选、多选、自由输入和 MCP 表单等人工提问使用既有 `cancel` 回答，不代填默认值。工具收到拒绝或取消，Run 仍按正常执行结果结算；不把取消一个问题等同于停止整个 Run。这个行为属于该 CLI 消费者，不改变 Host 的全局审批超时，也不回答其他 Run 的请求；可处理交互的 SDK/Web 消费者仍使用同一 Interaction 契约。

one-shot 的调用设置仍临时写入共享 Session，并非独立的 Run 设置层。持久 Session 只在设置版本仍等于该次写入的版本时恢复；另一 Client 修改过任意设置后，保留新的设置事实并报告恢复冲突，调用旗标中未被覆盖的字段可能继续保留。初次应用也使用读到的版本，避免在读取与应用之间覆盖新编辑。不通过读后无条件写入、重试旧恢复或创建第二份设置权威来消除冲突。

`commands.execute` 接收 `sessionId`、`inputId`、注册 `name` 和可选 `args`；`review.start` 接收 Session/Input 身份及参数，`agents.reviewLean` 接收 Session/Input 身份。三者都要求 `run:control`，实际执行保留忙时拒绝。帮助和命令正文读取不经过执行的空闲门禁。承接 FEATURE_299 后，未声明 `execution: configuration` 的 extension handler 经正常工具执行入口运行，立即返回 `started.runId`；没有模型调用或没有输出也仍有真实工具 Run。Host 保存一次原始输入，并为 handler 提供所属 Run、取消信号及受检工具调用。handler 返回模型 invocation 时在同一 Run 内继续执行，复用原 inputId 和工具历史；模型、工具限制与 fork 仍由 Host 从注册结果解析。声明 `execution: configuration` 的命令才直接返回 `completed`，不伪造执行 scope。`completed.success` 和可选 `message` 是该动作的结果，`started.runId` 只是已启动身份；客户端随后观察 Session、等待 `runs.await`，不能把它重新提交为输入。

prompt/extension 的模型偏好、工具限制、hooks 和 fork 由 Host 从可信注册来源执行。hook shell 沿用正常工具授权路径；PostToolUse 与 Stop/SubagentStop 结算后才报告终态，fork 结果提交回原 Session 后才完成。`disableModelInvocation` 不禁止用户显式调用。低层 daemon 输入也不能携带 Host-only command 描述符来注入这些策略。

注册命令的第一个参数为 `help`、`--help` 或 `-h` 时，沿用原帮助语义，只返回说明，不执行 handler 或模型。客户端使用 Host 命令目录的名称及 aliases 判定注册命令，不能因为本地没有 extension runtime 就当作未知命令，也不能让同名 Skill 抢占已注册命令；`/skill:name` 保留显式 Skill 含义。

交互式 CLI 和单次 CLI 都把 Skill 原文通过 `inputs.submit` 交给 Host，不在客户端预先执行动态上下文或 hooks。单次调用的既有 repoIntelligenceMode/Trace 参数与模型、effort 等参数通过 Session 设置表达；持久 Session 在调用结束后恢复原覆盖，临时 Session 由 Host 按既有生命周期清理。设置恢复失败会明确诊断。单次 CLI 为保留原 JSON/text 进度格式，仍使用底层只读进度适配器；它不执行任务、不提交输入、不裁决终态，产品结算由 `runs.await` 决定。

`commands.readPrompt` 是明确的 SDK 纯读取能力，返回 `{title, text}` 或 `null`。它不会调用 extension handler、运行 hooks、保存输入或启动模型；取消读取后的本地草稿没有执行效果，编辑后通过普通 `inputs.submit` 提交也不携带原命令的权限元数据。当前 CLI 没有新增草稿按钮或 `--manual` 标志；旧 hook 阻止执行的 manual output 是结果提示，不被解释成编辑器模式。

命令或 review 的回复丢失时不能透明重放：extension 副作用可能已发生，即使没有 Run 或用户输入可查询。若收到 started 身份，直接跟随原 Run；没有收到身份时只能检查已知领域事实、显示结果不确定并由用户决定后续操作，不能自动重跑 handler。

`memory.forProject` 返回的 controller 仅含已有用户操作。proposal 预览附带 `revision` 和 `expectedFingerprints`，批准/拒绝应回传所见版本，forget 应传已读正文指纹；Host 重新校验精确引用，过期预览不能批准新内容。`reviewerProviderConfigured()` 是取得 plane 时的状态；需要刷新时重新调用 `forProject`。doctor 使用这些查询事实，`ensureOpenTarget` 只验证路径和必要目录，本地编辑器由 UI 打开。Learning 的 acknowledge/snooze 只改变调用客户端的通知状态，disable/promote 等治理动作则对其他客户端可见。

手动 compact 和领域修改丢失回复后不能自动重放。调用方应读当前历史、预览或领域状态；`compacted: false` 的 `reason` 需原样处理，不能把 Provider 失败显示为“无需压缩”。

## 身份、状态与事实权威

| 对象 | 身份/边界 | 客户端处理 |
| --- | --- | --- |
| Host | 底层 Runtime 的 runtimeId、启动时间和握手身份 | 产品连接完成前由启动器/连接器验证；`KodaXProductClient` 当前不直接暴露 Runtime identity |
| Session | `session.id` | 共享设置、存储、分支、目标和显示的归属；项目路径不是 Session 身份 |
| Input | `sessionId + inputId` | 调用方为一个意图分配 ID；不确定接收时查询原 ID，不能直接生成新 ID 重发 |
| Run | `runId`，关联 `sessionId` | 输入接收与运行完成分开；仅 Host 生命周期/终态是完成事实 |
| Interaction | `requestId`，关联 Session/Run | 精确回答当前请求；过期、已答和未知请求不能被当作新请求 |
| 显示项 | `ClientViewItem.id`；用户项可带 `inputId` | 以身份和 Host 顺序显示；旧历史可无 inputId，禁止按全文去重不同用户意图 |
| History | `revision`、项 ID、分页 cursor；搜索 entryIndex 仅在该 revision 内稳定 | 不跨 revision 拼接页或按陈旧索引执行分支操作 |
| 授权/注册/Actor | 各域自己的 ID、revision、路径等 | 遵守对应 CAS/归属约束，不用统一的猜测 revision 替代 |

`inputs.submit` 的 delivery 包含 `immediate`、`after_turn`、`steer`、`redirect`；后两者必须指定 `targetRunId`。同一 inputId 的不同文本、附件或其他意图发生冲突；附件是意图的一部分。`read` 返回 `null` 仅表示该 Host 当前查不到接收记录，不保证跨 Host 重启的全局恰好一次。

接收状态 `submitted` 表示进入对话上下文，不证明 Provider 已接收；`queued` 等待安全交付点；`withdrawn` 已撤回；`dropped` 表示目标 Run 在交付前结束，正文未进入上下文。重新提交被丢弃意图使用新 ID。队列 text 是有界预览，编辑撤回内容应使用 `withdraw` 返回的完整原文。

`runs.stop` 的 `accepted` 仅表示本次创建了持久 Stop 请求；返回的 state/outcome/phase 与 Run 真实终态分别解释。`runs.await` 的 `phase: 'unknown'` 表示终态无法确认，例如终态持久化失败或 Actor 结算不确定；连接可能仍然健康。它绝不是成功或取消，也不保证重新连接可以解决。传输失败通常使在途 Promise reject，应与 unknown 分开处理并保留 error 原因。phase 当前是字符串类型，UI 必须保留未知值的安全显示，不能把不认识的状态当成功。结果中的 error 是错误文本，不能通过是否存在 result 单独推断成功。

delivery 的队列行为如下；空 queue 不能证明所有已知输入已经交付。

| delivery | 行为与确认 |
| --- | --- |
| immediate | 尝试开始 Run；Session 忙时冲突，不先执行动态准备 |
| after_turn | 保存到 Host 可撤回队列；普通输入在当前 Run 下一次模型调用前的安全点交付，不等待整个长任务结束。没有可用安全点时保留待后续调度；多条输入也可能合批为同一 Run/一个 user 展示项，须逐 inputs.read 确认 submitted/runId |
| redirect | 保存新输入并停止目标 Run，沿用显式 redirect 的后续调度 |
| steer | 交给目标执行中的中断输入路径，可能返回 queued，但不在可撤回 view.queue 中；通过 inputs.read 确认 submitted/dropped |

普通 stop/failed 不自动 drain，队列保留；不能在重连时自行重放提交。Ink 已按逐 inputId 查询处理合批确认，不按正文去重。

安全点消费与 withdraw 使用同一 Host Session 操作锁；输入成功保存后才从可撤回队列移除并标记 submitted。消费前撤回得到完整原文和附件，消费后撤回明确 conflict。排队 Skill 必须经 Host 可信准备，是普通批次的顺序边界；不把 Skill 当普通文字塞入执行器，也不让后方输入越过它。没有后续执行额度时不通过无限延长 Run 来消费队列。以上行为对 REPL 和 SDK 相同，不新增 UI 自有执行队列。

Interaction 的 kind 决定 options 和 response：单选问题、多问题、文本输入或权限；取消用 `kind: 'cancel'`。权限答案为 allow_once、带 suggestionId 的 allow_session/allow_always、或 reject；suggestionId 来自当前请求，不能自行拼装。`accepted: false` / `already_resolved` 覆盖迟到、重复、取消、过期或未知目标；不要无限重答。

`readLineage` 在尚无 lineage 的旧 Session 可返回 null。会话读取、lineage、设置读取及 fork/recover 都先等待同 Host 已发起的显示快照保存，再进行原有准入和存储一致性检查；调用者不必先读一次历史来触发同步。保存失败会传递给调用者，外部写入造成的不稳定边界仍明确拒绝。Run 终态本身不等于所有显示快照已保存。

标签和分支选择的未知 selector 必须明确冲突。rewind 需要 expectedHead，只允许空闲 Session，且不会撤销文件副作用；fork 可使用带 sourceRevision 的 historyBoundary，源 Session 保持不变。recover 从确定性恢复种子派生新 Session，不执行 LLM 调用；继续运行仍通过普通 input submit。

`selectBranch` 的可选第三参数 `summarizeCurrentBranch` 保留原分支切换时的摘要行为。REPL 若尚未持有 rewind 的 expectedHead，会先读取当前 lineage，再把该身份提交给 Host 校验；这不会取消并发冲突保护。

## 输出、全文与冻结浏览

### Session 视图逐字段说明

以下 `?` 表示可缺失，不表示零、空字符串或已完成。Host 生成视图的代码是 [SessionViewOwner](../src/session-view.ts) 与 [Runtime Session view 读取](../src/sdk-runtime.ts)；终端仅把这些事实投影成组件。

| `ClientSessionView` 字段 | 来源与含义 | 消费规则 |
| --- | --- | --- |
| `session` | Host 加载的 `ClientSession` 元数据 | 先检查 session.id，避免切换 Session 后把在途旧回调渲染到新页 |
| `session.id`, `session.title` | Session 身份与标题，必填字符串 | 标题可变，不能充当身份 |
| `session.gitRoot?`, `session.workspaceRoot?` | Host 保存的仓库/工作区定位 | 不从标题或浏览器目录推断路径 |
| `session.surface?`, `session.profileId?` | Session 的界面/配置归属元数据 | 不是 Host 权限凭据 |
| `session.createdAt?` | Session 保存的创建时间字符串 | 缺失时显示未知，不用连接时间代替 |
| `settings` | Host 当前 profile 配置与 Session 覆盖合并后的有效选择，复用执行侧解析 | 与 getSettings/updateSettings 的原始覆盖区分；清除覆盖后恢复 profile 值，两层均无值时保持缺失。UI 显示 Host default，不把旧模式或本地默认值冒充 Host 事实 |
| `items` | canonical 历史与当前运行显示项合并后的有序、有界列表 | 每帧替换，保持 Host 顺序；窗口外的项不等于被删除的历史 |
| `queue` | Host 当前等待交付的输入 | 不是本地草稿；顺序和撤回目标以 Host 为准 |
| `queue[].inputId`, `queue[].text`, `queue[].enqueuedAt` | 输入身份、有界预览、入队 Unix 毫秒时间 | 同文本可有不同身份；编辑全文通过 withdraw 返回值获取 |
| `interactions` | Host 当前等待答案的精确请求集合 | 用 requestId 呈现/回答；另一 Client 回答后可从下一帧消失 |
| `runs` | 当前 Host 记录中本 Session 的非终态 Run，以及最近一个 Run | 不是持久的全部 Run 历史；重启后缺失不表示过去没有运行 |
| `runs[].runId`, `runs[].phase` | 运行身份与实际生命周期字符串 | 以 Run 事实判断完成，不通过工具状态/文本推断；未知 phase 保留为未知 |
| `runs[].provider`, `runs[].model?`, `runs[].error?` | 该 Run 记录中的 Provider、可选模型和错误文本 | 这是 Run 当前可变选择；活动 Run 可随 Session 设置变化更新，不能作为已经发送的物理请求或各 worker 模型的历史凭证 |
| `contextBudget?` | Host 解析当前父 Session 选择对应的有效配置，见下方预算规则 | 缺失表示预算未知；不能从客户端 Provider 或启动快照补算 |
| `parentContextTokens?` | Host 对已保存父会话 data.messages 的 token 估计；非历史重读时可沿用上次值 | 空闲/resume 时也可显示；不是账单用量或 transcript 总长度 |
| `activity?` | Host 收集到的最近 Run 的显示活动 | 可缺失、可保留最近终态活动；存在不证明仍在运行 |

### 显示项、流式文本与工具

| `ClientViewItem` 字段 | 含义 | 消费规则 |
| --- | --- | --- |
| `id` | Host 为该显示项给出的身份；同项更新沿用 ID | 可作组件 key，不解析内部字符串格式；不同读取面或修订的 ID 不保证互换 |
| `inputId?` | canonical user 消息对应的已接受输入身份 | 关联乐观输入与 Host 正式项；旧历史可能没有，不能据全文全局去重 |
| `type` | user/assistant/thinking/info/error/event/hint/sidecar/system/tool | 用户、助手、思考、通知与工具分别呈现；不同类型不因相邻而合成同一条原文 |
| `text` | 该类型的显示正文；tool 时是工具输出 | 可能是有界后缀；原文为空时空文本合法，不代表没有工具输入或运行失败。不能因其他项目用完预算而把非空原文投影成空壳 |
| `textOffset?`, `totalTextLength?` | 有界正文后缀的绝对 UTF-16 偏移与完整长度 | 按 readItem 补齐；不能用 text.length 代替完整长度 |
| `timestamp?` | Unix 毫秒时间；实时项生成时取时钟，后续同 ID 更新保留原时间，恢复项采用保存的信息 | 保持 Host 数组顺序，不按本地到达时间重排；缺失不补成“现在” |
| `icon?` | Host 附带的展示提示字符串，例如 sidecar 裁决提示 | 仅展示；未知值用通用图标，不据它判 Run/工具终态 |
| `compactText?` | Host 提供的可选紧凑展示文本 | 折叠可使用，复制/全文仍取 text 的完整内容 |
| `tool?` | 工具显示事实；通常与 type=tool 配合 | 缺失时保留可读正文，不能自行捏造工具调用 |
| `tool.callId`, `tool.name` | 工具调用身份与工具名 | callId 用于关联状态更新；name 不是调用身份 |
| `tool.status` | running/success/error/cancelled/awaiting_approval | success 仅表示此工具结果，不代表 Run 成功。类型允许等待审批，不承诺每个路径逐一发出所有中间状态 |
| `tool.inputText?`, `tool.totalInputLength?` | Host 序列化的工具参数文本及可选完整 UTF-16 长度 | 输入与输出分开；补读使用 part=input，不能把预览重解析后当作原始参数 |
| `tool.progress?` | 最近的工具进度消息 | 当前提示而非追加日志；完成时可被清除 |
| `tool.startedAt?`, `tool.endedAt?` | 工具开始/结束的 Unix 毫秒时间 | 两者具备时才可计算执行耗时；不存在 endedAt 不等于当前一定还运行 |

纯契约没有 item.streaming、item.isFinal 或逐 token 事件。Host 收到 assistant/thinking delta 后更新同一显示项的完整当前文本；一次刷新可以合并多次内部事件。Provider retry/输出段替换可以移除旧项或替换正文，不能要求 text 永远只增长。工具开始、progress、result 也更新同一个工具项；状态由 Host 生成，客户端不解析文本前缀再猜一次状态。

当前实现保留最后 150 项，正文与工具参数合计最多 131,072 个 UTF-16 码元，每字段最多 8192 个码元。Host 先为各保留项的非空正文和参数预留可读预览，再把剩余额度分配给较新的内容；长回答或工具结果不能挤掉较早 query、Thinking、回答和 Bash 参数的全部预览。正文仍为带 textOffset 的后缀，工具参数仍为前缀；全文继续按原 itemId 和 part 分页读取。这是显示长度限制，客户端不能用它计算模型上下文的 token 使用率。

当前 Ink 的 [clientViewToHistoryItems](../packages/repl/src/ui/client-plane.ts) 在存在活动 Run 时给列表中末条 assistant 加本地 isStreaming 展示标记，Run 终态后重新投影去掉；这是终端显示约定，不能升级成 Host 对某项仍在产生 token 的保证。工具、审批、Run 和输出项分别依其自身事实显示。

### Activity 与状态栏逐字段说明

| `ClientSessionActivity` 字段 | 来源与含义 | 消费规则 |
| --- | --- | --- |
| `runId` | 产生这组活动的 Run | 不把其它 Session/Run 的活动混入当前状态栏 |
| `contextBudget?` | 执行器在真实压缩准入/请求点发出的预算；含 provider/model/contextId、scope、窗口、响应与 Memory 预留、压缩阈值和物理输入容量 | 与顶层当前选择的配置预算分开；只与同一执行上下文的 token 数量计算比例 |
| `costReport?` | 当前 Run 的既有 getCostReport 回调在视图刷新时返回的报告文本 | 可直接展示；不是结构化计费 API，不解析成精确金额 |
| `iteration?.current`, `iteration?.maximum` | Runner 的迭代开始/结束事件 | 当前迭代与本次执行上限；maximum=0 是底层无界调用约定，不除以零 |
| `compacting?` | compact start/end 事件投影的压缩状态 | 未收到信息时保留未知；false 表示该活动已结束压缩状态 |
| `context?.tokenCount` | 最近 iteration end 的 context snapshot 或 compact stats 的 tokensAfter | 当前上下文占用，不是累计输入输出 token |
| `context?.tokenSource` | api 或 estimate；压缩统计更新按 estimate 投影 | 标明 API 校准/估算来源，不承诺计费精确度 |
| `context?.scope` | parent 或 worker；child/worker 事件投影为 worker | worker token 不能覆盖父会话持久上下文 |
| `parentContextTokens?` | 最近父 iteration/compact 的 token 事实 | 子事件不会覆盖；与 view 顶层保存态估计不同，按显示场景选取 |
| `usage?.inputTokens`, `usage?.outputTokens`, `usage?.totalTokens` | iteration end 携带的最近 Provider 响应用量快照 | 整组替换，不把重复观察帧相加；不是 Session 或整个 AMA 的累计总账 |
| `usage?.cacheReadTokens`, `usage?.cacheWriteTokens`, `usage?.thoughtTokens` | 可选缓存读/写及思考 token；Host 将领域源 cachedReadTokens/cachedWriteTokens 显式映射到公共名称 | 未报告不等于 0；分项可能与 input/output 重叠，不能再加到 totalTokens |
| `children?` | 当前子活动投影 | 不是完整 Actor 树；完整事实使用 agents 域 |
| `children[].id`, `children[].label`, `children[].source` | 子活动身份、标题与 workflow/normal 来源 | 以 ID 更新，不以标题去重 |
| `children[].kind`, `children[].detail` | assistant/thinking/tool/progress/prompt/stream 类型与有界摘要 | 不是子 Agent 全文；全文使用 agents.output |
| `children[].status`, `children[].startedAt` | running/completed 与首次活动 Unix 毫秒时间 | 当前 Host 完成时通常移除子活动，不保证观察到 completed 过渡帧 |
| `managedTask?` | managed task 状态事件的显示投影 | 不是第二套 Run 状态机；Run 结束时隐藏实时忙碌提示 |
| `managedTask.harnessProfile?` | 执行 harness 名称 | 展示来源，不据未知名称猜运行模式 |
| `managedTask.globalWorkBudget?`, `managedTask.budgetUsage?`, `managedTask.budgetApprovalRequired?` | 执行域提供的工作预算、已用量、需审批事实 | 按该领域预算含义显示，不混作 context token 或费用，不凭布尔值自行批准 |
| `managedTask.phase?`, `managedTask.workerId?`, `managedTask.workerTitle?` | managed 执行阶段和当前 worker 身份/标题 | phase 是字符串，未知阶段显示通用活动，不能判成功 |
| `managedTask.breadcrumb?`, `managedTask.expandedBreadcrumb?` | Host 格式化的简短/展开执行路径 | 是展示文本，不是可导航的 Actor ID |
| `managedTask.round?`, `managedTask.maximumRounds?` | 当前 managed 轮次与轮次上限 | 与 Runner iteration 分开，不相互覆盖 |
| `managedTask.idleWaiting` | 是否暂时等待子工作，managedTask 存在时为必填布尔值 | 不是 Run 已完成，也不是 Host 空闲可关闭 |
| `managedTask.pendingChildren?`, `managedTask.fanoutCount?` | 等待中的子任务数及 fanout 计数 | 不据其中一个数反推完整子任务生命周期 |
| `todos?` | 最新 onTodoUpdate 的列表投影 | 整表替换，不从旧进度文本恢复另一份列表 |
| `todos[].id`, `todos[].subject`, `todos[].status` | Todo 身份、主题与 pending/in_progress/completed/failed/skipped/cancelled 状态 | Todo 完成不意味着 Run 完成 |
| `todos[].description?`, `todos[].owner?`, `todos[].note?`, `todos[].activeForm?` | 描述、归属、备注及进行时文案 | 保留可选性，不凭缺失字段推断领域状态 |

状态栏的“Session 当前选择”“Run 当前选择”“上下文占用”“本次 usage”是不同事实：

| 显示项 | 实际取值来源与边界 |
| --- | --- |
| 当前选择 | 产品显示读取 view.settings 的有效选择，编辑覆盖读取 sessions.getSettings；Run 当前可变 provider/model 读取 view.runs，它不是已发出请求的快照。Ink 从 Host view 同步显示配置和现有引用，模型默认名取 Host contextBudget；不会把观察同步写回 Host。显式本地设置仍先等待确认，并保留该等待期间确认的字段。Classic 从现有显示观察同步配置，后续提示符和命令读取同源状态。未指定的模式/推理选择显示 Host default；显式切换报告新选择，不能据此反推 Host 未报告的默认策略 |
| 父上下文候选值 | 当前 [surface-status.ts](../packages/repl/src/ui/view-models/surface-status.ts) 依次取 activity.parentContextTokens、scope=parent 的 activity.context.tokenCount、view.parentContextTokens |
| 运行中的上下文 | Ink 优先显示 activity.context.tokenCount（可能来自 worker），缺失再取父候选值；Web 应标明 scope，避免将 worker 值说成父会话长度 |
| 空闲上下文 | SA 使用父候选值；AMA/AMAW 优先 view.parentContextTokens 的保存态估计，再回退父候选值，避免结束后留下 worker 数字 |
| 上下文窗口/占比 | 产品 Ink 读取 view.contextBudget，包含 scope=parent、解析后的 provider/model、contextWindow、reservedResponseTokens，以及 compaction.enabled=true、triggerPercent、可选 absoluteTriggerTokens。Host 复用现有窗口与压缩配置解析，设置或 config reload 后刷新同一 view。worker 没有匹配预算时仅显示数量与 scope，不除以父窗口 |
| usage/cost | usage 来自最近响应快照，costReport 是单独的可选报告；不与上下文占用或工作预算混算。usage 没有独立 scope 字段，不能断言为父会话总账 |
| 冻结/空闲状态 | Ink 冻结浏览停用实时 managed/iteration/compacting 的活动投影，使用冻结显示状态；终态后不因残留 activity 继续显示忙碌。未知数值用“—”或省略，未知状态显示通用文字，不补 0、不默认 success |

顶层 contextBudget 描述当前选择的有效配置，空闲时不能冒充某次请求的最终容量。activity.contextBudget 来自既有执行预算事件，保留执行器实际使用的 compaction.triggerTokens/physicalCapacityTokens、reservedResponseTokens 和 reservedMemoryTokens；SA 父执行有 Memory 时包含其预留，worker 的预算沿自己的上下文发出，不能套用父预留。物理容量包含执行器既有安全余量；当前上下文计数包含其 system/tool envelope，客户端不重算阈值。这里的响应预留属于压缩准入策略，不能当作之后每次 Provider 请求实际 max_tokens 的不可变凭证。

产品 Ink 在运行时优先使用匹配 scope 的执行预算，未知 worker 预算只显示数量与归属；空闲使用父配置窗口。最终阈值未知时不显示推算的压力颜色。配置预留、上下文占用与 usage 不混算。独立嵌入 REPL 保留本地配置解析路径。压缩常开，没有新增可写开关。

### 两条短时序示例

首轮输入到终态（下面表达因果，不保证一次内部事件对应一次观察回调）：

1. Client 对 Session 建立 observe，先收到当前 view；随后用新 inputId submit。先 submit 后 observe 也能取得当前态，但不能要求补发错过的瞬态步骤。
2. submit 返回 submitted/runId，后续 view.items 出现 user 项，runs 给出实际 phase；单条输入可由 inputId 关联，after_turn 合批必须逐 inputs.read 确认各 ID，不能要求每个输入各有一个展示项。
3. Host 更新 thinking/assistant 项；工具以稳定 item.id 和 callId 出现，status=running、inputText 为参数，后续 progress 或结果替换同项。
4. 若需要权限，view.interactions 出现 requestId；任一 Client respond 后后续视图移除请求。工具最终 success/error/cancelled，不能据此结束整轮。
5. runs.await 返回真实终态，view.runs/最后正文收敛；Client 去掉本地流式标记。若 await 返回 unknown，显示终态无法确认及 error 原因，不发布成功；连接错误的 Promise rejection 单独处理。

继续旧 Session 与冻结历史：

1. connect/ensure 后 sessions.read(existingId)，再 observe；使用 Host 恢复出的项顺序和保存态上下文。resume 不需要复制旧 query 再 submit，也不从本地文本重造历史。
2. 用户打开历史时调用 readHistory，从最新页沿 nextCursor 读旧页，校验 revision；按页顺序合并，用 readHistoryEntry 补齐有界/超大项。
3. 捕获此次浏览的项身份、顺序与长度；用全文 reader 补齐当时范围后，才发布可复制/搜索的冻结内容。正文变更或读取失败时明确报错并重开，不能展示半份“完整历史”。
4. 新输出继续更新后台当前 view，不移动冻结页阅读位置；退出冻结浏览再回当前 view。用户真正要继续工作时才用新 inputId 提交新意图。

### 全文读取规则

`sessions.observe` 先交付当前 `ClientSessionView`，以后交付完整替换视图。它不是文本 delta 或可回放事件日志；客户端替换当前展示投影，不自行将每帧追加成历史。view 包含 Session、settings、items、queue、interactions、runs，以及可选的 contextBudget/activity/parentContextTokens。Activity 的父上下文与 worker 上下文不可混为一个计数。

输入接收结果与正文视图异步更新，不保证同一帧到达。已提交输入可能稍后才出现在观察视图中；消费结果以 inputId 的接收记录为准，不能因首帧尚未显示正文就重交输入。后续 view 应自然收敛，不需要客户端额外读取或重新提交来推动刷新。

取消后保留的半截输出可能只有 display checkpoint，没有 canonical assistant message。Host 为新输出保留可选 `afterInputId` 来源锚，恢复时将其放在对应 canonical 用户输入之后、下一轮输入之前；合批输入的已记录身份映射到同一用户项。同一 Run 的 steer 和已交付普通排队输入按实际交付顺序更新后续输出来源；segment 开始和工具项创建时捕获来源，既有项的延迟 delta/result 保留原锚。该字段是 Host 恢复元数据，客户端仍只使用 Host 给出的项顺序，不自行排序。旧记录缺失来源时保持旧恢复规则，不按正文或时间猜测所属输入。

显示窗口是有界的。`textOffset`/`totalTextLength` 表示正文省略的前缀和总长；工具 inputText 可由 totalInputLength 标明不完整。调用 `readItem(sessionId, itemId, { part: 'text' | 'input', offset })` 补齐。offset、totalLength、nextOffset 均以 UTF-16 字符单元计数，不是 UTF-8 字节；应按返回的 nextOffset 续读，验证项 ID、偏移连续性和长度，直到结束。null、无进展或读取变化是失败，不能把部分原文当全文。

相邻工具可以在客户端共用一个展示标题，重复摘要可以折叠计数，但每个工具仍保留原 Host itemId。搜索定位、选择高亮、展开和复制必须指向该工具（或包含它的折叠摘要行），不能因合并展示而读到另一工具，或只滚到整段标题便判定目标已可见。

历史与实时 view 不同：`readHistory` 首次给最新页，页内由旧到新，nextCursor 指向更旧页；拼接完整历史要反转页顺序，不能反转页内顺序。cursor 是不透明值。每页必须属于同一 revision；变更时重新从最新页读。`oversized` 给出超大条目的 itemId/byteLength，page.items 保留可定位的有界投影；这些正文须由 `readHistoryEntry` 读取，不能静默遗漏或用截断预览冒充。搜索可按角色过滤，scope 为 all 或 compacted；hit 的 snippet 是检索预览，不是复制原文。每个命中包含不透明 itemId，可直接交给 readHistoryEntry 分页读取原文，包括压缩前长正文。命中身份使用 transcript 修订空间，与 conversation 身份分开；entryIndex 不能当作 conversation 页数组下标或 fork 的 entryId。现有快照过期时 reader 明确报 resync_required，调用方须重新搜索，不按全文匹配恢复身份。

冻结浏览属于 UI 操作：进入浏览时捕获项身份、顺序和已显示长度，补读所捕获长度内的正文/工具输入，拒绝读取中缩短、替换或不连续的内容。新产生输出不能改变冻结页的滚动位置与搜索结果；退出后再回当前 view。现有 Ink 通过 [client-plane.ts](../packages/repl/src/ui/client-plane.ts) 的 frozen reader 实现，不新增 Host 租约或另一套恢复框架。产品 `readItem` 本身没有任意时点不可变快照参数，不能据此承诺任意并发替换时仍可取回旧正文。

复制、外部编辑器和全文历史使用读取到的原文；终端排版可转换不可打印控制字符，但不能将排版处理后的字符串保存回历史，或混入 Host 原文。工具输入、执行输出、thinking 和助手文本保持各自类型与边界；隐藏/折叠是 UI 决策。

## 错误、断连与重连

公开方法以 Promise 拒绝报告操作失败；部分领域另外返回 null、undefined、boolean 或判别联合，必须按方法声明解释。当前纯契约没有统一导出的 `ClientError` 联合，不能承诺所有错误都拥有同一形状。Node/RPC 实现中的错误可能带 `code`，调用方应先收窄 `unknown`，保留消息和原始原因。

常见边界包括 conflict（意图或 revision 冲突）、not_found、permission_denied、unauthorized、version_incompatible/client_upgrade_required、resync_required/data_changed、runtime_changed、observation_invalidated 和读取超时/取消。不要将这些错误统一吞为“没有数据”或“已完成”。具体码以 [daemon protocol](../src/runtime-daemon/protocol.ts) 及执行域为准，当前协议码表不是纯产品 SDK 的穷尽错误类型。

普通产品消费者将错误视为 unknown，收窄后展示错误消息；不需要导入底层诊断错误类。低层 Node 宿主可从 `/runtime` 导入既有 `RuntimeDaemonCapabilityUpgradeError`：其 code 为 `daemon_capability_upgrade_required`，包含 capability、recoverable、restartRequired 和可选 preflight。例如构建或旧启动器问题可标为 runtimeBuild/launcherBuild；应展示具体原因，不据这些字符串构建 UI 业务能力矩阵。recoverable/restartRequired 不授权强停忙碌 Host，也不意味着可以自动重试所有操作。该类不从 `/client` 导出，不属于纯数据契约，也不覆盖全部连接/执行错误。

断连后重新建立连接，再 observe/read 获取 Host 当前事实；不要依赖错过的事件推导终态。`observe(sessionId, onView, { onStatus })` 报告 live、interrupted、closed。只有完整新 view 已交付后才报告 live；可恢复传输中断先报告 interrupted，复用现有重订阅和有限重试，耗尽或永久断连报告 closed/reason=unavailable。Host 视图读取失败也报告 interrupted，即使连接仍然健康；后续成功刷新再恢复 live。Session 删除或 Host 释放观察报告 closed/reason=unavailable；主动 close 报告 closed/reason=client。首次建立失败仍 reject。该回调不是执行恢复或请求重放承诺。Ink 在 interrupted 时保留正文、已打开的弹窗及草稿，不新开对话；只有新完整视图确认请求消失或观察永久关闭时，才清理本地弹窗。观察清理不等同用户 Esc、取消或拒绝，不能向 Host 自动发送答案。已打开弹窗的明确用户答案仍按 requestId 由 Host 裁决；传输失败须显式提示，不能自动重答。`agents.wait` 的局部 sequence 等待也不构成跨 Host 的全局恢复日志。

ACP 在观察中断或失效时报告当前 prompt 的投影失败，沿原有失败收尾请求停止该 Run；迟到的权限答复不会再提交。它不会把观察丢失转换成正常完成。

## 使用示例

需要启动便利的 Node 应用显式调用 ensure；业务操作仍使用同一 Client：

```ts
import { ensureKodaXClient } from '@kodax-ai/kodax/client';
import type { EnsureKodaXClientOptions } from '@kodax-ai/kodax/client';

const options: EnsureKodaXClientOptions = {
  profile: 'default',
  clientInfo: { name: 'my-local-app', clientType: 'app' },
  daemonStartupTimeoutMs: 60_000,
};
const client = await ensureKodaXClient(options);
try {
  const sessions = await client.sessions.list();
  renderSessionList(sessions); // 本应用提供的列表渲染函数
} finally {
  await client.disconnect();
}
```

Node SDK 被动连接，并观察一次有身份的输入：

```ts
import { randomUUID } from 'node:crypto';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import type { ClientSessionView } from '@kodax-ai/kodax/client';

const client = await connectKodaXClient({ profile: 'default' });
try {
  const session = await client.sessions.create({ projectPath: process.cwd() });
  const observation = await client.sessions.observe(session.id, (view: ClientSessionView) => {
    renderCurrentView(view); // 本应用提供的完整替换渲染函数
  }, { onStatus: (status) => renderObservationStatus(status) });
  try {
    const inputId = randomUUID();
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId, text: '解释这个项目' });
    if (accepted.runId) {
      const outcome = await client.runs.await(accepted.runId);
      if (outcome.phase === 'unknown') throw new Error(outcome.error ?? 'Run 终态无法确认。');
      showRunOutcome(outcome); // 依 phase/error 显示真实结果
    }
  } finally {
    observation.close();
  }
} finally {
  await client.disconnect();
}
```

Web 的 UI 代码只依赖类型和注入的产品客户端，不导入 Node 启动器：

```ts
import type { KodaXProductClient, ClientSessionView } from '@kodax-ai/coding/client-contract';

export async function watchSession(
  client: KodaXProductClient,
  sessionId: string,
  replaceView: (view: ClientSessionView) => void,
) {
  return client.sessions.observe(sessionId, replaceView);
}
```

注入 client 的远程网关、认证和网络 transport 需要另行实现与评审；该例不表示浏览器已经能直接连本机 named pipe。

| 导出入口 | 可导入内容 |
| --- | --- |
| `@kodax-ai/kodax/client` 值 | `connectKodaXClient`、`ensureKodaXClient` |
| `/client` 类型 | `ConnectKodaXClientOptions`、`EnsureKodaXClientOptions`、`RuntimeClientInfo`，以及 `export type *` 转出的所有纯契约声明，包括 ClientSessionView、ClientViewItem、ClientRunOutcome、ClientObservation |
| `@kodax-ai/coding/client-contract` 类型 | `KodaXProductClient` 及纯产品数据契约；不包含 Node 连接器、启动器或诊断错误类 |
| `@kodax-ai/kodax/runtime` 类型 | 底层 `RuntimeIdentity`、`RuntimeBuildIdentity`；RuntimeIdentity.build 可选，RuntimeBuildIdentity 明确声明 origin/fingerprint，不将它加入业务 view |
| `/runtime` Node 诊断值 | 既有 `RuntimeDaemonCapabilityUpgradeError`；仅底层 Node 宿主按需导入 |

`RuntimeClientInfo` 来自共享纯数据声明，并由 `/client` 与 `/runtime` 保留类型导出；它不把底层 Runtime 的 Node 类型依赖带入产品声明。未声明导出的依赖类型应从其所属包显式导入。消费者类型验证通过真实 `/client` 包入口覆盖 options 和核心 view/outcome/observation 类型，保持 `types: []` 的无 Node 类型环境；Node 诊断类另从 `/runtime` 消费，不用源码直导替代包导出验证。

## 产品入口与实际限制

CLI 的 Ink、classic、单次输入使用 Host Client 投影；SDK `/client` 是同一产品面。A2A 服务由 Host 启动并注入 Runtime，在协议边界映射任务/流式通知；A2A 的 taskId 与 Session/Run ID 不能混用。ACP 默认入口使用 `ensureKodaXClient`，通过 inputs/observe/interactions 转换协议请求；显式 Runtime 注入保留为 embedder 接缝。ACP 需要将协议 append 通知与共享当前态转换，ACP 本身不能表达任意输出替换，也没有完整 form/url 反向交互能力；不能承诺重连可以重造全部瞬态事件。

入口实现应使用同一启动/连接身份规则。底层显式嵌入、Host 内执行适配和产品入口必须分清；不能因为 storage、extension 或回调不可序列化，就在产品 Client 内另建私有执行 owner。入口的当前迁移状态以源码和 FEATURE_298 的验收记录为准，未迁移接缝不构成新的稳定产品能力。

当前没有承诺：浏览器远程传输、Host 崩溃后自动恢复全部执行、跨 Host 全局恰好一次提交、事件无限回放、任意时点全文快照、跨协议完全等价的瞬态输出。新增能力先扩展纯契约及 Host 实现，再让各 UI 消费；不以 UI 私有读取、版本分支或第二份执行状态绕过契约。

## 显式工具执行与 Session Stop（FEATURE_299 合入）

`runs.startTool({sessionId, inputId, name, input, rawInput})` 将用户明确指定的工具交给同一 Host。CLI 的 `!command` 使用这个入口；执行仍经过工具可见性、权限、Shell 边界、记录及取消规则，不直接启动客户端进程。相同 inputId 和意图返回同一 Run；同一身份换工具或参数拒绝。取得 Run 身份后通过 `runs.await` 和 Session 视图消费结果，开始执行不代表成功。

注册扩展命令的 handler 与随后模型接续属于同一个 Run，贡献快照保持到整个 Run 排空；期间热更新只影响之后的 Run。共享 MCP 调用沿用这个 Run 的 Session 归属，表单或 URL 交互进入同一 Interaction 面。MCP 目录查询与显式目录刷新也占用现有 provider 使用保护，替换连接会等待正在进行的读取结束；关闭中的连接不会另起握手进程。

`runs.stop(runId)` 只停止指定 Run，供 redirect 等局部操作使用。用户的整个 Session 停止操作使用 `sessions.cancel({sessionId, expectedRunId, requestId})`；在重试同一次请求时保留三个字段，不能换身份或用客户端 list/stop 循环替代。Host 固定当时的 Run 顺序边界，先处理排队 Run，再处理活动 Run；边界后的新提交不被这次请求取消。尚未消费的产品输入队列继续遵守原保留与撤回语义，不能当作排队 Run 擅自删除。

返回的 `accepted` 与清理确认不同；自然完成可以赢得终态竞态。重复请求不重新执行副作用。`unknown` 表示尚未确认清理，不能显示成已经停止。部分交付失败保留该请求的边界；原请求重试完成后才释放，其他请求不能替它解除。此处复用主线已有的领域停止记录，没有恢复已删除的通用 operation envelope。

## 活动面与批准计划

`activity.todos`、`children`、`managedTask`、`costReport` 是 Host 事实，终端直接消费；本地加载状态不能覆盖另一个客户端启动的活动 Run。`managedTask.childFanoutClass` 与 fanoutCount 共同驱动原 AMA 后台条。模型内调用工作流时，`activity.workflow` 复用已有 `ClientWorkflowProcess`，保留阶段、计数、状态和名称；子代理摘要作为可补读、可保存的显示项提供。临时 Worker 进度仍只属于活动面，不变成用户对话。

计划批准使用已有 permission Interaction，`options.plan` 提供完整计划正文，不从截断的 inputPreview 恢复。首个有效回答生效；Host 确认当前 Run 仍在运行且仍为 Plan 模式后才应用批准结果。拒绝、取消及 Stop 不切换权限模式，客户端不能自行先显示已批准。
