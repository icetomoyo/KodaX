# GLM 清单在修复后的分支上是否仍成立？

结论：清单有帮助，上一轮没有处理配置与能力探测的本地消费路径，也没有统一 classic 初次连接重试策略。但 MCP、prepare*、默认模型及 Learning“新增退化”的描述需要纠正。核验基线为 `795b8469`，主线为 `7b5b1b9e`；本轮只核验并记录，不修改生产代码。[配置消费核验](glm-config-consumer-audit.md)、[REPL 表面核验](glm-repl-surface-audit.md)

## 应补入上一轮结论的事项

- **配置与能力探测应优先补齐消费迁移。** 产品 CLI 已持有 Host Client，但部分 REPL builtin 命令仍走本地配置或 Provider 探测。不能从 `config` / `catalog` 契约存在推导这些命令已迁移；也不能把所有启动配置读取都认定为错误。具体调用链和范围见[配置消费核验](glm-config-consumer-audit.md)。
- **classic 初次 attach 的重试策略仍与 Ink 不同。** 前轮修复失效问题窗口及关闭观察后的输入清理，没有修改连接重试策略；初次连接与已连接后的 daemon 恢复须分开讨论。[REPL 表面核验](glm-repl-surface-audit.md)
- **持久授权的列出/撤销缺少 REPL 管理入口。** `permissions.listGrants/revokeGrant` 已有服务，但没有对应 REPL/CLI 消费；前轮没有处理，审批对话不等于授权管理。[REPL 表面核验](glm-repl-surface-audit.md)
- **Host 历史搜索未接线，但打开搜索会自动加载完整历史。** Ink 已在打开搜索时调用完整历史读取，再本地搜索；可优化的是避免全量载入的 Host 搜索路径，不是缺少全历史搜索功能。[REPL 表面核验](glm-repl-surface-audit.md)

## G2：Learning 确实轮询，但不是本分支新增

产品 adapter 直接转发 `runtime.learning.subscribe`；daemon 通过 `pollRuntimeLearningEvents` 调用 `learning.events`，无事件时等待 100ms。`git show 7b5b1b9e:src/runtime-daemon/client.ts` 中存在相同函数与分支，因此这是已有传输实现限制。大约每秒十次空闲请求是忽略 RPC 耗时后的上限估计，不是实测性能数据。[`src/client-runtime-adapter.ts:94`](../../src/client-runtime-adapter.ts#L94)、[`src/runtime-daemon/client.ts:1079`](../../src/runtime-daemon/client.ts#L1079)、[`src/runtime-daemon/client.ts:1400`](../../src/runtime-daemon/client.ts#L1400)

进程内实现也不是完全没有轮询：它使用 waiter 唤醒，同时以 25ms 检查持久化事件补偿跨实例写入。`AsyncIterable` 是接口形状，不能据此区分推送与轮询。[`packages/agent/src/learning/learning-center-service.ts:64`](../../packages/agent/src/learning/learning-center-service.ts#L64)、[`:157`](../../packages/agent/src/learning/learning-center-service.ts#L157)、[`:487`](../../packages/agent/src/learning/learning-center-service.ts#L487)

**进一步确认的资源释放缺口：空闲时 `return()` 不能中止 daemon 轮询。** 现有实现是 async generator，`next()` 在无事件循环里尚未抵达 yield，后续 `return()` 排在该调用后面。REPL binding 的 `close()` 设置 `active=false` 并调用 `return()`，能阻止后续 listener，却不能立即停止此处的空闲 RPC。[`src/runtime-daemon/client.ts:1400`](../../src/runtime-daemon/client.ts#L1400)、[`src/repl-learning-binding.ts:11`](../../src/repl-learning-binding.ts#L11)

离线复现直接提取当前源码函数并通过 TypeScript 转译，注入可计数的 `request`：启动 `next()`，30ms 后调用 `return()`；再等 250ms，请求数由 1 增至 3，return 仍未完成；注入一个事件后，next 与 return 才完成。未连接模型或实际 Host，故这是现有函数的机制复现，不是完整 IPC 生命周期验收。已有产品测试在收到事件后才调用 return，未覆盖此空闲关闭窗口。[`src/sdk-client.domains.test.ts:563`](../../src/sdk-client.domains.test.ts#L563)

优先修复可取消性和释放语义，再根据需要评估推送或长轮询；不能仅以“改成推送”替代生命周期验收。真正的跨 IPC 停止请求、断线与重新挂载仍需回归验证。

## G2：不应直接把 models 改回 model.list

产品 `catalog.models` 从 `runtime.catalog.providers()` 派生，这仍是 Host 查询。Host providers 包含配置模型以及注册的运行时 Provider；现有 `runtime.catalog.models` 却直接调用无这些参数的 `getProviderList()`。两者并非可以无条件互换，产品投影也统一了过滤后仍返回数组的形状。[`src/client-runtime-adapter.ts:258`](../../src/client-runtime-adapter.ts#L258)、[`src/sdk-runtime.ts:12653`](../../src/sdk-runtime.ts#L12653)、[`:12666`](../../src/sdk-runtime.ts#L12666)、[`:21552`](../../src/sdk-runtime.ts#L21552)

当前产品契约测试明确验证自定义 Provider 模型由 `catalog.models` 返回。存在未消费 RPC 不足以证明产品实现退化，暂不建议为调用数量对齐而替换该路径。[`src/sdk-client.capabilities.test.ts:58`](../../src/sdk-client.capabilities.test.ts#L58)

## 不应直接接受的判断

- “远程 Client 无法管理 MCP”：产品契约已有 CRUD，CLI 也有 Host MCP binding；应区分缺少某个 REPL 菜单与服务不可用。[配置消费核验](glm-config-consumer-audit.md)
- “prepare* 都是死代码”：Product CLI 未注入的旧 seam 仍可服务独立 REPL；先判断独立包兼容性，不能直接删除公开 options。[REPL 表面核验](glm-repl-surface-audit.md)
- “默认模型永久显示 —”：Host view 会传递解析后的 provider/model，初始快照前的占位不能算持续能力缺失。[REPL 表面核验](glm-repl-surface-audit.md)

## 未证实与未解问题

- 本轮未测远程部署，配置文件是否实际落在另一台机器是环境条件，已确认的是命令调用链仍可能本地执行。
- Learning 空闲关闭已作函数复现，实际 UI 重挂载造成多少积存请求尚未测量。
- 新增权限管理入口、统一历史全文搜索入口及初次连接重试 UX 仍需确定产品范围；不是所有未展示的服务都必须立即加菜单。
- 上轮关于 A2A 离线结果、ACP trace 及浏览器 transport 的边界仍保留，未被本轮清单取代。[前轮报告](product-client-reaudit-2026-09-14.md)
