# KodaX 文档

面向 KodaX 用户、产品客户端集成方和受信 Host 开发者的文档。

本开发树基于 FEATURE_298/299/301/303/304/305/306 实现了统一的 Product Client 契约。当前包版本为 `0.7.97-beta.9`；`v0.7.96` 为最后一个稳定版本。

`v0.7.97-beta.9` 新增数据根目录迁移（FEATURE_306：`resolveKodaXHome` 与 `copyKodaXDataRoot`），`inputs.withdraw` 可撤回尚未投递的 `steer` 输入，另一客户端仍连接时客户端退出的停止请求会立即被拒绝（Issue 410），相对路径的 `KODAX_HOME` 会被忽略并给出警告；`v0.7.97-beta.8` 修复了 Windows daemon 启动可靠性（Issue 409）：fail-closed 启动路径改用随包的原生 helper 验证并托管 kill-on-close Job，不再通过 PowerShell 编译 C#，失败启动保留清理句柄并串行化同槽位准入，`child_exit` 可重试；`v0.7.97-beta.7` 修复了 Space 集成报告中的图片投影、附件读取与扩展审批归属问题（Issue 408）：用户图片的观测标签离开视图、历史与搜索正文，Host 附件读取覆盖 PNG、JPEG、WebP 和 GIF 并返回实际 mediaType，只读视觉工具解析为 `read` 能力，扩展审批携带逐扩展的结构化归属；`v0.7.97-beta.6` 改为每个 `KODAX_HOME` 一个 Host：SDK 入口与 `kodax daemon`/`a2a serve` 命令删除了 Host 位置的 `profile`（破坏性变更），Space 与 CLI 跨安装共用一个兼容 Host，独立二进制的 Linux 下限降至 glibc 2.17，Session 设置不再随共享的用户默认值变化；`v0.7.97-beta.5` 合入了 SDK 基础加固（扩展 `tool:before` 覆盖所有分发路径并失败即阻止、模型不能写入 agent home 的扩展与集成目录、`web_fetch` 拒绝云元数据地址与公网到内网的重定向）、代理与私有 CA 支持、扩展请人批准单次调用、持久的视觉观测与 Managed Run Context 复用，并修复 Windows 沙箱、冷启动与 agent home 保留问题；`v0.7.97-beta.4` 修复了 Space SDK 指令与历史记录客户端契约（AGENTS-only 编辑器加载、标签指令加载器、带修订围栏的历史契约 v2（Fork/Rewind/Retry 轮次目标）、双向分页与可取消读取、带类型的能力检查及可选的 Launcher 要求）；`v0.7.97-beta.3` 修复了长上下文恢复（有界读取、自适应 compaction 预算和严格完整摘要解析）、持久化独立 Actor 结算、首次 Run 工作模式锁定和保存的 Session 历史记录（`productHistoryLocation` 与 `productHistoryTurnResolution`），并经过中断退出恢复及 DOCX/LibreOffice 证据验证；`v0.7.97-beta.2` 强化了 Script 执行可靠性（无碰撞 VM 调用路径、带类型的程序数据、原生工具名 wire 保真、可选 sourceContent 和按需 outputSchema、缺失 Node global 的上下文引导）以及共享 Host 恢复和 Workflow 完成修复；`v0.7.97-beta.1` 完成了 Space 侧 Host 执行与 Session 接缝（主 Skills 默认使用消费时执行绑定、Quick Ask Session 提升、重定向边界恢复和原子化核心配置发布）；`v0.7.97-alpha.12` 将公开产品执行收敛到独立共享 Host，并落地了 FEATURE_302 提供商/OAuth 凭据一致性栈及 Claude 5.5 历史记录支持；`v0.7.97-alpha.11` 添加了显式 Agent/Coding/Script 工作模式，并刷新了 Ark、MiMo 和 MiniMax 目录；`v0.7.97-alpha.10` 在 Host 重启后继续检查点 Run，扩展了实时上下文容量恢复，新增 Kimi K3.1 提供商路由和答案感知 AskUser 跳过策略；`v0.7.97-alpha.9` 通过规范元数据准入检查将不可读 Session 记录正文与 Run 列表/Daemon 检查隔离；`v0.7.97-alpha.8` 将 Artifact SDK 内置到主包（`/artifacts*` 子路径，Node floor 20.16，无独立 artifacts npm 包）；`v0.7.97-alpha.7` 跨 Daemon Profile 解决了共享 Session Host 所有权问题，包括可重试的启动/连接超时、空闲 Host 退出和有界 Windows 附加。npm 发布为独立的维护者操作。历史发布说明不覆盖当前客户端契约，也不表明包已发布。

