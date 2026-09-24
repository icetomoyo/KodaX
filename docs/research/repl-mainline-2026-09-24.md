# 2026-09-24：合并最新主线后，REPL/UI 统一消费面还有哪些缺口？

结论：9 月 15 日的 config/catalog/probe、Learning 轮询、prepare 备用入口、classic 与 Ink 重连次数差异均不能继续列为未完成；当前值得优先处理的是 Learning 推送迭代器的释放/失败结算，其次是已有授权服务缺少 REPL 管理入口。浏览器传输和逐字工具 JSON 预览属于明确边界。依据：下文当前源码与实现提交；本笔记没有运行全量测试或真实 Provider。

## 核对基线与方法

- 分支基线为 `88e11abd`，合并对象为主线 `c447c0f3`。读取的是合并中的工作区；本次主线在 REPL 的生产改动主要是 Git 可用性检查，`client-contract.ts`、`client-runtime-adapter.ts`、`cli-client-plane.ts`、`InkREPL.tsx`、`interactive/commands.ts`、`runtime-daemon/client.ts` 相对分支 HEAD 无本次合并差异（`git diff HEAD -- <上述路径>`）。合并最终验证由主任务另行记录。
- 只以仓库源码、规格和测试代码为证据；下文“有测试覆盖”指已读到回归场景，不冒称本轮重新执行通过。已实现设计为 [FEATURE_298](../features/v0.7.97.md)，公开边界为 [CLIENT_CONTRACT](../CLIENT_CONTRACT.md)。

## 旧 GLM 清单的当前状态

| 原判断 | 当前核验 | 一手证据 |
|---|---|---|
| `/model`、默认配置仍在客户端写文件 | **已闭合产品路径。** CLI 注入 Host config/catalog，Ink/classic 转发到 commands；`hostModelCommand` 查询 Host Provider 模型，`saveAndApplyHostSetting` 分开保存默认与应用 Session，保存报错会回查 Host，明确部分成功。独立未绑定 REPL 保留本地兼容分支，不能据其仍有 `prepareRuntimeConfig` 就认定产品路径退回本地权威。 | `src/kodax_cli.ts:4986`；`packages/repl/src/interactive/repl.ts:1360`；`packages/repl/src/ui/InkREPL.tsx:10238`；`packages/repl/src/commands/host-settings.ts:45`、`:105`；`src/sdk-client.catalog.test.ts:132`；提交 `3246f30b`、`849dd668`。 |
| `/fallback`、verifier/stall 日志仅改变 UI 环境 | **已闭合。** 三个既有字段调用 Host config，并读取安全的有效值、来源及 applied；测试分别覆盖真实 sidecar 日志和 Workflow child fallback。 | `packages/repl/src/interactive/commands.ts:1225`、`:2058`、`:2134`；`packages/repl/src/commands/host-settings.ts:6`；`src/sdk-client.catalog.test.ts:227`、`:299`、`:395`；提交 `1305f0e6`。 |
| Provider probe/forget 仍本地执行 | **已闭合完整接线。** CLI catalog 经两种 REPL callback 到 probe/forget；Host 未绑定分支仍服务独立 REPL。回归覆盖后续 SA/AMA 请求实际使用同一能力缓存。 | `src/kodax_cli.ts:4986`；`packages/repl/src/interactive/repl.ts:1361`；`packages/repl/src/ui/InkREPL.tsx:10239`；`packages/repl/src/interactive/commands.ts:1741`、`:1762`；`src/sdk-client.capabilities.test.ts:16`；提交 `774f572f`。 |
| Learning 100 ms 轮询 | **已改推送，但释放/错误结算仍需修复，见下一节。** 当前使用 `learning.subscribe/unsubscribe` 通知。 | `src/runtime-daemon/client.ts:1081`、`:1402`、`:1416`；提交 `7a8fc22a`。 |
| prepare 四组备用入口半接线 | **已清理 REPL 无接线声明/消费。** 在 REPL 源码搜索 `prepareReview/prepareAgentsLean/prepareSkillInvocation/prepareCommandInvocation` 无匹配；执行准备由 Host 动作或原独立本地路径承接。 | 提交 `7a8fc22a` 的 commands/types、review/agents、user-skill-invocation、Ink/classic 改动。不能沿用此前“注入者仍可用所以不能删”的历史判断。 |
| classic 六次后放弃，Ink 无限重试 | **差异已闭合。** 现在两端都是初次 + 最多五次自动重试，之后执行前重新观察；观察不可用时保留未提交草稿，不放行新执行。 | classic `packages/repl/src/interactive/repl.ts:971`、`:987`；Ink `packages/repl/src/ui/InkREPL.tsx:1890`、`:1895`；`src/sdk-client.repl-observation.test.ts:49`；提交 `4c4f8e26`。 |
| 未选模型恒显示 `—` | **不成立。** Session view 同步以 `contextBudget.provider/model` 补 Host 解析默认值；不能仅按某个占位分支判断真实状态。 | `packages/repl/src/ui/client-session-settings.ts:8`；其相邻 `.test.ts`；提交 `3246f30b`。 |
| 历史搜索只能搜已显示部分 | **不成立；仍有性能边界。** 打开搜索主动读完整 Host 历史和冻结条目，再建本地索引；没有使用服务端 `searchHistory` 不等于结果仅限窗口。 | `packages/repl/src/ui/InkREPL.tsx:5191`、`:5202`、`:5532`、`:5553`、`:4336`。 |
| MCP CRUD 缺失 | **原判断范围过宽。** `/mcp` 本身只承诺 status/refresh；独立 `kodax mcp add/remove` 是离线配置管理。公共 Client 已有管理能力，REPL 没有新增 CRUD UI 不等于远程 Client 无能力。 | `packages/repl/src/interactive/commands.ts:1003`、`:1063`；`docs/CLIENT_CONTRACT.md:79`；`packages/coding/src/client-contract.ts` 的 `mcp` 服务。 |
| 授权 list/revoke 无 UI | **仍成立，是消费入口缺口。** 服务与双 Client 回归已有，REPL callbacks 和命令树未暴露管理入口。 | `packages/coding/src/client-contract.ts:193`；`src/client-runtime-adapter.ts:161`；`src/sdk-client.permissions.test.ts:171`、`:189`、`:207`；`packages/repl/src/commands/types.ts:182`，REPL 源码搜索 `listGrants/revokeGrant` 无命中。 |

