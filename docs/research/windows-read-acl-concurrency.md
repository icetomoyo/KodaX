# 如何对标 Codex 的读取 ACL，同时保留 KodaX 现有无命令锁并发？

结论：在本次“保留现有 token、固定 capability 集合并发，不新增锁/串行/batch”的约束下，已确认可直接落地的是 Codex 的最终授权根排除和历史 SSH ACL 清理；没有找到可直接把 KodaX 普通读取根改成 RX、同时保证同根读写冷启动不互相覆盖的局部替换。不能把两者宣传为完整等价的 ACL 实现。

本地对标源码：`C:/Works/PubProj/codex`，commit `968835997714baaff199cfed5f89a2c65d8ca77d`。KodaX 所引行为基于原有 `stable_root_operations` / `apply_and_verify`，本轮仅调研，没有改产品源码。

## 核心差异

1. Codex 的 `apply_read_acls` 先检查 Users / Authenticated Users / Everyone、再检查 sandbox group 是否已有所需读取权限；满足就不写 ACL，缺少时才给 sandbox group 加 RX。read ACL helper 的入口传入 `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE` 和 OI/CI。[Codex setup_main/win.rs:210–279](C:/Works/PubProj/codex/codex-rs/windows-sandbox-rs/src/bin/setup_main/win.rs:210)、[同文件:612–632](C:/Works/PubProj/codex/codex-rs/windows-sandbox-rs/src/bin/setup_main/win.rs:612)

2. Codex 这条 helper 路径有 `acquire_read_acl_mutex()`，已有 helper 运行就跳过。这里只证明该读取 helper 有协调，**不推断它已串行所有 read/write ACL 路径或已证明不存在同根竞争**；因此不能把它当作可原样搬入 KodaX 的无锁并发证明。[Codex setup_main/win.rs:600–607](C:/Works/PubProj/codex/codex-rs/windows-sandbox-rs/src/bin/setup_main/win.rs:600)

