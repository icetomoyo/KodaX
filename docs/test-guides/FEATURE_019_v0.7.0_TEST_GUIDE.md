# FEATURE_019 v0.7.0 测试指导

## 这份文档测什么

`FEATURE_019` 为 KodaX 引入了统一的 session lineage/tree 真相层，覆盖这几类能力：

- 从旧的线性 session 自动迁移到 tree/lineage 模型
- `/tree` 查看当前 session 树并切换 branch
- 用 label 作为轻量 checkpoint/bookmark
- `/fork` 从当前 branch 或指定节点导出新 session
- branch switch 时自动插入 branch summary，保证切回后上下文不丢
- 在 resume / tree switch / fork 时接入 provider guardrails
- Project Harness 的 checkpoint / session-tree 记录向通用 lineage 语义收敛

这份测试指导分成两部分：

1. 人工主流程验证
2. 已自动验证项目

如果只做一轮高价值手工回归，优先执行 `TC-019-001` 到 `TC-019-006`。

---

## 测试环境

### 前置条件

- 已在仓库根目录完成依赖安装
- 可以正常启动 REPL
- 本机至少有一个可用的 durable provider
  推荐：`openai` 或其他具备 full-history / durable session 语义的 provider
- 如需验证 guardrail block，准备一个 bridge / lossy provider
  推荐：`gemini-cli`

### 建议工作目录

在仓库根目录执行：

```powershell
cd C:\Works\GitWorks\KodaX
```

### 建议准备

- 记录本轮测试使用的 session id
- 测试过程中保留一个 durable provider 和一个 lossy provider，便于切换验证

---

## 人工测试用例

### TC-019-001：新 session 能落成统一 lineage，并可通过 `/tree` 看到树结构

优先级：高
类型：正向测试

前置条件：

- 使用 durable provider 启动 REPL

测试步骤：

1. 启动 KodaX REPL。
2. 输入一轮简单对话，例如：
   - `帮我列出当前仓库的 packages`
3. 再输入第二轮，例如：
   - `再总结一下和 session 相关的目录`
4. 执行：
   - `/tree`

预期结果：

- [ ] 对话可以正常完成并自动保存
- [ ] `/tree` 能输出 ASCII tree
- [ ] 树上至少能看到当前 session 的 message 节点
- [ ] 当前 active path 有显式标记

---

### TC-019-002：`/tree <entry-id>` 切 branch 后会自动生成 branch summary

优先级：高
类型：正向测试

前置条件：

- 已完成 `TC-019-001`
- 当前 session 至少有两轮消息

测试步骤：

1. 先执行 `/tree`，记下第一个 user 节点或较早节点的 `entry-id`。
2. 执行：
   - `/tree <entry-id>`
3. 再执行：
   - `/tree`
4. 在新 branch 上继续提一个新问题，例如：
   - `换一个角度，给我按职责划分这些目录`
5. 再执行一次：
   - `/tree`

预期结果：

- [ ] 切 branch 后命令执行成功
- [ ] 切换后当前消息数减少到目标 branch 对应上下文
- [ ] 新 active path 上会出现一个 `branch` / `branch_summary` 类型节点
- [ ] 继续对话后，这个 branch summary 不会消失
- [ ] 新回答建立在“回到旧分叉点再继续”的语义上，而不是污染原 branch

---

### TC-019-003：label 可作为轻量 checkpoint/bookmark 使用

优先级：高
类型：正向测试

前置条件：

- 当前 session 已存在至少一个可见 tree 节点

测试步骤：

1. 执行 `/tree`，记下一个节点的 `entry-id`。
2. 执行：
   - `/tree label <entry-id> checkpoint-a`
3. 再执行：
   - `/tree`
4. 再执行：
   - `/tree checkpoint-a`
5. 执行：
   - `/tree unlabel checkpoint-a`
6. 再执行：
   - `/tree`

预期结果：

- [ ] label 设置成功
- [ ] `/tree` 中该节点显示 `[checkpoint-a]`
- [ ] 可以直接通过 label 名称切过去
- [ ] `unlabel` 后该 label 消失

---

### TC-019-004：`/fork` 能把当前 branch 导出成新 session

优先级：高
类型：正向测试

前置条件：

- 当前 session 已存在可 fork 的 branch 或 label

测试步骤：

1. 记下当前 session id。
2. 执行：
   - `/fork`
   或
   - `/fork checkpoint-a`
3. 观察 REPL 输出的新 session id。
4. 在 fork 后的新 session 里继续提问一轮。
5. 再执行：
   - `/sessions`

预期结果：

- [ ] `/fork` 成功创建新 session
- [ ] 当前 REPL 会切到新的 session id
- [ ] 新 session 中继承了被 fork branch 的上下文
- [ ] 在新 session 的继续操作不会回写污染旧 session
- [ ] `/sessions` 中可以看到新旧两个 session

---

### TC-019-005：`/load` 能恢复 durable provider 下的已保存 session

优先级：高
类型：正向测试

前置条件：

- 已保存至少一个 session
- 当前使用 durable provider

测试步骤：

