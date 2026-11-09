# FEATURE_124 v0.7.43 — Memory System Alignment 人测指引

> **目的**：验证 (1) per-project 隔离的 memory 目录解析正确；(2) MEMORY.md 索引被注入 system prompt 的正确位置；(3) memory-rules 教学文本被注入；(4) `/memory` slash 命令的 list/rebuild/open/help 子命令正确工作；(5) LLM 在收到含 memory 教学的 SP 时能写入/读取/不重复写 memory（smoke eval 行为验证）。
>
> **前置**：
> - KodaX v0.7.43 已构建（`npm run build`）
> - 测试在任意 git 仓库下做（KodaX 自身仓库即可）
> - smoke eval 部分需要 `ARK_CODING_API_KEY` 或 `ZHIPU_API_KEY` 至少一个（无 key 自动 skip）

---

## Test 1 — Per-project memory 目录解析

### 步骤

1. 在 KodaX 仓库根目录下运行：
   ```bash
   node --eval "import('@kodax-ai/agent').then(m => console.log(m.resolveMemoryRoot(process.cwd())))"
   ```
2. 切到任意没有 git remote 的临时目录（比如新建一个 `mkdir /tmp/no-git && cd /tmp/no-git`）再跑同样命令。

### 期望结果

- Test 1.1 输出形如 `~/.kodax/projects/github.com-icetomoyo-kodax/memory`（用 git remote 解析的 sanitized key）。
- Test 1.2 输出形如 `~/.kodax/projects/local-<16-hex>/memory`（无 git remote 时退到 hashCwd 兜底）。
- 同一个 git remote 仓库无论在 worktree 1 还是 worktree 2 解析出的 path **一致**（key 来自 remote URL 不来自路径）。
- 不同 cwd 解析出 **不同** 的 path（per-project 隔离）。

### 失败排查

| 现象 | 诊断 |
|---|---|
| 输出未含 `projects/` 段 | Phase A `paths.ts` 未生效 — 跑 `npm run build` |
| 两个不同仓库返回同一路径 | `sanitizeProjectKey` 边界 bug — 报 issue 附上两边的 git remote URL |

---

## Test 2 — System prompt 注入位置

### 步骤

1. 启动 KodaX，发任意一条用户消息：
   ```
   你能看到哪些 memory 相关的指令？引用原话给我看。
   ```
2. （也可以 transcript 抓 system prompt 看）

### 期望结果

- Test 2.1 LLM 回复中能找到 `Types of memory` / `user / feedback / project / reference` / `Two-step process` / `Before recommending from memory` / `Memory and other forms of persistence` 这些 section 标题。
- Test 2.2 LLM 能复述 memory 目录路径（应该跟 Test 1.1 输出一致）。
- Test 2.3 顺序：`project-agents` (AGENTS.md) → `memory-rules` (教学文本) → `project-memory` (MEMORY.md 当前索引) → `skills-addendum`。

### 失败排查

| 现象 | 诊断 |
|---|---|
| LLM 说看不到 memory 指令 | Phase B/C 注入未生效 — 跑 `npx vitest run packages/coding/src/prompts/memory-rules.test.ts tests/memory-prompt-injection.test.ts` 看哪个测试 fail |
| memory 教学出现位置不对（在 skills 后面 etc.）| sections.ts 的 order field 漂移 — 看 `'memory-rules'.order` 是否还是 150 |
| LLM 复述的路径不是当前 cwd 解析出来的 | `resolveMemoryRoot(executionCwd)` 在 capability-sections 里被传错 cwd — 看 capability-sections.ts hook 处 |

---

## Test 3 — `/memory list`（空状态）

> Current `v0.7.85` behavior is superseded by FEATURE_292: `/memory` reads the
> governed accepted-Memory state, while `MEMORY.md` is only a derived projection.

### 步骤

1. 在一个没有写过 memory 的临时项目（或先 `rm -rf ~/.kodax/projects/<key>/memory/`）启 KodaX。
2. 输入 `/memory`（或 `/memory list`）。

