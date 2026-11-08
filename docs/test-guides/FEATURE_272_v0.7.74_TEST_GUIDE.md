# FEATURE_272 v0.7.74 - 人工测试指导

## 功能概述

**功能名称**: 可靠的大型上下文压缩与 SDK 可观测性

**版本**: v0.7.74

**测试日期**: [待填写]

**测试人员**: [待填写]

自动大型压缩始终开启；百分比阈值限制在 15%-90%，可增加绝对 token
阈值且两者取较小值。一次压缩覆盖保护尾部之外的全部历史，保留真实用户
query，并以 contextId 区分主/子 Agent。Runtime/Space 使用有界 transcript
分页与 chunk，避免 8 MiB daemon 帧。根宿主在驱逐压缩原文前先持久化精确
lineage，并提供确定性、revision-bound 的历史检索与按条目回读。

---

## 测试环境

### 前置条件

- Node.js 20+，主仓与 KodaX Space 位于相邻目录。
- 主仓已执行 `npm run build`；Space 已执行 `npm run link:kodax`。
- Space 使用一个声明 1M context window 的可用 provider/model。
- 准备一个可持续多轮对话的测试项目；不要在生产 Session 上做破坏性测试。

### 记录要求

- 保存每次 `context.compaction.finished` 的完整 payload。
- 记录 UI 压缩前/后数值、实际阈值、contextId/contextKind/revision。
- 失败时保存日志及 Session ID，不要只截取通知文案。

---

## 测试用例

### TC-001: 百分比边界与始终开启

**优先级**: 高

**类型**: 边界测试

**测试步骤**:

1. 在 Space 压缩设置中依次输入百分比 `15`、`90` 并保存。
2. 尝试输入 `14`、`91`，确认 UI 阻止越界提交。
3. 在 `~/.kodax/config.json` 临时设置 `enabled:false, triggerPercent:1`，重启并读取有效配置。

**预期效果**:

- [ ] 15 和 90 均可保存。
- [ ] UI 范围为 15-90；SDK 对遗留的 1 归一化为 15。
- [ ] `enabled:false` 不会关闭自动大型压缩。
- [ ] 留空百分比时有效值为 75。

### TC-002: 百分比与绝对阈值取较小者

**优先级**: 高

**类型**: 正向测试

**测试步骤**:

1. 在 1M 模型上设置百分比 75、绝对阈值 300000。
2. 打开上下文指示器详情。
3. 将绝对阈值改为 0，再次查看详情。

**预期效果**:

- [ ] 第一次有效阈值显示 300k，而不是 750k。
- [ ] 设置 0 后绝对阈值不再生效，有效阈值恢复 750k。
- [ ] 设置说明明确表示两个阈值取较小者。

### TC-003: `322,973` 类事故回放

**优先级**: 高

**类型**: 回归测试

**前置条件**: 1M 模型，百分比 30 或绝对阈值 300000。

**测试步骤**:

1. 构造约 323k 的主上下文，其中最近约 60k 为可辨认的尾部标记；更早历史分为多个时间段。
2. 触发自动压缩，记录 canonical event。
3. 继续提问早期、中期和最近三个阶段的约束。

**预期效果**:

- [ ] `protectedBudgetTokens` 约为 60k，而不是 200k。
- [ ] `eligibleTokens` 覆盖保护尾部之外的全部历史，不只约 100k 最旧片段。
- [ ] 一次 trigger 只产生一次 committed canonical event，不在同一轮循环压缩。
- [ ] UI 显示真实主上下文 before → after；完整滚动历史仍可见但不冒充 active context。

### TC-004: 用户 query 跨两轮压缩保持

**优先级**: 高

**类型**: 数据完整性测试

**测试步骤**:

1. 在历史早、中、晚期分别发送带唯一 ID 的三条请求和一条纠正请求。
2. 触发压缩；继续增长上下文并再次触发压缩。
3. 检查第二次 checkpoint 中的 `User Queries & Corrections` JSONL。

**预期效果**:

- [ ] 四条真实请求原文、顺序和 ID 均存在。
- [ ] tool_result、自动继续和 compaction checkpoint 不被误记为用户 query。
- [ ] 上一轮保护尾部中的同一消息没有在第二轮重复入账。
- [ ] 用户在新 turn 再次发送相同文字时仍形成独立条目。

