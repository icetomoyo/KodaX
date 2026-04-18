# FEATURE_072 v0.7.20 测试指导

## 这份文档测什么

`FEATURE_072` 把 post-compact attachments 从散落在 flat `context.messages` 的 `[Post-compact: ...]` 系统消息，
迁移到 `KodaXSessionCompactionEntry.postCompactAttachments` 字段上（lineage-native 存储）。
同时引入 worker-scoped `onIterationEnd` 事件，防止 worker 的 token 计数污染 parent REPL 的 context snapshot。

这份指导验证四件事（与 v0.7.20.md §Phasing Phase D 对齐）：

1. `/fork` 穿过 compaction entry 保留 `postCompactAttachments` 与 `memorySeed`
2. `/rewind` 落在 compaction entry 时，新 leaf 的派生视图仍包含 attachments
3. 长 AMA 会话在 LLM summary 反复失败场景下仍然 bounded growth（不再单调增长到 180k+）
4. AMA 执行期间 worker 的 token 计数不污染 parent context

优先执行 `TC-072-001` 到 `TC-072-004`。

---

## 测试环境

### 前置条件

- 已在仓库根目录完成依赖安装
- `npm run build` 全绿
- 可以正常启动 REPL
- 本机至少有一个可用的 provider；推荐 `openai` 或 `anthropic`（有稳定的压缩路径）
- 要验证 TC-072-003（fault-injected），可以用一个回环低质量 provider 或手动编辑 summary-generator 返回空

### 建议工作目录

```bash
cd c:/Works/GitWorks/KodaX-author/KodaX
```

---

## 单元测试先过

所有 Phase A/B/C 的自动化测试必须先全绿再开始手工验证：

```bash
npx vitest run packages/agent/src/session-lineage.test.ts
npx vitest run packages/agent/src/compaction/microcompaction.test.ts
npx vitest run packages/coding/src/task-engine.test.ts
```

预期：39、22、42 tests 全部通过。

---

## TC-072-001 — `/fork` 穿过 compaction 保留 attachments 与 memorySeed

### 目的
确认 Phase A 对 `cloneForkableEntry` 的扩展真的把 attachments 深拷贝到 fork 分支。

### 步骤
1. 启动 REPL，用大上下文压力触发一次真实压缩：
   - 连续抛 3-5 个读大量文件的请求，直到状态栏显示 `Compacting...` 完成
2. 等待压缩完成，运行：
   ```
   /tree
   ```
   观察应当有一个 `compaction` 节点
3. 运行：
   ```
   /fork
   ```
   （或者 `/fork <label>`；default fork 从当前 leaf）
4. 切到新 session，运行：
   ```
   /tree
   ```

### 预期
- fork 出的新 tree 包含原 compaction 节点的副本
- 新 session 继续对话时，LLM 能引用到 compaction 前已读的文件（意味着 attachments 跟过来了）

### 反例红旗
- fork 后 LLM "忘掉"已读文件的内容（attachments 丢失）
- fork 后 `/tree` 报错或 compaction 节点消失

---

## TC-072-002 — `/rewind` 落在 compaction 的派生视图包含 attachments

### 目的
确认 `getSessionMessagesFromLineage` 的 slicer 在 rewind 穿过 compaction 时仍前置 attachments。

### 步骤
1. 同 TC-072-001 触发一次真实压缩
2. 继续对话几轮
3. 运行：
   ```
   /rewind
   ```
   （或者 `/rewind <entry-id>` 指向那个 compaction entry）
4. 确认 REPL 状态栏 token 数下降（回到压缩后不久的状态）
5. 问一个需要引用已压缩上文的问题

### 预期
- LLM 能通过 summary + attachments 回答（不是 "I don't remember"）
- 状态栏 token 数合理（不应该是 0 或异常小）

### 反例红旗
- LLM 回答 "I don't have context" / "请提供更多信息"（attachments 未跟过 rewind）
- 状态栏 token 数不变或下降过多

---

## TC-072-003 — 长 AMA 反复 summary 失败仍 bounded growth

### 目的
这是 v0.7.18 →v0.7.19 的核心修复场景。Phase B 把 attachments 搬到 CompactionEntry 上，加上 Phase A 的 eviction 扩展，
保证多轮压缩后旧 island 的 attachments 真被 evict。

### 步骤
1. 进入一个大仓库（>= 50 文件），准备一个会触发多轮读取的 AMA 任务：
   ```
   /ama 帮我审查这个项目里所有 *.ts 文件，逐个分析、整理成一份 deep-dive review
   ```
2. 观察 REPL 状态栏的 `context tokens` 数字
3. 让它跑 5-10 轮以上

### 预期
- 每次压缩后 token 数应当回落到触发阈值以下
- 长时间后 token 数应在上下波动，**不单调增长**到 180k+
- `/tree` 查看 lineage entries 数量不爆炸

