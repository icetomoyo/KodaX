# 统一契约面复核

日期：2026-09-26。审计代码：`6e5d62986ec92a18875489de43c367b4bbffff95`；主线固定比较点：`c447c0f3c1fe48854a1288225dd4514d0d65b827`。本次没有修改生产代码，也没有合并新的主线提交。

后续修复及验证见[修复验收](contract-browse-fix-verification-2026-09-26.md)。本文保留修复前的审计结论与反例。

## 结论

目前不能确认“统一契约实现没有问题”。已经复现三个公共历史读取缺陷、一个 Host 创建会话失败后的 MCP 资源释放缺陷，以及一个工作流实际权限与显示默认值不一致的缺陷。它们与已确认的普通 TUI 历史裁剪回归相互独立；仅修滚轮消费层不能解决公共读取缺陷。

这些反例没有证明必须引入全局事件日志或通用状态机。它们首先需要兑现现有契约：正确拼接原文、分页不静默丢项、按已有身份回源、失败释放已取得的资源。但现有历史 cursor 会因追加过期，不能据此保证持续并发写入期间的任意旧快照分页永远成功。

## 事实与能力分层

| 面 | 当前职责 / 保证 | 本轮判断 |
| --- | --- | --- |
| `/client` 连接、启动、断开 | 同一个 Host 执行；connect 被动，ensure 显式启动；断开不停止共享工作 | 已读实现；公共 SDK 生命周期回归通过；没有重新执行完整启动器矩阵 |
| `inputs` / `runs` / Session Stop | inputId 接收去重、排队与撤回；真实终态；请求停止与清理确认分开 | 公共 SDK 定向回归验证；不能由文本存在推断成功 |
| `observe` / `readItem` | 最近有界视图完整替换；按身份补读正文 | 正常流式、输出提交、工具原文已有通过用例；发现用户项离窗补读缺陷 F03 |
| `readHistory` / `readHistoryEntry` / `searchHistory` | canonical 历史分页、完整内容补读、全 Session 搜索 | 发现 F01/F02；不是 TUI 专有问题 |
| `interactions` | 验证后消费、首个有效答案生效、完整计划正文 | 真实 IPC 双端竞争、无效答案、拒绝/取消/Stop 回归通过 |
| settings / config / catalog | Host 有效配置、Session 覆盖、条件更新及显式探测 | 已读适配；实际模型/effort、清除覆盖、目录与跨客户端回归通过；不宣称所有 Provider 在线行为均验证 |
| MCP / Session 创建 | Host 管理连接；每 Session 资源取得与释放 | 正常重载和双 Session 隔离回归通过；故障注入发现 F04 |
| commands / review / compact / memory / learning / workflows | Host 领域操作和各自的订阅、revision、结果 | 现有公共 SDK 领域测试通过；新增审计发现 F05 工作流隐式权限默认与显示不一致 |
| lineage / fork / rewind | 明确边界及冲突，不能把旧页拼到新分支 | 定向回归；不承诺跨任意改写保留旧分页链 |
| Ink / classic / ACP | 消费相同 Host 事实，呈现及外部协议能力不同 | Ink 普通历史浏览仍有 Issue 342；协议转换不等于各端 UX 完全相同 |
| 浏览器 / Web | 纯类型可复用，网关和远程 transport 另行实现 | 当前没有现成浏览器 transport，不计为已经通过的端到端能力 |

## Spec

### F01 — P1：超长正文的独立 base64 分块被错误拼接

`src/client-history.ts:263` 先连接各块的 base64 字符串再解码；Host 每块独立编码 256 KiB，前块末尾包含 padding，拼接后解码提前结束。真实公共 SDK 读取 300 KiB assistant 正文时，整页 `readHistory` 失败；搜索可以命中，但 `readHistoryEntry` 同样报 `internal_error`。没有并发改写或过期 cursor。

要求：`docs/features/v0.7.97.md:295`“展开或复制大内容要能取得原内容”；`docs/CLIENT_CONTRACT.md:286` 要求搜索命中引用可补读原文。

