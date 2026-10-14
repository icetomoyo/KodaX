# KodaX 首个真实 SDK request：离线 wire 分账

本次补齐 KodaX 自身的 provider 序列化证据：固定 baseline `bd4479d59cab3d082f07c2d34681fff198d82fa0` 与当前未提交 candidate，各运行 16 个场景。两边各 16 个主请求均成功；外部网络调用、真实模型调用、工具执行均为 0。**这不是跨产品总量比较，也不是 provider BPE / API usage / 界面上下文读数。Codex Rust 的同条件真实 request capture 仍未完成。**

## 方法与边界

- 可复运行入口：`npx vitest run tests/first-turn-wire-inventory.test.ts`。测试使用生产 `runKodaX` / `runManagedTask`、真实 custom-provider OpenAI / Anthropic SDK，捕获最终 `fetch` 的 JSON body；没有手写 coding tool schema，也没有覆盖 provider.stream。每个主请求返回一次合成的终止 SSE，无工具调用。
- `empty`：空工作目录、空外部 home、无外部指令/skills/MCP/history，裸 public Coding SDK。固定 `repoIntelligenceMode:off`、`lsp:false`、reasoning off；保留生产构建器实际选择的工具。
- `agents`：在 empty 上增加同一份短 AGENTS fixture，使用生产 AGENTS loader。
- `catalogs`：在 agents 上增加一个固定 skill metadata，经生产 `formatSkillsSystemPrompt` 渲染；以及一个磁盘 MCP 缓存条目，经真实 `McpCapabilityProvider` 渲染。MCP 不启动进程、不发现网络能力，catalog 不能证明 live availability。Skill 完整正文未加载。
- `runtime-host`：空外部 home/workspace，经真实 `createKodaXRuntime({sharedDaemonHost:true}) → createCliClientPlane → runClientPlaneRound`。会话选定 SA/AMA、full-access，其余 Host 能力由生产 Runtime 绑定；不是手写 callbacks 模拟默认 Host。真实默认内置 3 项 skill 目录、记忆、会话历史、LSP 等保留。因此它表示该显式 Session 权限下的 Runtime/REPL Host 场景，不代表用户任意配置的 CLI 默认值或 Codex desktop。
- 同时隔离 `setAgentConfigHome`、Runtime homeDir、`USERPROFILE`、`HOME`。早期只隔离 KodaX home 的探路批次读到了 OS 用户 skill 描述，已判无效；本文只使用完整 OS home 隔离后的下列两批。
- 每个 runtime-host 主轮结束后，还触发一个 `commit_episode_learning_review` 辅助请求。捕获其合成 body 后抛 AbortError 阻断，独立记录为 `auxiliaryBlockedRequests`；它不计入以下主轮总数，也不产生学习写入。
- UTF-8 bytes 为 SDK JSON 的精确体积；`estimatedTokens` 用同一 KodaX `countTokens` 算法，包含 JSON 表达成本。真实服务端 tokenization、缓存命中、价格与 UI 显示均未测。

## 原始证据

- candidate：`C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-wire-BvuZ9w/inventory.json`
- baseline：`C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-wire-64P8bv/inventory.json`
- 逐字段/规范化 schema 比较：candidate 同目录 `comparison.json`。
- 各 cell 子目录保留 `request.json`，每项均含字符数、UTF-8 bytes、SHA256、统一 token 估计、system/conversation/tools/controls 分账及工具名。只写独占 `mkdtemp` 子目录；没有清理共享 dump 根目录。
- 原始 payload 保留随机 fixture 路径、Session ID/时间，因此前后 body SHA 不应相等。随机路径部分等长，表中所有场景的差额重复一致。Schema 比较递归排序 object key、保留数组顺序；不修改原始 payload。唯一 schema 变化是 `ask_user_question` / `todo_update`；description 变化是四个 todo 工具；AMA 删除缺少 runner 的 `run_skill_script`。

## 主轮 JSON body 体积