1. 记下一个已有 session id。
2. 执行：
   - `/load <session-id>`
3. 执行：
   - `/tree`
4. 再继续提问一轮。

预期结果：

- [ ] session 能成功恢复
- [ ] 恢复后 message 数量正确
- [ ] `/tree` 能看到对应 lineage
- [ ] 继续提问后可以在原有 lineage 上继续 append / branch

---

### TC-019-006：lossy provider 会在 load / tree switch / fork 上被 guardrail 阻断

优先级：高
类型：负向测试

前置条件：

- 已存在一个可恢复 session
- 当前 provider 切到 `gemini-cli` 或其他 lossy/stateless provider

测试步骤：

1. 执行：
   - `/load <session-id>`
2. 执行：
   - `/tree <entry-id>`
3. 执行：
   - `/fork`

预期结果：

- [ ] REPL 输出 provider guardrail 提示，而不是误报 “not found”
- [ ] 对 block 场景不会真的执行 load / switch / fork
- [ ] 提示中明确说明当前 provider 不具备 durable/full-history session 语义

---

### TC-019-007：旧 linear session 能被兼容读取并迁移

优先级：中
类型：边界测试

前置条件：

- 准备一个旧格式 JSONL session 文件

测试步骤：

1. 把旧格式 session 放到 session 存储目录。
2. 执行：
   - `/load <legacy-session-id>`
3. 执行：
   - `/tree`
4. 在该 session 上继续对话一轮，再退出并重新加载。

预期结果：

- [ ] legacy session 能被正常读取
- [ ] 加载后能生成 lineage/tree
- [ ] 后续保存不会破坏旧数据的可恢复性

---

### TC-019-008：Project Harness 会写入通用 lineage 语义记录

优先级：中
类型：集成测试

前置条件：

- 项目内可运行 project harness 相关流程

测试步骤：

1. 启动一个会触发 Project Harness 的流程。
2. 让 harness 至少完成一轮 checkpoint / session node 落盘。
3. 检查 `.agent/project` 相关输出文件。

预期结果：

- [ ] checkpoint 记录存在
- [ ] session-tree 记录存在
- [ ] 记录中包含通用 lineage 语义字段，如 `id` / `taskId` / `parentId`
- [ ] harness 仍保持原有 feature/run 追踪能力

---

## 边界与回归关注点

### BC-019-001：branch summary 不能在下一次 save 时被冲掉

- 做一次 `/tree <old-entry-id>` 触发 branch summary
- 继续对话 1 到 2 轮
- 再次 `/tree`
- 预期：branch summary 仍保留在 active path 中

### BC-019-002：guardrail block 不能误报成资源不存在

- 在 lossy provider 下执行 `/load`、`/tree <id>`、`/fork`
- 预期：看到 provider guardrail 提示，而不是 `Session not found` 或 `Tree entry not found`

### BC-019-003：session 手动保存不能丢 extension state / records

- 在具备 extension runtime 的场景下对 session 做手动 save
- 预期：后续恢复时 extension state / records 仍在

---

## 可自动验证项

下面这些内容已经可以自动测试，本次改动已实际执行：

### 自动验证范围

- lineage helper 行为
- branch summary 持久化
- file session storage 迁移与 fork / label / branch switch
- `/tree` 与 `/fork` 命令路由
- provider guardrails
- project storage / harness 的 lineage 语义收敛
- 与 `034` runtime 持久化链路的兼容性
- TypeScript 构建

### 已执行命令

```powershell
pnpm exec vitest run packages/agent/src/session-lineage.test.ts packages/repl/src/interactive/storage.test.ts packages/repl/src/interactive/session-tree-command.test.ts packages/repl/src/interactive/session-guardrails.test.ts packages/repl/src/interactive/project-storage.test.ts packages/repl/src/interactive/project-harness.test.ts packages/repl/src/interactive/project-commands.test.ts packages/repl/src/interactive/provider-capabilities.test.ts packages/repl/src/interactive/compaction-command.test.ts packages/coding/src/agent.extension-runtime.test.ts
```

```powershell
npx tsc -b packages/agent packages/coding packages/repl
```

### 自动验证结果

- 测试文件：10 个
- 测试用例：82 个
- 结果：全部通过
- TypeScript 构建：通过

### 自动验证覆盖到的核心文件

- `packages/agent/src/session-lineage.ts`
- `packages/repl/src/interactive/storage.ts`
- `packages/repl/src/interactive/commands.ts`
- `packages/repl/src/interactive/repl.ts`
- `packages/repl/src/interactive/session-guardrails.ts`
- `packages/repl/src/interactive/project-storage.ts`
- `packages/repl/src/interactive/project-harness-core.ts`

---

## 测试总结模板

| 用例数 | 通过 | 失败 | 阻塞 |
|---|---:|---:|---:|
| 8 |  |  |  |

测试结论：

- [ ] 可发布
- [ ] 需修复后复测
- [ ] 存在阻塞项

发现的问题：

- 待测试人员填写

---

生成时间：2026-03-26
Feature ID：019
Version：v0.7.0