修复方向：各块分别解码成字节，再连接字节并统一解码 UTF-8/JSON。不能各块先转 UTF-8 文本，否则跨块多字节字符仍会损坏。补边界前后、中文/emoji 跨界、分页与搜索两入口回归。

### F02 — P2：历史投影误用实时视图的 150 项限制

`src/client-history.ts:198` 调用有窗口裁剪的 REPL 恢复函数。单条 canonical 消息包含 80 组交错 thinking/text 块时，公共历史只返回 150 项而非 160 项，且没有下一页。补读 ordinal 同样经过裁剪，客户端不能通过返回的引用找回前十块。

要求：`docs/features/v0.7.97.md:271`“消息内容块保序”；`:295` 分页须承接展开、定位、复制能力。

修复方向：历史投影与实时窗口裁剪分开，沿用原内容块语义；测试不能只增加消息条数，还要覆盖单条消息的高块数和工具展开数量。不以提高 150 上限替代修复。

### F03 — P2：用户输入移出视图后失去全文补读来源

`src/sdk-runtime.ts:4495–4503` 离窗回源仅处理 outputId 和工具 callId，未处理用户输入。观察并成功补读 9009 字符的用户项后，追加 85 轮对话，使该项移出窗口；用原 ID 调 `readItem` 返回 null。原消息没有改写，也没有 rewind。

要求：`docs/features/v0.7.97.md:287`“普通新增输出不能使原选中内容过时”。这不要求任意旧版本快照，只要求仍然存在且未变更的原消息可读。

修复方向：为已接受输入保留并使用来源身份，补足原 ID 到 canonical user 的回源；覆盖同文本不同 inputId、离窗、压缩和分支切换，不能用正文猜身份。旧无身份消息的兼容范围要另行界定。

前三项均经嵌入式 Runtime 和真实 named pipe + `connectKodaXClient` 复现。两套复现各有四个失败断言（F01 占两个）与两个通过控制项。详见[证据与可重跑源码](contract-history-assurance-2026-09-26/evidence.md)。fixture 使用隔离存储注入消息；普通追加案例直接追加 canonical fixture 后由公共 appendNotice 触发刷新，并非执行 85 次模型调用。

### F04 — P2：Session MCP 持久化失败后资源未释放

`src/sdk-runtime.ts:7881–7892` 先取得 Session MCP 连接，再写入配置，之后才标记 ownsSessionResources。持久化抛错时，`:7907` 的清理条件为假。

隔离环境下将 Session MCP 存储路径设为普通文件，真实 stdio MCP fixture 已启动，创建随后报 EEXIST；Session 不存在，而子进程在失败返回及 500ms 后仍活着，直到 runtime.close 才退出。本项经真实 Runtime 的产品适配器验证，未重复经过 IPC。

要求：FEATURE_298 T12，`docs/features/v0.7.97.md:610`“Host 能校验/创建/释放每 Session MCP 资源”。[复现源码与结果](contract-operations-assurance-2026-09-26/result.md)已保留。

修复方向：资源成功取得后立即承担释放责任，后续配置/Session 保存失败均释放本次资源，并处理本次配置残留；保留原失败及清理失败诊断。不能先延迟取得责任到全部保存成功。

### F05 — P2：工作流实际权限未采用显示中的产品默认值

`src/sdk-runtime.ts:11296–11298` 以 productInput 是否存在决定是否采用产品默认权限；直接 `workflows.start` 没有这个字段。视图使用产品默认 accept-edits，而实际工作流可能按未指定模式执行，触发额外人工审批。

真实 named pipe + 公共 Client 对照：空 profile/Session 权限下，view.settings 为 accept-edits；工作流子任务写本项目临时文件时出现 permission，文件没有写入。取消审批并等待终态，再给同 Session 显式设置 accept-edits，执行相同工作流则直接写入成功、无审批。见[对照源码和结果](contract-operations-assurance-2026-09-26/result.md)。本次复现用例 1/1 通过，断言当前差异确实存在，不表示正确行为已经修复。