| Protocol / mode / scenario | Baseline bytes | Candidate bytes | 减少 bytes | 统一估计 tokens：前→后 |
|---|---:|---:|---:|---:|
| OpenAI SA empty | 75,963 | 67,169 | 8,794 | 19,022→16,811 |
| OpenAI SA agents | 76,214 | 67,420 | 8,794 | 19,085→16,874 |
| OpenAI SA catalogs | 81,278 | 72,484 | 8,794 | 20,351→18,141 |
| OpenAI SA runtime-host | 90,552 | 81,758 | 8,794 | 22,723→20,512 |
| OpenAI AMA empty | 106,242 | 90,291 | 15,951 | 26,608→22,601 |
| OpenAI AMA agents | 106,494 | 90,543 | 15,951 | 26,671→22,664 |
| OpenAI AMA catalogs | 111,558 | 95,607 | 15,951 | 27,938→23,931 |
| OpenAI AMA runtime-host | 114,829 | 98,878 | 15,951 | 28,805→24,798 |
| Anthropic SA empty | 77,119 | 68,325 | 8,794 | 19,311→17,100 |
| Anthropic SA agents | 77,373 | 68,579 | 8,794 | 19,374→17,164 |
| Anthropic SA catalogs | 82,521 | 73,727 | 8,794 | 20,662→18,452 |
| Anthropic SA runtime-host | 91,649 | 82,855 | 8,794 | 22,997→20,787 |
| Anthropic AMA empty | 104,628 | 88,706 | 15,922 | 26,205→22,205 |
| Anthropic AMA agents | 104,883 | 88,961 | 15,922 | 26,268→22,268 |
| Anthropic AMA catalogs | 109,802 | 93,880 | 15,922 | 27,499→23,499 |
| Anthropic AMA runtime-host | 113,018 | 97,096 | 15,922 | 28,352→24,352 |

减少量在四类外部内容场景中一致。SA 的 8,794 bytes 全来自工具通道。AMA 的 system 减少 5,716 bytes、conversation 减少 184 bytes；工具通道减少 OpenAI 10,051 / Anthropic 10,022 bytes（包括不可执行的 skill script contract）。Control 字段未变。上述 delta 是此次整体 candidate 的量，不单独归因某一个句子。

## Candidate 实际分账（bytes）

各组件以独立 JSON fragment 计量；完整 body 另含字段名、分隔符等 framing，不把组件 token 估计强行相加成 API usage。

| Protocol / mode / scenario | system | conversation | tools | 工具数 |
|---|---:|---:|---:|---:|
| OpenAI SA empty | 13,659 | 63 | 53,318 | 46 |
| OpenAI SA runtime-host | 17,456 | 63 | 64,110 | 59 |
| OpenAI AMA empty | 25,464 | 1,347 | 63,351 | 58 |
| OpenAI AMA runtime-host | 26,086 | 4,549 | 68,114 | 65 |
| Anthropic SA empty | 13,697 | 125 | 54,414 | 46 |
| Anthropic SA runtime-host | 17,500 | 125 | 65,141 | 59 |
| Anthropic AMA empty | 25,502 | 1,409 | 61,706 | 58 |
| Anthropic AMA runtime-host | 26,124 | 4,617 | 66,266 | 65 |

说明：AMA 把动态上下文放入 user/context message；不能只读 system 字符数。实际 Host 与裸 SDK 的差值也不能归为“模型更费 token”；能力集合和默认内置目录不同。Runtime Host 本次没有绑定可执行 skillScriptRunner，候选两条路径均不暴露 `run_skill_script`。

## 运行与复现限制

Candidate 与 baseline 各 `1 test PASS`，分别包含完整 16 cell。Baseline 测试文件复制到 `C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-baseline-bd4479d/tests/`，使用 archive 自己的 Vitest 配置与精确 source aliases（llm/agent/coding/repl/runtime）；没有复制 candidate dist。archive 的 node_modules 已核查为指向当前 worktree 已安装依赖的 Junction，两处 package-lock SHA256 同为 `2CBF6F0AAD2376470C4F20C881EC633D619DE37395790C9896993B1A841FABEE`。

