# KodaX 与 Codex 的文件写入沙箱边界核查

核查日期：2026-10-02。范围为一手源码与既有设计文档；未修改执行实现，未进行现场沙箱功能测试。Codex 源码研究委托后台研究 agent，结论由主 agent 结合源码复核、收敛。

## 固定版本

| 对象 | 检查点 |
| --- | --- |
| KodaX 当前 worktree，`codex/product-client-refactor` | `f9b0fb586aa9bc8af8ffa67160d2c9ec952779b9` |
| KodaX 主分支，`KodaX` | `cad8b658797976ce22a4bd70c60d2251d537e542`；本地主仓库与当日 token-auth `git ls-remote` 返回一致 |
| 本地 Codex，`C:/Works/PubProj/codex` | `a20fe6335f960a350483d0079db2ec281c68202c` |
| 既有研究引用的 Codex 检查点 | `968835997714baaff199cfed5f89a2c65d8ca77d`；本地对象可读，亦核对关键路径 |

## 已证实结论

1. **当前 worktree 的 `write` 与 KodaX 主分支保持同一执行边界。** 下列比较无差异：`packages/coding/src/tools/write.ts`、`packages/coding/src/tools/_internal/text-file-mutation.ts`、`src/windows-text-transaction.ts`、`src/trusted-text-approvals.ts`、`packages/coding/src/trusted-text-mutation.ts`，以及整个 `native/`。两分支 SDK Runtime 同样绑定可信文本 host，并在 Auto 精确调用获准后授予文本 approval。比较依据是上述固定提交之间的 `git diff origin/KodaX HEAD -- <paths>`，而非截图中的模型说明。
2. **KodaX 文本事务确实不接受 OS-token 沙箱执行。** 这是已发布的 ADR-066 决策，非本次统一契约面改造新引入的例外。[ADR-066](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/ADR.md:5640) 明确区分可信 Runtime 文本事务与 shell containment，并说明文本 mutation 不应描述成 OS-token sandbox enforcement。[文本 mutation 入口](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/tools/_internal/text-file-mutation.ts:191) 也明确执行于 trusted host。
3. **Codex 的通常沙箱写入路径与 KodaX 不同。** 自动批准的 `apply_patch` 仍设置 `bypass_sandbox: false`；Runtime 构建文件系统沙箱上下文，受限制的本地写入交给沙箱 helper 子进程。因此，“无需审批”和“不进入 OS 沙箱”是不同事实。[自动批准](C:/Works/PubProj/codex/codex-rs/core/src/apply_patch.rs:37)、[Runtime 上下文](C:/Works/PubProj/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:87)、[本地写入分派](C:/Works/PubProj/codex/codex-rs/exec-server/src/local_file_system.rs:103)、[helper 沙箱准备](C:/Works/PubProj/codex/codex-rs/exec-server/src/fs_sandbox.rs:145)。
4. **既有设计记录没有把 KodaX 文本事务声称为 Codex 文件写入机制。** FEATURE_295 明确记录文本工具参考 Claude Code 风格的可信边界，而 Windows shell/process sandbox 参考 Codex。[FEATURE_295](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.96.md:293)。这证明项目当时的参考意图，不独立证明 Claude Code 的实际实现。

## KodaX 的实际保护与限制

`write` 经 `withTextFileMutation` 请求 Runtime host 的 snapshot，再以 revision 执行 commit。Runtime host 对路径及授权 root 做检查，调用进程内 native primitive；它不启动文本 sandbox helper。[调用入口](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/tools/_internal/text-file-mutation.ts:198)、[snapshot / commit](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/windows-text-transaction.ts:408)。

这仍然是受控写入：原生边界重新验证资源身份，使用短时文件 slot 锁、CAS、flush 与原子替换；权限层保护 Git metadata 和 Runtime 控制路径。CAS 防止基于旧版本覆盖，原子替换避免部分写入；两者都不能替代 OS 对可写范围的强制隔离。[资源与事务约束](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/ADR.md:5685)、[内建路径策略](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/trusted-text-mutation.ts:62)。

不能把文本 root 检查概括为“永远只能写 workspace”：Full Access，或 Auto 对具体调用的批准，能够授权 root 外的精确目标。Auto 必须先消费已分类允许的具体调用，随后才授予对应文本 approval；snapshot 与 commit 会再次检验该批准。[root 授权](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/windows-text-transaction.ts:147)、[Auto 授权](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:19719)、[批准传入事务](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/windows-text-transaction.ts:416)。

后台 shell 不参加 KodaX 文本 slot 锁。Windows 有提交窗口的写入 reservation；Unix 的不合作 shell 在最后重读之后修改仍可能形成普通 OS race。不能声称这些锁串行化所有 shell 文件活动。[冲突契约](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/ADR.md:5719)。