### TC-005: 主/子 Agent 指标隔离

**优先级**: 高

**类型**: 并发/可观测性测试

**测试步骤**:

1. 启动会产生子 Agent 的任务。
2. 为根 Session 设置非默认百分比与绝对阈值，并让子上下文超过较小的有效阈值；在子历史中写入一个不出现在摘要内的唯一标记。
3. 让主上下文压缩到例如 222k，再让子上下文产生较小的 8k 压缩结果。
4. 查看 canonical events 和 Space 上下文指示器；让子 Agent 搜索并读取自己的唯一标记。

**预期效果**:

- [ ] 主事件 `contextKind=root, contextId=<sessionId>`。
- [ ] 子事件具有独立 `contextId`、`parentContextId` 和 `agentId`。
- [ ] 子事件仍可观察，但不会把主 UI 的 222k 覆盖成 8k。
- [ ] contextRevision 只随所属上下文提交递增。
- [ ] 子 Run 继承根 Run 已解析的 `triggerPercent`/`triggerTokens`，而不是退回默认值。
- [ ] 持久化子 Run 使用独立隐藏的 `managed-task-worker` Session；可检索自己的压缩原文，但不能检索或修改根 lineage。

### TC-006: 手动 compact 使用有效阈值保护预算

**优先级**: 高

**类型**: SDK 测试

**测试步骤**:

1. 通过 Runtime Session settings 设置 60% 和绝对 250000。
2. 在未达到自动阈值时调用 `runtime.sessions.compact({sessionId})`。
3. 检查 manual canonical event。

**预期效果**:

- [ ] 手动调用立即执行，但 `effectiveTriggerTokens=250000`。
- [ ] 保护预算约 50k；没有隐藏的 `triggerPercent:100`。
- [ ] `source=manual` 且 before/after revision 连续。

### TC-007: 超过 8 MiB 的 transcript 无损恢复

**优先级**: 高

**类型**: 性能/边界测试

**测试步骤**:

1. 写入一条大于 8 MiB 的 client notice 或等价 transcript entry。
2. 建立 daemon observation；记录 snapshot 的 JSON 字节数。
3. 使用 page API 和 entry chunk API 读取全部内容并按 index 重组。
4. 在读取中途追加一条新 entry，再使用旧 cursor。

**预期效果**:

- [ ] observation/page/chunk 单个响应均显著小于 8 MiB。
- [ ] 超大 entry 以 `oversized:true` 描述，不被静默截断。
- [ ] chunk 解码后的 JSON 与原 entry 字节内容一致。
- [ ] 旧 cursor 明确报 stale/resync，而不是返回混合 revision。
- [ ] Space 滚动历史最终按原 append 顺序显示。

### TC-008: 压缩失败不部分提交

**优先级**: 高

**类型**: 负向测试

**测试步骤**:

1. 使用会让 summary provider 失败或返回 tool_use 的测试 provider。
2. 触发一次大型压缩。
3. 比较失败前后的 canonical active messages、revision 和 query ledger。

**预期效果**:

- [ ] active history 和 contextRevision 不变。
- [ ] 不出现只覆盖最旧一部分的临时 summary。
- [ ] 错误通过诊断/调用错误明确暴露。
- [ ] 若显式启用了 legacy emergency pruning，其恢复 checkpoint 仍包含全部真实用户 query。

### TC-009: fallback 不误报成功

**优先级**: 高

1. 构造“不可裁剪的 mandatory system/checkpoint 已超过物理容量”的上下文。
2. 触发显式 legacy emergency pruning。
3. 记录 canonical messages、`onCompactStats`、`onCompact` 与 Runtime event。

**预期效果**:

- [ ] 返回的 canonical history 与触发前相同。
- [ ] 新数组引用但 token 未减少不算成功。
- [ ] token 有减少但完整请求仍超过物理容量也不算成功。
- [ ] 两种失败候选都不发出成功 compact stats，不增加 context revision。

### TC-010: 配置模板与 kodax_manual 一致性

**优先级**: 中

