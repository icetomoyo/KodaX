# SDK 统一 Client 契约迁移指南

适用范围：当前工作树的 FEATURE_298/299/301/303/304/305 实现；本次核对的包版本为 `0.7.97-beta.6`，随 `v0.7.97-beta.6` 标签发布（npm 发布为手动步骤）。接入前应核对所安装包的导出和 Host 能力；下文带日期的 beta.1/beta.2/beta.3/beta.4 记录保留各自历史范围，beta.5 的变化见 [SDK hardening migration](#sdk-hardening-migration-shipped-in-v0797-beta5)。beta.6 的破坏性变更见 [One Host per KODAX_HOME](#one-host-per-kodax_home-profile-removed)：Host 位置的 `profile` 已删除。

Space 的可信授权绑定、canonical Fork/Retry/Rewind、宿主配置、附件/统计与退出恢复范围见 [SDK/Host 接缝](SPACE_SDK_SEAMS.md)。

从 beta.2 升级后，检查 Host 的 `productHistoryLocation` 和 `productHistoryTurnResolution` 再启用搜索定位和整轮操作。旧会话无需改写。保留 SDK 返回的字符串修订和确认时的分支头；收到过期结果时重新选择目标。

2026-11-02 发布验收修复中，扩展 API `exec()` 的 PowerShell 启动改为
`-NoLogo -NoProfile -NonInteractive`，避免隐式执行用户 profile 和交互提示。
依赖 profile 内函数或 alias 的扩展需在命令中显式初始化（例如 `Import-Module`）。
原命令超时、秘密环境变量白名单和显式 Bash 执行契约保留。

Markdown Agent / SDK profile 的行为指令通过 `agentProfile.instructions` 保留，
Solo 和 Adaptive 都会向模型提供可用且已授权的 Skill 目录。运行时绑定生成的
目录共用 8,000 UTF-16 单元上限；省略目录项不会删除已绑定的授权。
调用方显式设置的 `systemPromptOverride` 仍是 Solo 的完整提示覆盖，不自动追加
可选 Skill 目录。`sa` 当前仍是可执行的 Solo 模式；`amaw` 才是归一为 `ama` 的旧别名。

## 2026-11-03 beta.1 后续修复（未发布）

本轮基线为 `v0.7.97-beta.1` / `e733e51f`，后续修复已随 `v0.7.97-beta.2` 发布
（npm 发布为手动步骤）。截至 2026-11-07，`beta` 指向 beta.2、
`latest` 指向稳定版 0.7.96，这是正常发布策略。下述后续修复须分别验证源码、
正式包、实际运行 Host 和 Space 成品，不能用本地版本号推断旧 Host 已升级。

- Promotion 提交后，已有/新增/第二客户端观察者须刷新元数据及历史边界；
  保留原 Session、正文、附件和 ID。陈旧分页仍按原修订规则失效。
- Pending 输入的原始意图与失效连接授权分开；仅原稳定 principal 可以重绑
  未消费的原输入，并通过持久幂等撤回回执取回完整正文及附件。
  共享接收状态不授予其他 principal 读取原输入全文的权力。
- Script Stop、冷 Host 和 observe 后历史首读分别验证；内部写入收敛不放宽
  真实并发变更/过期分页冲突。Issue 371 的历史加载性能继续独立验收。
- Partner 的可信 Agent 模式要求在 Host 准入、消费和装配边界核验；模式要求
  与 shell/write/子 Agent 权限正交，不通过禁止正常工具实现。
- Script 分阶段补组合/安全并发、模型选择输出与完整证据、长任务观察及有界
  跨 cell 数据；保留原生调用、权限、预算、guardrail、真实参数与取消清理。
  性能及智能验收计入新增教学、回读、全部 Provider 请求和实际 usage。
- Repo-intelligence 诊断/预热由实际执行 Host 返回，复用同一缓存；保留按需
  初始化与失败回退，预热错误不归为 Provider 失败。Linux 既有指引先复验。
- Workflow 保留 slash、进度、停止及会话最终结果；新增独立运行记录管理与
  rename/delete/prune 公共接口需求撤回。Host 确认自身子任务/资源停止后，
  持久完整结果、报告与历史引用，再释放运行状态和清理无引用临时资源。
  结果/交付物、项目文件、保存定义、其他客户端及 unknown 运行受保护；
  断连不等于取消，冷恢复只续清理不重放未知副作用。

本节固定源码实施契约；每个切片的运行证据与未验边界记录在
[本轮测试指南](test-guides/FEATURE_298_v0.7.97_TEST_GUIDE.md#2026-11-03-beta1-后续正确性与-scriptworkflow实施中)。
真实账号、覆盖安装、跨平台和麒麟实机继续单列验收。

### 输入恢复与模式约束

`connectKodaXClient`/`ensureKodaXClient` 要求实际 Host 的
`productInputRecovery:1`。Main 持久保留原 `instanceId`/`instanceSecret`，
由认证连接派生稳定 principal；仅对尚未消费且旧连接 generation 已失效或 lease
已撤销的输入，按原 inputId、全文、附件、delivery 和 target 重提交以重绑。
同连接仍有效时不能用另一 lease 替换已接受的授权。

`inputs.read` 继续共享接收状态；`inputs.withdraw` 的全文和幂等回执只属于原
principal，外来身份返回 `permission_denied`。这是对旧跨 principal 撤回行为的
必要收紧，不影响普通 Agent 工具权限。回执与移除 pending 原子提交；丢响应后
按原 Session/inputId 重试 withdraw，返回原正文、附件 descriptor 及 delivery。
已撤回 ID 再提交返回 withdrawn，不能再次执行。回执保留至 Session 释放/删除。
旧数组队列继续读；新 envelope 使旧 Host 保守拒绝，坏文件仅阻断所属 Session。

Partner 可在可信 Main 使用
`services.createExecutionProfile({requiredWorkMode:'agent'})`，要求实际 Host 的
`productExecutionModeConstraint:1`。Host 在准入、排队消费、安全点和最终装配
核对模式，不匹配返回 `execution_mode_mismatch`，保留原问题。它不自动切换
Session、不限制正常 shell/write/子 Agent；子 Agent 保留自己的模式声明。
静态 pending 约束随原意图持久化，新连接省略字段不能放宽。
根 Run generation checkpoint v3 保留约束并校验原身份/fresh authority；
旧 Host 拒绝 v3。Main recovery.profile 可读取原约束，不应改成当前 UI 选择。

### Repo-intelligence 诊断与预热

在既有 Product catalog 使用
`catalog.inspectRepoIntelligence(sessionId)` 和
`catalog.prewarmRepoIntelligence(sessionId)`；实际 Host 须声明
`repoIntelligenceDiagnostics:1`，旧 Host 在发送前明确拒绝。
返回 runtimeId、sessionId、workspaceRoot、配置/请求模式、effectiveEngine、
status、initialized 和 warnings。inspect 只看现有缓存，不执行 probe 或索引；
未初始化不是 ready，prewarm 可等待当前共享缓存完成，另一客户端能读到同一事实。
Host 根据受准入 Session 解析路径与有效设置，不接受 Renderer 自报缓存状态。
off/禁用预热保持惰性；worker 降级保留 warnings，不触发 Provider 请求/失败。
缓存过期或 Host generation 变化后应重新观察，不能沿用旧 ready。

### Script 的分阶段契约

参照 Code Mode 的可观察效果，保留 QuickJS，实现顺序为 S1 组合、S2 输出与证据、
S3 长任务与 Run 内数据；不以 JavaScript 可执行或选择 Script 模式作为覆盖证明。
这些阶段复用既有 Run、Host dispatcher、Session records 和共享预算，不建立第二个 Runtime。

参照依据（2026-11-04 复核）：OpenAI 的 [Code Mode hooks 契约](https://learn.chatgpt.com/docs/hooks#tool-calls-from-code-mode)
要求嵌套调用继续接受执行前阻断/参数改写，执行后拒绝不能撤销副作用；
[配置文档](https://learn.chatgpt.com/docs/config-file/config-reference) 区分 direct、deferred
和 code_mode 工具面。并发、取消 drain 与非持久 store 的实现参照为本地官方 Codex
源码 `edd1ae37ec82650e8d7a97a7e84db39fd5722441`，不是所有已部署版本的能力声明。
据此选择复用原 dispatcher 和权限路径、保留原生调用，并分别定义观察、完成与清理。

- **S1 工具组合与顺序**：脚本中的 `tools.NAME(input)` 沿实际 registry、Host/MCP
  已授权绑定、guardrail 和权限路径调用。只读且允许并发的独立调用可并行；写入与未知
  副作用保留屏障顺序。真实参数在 guardrail/hook 修改后先持久再执行，不能只记录模型
  原参数。并发准入后若工具被改为有副作用则拒绝，不能静默重试。原生 `tool_call` 仍可
  调用同一能力，bash 保留原生入口；不强迫每个任务经过 Script。
- **S2 完整证据与选择输出**：`cell.started/output/yielded/settled` 与
  `call.started/prepared/settled` 写入同一 canonical Session。模型侧
  `selected_output:true` 仅在可证明的正文/必要说明分离边界省略正文；失败、警告、
  分页、截断和未决副作用不得消失，无法分类的结果保守完整返回。
  `script_read({cell_id,call_id,offset})` 在同一 Session 回读原始参数及结果，
  按 `nextOffset` 续页；unknown 不是执行失败或可重放证明。
  单次传输过大的结果先保存完整 receipt，再向 cell 返回 `result_ref`，
  `await read_result(callId,offset)` 只允许读取本 cell 已完成的结果，按页处理原始 JSON。
  不截掉原文后伪称已完整处理，也不因回读再次执行工具。
  Script 的文件读取返回程序可用的实际正文，不复用“模型已看过正文”的 native read
  去重提示，也不把 guest 读取登记为模型已见原文；写入/编辑仍使原生读取缓存失效。
  原生 read 保留原有去重，程序重复取数的必要 I/O 不宣称为效率收益。
- **S3 观察、取消与数据生命周期**：`script_exec({code,yield_time_ms})` 和
  `script_wait({cell_id,cursor,yield_time_ms,cancel})` 的等待窗口不延长执行截止。
  yield 返回观察，不等于完成；取消先报告 cancelling，只有 `cleanupComplete`
  才证明已准入调用及其清理收敛。父 Run 退出须取消并 drain 活动 cell，Stop 保留
  interrupted 历史。每个 Run 同时一个活动 cell；独立 Run 互不加全局锁。
  `store/load` 在该 Run 的 fresh VM cells 间传递 JSON，最多 128 项、合计 1 MiB，
  `store(key,undefined)` 删除。结束或 Host 崩溃即丢失，不是恢复 checkpoint。
  cell 默认 60 秒、64 次尝试调用、32 MiB VM、单次传输 1 MiB；控制消息另按现有
  调用/字节限额派生总量上限，空消息也计费，重复 yield 合并，避免无界入队。

这些实现不自动重放未知副作用，不放宽权限或增加模型评审调用。提示与工具契约的
新增字节、实际脚本执行比例、任务正确性及全部请求/token/耗时分别报告；有界 smoke
不能证明总体效率提升或模型智能无回退。

### 2026-11-04 原文返回与按需输出描述（未发布）

基线 `37258ec5c`。Host Run 工具与显式 `mcp_call` 的成功、未被后处理改写的
Script 结果可增加 `sourceContent`：它直接保留 `CapabilityResult.content`，可为
字符串（包括空串、空白和原行分隔）或普通 JSON 内容 blocks。它与已有展示
`content`、结构化 `data.value` 分开，消费者无需从展示标题、行标签或拼接文本中
反向提取原文。它不是警告分类器，也不代表传输或文件字节原文；普通文件 read
的 `data.text` 规范化契约保持。本轮不扩展 resource/fallback 路径。

原字段缺省、非普通 JSON blocks、容量不足、错误或后处理改写时，该可选视图
可能缺省，不能据此推断来源为空或没有警告。未知 metadata 不会授予此字段。
原生无投影监听方不新增复制；Script 字符串免复制，blocks 独立快照，guest 修改
不改变持久原文。最终内容匹配和错误门禁防止绕过 hook/脱敏。可选快照容量失败
记录诊断并保留原结果，监听和持久化异常仍传播，不变成 Provider 失败。

VM 和完整 receipt 保留 sourceContent，额外字节计入原容量/传输限额。大结果
继续按既有 result_ref/read_result 分页，Session 原文用 script_read 读取，不重复
执行工具。模型回执仅在原文可回读、展示中已有完整副本且严格减少 UTF-8 字节时，
使用 `sourceContentOmitted:true` 和 `original:{cell_id,call_id}` 引用；显式返回及
未显示、空白、小值继续保留。该优化不等于模型必然选择最少上下文。

Host 工具注册 descriptor 新增可选 `outputSchema`，经原 IPC 注册和已有
`mcp_describe` 按需返回，同时完整显示 Host description/server。标准 MCP 原字段
优先；默认搜索、RunScoped 工具合同和模型菜单不常驻大型输出 schema，不自动
describe 或执行工具。未声明就是未知；这是工具方声明，不表示 SDK 已验证每个
返回值符合 schema，也不是新的执行授权。旧 Host 可能尚不返回该可选元数据，
接入时须核对实际 Host，不能只看 Main SDK 版本。

SDK 保证受权返回视图与证据保真可读。消费者若要求交付物逐字保留来源，应直接
使用原值、在交付前比对并回读验证；本轮不增加全局写入拦截或自动修改文件。
既有模型样本的警告前缀失败继续保留，不以新接口保证任意模型的业务产物正确。

### 2026-11-04 Script 调用路径与程序数据（未发布）

基线为 `49da64f24`。前次真实样本的裸名调用和格式化文本解析失败，按通用调用与
结果契约修复；生产说明只描述 API，不加入任务解法、文件扩展名分支或模型专属指令。
原生工具、权限、预算和 fallback 继续独立可用。

`tools["实际工具名"](input)` 是完整调用入口，每条 Script 工具合同将调用路径与
原始名称、输入 schema 放在一起。可用作 JavaScript 标识符且不与全局对象、内建、
控制函数或保留字冲突的工具，提供同一函数的裸名兼容；其他名称继续按原名使用括号
调用。两种形式进入同一受权 dispatcher，不扩大工具集、改名或自动重试。

成功的内置文件文本读取可提供 `result.data`，原 `content` 仍是完整显示结果：

```ts
{
  kind: 'text',
  text: string,
  normalized: true,
  offset: number,
  line_offset: number,
  lineCount: number,
  complete: boolean,
  next?: { offset: number; limit: number; line_offset?: number }
}
```

`data.text` 是最终有效窗口的文本行以 LF 连接，不含展示行号、页尾或原始行分隔；
不保留原文件末尾换行的存在信息。它是规范化文本窗口，不能作为字节原文。`lineCount` 只计
当前窗口，可区分空文件与一个空行；`complete` 只在从源开头读到结尾时为真。
读到 EOF 的后半段仍不完整；存在 `next` 时可将参数与原 `path` 合并继续读取，
长行的 `line_offset` 以 Unicode 字符计。工具不自动解析 JSON 或猜测数据格式。

文本数据由读取器在原有选窗和输出预算内生成，经最终后处理后仅在显示内容精确
匹配时接受。内置 read 的图片、错误、transient artifact，以及没有受信投影的未知
结果，不假造文本 `data`；消费者须处理它缺省的情况，并检查 `isError`、警告及续读证据。
Native 读取不为这个契约额外读取文件；Script 仍保留内容哈希与写后缓存失效。

Host Run 工具与显式 `mcp_call` 的既有 `structuredContent` 可提供另一种数据：
`{kind:'json', value:KodaXJsonValue}`。它直接保留 JSON 类型，不从展示文本或外来
metadata 猜测。对象、数组、有限数字、布尔值、字符串和 null 受支持；undefined
不提供数据。MCP 显式 null 优先于旧 snake_case 字段，缺省时继续兼容原回退。
消费者按 `kind` 使用 `text` 或 `value`；此范围不包含尚未接入的 fallback/resource 路径。

仅有监听方时校验并快照 JSON 值及图文显示内容，防止原对象或 block 在后处理期间
原位变化；最终内容不匹配或标错即撤销投影。可选快照超出运行时容量时记录诊断、
保留原成功结果与完整证据，不把它改成工具或 Provider 失败。普通 native 没有这个
额外遍历/复制。JSON 投影不将未知正文标作可省略，`selected_output` 保留全部原文、
图片及不明警告，不以 typed data 的存在推断上游结果完整。

VM 与持久回执保留 `content` 和完整 `data`，既有 `result_ref/read_result` 与
`script_read` 可回读完整 DTO。模型侧回执可用原文引用省略重复的派生 `data.text`，
保留窗口与续读信息；用户主动返回的值、输出以及失败/警告继续保留。
这会增加持久化和 VM 传输字节，可能更早触发大结果引用，须计入实际性能结果。
JSON 的模型回执只有在原文可回读、实际显示已包含副本且引用严格减少 UTF-8 字节时
才省派生 value；null、未显示值及小值保留。选定文本隐藏继续遵守原有语义。

Script 验收须显式配置 `workMode:'script'` 并核对实际 cell/leaf 回执。功能覆盖任务
可以明确要求在 Script 中取数、计算和保存；这种覆盖不计作模型自主采用率。另用
自然任务观察 Script 模式及原生 Coding 模式的实际选择、任务结果和成本，原生工具
继续可用。模式已选中、JSON DTO 已进入 VM 或任务最终正确，都不能单独证明脚本
实际完成了数据计算；需核对执行代码与输入到交付物的依赖。

`code` 是 async 函数体，cell 的生命周期由该 body 的 Promise 决定。调用异步
helper 时须在 body 内 await 或 return 其 Promise；仅在 helper 内 await 工具
不足以等待整个 helper。未等待的工具调用仍会失败，yield 只影响观察，不自动
接管脱离 body 的工作；已有或未知效果仍通过完整回执核对，不自动重放。

本轮同时修复实际 Ark 使用的 Anthropic-compatible 原生工具名传输：不符合协议的
名称使用可读片段加稳定摘要的合法别名，返回、流式 delta 与历史回放仍恢复 SDK
原名，参数、权限和 canonical 记录不变。`kdx_` 是传输保留前缀，以它开头的合法
SDK 名称也会编码，避免与生成别名冲突；普通合法名称及内置工具合同不变。
别名不是执行授权，未知别名不越权解码，真正生效的 forced 名必须来自当前原名
工具表，signed/opaque 协议原文保持。此修复限定该协议路径；OpenAI Chat 等其他
协议没有由本轮获得同类兼容，已发现的 OpenAI Chat 同类透传限制仍待独立处理。

### Workflow 的同 Host 收尾

保留现有 slash 执行、进度、停止、读取与 Session 最终结果；本轮不新增公共
rename/delete/prune，也不扩展独立运行记录产品。执行的同一 Host 先等待自身该 Workflow
的子执行器真正停止，再原子持久完整 `result.json`、报告/manifest 和稳定的
`workflow:<runId>:result` Session 输出及 artifactRefs，之后才发布终态并释放运行状态。
合法 `undefined` 结果使用显式 envelope，与缺失原文区分；断连不触发取消。

清理只处理 Host 已登记的、owner/终态/停止证据完整且无引用的临时资源。发布终态前
先持久 cleanup receipt；重启仅读这个小型 pending 索引续清理，不扫描历史或重跑脚本。
结果、报告、交付物、脏或未合入 worktree、项目文件、保存定义、其他客户端和状态未知
运行继续保留；失败清理可续办，不能以按年龄删除或全局 git prune 冒充自动收尾。
Space 通过公开 Host 结果/历史接口读取，不直接操作 Host 运行目录。

其他 Session 将临时 worktree 或子目录用作项目/执行目录时，Host 在准入边界解析
真实路径并持久登记项目引用；即便采用者空闲、Session 删除或 Host 重启，也不把已采用
项目重新当垃圾。登记与删除共用每个 worktree 的文件锁，锁内重验目录身份；别名不会
绕过保护。正常叶调用不逐次解析路径，也不为收尾增加全局 Session 扫描或全局锁。
开始执行前的 host-owner 证据允许运行中安全采用；普通同形状目录缺少 Host 证据时
继续按普通项目处理。

临时分支的精确路径、名称和原 OID 在移树前持久登记，临时删除失败保留 warning 与
pending；即便树已移除，冷恢复仍能继续。变更 OID 或被其他 checkout 使用的分支受保护，
最终 ref 删除以原 OID 作 CAS，不盲删同名新分支。收尾仅额外移除精确的空协调目录，
非空、未知或仍有等待者的目录保留。

### 交付顺序与剩余验收

1. 先交付本轮源码和独立 Host 回归，固定构建身份；本地源码通过不代表 npm 已更新。
2. 后续正式发包须从该源码生成新 beta，复验真实 tarball 的 SDK、worker、协议数据与
   原 CLI 体积门禁。继续保留稳定 `latest=0.7.96` 的通道策略，不用覆盖旧 beta.1 代替发布。
3. Main 连接实际 Host 后核对上述能力键与 runtime generation；升级包后仍存活的旧 Host
   必须先完成既有切换流程。运行中 Session、未消费输入及恢复授权按各自契约迁移。
   新 Script 行为另做实际 Host smoke，不能只凭 SDK 版本或已有执行器能力声明判断。
4. Space 再验 promotion/输入重绑/Agent 模式拒绝、预热状态、Workflow 原文与自动收尾，
   通过共享 Host 接口接入。SDK 的独立双客户端通过不替代 Space 成品验收。

Script 的源码机制与真实模型可用性分别推进：调用路径及程序数据修订已提供通用契约，
CSV 样本实际消费文本数据，新的 Host 样本完成任务，但尚未观察到 VM 内用 JSON
value 计算。旧 XML/日志样本未完成及警告改写也继续保留，不能把原生 fallback 或最终
任务正确代替脚本数据处理及效率证据。保持显式选择和原生能力，后续使用独立问题、
预算及受控样本评估智能与效率，再决定默认策略；生产说明不加入任务或模型专属解法。
跨平台、麒麟、真实账号、覆盖安装和 Issue 371 仍由各自验收关闭。

## 统一 Host SDK 收口（未发布）

### 2026-11-02 Space 默认方法、消费绑定与 Quick Ask（alpha.12 之后，未发布）

已发布的 `0.7.97-alpha.12` 不含本节接口；本节接口随 `v0.7.97-beta.1` 发布。
请锁定该实际发布包（beta.1 的 npm 发布仍为手动步骤），并检查
`productExecutionBinding:1`、`sessionPromotion:1`；旧 Host 明确返回
`daemon_upgrade_required`，不能忽略声明继续执行。原配置、环境变量 Key、凭证 broker、
原 `authorizeExecution` 回调及未使用新字段的调用保留原行为。

可信 Main 可返回 `profile.defaultSkill:{name}`。Host 使用自己的 registry/config root
准备方法，保留原始用户问题、persona 与普通 Partner 的 shell/写文件/子 Agent 能力；
具体执行仍受现有模式、审批、沙箱和显式工具上限约束。用户显式 Skill 仅覆盖本轮，
下轮恢复默认。已识别的排队显式方法若消失会拒绝，不悄悄换成默认方法。

需要排队时读取最新业务配置时，在 Main 注册
`services.executionBindings.register(async (request, scopedServices, signal) => authorization)`，
外层 `authorizeExecution` 对 `kind:'input'` / `'recovery'` 仅返回 `{binding:{leaseId}}`；
命令、review、工具、Workflow、compaction/probe 和独立 Actor 继续各自原有的显式授权，
不能把根输入 binding 用于这些操作。`request.phase:'admission'`
发生在真实准入/消费边界；回调原子读取最后成功提交的专家/连接器状态，返回正常凭证、
工具、profile 以及 `businessBinding:{id,revision,data?}`。`data` 只放非秘密事实，整个
快照最多 16 KiB。每次解析使用回调传入的 Session 专属 `scopedServices` 构建 profile，
不要闭包缓存首次 Session 的目录；不要在 Main 展开 Skill、执行 hooks 或修改原问题。
同一 Run 的工具上限保持固定，业务变化的后续输入进入下一 Run。未提交 UI 草稿不生效；
禁用/撤销必须事实拒绝，明确移除专家可以返回已提交的普通 Partner 绑定。

`phase:'recovery'` 提供 `recovery.snapshot` 和原 persona/profile 事实：保留原业务快照，
重新获取当前凭证/连接器 lease 和更窄的工具上限。不要用当前选中专家替换原专家。
旧 Run 没有业务快照时，Main 必须自行核实来源，不能猜测账号或绑定。
已准备 Skill 的回执保存原 hooks 附加上下文及来源/策略指纹；冷恢复不重放准入 hooks，
来源或策略变化会明确拒绝。旧 checkpoint 无法证明有副作用 hooks 已完成时也拒绝自动重放。
带新快照/回执的 checkpoint 使用 v2，旧 Host 不能降级读取执行。

断连、失效或拒绝返回 `execution_binding_unavailable` / `execution_binding_rejected`；
恢复换业务返回 `execution_binding_changed`，缺失已选方法返回 `default_skill_unavailable`。
排队失败保留原输入，`inputs.read` / 队列暴露 `admissionError`，不丢弃或自动重试。
原 principal 以同一 inputId/原问题重提交可重新绑定；也可显式 withdraw。
旧 alpha.12 队列的显式方法身份可从唯一原引用恢复；歧义或方法消失时保留原问题并
要求确认，不以新默认方法替代。恢复的根 Run 业务快照不授权尚未消费的新轮次。
重连/冷 Host 后重新注册进程内 lease；独立 Actor 使用自己的准入，不借用根专家声明。

Space 独立补审后的修正：`steer` 也先在 Host 解析 Main binding，再比较目标 Run 的完整
授权 key、principal 和窗口；解析完成后重新核验目标仍活动。同授权的 steer 进入原 AMA Run，
变化的业务/profile/credential/tool lease 仍拒绝，不能以新 lease 或当前新专家替换原执行。
Main 应为 steer 返回目标 Run 原有声明；同 inputId 的已接受重试不重复解析或注入。
`redirect` 入队保存已识别的显式方法名，消费前卸载会保留输入并返回
`default_skill_unavailable`，不回落默认方法。旧补丁写出的
`skill:true / explicitSkill:null / redirect` 同时可能来自普通 Run 边界，不能只凭 delivery
认定显式方法。新普通边界由 Host 持久保存内部 `plainRunBoundary:true`，冷恢复后仍不按
旧显式意图判断；这不是 Client 输入选项，不由 Main/Renderer 提供。旧 null 记录无方法
引用时按普通输入恢复，仍使用消费时 Main 最新成功提交的默认方法；带引用的旧记录按
唯一方法保守恢复，方法缺失或引用歧义仍拒绝，原问题可撤回。已报错输入继续要求原
principal 重绑，不能借迁移获得另一账号或专家的 authority。持久字段 `skill` 保留旧名称，
含义为独立 Run 边界，不能据其为 true 推断一定有具名方法。Client/wire 输入与既有配置、
凭证入口不变。
前一次 steer/显式 redirect 修正提交 `00bfe7ed12407eda722a6bc4b15ace106e413dc5` 已在 Root 主分支，
[完整 CI](https://github.com/icetomoyo/KodaX/actions/runs/41415454375) 16 个任务通过、
发布跳过；尚未发布 npm。Space 需使用包含本次修正的新 SDK，不能只依赖旧 alpha.12。
该 CI 是普通 redirect 第二次补审前的基线；以上边界区分修正还需包含在后续新 SDK 中，
本轮独立验证见 [普通 redirect 补审](test-guides/FEATURE_298_v0.7.97_TEST_GUIDE.md#普通-redirect-的补审修正2026-11-02)。
普通 redirect 功能修正为 `cd151cb1ddf7eb273debb5e458a9c989d8804ac1`，含后续门禁修正的
候选 `962a41600d5676460e35866be908ec22b32c301b` 已推送 Root `KodaX` 主分支，精确 SHA 的
[CI 41438153424](https://github.com/icetomoyo/KodaX/actions/runs/41438153424) 16 个任务成功、
发布跳过。未发新 SDK 包；Space 升级时必须包含本轮修正，原 Client 参数和凭证入口不变。

Quick Ask 使用 `sessions.promote({sessionId,requestId,expectedRevision,tag})`，修订来自
`sessions.read(...).metadataRevision`。成功返回 `{requestId,session}`，仍是原 Session ID。
Host 原子保存 tag 与操作回执，历史、原生历史、lineage、附件和统计不变；新 promotion
要求会话空闲且可写。每个原 Session 一次 promotion，相同 requestId/修订/tag 可重试；
不同请求或变化的参数返回 conflict。丢失响应时调用
`sessions.readPromotion(sessionId,requestId)`，按原操作查询/重试；确认成功后 Space 才更新
侧栏和 ephemeral 状态。Fork/Recover 的新 Session 不继承源 promotion 操作身份。
元数据提交会刷新 Session capture/history 修订，Space 应重新读取分页 cursor 与 historyBoundary；
修订变化不代表历史内容被改写。

发布包新增 `runtime-daemon-schema.json`：构建从同一个 TypeScript 协议源生成完整数据，
Node SDK 与独立二进制均携带。自定义打包需保留该资源，不能省略后放宽协议校验。
CLI 原体积门禁、CI job/矩阵/触发条件和发布依赖关系保持原值。

### 2026-11-02 核心配置提交补齐（alpha.12 之后，未发布）

Space 正式 alpha.12 验收基线为 `codex/sdk-alpha12-preparation@ca8d2313`；其配置
原子性反馈已纳入 Root 后续修复。本节新增实现已随 `v0.7.97-beta.1` 发布，历史
版本字符串 alpha.12 不含这些字节。没有修改 Space 产品代码或其凭证来源。

所有核心配置修改（Runtime、Provider CRUD/setup/OAuth registration、旧权限模式保存/
迁移、初始化、saveConfig 与拆分集成迁移清理）使用同一配置写锁与原子替换。
写入在同目录临时文件完成并同步后才发布；合作 writer 在锁内重新读取当前配置，保留
未知字段与凭证。普通未加锁 reader 只见完整旧文档或新文档。此保证要求所有 writer
升级；旧版截断写入、直接外部编辑、两个不同路径别名锁，以及突然断电的文件系统持久性
不由它保证。显式配置文件 symlink 的原入口继续保留。

可信 Main 可从 `/repl` 导入 `readCoreConfig(configPath)` 读取完整文档；只有文件确实
缺失才返回 `{}`，损坏/不可读/断链返回 `CoreConfigReadError`，不回落默认值或重置账号。
错误不携带配置原文或解析器 cause。`CoreConfigWriteConflictError` 保留原类身份，增加
`code:'conflict'`、`data:{source:'configuration',reason:'lock_busy'}`；读取错误为
`code:'internal_error'`、`data:{source:'configuration',reason:'read_failed'}`，兼容既有 RPC 错误码。
Space 现有有限锁忙重试可保留；不重试损坏文件，不把配置忙归为网络故障，不补取新 CAS
版本后盲目覆盖。确需复合修改时，使用已有 `withCoreConfigWriteLock`，锁内读取，调用
新增公开 `writeCoreConfigAtomically`；不要嵌套再次加锁的 SDK mutation。
锁失败或临时文件写入失败不发布部分配置；成功提交后才应用 Runtime 默认值/更新注册表。
Windows reader 短暂拒绝替换（`EPERM`）时，在同一锁和 staged 文件内做最多 1 秒
累计重试；永久拒绝、其他 IO 错误仍报错并保留旧文件。预算限制重试调度，不能打断单次
内核调用。发布后的锁释放失败可能发生在提交完成之后；遇到它或断连等结果不明时先重读
核对，不能假定失败等于未提交，不自动回滚或重放凭证/账号切换。凭证 binding/revision、
OAuth 和撤销规则保持；改名不证明新别名有权使用旧账号。

前次功能基线已推送 Root `KodaX@b385395c9f8686aee182a4c6a38b4f3008421d32`，完整 CI
[41401900534](https://github.com/icetomoyo/KodaX/actions/runs/41401900534) 全绿（16 个
任务成功、发布按预期跳过）；本机冻结全套 19252 通过、87 条件跳过、0 失败/0 TODO，
源码与产物指纹一致，双轴复审无剩余项。完整证据和先前失败见
[最终验收](test-guides/FEATURE_298_v0.7.97_TEST_GUIDE.md#最终验收2026-11-02未发布)。
设计子仓仍为 `7927f835744643b418d463b10a2e1c1c4bdd12e8`，Space 独立分支及产物未改。
接手时先锁定包含该提交的 `v0.7.97-beta.1` SDK 字节（npm 发布为手动步骤），按能力门禁启用默认方法/业务 resolver 和
promotion，保留配置有限锁忙重试与原凭证来源，再走 Space 生产安装包的账号保持、撤销、
排队/恢复和 Quick Ask 成品回归。已发布 alpha.12（标签 `f24a922c1`）不含本节后续补丁；
本轮没有移动标签、发布 npm 或替 Space 完成产品侧适配。

### 2026-10-30 SDK 组合契约修复（未发布）

Partner 默认具备所选通用 Agent 工作面的能力：persona、surface/profileId 和专家验证
不是隐式只读权限。使用 Session `workMode:'agent'`，不需要为了准入创建 profile。
`agentMode:'sa'` 仍保留 Solo 子 Agent 排除；AMA 保留协作能力。实际操作仍受显式工具
策略、permissionMode、审批、连接器绑定、管理员策略和沙箱限制，不自动升级为 Full Access。

有现有 persona/策略时，可信 Main 通过 `authorizeExecution` 的
`await services.createExecutionProfile(existingContext, hostToolLease.tools)` 绑定。
helper 查询该 Session 的 Host 实际工具目录，再加入本次 lease 工具；谓词留在 Main。
返回数据包含允许工具的名称、sideEffect 和 planModeAllowed。Host 在 schema、发现及
目标调用时重检，并与工作面取交集。Host-only 扩展因此可以正常获得显式授权；同名工具
元数据变化后不会沿用旧授权。无工具限制的 persona-only profile 不制造工具白名单。

```ts
import { ensureKodaXClient } from '@kodax-ai/kodax/client';

const client = await ensureKodaXClient({
  async authorizeExecution(request, services) {
    const existing = await authorizeExistingCapabilities(request, services);
    // 由可信 Main 注册表解析，不接受 Renderer 提交的 authority。
    const partner = lookupRootPartnerContext(request);
    return partner ? {
      ...existing,
      profile: await services.createExecutionProfile(partner.context, partner.hostToolLease.tools),
    } : existing;
  },
});
await client.sessions.updateSettings(sessionId, { workMode: 'agent' });
const accepted = await client.inputs.submit({ sessionId, inputId, text: '研究并生成报告' });
if (accepted.runId) {
  const { workMode, effectiveConfig } = await client.runs.read(accepted.runId);
  // effectiveConfig 在实际工具装配后出现；不要用 Session 选择值补造它。
}
```

上述应用函数复用原授权并解析根 Partner 上下文；独立 Actor spawn/followup 返回各自
声明的授权，不注入根 profile。派生子任务继承父级显式限制。`authorization.tools` 可
独立用于根 Run 或独立 Actor，和 profile 上限取交集；缺省不制造额外限制，`[]` 拒绝所有工具。
新契约需要 `productExecutionProfile.version === 2`；旧 Host 明确要求升级，不能静默丢策略。
独立库的同步 `createExecutionProfile(context, catalog)` 是纯 builder，显式谓词/排除项
必须提供可信 Host 目录；不能把 Main 本地 registry 当成跨进程目录。

授权服务保留 `services.identity.runtimeId`，用于识别当前 Host；租约缓存不能跨 Host 实例复用，恢复时重新注册。

授权快照对本次执行固定：新增或元数据变化的工具需下一次 Main 授权重新求值；保存配置、
扩展 reload 不放宽已准入 Run。恢复需重新绑定授权，恢复流程仍校验原意图；租约撤销后
native 与 MCP 别名都不可调用。MCP 普通连接器保持原 provider 授权，物化 Host 工具的
MCP 别名还必须通过同一目标工具上限；桥接不授予被排除的工具。

根 Run 的 profile 工具名称、元数据和独立 `authorization.tools` 上限作为非秘密准入
证据随恢复状态保存。每次恢复及重新绑定都继续取原上限与新授权的交集，连续重启也
不能放宽；新授权变为 persona-only 不会清除旧限制。同名工具的 sideEffect 或
planModeAllowed 改变时不能沿用旧元数据授权。此证据不替代本次 Host 的有效 lease
与授权回调，也不作为公开 Runtime 配置项或 Renderer 授权入口。旧记录缺失的证据保持缺失，
不能宣称已验证其历史工具快照。
仅完整来自可信 profile 的工具谓词可由该快照重建；任意自定义 Runtime 回调与旧
记录仍要求新的函数绑定。恢复保留原 persona 指令与验证要求，新授权只继续收窄工具。

`runs.read().effectiveConfig` 持久化最后一次实际装配快照，包括 `workMode`、`agentMode`、
`agentProfile`、`verification`、`toolScope`（含 Script/deferred 叶工具）和
`modelToolScope`（物理模型请求所见 schema）。显式工具入口没有模型请求，省略后者。
快照随请求更新，重连/Host 重启可读取；尚未装配或旧记录缺失时保持未知。
工具可见/可执行并不表示每次操作已获审批。低层 `onEffectiveConfig` 使用相同快照。

Artifact 既可通过 Host lease，也可通过原生 adapter 使用；原生路径依赖通用 write，
显式禁 write 时仍应拒绝。离线回归使用真实 Artifact runtime 生成 PPTX；不据此宣称
实际 Space 部署已迁移，或真实连接器与专家模型的质量已经验收。

Script＋SA 使用托管 Script 执行入口并保留 Solo 排除项。运行中切换计划权限或
planModeEffort 会更新下一次物理请求的 effort。Actor 恢复保留
`resumeCheckpoint:true` 和空 objective，经 `actorCheckpointRecovery.version === 1`
门禁继续原 turn；旧 Host 明确要求升级。

配置修改的确认仅表示已保存。`config.readEffective().application` 逐字段标明：
`immediate`（fallbackProviders/stallLog）、`next_run`（模型默认、输出上限、缓存、LSP、
模型 tiers、Workflow 等）、`extension_reload`（extensions，经既有 watcher 校验/reconcile）、`restart`（locale、
providerModels、lspAutoDownload、日志/保留/索引进程配置）。Session 覆盖仍优先；
上述输出、缓存、LSP 和模型分层的 next_run 默认低于真正外部环境变量，SDK 显式
Run 配置优先。fallbackProviders/stallLog 保留既有显式 patch 即刻更新进程环境投影的规则。
next_run 值在新 Run
准入时捕获；reload 不改写活跃 Run。读取 maxOutputTokens 等数量字段保持数字，
不会当作认证 token 脱敏。新增 maxOutputTokens/disablePromptCache/lsp 的有效值与
来源、applied 可用于确认；旧 Host 缺少 application 时不能补造已生效事实。
这里的 application 描述 Host 默认配置的生效边界；Session 设置的实时请求边界
见 [Client 契约](CLIENT_CONTRACT.md#配置生效边界)。回归步骤见
[FEATURE_298 验收指南](test-guides/FEATURE_298_v0.7.97_TEST_GUIDE.md#2026-10-30-sdk-组合与配置边界)。

本节描述 alpha.11 之后、已随 `v0.7.97-alpha.12` 发布的 Host 收口，优先于下文历史版本的嵌入示例。
完整产品执行只由独立共享 Host 拥有。产品使用 `ensureKodaXClient` / `connectKodaXClient`；
可信底层接入使用 `ensureKodaXRuntime` / `connectKodaXRuntime`。连接关闭只释放本连接。

| 原入口 | 迁移结果 |
| --- | --- |
| `createKodaXRuntime()` 或 `mode:'embedded'` | 改用 Client；旧 JS 调用返回 `runtime_host_migration_required`，不静默改写生命周期 |
| `createKodaXRuntime({mode:'daemon'})` | 保留为统一启动器的薄委托；`execPolicy/autoReview` 仍只用于新 Host 的一次性 bootstrap |
| `sharedDaemonHost` / `daemonHostRuntimeId` | 内部装配字段，不再在公开类型或构造中接受 |
| `acquireKodaXInlineOwner` / `setKodaXRuntimeOwnerMode` / `enableKodaXDaemonOwner` | 不再从根入口或 `/runtime` 导出；迁移交给启动器 |
| `externalAgents` 函数型工厂/策略注入，包括 `mode:'daemon'` 的旧进程内 Host | 明确退役，无透明等价替代；configured A2A 留在唯一 Host 内，独立 `/agent` executor-plane 库继续可用 |

启动器检查 profile 与实际 Session 存储根，在旧 owner 已退出且没有竞争写入者时，
原子地把旧 owner-policy 改成统一 Host 终态。旧 reader 会拒绝该格式，因此旧 SDK
不能在 Host 闲退后通过该 profile 回切 inline；旧管理工具可能报告策略格式错误。
不要删除这个文件来降级。迁移可以重复，提交后启动失败也不回退旧模式。
Session、Run 和历史数据格式不因该策略切换而改写。

同一 Session 目录已有其他 profile 的共享 Host 时，启动器复用它，同时在锁内重新核验
其进程身份并迁移本次请求的旧 profile，避免关停后从这个别名回切 inline；不会为迁移别名
重启现有 Host。请求 profile 自己仍有存活、未知或损坏 owner 时继续拒绝。

存活 owner、未知身份、损坏锁不自动回收；忙碌旧 Host 沿用正常升级阻塞。
旧私有 embedded 可能没有共享 owner 记录，缺锁不能证明其已退出：这类宿主须先停止、
升级并重载，或使用独立数据根。已迁移 profile 的门禁不能约束任意旧程序或新建 profile。
Host ready 与 Run 可恢复分开；Stop、历史变化、授权失败或效果未知继续阻止不安全续跑，
工具不因迁移或断连自动重放。长寿命旧 SDK 的构建身份保护保持。

历史产物、支持范围与执行证据见 [FEATURE_298 测试指南](test-guides/FEATURE_298_v0.7.97_TEST_GUIDE.md)。

## 2026-10-29 未发布改动对齐

核对范围为 `v0.7.97-alpha.10`（`6efeafa5`）之后至 `b70d2d30` 的源码。
以下能力已贯通相应的公开类型、Host 实现和 daemon 适配；不据此声称旧安装包、
Space 或其他外部客户端已升级，也不要求独立库与 Product Client 使用同一个执行入口。

| 当前能力 | SDK 消费要求 |
| --- | --- |
| Agent / Coding / 实验性 Script | 用 Session `workMode` 在首轮前选择，之后固定；版本化设置快照的 `workModeLocked` 表示只读；独立 SDK 边界见下文 |
| MCP/工具完整结果 | 工具项的 `outputPath` 标明 Host 保存的原文；使用 `readItem` 或 `readHistoryEntry` 的 `part:'original'`，不要在客户端直接打开路径 |
| 任务报告 | Product 项用 `taskResult`；`/session` transcript 的 `taskResults` 用 `KodaXTaskResultReport[]`，允许未知状态与缺失 taskId |
| 流式进度 | thinking 和有调用 ID 的 tool-input 均可带 `estimatedTokenCount`；显示 `~… tokens`，不能当成 Provider usage 或把 UTF-16 分页偏移改成 token |
| 普通问题 | 保留 skipped/non_interactive；本地等待超时不提交答案，Host 独占 deadline；Runtime `userInputs.respond` 拒绝客户端 timeout 对象 |
| Skill 策略 | 模型发现、激活与 SDK 调用复用可信 registry；`Bash(pattern)` 仅允许匹配的单命令，仍须 Host 授权 |

CLI 的 `--agent-mode sa/amaw` 是迁移错误；底层 SDK 的显式兼容 profile/角色/执行路由
仍按各自契约保留，不能机械替换为产品模式。该组能力已纳入 alpha.11；上节 Host 收口已随
`v0.7.97-alpha.12` 发布。
Issue 371 的历史首次读取延迟、Script 的模型效率及跨平台人工验收不因 SDK 对齐而关闭。

本次 Windows 源码核对验证（2026-10-29）：`npm run build`、`npm run typecheck`
通过；14 个 SDK 定向测试文件的 197 项测试全部通过，覆盖工作模式设置、daemon
协议、历史/原文、任务报告、流式估算、交互、Skill 生命周期与独立层级。
固定构建产物的 `bundled-mcp-output-recovery`、`bundled-skills`、
`bundled-task-results`、`script-release` 共 8 项全部通过，包含独立 daemon 重启
和实际 npm tarball 的 Script 执行/缺失 worker 拒绝。英文工作模式示例及新增契约
类型已针对生成的公开声明编译通过。这是离线夹具与当前 Windows 环境的定向证据，
不是全仓测试、真实模型或各平台发布归档的完整验收；本轮仅同步文档，未修改运行代码。

## 1. 替换范围与文档权威

TUI、桌面 UI、IDE、自动化应用接入共享 KodaX 时，以 `KodaXProductClient` 为业务契约。入口是 `@kodax-ai/kodax/client`；[完整行为契约](CLIENT_CONTRACT.md)与[类型定义](../packages/coding/src/client-contract.ts)共同说明方法、数据和错误语义。[英文接入指南](../public_docs/sdk/embedder-guide.md#product-client-integration)提供最小生命周期示例。

这不是对旧 Runtime 对象的重命名：提交输入、执行结算、交互、显示和持久历史现在各有明确边界。不要对旧对象做类型断言来假装它实现了 `KodaXProductClient`。

| 接入目的 | 当前入口 | 迁移要求 |
| --- | --- | --- |
| 产品 UI / 共享 Session / 自动化应用 | `/client` 的 `ensureKodaXClient`、`connectKodaXClient` | 默认采用统一契约；执行、配置与存储归 Host |
| 浏览器侧类型、自己的 UI 适配器 | `@kodax-ai/coding/client-contract` 的 `import type`，或 `/client` 的类型导出 | 纯类型可用；Node 连接器不能直接在浏览器运行 |
| 受信任 Host 的启动、凭据桥、Host Tools、诊断 | `/runtime` | 连接唯一共享 Host 的底层接缝；不属于产品 Client 的全部承诺 |
| 独立 Agent/LLM/coding 库 | `/agent`、`/llm`、`/coding` 等 | 保留独立使用；旧 `KodaXClient`/`Client` 是另一种执行对象，不等于 `KodaXProductClient` |
| 文件渲染与视觉证据 | 主包 `/artifacts` 子路径；共享 Host 使用 `/artifacts/client` port | 先由可信 Host 注册 `/artifacts/kodax` adapter；只安装一个主包，不新增 Product Client 业务域，不在 UI 本地回退渲染 |

根入口和上述底层导出尚未全部删除，也没有因为本次迁移就全部成为 TypeScript `@deprecated`。产品接入应迁走它们承担的业务职责；确需底层能力的受信任宿主仍可明确使用。客户端不能在连接失败时创建私有 Runtime，形成第二个 Session 写入者。

工作模式使用 `sessions.updateSettings(id, { workMode: 'agent' | 'coding' | 'script' })`；Coding 默认，仅首次 Run 被接纳前可选择，之后更换模式须新建 Session。`getSettingsVersioned` 返回只读 `workModeLocked`；旧 Host 缺少该字段时，产品 UI 应禁止修改并提示升级。

旧格式 Session 可能没有模式记录，但旧 Run 已持久化原执行配置。通过原身份、已停止 owner、checkpoint 和 fresh authority 校验后，同一 Run/Turn 可按原有效模式恢复；它不回填 Session 模式，也不写新锁标记，因此再次 checkpoint/restart 仍能恢复。后续新 Run 与普通/versioned 设置仍受 Session 锁约束。profile 和工具策略会影响有效模式，不能仅采用请求中的 `workMode` 字符串；持久 Run 事实与原快照冲突时明确拒绝。显式新格式锁元数据不适用该兼容路径；generation checkpoint v3 表达 Agent authority，不代表新锁格式。
产品 Host 能力由 `sharedSessionSettings.keys` 报告；旧 Host 不支持时明确拒绝，不静默丢弃。模型/权限设置与工作模式独立。
独立 `/coding` 的 `runManagedTask({ workMode: 'script', session: { storage }, ... }, prompt)` 要求可写 Session storage；
`persistedByHost:true` 的宿主须实现可选 `appendSessionRecords(id, records)` 原子追加接口，以免旧的全量快照覆盖宿主历史。
返回 false 表示 Session 已不存在；写入失败停止该 Run 的 Script 执行，不能自动重放已发生副作用。
低层 `runKodaX/startKodaX` 不支持 Script，明确提示改用 managed Run；原 SDK 显式 profile、专用角色与工具权限不被产品预设覆盖。
可用性检查 `assertWorkModeAvailable(options)` 仅启动无工具 VM，不产生模型请求；它不证明所选模型的智能或任务效率。

## 2. 旧调用如何迁移

产品 `runs.read` / `runs.await` 新增可选 `failureDetail`，透传 Runtime 的本地
Skill 失败事实。应优先按稳定 `providerErrorCode` 与 `stage` 处理，再展示
`safeMessage`，不要将所有失败统一标为 Provider 错误；`skillName` 是安全标识，
不使用调用方路径作为可信来源。`skill_not_found / skill_not_registered /
skill_registry_unavailable / skill_policy_restore_failed` 均为本地失败，阶段为
`skill_load / skill_policy`。旧结果没有该字段时保留原失败事实，不推断 Provider
已被调用。具体语义及 Space 的独立注册职责见 [错误契约](CLIENT_CONTRACT.md#错误断连与重连)。

客户端退出恢复新增 `ClientExitReceipt.recovery`，由 `readExit` 和离线
`readKodaXClientExits` 每次重新核验。Space 应用 `recovery.state` 的
`ready/pending/blocked` 和 `nextAction`，替换仅按 `cleanup.state` 阻塞启动的
逻辑。原 Host、精确进程/Job 身份和成功 shutdown outcome 已验证时，旧
`cleanup.state=unknown` 可以与 `recovery.state=ready` 同时存在：旧任务结果仍
未知，但允许安全启动/连接。初始 accepted 或旧 Host 缺少 recovery 不代表可
放行，应由新 SDK 离线核验。旧回执保留、重试不改 unknown 为成功、旧退出
不作用于新 Host。状态与动作表见 [客户端退出与恢复](SPACE_SDK_SEAMS.md#客户端退出与恢复)。

普通提问的等待语义已调整：`ask_user_question` / `askUser` 默认无限等待，
允许用户明确跳过，不再有 `required` 作答约束，也不自动采用默认答案。
`userInputTimeoutMs` 默认 `0`（禁用期限）；Host 显式配置正值时才启用期限。
提问的 `expiresAt` 现在可缺失；UI 不应据此补出本地期限。问题超时/跳过时，
SDK 回调返回 `AskUserUnanswered`（`{ unanswered: true, reason: 'timeout' | 'skipped' | 'non_interactive' }`），
调用方应先用 `/agent` 的 `isAskUserUnanswered` 收窄，再处理答案。
Client 用 `{ kind: 'skip' }` 显式跳过问题。普通问题的旧 `cancel` / `userInputs.dismiss`
以及旧输入回调返回 undefined 都视为跳过，正常继续；明确 Run/Session Stop 才中断 Run。
非交互客户端用 `{ kind: 'skip', reason: 'non_interactive' }`，保留无法回答的原因；
`timeout` 仍由 Host 期限产生，客户端不能伪造。MCP 无回答仍转换为协议 `cancel`。
底层 Runtime `userInputs.respond(id, {unanswered:true, reason:'timeout'})` 对仍有效的
请求拒绝为 `invalid_input`，不会把对象塞进答案；不存在或 Run/revision 已不匹配的
请求仍返回 `already_resolved`。REPL 的本地 timeout 不发送 RPC，non_interactive 原样保留。
Space 刷新、断连或关闭订阅只清理本地展示，重连后重读同一请求并按原 ID 回答；
权限审批的拒绝和超时策略不变。完整结算规则见 [Client 契约](CLIENT_CONTRACT.md)。

当前源码增加可选 `ClientSession.lastMessageAt`（摘要同样提供）。会话列表和裸 `-r` 使用最近真实对话时间排序，缺失时回退创建时间；`before` 的创建时间过滤含义不变。UI 可用 `lastMessageAt ?? createdAt` 显示日期，继续透传不透明游标，避免本地再次按创建时间排序。分页是实时边界，不保证跨页冻结快照，新增活动后刷新首页。历史压缩、Actor/设置保存和合成消息不刷新最近对话时间。完整规则见 [Client 契约](CLIENT_CONTRACT.md)。

启动提速由共享 Host 的单次历史恢复和规范 Actor 元数据投影实现，不增加 UI 配置、业务 RPC 或启动进度类型。现有 `onStartupProgress` 继续可用于 CLI、Space 和 Node SDK；被动 connect 与私有 embedded Runtime 不承担全局恢复。

并发自动更新的源码修复（Issue 369）在 SDK 启动器中统一处理初始化/只读预检的瞬时冲突及可重连断开，释放临时连接后按原期限退避，并考虑慢预检耗时。调用方无需增加重试层或更改参数；停机和业务请求不重放，被动 connect 不自动更新。需要重新加载包含该修复的 SDK；仅重建磁盘文件不会更新已加载的旧模块。详见 [回归记录](test-guides/ISSUE_369_v0.7.97_REGRESSION_GUIDE.md)。

下表按调用目的映射，参数和返回值不保证一对一兼容。

| 原有用法 | 统一契约用法 | 必须调整的行为 |
| --- | --- | --- |
| `createKodaXRuntime({mode:'daemon'})` 作为 UI 入口 | `ensureKodaXClient(options)` | 启动/升级交给统一启动器；返回产品 Client |
| `connectKodaXRuntime(...)` | `connectKodaXClient(...)` | 被动连接；`daemonToken` 对应产品选项 `token`，`endpoint` 只接受本地 pipe/socket |
| `runKodaX`、旧 `KodaXClient`、`runtime.runs.start` 提交用户请求 | `sessions.create/read` → `inputs.submit` → `runs.await` | 每个意图有 `inputId`；接收回执不是完成结果 |
| 调用时传 provider/model/effort 等执行选择 | `sessions.updateSettings` 或 versioned CAS | 设置是共享 Session 事实，影响下一次物理请求；不是任意 Run 私有 options |
| 客户端 pending 队列、`submitInput` 的旧 delivery | `inputs.submit/read/withdraw` | 使用 `immediate/after_turn/steer/redirect`；不要直接照搬旧 `interrupt` 字面量 |
| `onTextDelta/onTool*/onComplete`、`runtime.events.subscribe` 拼 UI 状态 | `sessions.observe` | 每次回调是完整当前 view 的替换；不用 delta 拼第二套运行权威 |
| `handle.result`、`onComplete` 或 spinner 停止判定结束 | `runs.await(runId)` / `runs.read(runId)` | 保留 `phase` 和 `error`；`unknown` 不是成功 |
| 仅调用 `runs.abort` 实现整个 Session 的 Stop | `sessions.cancel({sessionId, expectedRunId, requestId})` | 按 Host 的 Session 顺序边界停止；单 Run 停止用 `runs.stop` |
| permission/AskUser 回调或客户端创建权限请求 | `view.interactions` / `interactions.list` → `interactions.respond` | 只回答 Host 已创建的精确 requestId；授权 suggestionId 原样回传 |
| `SessionStorage`、`/session` 文件读写、`uiHistory` 拼接 | `sessions.*`、`readHistory/readHistoryEntry/searchHistory` | 客户端不直接访问活动 Host 的文件；历史与显示引用不混用 |
| 复制屏幕预览或对显示数组不断追加 | `readItem` 补读显示项；`readHistoryEntry` 补读历史/搜索项 | 正文分页校验 ID、偏移、长度与版本；显示窗口不是完整历史 |
| 本地追加 `/model` 等命令提示 | `sessions.appendNotice` | 通知由 Host 保存，属于 client-only 内容；失败要显示，不能重跑原命令 |
| 读写本地 config/MCP JSON；UI 创建 `McpManager` | `config.*`、`mcp.*`、`catalog.*` | Host 负责文件和连接；模型能力 probe 是显式、可能计费的动作 |
| 客户端展开 Skill、执行 command hooks、准备 review | `inputs.submit` 原始 Skill 输入；`commands.execute`、`review.start`、`agents.reviewLean` | 可信准备和执行归 Host；`commands.readPrompt` 仅返回可编辑文本 |
| UI 持有 workflow 模块或独立 memory/learning owner | `workflows.*`、`memory.forProject`、`learning.*` | 提交声明式意图；订阅故障和 Run 终态分开处理 |
| 客户端维护 Agent 注册或 mailbox 状态 | `registrations.*`、`agents.*` | 使用领域 ID、revision 和实际事件，不按 UI 缓存推断完成 |
| `runtime.close()` 或旧 Client dispose | `observation.close()`、`client.disconnect()` | 释放观察/连接；完整退出使用 lifecycle.requestExit，断连后 readKodaXClientExits 核验回执 |

没有产品等价项的底层能力不能自动提升为产品承诺。例如凭据 lease、Host Tool bridge、原始 Runtime events 和特定诊断继续由受信任宿主明确接入 `/runtime`。产品 `mcp` 也不承诺旧 `McpManager` 的所有 start/stop/catalog 方法；先核对实际类型，不在 UI 中创建第二套执行连接来补齐。

## 3. 输入、队列与结果恢复

调用者保存 `sessionId`、`inputId`、原始正文和附件，再提交。输入 ID 应使用稳定生成的唯一值；一次响应丢失不能通过生成新 ID 自动重发。

- `submitted`：已进入会话上下文，不证明 Provider 已接收；用返回的 `runId` 跟随执行。
- `queued`：尚待交付。通过 `inputs.read(sessionId, inputId)` 逐项确认；多条输入可能合批为同一 Run。
- `withdrawn`：已撤回；只有 `withdraw` 的完整返回内容适合重新放回编辑器。
- `dropped`：目标 Run 已结束且未交付；明确再次提交时使用新 ID。

`after_turn` 可在当前 Run 的下一次模型请求前交付，并非必定等整个任务结束。`steer/redirect` 需要 `targetRunId`；steer 的等待不等于可撤回队列。Stop/失败也不表示 Host 自动清空所有待发送输入。

同一个 Host 上丢失提交响应时查询原 `inputId`；已知 `runId` 时查询/等待原 Run。新 Host 不承诺继承旧 Host 的输入接收身份；查不到记录不能证明副作用未发生。命令、review、compact、memory 修改等丢失响应，也不能透明重放。

## 4. 观察、历史与完整正文

`sessions.observe` 先给完整当前 view，后续仍是替换。`view.items` 有界，`view.runs` 也不是全量 Run 日志。显示层保持 Host 顺序，按项 ID 更新；不能用相同正文去重不同输入，不能把 `outputId` 当作唯一块 ID。

| 要读取的内容 | 入口与身份 |
| --- | --- |
| 当前屏幕 | `observe` 返回的 `ClientSessionView` |
| 显示项全文/工具参数 | `readItem(sessionId, viewItem.id, {part, offset})` |
| Host 项的实际图片（PNG/JPEG/WebP/GIF） | `readItem(sessionId, item.id, {part:'attachment', attachmentIndex, attachmentOffset, expectedImageSha256})`；有界字节块，不是文本投影 |
| 较早的规范对话 | `readHistory(sessionId, {cursor})`，首次为最新页 |
| 历史页或搜索结果全文 | `readHistoryEntry(sessionId, historyItemId, {part, offset})` |
| 全 Session 搜索 | `searchHistory`，使用命中 itemId 读取正文 |

页内从旧到新，页间 `nextCursor` 指向更旧页。一次组合读取必须保持同一 revision；修订失效就重新读取，不能拼接不同版本。正文偏移单位为 UTF-16 字符单元；沿 `nextOffset` 读取，`null`、无进展、版本变化和不连续都应报告失败。

当前 view 最多 150 项且有正文预览预算。完整历史和离窗 canonical 项回源不裁剪单消息内部的内容块。冻结浏览应保存项身份、所见长度和版本；不能据此承诺任意并发替换时可恢复过去所有内容。

普通 Ink 浏览的 15 秒等待上限是该 UI 的恢复策略，不是所有 SDK 请求的通用超时。其他消费者需要设计自己的等待/退出体验；不能误以为取消客户端等待就取消了已提交 Run 或 Host RPC。

## 5. 交互与 Stop

交互 UI 展示 Host 请求并提交匹配 kind 的回答。权限扩展只使用该请求给出的 `grantSuggestions`；Plan 审批显示完整 `options.plan`，不用参数预览冒充计划。人工取消问题使用 `{kind:'cancel'}`，不等同于停止 Run。重复、过期或已解决请求的 `accepted:false` 应按结果处理。

```ts
import type { KodaXProductClient, ClientInteraction } from '@kodax-ai/kodax/client';

// Call only after the user chooses to reject this displayed permission request.
export async function rejectPermission(client: KodaXProductClient, request: ClientInteraction) {
  if (request.kind !== 'permission') throw new Error('Expected a permission request');
  return client.interactions.respond(request.requestId, {
    kind: 'permission', decision: { type: 'reject', reason: 'Rejected by the user' },
  });
}
```

Session Stop 的 `expectedRunId` 来自用户点击时观察的 Run，`requestId` 在发出请求前生成并保留。过期 Run 冲突应刷新 UI，不把旧点击自动改投新 Run。Stop 回执的接收状态不代表已结束；继续观察并通过 `runs.await` 确认各 Run 的真实结果。

## 6. 设置、能力与订阅

`getSettings` 是原始 Session 覆盖，`view.settings` 是 Host 解析的有效设置；`config.read` 是已保存默认值，`config.readEffective` 是有效执行配置。patch 的缺省字段保持不变，支持的 `null` 清除覆盖。并发编辑使用 `getSettingsVersioned/updateSettingsVersioned` 的 revision；临时覆盖结束后不能无条件恢复旧值覆盖其他客户端的新设置。

`ensureKodaXClient` 可启动/正常更新本地空闲 Host；`connectKodaXClient` 不启动或替换它。两者要求 `productClient` v1，具体新增领域能力仍可能要求额外握手支持（如 `subscriptionLifecycle`、`workflowSettingsDefaults`、`planModeEffort` 设置键）。缺失时明确报错，不能静默降级。

### 启动进度与 UI 交接

两个产品入口都接受可选 `onStartupProgress(progress)`，`ClientStartupProgress` 可从 `/client` 或纯契约入口作类型导入。底层 `ensureKodaXRuntime/connectKodaXRuntime` 使用同一类型和回调。ensure 报告实际 `checking/starting/upgrading/waiting/connecting/ready` 阶段；被动 connect 只报告 `connecting/ready`。`waiting.reason` 为 `connected_clients/host_starting/host_stopping`，沿用现有等待与期限，不强停其他客户端。

新 Host 还会通过同一回调报告 `stage: 'initializing'`，`phase` 为
modules/extensions/runtime/recovery/mcp/sessions/a2a/listener。显示层应增加这一分支；
原样接收纯数据即可，不需要另建探测。阶段可能合并或重复，不表示百分比或 Ready。
SDK 复用既有启动轮询和 bootstrap 日志尾部，无回调时不启用该通道；
`createKodaXRuntime` 也可用同一回调观察其本机初始化步骤。

启动 `ready` 只表示认证、身份及能力校验完成，Client 接口可用；不表示 Session 已加载、订阅已同步或 UI 已渲染。以返回 Promise 的结果处理成功/失败，在 `finally` 清除启动显示。阶段可以重复，连续相同通知会合并。回调在本机调用、不被等待；抛错或异步拒绝走现有诊断，不改变启动结果。已有无回调调用无需改动。

REPL 的显示交接使用可选 `onBeforeRender`，在恢复提示及初始 banner/TUI 输出前清除终端加载显示；原先未发布的启动显示钩子 `onReady` 已直接更名，不保留别名。其他 UI 在自己的渲染边界完成交接。该能力不新增 Host RPC、持久事件或能力版本；完整语义见 [Client 契约](CLIENT_CONTRACT.md#连接启动与所有权)，可编译示例见[英文指南](../public_docs/sdk/embedder-guide.md#show-local-startup-progress)。

### 订阅就绪与连接状态

Session 观察通过 `onStatus` 区分 live/interrupted/closed；重连中的提示由应用自身管理，不存在公共 `reconnecting` 状态。Workflow/Learning 订阅的 `ready` 仅代表注册成功；重新订阅后等待 ready，再读取快照，读取期间通知作为再次刷新信号。断连恢复不重放业务 mutation，Run 的 `unknown` 结算也不等于网络断连。

## 7. 已移除与仍保留的能力

本分支移除了通用 operation envelope/receipt、持久事件 journal/replay、旧 exit-settlement/rollback 协议和 Worker-hosted embedded Runtime。它们的迁移明细见[移除表](../public_docs/sdk/embedder-guide.md#migrating-to-v0797)。不能继续依赖旧 event cursor 跨重启续传，或把断连自动重发解释成恰好一次。

独立 coding/Agent/LLM 库、显式 inline embedded Runtime、daemon、构造工具 handler worker、语义分析 worker 等并未因此全部退役。历史 ADR/feature 文档描述的是当时决策；当前产品行为以本迁移指南、Client 契约和实现为准。版本号相同也可能加载了不同源码/构建，升级后需要重新加载 SDK 进程；启动器不会强停忙碌 Host。

## 8. 接入验收

迁移完成至少验证以下行为，而不只验证 TypeScript 能编译：

1. 两个 Client 看到同一 Session 设置、交互与执行事实；断开一个 Client 不停止另一方的工作。
2. 提交后保留输入身份；排队、撤回、steer/redirect、Stop 和迟到回答使用各自回执，不丢失或重复输入。
3. 对 completed/failed/interrupted/unknown 和传输拒绝分别显示；重新连接不重复启动任务。
4. 多轮、多工具、长正文和同文不同输入跨显示窗口后仍能准确读取；分页修订变化有可见恢复路径。
5. 命令通知经 Host 后仍可见且不进入模型上下文；失败只报告，不重跑有副作用命令。
6. Learning/Workflow 订阅注册失败、运行中故障、主动关闭和重连，均不会假报 Run 完成。
7. 产品消费者不持有 SessionStorage、可执行 Runtime 对象或客户端 MCP owner；底层宿主代码单独标明职责。
8. 如展示启动进度，失败时也清除显示；不把启动 `ready` 当作 UI/Session/订阅就绪，不因进度回调故障重试启动或提交业务。

仓库现有验证入口：`src/sdk-client*.test.ts`、`src/session-view*.test.ts`、`tests/repl-pty-acceptance.mjs`、`tests/repl-history-browse-acceptance.mjs`。具体回归记录见[Issues 345–347 and 352 验证指南](test-guides/ISSUE_352_v0.7.96_REGRESSION_GUIDE.md)。这些测试不证明所有外部应用已经迁移。

## Result verification retirement (2026-10-11)

The automatic Sidecar Verifier is retired. Remove `verifierLog`, `/verifier-log`, `KODAX_VERIFIER_*`, `onSidecarMessage`, `sidecar.message`, and protocol-emitter integrations. New config patches reject the retired key; old saved defaults are ignored. Persisted legacy UI items, synthetic messages, and managed-task fields remain readable without replay. Main-agent evidence and ordinary Actor results carry review findings; Run completion and Goal completion are lifecycle facts. `agentProfile.verification` and `context.taskVerification` reach both SA and AMA. Host Goal tools use the canonical journal’s atomic mutation seam. Stall detection and Auto permission review retain their own models and controls. Rebuild Host and clients from matching code before using the changed types.

## Artifact SDK 契约迁移（2026-10-13）

`v0.7.97-alpha.5` 源码包含 Artifact SDK 的统一扩展（开发于 `27d08788`）。2026-10-18 用户确认改为主包单一 npm 分发，经 `/artifacts`、`/artifacts/client`、`/artifacts/runtime`、`/artifacts/kodax` 暴露；已发布的 alpha.7 不包含这些新出口，应安装当前本地主包 tarball 或未来包含变更的新版本，不再安装独立 artifacts 包。公开方法仍为 `capabilities/prepare/create/open/edit/export/render/capture/readEvidence`。独立 Node 宿主使用 `/artifacts/runtime` 的 `createNodeArtifactPort`；共享 CLI/Space 使用 `/artifacts/client` 的 `createKodaXArtifactPort(client, sessionId)`，沿现有 Run 和附件通道执行，不新增 Session owner。

初版 `ArtifactRef.kind: 'presentation'` 改为内容 `format: 'pptx'`；证据批次的裸 `sourceHash` 改为 `source: VisualSource`，文件引用内的 `sourceHash` 仍是实际字节 SHA256。capabilities 改为结构化记录；PNG 必须有哈希和尺寸；分页证据必须有 `layout`。DOCX 的实际页数在渲染后的 `layout.totalPages`，不在 `open` 返回值。`capture` 改用与 `kind` 匹配的 `locators`。这些是发布前直接调整，不保留旧字段别名。

调用 `readEvidence` 获取经新鲜度、来源和 PNG 校验的实际图片；共享 Host UI 不自行读返回路径。附件 `image.offset/totalLength/nextOffset` 和 `attachmentOffset` 按字节计数，与正文 UTF-16 偏移分开。客户端校验每块身份、哈希、尺寸和连续偏移，拼接后再次校验完整图片；旧 Host 缺能力时明确失败。

自动视觉审查由共享 Agent 指引及可用工具触发，不要求 slash；SDK 本身不另发起模型判官请求。文件渲染可无界面运行，仍需可用 renderer 和支持图片输入的 Provider。`ready`/覆盖检查不表示质量通过。完整支持矩阵、DOCX 保真限制、示例和取消语义见 [Artifact SDK](ARTIFACT_SDK.md)；自然任务 E2E 的未完成闭环及工具 schema 缺口见[实测记录](test-guides/FEATURE_301_v0.7.97_TEST_GUIDE.md#natural-task-observations-2026-10-13)。


## LLM provider parity：能力与费用契约（FEATURE_302 T11）

原有 provider 名称、config.json 和 API_KEY 环境变量继续有效，默认仍为现有 HTTP/SSE；不需要将 API key 搬进配置文件。原生/订阅连接通过既有 broker 按请求授权。新增能力及边界见 [LLM 接入契约](LLM_INTEGRATION.md)。

`TokenUsageRecord.cost`、provider/session 的总费用现在为 `number | null`。未知价格或未覆盖的 cache-write TTL 返回 `null`，不能再当作零价；`knownCostSubtotal`、`unknownCostCalls`、`nominalCostCalls`、`costBasis` 区分已知小计与订阅名义估算。已有数值费率和显式零价保持原义，静态费率不是实时账单。`cachedWriteTokensByTtl` 保留缓存写入分区，`cacheWritePer1MByTtl` 可为已声明 TTL 提供估算费率。

工具 strict/grammar 只按显式能力启用；`require` 不可静默降级，`prefer` 仅在明确的 400/422 约束拒绝后有一次受限回退。`strict` 会关闭对象额外属性，将可选属性变为可空的必填属性，属于显式 opt-in。Responses grammar 的原始输入由声明的单个字符串属性承接，部分流片段不构成可执行工具。

原生 provider 的 reasoning 学习记录增加身份 scope；旧的无 scope 记录不用于限制新原生请求或 REPL 可选 effort。账号/密钥/连接变化会隔离学习及 opaque history，仍保留可读历史。CLI bridge 的旧行为保持。请求投影诊断区分 estimated 和 native protocol-input；后者为签名前实际请求对象的哈希，不代表服务端 cache hit 或实际计费。

Reasoning 链路修正（2026-10-31）：Host `settings.effort` 是用户的会话选择，
内置 AMA Worker、SA 和 Script 根执行继承此选择，不再套用旧的
`balanced/deep` 角色默认或上限。旧实现把 `high` 压成 `medium` 属于缺口，
不能因某些 provider 最后又映射回 `high` 而视为正常。只有明确声明的 specialist
保留其显式 effort 策略；子任务的显式 `auto` 也不再被丢弃为继承父级。
Agent/构造产物的旧 profile 在接入边界转换为 `medium/high` 等原生 effort，
不改写调用者对象或存量文件；旧 reasoningMode/thinking SDK 输入仍兼容。
`onReasoningResolved` 继续保留完整诊断；Client `activity.reasoning` 新增只读的
主请求结果（provider/model、请求 ID、requested/sent effort、fallbacks、verified）。
新请求开始时清空，child/旧请求不能覆盖；旧 Host 缺失时不得推断实际档位。
AMA 扩展的 session hydration、runtime.setThinkingLevel 与 provider:before 现在
通过既有 Run 隔离机制和同一运行选择生效；工具/Actor/workflow 继承当前选择，
保留旧 thinking 输入及共享 Actor 预算，不把临时扩展覆盖写成全局默认。
`verified:false` 不表示失败，也不证明服务端实际采用该强度。CLI 只为本次新发生的
`unsupported-effort` / `unsupported-parameter` 回退追加结果提示；profile 映射和
`cached-rejection` 不逐轮追加提示。Space 接手时应保持同样的区分，不应将单次
Worker/子任务结果写回共享会话选择或全局配置；后续请求通过身份隔离的能力学习自愈。
状态栏仍表达会话选择；Space 可用 `activity.reasoning` 展示本次发送结果，
不把自愈后的 wire 参数回写到会话选择或全局默认。身份隔离的能力学习负责后续请求。
回归入口见 [effort 链路指南](test-guides/FEATURE_233_v0.7.97_TEST_GUIDE.md)。


## T12-A Main 授权与 OAuth registration

根 `/runtime` 新增 createProviderCredentialAuthorizer、createNativeCloudCredentialResolver、loginProviderOAuth 和显式 encrypted/Windows OAuth store。原有 bindOAuthCredentials/bindCloudCredentials、API_KEY/env 及 CLI bridge 入口仍有效。Main 工厂使用 services.identity.runtimeId 识别 Host 换代；产品输入不携带 callback/store/秘密。工厂由宿主拥有，断开时调用 close，清理失败可观察。

KodaXClientExecutionRequest 新增无持久 Session 的 provider_probe；旧 authorizer 不应在收窄 kind 前访问 input.sessionId。该请求对应 providerProbeAuthorization:1，Root Client/CLI 使用授权时要求兼容 Host。RuntimeScopedCredentialTarget.operation 增加 provider.reasoning.probe；旧的 session.compact/run/actor/workflow 保持。

OAuthSessionRecord.identityKind 可为 account 或 grant，旧记录缺省按原 account 语义处理。grant 的 accountId 是隔离的授权主体，不假称已验证用户；注册信息不可被轮换或另一个账号替换。普通 custom connection 可保存非秘密 oauthRegistration 引用，实际令牌留在 Main 的 store。用户新要求的 auth.json 普通 Key 存取、隐藏输入与 Space 迁移仍见 FEATURE_302 T12-B–G；不要把本切片的端口/加密测试当作那些体验已完成。


### FEATURE_302 T12-C：保存 Key 与条件更新

现有配置入口和 API_KEY 环境变量继续有效。setup / /setup 可隐藏输入并保存到 config.json 同目录的权限保护明文 auth.json；`kodax auth set-key|status|remove-key <provider>` 管理保存值。普通配置不含 Key。

可信 Main 可从 `/runtime` 使用 createProviderCredentialManager；先 describe，再把完整非秘密状态传给 setApiKey/removeApiKey。profile 与 configPath 必须和实际 Host 一致。不要丢掉 configured:false 状态里的删除 revision，不能用 null 代替已经发生过的删除；UI 不读回 Key。写入文档 v2 接受 v1 读取并在修改时升级，保留删除修订以保护并发回滚。

CLI Host 要求 providerCredentialConnectionBinding:1，保存值按实际 adapter API/地址/认证模式匹配，旧 Host 应升级后重启。SDK 中原始 API-key/云/OAuth lease 入口保留。保存不是在线验证；OAuth 默认文件与 Space 实迁移已在 T12-D/E/F 完成，见本指南末节。


### FEATURE_302 T12-D：OAuth 共用文件

默认 providerOAuthStore(configPath) 改为 auth.json；新登录无 OS vault 强依赖。旧 linked registration 可用 migrateProviderOAuthRegistration 导入，保留原 client/service/account/issuer/identityKind/profile，清旧 token 前先 durable commit。已存在的共享记录（含注销状态）优先，不从旧副本复活。明确 Windows/encrypted SDK 后端保留。

可信 Main 可为 loginProviderOAuth 提供实际 profile；缺省旧 registration 视为 default。authorizer 要求 services.identity 带实际 runtimeId；自己包装 services 的客户端需转发它。Host profile 不再参与授权（Issue 406），被重定向到其他 profile Host 的客户端照常注册 lease。Radius source 的 issuer 必须与已登录 registration 相符。File store initialize() 在授权 shell 前建立 mask targets，默认 CLI 已调用；自建宿主使用该后端时也应在启用工具前调用。

此阶段修复了独立 Host 漏转发 providerProbeAuthorization 的问题，现按真实 owner 能力声明，避免 SDK 要求与 daemon 握手不一致。该修复不放宽旧 Host 的能力门槛。


### FEATURE_302 T12-E/F/G：历史离线验收（未发布，2026-10-31）

T01–T12 本地实现、离线完整回归和双轴评审完成，原 config.json、provider/model 别名及
API_KEY 环境变量继续有效。默认保存值优先于批准 env，再走该连接声明的认证；
删除保存值后显示 env 来源。活动 broker 拒绝/撤销和损坏文件不回退到 ambient 凭证。
文件采用权限保护明文 auth.json，不要求 keychain，普通配置不保存 Key。

Space 已在独立提交 `065cc39c` 接入真实 provider IPC/持久化/broker 与稳定客户端秘密迁移。
UI 更新必须携带显示时的状态，改名/删除不能重新读取新 revision 来绕过并发检查；
同根共用 auth.json，不同根隔离。原 active/exitRecovery 身份值不变。
以下来源选择以 T12-H 补充为准，旧值与 CLI 不同不能自动选择其中一方。
OAuth 注销与 API-key 删除保持不同入口；高级原生连接沿 SDK/CLI/config 配置。

可信测试/底层宿主若显式创建隔离 daemon，close 只断连接；删除临时 home 前须核验
实际 owner runtimeId，经 daemon.shutdown 并用 waitForRuntimeDaemonShutdown 验证退出。
生产 Space 断开后维持共享 Host 的既有生命周期；不把测试回收策略搬入正常产品退出。

这不是 npm 发布声明。Root/Space 包版本及 Registry 锁未改；Space 发布前须发布并锁定
包含本次契约的 SDK 字节，再运行原 exact-byte/安装包门禁。当前 dev-link 仅用于联调，
不得绕过门禁或作为正式安装包。独立分支的完整测试不覆盖原工作区另一线程未合并改动；
合并后重跑受影响的 Host/凭证/恢复/发布验证。精确测试与未验证范围见
[FEATURE_302 最终验收](test-guides/FEATURE_302_v0.7.99_TEST_GUIDE.md#t12-efg-final-offline-acceptance-2026-10-31)。

### FEATURE_302 T12-H：账号保持与可重试升级（未发布）

本轮 Root 代码与测试固定点：本地 `KodaX` 提交
`a31f86206e413e89b5a97acad3b7090473cf474e`（基于 `68a02521c`）。
设计子仓 gitlink 保持 `8574086208d6b5cc6ff6599c825fe88d986c4dd0`；本批未修改
Space 仓库。Space 接手应采用包含此 Root 提交的 SDK/完整资源，继续保留自身独立
分支的凭证迁移与 Main broker 代码；不把本地验收视作推送、发布或真实账户认证。

2026-11-01 的 Root 审计补充仍未发布：既有 SDK/配置/API_KEY 入口和 auth.json v2
保持有效。CLI 按需打开所选 OAuth，失败可重试；缺失、撤销或 profile/issuer 不匹配
均报错，不能用环境 Key 或其他注册账号兜底。原始损坏配置、凭证及队列文件保留。
已有核心配置损坏、非对象或读取被拒绝时，CLI 与 SDK 均显式拒绝按空配置执行或
打补丁，防止采用默认 provider/环境账号；真正缺失的新用户配置仍允许正常启动。
有效旧配置与正常文件链接继续有效，悬空文件链接保留并报错。存活 Host 的
`config.readEffective()` 仍可报告 `persistedConfig.state: invalid`，修复后重新读取
原 provider；冷启动失败也可在修复后重试，不生成替代身份。
Space 接手时应保留统计的 `coverage: partial`/issues；单个损坏 pending-input 文件仅
使所属 Session 提交返回现有 `conflict`，不能自动清空或重新绑定其 principal。
任务事件不可读则任务呈 `unknown` 并拒绝再次派发，健康任务不受影响。修复原文件后
重连/重启 Host 恢复原队列与身份，不把未知执行当成重试许可。Windows 原生静态资源
也必须随 SDK/二进制一起分发，缺失或篡改会显式失败。验收及真实 OS 前置条件见
[Issue 376](test-guides/ISSUE_376_v0.7.97_REGRESSION_GUIDE.md)。本批没有修改 Space 仓库。

后续审计修复补齐 AMA Root learned Skill 的 catalog/准入/outcome/release；失败和取消
不能计作已验证成功，释放必须属于 Host 可等待的 Memory 工作，并先于完成通知。
显式 `runs.startTool` 加载 Skill 时也装配现有策略和 hooks；这仍是当前 Run 的一次
调用，不给后续 Run 持久授予工具权限。Space 无需恢复旧 SA CLI 或重复 effort 提示。
模型描述新增可选 `multimodalSupport`；切换模型时按选中模型判断图片，保留原始历史。
费用沿用可空/nominal 合同，新增 `maxPricedInputTokens` 限定已覆盖费率的输入范围；
未知价格、TTL 或超范围不能显示为零。目录/费率来源和限制见
[模型与费用边界](LLM_INTEGRATION.md#审计后续模型与费用估算边界2026-11-01未发布)。

Space 若提供存储维护，可显式调用 `/coding.inspectToolOutputStorage(directory)`；
`partial`、`failed` 或子目录存在时，不能把平面容量统计当完整全局清单。
清理须先停止共享该目录的所有写入，并掌握所有 SDK/Host 会话与 manifest/stream 的
完整引用闭包，再调用既有 `cleanupUnreferencedToolOutputs`。仅有当前 Space 会话目录
不构成完整范围；未知引用域继续保留，不能恢复启动扫盘或按 TTL 自动删除。

坏配置不再阻止 CLI `--help`、`--version` 和只读 `doctor`；执行与配置写入仍拒绝使用
坏配置作默认账号。`doctor --json` 新增 `coreConfig` 语法状态/位置与 `locks` 清单，
不返回原文或凭证。它只覆盖默认配置根下的已知位置，显式 SDK storage 覆盖需另查。
Space 可展示这些诊断，但不能凭锁年龄或 PID 不可读自动删除历史锁。
后续诊断补齐默认 `sessions/.write-locks`；锁记录的 empty/invalid-json/missing、
json-object 和 reclamation-claim 可区分，但 `ownership: unverified` 一律不是死亡证明。
子 Agent 的终态配额/认证错误不再误触发 Provider fallback；真实 408、限流及暂时
Responses 服务故障仍可沿已配置的链切换。401 强制刷新与稳定账号 replay 身份尚未
贯通，Space 不能自行把当前 POST 重放或删除 token 身份隔离来掩盖错误。离线修复应先
停止所有共享 CLI/Host/SDK 写入者、备份原目录，再隔离明确诊断出的锁及对应 reclaim
claim；保留 config/auth/session/journal。活跃任务或未确认所有者不能做此处理。

更新 SDK 时须同步完整 dist 和既有 JSON 资源，不能只替换 JS 并复用旧资源。
`windows-native-scripts.json` 的历史文件名保留，现也包含带哈希校验的共享 ASRT
broker 模板；按需装配并缓存，程序内容和参数语义保持。旧 Host 的既有 Windows
provision/control 数据未改，运行中的任务不为本次资源整理而强制退出。

CLI 的 config.json、API_KEY 和单记录凭证 SDK 入口继续有效，auth.json 仍为 v2。
新增 AtomicFileProviderCredentialStore 扩展提供一致快照与多记录 CAS，不改变旧调用方契约。
Space 的旧 Key 自动迁到应用私有作用域，旧加密副本保留；CLI 已有不同 Key 时双方继续各用
原账号。首次选择 legacy/env/shared 来源须成功持久化，env 只固定来源、不复制变量值。
之后 env 消失、删除、旧后端暂时不可用、API/地址变化，都不能静默采用另一账号。
显式保存沿当前作用域更新，只有发布/采用共享凭证操作才改变共享关系。

迁移失败可在修复底层存储后重试；只有已持久固定的旧来源可在复制失败时继续原账号。
迟到迁移不使用用户新选择的 revision 重新授权，删除墓碑与显式换号保持权威。
默认 OAuth 迁移保留旧 sealed 备份，新文件中的当前 grant/撤销记录始终优先；不要并行运行
旧/新 rotating-grant refresher 或用备份覆盖撤销。客户端 active/exitRecovery 原值保持，
初始化失败不缓存成永久失败，也不生成替代身份。持久 legacy 启动值接入现有 SDK Host
升级/恢复，保留 busy/owner 边界；已退役的第三方私有 embedded factory 仍需迁移。

Space 接手契约及交接索引位于其独立仓库的 docs/SDK_PROVIDER_CREDENTIALS.md 和
docs/handoff/PROVIDER_UPGRADE.md。H 验收结果单独记录，不以 A–G 的历史计数代替。
H 对应 Space 独立提交 `437cac7d`；Root完整18,659、发布包70、Space完整4,531和实际
Electron两项通过，两轴复审无剩余发现。详细证据见测试指南H节；原线程后续提交整合后须重验。

### FEATURE_302 T12-I：整合最新 Host 契约（未发布）

独立分支整合本机主开发分支 `KodaX` 的 `0fa38e5b2`；原工作区和主分支未改动。
保持 H 的账号来源/墓碑/撤销边界，并保留执行 profile、真实工具目录、恢复上限、
Session view close drain 和 Windows 进程回收。合并后的验收另记测试指南 I 节，
旧 H 计数不作为合并树的通过证明。

`KodaXClientHostAuthorization` 服务含完整 identity 和 `createExecutionProfile`。
自行包装该公开回调须提供真实能力；不要把裸 Runtime 强转成完整服务。只在应用内部使用
凭证服务的私有 helper 可以声明更窄的依赖，公开请求/返回仍沿现有契约。Space 本次适配
属于后一种类型修正，JavaScript 不变；它不替代另一线程的 persona/Partner/profile 迁移。
执行 profile 应由可信 Main 根据该 Session 的实际 Host 目录生成，不能用本地工具名单冒充。

I 阶段时尚未合入/推送主分支。正式合入前复核主分支新提交，携带 `docs/features` 独立仓库
提交；Space 发包前发布并锁定配套 SDK 字节，再执行原生产门禁。

### FEATURE_302 T12-J：Root 本地主分支合入（未发布）

用户授权后，Root 的本地 `KodaX` 主分支已包含接入层改动及另一线程最新的
`a9587af7e` MCP/Skill 修复，配套设计子仓也已同步。保留原配置/API_KEY、账号来源、
凭证 proof/epoch、OAuth 撤销和 Host 恢复边界；MCP 原文恢复和按实际 Host 配置根查找
Skill 与 reasoning/cache/history 路径共同保留。未推送或发布。

源码工作区需按更新后的锁文件安装依赖，不能沿用缺少原生云 SDK 的旧 node_modules。
合并后的主仓库验收及实际检查点见 FEATURE_302 测试指南 J 节。Space 保留独立
`codex/provider-credentials-space` 分支；本次 Root 合入不代表重新认证 Space 构建或
完成其 persona/Partner/profile 产品迁移。Space 发布仍须先锁定匹配的已发布 SDK 字节。

### 2026-10-31 恢复与凭证覆盖补齐（未发布）

Root 在 `a65249d8` 审计后补上真实文件、独立 Main/Host 进程的凭证迁移中断、
刷新期间换号、撤销后冷恢复，以及公开执行入口的崩溃快照/历史修复组合回归；
默认 Judge 的兼容声明改为禁用，与已退役的运行时一致，不新增模型调用。
组合测试还发现并修复了 Host 快照用本轮输入覆盖旧会话标题的问题，沿用已有读取结果保留标题。
managed Run 连续失败计数改为继承并递增，错误快照完成保存后再返回；历史加载失败时不写空快照。
旧配置与 API_KEY 入口继续有效；原 sealed 凭证保留，当前选择和撤销墓碑优先，
恢复不重放旧工具或未提交的用户消息。具体验收及仍待实机证据见
[Issue 371 回归指南](test-guides/ISSUE_371_v0.7.97_REGRESSION_GUIDE.md)。
Space 仍在 `codex/provider-credentials-space` 独立分支接手，配套设计子仓仍为
`8574086208d6b5cc6ff6599c825fe88d986c4dd0`；本轮没有修改 Space 产品代码。
发布前需锁定包含本轮修复的已发布 SDK，重跑生产安装包升级、账号保持、撤销、
Host 重启和退出恢复门禁。Root 的离线组合回归不能代替真实服务登录或 Space 成品验收。

恢复阶段交接（后续 effort 修正见下）：Root 本地 `KodaX` 主分支已安全包含功能提交
`27bb8536edf8ba149860e6d4c4562ecb0f8526fb`，设计子仓仍为
`8574086208d6b5cc6ff6599c825fe88d986c4dd0`；Space 保留
`codex/provider-credentials-space@7b37e1c8ddf0d72d8674d521f1e8e0298d3341a2`，
本轮没有改动 Space 产品代码。Root 全源码按整文件复验汇总为 18,813 通过、
73 条件跳过、0 TODO；实际主仓重建后 300 项定向源码、86 项发布包和 4 项真实旧版本
安装/Host 升级验收均通过，双轴评审无剩余发现。接手时先发布并锁定包含该功能提交的
SDK 字节，再做 Space 生产安装包升级、旧配置/API_KEY 与凭证迁移、账号保持、撤销不回退、
真实 Codex/OpenAI/Copilot 刷新换号及 Host/退出恢复；persona/Partner/profile 在途改动
整合后仍需复验。旧 sealed 只作保留的恢复材料，不覆盖当前授权或撤销记录；旧新版本
不得并行刷新同一 rotating grant，未知所有者旧锁不按时间强行清理。尚未推送或发布。

### 2026-10-31 effort 链路修正：最新 Space 交接（未发布）

Root 本地 `KodaX` 主分支已安全包含功能提交
`9e3147da47536b1ed3fb8817c0e351b8923776c3`，以及测试夹具修正
`19aa6a3c3cfb0ff82974d7a931d33ee71403373d`；设计子仓仍为
`8574086208d6b5cc6ff6599c825fe88d986c4dd0`，Space 仍保留
`codex/provider-credentials-space@7b37e1c8ddf0d72d8674d521f1e8e0298d3341a2`。
本轮没有改动 Space 产品代码、凭证、账号选择或原配置/API_KEY 入口。
内置 AMA/SA/Script 根请求现在继承 Session effort，工具、Actor、workflow 和子代理
继承当前运行选择；旧 balanced/deep profile 仅在兼容边界转为 medium/high，
新脚手架和辅助评测脚本使用原生 effort，modelHint 的同名路由档位继续保留。
Space 应继续把 settings.effort 当作用户选择，按需消费新增可选只读
activity.reasoning（主请求的 requested/sent、归属与 verified:false）；缺字段保持未知，
不得用子任务、旧请求或兼容回退改写共享选择及全局默认。正常映射和已学回退不重复提示，
新拒绝仍可见；账号隔离的能力学习和撤销/恢复边界保持。源码按完整文件复验汇总
18,884 通过、73 条件跳过、0 TODO；实际主仓构建/类型、192 项定向源码通过，
发布包按完整文件复验为 87 通过，双轴复审无剩余发现，详细范围和初次失败见
[effort 回归指南](test-guides/FEATURE_233_v0.7.97_TEST_GUIDE.md)。接手时先发布并锁定
包含功能提交的 SDK 字节，再做 Space 生产安装包升级、真实服务 OAuth/换号/撤销和
Host/退出恢复门禁，并整合另一线程的 persona/Partner/profile 改动后复验。
Root 离线结果不代替 Space 成品验收。新版 CLI/SDK 启动连接时，可对同一安装中可验证、
安全空闲的旧 Host 按构建指纹自动换代；普通交互 Host 在最后一个客户端离开、全部工作
空闲 30 秒后自动退出。活动工作、其他连接、显式常驻/A2A、跨安装或缺失构建身份等情况
按既有边界保留或拒绝替换，不要求用户一律手动 daemon stop。
尚未推送或发布。

2026-11-01 终端反馈补充：Root 本地 KodaX 已包含功能提交
`306eafdfa8ec3242abeead9e1fdf56ee3763b45e`。Ctrl+T effort 快捷键改为保存期间 spinner、确认成功后
约两秒的短暂浮层；成功不再写入会话通知，失败/部分成功及显式 `/effort` 回执保持。
连续按键按序应用，退出开始即取消排队动作和迟到反馈；保存协议、Session 选择、凭证和
SDK view 契约未变。这不代表 Space 已实现同样的产品交互，仍由负责线程独立接手。

2026-11-01 CLI 帮助修正：根帮助选项在子命令分发前统一处理，`daemon` 六个子命令
的 `--help` / `-h` 只输出帮助，不能触发启动、停止、重启或前台服务。嵌套命令及别名
沿同一边界保护，普通管理调用与原参数保持不变；SDK/凭证/Host 生命周期契约未变。
本轮 Git 推送范围为 Root 的 `origin/KodaX`，以及其引用的设计提交
`8574086208d6b5cc6ff6599c825fe88d986c4dd0` 在设计仓 `origin/main` 中的可达性；
Space 独立分支不推送，不创建版本标签、不发布包。最终主仓与远端验收见
[daemon 帮助回归记录](test-guides/FEATURE_233_v0.7.97_TEST_GUIDE.md#daemon-help-dispatch-repair--2026-11-01)。

远端验收：功能提交 `8a8bd445e6f62f899fb850b757ce78879abcde65` 已合入本地 KodaX 并
推送至 Root `origin/KodaX`；设计仓 `origin/main` 已先推送上述 `8574086` 依赖，随后
分别核对远端 SHA。实际主仓重建、类型检查、109 项定向源码、8 项发布包验收通过；
独立工作区完整发布包为 89 项通过。Space 保持独立，未推送、未改 SDK pin，未发布包或标签。

## Issue 376：恢复、凭证与原生历史补齐（2026-11-01，未发布）

本轮直接在 Root 本地 `KodaX` 主分支实施，基线 `3cd3e5af`；没有修改设计子仓
`8574086` 或 Space 独立提交 `da531f0a`。本轮未推送、发布或改变 SDK pin，验收见
[Issue 376 指南](test-guides/ISSUE_376_v0.7.97_REGRESSION_GUIDE.md)。

旧配置文件、已保存 API key、支持的环境 key 与原有 broker/绑定入口继续可用；账号、
路由和墓碑优先级不变。OAuth 新 broker 协商请求凭证封装以获得稳定账号 replay 身份和
401 按代次刷新，旧 string 回调仍工作。消费方必须通过 SDK 凭证 scope，不能把封装字符串
直接填入 HTTP 头、保存到配置或传入 Renderer。刷新成功也不重放刚失败的 POST，不把另一
账号或 API key 当作修复。云回调可额外返回经过可信 principal 验证的 `replayIdentity`；
没有该证明的默认云 SDK 继续保守隔离，不能伪造稳定身份来争取缓存。

新的 Main `/runtime` 维护入口为 `inspectStorageRepair`、`inspectStorageRepairCandidate`、
`applyStorageRepair`、`confirmStorageRepair`。本地 CLI 对应 `doctor --inspect-storage <target.json>`、
`--repair-storage <plan.json> [--repair-candidate <candidate>] --writers-stopped`、
`--verify-storage <receipt.json> --writers-stopped --verified-current-state`。单次只选一种动作；
这些入口属于可信本机管理员，未进入 Product Client、Renderer 或模型工具目录。
inspection 只读；apply 核对原件身份/hash、实际 writer 锁和候选完整性，保留备份并设置
repair fence。当前单个源文件/候选的维护检查上限为 64 MiB，超限会明确拒绝，不截断数据。
合法 JSON 不证明外部副作用已核对，只有独立人工/可信运维核对当前状态后
才能 confirm 清 fence。`--writers-stopped` 是操作者对旧非协作 writer 的前置声明，不能
证明其他安装已离线。未知锁不按年龄删除；不兼容的锁协议仍拒绝通用修复。

事件账本只对语法损坏的末行提供明确前缀候选；Extension/A2A/任务 snapshot 使用完整候选，
不把空集合当成默认修复。修复失败和中断保留原件、回执和 fence；未知任务不自动派发远端
效果。原始凭证/config 损坏仍不自动清空或重置账号。服务端已消费 refresh token、客户端
却尚未持久化便崩溃时，本地无法保证恢复；封存备份不能当作可自动回滚的有效 refresh token。
需要旧 alpha.11 不认识的新协议时，不支持降级到旧 reader/writer 共用新存储。

统计 v2 按真实 Session 存储根分隔，以独立追加 lane 收集事实，旧默认 v1 只读导入，未采集
的历史仍为 partial。统计不是执行权威。分页 cursor 绑定当前投影代次；Host 重启、重建、
LRU 淘汰或旧格式 cursor 返回 `conflict` 时，从第一页重取并按 ID/revision upsert。
这避免并发 lane 在冷热恢复排序不同后继续旧 offset 而漏项。

自定义存储/Space 必须原样保留 assistant 的可选 `nativeHistory`，不要用显示文本重建完整
记录；过滤改变内容时丢弃不匹配的片段。Claude 5.5 的原生范围与真实账号验证限制见
[接入契约](LLM_INTEGRATION.md)。全局工具输出自动清理是另一个存储能力：需要关闭
Root/Space/分支/附件的引用与所有权链路。本轮没有加入 TTL 删除，旧工具原件保留；
现有显式诊断不等于自动 GC 已完成。


## Space SDK repair migration, 2026-11-08 (shipped in v0.7.97-beta.4)

These source fixes after beta.3 ship with the `v0.7.97-beta.4` tag; npm
publication is a separate maintainer step, and a tag is not a claim that a
running Host has already been upgraded. Pin and validate the actual SDK package
and Host bytes.

- `loadAgentsFiles` again returns only AGENTS.md files for legacy editors/count
  limits. Prompt consumers use the new `loadInstructionFiles` API, whose ordered
  sources have `kind:'agents'|'rule'`. Keep `scope` for precedence, not file kind.
  Existing rule order, whole-file budgets and prompt formatting are retained.
  `onDiagnostic` reports skipped fragments with typed `RuleDiagnostic.code`,
  source path and human-readable reason. It is available through the public
  coding export. Previously overwritten AGENTS content needs backup/version
  recovery; upgrading cannot reconstruct it.
- Resolve history actions and pass the ready result as `{turn}`. Retry uses
  `{turn,before:true}`. Rewind derives the confirmed expected head from that
  result. Never send an observed tool item's message boundary as a turn end.
  Handle `resync_required` using `error.data.reason` and reselect/reconfirm;
  `status:'stale'` is replaced by the shared error contract in v2.
  The SDK negotiates v2 on the wire; old SDKs retain their original response
  shape and stale result, so strict beta.3 clients can coexist with an upgraded Host.
- Keep both opaque neighbor cursors from each page. Do not combine `around` and
  `cursor`. Pass AbortSignal and an optional timeout for cancellable reads.

### Startup and self-healing

Use `ensureKodaXClient` when the app owns local Host startup/update:

```ts
const client = await ensureKodaXClient({
  requirements: { productHistoryTurnResolution: 2, productHistoryLocation: 2 },
  onStartupProgress: renderStartupProgress,
});
```

The existing launcher discovers the actual owner, upgrades a provably older
idle Host (or changed bytes in the same installation), closes temporary clients,
then reconnects with the original principal and requirements. No manual npm
capability casts, private Host startup implementation or second Session writer
is needed. Do not implement another upgrade/retry loop in the Renderer.

Optional history contracts are not newly mandatory for a basic Client startup.
Apps that can open before history editing is available may omit these optional
requirements and check
`client.capabilities.supports('productHistoryTurnResolution',2)` and
`client.capabilities.supports('productHistoryLocation',2)` per feature. A missing
turn contract fails before a new turn operation is sent. Module constants only
check SDK adapter support; they cannot prove a live Host was upgraded.

`connectKodaXClient` remains passive, accepts the same typed requirements, and
does not start/replace a Host. `ensure` retains existing busy/owner/build fences:
it never kills active work, replaces an unproven/newer foreign installation, or
replays an uncertain write. Competing launchers and connected-client contention
use the existing bounded startup wait/progress path. Active-work blockers are
structured upgrade errors; preserve the running work and retry normal startup
when idle. Do not treat such a blocker as corrupt SDK installation or reset the
user's home/session data. A changed launcher process must reload the installed
SDK bytes before retrying; do not weaken build proof to force startup.

The versioned contract, reasons, revision domains and remaining cold-read limits
are recorded in [Client contract](CLIENT_CONTRACT.md#2026-11-08-space-sdk-contract-repairs-shipped-in-v0797-beta4).


## SDK integration corrections (shipped in v0.7.97-beta.7)

- User entries in the current view, history reads and search retain the user's
  original text. Stop stripping observation-label suffixes in clients. Optional
  `attachments[].observationId/width/height/sha256` carry image observation facts;
  observation IDs remain opaque. Existing beta.5/beta.6 saved inputs are projected
  without rewriting their canonical model context.
- Read all accepted image formats (PNG, JPEG, WebP, GIF) through
  `sessions.readItem(..., { part: 'attachment', attachmentIndex,
  attachmentOffset, expectedImageSha256 })`. Use the returned actual mediaType,
  validate the hash and concatenate decoded byte chunks. Do not read attachment
  paths directly or calculate the Host media directory. The 512 KiB chunk and
  10 MiB image limits remain in force.
- `visual_history`, `visual_inspect`, and `visual_read_pixels` resolve to the
  `read` capability. The built-in capability inventory has a completeness test.
- Permission Interactions may include `options.extensionAsks`, a list of
  `{ extension, reason }` supplied by the Host. Show each reason alongside your
  own risk explanation. Keep the aggregate `reason` fallback for older Hosts;
  absence of the new field cannot identify the approval's origin. Extension asks
  remain one-call approvals without grant suggestions.

## SDK hardening migration (shipped in v0.7.97-beta.5)

These changes ship with the `v0.7.97-beta.5` tag; npm publication is a separate
maintainer step. Check the installed package and the connected Host before
relying on them.

- Extension `tool:before` now runs on every dispatch path, including AMA without
  `events` and nested constructed-tool calls. An early allow no longer ends
  evaluation, and a handler that throws or does not answer within 10 seconds
  blocks the call. Review hooks that relied on fail-open behavior.
- A handler may return `{ decision: 'ask', reason }`. Inline hosts answer it
  through the optional `KodaXEvents.requestToolApproval`; without it the ask
  blocks. Product clients receive an ordinary permission Interaction whose
  `reason` names the extension, with no grant suggestions: answer `allow_once`
  or `reject`. Hosts advertise `toolHookAsk: { version: 1 }`.
- With `KODAX_HOME` set, user Skills, personal workflows and commands load from
  `<KODAX_HOME>/skills`, `<KODAX_HOME>/workflows` and `<KODAX_HOME>/commands`,
  not `~/.kodax`. Move existing files. `~/.agents/skills` is unchanged.
  `SkillRegistry.refreshIfChanged()` applies on-disk Skill edits between requests.
- The model cannot write `<agent home>/extensions` or `<agent home>/integrations`,
  including the home of an inline Runtime built with `homeDir`. Install
  integrations through `kodax mcp add`, the integration commands or a Host UI.
- `ClientSessionView.sandbox` is an optional field with the latest shell sandbox
  health; Windows `applied` observations may list `degradedReadRoots`. Treat a
  missing field as not yet observed, not as healthy.
- `session_history_search` hits add `entryRevision`, which
  `session_history_read` accepts so tail appends do not make the read stale.
  Callers that ignore it keep the strict whole-history `revision`.
- In Runtime-owned Sessions, `read` returns an `observationId` with each
  accepted image and the visual tools join the tool list. Treat observation IDs
  as opaque.
- The idle Host expires retired agent-home state after 30 days (unresolved
  child records after 90) and rotates `daemon.log` at 2 MiB. Do not depend on
  Run event journals or filesystem-effect ledgers; neither is read by current
  code. A Host downgraded to v0.7.96 finds no Run event journal for Runs older
  than 30 days.
- The daemon Host copies its environment at start, including `HTTPS_PROXY`,
  `NO_PROXY` and `NODE_EXTRA_CA_CERTS`; restart it after changing them.

See the [Client contract](CLIENT_CONTRACT.md) unattended-run and permission
sections and [ADR-071](ADR.md) for the ask decision.

## One Host per KODAX_HOME (profile removed)

Breaking change shipped in `v0.7.97-beta.6`; npm publication is a separate
manual step. Decision:
[ADR-075](ADR.md). The Host is identified by its data root (default
`~/.kodax`). One Host serves each data root. It always uses the fixed
directories `runtime/daemon/default/` and `runtime/profiles/default/`;
`default` is a location, not a profile you can choose.

### `homeDir` / `--home` versus `KODAX_HOME`

They name different directories:

| Setting | Names | Data root |
|---|---|---|
| `KODAX_HOME` | the data root itself | the value, which must be absolute (a relative value is ignored) |
| `homeDir` option, CLI `--home` | the base directory that owns the data root | `<homeDir>/.kodax` |
| neither | | `~/.kodax` |

`homeDir: '/data/team'` and `KODAX_HOME=/data/team/.kodax` select the same
Host. `homeDir: '/data/team/.kodax'` selects `/data/team/.kodax/.kodax`, a
different Host and different Sessions. A data root that is not named `.kodax`
can only be selected with `KODAX_HOME`.

`resolveKodaXHome({ env?, homeDir? })` from `@kodax-ai/kodax/agent` returns the
env/default result without touching `process.env`: `{ path, source: 'env' | 'default', ignoredEnv? }`.
Here `homeDir` is the base for the `~/.kodax` fallback (default `os.homedir()`),
and `ignoredEnv` carries a non-empty `KODAX_HOME` that was skipped because it
was not absolute. `getAgentConfigHome()` returns the same path unless
`setAgentConfigHome` overrides it. An embedder that wants a different data root
must set `process.env.KODAX_HOME` before the first SDK call that reads it.

### Relocating a data root: `copyKodaXDataRoot`

```ts
import { copyKodaXDataRoot, KodaXDataRootCopyError } from '@kodax-ai/kodax/runtime';

try {
  const result = await copyKodaXDataRoot({
    from: oldRoot,
    to: newRoot,
    exclude: ['space/runtime-client-identity.json'], // embedder-owned per-root state
    onProgress: ({ files, totalFiles, bytes, totalBytes }) => {},
    signal,
  });
  // result: { files, bytes, skipped: [{ path, reason }] }
} catch (error) {
  if (error instanceof KodaXDataRootCopyError) error.code; // see below
}
```

It copies and never moves: the source is only read. Behavior:

- The target must not exist or must be an empty directory
  (`target_not_empty`, `target_invalid`). OS housekeeping entries
  (`.DS_Store`, `desktop.ini`, `Thumbs.db`, `lost+found`, `$RECYCLE.BIN`,
  `System Volume Information`, `.Spotlight-V100`, `.fseventsd`, `.Trashes`,
  `.TemporaryItems`) do not count and are left alone, so a drive root or a
  mount point works. It must not contain or sit inside the source
  (`nested_roots`).
- It refuses (`host_running`) while any Host slot under `runtime/daemon/*` or
  the Session storage owner lock names a process that is not provably gone, and
  checks again just before publishing. Stop every client of the source first.
- The copy is assembled inside the target. `KODAX_DATA_ROOT_COPY_MARKER`
  (`.kodax-copy-incomplete`) is written first and removed only when the copy is
  complete, so a target holding it is not a usable data root. A failed or
  aborted run removes what it wrote (and the target directory if it created
  it). A target left with the marker by a crashed run counts as empty and is
  replaced on the next call, so re-running is safe.
- Stored data holds absolute paths into its own root (MCPB install folders
  and launch arguments, session image and tool-output paths, workflow
  snapshots, embedder stores). In every `.json` / `.jsonl` file, each
  occurrence of the source root — native, forward-slash, or JSON-escaped with
  doubled backslashes; case-insensitive on Windows and macOS — that is not part
  of a longer name is rewritten to `to`. Nothing else in the file changes;
  other file types and files that are not valid UTF-8 are copied byte for
  byte. `rebasedFiles` counts the rewritten files. A source that is a whole
  drive is not rebased. A rewritten file whose length changed has a new size,
  so caches keyed on size and modification time rebuild.
- File modification times are preserved. Symbolic links and junctions are
  skipped, never followed.
- `skipped` lists the topmost skipped entry with a reason: `non-portable`,
  `excluded` (your `exclude`), `symlink` or `unsupported`.

Not copied (`non-portable`), because it belongs to one Host, process or
machine, plus any name ending `.lock` or `.lock.queue`:

| Path under the data root | Why |
|---|---|
| `runtime/daemon/` | Host descriptor, token, lock, log, owner policy, client exit receipts |
| `runtime/processes/` | live child-process records |
| `sessions/.product-host/` | Session storage owner lock |
| `instances/` | per-process heartbeat directories |
| `sandbox-runtime/` | sandbox gate and ACL state bound to this machine and boot |
| `native-text-state-v1/` | trusted state validated against its own directory ancestry |

Everything else, including `config.json`, `auth.json`, `sessions/`, `skills/`
and `runtime/profiles/default/runs/`, is copied. `auth.json` reserved
credential bindings tied to the source root's client identity are the
embedder's to `exclude` if they must not follow the data.

Error codes: `source_missing`, `target_invalid`, `target_not_empty`,
`nested_roots`, `host_running`, `aborted`.

### What was removed

| Where | Removed |
|---|---|
| `ensureKodaXRuntime`, `connectKodaXRuntime`, `createKodaXRuntime({ mode: 'daemon' })` | `profile` |
| `getKodaXRuntimeOwnerState`, `waitForRuntimeDaemonShutdown` | `profile` |
| `ensureKodaXClient`, `connectKodaXClient`, `readKodaXClientExits` | `profile` |
| `kodax daemon start\|stop\|restart\|status\|logs\|serve`, `kodax a2a serve` | `--profile` |

TypeScript callers get a compile error. Nothing is silently ignored:

- A JavaScript caller that still passes `profile` gets
  `RuntimeHostMigrationRequiredError` (`code: 'runtime_host_migration_required'`)
  before anything starts:
  `ensureKodaXClient no longer accepts "profile": one Host serves each KODAX_HOME. Remove "profile"; to isolate Hosts, use a separate homeDir or KODAX_HOME.`
- `--profile` on the CLI fails with the same text for the command, naming
  `--home` instead of `homeDir`.

### How to migrate

Delete the option. Code that used it to share one Host keeps working:

```ts
// Before
const client = await ensureKodaXClient({ homeDir, profile: 'coder' });
const exits = await readKodaXClientExits({ homeDir, profile: 'coder', clientInfo });

// After
const client = await ensureKodaXClient({ homeDir });
const exits = await readKodaXClientExits({ homeDir, clientInfo });
```

```sh
# Before
kodax daemon stop --profile coder
# After
kodax daemon stop
```

The same applies to `ensureKodaXRuntime`, `connectKodaXRuntime`,
`createKodaXRuntime({ mode: 'daemon' })`, `getKodaXRuntimeOwnerState` and
`waitForRuntimeDaemonShutdown`.

If you used `profile` to keep two Hosts apart, give each its own data root
(`homeDir`, `--home` or `KODAX_HOME`). A separate data root also separates
configuration, providers and Sessions. Before, two profiles in one home already
shared those; only the directory names differed.

### `identity.profile`

`RuntimeIdentity.profile` stays on the wire because older clients check it on
connect. It is deprecated. A current Host always reports `default`. A Host
started by an older client in another directory (older Space used `coder`)
reports that name while it serves the home. Do not use it to select or isolate
a Host.

### Older clients next to a new Host

| Pair | Result |
|---|---|
| new CLI + new Space | one Host in the fixed directory |
| new client + older Space whose `coder` Host owns the Sessions | `ensure`, passive `connect` and `kodax daemon start\|stop\|status\|logs\|restart` act on that Host; `readKodaXClientExits` also reads its exit receipts after it is replaced. When it is idle, the usual upgrade replaces it |
| older CLI (v0.7.97-alpha.7 or later) | uses the `default` directory, which is the new Host |
| older Space started after the new Host | follows the Session storage owner to the new Host; its `--profile coder` stop and exit-receipt paths miss that Host until Space is upgraded |

### One-time state merge

Older Hosts kept per-Session Runtime state under `runtime/profiles/<profile>/`,
so one Session could have different settings depending on which product
started first. When the new Host starts and owns Session storage, it merges
every `runtime/profiles/<p>/` into `runtime/profiles/default/` once:

- Runs, Session stop records and Session MCP records move when the target has
  none for that id; otherwise the target copy is kept.
- Session settings: the more recently written copy wins.
- Session order: the larger counter is kept, so numbering stays monotonic.
- Queued inputs: both queues are kept, once per input id. A Session holds at
  most 5 queued inputs; older-Host inputs beyond that are reported as withdrawn
  and can be sent again.
- Permission grants: only grants scoped to one Session are imported. Global
  grants, such as an "always allow" given in Space, are dropped and counted,
  because importing them would extend that approval to every client. Approve
  them again where needed.

A profile whose Host is still running is skipped until a later start. The
merged directory is renamed to `runtime/profiles/<p>.merged-<YYYYMMDD>/` and
removed by the idle Host 30 days later. One `runtime.host.state-merged`
diagnostic reports counts, conflicts, dropped grants and any item that failed.
A failed item stays in place and is retried on the next start.

### Not affected

Three other things are also called "profile" and do not change:

- Credential profiles: the account namespace in `auth.json` (API-key bindings,
  OAuth registrations).
- Agent and execution profiles (`KodaXAgentProfile`, `createExecutionProfile`).
- Session `profileId`.