## Codex 的关键执行链

在上述本地当前版本：

1. `prepare_apply_patch` 的安全判断即使 AutoApprove，也设置 `Skip { bypass_sandbox: false }`。[源码](C:/Works/PubProj/codex/codex-rs/core/src/apply_patch.rs:37)。
2. Runtime 在要求 sandbox 的 attempt 中构建 `FileSystemSandboxContext`，并把它传给 `apply_patch_with_options`。是否 sandbox 取决于实际 permission profile 与执行 attempt，不由“patch 已自动批准”单独决定。[上下文](C:/Works/PubProj/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:87)、[执行](C:/Works/PubProj/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:167)。
3. `LocalFileSystem` 根据 `should_write_into_sandbox` 选择 `SandboxedFileSystem`；受限制写入进入 `FileSystemSandboxRunner`。[分派](C:/Works/PubProj/codex/codex-rs/exec-server/src/local_file_system.rs:103)、[写入 helper 请求](C:/Works/PubProj/codex/codex-rs/exec-server/src/sandboxed_file_system.rs:169)。
4. Runner 为 `--codex-run-as-fs-helper` 构造独立子进程，将有效文件系统 policy 交给 `SandboxManager::for_file_system_helpers()`，再调用 `transform_for_direct_spawn`。选不出有效 sandbox 时返回 `filesystem sandbox cannot be enforced on this executor`，不在该分支静默改成宿主写入。[源码](C:/Works/PubProj/codex/codex-rs/exec-server/src/fs_sandbox.rs:145)。helper 内使用直接文件 API，并不意味着其进程不受 OS 沙箱限制。

既有研究引用点 `968835997714baaff199cfed5f89a2c65d8ca77d` 的 `git show` 也确认：`core/src/apply_patch.rs` 的 AutoApprove 设置 `bypass_sandbox: false`；`core/src/tools/runtimes/apply_patch.rs` 构建并传递 FS context；`exec-server/src/local_file_system.rs` 选择 sandboxed FS；`exec-server/src/fs_sandbox.rs` 启动并包装 FS helper。这是对该历史检查点的核验，不是对所有历史 Codex 版本的断言。

**例外：** 未要求 sandbox 的 attempt、Full Access 等无限制 permission profile 可以选择直接写入。以上关于 helper 的结论针对有限制的本地写入，不能扩展成“任何 Codex 写入都一定进 sandbox”。远程 executor 的实际隔离实现也不能仅由本地 helper 路径推出。[attempt 选择](C:/Works/PubProj/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:87)、[FS 分派](C:/Works/PubProj/codex/codex-rs/exec-server/src/local_file_system.rs:103)。

OpenAI 官方说明同样区分 sandbox 的技术边界与 approval policy；Full Access 移除文件系统和网络边界，普通 workspace-write 保留边界。[官方沙箱说明](https://learn.chatgpt.com/docs/sandboxing)。

## 设计判断与下一版边界

以下是建议，不是已实现的新承诺：

- 文本事务与长时间运行的 shell 生命周期解耦有合理的可靠性目的，尤其避免 shell setup / cleanup / owner 状态阻断文本操作。[既有问题](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/ADR.md:5644)。
- 解耦并不必然要求撤掉文本写入的 OS 隔离。Codex 的独立 FS helper 提供了另一种机制证据；是否采用它，还需验证 KodaX 现有 native CAS / atomic commit、性能与并发语义。
- 统一契约面首先要求唯一 Host 权限 authority；不同工具可以有不同执行边界，但边界必须明确。当前 v0.7.97 规格明确保留可信文本事务及其独立于 shell/broker 健康的属性。[当前规格](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:325)。
- 如果下一版产品承诺 Auto 下所有文件写入都受 OS 限制，需要单独修订 ADR-066，并考虑独立、短命的受限文件事务 worker，继续由 Host 裁决权限并保留原子提交和冲突保护。这应作为独立架构变更，而非同步主分支修复时隐式改变。

## 未证实与未解决问题

- 截图中的助手说明不能证明该会话每条 shell 命令的实际沙箱执行结果；本次确认的是源码设计与两分支一致性，未读取那次运行的原始执行记录。
- 未在当前机器现场测试 Codex helper 的 Windows token / ACL 效果，未对 Runtime/native binding 进行完整安全审计。
- 未验证受限 worker 能否以最小改动保留 KodaX 全部文本事务语义；此项需要独立设计与验证。
- 未推断其它历史 Codex 版本、远程 executor 或 Claude Code 的全部行为。