### 反例红旗
- token 数持续单调增长
- 多次压缩后状态栏数字始终在高位
- `/tree` 显示几十上百个 CompactionEntry 都挂着 attachments（evict 失效）

### 自动化守卫
Phase A 的 `evictOldIslandMessageContent strips postCompactAttachments on old-island compaction entries` 测试已自动守护此类累积。

---

## TC-072-004 — Worker scope 不污染 parent token count

### 目的
Phase C 给 worker 的 `onIterationEnd` 加了 `scope: 'worker'`，REPL 应当跳过 `context.contextTokenSnapshot` 写入；
只更新 live display。

### 步骤
1. 进入一个中等规模仓库
2. 触发 AMA 任务（H2 harness），看 Scout + Planner + Generator + Evaluator 协同
3. 在 worker 跑的过程中（状态栏显示 `[Scout] ...` / `[Generator] ...`），**记录** 状态栏的 `live token` 数字（会跟着 worker 变化——预期行为）
4. worker 结束后，状态栏的 `context tokens` 应当回到 **parent REPL** 的数字，不应停留在 worker 的数字

### 预期
- Worker 运行期间 live token 反映 worker 上下文
- Worker 结束后 context snapshot 立刻反映 parent 的上下文（不等 finally-block 补偿）

### 反例红旗
- Worker 结束后 context token 卡在 worker 的数字不动
- Context token 数字上下乱跳

### 自动化守卫
`packages/coding/src/task-engine.test.ts`:
- `FEATURE_072: createWorkerEvents scope tagging > tags forwarded onIterationEnd with scope: worker`
- `... does NOT forward onIterationEnd when emitIterationEvents is false`

---

## 已自动验证项目

Phase A/B/C 已包含以下自动测试（全部在 `npm test` 的默认运行路径内）：

### `getContextMessagesForEntry` 1-to-1 contract 守卫（Phase A）
`packages/agent/src/session-lineage.test.ts`:
- `FEATURE_072: postCompactAttachments and slicer-layer emission > getContextMessagesForEntry contract: every entry in the active path produces ≤1 message (073 prerequisite)`

### Slicer-layer attachment emission（Phase A）
- `slicer inlines attachments for non-rewind compaction entries`
- `slicer skips attachments for rewind-marker compaction entries`

### Defensive strip in applySessionCompaction（Phase B）
- `FEATURE_072 Phase B: ... applySessionCompaction defensively strips inline [Post-compact:] messages from compactedMessages`

### applyLineageTruncation helper（Phase B）
- `... applyLineageTruncation reconciles lineage against trimmed messages without appending a CompactionEntry`

### 500-entry lineage p95 benchmark（Phase B）
- `... benchmark guard: getSessionMessagesFromLineage on 500-entry lineage completes quickly`

### Eviction strips attachments（Phase A）
- `evictOldIslandMessageContent strips postCompactAttachments on old-island compaction entries, preserves memorySeed and summary`

### Fork preserves attachments（Phase A）
- `forkSessionLineage carries postCompactAttachments to the new branch via cloneForkableEntry`

### Microcompact immutability（Phase A）
`packages/agent/src/compaction/microcompaction.test.ts`:
- `FEATURE_072 regression guard: microcompact must never mutate in place > returns a new array when at least one message is trimmed`
- `... trimmed messages are new object references (no in-place mutation)`
- `... untrimmed messages may share references (memory optimization is permitted)`

### Worker scope tagging（Phase C）
`packages/coding/src/task-engine.test.ts`:
- `FEATURE_072: createWorkerEvents scope tagging > tags forwarded onIterationEnd with scope: worker when emitIterationEvents is enabled`
- `... does NOT forward onIterationEnd when emitIterationEvents is false`

---

## 跨 Feature 互动核查

### 与 v0.7.19 surgical fix 的关系
- **P1-P3、P5**：继续有效，未受 072 影响
- **P4**（`injectPostCompactAttachments` 内部的 string-prefix strip）：agent.ts 侧仍保留作为 belt-and-suspenders；新增的 `applySessionCompaction` 内防御性 strip 是结构性补充
- **P6**（REPL finally-block snapshot 重置）：现在主要重置 live display；其 snapshot 那行在 Phase C scope gate 后冗余但无害

### 与 FEATURE_073 的契约
- `getContextMessagesForEntry` 继续保持 1-to-1
- attachments 在 slicer 层前置
- FEATURE_073 可以直接在此基础上升级 slicer 切片逻辑，无需回退 072

---

## 退出条件

全部 TC-072-001 到 TC-072-004 通过 + 所有自动化测试全绿 = v0.7.20 可发布。

如有任一红旗情况，优先标记为 `v0.7.20` 的 `KNOWN_ISSUES`，
根据严重性决定是 block release 还是同步补 bugfix。
