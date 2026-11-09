# FEATURE_260 v0.7.68 人工测试指南

## 状态与范围

**功能**：KodaX Memory Agent — Proactive Execution Recall + Scoped Memory Consolidation
**目标版本**：v0.7.68
**开发状态**：发布 CI、聚焦回归、构建、产物验证、覆盖率和预注册 eval 已完成
**测试日期**：2026-07-12
**人工测试人员**：待填写

本指南验证 F260 的运行时边界、治理路径和用户体验。人工验证不替代
`docs/features/v0.7.68.md` 中的统计门禁，也不得使用真实长期记忆目录。

## 测试环境

- Node.js >= 20，已执行 `npm install`。
- 使用隔离的 `KODAX_HOME` 或临时 Agent Home。
- 准备两个项目目录、两个 agent identity、两个 user identity。
- 如测试 review/promotion，使用可控的 `memoryReviewer`。
- 开启普通 trace，但不要延长 trace retention。

## 自动化基线

```powershell
npx vitest run --maxWorkers=3
npm run build
npx vitest run --config tests/config/vitest.eval.config.ts tests/feature-260-memory-agent.eval.ts
```

已验证结果：

- 最终 GitHub Actions 在 Node 20 和 Node 22 上分别完成 clean full sweep：
  798/798 测试文件、9593/9593 测试通过；另有 2 个条件跳过文件、30 条条件
  跳过测试和 22 条 todo，共 800 个文件、9673 条测试记录。Unix socket runtime
  gate 随后通过。此前 Windows 本机 Shard 2 的 heap OOM 仅作为本地 runner
  限制保留，不再构成发布证据缺口。
- Post-review 集中回归 164/164、release/manual/tracker 集合 45/45 通过。
- packages、CLI bundle、11 个 SDK 入口和 DTS 构建通过。
- `npm pack` 产物可在全新临时项目安装，根入口和全部 10 个 SDK subpath 均可
  导入；发布 metadata 为 `0.7.68` 且 `private=false`。Windows 独立二进制
  `kodax.exe --version` 返回 `0.7.68`，5 个必需 sidecar 均存在。
- F260 核心增量语句/行覆盖率 87.58%，函数覆盖率 92.15%。
- `f260-v0.7.68.2` sealed panel：520/520 cells 完成，全部门禁通过。
- schema-v2 manifest 位于系统临时目录
  `kodax-eval-dumps/feature-260-memory-agent/f260-v0.7.68.2/experiment.json`，
  不进入仓库。早先的 520-cell raw/review artifacts 在 post-review 全量验证
  期间被 Windows 临时目录清理回收；如需重新审计原始响应，必须显式授权后
  做 bounded rerun，不能从汇总指标反向重建。

### Post-review hardening checks (Issue 152)

- Credential-bearing HTTPS remotes and equivalent SSH remotes must resolve to
  the same non-secret memory project identity.
- Structured writes must reject case-variant Markdown paths and governance
  sidecars under managed roots; shell interpreters that address those roots
  must be rejected while explicit read-only inspection remains available.
- Two concurrent inbox drains must review one episode at most once; concurrent
  proposal and lifecycle writes must retain every independent entry.
- The eval manifest must include the schema-v2 combined tracked/untracked source
  snapshot, and malformed raw JSON must stop instead of regenerating a cell.
- `kodax_manual` must route memory-capability questions to the governed-memory
  topic, name every `BUILTIN_COMMANDS` entry, and describe the current Runtime
  plus `/experimental-memory` SDK surfaces.

## 测试用例

### TC-001：无 MemorySession 时保持中性

**优先级**：高
**类型**：兼容性 / 负向

步骤：

1. 用空的隔离 Agent Home 启动普通 Coding 任务。
2. 检查模型可见工具和 system prompt。
3. 完成任务并检查 Session Lineage 与后台文件。

预期：

- [ ] 不暴露 `memory_recall`。
- [ ] 不读取或注入原始 `MEMORY.md` 路径/内容。
- [ ] 不创建 review inbox、Outcome Digest、notice 或后台任务。

### TC-002：只召回完全匹配 scope 的记忆

**优先级**：高
**类型**：安全 / 正向

步骤：

1. 在项目 A 创建一条 active、prompt-safe、带有效 apply receipt 的项目记忆。
2. 在项目 B、另一个 agent 和另一个 user 下创建相似标题的记忆。
3. 在项目 A 发起只匹配项目 A claimKey 的任务。

