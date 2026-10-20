# Issue 368：REPL 未发送会话不进入持久化历史

用户要求：新 REPL 会话先作为草稿，首次有效输入被接受后再持久化；Space 合理处理旧空记录。

SDK 公共创建接口新增 `draft: true`，Host 提供 `sessionDrafts:1` 能力。CLI 必须协商此能力；生产 REPL 的 Session command 绑定在启动和 `/new` 时声明草稿。普通显式创建继续保持原有持久化语义，命名的空会话无需被删除。

草稿保留设置、显示与 Actor CAS 的内存状态，不在 Session 历史列表里。首个用户输入保存到 canonical 历史时转为持久化会话，并保存此前有效设置。无效输入或关闭前未发送的草稿不留下 Session 文件或设置；接受后的执行失败保留输入。历史 revision 的草稿边界不代表已有磁盘文件。

1. 启动 Ink REPL 与 classic REPL，不发送输入，改 Provider/模式后退出。通过 SDK Session manager 验证没有新增记录。
2. 执行多次 `/new` 后退出，结果相同。
3. 使用 SDK 创建草稿，观察空 view、更新设置、提交无效输入，历史仍为空。
4. 提交有效输入，接受后立即可读取唯一的 canonical user input；运行完成、失败或停止后仍保留。
5. 重复提交同一 inputId，不能新增一轮执行或一份输入。
6. 重启后恢复已接受会话及其设置；未发送草稿不能被恢复，也不能污染之后显式创建同 ID 的设置。
7. 显式普通创建命名空会话、派生会话、临时任务与已有会话继续按原契约工作。
8. 删除未发送草稿后同 ID 可重新创建；转正期间并发读取设置不能回落为默认值。
9. 注入首次设置写盘失败，确认不启动 Provider；解除文件故障后再次提交，设置会重试保存，重启 Host 后仍可恢复。
10. 分别通过公开 `runs.start` 的 coding/managed_task 路径提交草稿；首次输入与设置在 Provider 执行前保存，输入不能重复追加。会话转正后重启 Host，此前选择的 Provider、权限模式和 Agent 模式仍可恢复。注入首次设置写盘失败，两条路径均不得调用 Provider。
11. 首次设置写盘失败后，重试同一 `inputId` 和内容；canonical 输入始终只有一份，Provider 只执行一次。复用该 ID 提交不同内容必须返回 conflict，不能执行。

自动回归：`src/sdk-runtime.session-drafts.test.ts`、`src/sdk-client.inputs.test.ts`（包含真实共享 Host 与生产 CLI 绑定）；关联 Session/设置/lineage/schema 回归一同运行。发布应同时包含 `83aafb22` 的用户图片恢复修复和本轮草稿修复；此文档不表示 npm 已发布。

## 2026-10-14 自动验证结果

- 最终 SDK 回归 17 文件 596 项通过，覆盖草稿、输入、设置、CLI、schema、存储、用户图片、自定义 Provider 和流完整性。此前的 61 项草稿与 168 项存储验证保留为首轮证据，不与最终计数叠加。
- V8 专项 3 文件 19 项通过；`sdk-runtime.ts`、`cli-client-plane.ts`、`interactive/storage.ts` 的新增可执行语句起始行覆盖 54/56（96.43%）。范围是相对 `83aafb22` 的三个草稿接缝，不是全仓覆盖率，重复专项不叠加测试计数。
- SDK workspace 构建、bundle、独立声明构建、源码与测试类型检查通过；Standards/Spec 最终产品增量均 0 项残留。
- 首轮草稿补丁的 Space 联调通过 14 项 Electron 回归（13 项真实共享 Host，1 项旧空记录与侧栏兼容）；Space 258 项关联回归、类型检查、lint 和生产构建通过。这些记录先于 SDK admission 的本轮补修；补修通过上述 SDK 公开调用边界验证，正式 Registry 与打包验收仍待发布后执行。
- 发布状态：修复已记入 Unreleased。SDK 维护者发布后，Space 需更新精确依赖锁、撤下开发链接，再执行 Registry 与正式打包验收。