要求：`docs/CLIENT_CONTRACT.md:94` 产品 Session 的有效模式与执行一致；FEATURE_298 T22 要求工作流经统一 Host 启动。修复应明确产品工作流的设置解析归属，不用是否存在普通输入对象猜来源，也不能将低层 Runtime 未声明权限的调用一律改成自动授权。显式/隐式相同设置、普通输入/显式工具/工作流入口需要交叉对照。

## Standards

1. 成文规范项：`src/runtime-daemon/client.ts:1665` 的迟到订阅释放失败被 `.catch(() => undefined)` 吞掉，违反 AGENTS 的“NEVER silently swallow errors”。这是低层 Runtime 事件订阅清理路径，不能算成已复现的 Product `sessions.observe` 生命周期缺陷。建议复用正常关闭诊断，补故障用例。
2. 判断项：`src/client-history.ts:216–223` 和 `src/session-view.ts:799–808` 重复转换 canonical 输出，前者没有后者保留的 outputId/提交字段，存在投影漂移。历史本来使用独立 revision/ordinal 身份，契约也没有承诺跨读取面 ID 互换，因此这不是独立的硬契约违规。普通浏览需要跨面定位时，应验证已有源身份字段是否足够，而非从文字相等推断同项。

未发现明确包独立性违规。本轮规范轴两项（一个规范违反、一个风险判断），需求轴五项已复现缺陷，最高 P1。

## 有意边界，不计为新缺陷

- 历史页必须属于同一 revision；追加和分支变化都可能使 cursor 过期。客户端应保留已显示内容并明确刷新/重试，不能无限循环重读或跨版本拼接。
- 当前 observe 没有历史 revision；共同 inputId/callId 只证明一项的关联，不能证明两个列表来自同一分支快照。
- 任意并发替换时读取旧稿、事件无限重放、Host 崩溃后自动继续执行均不是当前保证。
- Thinking 不参与全文搜索是原有明确脱敏策略；按历史项引用仍可读取其正文，不作为本次新缺口。
- ACP 追加通知不能完全表达任意替换，且浏览器没有现成 transport；“同契约”不等于每个消费协议具备相同显示操作。

## 验证与剩余工作

本轮第一组公共 SDK 回归：13 文件、93 项通过，覆盖 history、observe、inputs、runs.await、interactions、settings、lifecycle、output ownership、workflow、domains、catalog、MCP。

`npm run test:contract -- --maxWorkers=2`：116 文件通过、1 文件失败；953 项通过、1 项失败、21 TODO。失败为 `agent.extension-runtime.test.ts:630` 后台 review 完成计数预期 1、实际 2。原文件独立重跑 7/7 通过；尚未证明首次失败原因，不能记录成整层一次通过。该脚本主要是 coding orchestration 契约集，不包含全部 `sdk-client.*`，因此必须另跑公共 SDK 行为测试。

第二组订阅、队列、权限、分支、ACP 与终端消费回归：12 文件、147 项通过。两组定向回归合计 25 文件、240 项通过；其中公共 IPC、协议测试与消费者单元测试混合，不将 240 项全部称为端到端测试。新增缺陷复现单列，不包含在通过数中。

本轮未修改生产代码，未跑新的物理鼠标或发行 bundle 端到端测试，未调用真实付费模型，也未修改用户原始 Session。之前的终端 A/B 证据仍用于 Issue 342，不能冒充本轮公共契约修复验证。

为降低逐项补洞的风险，后续回归应围绕交叉不变量：同一原文跨 observe/readItem/history/search、窗口内外、单条块数与字节上限；普通追加与分支改写分别验证；资源取得后的每个失败点验证释放；显示有效设置与不同执行入口实际采用的设置一致；相同场景覆盖嵌入式和真实 IPC，再由消费者验收。现有总通过数不能代替这些边界组合。
