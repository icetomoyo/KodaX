# Windows 沙箱怎样从设计上避免读取需求污染宿主 ACL？

## 最终实施范围：对标 Codex 的 ACL 排除规则

用户随后明确要求对标本地 Codex `968835997714baaff199cfed5f89a2c65d8ca77d`，保留工具可用性，不添加新的限制。本节取代下文“外部 ACL 完全不动”的前案；旧 token 探针只保留为历史证据。

- 普通 profile、Agent Home 和工具读取行为保留。使用 Codex 相同的 profile 排除名单，并跟踪 SSH `Include`、`IdentityFile` 等引用；USERPROFILE 本身展开后过滤，读根和写根均不能重新带入这些排除项。它们是“不安装 ACL”的例外，不是额外的 denyRead。没有新增全盘工作区外访问限制。[策略实现](../../src/windows-sandbox-read-policy.ts)
- Native admission 和提权 setup 均接收相同的排除范围，避免 denyWrite 经固定 ACL 集合重新引入授予。固定四项 ACE、token/Default DACL、WFP、IPC、Job 和并发路径保持现状；没有将 Codex 带读取 ACL mutex 的 RX 安装直接移植。本次不宣称所有读取根已改为 RX。[并发对比依据](windows-read-acl-concurrency.md)
- Setup generation 11 对 generation 10 执行一次精确迁移：按旧组 SID、filesystem nonce、规范目标路径和 ACE 类型/掩码/继承标志删除本产品条目。除旧 setup 根外，覆盖 `.ssh` 子文件和配置明确引用的文件；不读取私钥内容、不扫描整个 home、不跟随 junction。原 owner、其他权限与继承设置保留。[原生实现](../../native/windows-sandbox-v2/src/acl.rs)
- 真正清理前要求旧沙箱进程空闲；既有 generation 8/9 的活动账号协议升级行为保持不变。迁移待完成记录保留旧 roots、SID、nonce，失败重试不丢失身份，成功后才发布 ready marker。未知旧 nonce、已移动路径或来源不可确认的额外历史 ACL 不做猜测性泛删。[setup 实现](../../src/sandbox-runtime.ts)
- 独立账号不能读取私钥时继续使用已有宿主授权路径；未新增 SSH 专用代理、密钥副本、自动宿主升级、命令重放、锁、队列或 batch。

本地验证结果和仍需人工确认的边界见 [Issue 333 回归指南](../test-guides/ISSUE_333_v0.7.96_REGRESSION_GUIDE.md)。此实现尚未发布，也没有修改客户机器的真实 SSH ACL。

## 2026-09-10 用户确认后的修改方案（待实现）

用户已接受：保留独立低权限账号、网络隔离和工作区权限控制；工作区外的用户目录不修改 ACL，访问服从 Windows 原有权限，不承诺阻止写入原本就向该账号开放写权限的外部目录。因此，下文“必须先解决全盘写隔离与 token 兼容性的冲突”不再是本次修复的前置条件；探针事实仍保留，现有 token 组合不变。本节优先于后面的历史方案讨论。Issue 333 仍未修复。

### 修改边界

1. **区分访问路径与可修改 ACL 的目录。** 可管理范围限于明确选定的工作区，以及 KodaX 自有、实际必需的运行、控制与命令临时目录。KodaX 配置目录不能整体视为可开放给子进程的运行目录。后者不因物理位置在工作区外就变成任意用户目录授权；控制目录仍保持原有更严格的访问规则。
2. **外部路径只使用既有权限。** profile 顶层枚举、PATH、工具发现、外部 read/write/denyWrite 请求都不能扩大 ACL 管理范围。明确的外部写请求也不会自动把路径认领为工作区；可用权限由 Windows 决定。外部 denyWrite 不再被表述为系统已强制实现的限制。涉及 KodaX 控制状态的必要保护继续保留，不能随普通外部目录一并忽略。
3. **保留运行机制。** 保留 srt-sandbox 身份、现有 restricting SID 组合、Default DACL、WFP、Job、IPC 和独立命令生命周期。可管理目录继续使用稳定 ACL 集合及命令 token 选择权限，不恢复每命令 grant/revoke，不增加全局锁、串行队列、batch 调度或策略开关。

