# Windows 沙箱如何最小化修复 SSH ACL 污染？

> 方案状态更新：用户要求从设计上消除这一类问题，后续推荐已转向[分离读取策略与 ACL 修改范围](windows-sandbox-acl-design-alternatives.md)。本文关于 OpenSSH、NTFS 和事故机制的事实仍有效；下文仅排除 `.ssh`、展开整个 home 的建议保留为早期兼容性方案，不再作为最终架构建议。

结论：优先让 SSH 管理的路径不再接收沙箱 ACL，并在既有 setup 升级路径精确清除历史沙箱 ACE；把 Modify 改成 RX、仅删除沙箱组或追加 DENY 都不能同时解决 config 与私钥兼容性。依据见下文。

核查日期：2026-09-10。KodaX 源码基线：`7b1d1ffb8fa80729acf8eedd0e80b8f6a7c8ec33`。上游引用使用当日 `latestw_all` / `main` 分支，客户实际 OpenSSH 版本尚未获得。此次查阅源码和文档，并在自动删除的临时目录做 NTFS 继承实验；没有读取用户 SSH 内容、修改真实 SSH 权限或修改运行时代码。

## 已证实

1. **config 与私钥的要求不同。** Windows `read_config_file_depth` 调用权限检查时传 `read_ok=1`；私钥 `sshkey_perm_ok` 传 `0`。因此不可信主体的纯 RX 可以通过 config 检查，但不能通过私钥检查。[readconf.c:2471–2479](https://github.com/PowerShell/openssh-portable/blob/latestw_all/readconf.c#L2471-L2479)、[authfile.c:88–118](https://github.com/PowerShell/openssh-portable/blob/latestw_all/authfile.c#L88-L118)

2. **OpenSSH 看的是 ALLOW ACE，不会用 DENY 抵消一个不安全的 ALLOW。** 检查遍历 DACL，跳过非 `ACCESS_ALLOWED_ACE_TYPE`；受信任主体以外仅在 `read_ok` 且没有写类权限时放行，否则报错。写类包括写数据、追加、写属性、改 DACL、改 owner、删除；SID 无法解析也不是豁免条件。源码还认可当前用户的 SIDHistory 等价身份。[w32-sshfileperm.c:45–49、95–162](https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/w32-sshfileperm.c#L45-L162)

3. **KodaX 对读取根预装四项，而非仅 RX。** `stable_root_operations` 总是生成 DenyWrite DENY、AllowRead RX、sandbox group Modify、AllowWrite Modify；token 激活标志不决定是否安装这些 ACE。setup 合并读写根后调用该函数安装同一套权限。故删除 group 后仍可能残留 AllowWrite Modify；若要恢复私钥兼容性，还须移除 AllowRead RX。[acl.rs:545–589](../../native/windows-sandbox-v2/src/acl.rs#L545)、[acl.rs:675–710](../../native/windows-sandbox-v2/src/acl.rs#L675)，基线见页首。

4. **`.ssh` 默认进入 setup 根。** `windowsSandboxProfileReadRoots` 枚举用户主目录所有非符号链接顶层条目；setup 与 runtime read scopes 合并后授予 ACL。[sandbox-runtime.ts:4157–4168](../../src/sandbox-runtime.ts#L4157)

5. **WRITE_RESTRICTED 仅限制写访问。** Microsoft 定义为限制 SID 只参与写访问判定。KodaX 确实用此标志创建 token，并同时加入 account/logon/everyone 作为 restricting SID。由此不能把“从某次 command 的 allowRead 中移除 `.ssh`”当作拒绝读取；也不能声称删掉 AllowRead capability SID 就消除了来自普通组 ACL 的读取权限。[Microsoft CreateRestrictedToken：Flags](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken#parameters)、[win.rs:521–570](../../native/windows-sandbox-v2/src/win.rs#L521)

6. **修复应先找到继承源。** Microsoft 明确说明可继承 ACE 能传播到已有子目录/文件，从父对象删除后会自动移除子对象继承的副本；受保护 DACL 不继承。因此不能只按文件名删除 `.ssh/config` 上的继承项，也不应以重置全部 DACL 代替精确移除沙箱项。[Automatic Propagation of Inheritable ACEs](https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces)、[SE_DACL_PROTECTED](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-control)

## 同类上游方案

- Codex 已在 2026-04-19 合并同类修复：把精确等于 USERPROFILE 的根展开成直接子项，去掉主目录根本身，再对读根、写根统一应用敏感路径排除；说明了直接授予主目录权限会向下污染 SSH 路径。这支持“过滤授予路径，保留其余 ACL 架构”的方案。[Codex PR #18443：Bug / Change / Why this shape](https://github.com/openai/codex/pull/18443)
- 当日 Codex `setup.rs` 的固定名单包含 `.ssh`、`.tsh`、`.brev`、`.gnupg`、`.aws`、`.azure`、`.kube`、`.docker` 等；其测试覆盖 `.AWS` 大小写变化和 `.ssh/config` 子路径。该名单是 Codex 的策略选择，不代表这些产品全部有 OpenSSH 同样的 ACL 检查。[setup.rs:53 起](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/setup.rs#L53)、[setup.rs:2015 起](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/setup.rs#L2015)
- Codex 又补充 SSH 配置依赖扫描，处理 `IdentityFile ~/.keys/...`、`Include` 等位于 `.ssh` 外的路径；其范围是把依赖映射回主目录顶层条目并排除。说明“只排除 `.ssh`”不等于保护任意位置的 SSH 文件。[Codex PR #18493：Bug / Change](https://github.com/openai/codex/pull/18493)、[ssh_config_dependencies.rs](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/ssh_config_dependencies.rs)

上面两项 PR 均于 2026-04-19 合并；2026-09-10 检查的 `main` 仍含固定名单与依赖扫描。但不能把上游视作完整通用保护：`expand_user_profile_root_for` / `filter_user_profile_root` 只处理精确等于 USERPROFILE 的根，`is_user_profile_root_exclusion` 检查位于 USERPROFILE 下的顶层名；这些函数本身不会拒绝 `C:\Users` 或卷根等更高祖先。显式 read overrides 在 `build_payload_roots` 合并后仍经过相同过滤。[setup.rs:1120–1155、1200–1277](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/setup.rs#L1120-L1277)

在以上两个 PR 的说明及所查 setup 过滤函数中，没有发现恢复历史 SSH ACL 的逻辑；因此不能声称升级到它们就会自动清理旧权限。此次没有全面审计 Codex 的卸载/迁移子系统，该范围以外是否另有修复能力未证实。[PR #18443](https://github.com/openai/codex/pull/18443)、[PR #18493](https://github.com/openai/codex/pull/18493)、[setup.rs](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/setup.rs)

显式 write overrides 也会先 canonicalize，再执行同样的主目录展开、主目录排除、固定名单及 SSH 依赖过滤，没有因为用户指定额外写根就跳过这些规则。[setup.rs:619–635](https://github.com/openai/codex/blob/main/codex-rs/windows-sandbox-rs/src/setup.rs#L619-L635)

## 最小方案建议及其边界

以下为基于上述事实的工程判断，尚未实现或做 Windows 端到端验证。

1. **停止污染**：本次聚焦默认用户 `.ssh`，在最终 Windows 授权根处统一排除它及后代；覆盖 setup、runtime roots、workspace/write roots，防止只在目录枚举处过滤后被另一条路径重新带入。精确等于 USERPROFILE 的根复用现有顶层枚举，展开成现有子项并排除 `.ssh`；覆盖它的更高祖先不能直接授予可继承 ACL。显式要求访问 `.ssh` 的冲突应在 ACL 修改前说明不支持，而非静默赋权。比较需处理 Windows 大小写和规范路径，即使 `.ssh` 尚未创建也不能允许父根授权。暂不恢复整个历史敏感目录名单。依据：本项目根合并方式与上游 #18443；较高祖先拒绝是本项目方案补充。
2. **修好已有机器**：沿用 setup 的版本迁移能力，按可验证的 sandbox group / filesystem capability SID、目标路径与 ACE 类型和掩码清理旧授予；从原始继承源处理并验证后代结果，保留用户其他 ACL、owner 和继承配置。仅轮换账户或 capability nonce 不够，因为 OpenSSH 会检查残留未知 SID 的 ALLOW。依据：本项目四项 ACL 和 OpenSSH 不依赖 token 激活状态的 DACL 检查。
3. **不重写权限架构**：只把所有读根改成 RX 仍会破坏私钥；追加 DENY 仍会被 OpenSSH 拒绝。现有稳定 ACL 集合的注释还明确用于避免并发 read/write admissions 互相覆盖，因此不应为此问题全局更换 ACL 模型。[acl.rs:637–646](../../native/windows-sandbox-v2/src/acl.rs#L637)
4. **明确外部 SSH 文件边界**：若此次只修用户默认 `.ssh` 目录，应明确自定义 IdentityFile / Include 外部路径尚未覆盖。是否引入小型 SSH parser 应由真实使用场景决定；不建议在本次反馈下直接移植整个上游依赖扫描器。依据：上游 #18493 显示其确有额外职责和范围。
5. **必要验证**：用临时目录、临时 config、临时生成密钥复现；分别测 config 与私钥、旧 ACE 迁移后可用、重复 setup 不重新污染、来自父根的继承、大小写/路径规范化和普通工作区读写。验证模型必须直接观察真实 OpenSSH 与 NTFS 行为，不能仅证明过滤数组正确。依据：两种 OpenSSH 检查条件与 NTFS 传播语义。

## 本项目落地范围

这是推荐方案，尚未成为已实现行为：

- **两处实现范围**：共享的 Windows 授权根处理，以及现有提权 setup 中一次性的 SSH ACL 迁移；复用 setup 的版本、锁、账户空闲检查和读回校验。健康账户保留 SID 与 filesystem nonce，不通过轮换制造更多失去关联的旧 ACE。迁移前保留并校验旧 marker 信息，不能先覆盖旧授权依据。[现有 setup](../../src/sandbox-runtime.ts#L2445)、[capability SID 推导](../../native/windows-sandbox-v2/src/model.rs#L319)
- **清理边界**：默认事故路径是 `.ssh` 根上的显式沙箱 ACE 传播到子文件。按已知组 SID、旧 nonce 与规范根推导出的 capability SID，结合类型、掩码、继承标志精确移除，保持 owner 和无关条目。不扫描整个 home，不按 SID 前缀泛删，不执行全量 ACL reset。如果授权来自更高祖先、旧 nonce 丢失或条目归属不能确认，给出明确诊断进入定向修复；不能把正常路径的自动清理宣称为覆盖任意历史 ACL。[ACL 写入方式](../../native/windows-sandbox-v2/src/acl.rs#L1114)、[现有精确移除及校验模式](../../native/windows-sandbox-v2/src/acl.rs#L1190)
- **使用边界**：使用本机 SSH 凭据的命令沿用既有宿主执行授权；不新增凭据代理、私钥复制、SSH 配置解析器或自动重放。主目录展开只覆盖现有子项，不能保证沙箱可新建 home 顶层文件；有此需求时沿用宿主授权。已启动或结果不确定的命令不能自动重放。[宿主执行边界](../ADR.md#adr-069-sandbox-success-is-authority-while-host-escalation-is-a-separate-policy-boundary)
- **范围控制**：`.ssh` 外自定义 `IdentityFile` / `Include` 不纳入这次默认目录修复，也不承诺完整凭据隔离；有真实反馈再扩展。上述兼容性边界应在发布说明中说明，不能把默认目录修复表述为所有 SSH 布局已支持。

## 本地 NTFS 验证记录

2026-09-10，在 Windows 临时目录创建 `.ssh/config`，用四个仅用于实验的 SID 模拟组 Modify、AllowRead RX、AllowWrite Modify 与 DenyWrite。使用真实 `Set-Acl` / `Get-Acl` 验证继承，不接触真实账户目录，也不调用 sandbox setup。

观察结果：四项 ACE 均继承到 config；只移除组 ACE 后，AllowWrite 的写权限仍存在；从 `.ssh` 根精确清除四项后，config 的 SDDL 与实验前完全一致。探针返回：

```text
PASS: all four ACEs inherited; group-only removal leaves write capability; exact root cleanup restores child ACL baseline.
```

实验结束后已删除临时目录。此结果验证普通 NTFS 继承和清理策略，不是原生 helper 的端到端回归，也没有验证真实 OpenSSH 读取配置/私钥；实现时仍需执行前述验收。

## 未证实

- 客户 config 上实际的完整 DACL、ACE 是显式还是继承、是否还存在其他历史 capability SID，以及具体 OpenSSH 版本尚未获得，不能保证单条 icacls 命令恢复全部 SSH 使用场景。
- 本次未确认任何私钥曾被进程读取；代码上的授权可能性不能等同于已发生读取。
- 没有证据证明排除固定目录就能隔离所有凭据。WRITE_RESTRICTED 与既有账号权限意味着“停止添加沙箱 ACE”与“确保账号绝不可读”是不同保证。

## 未解问题

- 旧 generation 的 nonce / capability SID 是否完整可恢复、历史授权根是否完整可枚举，需结合 KodaX setup 状态文件迁移实现再确定；在没有依据时不能用 SID 前缀批量删除不相关 capability。
- 客户是否使用 `.ssh` 外的自定义私钥路径尚未知；若有，应单独评估，不能套用默认目录迁移后即宣布其场景恢复。