### 期望结果

```
[memory] accepted Memory
  No accepted memories yet.

  0 accepted; 0 topic files
  storage: <agentConfigHome>/projects/<key>/memory
```

### 失败排查

| 现象 | 诊断 |
|---|---|
| `/memory` 命令不存在 | 注册漏掉 — 看 `packages/repl/src/interactive/commands.ts` BUILTIN_COMMANDS 是否含 `memoryCommand` |
| 路径显错 / 含 NaN | Phase A `paths.ts` 边界 bug — 跑 `packages/agent/src/memory/paths.test.ts` |

---

> FEATURE_292 update: the ordinary surface is natural language plus `/memory list`,
> `remember`, `forget`, `decisions`, `show`, `approve`, `reject`, `doctor`, and
> `open`. `open` launches the external editor/file browser. `rebuild` is a hidden
> compatibility repair for the derived `MEMORY.md` projection only and is
> intentionally absent from help and completion.

## Test 4 — `/memory rebuild`

### 步骤

1. 在 memory 目录下手动放几个 topic 文件（伪造一个 LLM 写过的状态）：
   ```bash
   MEM_DIR=$(node --eval "import('@kodax-ai/agent').then(m => process.stdout.write(m.resolveMemoryRoot(process.cwd())))")
   mkdir -p "$MEM_DIR"
   cat > "$MEM_DIR/feedback_test1.md" <<'EOF'
   ---
   name: Test feedback A
   description: Test feedback entry A
   type: feedback
   ---

   Body A.
   EOF
   cat > "$MEM_DIR/user_role.md" <<'EOF'
   ---
   name: User role
   description: Backend engineer
   type: user
   ---

   Body B.
   EOF
   # 故意做一个没有 frontmatter 的文件
   echo "no frontmatter at all" > "$MEM_DIR/broken_one.md"
   ```
2. 启 KodaX，跑 `/memory rebuild`。

### 期望结果

- 输出：`rebuilt MEMORY.md with 3 entries (newest first).`
- 有 warning 段提到 `broken_one.md` 没有可解析的 frontmatter。
- `cat $MEM_DIR/MEMORY.md` 显示 3 行：
  - 第 1 行：mtime 最新的文件（`broken_one.md` 因为最后创建，**应该排第一**，title 用 filename fallback）
  - 第 2 行：`user_role.md`
  - 第 3 行：`feedback_test1.md`
- Topic 文件本身**没被改动**（用 `git diff` 或 mtime 验证 — rebuild 只写 MEMORY.md）。

### 失败排查

| 现象 | 诊断 |
|---|---|
| `rebuilt MEMORY.md with 0 entries` | `readTopicFiles` 把 .md 过滤错了 — 看 memory-command.ts 排除规则 |
| 排序不是 mtime desc | `sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)` 排错向 |
| broken_one.md 没出现在 index | 排除逻辑错把 malformed 也过滤掉了 — 看 `parseOk` 流程，malformed 文件应该 fallback 而不是 drop |

---

## Test 5 — `/memory open`

### 步骤

1. 跑 `/memory open`。

### 期望结果

```
[memory] open these paths in your editor:
  index : <absolute path to MEMORY.md>
  dir   : <absolute path to memory dir>
```

注意：KodaX **不** 自动 spawn `$EDITOR`（CLI-first 原则）。把路径打出来给用户在外部编辑器开就够。

### 失败排查

| 现象 | 诊断 |
|---|---|
| KodaX 试图 spawn 编辑器 | 设计稿写错了 — 看 memory-command.ts `openMemory` |

---

## Test 6 — Smoke eval（LLM 行为验证，可选）

### 步骤

1. 设至少一个 API key：
   ```bash
   export ARK_CODING_API_KEY=<key>
   # 或
   export ZHIPU_API_KEY=<key>
   ```
2. 跑：
   ```bash
   npx vitest run -c tests/config/vitest.eval.config.ts tests/memory-smoke.eval.ts
   ```

### 期望结果

