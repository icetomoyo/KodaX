# 权限模式

KodaX 通过四个权限配置控制文件系统与 Shell 命令权限。

## 权限配置

| 模式 | 行为 |
|---|---|
| **Plan** | 只读分析。KodaX 检查代码并提议方案，不做任何编辑。 |
| **Edits** | 受信文本编辑直接应用；合规的 Shell 命令先尝试沙箱，仅在经过验证的宿主边界处询问。 |
| **Auto[LLM]** | 先在沙箱中执行；仅经过验证的预启动宿主边界由 LLM 审查。 |
| **Full Access** | 直接在宿主执行，无沙箱、无 Auto 审查、无审批提示。 |

在 REPL 中，**Shift-Tab** 在 Plan → Edits → Auto[LLM] → Full Access 之间循环。旧的 Auto[RULES] 设置自动归一为 Auto[LLM]，且永远不会迁移到 Full Access。

## Auto 模式

Auto[LLM] 首先在 OS 沙箱内执行操作。沙箱完成是权威且静默的。只有沙箱不可用或在目标启动前拒绝时，才会进入宿主边界：

- Edits 询问用户。
- Auto[LLM] 询问审查器；allow 精确执行一次宿主尝试，concern 则阻止尝试并让 Agent 改用更安全的路线。
- 已经启动或可能已经启动的命令，绝不重放到宿主。

审查基础设施失败会重试一次（90 秒，然后 180 秒）。显式拒绝不重试，Auto 审查不会弹出自己的审批提示。

Full Access 绕过沙箱、所有审批路径和内置危险命令回退（包括强制删除和 Windows URL 启动模式）。未匹配的命令和显式 `allow` 规则直接执行。显式的用户、管理员和受信项目 `forbidden` 规则仍然拦截；显式 `prompt` 规则被拒绝，因为 Full Access 使用 Never 审批语义。

显式 `forbidden` 和 `prompt` 规则也会在识别到的嵌套 Shell 入口形式中检查：`cmd /C`/`/K`、PowerShell 命令选择器和缩写，以及严格解码的 UTF-16LE `EncodedCommand` 负载。若嵌套主体无法可靠降级，KodaX 保持完整外层 argv 不透明。外层/解释器策略仍适用；否则 Edits 或 Auto[LLM] 执行正常的宿主边界决策。

执行策略拒绝文本是 JSON，包含 `code`、`denialSource`、`source`、`sourcePath`、`permissionMode`、`matchedRules`、`retryable`、`remediation` 和 `guidance`。KodaX 内置或配置的规则并不代表 OS 限制。对于显式禁止，请联系策略所有者审查规则；对于 Full Access 下的 prompt 规则，请让用户选择 Edits 或授权策略变更。配置是快照；授权策略变更后启动新的 Run。绝不重写命令、切换解释器或创建脚本以绕过拒绝。

```bash
kodax execpolicy check --mode full-access -- <命令>
```

不带 `--mode` 时，检查器使用保守的内置回退契约。这是 token 前缀策略，不是任意脚本文件或动态生成程序的语义分析器。

## SDK 权限控制

SDK 调用方通过共享 Runtime 会话设置控制权限。直接 `runKodaX`/Coding 消费者拥有自己的宿主护栏和权限策略；`KodaXOptions` 不选择 Runtime 权限配置。Runtime 拥有沙箱优先路由；客户端不得添加第二个预分类器或从显示预览重建权限。`RuntimePermissionMode` 是标准的四模式输出类型；`RuntimePermissionModeInput` 额外接受旧的 `auto-in-project` 输入别名。

对于 `@kodax-ai/kodax` 直接 SDK 入口，实时 `context.resolveShellPermissionMode` 回调也管理默认原生文本宿主。Full Access 允许普通外部目标。Auto 模式下，来自 `auto-mode` 护栏或宿主 `beforeToolExecute` 的显式 allow 授权该具体的文本调用；后续宿主否决仍优先。审查或回调缺失不构成在工作根目录外写入的权限。

Runtime 和直接/托管提供商请求包含实时宿主 getter 的有效权限模式，即使有自定义系统提示。此上下文在后续请求和重试时刷新，而非从 `config.json` 推断或作为陈旧对话消息持久化。Runtime 会话设置优先于调用方默认值。修正后的文本审批和实时上下文契约需要 Runtime 权限能力 6。

## Shell 执行契约

KodaX 支持宿主可配置的 Shell 执行契约。Runtime 会话设置或单个 Run 可选择 `pwsh`、Windows PowerShell、`cmd`、`bash`、`zsh` 或显式的 Git Bash 可执行文件。KodaX 在有效项目 cwd 中解析 Shell 环境，然后通过同一解释器执行命令。

解析后的环境按契约和 cwd 隔离，在有限 TTL 后过期，可显式刷新。宿主环境（包括常规开发凭据）被继承；仅移除固定的 KodaX/Electron 执行控制变量和显式 `denyPatterns`。

`shellExecution` 缺省时，已建立的解释器路径保持不变。

## Full Access 文本工具与显式命令

Full Access 通过受信事务宿主允许普通 Git 元数据和工作区外的文本目标。每次操作重新检查权限；不会永久添加磁盘根。受保护的 Runtime/控制文件以及原生 no-follow、硬链接、修订/CAS 和原子性规则仍被强制执行。文本策略拒绝区分 `builtin_fallback` 和 `runtime_integrity`，并指明匹配的规则和补救措施。原生文本协议为版本 5；旧的原生绑定必须与宿主一起升级。

`write`、`edit`、`multi_edit` 和 `insert_after_anchor` 的 Auto 审批绑定到具体工具 ID、完整输入和解析后的目标。每次审批许可一次快照/提交事务。它不添加可写目录、授权另一个内容负载，也不授权后续 Undo。模式变更和 Run 取消撤销 Runtime 审批。受保护文件、原生链接/路径验证和修订/CAS 检查仍适用于已批准的外部文本操作。

手动 `!command`、扩展托管命令和嵌套作用域工具进入同一会话 Run 和 Shell 策略。手写输入不撤销显式禁止。停止请求从所属 Runtime 取消，并在确认前等待真正的工具清理。

## 另见

- [沙箱](./sandbox.zh-CN.md) — 沙箱优先隔离与宿主边界路由
- [配置文件](./config-files.zh-CN.md) — Config.json 参考