### 实现切面

- TypeScript 构造策略时停止把整个用户 profile / 外部 PATH 作为安装 ACL 的来源；运行依赖发现可继续存在，但只表示依赖，不表示授权。复用已有工作区与自有目录上下文向 native 提供明确的管理范围；仅在现有请求无法表达该边界时增加一个内部字段，按既有版本校验升级，不建立新的权限服务。
- Native 在 setup 和普通 admission 的实际 ACL 操作入口执行相同范围约束，禁止 allowRead / allowWrite / denyWrite 合并后绕过边界。已有 runner/control 专用授权同样核对目标归属，保持它们各自原有权限强度。范围外不安装 ALLOW 或 DENY，也不验证旧稳定 ACE 必须存在。
- 沿用规范路径和重解析点检查，防止祖先授权或链接把管理范围扩展到外部。用户 profile 根、磁盘根以及包含宿主 `.ssh` 的祖先不能作为递归授权根；不恢复“展开整个 home 后排除少数名称”的策略。普通工作区内用户主动放置的任意私钥仍不保证兼容严格 ACL 检查，此限制应说明。
- 外部文件不可读时报告真实权限错误；尤其验证用户目录下的 Node/npm、Git、Python 以及 linked worktree 的外部 Git 元数据。沿用既有宿主执行授权流程，不自动升级、不自动重放、不复制凭据，也不新增工具链镜像系统。

### 历史授权迁移

- 在既有 setup 版本迁移中执行一次，复用 setup 协调和账号空闲检查；普通命令与暖路径不做清理。健康账号及 filesystem nonce 尽量复用；读取、校验旧 marker 后才发布新 marker。
- 以旧 setupReadRoots、已知账号/组 SID、旧 filesystem nonce 和可验证的旧目标路径为依据，精确清除范围外的本产品 ACE，包括组 Modify、AllowRead、AllowWrite、DenyWrite；仅删除组不足以恢复私钥检查。
- 从已确认的继承源移除并读回验证，保留 owner、用户原有 ACE、继承设置。迁移需要一次性修改历史受影响的外部 ACL，这是恢复原状的例外；后续 setup 不再重加。
- 旧普通命令动态授予的路径不保证全部记录在 setup marker 内。无来源记录、旧 nonce 丢失、路径移动等无法证明归属的情况，返回具体诊断并保留未完成状态；不扫描全盘、不按 SID 前缀泛删、不全量重置 ACL。不能把默认 `.ssh` 自动修复宣称为任意历史授权都已清理。

### 验收与落地顺序

1. 先把已保留的原生外部 ACL 不变性复现转为正式回归测试；补 setup、PATH、外部 write/denyWrite、祖先/链接边界。比较 owner、完整 DACL 和控制位，失败路径也不得留下修改。
2. 实现管理范围边界，再实现旧版本精确迁移；用临时 SSH config 和临时私钥验证真实 OpenSSH，重复 setup / 重启不重新污染。迁移重复执行应幂等，无关 ACE 和用户 owner 保持不变。
3. 在真实独立账号链路验证 CMD、PowerShell 管道、Node 子进程/管道、Git 和 linked worktree；验证网络限制、退出/取消/超时清理、同根并发读写与暖路径无 ACL 写入。原有 83 项原生测试及受影响 TypeScript 检查必须通过，不通过则不发布。
4. 外部 Everyone 可写样例允许按 Windows 原权限写入，作为已接受边界的行为测试；外部私有不可访问样例仍应被 Windows 拒绝。测试不再要求 token 实现全盘路径白名单。
5. 更新 ADR-069/070、HLD、用户说明、Issue 333 和回归指南，明确新边界、私有工具/SSH 凭据的兼容性影响与历史迁移限制。实测通过后才标记问题已修复。

本次只确定方案，没有改动生产实现。其他同时进行中的工作区改动不属于本方案。

结论：优先选择 A 的职责边界——读取意图绝不自动产生修改外部 ACL 的授权，保留独立账号和稳定 capability 机制；但当前 token 对 account/logon/everyone 的兼容放行需要重新验证，不能把“停止落外部 ACL”直接宣称为完整写隔离。B 能避免为读取而扩权，却不是零宿主 ACL 改动方案，并且牵动 ASRT 网络身份和宿主进程隔离。