## 当前确定缺口与最小下一步

### P2：Learning 推送迭代器的 pending next 不能正确终止

`return()` 已能立即返回并关闭远端订阅，旧“return 自己一直卡住”的轮询问题已经消失。但它未唤醒正在等待的 `next()`；订阅握手失败时仅调用当时存在的 `failure`，失败若先发生、之后才开始 `next()`，错误没有留存，读取同样一直等待。依据：`src/runtime-daemon/client.ts:1424`、`:1433`、`:1443`。现有领域回归只在收到了事件后调用 return，未覆盖空闲中断或先失败后读取：`src/sdk-client.domains.test.ts:582`。

本次以原函数源码经 TypeScript transpile 后在隔离 VM 内注入无 IO 订阅检查两种时序，分别得到 `{kind:"idle-return",closed:true,next:"pending"}` 与 `{kind:"early-handshake-failure",closed:false,next:"pending"}`。这是函数级确定性证据，不是新一轮真实 IPC 验收。最小下一步：增加这两个回归，关闭时清理缓冲/唤醒等待者，保存订阅失败使后续读取明确失败；再验收真实 daemon 断连与取消。不需要重做推送协议。

### P2：持久授权缺少终端管理入口

已经通过永久批准生成的 grant，可以由 SDK 列表/撤销，但 REPL 用户没有等价的显式入口；这是产品操作面的不完整，不是授权执行失效。依据：上表 permissions 来源。最小下一步：在现有权限命令中增加列表和按已读 revision 撤销，消费现有服务即可；保留相同的授权和 stale revision 语义，不新增权限存储。

## 静态风险与明确边界

- **长历史搜索成本，P3 优化候选。** 首次完整搜索会读全部历史到终端进程；源码支持此判断，但本轮没有量测内存/延迟，不能宣布性能回归。下一步只在有大 Session 的真实慢例时测量并评估已有 Host search 服务，避免凭猜测引入第二套索引（`InkREPL.tsx:5191`、`:4336`）。
- **T47 未承诺逐字工具 JSON 预览。** 工具名、请求/调用身份、累计字符数及 thinking 阶段已经进入 view，classic 按阶段去重、Ink spinner 消费；半截参数 JSON 不保存。属于经设计限制的展示差异，不能再列为整类流式反馈缺失（`docs/CLIENT_CONTRACT.md:401`；`packages/repl/src/interactive/classic-plane-display.ts:91`；`src/sdk-client.streaming.test.ts:15`；提交 `85b807ea`）。
- **T43–T47 不是只有 DTO。** 权限默认、观察门禁、工作区详情、effort 拒绝/发送事实和流式活动都有消费者或真实 Host 测试；后续 `1df3afe2` 又补了 busy Session attach/observed Run stop/展示反馈。这些已有能力无需重新造一份客户端状态机（`docs/features/v0.7.97.md:1021`；`src/sdk-client.repl-activity.test.ts:56`；`src/sdk-client.capabilities.test.ts:16`；上述提交）。
- **浏览器网络传输仍未实现。** `/client-contract` 可做浏览器纯类型输入，但现有连接是 Node 本地 socket/pipe，契约明确没有 HTTP/WebSocket 网关。属于已声明交付边界；未来 Web UI 需要独立 transport 工作，不能宣称只接一个 endpoint 就完成（`docs/CLIENT_CONTRACT.md:25`、`:31`、`:379`）。
- **本次主线 consumer 改动未恢复第二执行权威。** review/common utils/workspace-runtime 的差异是调用 `assertNoGitInstallPrompt`，规避 macOS Git 安装弹窗；Host config、输入、观察、Session 切换路径并未被本次主线改回客户端执行（`git diff HEAD -- packages/repl/src/commands/review-command.ts packages/repl/src/common/utils.ts packages/repl/src/interactive/workspace-runtime.ts`）。这是 diff 结论，最终合并运行正确性仍以主任务验证为准。

## 未证实与未解问题

- 未重复执行 Windows/macOS/Linux 终端视觉/交互验收；源码测试存在不能替代发布人工验收（`docs/features/v0.7.97.md:1148`、`:1167`）。
- 本笔记不裁定 A2A/ACP 边界问题，交给同轮 adapter 审计；不沿用 9 月 15 日风险直接充当当前事实。
- 需要产品决定授权管理入口的命令名称与展示方式；其后端能力不需要设计扩充。长历史搜索是否需要优化，待真实负载证据。