对于 TUI、桌面/IDE 客户端和共享 Session 自动化，从 `@kodax-ai/kodax/client` 开始。Host 负责执行、设置和持久化。独立库和受信 Host API 保持为独立集成层。SDK 和 CLI 启动共享 `onStartupProgress`，包括实际 Host `initializing/phase` 观测值；这些不构成就绪状态，也不添加额外探针。

## 入门指南

会话工作模式（Agent、默认 Coding 和实验性 Script）、一致的问题结果、保存的原始工具读取、结构化任务报告和估算 token 流式进度在 `v0.7.97-alpha.11` 中发布；统一 Host 切换和提供商/OAuth 凭据一致性在 `v0.7.97-alpha.12` 中发布；Space 执行和 Session 接缝在 `v0.7.97-beta.1` 完成；Script 执行可靠性强化和共享 Host 恢复修复在 `v0.7.97-beta.2` 发布；长上下文恢复、持久化 Actor 结算及保存历史记录位置/轮次解析在 `v0.7.97-beta.3` 发布；指令与历史记录契约 v2 修复在 `v0.7.97-beta.4` 发布；扩展策略加固与单次批准、代理/私有 CA 支持及持久视觉观测在 `v0.7.97-beta.5` 发布；每个 `KODAX_HOME` 一个 Host 并删除 Host 位置的 `profile` 在 `v0.7.97-beta.6` 发布；Space SDK 图片投影、附件读取与扩展审批归属修复在 `v0.7.97-beta.7` 发布；Windows daemon 原生 Job 启动修复在 `v0.7.97-beta.8` 发布；数据根目录迁移与 steer 撤回在 `v0.7.97-beta.9` 发布。请阅读[当前 SDK 对齐说明](sdk/embedder-guide.md#post-alpha10-sdk-alignment)、[统一 Host 切换说明](sdk/embedder-guide.md#unified-host-sdk-cutover-shipped-in-v0797-alpha12)和[每个 KODAX_HOME 一个 Host](../docs/SDK_MIGRATION.md#one-host-per-kodax_home-profile-removed)以了解兼容性和独立库边界。首次读取延迟历史追踪见 Issue 371。

- [概述](./getting-started/overview.zh-CN.md) — KodaX 是什么，与同类工具的对比
- [安装](./getting-started/installation.zh-CN.md) — npm、单体二进制、从源码构建
- [快速开始](./getting-started/quickstart.zh-CN.md) — 你的第一个会话

## 配置

- [提供商与 API Key](./configuration/providers.zh-CN.md) — 16 个内置提供商别名
- [自定义提供商](./configuration/custom-providers.zh-CN.md) — OpenAI/Anthropic 兼容端点
- [配置文件](./configuration/config-files.zh-CN.md) — config.json、分文件、环境变量
- [权限模式](./configuration/permissions.zh-CN.md) — Plan / Edits / Auto[LLM] / Full Access + Exec Policy
- [沙箱](./configuration/sandbox.zh-CN.md) — 可选的 OS 级隔离（ASRT）
- [记忆](./configuration/memory.zh-CN.md) — 跨会话笔记、后台学习、`/memory`

## SDK

- [产品客户端集成](./sdk/embedder-guide.md#product-client-integration) — 共享 Session 应用的默认入口；同时链接到作用域低层 Host/库参考。
- [SDK 迁移指南](../docs/SDK_MIGRATION.md) — 新旧调用对照、生命周期和迁移验收（中文）。
- [客户端契约](../docs/CLIENT_CONTRACT.md) — 完整产品方法清单、观测、历史记录与错误语义。
- [Artifact SDK](../docs/ARTIFACT_SDK.md) — 可选独立包、共享 Host/Node 配置、九项操作、格式支持、证据与视觉审阅限制。

## 使用指南

*（更多独立指南即将发布：CLI 参考、REPL 命令、会话、多 Agent、技能、扩展、MCP、A2A、仓库智能、记忆、工作流、Compaction、Doctor、工具参考。当前 Skill SDK 语义见嵌入指南。）*

## 参考

*（即将发布：故障排查、FAQ、对比、许可证。）*