日期：2026-09-10。本地基线 `7b1d1ffb8fa80729acf8eedd0e80b8f6a7c8ec33`，ASRT `0.0.65`。本文是只读源码与 Microsoft 文档可行性分析；没有实现 A/B，没有运行它们的端到端测试。以下工程建议以已列源码事实为依据，未证明之处明确列出。

## 共同事实

- Windows WRITE_RESTRICTED 的 restricting SID 只参与写权限检查；写操作要同时通过普通 SID 与 restricting SID 两次检查。它不是文件路径 allowlist，也不会因为某个路径没写进请求就阻止进程尝试打开它。[CreateRestrictedToken：Flags / Remarks](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)、[CreateFile：lpFileName / dwDesiredAccess](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- 当前 KodaX 把 allowRead、allowWrite、denyWrite 三类路径合并；每类路径都产生完整四项稳定 ACE，包含 sandbox group Modify、AllowWrite Modify。**仅 denyWrite 的外部路径同样会获得 ALLOW 扩权，删除 profile read 枚举并不能堵住全部入口。**[acl.rs:545–589、600–647](../../native/windows-sandbox-v2/src/acl.rs#L545)
- setup 把 read/write roots 合并后落稳定 ACL；普通命令把非 setup-owned 的操作归入 mutable，缺少 ACE 时会直接 apply。因此新的 ACL 管理边界必须同时约束 setup 与 native admission，而不能只改 TS 的一份读根数组。[acl.rs:675–710](../../native/windows-sandbox-v2/src/acl.rs#L675)、[acl.rs:1884–1942](../../native/windows-sandbox-v2/src/acl.rs#L1884)
- 当前稳定集合旨在让同一 canonical root 的并发 read/write 请求不会互相覆盖 DACL，命令通过 token 选择 capability。[acl.rs:637–646](../../native/windows-sandbox-v2/src/acl.rs#L637) 因而修复可以收紧“哪些根有资格安装集合”，无需恢复每命令锁、串行化或 batch；但这条注释本身不构成所有并发竞争均已证明安全的结论。

## A：保留独立账号，分离读取意图与 ACL 管理范围

### 建议的硬边界

工程判断：只有 KodaX 自有运行目录和明确接纳为可管理范围的工作区，才允许安装稳定 ACL。任意 profile 条目、外部 allowRead、PATH/工具链发现、外部 denyWrite 都不应自动扩大这个范围。这把问题从永远追补 `.ssh` / `.keys` 名单，变成单一可核对的不变量。依据是上述三个入口都在为路径追加 ALLOW。

“工作区”必须是明确而合适的边界，不是把 USERPROFILE 展开成所有现有子目录后自动认领；否则任意 `.keys`、外部凭据目录仍然会因被当作工作区遭到修改。祖先重叠、路径别名和 reparse 需沿用 canonical/handle 检查约束；固定 `.ssh` 排除只能补充防误操作。[前次同类问题事实笔记](windows-ssh-acl-primary-sources.md)、[acl.rs:1889–1890](../../native/windows-sandbox-v2/src/acl.rs#L1889)

工程判断：外部读取只能依赖账号已有可用权限，失败要解释具体不可访问路径；不得悄悄修改 ACL 或升级 FullAccess。私有工具链/缓存确需使用时，可准备到已经批准的 KodaX 运行目录，但是否能直接复制、依赖哪些相邻资源不能凭路径一概决定。独立账号没有宿主私有 SID，WRITE_RESTRICTED 不会替它创造普通读权限。[CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)、[win.rs:537–570](../../native/windows-sandbox-v2/src/win.rs#L537)

### 不能跳过的写隔离约束

当前 `policy_restrictions` 把 capability、account、logon、everyone 都加入 restricting SIDs；注释说明 read-only roots 依靠 stable DenyWrite 补偿。只删除外部 DenyWrite 操作而不重新验证 token 行为，会改变隔离效果。[win.rs:521–570](../../native/windows-sandbox-v2/src/win.rs#L521)

由 Windows 两次检查规则推导：如果某个外部文件已有 `Everyone: Modify`，或同时适合普通与受限检查的 sandbox account/logon 写 ALLOW，且没有有效 DENY，当前 token 的两次写检查可能都通过。不能把“外部 read root 只做读取验证”当作只读保证。对于需要保证不可写的已知外部路径，至少应基于真实 token 和完整 DACL 验证所需写类权限失败；不满足时拒绝该 sandbox policy，不能为了补偿而向外部写 DENY。[Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)、[win.rs:521–570](../../native/windows-sandbox-v2/src/win.rs#L521)

**局部检查也不是全局证明。** 进程能够尝试访问未声明路径；只检查 allowRead 中列出的根无法证明全盘不存在上述 account/everyone 可写对象，也不能保证子对象、运行中新建路径或 ACL 变化同样不可写。要声称“所有非工作区路径绝不可写”，必须验证 token 本身是否能移除这些用于兼容的宽 SID 而保持 loader/IPC 运行，或有其他已经存在且足够的系统边界。本文没有证明这个条件成立；它是 A 的完整写隔离设计门槛。[CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)、[win.rs:558–570](../../native/windows-sandbox-v2/src/win.rs#L558)

因此 A 已能明确根除“读取需求触发外部 ACL 扩权”的设计错误；A 是否同时保持现有全部运行兼容性和完整写边界，还需 token 级实验，不能仅按过滤数组改动就宣布完成。

## B：使用宿主用户的 WRITE_RESTRICTED token

### 可以解决什么

由 WRITE_RESTRICTED 语义推导，在保持宿主用于读取的普通 SID 且不删除所需权限的前提下，读访问可以使用宿主已有权限，不需要为每个 private read/PATH 根添加 sandbox group ACE。Windows 也允许普通应用从自己的 primary token 派生 restricted token 并启动子进程。[CreateRestrictedToken：Flags / Remarks](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)

但这也意味着宿主可读凭据不会仅因换成 WRITE_RESTRICTED 而不可读；这是读取策略选择，不是自动获得更强的凭据隔离。[同一 API 的 WRITE_RESTRICTED 定义](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken#parameters)

### 为什么不能声称零宿主 ACL 改动

若要在普通文件系统上选择性允许工作区写入，restricting pass 必须有能匹配目标 DACL 的 SID。宿主现有 user ALLOW 只能解决普通 pass；加入独立 write capability 时，工作区通常仍需要相应 ALLOW ACE。除非既有 DACL 恰好满足受限 pass、或另有文件系统重定向/代理架构，否则更换用户身份不会凭空实现路径级选择性写权限。[Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)、[现有 capability ACL 实现 acl.rs:545–589](../../native/windows-sandbox-v2/src/acl.rs#L545)

也不能沿用当前 account SID 的兼容放行：把宿主 user SID 放进 restricting list，会让普通宿主文件上的 user 写 ALLOW 同时满足第二遍检查，破坏“只有工作区可写”的意图。同理须重新分析 logon/everyone，不能只修改 `current_token` 来源。[win.rs:521–570](../../native/windows-sandbox-v2/src/win.rs#L521)、[Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)

### 新对象 Default DACL 的区别

当前 KodaX 会给派生 token 的 Default DACL 设置 logon/everyone/policy capability 三个 GENERIC_ALL ACE；这是 token 的默认值修改，**不会由这个调用立即重写已有用户文件**。[win.rs:317–355](../../native/windows-sandbox-v2/src/win.rs#L317)、[win.rs:584–610](../../native/windows-sandbox-v2/src/win.rs#L584)、[Microsoft TokenDefaultDacl](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)

但新对象可使用显式描述符、继承权限或 token 默认安全信息，因此不能断言“所有新文件都只用原来的 owner ACL”，也不能断言“所有新文件一定被 Default DACL 污染”。必须区分文件/目录、无父级的 IPC 对象、显式受保护 DACL、原子替换与继承路径。[Security Descriptors for New Objects](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptors-for-new-objects)

上游 Codex 对限制 token 同样设置 permissive Default DACL，源码注释解释目的是 PowerShell 管道/IPC 的 ACCESS_DENIED 兼容问题；其 dedicated-account 入口与不加 user SID 的入口分开。这只能证明有此兼容性需求及实现先例，不能证明把 KodaX 改成宿主身份后无需复验。[Codex token.rs:49–101、383–475](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/token.rs#L49-L101)

是否影响宿主应用要分情况：若只改变派生 token，宿主进程 token 不随之改变；但新增工作区 ACE 或沙箱创建/替换的文件 ACL 仍可被 SSH 等宿主程序检查并拒绝。宿主同用户身份也扩大了需复验的进程/IPC 交互面；Microsoft 建议 restricted application 使用独立 desktop。[CreateRestrictedToken：Remarks](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken#remarks)、[SSH 权限检查事实](windows-ssh-acl-primary-sources.md)

## ASRT / 网络身份耦合与工程代价

本地 ASRT `0.0.65` 的 Windows 模块明确说明：创建独立 `srt-sandbox` 用户，WFP 规则按该用户 SID 生效，broker 经 `CreateProcessWithLogonW` 再启动受限子进程；宿主网络不受影响依赖身份不同。源码还把独立身份作为阻止借宿主进程/任务代理启动的一部分设计理由。[本地已安装 ASRT windows-sandbox-utils.js:16–30、455–463](../../node_modules/.pnpm/@anthropic-ai+sandbox-runtime@0.0.65/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js#L16)

KodaX 当前禁用 ASRT filesystem，只保留网络配置；broker 请求仍验证 expected sandbox user/group SID，native runner 在这个账号上下文中派生 token。因此 A 能保留这条链路；B 则须调整启动、身份校验、control/desktop/IPC 安全和网络约束，不能只替换一个 token 参数。[windows-sandbox-v2.ts:85–102](../../src/windows-sandbox-v2.ts#L85)、[sandbox-runtime.ts:5767–5799](../../src/sandbox-runtime.ts#L5767)、[runner.rs:277–280](../../native/windows-sandbox-v2/src/runner.rs#L277)

Microsoft 的 WFP `ALE_USER_ID` 表示本地用户身份。推论：仍按宿主 user SID 绑定网络规则将无法仅凭此字段区分沙箱与普通宿主进程；仅按原 srt-sandbox SID 保留规则又不会自动覆盖宿主身份子进程。B 需要单独设计并验证网络身份区分，不能退化成同时限制宿主网络，也不能丢弃网络隔离。[WFP filtering condition identifiers：FWPM_CONDITION_ALE_USER_ID](https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers-)

## 不引入命令锁、串行或 batch 的可行收敛

推荐工程顺序：先定义 ACL 管理域不变量，在临时目录与真实子进程中验证 A 的 token 兼容 SID 和工作区外写能力，再实施外部 read/PATH/denyWrite 安装职责的移除；对已获准管理的有限根继续使用同一份稳定 capability 集合，保留现有幂等准入和暖路径只读检查，每条命令由独立 token 选择能力。历史 ACL 清理沿升级迁移执行一次且精确证明归属。这里没有必要恢复每次命令的 grant/revoke transaction。[acl.rs:637–646](../../native/windows-sandbox-v2/src/acl.rs#L637)、[历史清理约束](windows-ssh-acl-primary-sources.md)

### 本项目建议落实为三个规则

1. **读取策略不能扩大 ACL 管理范围。** 用户 profile、PATH、外部 read/denyWrite 条目不会自动成为可修改 ACL 的根。可管理范围由可信的工作区上下文及 KodaX 自有目录推导，不增加用户配置开关；原生 ACL 修改入口统一检查它，setup 同样受约束。不能用“任意 allowWrite 就算工作区”偷换这个边界。
2. **受管理根维持固定 ACL 集合，权限差异放在命令 token 中。** 不因一个只读命令到来而降级正在写入的命令，不在命令结束时恢复整个旧 DACL。每条命令继续有自己的 request、token、Job 和生命周期；不新增全局锁、命令队列、batch 调度或并发关闭开关。setup 锁仍只协调 setup。[ADR-070](../ADR.md#adr-070-windows-sandbox-coordination-is-setup-scoped-or-capability-scoped)
3. **无法满足的策略明确拒绝。** 账号读不到某个外部私有工具/凭据，或无法在不改外部 ACL 的前提下满足写限制时，不扩权、不静默忽略限制、不自动切 FullAccess。沿用既有明确的宿主执行授权；已启动或结果不确定的命令不自动重放。[ADR-069](../ADR.md#adr-069-sandbox-success-is-authority-while-host-escalation-is-a-separate-policy-boundary)

这会调整 ADR-069/070 中“setup 预装整个 profile 的读能力”的现有行为。它是本次推荐的设计修订方向，尚未作为已验证、已接受的 ADR 写入正式架构记录。独立账号模型下，透明读取任意宿主私有文件、完全不改外部 ACL、保持现有所有运行兼容性，不能未经验证同时承诺。

### 验证门槛与当前基线

实现验收至少覆盖：外部 `.ssh` 和任意命名目录的 owner/DACL 在 setup、读取、PATH 发现及重复命令前后不变；已声明和未声明的外部可写对象、不同写权限类型的真实 token 访问；PowerShell/Node/Git 的加载和 IPC；旧授权的精确迁移；同根并发读写互不撤权，暖路径不写 ACL。外部不可变性必须在原生边界验证，不能只断言 TS 路径数组。

2026-09-10 已运行现有基线：

```text
cargo test --offline --manifest-path native/windows-sandbox-v2/Cargo.toml read_and_write_policies -- --nocapture
read_and_write_policies_share_one_persistent_root_acl ... ok
concurrent_read_and_write_policies_preserve_the_write_capability ... ok
test result: ok. 2 passed; 0 failed
```

这是当前稳定 ACL/并发准入机制的基线，通过不代表 A 已实现或全局写隔离已获证明。两个测试需作为设计修订中的保留项，而非被新增锁或串行路径绕开。

工程边界：工作区仍会有 ACL 改动，不能宣传“完全不改宿主权限”；任意位置密钥若用户把其所在目录明确当作可管理工作区，依然可能遇到严格权限检查。若产品要求连显式工作区内的任意文件都绝不变 ACL，则 A/B 这两种基于直接文件系统 capability 授权的路线均未满足，需要新的执行/文件视图架构，不应混入此次最小设计修复。

## 未证实与未解问题

- 尚未证明 A 在移除所有外部 ACL 操作后能同时通过真实 PowerShell/Node/Git 的运行兼容性和全局写边界验证。已知外部根只读检查不足以解决未声明路径；这个门槛必须先解决或明确限制产品保证。
- 尚未验证移除 restricting account/logon/everyone 中哪些 SID 后能保留所需 loader/IPC 兼容性；不能从官方 API 语义直接推导可用 token 配方。
- B 的 WFP 替代网络身份、同用户进程/COM/任务交互、新文件/default DACL 方案尚未设计和验证。因此不推荐本次草率切换 B。
- 两方案都需要处理之前已经落在外部路径的历史 ACE；无法证明 nonce / SID / 路径归属时应报告诊断，不得按 SID 前缀泛删。

## 实现前真实 Windows token 探针结果

在用户授权谨慎实现之后，运行了独立诊断，不改产品源码或既有用户 ACL。可复现入口为 [windows-token-probe.ps1](windows-token-probe.ps1)，P/Invoke 实现在 [windows-token-probe.cs](windows-token-probe.cs)。从项目目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs/research/windows-token-probe.ps1
```

前提是从未受限的宿主 token 执行。第一次在 Codex 默认工具沙箱执行时，基 token 已有 Codex restricting SIDs，创建对照 token 失败；随后经工具许可在沙箱外执行，基 token 的 restricting SID 列表为空。探针现在主动拒绝已受限基 token，避免把两个沙箱叠加误当成 KodaX 实验。

所有组都使用 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`，同一个唯一 capability SID，Default DACL 保留 logon/everyone/capability GA，并创建 ACL 包含宿主与 capability 的独立 desktop。只改变 restricting SIDs。目标文件是新建于 `docs/research/.token-probe-<随机值>/outside.txt` 的临时文件，唯一测试性 ACL 改动是给此文件 Everyone Modify；它未授予测试 capability。真实用户目录、账号、setup/WFP 未修改。

| Restricting SIDs | CMD 启动 | Windows PowerShell 管道 | Node 启动 | Node 子进程与管道 | 外部 Everyone:M 文件写入 |
|---|---|---|---|---|---|
| capability + account + logon + everyone（当前组合） | 37，通过 | 37，通过 | 37，通过 | 37，通过 | 42，成功写入 |
| capability only | 37，通过 | `0xffff0000`，失败 | 37，通过 | 15 秒超时并终止 | 41，EACCES/EPERM |
| capability + logon | 37，通过 | `0xffff0000`，失败 | 37，通过 | 15 秒超时并终止 | 41，EACCES/EPERM |
| capability + everyone | 37，通过 | 37，通过 | 37，通过 | 1，失败 | 42，成功写入 |
| capability + account | 37，通过 | `0xffff0000`，失败 | 37，通过 | 15 秒超时并终止 | 41，EACCES/EPERM |

退出码是探针约定：37 表示完成指定任务；外部文件测试以 41 表示捕获 EACCES/EPERM，42 表示写入成功，43 表示其他异常。PowerShell 任务是 `1,2 | ForEach-Object { $_ * 2 }` 并验证结果；Node IPC 任务使用 `child_process.spawn` 的默认管道并等待子 Node 退出。超时以探针码 `0xdead` 标识，不能解释为目标自身退出码。来源：本次实际执行的上述探针输出；没有把模型推断算作运行结果。

这轮结果提供两个决定性证据：**当前宽 SID 组合确实允许对已有 Everyone:M 外部文件写入；capability only 和 capability+logon 均不能直接保持当前 PowerShell/Node 子进程兼容性。** 因而不能简单删除宽 SID 后立即接通生产路径；A 的 token 可行性门槛尚未通过。这轮没有出现 `0xc0000142`，不能用既往 DLL 初始化失败码替代本次观察。

实验限制：使用真实宿主未受限基 token，而非 `srt-sandbox` 账号；没有创建/切换账号，没有 ASRT/WFP、生产控制管道或生产 handle-list 链路。初次探针没有 Job；随后为清理超时子进程加入仅用于诊断的 kill-on-close Job，在进程 suspended 时加入 Job 再 resume，复验全部五组，结果与上表一致。它仍不是完整生产启动路径。PS/Node 失败的 stderr 未重定向捕获，故本轮不归因于某个具体 DLL/对象。此结果能否定“这种简单 token 替换已可直接部署”，不能证明整个后端或所有 token 配方都不可行。

清理证据：探针 finally 关闭每个测试的 Job（终止后代），删除唯一随机临时目录并关闭 token/desktop/process handles。首次无 Job 实验完成后用宿主权限检查精确诊断 Node 命令行及 `.token-probe-*`，均无残留。仅保留可复现探针源码及本文结果。没有读取或修改真实 SSH 内容。

## 早期诊断阶段状态（历史，已被上面的实现取代）

Issue 333 仍为 Open，根治尚未完成。生产 ACL、token、setup、并发与调度路径均未修改。新增的原生外部读取不变性测试已实际跑出 RED；当前以显式 `#[ignore]` 保留为 opt-in 复现，不能计作修复通过。在未受限宿主上原有 83 项原生测试全部通过；默认工具沙箱中的 token 创建失败是嵌套受限令牌环境差异，不是本次生产回归。详见 [Issue 333 复现指南](../test-guides/ISSUE_333_v0.7.96_REGRESSION_GUIDE.md)。

## Standards 评审

独立评审最初发现诊断测试可能把 admission 的无关错误当作不变性通过，以及探针 Run 函数职责过大。已改为清理后检查 admission 成功，并拆分 desktop 创建与测试用例定义。复核无遗留规范问题。Standards：0 项遗留 finding。

## Spec 评审

独立评审要求测试比较完整 owner/DACL 与控制位，而不只是普通 ACE 列表；并指出 Job 清理加入后实验边界说明需同步。已补完整 SDDL/control 快照及准确的初次/复验说明，复核无遗留诊断误导。Spec：0 项遗留 finding。此评审对象是诊断材料，不代表尚未实现的生产修复通过验收。