首次 archive 加载因 runtime build identity 扫描缺少旧 dist 而失败（0 tests）；随后 archive 内 `npx tsc -b tsconfig.build.json` 生成各包输出。该构建退出 1，诊断为 `packages/artifacts/src/document-render.ts:24` / `render.ts:65` 的 `DocumentInitParameters.isEvalSupported` 类型问题，未修改旧源码；不据此认定 baseline 产品 bug。llm/agent/coding/repl 输出均存在，实际捕获仍走 archive 源码 aliases，随后 16 cell 全通过。

本次没有运行 Codex Rust builder，未得到 Codex 同条件完整最终 wire；不得发布 KodaX/Codex 的首轮总量比值。也未证明任何 paid provider 的模型行为提升，需与独立行为评审证据合并判断。

## 同版本完整 model input 稳定性复核

第二轮 candidate 16 cell 全部通过。新 evidence：`C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-wire-IdxhgJ/inventory.json`，与首轮 candidate `BvuZ9w` 的四项 production source hash 先做相等断言，再逐 cell 比较**完整 SDK request JSON**的规范化 SHA256（包括全部 system/messages/tools/control 字段，不只比较 schema）。16/16 normalized hash 一致，16/16 原始 body 的 UTF-8 bytes 差为 0。原始 SHA256 仍因动态事实变化而不同；不能把 normalized equality 写成 raw byte equality。

重跑命令（PowerShell）：

```powershell
$env:KODAX_WIRE_COMPARE_INVENTORY='C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-wire-BvuZ9w/inventory.json'
npx vitest run tests/first-turn-wire-inventory.test.ts
```

规范化规则严格限制为本 fixture 已知的三个生成事实，原 body 和原 bytes 账单始终保留：

1. `mkdtemp` 返回的完整绝对 fixture root（仅该精确值及其正斜杠形式）替换为 `<FIXTURE_ROOT>`。不改盘符或所有路径，也不改任意相似字符串。
2. 仅 system/messages 字符串内、以 `Session Scratch Directory:` 开头且位于当前 fixture workspace 的 `.agent/tmp/sessions/` 下的 ID，替换为 `<SESSION_ID>`。新捕获还断言该值等于真实 `runtime.sessions.create` 返回的 ID；旧捕获从同一宿主生成事实行读取。出处：`packages/coding/src/prompts/capability-sections.ts:148`。
3. 仅 system/messages 内完整匹配 `Snapshot: filesystem @ <ISO timestamp>` 的生成事实行，把其 timestamp 替换为 `<FILESYSTEM_SNAPSHOT_TIME>`。出处：`packages/coding/src/repo-intelligence/index.ts:1142` 的 `overview.generatedAt`。其它日期、时间及用户正文不做一般化清除。

最后递归排序 JSON object keys，保留数组顺序、字符串其余内容、所有工具 description/schema；没有删除任意 hex、UUID、字段或能力。每个 row 的 `processedKeys` 精确记录发生替换的 JSON path、事实来源及原值；`repeatComparison.priorProcessedKeys` 记录旧输入的对应替换，`rawBytesDelta` 保留独立原始体积差。各 cell 的 `normalized-model-input.json` 可逐字复查。

实际 processed keys：裸 SDK 的 12 个 cell 仅 1 个 prompt 字符串字段替换 root；Host SA 为同一 prompt 字段中的 3 项事实；Host AMA 为 system 与 context message 合计 4 项记录（root 在两个字段出现，Session ID/time 各一项）。因此本次验证覆盖完整 model input 的**受控生成事实等价**，不覆盖 OS/Node 版本、生产源码或真实用户目录变更后的稳定性，也不宣称 post-turn learning-review 的动态证据包稳定。

补丁调试曾因传入旧 evidence 路径使用正斜杠而首次 hash 断言失败，统一 `path.resolve` 后完整 16 cell 通过；没有修改生产代码、重跑 baseline 或发起真实模型调用。
