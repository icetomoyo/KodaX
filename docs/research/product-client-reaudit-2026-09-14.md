# 主线融合后 Product Client / REPL 能力复核

后续补充：在修复提交 `795b8469` 上核验 GLM 清单，另确认配置/Provider 探测的本地消费路径、授权管理 UI 缺位、classic 初次连接策略差异及 Learning 空闲订阅释放问题；同时纠正 MCP、默认模型与 prepare* 的过宽判断。请结合[补充核验](glm-findings-followup-2026-09-14.md)阅读本报告，不能把下述“入口存在”理解为所有消费者均已迁移。

结论：2026-09-14 使用已有 GitHub token 同步 origin 后，主分支 `origin/KodaX` 为 `7b5b1b9e`，当前分支原 HEAD 为 `0841fb51`。`git rev-list --left-right --count HEAD...origin/KodaX` 为 `186 / 0`：当前分支已包含主线，无需再次合并。此次按 FEATURE_298 不退步约束重新检查融合实现，并修复已复现的消费者缺口，没有重写 Host 或重放分支历史。[设计约束](../features/v0.7.97.md#L130)

## 已承接的主线能力

Session Stop 的固定请求身份与队列 frontier、独立工具 Run、Full Access、trusted text authority、Shell cleanup 的未确认结果均已进入当前 Host。产品 Client 保持统一入口，REPL、ACP 和 one-shot 使用同一 Host；不能把旧内部 API 的删除直接当作功能缺失。具体源码链与主线 commit 证据见 [Host 审计](product-client-mainline-gap-audit.md)。

Session/设置/目标/lineage/历史全文、队列、交互、MCP、扩展诊断、Agent 协作、workflow、Memory 和 Learning 均有产品入口。入口存在不等于所有用户路径完成验收，本次按实际调用者继续查找数据丢失和生命周期错误。[REPL/UI 审计](repl-ui-mainline-parity-audit.md)、[SDK/适配器审计](sdk-adapter-mainline-parity-audit.md)

## 本轮修复

| 缺口 | 结果与回归边界 |
| --- | --- |
| 输入接受过程中取消，REPL 提前返回 interrupted | 接回已有 Stop + awaitRun；完成、取消、unknown 均由 Host 结算。[回归](../../packages/repl/src/ui/client-plane.stop-control.test.ts) |
| classic 已失效问题占用 readline，阻塞后续问题 | Host 移除请求、观察关闭时取消窗口，不发送迟到答案；后续问题可正常输入。[回归](../../packages/repl/src/interactive/classic-plane-display.test.ts) |
| 重连/另一 Client 取回队列图片后丢附件 | 保留 Host withdrawal 原输入，将缺失图片引用恢复为可编辑路径；已有绝对/相对引用不重复。需求评审进一步发现无后缀图片丢显式类型，补齐取回至重交的元数据；删除引用后不再携带图片，空闲/忙时提交均覆盖。[回归](../../src/cli-client-plane.test.ts) |
| one-shot 恢复旧设置覆盖另一窗口的新选择 | 公共 Client 复用 Host 已有设置 revision/CAS；应用和恢复均条件更新。实际双 IPC Client 测试先复现新模型被覆盖，再验证保留。[回归](../../src/one-shot-task.test.ts)、[条件设置回归](../../src/sdk-client.settings.test.ts) |
| ACP 的 repo-intelligence 进程参数未进入独立 Host | ACP 构造时解析调用配置，提交前通过既有 Session settings 传递；Host 与 ACP 配置不同的真实协议测试验证 light/trace 生效。[回归](../../src/acp_server.daemon.test.ts) |
| 清除 Auto 审查模型覆盖后，实际审核未回到 profile | 首轮完整测试及独立复跑均确认失败；每次审批复用既有 profile + Session 有效设置解析器，普通工具与 Shell 都采用同一默认模型。已有用例扩为 Runtime/Product IPC 两条设置控制面。[回归](../../src/sdk-runtime.test.ts#L16260) |

条件设置是本轮唯一新增的产品域能力：`sessions.getSettingsVersioned` 与 `updateSettingsVersioned`。它们复用既有 RPC 与 Host 设置权威，不增加恢复日志、第二设置层或 UI 能力矩阵。[接口契约](../CLIENT_CONTRACT.md)

## 仍需区分的边界

- one-shot 设置仍暂时作用于共享 Session。若期间另一个 Client 编辑了任意设置，恢复会报告冲突并保留现状，未被改写的调用旗标可能保留；此次消除了覆盖新编辑，未新增逐 Run 设置层。[设置语义](../CLIENT_CONTRACT.md)
- ACP 专用 repo-intelligence trace event sink 尚未从 Product view 获得该诊断事件；模式/trace 开关已到达 Host。现行产品契约明确不覆盖 `/runtime` 全部诊断，没有为此新增通用事件面。[适配器审计](sdk-adapter-mainline-parity-audit.md)
- A2A 恢复时若 Run 已在离线窗口完成，已完成分支缺少结果读取，可能缺 final text/artifacts；该代码也存在于主分支，属于继承问题，不是本次重构新增回归。当前证据是源码路径，尚未补该窗口的独立复现测试。[适配器审计](sdk-adapter-mainline-parity-audit.md)
- 浏览器 HTTP/WebSocket transport 尚未实现，属于既有明确边界；纯类型可供浏览器使用，Node SDK 承担实际连接。[连接契约](../CLIENT_CONTRACT.md)
- classic 同 item ID 正文缩短存在显示风险，但已查到的真实 retry 路径会更换 item ID。本次保留未证实记录，不据构造 DTO 宣称实际 Provider 回归。[REPL/UI 审计](repl-ui-mainline-parity-audit.md)

## 验证

各修复均先运行失败的公开接缝回归，再作最小实现。首轮完整运行与实施并行，包含旧模块缓存和新 RED 用例，不作为最终快照成绩；其中 Auto profile 回退失败已通过稳定单文件复现确认并修复。评审增量期间的两次完整运行被主动停止，最终成绩仅取代码冻结后的运行。

| 门禁 | 最终结果与证据 |
| --- | --- |
| 构建 | `npm run build` 通过，含四个独立 workspace、native、bundle 和 SDK 声明；Product Client 通过无 Node ambient types 编译。`.client-reaudit-final-verified-build.log` |
| 严格类型检查 | `npm run typecheck`（src/tests）通过。`.client-reaudit-final-verified-types.log` |
| 构建产物 Windows PTY | `npm run test:repl-pty:built`，Ink 21 + classic 14，**35/35**；exit 0，产物 `kodax-repl-acceptance-gHByg6`。`.client-reaudit-final-verified-pty.log` |
| 定向 V8 覆盖运行 | 13 文件、**423/423** 通过。覆盖范围包括全部本次修改的生产执行文件；以 `git diff --unified=0 0841fb51` 的新增行与 Istanbul statement 起始行相交，本次新增可执行行 **150/159 = 94.34%**。纯类型契约不进入执行覆盖分母；这是增量行覆盖率，不是全仓覆盖率，也不把未插桩的 PTY 算入该百分比。`.client-reaudit-coverage.log` |
| 完整 Vitest | 最终固定代码 `npm test` 通过，exit 0：**1086 文件通过、1 文件跳过；15799 用例通过、77 跳过、21 todo**，725.11 秒。`.client-reaudit-final-verified-suite.log` |
| 静态差异检查 | `git diff --check` 通过；仓库未配置独立 lint 命令。 |

本轮没有运行真实模型服务或其他操作系统实机验收；已完成的 Windows 终端验收与独立 IPC 回归不能替代这些范围。

## Standards

首份固定补丁（26 文件，SHA-256 `DCD8B5CF071A563BE64AF89A2D6C650C719BE1AB3911F25054C6982226314989`）规范轴：硬违反 **0 项**，需处理的 smell **0 项**。

- 契约、adapter、one-shot：复用既有 Host CAS，没有新增设置权威；两处薄投影不足以要求抽象。
- input-artifacts、queue、CLI、Ink：附件恢复位于 REPL 层，未破坏包独立性。
- classic、readline、client-plane：取消沿既有生命周期传递；撤回错误明确传播，没有新增通用状态机。
- 测试、文档：覆盖消费者行为，新增 Markdown 均在 docs 下。

Auto 增量（`DB27CCB7CF047EC074988E64406C2ACB53B4DA42738B8D3CF33D2EBFF8B34BA9`）硬违反 0、需处理 smell 0；复用 profile/Session 解析器，参数化已有测试。媒体元数据与最后的路径匹配增量（最终 `5936709BA4BF52B937640426E643AE45D42C8D5AA9C67C6A8B625CD1A345D2D4`）两轮均为硬违反 0、需处理 smell 0；路径键有恢复、解析和队列三个真实用例。文档旧描述已同步。

## Spec

首份补丁发现 **1 项 P2**：SDK 无后缀图片带显式 `mediaType`，仅恢复路径会在重交时按后缀识别失败而静默丢附件。违反 FEATURE_298：“不因纯数据契约而删除……附件或图片能力”。原作者补回取回至提交的媒体信息，覆盖空闲/忙时两条消费者路径。

第一次媒体增量复查发现该 P2 仍有 Windows 大小写残留：恢复引用按大小写不敏感比较，新元数据匹配却直接比较字符串，`Capture` 与 `@capture` 会丢类型。随后三个匹配点统一平台路径规则，两个公开 queue 回归先 RED 后 GREEN。

最终媒体增量需求轴 **0 项未解决 finding，旧 P2 已关闭**。评审者独立重跑原只读复现，`submitPrompt` 与预处理后 `submit` 均保留图片。Auto 增量需求轴 **0 项 finding**；普通工具与 Shell 审核均回到 profile，符合清除 Session 覆盖的约定。

规范轴剩余 0 项；需求轴剩余 0 项。上述计数只覆盖本次固定补丁及增量，不抹去前文记录的产品边界或主线继承问题。

## 未解问题

本次不决定浏览器 transport、逐 Run 设置层或通用诊断事件接口的新产品设计。A2A 离线完成窗口、真实模型服务及其他操作系统的验收应分别留下独立证据，不能由当前分支已包含主线或本轮定向测试通过推导为已完成。
