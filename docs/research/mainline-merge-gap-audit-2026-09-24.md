# 2026-09-24 主线合并与统一接口缺口复核

本次将 `origin/KodaX` 的 `c447c0f3`（v0.7.96-rc.11）合入 `codex/product-client-refactor`，合并前为 `88e11abd`。共接入主线 10 个提交，涵盖 Windows 身份诊断和状态发布重试、Memory 与终态维护的关闭排空、预取消终态、文本事务缓存范围、macOS Git 安装弹窗预检。文档子模块也已融合两侧历史。

结论：未发现本次合并把统一 Product Client/Host 设计改回客户端执行。当前分支仍有已确认的消费和适配缺口，不能把“公共契约存在”解释为所有终端或协议消费者已经完整。

## 合并保留的设计

- Product contract、Client adapter、输入队列与 Session view 没有被本次主线改写；REPL 的配置、能力探测、执行与观察仍经过当前 Host 接线。
- Memory 与 maintenance 所有权进入现有 Runtime close，关闭先取消/排空工作，再释放 Host 资源；无需 UI 自己清理后台任务。Run 完成和 shutdown 受理均不代表后台清理已经全部结束。
- 保持 `ensureKodaXRuntime` 主动启动/更新、`connectKodaXRuntime` 被动连接；保留已删除的通用 exit-settlement，不恢复 worker 或第二个执行入口。
- Windows state 采用主线限定 EPERM、单调 200ms 预算的原子替换重试，保留当前身份结构。新 bundle Memory 夹具也按上述生命周期适配。
- 独立需求评审发现主线 Git 预检只保护旧 REPL review helper，当前 Host 捕获 diff 的路径漏接。已在 Host helper 复用同一预检，并新增经真实 IPC 的 Product review 回归；没有把 Git 执行搬回客户端。

冲突意图、源码位置和专项结果见 [Host 复核](host-mainline-2026-09-24.md)。本轮没有调用真实模型。

## 旧 GLM 清单的更新

| 旧问题 | 当前判断 |
| --- | --- |
| 配置、模型、Provider probe、fallback/log 留在本地 | 产品路径已由 T40–T42 接到 Host。独立 REPL 的本地兼容分支不构成产品路径退回本地。 |
| Learning 每 100ms 轮询 | 已改为推送；剩余问题是迭代器收尾和失败传播。 |
| models 从 Provider 列表派生，未用专门 RPC | Product adapter 仍如此实现，模型列表和 Provider 过滤已提供；这是实现重复，没有发现用户能力缺失（`src/client-runtime-adapter.ts:273`）。 |
| prepare 四组声明半接线 | 已清理未接线的 REPL 声明/消费。 |
| classic 与 Ink 重连次数不一致 | 两端均为初次加最多五次自动重试，执行前可重新观察，失败保留草稿。 |
| 默认模型一直显示占位、历史只搜索窗口 | Host 默认模型已投影；搜索会读取完整历史。全量读取成本未量测，只是优化候选。 |
| MCP CRUD 完全不可用 | 公共 Client 已有管理能力；REPL `/mcp` 仅提供 status/refresh，独立 CLI add/remove 属离线配置管理。 |
| 授权 list/revoke 无终端入口 | 仍成立；SDK 服务及测试已有。 |

逐条源码与提交证据见 [REPL 复核](repl-mainline-2026-09-24.md)。

## 当前缺口与建议顺序

1. **P2：Learning 推送迭代器生命周期。** 空闲 `next()` 不随 `return()` 结算；握手先于首次读取失败时错误未保存，后续读取一直等待。两个独立审计均以工作树原函数的隔离 stub 复现，尚非完整 IPC 复现。最小修复是保存终止/失败状态并唤醒等待者，补两个时序回归；无需重做推送协议，也不存在旧轮询的空转 RPC。
2. **P2：A2A 离线完成后的最终结果恢复。** 同一 Runtime 存活、edge 重启时 Run 已终结，恢复分支仅传 phase，未取完整 `runs.await` 结果，因而遗漏最终文本及错误详情。这是确定的静态路径；既有测试只覆盖重连后才完成。应补 terminal-at-recovery 回归再修补结果读取，不扩大为所有文件 artifact 丢失。
3. **P2：持久授权管理缺少 REPL 入口。** 消费已有 list/revoke 服务即可，保持 revision 和授权语义，不新增存储。
4. **需明确的恢复责任：** Learning/workflow 订阅没有 Session observe 的重订阅机制；应明确由消费者重建还是 transport 恢复，并用真实断连测试验证。当前不将其写成已复现的通用断线故障。

