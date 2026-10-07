# 文件文本事务是否应采用 Codex 式 OS 沙箱？

结论摘要：Codex 的受限文件执行器增加 OS 权限防线；KodaX 当前方案减少沙箱生命周期依赖，并已有明确的 CAS、原子提交与不确定结果契约。建议选择性采用受限执行器机制，保留现有事务语义；不把 Codex 的失败重试直接作为“安全无感回退”的保证。以下成本与方案均为源码评估，尚未实施或压测。

**2026-10-07 用户决定：暂不进行文本工具沙箱迁移，继续采用 ADR-066 的可信 Runtime 文本事务。** 用户认可 `write` 的输入与行为相对可控。下文保留为未选择方案的研究与成本参考，不作为当前统一契约面分支合回主分支的前置条件，不新增迁移实施票。

日期：2026-10-02。固定版本：KodaX worktree `f9b0fb586aa9bc8af8ffa67160d2c9ec952779b9`；Codex `a20fe6335f960a350483d0079db2ec281c68202c`。基础核查见 [执行边界比较](codex-file-write-sandbox-reference-2026-10-02.md)；Codex 回退细节见 [失败后回退事实](codex-fs-sandbox-fallback-2026-10-02.md)。

## 事实与优劣

| 维度 | KodaX 当前可信 Runtime 文本事务 | Codex 的受限文件执行机制 |
| --- | --- | --- |
| 可写范围执行边界 | Host 与 native 最终资源校验；不进入 OS-token 沙箱 | 有限制的 FS policy 通过沙箱 helper 在 OS 层执行 |
| 执行依赖 | 文本事务不依赖 shell setup、owner、cleanup、broker 健康 | 文本 I/O 依赖沙箱准备、helper 启动与通信 |
| 文件一致性 | 每个 canonical slot 有跨进程锁、revision CAS 与原子替换 | OS 沙箱本身不提供这些事务保证，不能以它替换 KodaX native 算法 |
| 故障可用性 | shell 沙箱不可用并不会触发文本降级，文本本来就走 host | helper 无通用宿主 fallback；上层补丁存在有条件的审批重试 |
| 运行开销 | 进程内 native 调用与文件 I/O | 另有进程启动、策略准备、请求传输；实际增量延迟未测 |

事实来源：[ADR-066](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/ADR.md:5654)、[KodaX host adapter](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/windows-text-transaction.ts:407)、[事务契约](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/types.ts:1875)、[Codex 写路由](C:/Works/PubProj/codex/codex-rs/exec-server/src/local_file_system.rs:103)、[helper 准备与启动](C:/Works/PubProj/codex/codex-rs/exec-server/src/fs_sandbox.rs:145)、[helper 子进程](C:/Works/PubProj/codex/codex-rs/exec-server/src/fs_sandbox.rs:520)。表中的延迟差异仅为机制推断，不是性能测量。