1. 查看仓库 `config-templates/config.example.jsonc` 与首次启动生成的配置模板。
2. 调用 `kodax_manual({topic:"compaction"})`。
3. 对照 SDK 指南第 25 节与 Space 设置界面。

**预期效果**:

- [ ] 两份模板均包含 `triggerPercent:75` 与 `triggerTokens:0` 示例。
- [ ] manual 明确自动压缩不可关闭、百分比限制 15-90、0 只关闭绝对阈值。
- [ ] manual 明确保护量为有效阈值的 20%、覆盖完整 eligible prefix、保留用户 query。
- [ ] manual 与 SDK 均说明只有物理有效且已提交的实际 token 减少才是成功。

### TC-011: 压缩原文持久化、退出与恢复

**优先级**: 高

**类型**: 数据耐久性回归测试

1. 在待压缩前缀中分别写入唯一的用户请求、助手结论、工具调用和工具结果标记。
2. 触发一次根上下文压缩，等待 `context.compaction.finished`，随后正常 `/quit`。
3. 使用 `kodax -c` 恢复同一 Session，并检查主 JSONL 与 island sidecar。
4. 询问只存在于被压缩原文、摘要中没有直接答案的标记。

**预期效果**:

- [ ] 压缩提交后，精确原始条目至少存在于主文件、sidecar 或仍未驱逐的 live lineage 之一。
- [ ] 重启后完整 transcript 合并主文件和 sidecar；同一稳定 entry ID 只出现一次。
- [ ] active model context 仍是 checkpoint + 保护尾部，不会把全部历史重新塞回 provider 请求。
- [ ] 根 Agent 先搜索再按 citation 回读，并使用原始证据回答，而不是从摘要猜测。
- [ ] `kodax -c` 不会在尾部额外渲染重复 tool call/tool result。

### TC-012: sidecar/main 写失败不丢失最后精确副本

**优先级**: 高

**类型**: 故障注入测试

1. 分别在 sidecar append/flush 与 slim main rename 阶段注入一次可识别的 I/O 失败。
2. 在每次失败后立即检查 live lineage、旧主文件、sidecar 和诊断事件。
3. 移除故障并重试保存，再调用完整 transcript 与历史检索。
4. 用一个尚未产生常规快照的新 Session 在首轮直接触发压缩。

**预期效果**:

- [ ] sidecar 未成功刷盘时不驱逐 live 原文，也不替换主文件。
- [ ] sidecar 已刷盘但 main 替换失败时，旧主文件仍权威，sidecar 保留精确原文。
- [ ] 错误不会被静默吞掉；可看到明确的持久化诊断。
- [ ] 重试后合并结果无重复，且 maintenance 不会再次归档同一 entry ID。
- [ ] 首轮 Session 由显式运行元数据和 exact pre-snapshot 原子建立，不因首次 `load()` 为空而失败。
- [ ] 持久化失败时 `contextRevision` 回到原值；Runtime 模式下 UI 不执行第二次 Session 写入。

### TC-013: 智能历史检索、revision 与信息边界

**优先级**: 高

**类型**: 恢复质量/隐私测试

1. 在已压缩历史中放入中文短语、代码标识符、工具结果，以及内容相近但时间不同的条目。
2. 让根 Agent 使用 `session_history_search`，再用 citation 调用 `session_history_read`。
3. SDK 调用 `sessions.transcriptSearch()`，将返回的 `revision` 与 `entryIndex` 传给 `transcriptEntryChunk()`。
4. 搜索仅存在于 hidden thinking、system 指令和旧合成 checkpoint 中的唯一标记。
5. 在 search 与 read/chunk 之间追加 Session 条目，再使用旧 revision。
6. 用普通短查询（例如 `0.7.74`）确认它不会因随机 entry ID 的短片段而命中无关条目，并直接用已知 ID 尝试读取被排除条目。
7. 在持久化子 Run 中触发压缩并检索该子 Run 的唯一旧标记；同时确认根标记不可见。再用 storage-less Run 和显式隐藏任一历史工具的 visibility policy 验证工具暴露。

**预期效果**:

- [ ] 精确短语优先，Unicode/标识符/工具证据可命中；默认只搜已离开 active path 的条目。
- [ ] read/chunk 有界返回，可通过 next offset/cursor 继续，citation 稳定指向 entry ID。
- [ ] hidden thinking、system 指令与合成 checkpoint 不可通过模型工具搜索或读取。
- [ ] 普通短查询不按随机 ID 片段加分；只有长直接标识符查询使用 metadata boost。
- [ ] 旧 revision 明确返回 stale/resync，不拼接两个版本的证据。
- [ ] 持久化子 Run 原子获得工具对并只读自己的隐藏 lineage；绑定根 Session 的子上下文、临时/storage-less Run、不支持 full-lineage 的自定义 storage，以及隐藏任一工具的策略都看不到工具对。
- [ ] embedded 与 daemon 都声明 `contextCompaction:3`、`transcriptPaging:1`、`transcriptSearch:1`。

### TC-014: 旧版本 `[compacted]` 会话的诚实兼容

**优先级**: 中

**类型**: 升级兼容测试

1. 复制一份由旧版本生成、只剩 `[compacted]` 占位符且没有 exact sidecar 的 Session。
2. 用 v0.7.74 加载、继续对话并执行一次新的压缩。
3. 搜索旧占位符之前的细节，以及升级后新压缩掉的细节。

**预期效果**:

- [ ] 旧 Session 可正常加载，不崩溃、不伪造缺失原文。
- [ ] 从未持久化的旧字节明确视为不可恢复；检索返回无命中，而不是幻觉内容。
- [ ] 旧 checkpoint 前缀与 `[compacted]` 即使 ID 已知也返回 `not_found`。
- [ ] 升级后的新压缩遵守 durable-before-evict，新产生的精确历史可恢复。
- [ ] 产品文档和诊断不承诺反向恢复旧版本已经永久删除的数据。

### TC-015: checkpoint 谱系与附件保持同一路径

**优先级**: 高

**类型**: 数据完整性/升级兼容测试

1. 触发一次会生成 artifact ledger 或文件内容附件的自动压缩，并保存压缩后的 Session。
2. 检查活动谱系的 compaction entry、`firstKeptEntryId` 与后续保留消息。
3. 通过 `kodax -c` 恢复 Session，确认下一轮 provider context 的 checkpoint、附件与保留尾部。
4. 再复制一份仅含旧式无 recovery guidance checkpoint 的 Session 并恢复。

**预期效果**:

- [ ] 活动路径以 compaction entry 开始，`firstKeptEntryId` 指向第一条保留消息。
- [ ] checkpoint 不会同时形成一个同级 synthetic message entry。
- [ ] artifact/file 附件紧跟 checkpoint，各出现一次，恢复后仍可见。
- [ ] 当前 checkpoint 保留 `Exact history recovery` 指引。
- [ ] 旧式无指引 checkpoint 可正常加载，并在派生上下文中升级为当前规范格式。

---

## 自动化预检

```powershell
# KodaX
npm run build
npx vitest run packages/agent/src/session-lineage packages/coding/src/tools/session-history.test.ts packages/coding/src/child-executor.test.ts packages/coding/src/agent-runtime/durable-compaction.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-048-tool-exec-ctx.contract.test.ts packages/coding/src/agent-runtime/__contract-tests__/p3.4-compaction-flow.contract.test.ts packages/coding/src/task-engine/_internal/managed-task/compaction.test.ts packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts packages/repl/src/interactive/storage.test.ts packages/repl/src/session/public-api.test.ts packages/repl/src/ui/utils/compaction-commit.test.ts src/sdk-runtime.test.ts src/runtime-daemon/client.test.ts src/runtime-daemon/server.test.ts

# KodaX Space
npm run link:kodax
npm run typecheck
node --test --import tsx apps/desktop/electron/test/runtime-context-telemetry.test.ts apps/desktop/electron/test/app-store-runtime-projection.test.ts apps/desktop/electron/test/runtime-host-adapter.test.ts
```

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 15 | - | - | - |

**测试结论**: [待填写]

**发现的问题**: [待填写]

---

*测试指导生成时间: 2026-07-21*

*Feature/Issue ID: FEATURE_272 / ISSUE_192 / ISSUE_198 / ISSUE_203*