以上是本次审计记录的既有缺口，不是本次合并新增回归；本轮没有扩展实现这些独立功能。

## 明确边界

- 浏览器只有可用的纯类型契约，连接实现仍是 Node socket/named pipe；HTTP/WebSocket transport 尚未交付。
- A2A server 仍需要内部 Runtime execution binding，尚非可独立部署、仅依赖 Product Client 的 edge。
- ACP Product 路径未投影专用 repo-intelligence trace；question/form 需要其他 KodaX Client 回答。Host 能力存在，不等于 ACP 已有所有交互入口。
- T47 未承诺逐字工具参数 JSON 预览；已有工具身份、字符数和 thinking 活动反馈。
- 自定义 reviewer 若不遵守协作取消，仍可能延迟 Host 关闭；不应提前释放所有权来掩盖它。

详细来源和验证限制见 [Adapter 复核](adapters-mainline-2026-09-24.md)。

## 验证

- `npm run build`：最终 Host review 补丁后通过，包含不依赖 Node ambient types 的 Product Client 契约检查。
- `npm run typecheck`：最终完整 src/tests 类型检查通过。
- Host review 新 IPC 回归：4/4 从 RED 到 GREEN；原 ordinary/scoped review 成功用例 2/2 通过。
- Host 生命周期专项：5 文件、106 用例通过，包括 Windows 真并发 state 发布。
- `npm run test:repl-pty:built`：Ink/classic 合计 47 项通过。
- `npm run test:bundle`：完整重跑 39/39 通过。新 Memory 夹具初轮两例因旧启动 API 失败，适配后单文件 3/3 通过，保留实际 HTTP 取消、持久任务及唯一恢复回执断言。
- `npm test`：完整运行 744.29s；1125 文件通过、1 文件失败、1 文件跳过；16312 用例通过、1 失败、77 跳过、21 todo。唯一失败是合并两侧 Issue 336–339 后，KNOWN_ISSUES 汇总仍写 216/182，实际应为总数 218/已解决 184。修正文档后，tracker-consistency 与 release-workflow 两文件 21/21 通过；未为这一纯文档修正重复整套测试。此次没有 Vitest reporter timeout。
- 上述新 Host review 测试是在全量启动后新增，单独运行结果列于前文，不把它重复计入全量数量。各专项结果互有重叠，不累计成总数。
- macOS 缺工具场景以 guard 模拟和实际 IPC 接线测试覆盖，不宣称已在 macOS 真机验收；跨平台人工验收仍待执行。日志保存在本地忽略文件 `.sept24-merge-*.log`，不提交。

## Standards

独立规范轴审阅固定补丁，未发现本补丁新增且需要修改的成文规范违反或有充分证据的 smell。核验 AGENTS.md、CONTRIBUTING.md 与 12 项 smell 基线；未把既有大函数或两处重复机械地列为问题。后续独立复核 Memory 测试生命周期适配及 Host review 补丁，均为 0 项发现。

## Spec

独立需求轴发现 1 项 P2：主线要求 SDK-owned Git 调用预检，而 Product `/review` 由 Host 捕获 diff，`src/runtime-review-preparation.ts` 未调用预检。来源为主线 `54ac092a` 的 “before SDK-owned Git calls” 和 CLIENT_CONTRACT 的“Host 捕获 git diff”。建议在 Host helper 复用 guard 并测试 Product 路径；本轮已按此修复，验证结果见上节。未发现其他新增需求缺失、scope creep 或 exit-settlement 复活。

规范轴：0 项；需求轴：1 项，最高 P2，已修复并通过专项验证。两轴未合并排序。
