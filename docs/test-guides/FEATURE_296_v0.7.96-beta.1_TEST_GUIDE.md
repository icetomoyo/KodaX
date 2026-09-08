# 长会话上下文容量恢复回归

无需客户 Provider。自动测试使用真实 OpenAI SDK 的离线 fetch、真实压缩器、Runner 和 SA 宿主；远端响应由固定 fixture 提供。

## 自动验证

```powershell
node node_modules/vitest/vitest.mjs run packages/llm/src/providers/base.test.ts packages/agent/src/context-capacity.test.ts packages/agent/src/primitives/runner-compaction-hook.test.ts packages/agent/src/session-lineage/compaction/compaction.test.ts packages/coding/src/history-capacity-recovery.test.ts packages/coding/src/token-accounting.test.ts packages/coding/src/task-engine/_internal/managed-task/context-capacity-boundary.test.ts packages/coding/src/task-engine/_internal/managed-task/compaction.test.ts packages/coding/src/agent-runtime/run-substrate.capacity-accounting.test.ts --maxWorkers=2
node node_modules/vitest/vitest.mjs run src/sdk-runtime.test.ts -t 'capacity.*credential' --maxWorkers=1
```

核对以下结果：

- vLLM 精确报文：窗口 131072、输入 103456、输出 32768 时，仅重试一次，输出降为 26616；显式更小输出上限不被提高。
- `at least`、字符预检 `upper bound`、输入单独超窗：不把边界数当精确 usage，不发送已知无效的减输出重试。
- 输入 95773：原输出预留 32768 可收缩为 32425，不提前终止。输入 125541、预留 3000：总需求含 safety 为 132308，必须减负。
- 最新已完成工具批次也可落盘降级；ID 和配对保留。原消息对象、全文不变，全文先落盘，替换上下文后提交。
- 受保护工具结果保留；已有可信 artifact 仅收缩预览；未知 marker、落盘失败不伪造全文或成功。
- 超大用户输入与大工具历史同时存在时，两级恢复共同生效，原用户输入不写入持久工具输出库。
- SA / AMA 在实际减负后最多重试一次生成，不重跑已执行工具；没有减负或再次拒绝即终止。
- 摘要已提交后降级失败，错误恢复历史保持该摘要；AMA 有效减负后可再次尝试摘要。
- SDK 本地容量详情包含 safety。上游已确认 overflow 显示 `context_capacity / transport`，`contextOverflow.inputTokensKind` 保留精确值与上下界区别。

## 有可用模型时的补充验收

以同一窗口设置运行长代码会话，重复读取 Python/HTML、执行命令并修改文件。观察压缩、降级后能继续工作，模型可用 read/grep 读取 marker 中的全文路径。中断并恢复同一会话，确认工具执行事实及可找回的输出仍存在。

配置的 `contextWindow` 应对应服务端真实限制。较早的压缩阈值可以降低压力，但固定 95% 或 80k 不能保证高密度代码的估算误差不越界，正确性由完整恢复流程保证。无需获取客户凭证或连接客户模型；离线验证证明已识别边界的 SDK 行为，不声称还原客户每一条未保存的请求。