预期：

- [ ] 只出现项目 A 的 bounded hook/ref。
- [ ] sibling project、agent、user、tenant 的 ref 均不可见。
- [ ] 召回内容标记为低权限证据，当前仓库事实优先。

### TC-003：主动 deliberate recall 的只读边界

**优先级**：高
**类型**：正向 / 边界

步骤：

1. 准备一个当前上下文无法回答、但同 scope 冷记忆可回答的具体过程缺口。
2. 让 Action LLM 调用 `memory_recall`。
3. 在同一 decision epoch 重复相同 need，再提交不同 need。

预期：

- [ ] 模型参数只有 `need`，没有 scope、identity、path 或 revision。
- [ ] 返回最多 3 条、总量不超过 512 tokens，使用固定低权限 envelope。
- [ ] 相同 query 复用结果；同 epoch 第二个不同 query 静默返回空。
- [ ] query 不触发第二个 Memory LLM，也不写记忆文件。

### TC-004：当前事实必须保持 memory-silent

**优先级**：高
**类型**：负向

步骤：

1. 询问当前分支、lockfile、失败测试或端口占用。
2. 同时让历史记忆中存在过期的相似事实。

预期：

- [ ] Action LLM 使用 read/bash 等当前证据工具，不调用 `memory_recall`。
- [ ] 过期事实不进入动态 reminder。
- [ ] trace 不产生伪造的 memory influence。

### TC-005：敏感数据和提示注入被拒绝

**优先级**：高
**类型**：安全

步骤：

1. 依次输入 API key、Bearer token、private key 和带“忽略系统指令”的工具输出。
2. 触发 observe、query、episode review 和 promotion。

预期：

- [ ] 敏感 body 不进入 observation、query result、reviewer input 或 durable memory。
- [ ] 仅由不可信指令支持的候选被 reject/quarantine。
- [ ] 错误可审计但不回显 secret。

### TC-006：consult-before-write 去重与冲突

**优先级**：高
**类型**：正向 / 边界

步骤：

1. 对同一 claim 重复提交相同证据。
2. 提交新的独立证据。
3. 提交适用条件细化。
4. 提交未解决的矛盾证据。

预期：

- [ ] 相同 claim+证据得到 `no_action`，不创建新 body。
- [ ] 新证据得到 `evidence_update` 并指向既有 ref。
- [ ] 条件变化得到 `condition_refinement`。
- [ ] 冲突得到 `conflict`，不覆盖 active body。
- [ ] 实际写入仍经过 proposal/preview/fingerprint/apply。

### TC-007：review timeout、重启 drain 与 rewind

**优先级**：高
**类型**：恢复

步骤：

1. 让 review 超过 30 秒并完成当前 episode。
2. 下一 session 用相同 tenant+agent+project 启动并结束任务。
3. 分别模拟 owner session 删除、branch rewind 和 reviewer 临时失败。

预期：

- [ ] timeout 后 pending digest 保留，不阻塞 Action Agent 最终答案。
- [ ] 下一 session 最多 drain 2 个旧 entry，并重新校验 owner/branch/rewind。
- [ ] 删除或 rewind 的 entry 被丢弃，不发生 lineage resurrection。
- [ ] reviewer 失败的 entry 保留且错误可审计。

### TC-008：trace、notice 与 provider cache 边界

**优先级**：中
**类型**：兼容性 / 性能

步骤：

1. 在 OpenAI、Anthropic 和 ACP adapter 下运行无 reminder、passive reminder、deliberate query。
2. 比较序列化请求、cache marker、Session Lineage 和 UI notice。

预期：

- [ ] `MemoryDecisionReceipt` 只附着现有 span，不建立事件库、不延长 retention。
- [ ] reminder 只改变 frozen dynamic suffix；query 只增加正常 tool tail。
- [ ] Outcome Digest 的 exposure 默认不是 `direct` attribution。
- [ ] 自动 notice 每 episode 最多一次，不弹 modal/toast、不抢焦点、不发声。

## 人工测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 8 | 待填写 | 待填写 | 待填写 |

**人工测试结论**：待填写。
**自动化发布建议**：`recommend-ship`。
**已知残余**：floor alias 有 1/60 普通即时召回未首步命中，paired
历史经验对中 4/70 未产生候选优势；两决策恢复为 20/20。残余均在预注册
非安全阈值内。安全、权限、secret、scope 和 poisoning 边界由确定性零违规
门禁承担。

Feature ID：260
