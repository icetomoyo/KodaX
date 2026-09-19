# GLM 的 config、MCP、provider probe 缺口在当前产品 REPL 是否成立？

结论：在 `795b8469`，config 与 provider probe 确有尚未迁移的产品消费路径；MCP 的结论需纠正：交互 `/mcp` 已用 Host，独立 `kodax mcp add/remove` 才直接写本地文件，不能据此断言产品 Client 无法管理 MCP。以下仅核验源码和已有测试，没有修改产品、运行真实 Provider 请求或重新执行测试。

## 1. config：成立，但不能泛化为 Session 设置完全不同步

- 生产 CLI 将 `interactiveClient` 的 Session、MCP、命令等面注入两个 REPL，却没有注入 config 或 provider catalog 面；`createCliClientPlane` 也只有 Session 设置、运行、输入、观察和历史操作。来源：`src/kodax_cli.ts:4914`、`:4943`、`:4966`；`src/cli-client-plane.ts:56`。
- classic 启动仍调用 `prepareRuntimeConfig()`，该函数读本地 config、投影本进程环境变量和注册本进程 Provider；本地文件读取在 `loadConfig()` 中。来源：`packages/repl/src/interactive/repl.ts:591`；`packages/repl/src/common/utils.ts:1071`、`:1335`。
- 更直接的产品路径证据是 `/model`：即使存在 `commandClient`，builtin 命令仍执行本地 handler（仅 extension/prompt 被优先转发），handler 从本地配置和 Provider 注册表列出/校验模型，先 `saveConfig` 再调用 `switchProvider`。因此 Host 独有的 Provider/模型可能在客户端校验时被拒绝，保存默认值也写的是客户端 config。来源：`packages/repl/src/interactive/commands.ts:1593`、`:1644`、`:1659`、`:1670`、`:3248`、`:3277`。
- `/model` 的当前 Session 选择已走 Host：classic 的 `switchProvider` 调用 `syncClientSettings`，Ink 的调用 `selectClientConfig`。不能将“持久默认值仍本地”写成“模型切换根本未同步到 Host”。来源：`packages/repl/src/interactive/repl.ts:1388`；`packages/repl/src/ui/InkREPL.tsx:10312`。
- `/fallback` 是另一条较实质的残留：直接保存本地 config，并修改本进程 `KODAX_FALLBACK_PROVIDERS`，不使用 callbacks。其即时环境修改不会跨进程传给 daemon；同一 configHome 的文件修改是否稍后被 Host 重载，是另一机制，不能由这个 handler 保证。来源：`packages/repl/src/interactive/commands.ts:1215`、`:1237`、`:1255`。
- Host 能支持迁移：产品契约有 `config.read/patch/reload`，适配器转发 runtime；Host patch 写自己的配置并触发 `onChanged`，catalog providers 从 Host 配置及运行时 Provider 注册表派生。已有双 Client 测试验证一端 patch、另一端 reload/read 看到新值。来源：`packages/coding/src/client-contract.ts:218`；`src/client-runtime-adapter.ts:198`；`src/sdk-runtime.ts:12605`、`:12654`；`src/sdk-client.catalog.test.ts:95`、`:103`。
- 建议优先级 P2：补齐产品绑定的 config/catalog 消费，保留 standalone 本地路径。前轮报告确认“有产品入口”但没有识别这些 builtin 的持久化/发现残留，属于有帮助的遗漏。来源：前轮 `docs/research/product-client-reaudit-2026-09-14.md:9` 与上述实际调用链。

## 2. MCP：交互面已迁移，独立管理 CLI 仍是文件面

