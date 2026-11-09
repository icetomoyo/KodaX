# 沙箱

KodaX 支持可选的 OS 级沙箱，用于隔离模型发出的 Shell 命令。Windows 上 ASRT 负责网络/账户配置，KodaX 原生运行器负责受限 Token 和进程 Job；macOS 和 Linux 直接使用 ASRT 的平台后端。

## 激活沙箱

```bash
kodax sandbox doctor    # 验证目标启动并检查就绪状态
kodax sandbox setup     # 激活
```

这些是宿主控制面命令：在用户终端直接运行，不要通过 KodaX 的 Bash 工具执行。在 REPL 中，使用 `/sandbox` 进行只读就绪诊断。

`kodax setup` 和首次运行配置也会检查一次沙箱就绪状态。

## 平台后端

| 平台 | 后端 | 依赖 |
|---|---|---|
| **Windows** | 受限沙箱账户 + 网络策略 | 无（激活时 UAC 提示一次；健康的代际升级保留现有 SID） |
| **macOS** | Seatbelt（`sandbox-exec`） | ripgrep（`brew install ripgrep`） |
| **Linux** | bubblewrap | `bubblewrap`、`socat`、`ripgrep` |

`getKodaXSandboxSetupGuidance(doctor)` 保留已报告的诊断结果，并提供针对实际缺失依赖的修复建议。KodaX 不会自动运行 `sudo` 或包管理器。

Linux 还需要内核和宿主安全策略允许非特权用户命名空间。KodaX 不修改 sysctl 或 AppArmor 策略；若代理无法 spawn 目标，独立 SDK 返回 `reason: 'backend_launch_failed'` 加有界诊断，而不是声称命令在沙箱内完成。

## REPL 诊断

在 REPL 中，`/sandbox` 刷新就绪状态和诊断结果，不激活后端，不请求提权。

## 环境、读写与网络

沙箱命令继承宿主环境（包括常规开发身份），可访问外部网络。固定的内部拒绝集移除 KodaX/Electron 执行控制变量。读取范围较宽，包括 Agent Home、凭据位置和全局 Git 配置。写入范围限于工作区和平台临时目录根。废弃的 `sandbox.envPass` 输入被忽略。

## 受信文本工具（v0.7.96）

在 Windows、Linux 和 macOS 上，Runtime 的 `write`、`edit`、`multi_edit`、`insert_after_anchor` 和 `undo` 是受信的 KodaX 宿主操作，不进入 ASRT、工作区 Session、原生 Shell 运行器或沙箱辅助程序。宿主使用文件级内核锁、加锁重读、修订/内容 CAS、刷新的同目录临时文件和原子替换来授权最终规范的本地路径。符号链接/重解析目标、远程文件系统和敏感的 KodaX/Git 控制位置会失败关闭。这些工具受宿主策略约束，不作为 OS Token 沙箱写入操作通告。

隔离的 Skill Script 执行使用 native protocol 10，仅支持 POSIX。由于该路由需要每命令 `denyRead`，而 Windows 沙箱不支持此策略，因此 Windows 不可用。

## SDK 沙箱

SDK 命令目标继承其执行宿主的环境。SDK 嵌入者也可通过 `@kodax-ai/kodax/sandbox` 独立使用独立 Shell 沙箱能力。不可用结果可能包含 `reason: 'doctor_not_ready' | 'backend_launch_failed'`；后者还包含有界 `diagnostic`，不会被报告为沙箱完成。单独的 `execution_uncertain` 结果意味着无法恢复目标启动权限，调用方在决定下一步之前必须重读外部状态。

## 另见

- [权限模式](./permissions.zh-CN.md) — 权限模式与 Auto 模式
- [配置文件](./config-files.zh-CN.md) — Config.json 参考
- [SDK 沙箱 API](../sdk/embedder-guide.md#30-standalone-sandbox-sdk-v0778) — SDK 沙箱子路径