**安全收益的范围。** 有效 policy 正确且未允许降级时，OS enforcement 能在文件执行器发生路径解析/越界实现错误时增加独立的写入边界；也让 shell 与文件执行器采用一致的有效文件权限。它不能阻止已授权范围内的错误覆盖，也不隔离整个仍有宿主权限的 Host。若 Host 能任意发出更宽 policy 或无条件降级，此防线不能提供“所有写入始终在沙箱”的保证。这是基于执行边界的设计推断。[权限上下文](C:/Works/PubProj/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:87)、[官方 sandbox / approval 区分](https://learn.chatgpt.com/docs/sandboxing)。

**一致性不能退步。** KodaX 已明确返回 `written`、`stale`、`committed_uncertain`，其中后者要求保留回执、禁止盲目重试。Codex 补丁代码则明确承认写入失败可能已经截断目标，多文件逐 hunk 执行可以部分成功。因此应复用 KodaX 原有每文件事务，而不是改成简单 `fs.write` 或移植整套 patch replay。[KodaX 回执](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/windows-text-transaction.ts:355)、[现有不确定结果测试](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/tools/_internal/text-file-mutation.test.ts:120)、[Codex 写入副作用与逐 hunk 执行](C:/Works/PubProj/codex/codex-rs/apply-patch/src/lib.rs:489)。这不是声称 KodaX 当前具备跨多个文件的整批原子事务。

## 改动范围与成本判断

建议的最小边界为：仍由 Host 唯一授权，工具继续使用既有 snapshot / commit 端口；把受限目标 I/O 放入独立文件事务 worker，内部继续使用 native 的身份验证、CAS、原子替换与回执。Host 的权限、版本和回执事实保持权威。它不应成为新的 UI runner、RPC 执行服务或长期 shell workspace owner。[既有 Host 端口](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/types.ts:1896)、[v0.7.97 权限与文本边界](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:325)。这是待验证方案，不是已接受的 ADR 修订。

工程改动集中在五类接缝，而不是整个统一契约面重写：

1. Host 文本 adapter 的执行路由与精确权限范围。
2. 受限文件 worker 的启动、输入传输、退出确认与结果回执；进程失败必须与提交状态分开。
3. Windows SID / 锁 namespace / 文件 ACL 与 Unix UID / coordination root / 元数据保留的适配。
4. 有效文件 policy 的传递、native artifact 的受保护加载与三平台构建打包。
5. 跨两种路由的冲突、Undo、取消、崩溃、权限及性能验证。

来源接缝：[文本 adapter](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/windows-text-transaction.ts:407)、[当前 native 打包形态](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/Cargo.toml:8)、[Windows SID 边界](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/src/windows_transaction.rs:599)、[Unix 私有锁目录](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/src/unix_transaction.rs:753)、[Unix 元数据保留](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/src/unix_transaction.rs:1138)。

以熟悉此代码库的一名工程师集中工作估计，范围是累计人日，不是承诺排期：

| 交付范围 | 粗估投入 | 验收含义 |
| --- | --- | --- |
| Windows 机制验证 | 2–4 人日 | 证明受限 worker 能保留事务、同一 slot 协调、并行与未启动回退；不能据此宣布可发布 |
| Windows 可发布实现 | 10–20 人日 | 包含机制验证、精确授权、故障分类、混合路由、打包和回归 |
| Windows / Linux / macOS 全部可发布 | 20–40 人日 | 包含 Windows 范围，并在真实三平台验证 namespace、metadata、进程边界及性能 |

这是工程判断；不是从源码可得的事实。SID/UID 协调与 metadata 保留若必须重新拆解 native commit，或缺少真实平台环境，成本会增加。仅改善文档/执行边界显示的成本显著更低，但不会产生 OS enforcement 收益。

## 旧沙箱与并行问题为何可能回来

风险存在，但可避免的根因不是“只要有沙箱就必然串行”。

- **共享 shell 生命周期。** 原设计的 stdin、workspace owner、reset / cleanup 曾阻断文本工具；文件 worker 不能重新依赖长时间 shell 的存活或等待其退场。[旧问题](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/ADR.md:5644)。
- **锁分裂。** Windows 当前 namespace 根据进程当前 TokenUser SID 建立；若新 worker 改为专用沙箱账户，它与宿主 fallback 不会天然共用当前 private namespace。同文件两条路由若各锁一套，会破坏 CAS 保证。Unix 当前锁目录也检查 effective UID 与私有权限，必须核查沙箱中的 UID / mount 映射。此为源码支持的迁移风险，不是对尚未实现 worker 的现场结论。[Windows](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/src/windows_transaction.rs:669)、[Unix](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/src/unix_transaction.rs:753)。
- **元数据变化。** 改账户或 token 会影响新文件身份、临时文件权限及已有文件 ACL / flags / attributes 的保留，不能只检查内容相等。现有代码和测试已经处理这些语义。[Windows metadata](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/src/windows_transaction.rs:1068)、[Unix metadata](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/src/unix_transaction.rs:1138)、[Windows 旧低完整性文件测试](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/tests/transaction.rs:762)。
- **重复提交。** worker 完成写入后丢失响应，与根本未启动不同。自动改走宿主可能重复作用或覆盖并发修改；必须保留 unknown / committed_uncertain 的处理。[现有回执](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/types.ts:1887)、[v0.7.97 禁止猜测后重跑](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/docs/features/v0.7.97.md:333)。

## 能否快速、无弹窗回退

**先纠正现状：** 当前文本事务始终使用可信 host；shell 沙箱不可用时，它不需要先失败再回退。生产缺少可信文本 host 本身则报错，只有 test 有本地队列 fallback。[当前调用](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/tools/_internal/text-file-mutation.ts:191)。当前 shell 的宿主回退要求 Host 决定；Auto 可以使用 reviewer，Edits 可以请求权限，明确拒绝不被绕过。[Bash 回退入口](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/tools/bash.ts:564)、[Host 模式裁决](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:21515)。

拟议文本回退条件：无文件副作用的可信证明、worker 已结束而不会稍后继续写入，以及 Host 对该精确事务的既有授权确实覆盖宿主通道。没有覆盖时需要同一 Host 作权限决定，不能由客户端或工具私自补授权。这是方案要求；尚未实现。

| 失败事实 | 拟议行为 |
| --- | --- |
| 能力不可用 / 准备失败，事务未启动，Host 授权允许宿主通道 | 可直接采用当前可信文本事务，无需用户弹窗 |
| 明确的路径、受保护状态或权限政策拒绝 | 保留拒绝；不可借另一通道规避 |
| worker 已运行，但是否产生文件副作用未知 | 停止、重读/展示不确定事实；不自动宿主重试 |
| 明确已提交，但响应或 durability 不确定 | 保留回执及不确定结果；不重新提交 |
| CAS 冲突 | 返回 stale；不把冲突当作沙箱故障 |
| 用户取消 | 终止并确认停止；不因取消而降级再写 |

“优先沙箱、已授权时允许可信 host 兜底”可以在常见准备失败时做到无弹窗，但不等于“任何时候始终由 OS 沙箱强制限制”。无弹窗也不应隐藏实际执行边界，Host 需留下可查询事实。已有 Auto 若需额外 reviewer，仍可能有等待；启动/IPC 也有成本，所以“与当前同样快”需验证，不能从机制推断。[现有 Auto reviewer](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/src/sdk-runtime.ts:21562)、[官方边界定义](https://learn.chatgpt.com/docs/sandboxing)。

Codex 的 helper 没有通用直接宿主 fallback；`apply_patch` 的 `never` 禁止退出 sandbox 重试，`on-request` 可以请求审批后重试，且多文件可能已部分成功。这些细节不支持“复制 Codex 就获得安全无感回退”。[补丁 override](C:/Works/PubProj/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:134)、[重试判断](C:/Works/PubProj/codex/codex-rs/core/src/tools/orchestrator.rs:391)、[部分成功与未知效果](C:/Works/PubProj/codex/codex-rs/apply-patch/src/lib.rs:489)。

## 建议的验证门槛

以下是未来实施验收，不是本轮已通过的测试：

1. 两分钟后台 shell 运行时，文本工具与其它独立命令持续可用，不等待 shell owner / cleanup。
2. 同一 slot 的 sandbox / host 混合竞争仍只有一次 commit；不同 slot 不互等；跨 Host 同样成立。
3. worker 在准备、开始 mutation、原子替换、发送回执几个阶段退出或丢响应；只在可信未产生副作用的路径允许回退。
4. 策略拒绝、受保护路径、Undo stale、取消、metadata 保留和 native artifact 加载分别保持原语义。
5. 同机器、同文件负载比较当前方案与 worker 的冷/热调用 p50 / p95，以及连续大量小编辑的吞吐；不预设“快到用户无感”。

现有可复用基础：[跨进程 CAS](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/tests/transaction.rs:569)、[不同文件不互等](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/tests/transaction.rs:794)、[Unix 并发与死亡锁释放](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/native/windows-text-transaction/tests/unix_transaction.rs:256)、[Bash 未启动回退与取消测试](C:/Users/ADMIN/.codex/worktrees/a72f/KodaX/packages/coding/src/tools/bash.test.ts:781)。

## 未证实与未解问题

- 未实现 worker、未运行新的功能测试或性能测试；投入、性能、可用性及 metadata 风险均需机制验证校准。
- Windows 采用何种受限 token / 账户，以及怎样在 sandbox 与 host 路由间共用受保护 slot 协调，尚未选定。
- 产品要承诺强制文本 OS 沙箱，还是允许精确授权后的 host 兜底，尚未形成新的已接受决策。当前 ADR-066 与 v0.7.97 设计仍有效。
- 如何证明 IPC 失败前没有文件副作用、以及怎样保留已经提交但丢失响应的事实，尚需确定最小实现。