- 生产 `interactiveOptions.mcp = interactiveClient.mcp`；classic/Ink 将它传入 CommandCallbacks；`/mcp status` 优先 `mcp.status()`，`/mcp refresh` 优先 `mcp.listTools({ forceRefresh: true })`。只有没有绑定时才读本地 extension runtime。来源：`src/kodax_cli.ts:4946`；`packages/repl/src/interactive/repl.ts:1230`；`packages/repl/src/ui/InkREPL.tsx:10120`；`packages/repl/src/interactive/commands.ts:1005`、`:1019`、`:1039`。
- `/mcp` 自身只有 status/refresh，没有 add/remove CRUD UI；其帮助引导用户执行另一个独立命令 `kodax mcp add`。不能把“REPL 缺 CRUD 入口”误写为“已有 REPL CRUD 绕开 Host”。来源：`packages/repl/src/interactive/commands.ts:1003`、`:1033`、`:1064`。
- 独立 `kodax mcp list/add/remove` 确实读写本地 integration 文件：`src/integration-cli.ts:530`、`:536`、`:573`、`:578`。因此 GLM 指向的 `common/mcp-servers.ts` 是真实文件 helper，但它也被 Host 内部复用，本身不是产品客户端绕开 Host 的证据。来源：`src/sdk-runtime.ts:21531`、`:21538`。
- 产品 Client 的 CRUD/reload 完整可调用：适配器转 runtime，daemon 转 `mcp.server.*` RPC，Host CRUD 使用自己的 configFile，reload 替换 Host capability provider。真实产品 IPC 测试通过 `client.mcp.upsertServer` + `reloadServers` 激活 MCP。来源：`src/client-runtime-adapter.ts:207`；`src/runtime-daemon/client.ts:1183`；`src/sdk-runtime.ts:12788`、`:12798`；`src/sdk-client.mcp.test.ts:83`；`src/sdk-client.integration-diagnostics.test.ts:65`。
- 建议归类为 P3 产品入口/独立管理 CLI 一致性工作，而非当前 REPL 功能回归或统一接口缺失。若未来要让独立管理 CLI 显式面向任意 Host，可复用已有契约；无需为纠正 GLM 判断立即新增 CRUD 命令。依据是上述 status/refresh 已迁移、CRUD 已由契约提供的事实。

## 3. provider probe / forget：成立，而且影响本地 Client 与独立 Host 的权责一致性

- builtin `/provider` handler 将 callbacks 命名为 `_callbacks` 且不使用；`forget-capability` 直接清理本进程默认 configHome 的缓存；`probe` 本地计算候选 effort，传本地 `resolveProvider` 给 `probeProviderReasoningEfforts`。绑定 `commandClient` 不改变 builtin handler 的执行。来源：`packages/repl/src/interactive/commands.ts:1707`、`:1716`、`:1723`、`:1733`、`:1740`、`:3277`。
- helper 确实执行 `provider.stream()` 并持久化拒绝 effort，源码明确这是显式用户命令触发的真实请求。因此“客户端必须具备相应 Provider 凭据/环境，并可能计费”成立；它不是后台自动探测，也不是凭据泄露。来源：`packages/repl/src/common/capability-probe.ts:11`、`:40`、`:50`、`:74`。
- Host 产品面已能正确支持：`catalog.reasoningEfforts/probeReasoningEfforts/forgetCapabilities` 使用 Host configHome 和 Provider 解析器；daemon 已有 probe/forget RPC。来源：`packages/coding/src/client-contract.ts:234`；`src/client-runtime-adapter.ts:262`；`src/runtime-daemon/client.ts:1127`；`src/sdk-runtime.ts:12636`、`:12641`、`:12649`。
- 现有产品 IPC 测试使用 loopback 假 Provider，验证 Host probe 收窄 SA/AMA 实际请求能力，forget 恢复后续请求；它验证供给侧，不覆盖当前 builtin `/provider` 的路由。源码可核对：`src/sdk-client.capabilities.test.ts:14`、`:65`、`:68`、`:82`。此次未实际执行 probe。
- 建议优先级 P2，排在新增 MCP CRUD UI 之前：产品 `/provider` 应复用已有 Host catalog 面，standalone 保留 helper。这是前轮报告未识别的有效遗漏，而非缺少新的统一接口。

## 未证实

- 未复现“所有 Host 配置热更新均不会反映到 REPL”。Session 设置已有观察同步，saved config/catalog 仍本地只是更精确的已证实范围。
- 未复现每一种同机 configHome 下 capability cache 的跨进程可见性；即使共享文件使拒绝记录可见，也不能消除本地请求、独有 Provider 和本地凭据依赖。
- 未把远程浏览器传输尚未实现混入此三项；这里评估已有产品契约和已连接 Host 的客户端消费路径。

## 未解问题

产品 REPL 修改 `/model` 等设置时，是否应同时修改 Host 全局保存默认值，还是只修改当前 Session，需要沿用现有“saved”语义和产品设计作明确决定；当前代码同时做本地持久化和 Host Session 修改，不能机械删除其中一个而改变用户预期。来源：`packages/repl/src/interactive/commands.ts:1644`、`:1646`、`:1670`、`:1672`。