3. KodaX 每个读/写/denyWrite 根都生成同一组四项 ACE：DenyWrite DENY、AllowRead RX、sandbox group Modify、AllowWrite Modify；变化的是进入受限 token 的 capability，非 ACL 集合。现有注释明确以此避免读写命令发布不同 DACL。[KodaX acl.rs:545–589、600–647](../../native/windows-sandbox-v2/src/acl.rs#L545)

4. KodaX 实际写入是读取旧 DACL、`SetEntriesInAclW` 构造新 DACL、`SetSecurityInfo` 提交，然后 read-back；ALLOW 使用 SET_ACCESS。Codex helper 的底层也先读 DACL，再构造并整体设置 DACL。[KodaX acl.rs:1112–1184](../../native/windows-sandbox-v2/src/acl.rs#L1112)、[Codex acl.rs:520–564](C:/Works/PubProj/codex/codex-rs/windows-sandbox-rs/src/acl.rs:520)

## 为什么 read=RX / write=Modify 不是安全的一行修改

从上述实现可构造如下并发交错，不依赖任何未公开 API 行为：读命令与写命令都获取尚无 sandbox ACE 的 DACL A；读命令生成 A+RX；写命令生成 A+Modify+write capability；写命令先提交并验证成功；读命令最后提交 A+RX。此时写命令已拿到 token，但普通 pass 的 Modify / restricting pass 的 write capability 可能被晚到的读 DACL 覆盖。读命令只验证自身 RX 会成功，无法发现另一命令被破坏。[KodaX apply_and_verify](../../native/windows-sandbox-v2/src/acl.rs#L1112)

把 SET_ACCESS 换成 GRANT_ACCESS 不解决上述交错：GRANT_ACCESS 只改变“把新信息合并进传入旧 ACL 内存”的方式，不是对文件对象原子追加一个 ACE。SET_ACCESS 还会替换同一 trustee 的既有访问控制，而 GRANT_ACCESS 会合并其权限；两者最终都需要另一步提交新 DACL。这里的问题不仅是相同 trustee 降权，也包括旧快照覆盖另一 writer 的其他 trustee。[Microsoft ACCESS_MODE](https://learn.microsoft.com/en-us/windows/win32/api/accctrl/ne-accctrl-access_mode)、[Microsoft SetEntriesInAclW](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setentriesinaclw)、[KodaX acl.rs:1152–1177](../../native/windows-sandbox-v2/src/acl.rs#L1152)

“先检查是否已有 Modify，有就不写 RX”只避开顺序 warm path；不能排除两个命令都在权限尚未安装时检查通过的 cold race。现有按 read-back 重试也不能证明解决：writer 的最后一次验证可早于 reader 的覆盖。以上是基于代码顺序的竞争分析，未声称已在本轮运行新竞态实验。[KodaX acl.rs:1117–1124、1179–1184](../../native/windows-sandbox-v2/src/acl.rs#L1117)

## 候选方案判定

| 候选 | 判定 | 依据及代价 |
|---|---|---|
| sandbox group 恒定 RX，write capability 提供普通 pass 写权 | 当前 token 不适用 | 当前 filesystem capability 只加入 restricting SIDs，不是普通 enabled group。普通 pass 不会凭该 restricting SID 自动取得写权；要另改 token 身份/组构造或普通授权主体。 |
| setup 只预装 RX，命令读取仅验证，写入临时升级 Modify | 不是现有行为的局部等价替换 | 尚未预装的动态 read roots 会变成不可读/要求 setup；setup 刷新与 write admission 同根还需协调，且现有 setup-owned 验证要求完整稳定集合。 |
| read 仅添加 RX；write 添加不同 SID 的 Modify | 仍有 DACL lost update | 不同 trustee 不能阻止两个 writer 各自基于旧快照提交整个 DACL。 |
| 仅在读取请求发现“原账号已可读”时跳过全部 stable ACL | 不能直接等价替换 | 当前 read-only policy 同时激活 DenyWrite capability；跳过其安装/验证还改变写约束。此前 token 探针已证明宽 SID 组合可写 Everyone:M 外部文件。 |
| 保留稳定集合，对标 Codex 排除机制与精确迁移 | 本轮可行且最小 | 保持原 token/并发模型，解决已知 SSH 路径被自动授权；必须明确其余普通 read 根仍可能得到 KodaX 固定 Modify 集合，不能称“所有读授权已改成 RX”。 |

第一项依据：[KodaX win.rs:521–570](../../native/windows-sandbox-v2/src/win.rs#L521)、[Microsoft CreateRestrictedToken：两次检查及仅添加 restricting SIDs 的参数](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)。CreateRestrictedToken 这里不会把新增 restricting SID 变成普通 enabled group。

第二项依据：[KodaX acl.rs:675–710](../../native/windows-sandbox-v2/src/acl.rs#L675)、[KodaX acl.rs:1884–1942](../../native/windows-sandbox-v2/src/acl.rs#L1884)。若能证明仅一次 setup 安装、所有读根永久不参与写授权且禁止后续扩展，才可能避免这类冲突；这些都不符合本次“不新增使用限制”的要求，故不推荐。

第四项依据：[KodaX acl.rs:644–646](../../native/windows-sandbox-v2/src/acl.rs#L644)、[之前真实 Windows token 探针](windows-sandbox-acl-design-alternatives.md)。普通读取 API 的存在与限制写的 capability 安装不是同一职责，跳过时必须分别证明。

最后一项依据：Codex 的 final read/write root 过滤在 ordinary 和 override roots 汇合后应用，含主目录展开、固定排除、SSH 配置依赖排除；KodaX 的同根固定集合已具备原有并发测试。[Codex setup.rs:655–671](C:/Works/PubProj/codex/codex-rs/windows-sandbox-rs/src/setup.rs:655)、[Codex setup.rs:1184–1236](C:/Works/PubProj/codex/codex-rs/windows-sandbox-rs/src/setup.rs:1184)、[KodaX acl.rs:2360、2399](../../native/windows-sandbox-v2/src/acl.rs#L2360)

## 建议的本轮边界

本次实现可对标“哪些路径不该被沙箱授予 ACL”，继续使用已经接受的 capability 并发机制；不要顺带改 token、SET_ACCESS 模式或 read/write 不同持久集合。验收除 SSH 新安装/迁移外，继续跑已有 `read_and_write_policies_share_one_persistent_root_acl` 与 `concurrent_read_and_write_policies_preserve_the_write_capability`，再补排除规则不会重新把敏感路径带回最终授权根的测试。[KodaX acl.rs:2360、2399](../../native/windows-sandbox-v2/src/acl.rs#L2360)

## 未解问题

- 本文没有证明所有可能的 lock-free ACL 算法都不可行；结论只针对当前 whole-DACL read/modify/write API、固定 token 和无新增协调/限制的最小改动。
- 普通 read 根改成真正按需 RX 若仍是独立需求，应单独设计 normal-pass 身份与 ACL publication 的并发合同，不能在本次 SSH 修复中假定已经获得。
- Codex 的 read mutex 不等于其所有写路径都受相同 mutex 保护；本轮没有全面审计上游并发正确性。