- 12 个 cell（2 alias × 3 case × 2 run）跑完。
- 整体 PASS rate ≥ **8/12（67%）** 视为 smoke ACCEPT。
- 单 case 期望：
  - S1 (write): 模型在收到 feedback 用户消息后会 Write 一个 `feedback_*.md` 到 memory dir。**floor model（zhipu）可能 1/2 通过**，是已知 intent-vs-action floor。
  - S2 (read): 模型在回答 stack 问题前会 Read/Grep memory dir。两个 alias 都应该 ≥ 1/2。
  - S3 (no-duplicate): 模型不会创建跟现有 feedback 重名/重复的文件。两个 alias 都应该 ≥ 1/2。
- Dump 文件路径会打印到 stdout，可以人工 spot-check raw tool_call。

### 失败排查

| 现象 | 诊断 |
|---|---|
| 测试整体 skip（"no provider API keys"）| 确认设了 ARK_CODING_API_KEY 或 ZHIPU_API_KEY 中至少一个 |
| 某 cell timeout | 单 cell 限时来自全局 900_000ms ÷ 12 ≈ 75s/cell，正常 < 30s；timeout 多半是 provider 那端慢 — 重跑 |
| 整体 < 50% pass | memory-rules prompt 有问题 — 看 raw dump 里 LLM 的 reasoning 文本，常见是模型没识别出 path 应该落在 memory dir。**这是 prompt iteration 信号，不是 ship blocker**（per design 注释） |

**Note**: 这是 SMOKE TEST，不是 SHIP-gate。Substrate 强保证（Phase A/B/C/D 共 68 个确定性单元 + 集成测试）已经覆盖 path 解析 / frontmatter 解析 / 截断 / SP 注入 / 顺序 / 命令逻辑。

---

## Test 7 — 跨 session 持久化

### 步骤

1. 启 KodaX，告诉它："请记住：项目用 Go + PostgreSQL，团队偏好 idiomatic Go 写法。"
2. 等模型说"已记住"或类似回应（应该看到 Write/Edit 工具调用）。
3. 退出 KodaX (`/exit`)。
4. 重新启 KodaX，发新消息："这个项目用什么技术栈？"

### 期望结果

- 步骤 2：模型应该 Write 一个 `user_role.md` 或 `project_*.md` 到 memory dir，然后 Edit MEMORY.md 加索引行。
- 步骤 4：新 session 起来后模型能引用 step 1 提到的 Go + PostgreSQL（来自 system prompt 注入的 MEMORY.md + topic 文件）。

### 失败排查

| 现象 | 诊断 |
|---|---|
| 第二次起来模型说"没有相关信息" | SP 注入路径不对，cwd 解析在两次 session 不一致 — 看 step 1 写到哪个 dir vs step 4 读自哪个 dir |
| 第一次根本没写 | LLM 没识别 feedback/project 触发点 — smoke eval S1 case 应该会暴露这个 |

---

## Test 8 — InkREPL `[memory:<type>]` badge（**DEFERRED to v0.7.44+**）

设计稿原计划包含 transcript badge 用 `isAutoManagedMemoryFile()` 标注 memory dir 内的文件写入。**Phase D.2 决策延后** — 改 InkREPL.tsx (8800 行) + tool-display.ts + 影响 50+ golden snapshot 测试的风险，对一个纯展示增强不划算。Phase B/C/D.1 已构成完整能力闭环。

**Do not test in v0.7.43.**  v0.7.44+ 会和其它 transcript-render 改动一起做。

---

## 一键回归

```bash
# 单元 + 集成测试（确定性，无需 API key）
npx vitest run \
  packages/agent/src/memory \
  packages/coding/src/prompts \
  packages/repl/src/commands/memory-command.test.ts \
  tests/memory-prompt-injection.test.ts

# Smoke eval（需 API key）
ARK_CODING_API_KEY=<key> npx vitest run -c tests/config/vitest.eval.config.ts tests/memory-smoke.eval.ts
```

预期：单元+集成全绿（76 tests），smoke eval ≥ 8/12 cells PASS。
