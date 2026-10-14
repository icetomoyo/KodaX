# 首轮 token 优化：实施、E2E 与有限模型评估

日期：2026-10-14。基线：`bd4479d59cab3d082f07c2d34681fff198d82fa0`。本轮完成[主计划](codex-kodax-first-request-plan-2026-10-14.md)的 P1–P3 与 P0 的 KodaX 分账；P0 的 Codex Rust 同条件捕获仍未完成，P4–P6 仍是有条件的后续工作。最终全量测试已通过。实现与测试使用 implement/TDD；评估遵守 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md)，模型样本由主会话先盲审、后揭盲，没有模型 judge。

**工程建议：recommend-ship 当前 P0–P3。** 固定输入确实减少；当前代表性的下一响应对比未发现实质退化，但有少量计划组织和措辞差异。证据不足以证明全任务智能性能不下降或整体提升；延迟也没有一致改善。原 live SDK smoke 未通过，原因已定位为评测入口缺少生产 mutation host；基线同样拒绝，真实 Runtime 的生产模式零网络重放已验证执行成功。这两项结果分别保留。

## 1. 实际改变与保留的能力

### P0：测最终请求，不用界面百分比替代输入

新增[离线 wire inventory](../../tests/first-turn-wire-inventory.test.ts)：空目录、短 AGENTS、小 skills/MCP 目录、真实 Runtime Host 四种场景，交叉 SA/AMA 和 OpenAI/Anthropic，共 16 cells。经过实际 production builder、工具选取和 provider SDK 的最终 `fetch` JSON 序列化；捕获后返回合成 SSE，不联网、不调用真实模型、不执行工具。

真实 Host 场景经 `createKodaXRuntime → createCliClientPlane → runClientPlaneRound`，保留其内置 skills、记忆、会话和 LSP 等实际能力。学习辅助请求单独截获并阻断，不并入主轮。没有手工删工具来制造结果，也没有更改 KodaX 状态栏公式。[方法、逐项数据与复现](first-turn-wire-inventory-2026-10-14.md)。

Codex Rust 同条件最终 wire 尚未捕获，因此本文没有 KodaX/Codex 首轮总量比值。此前 Codex TUI 的 12K 展示扣除与 cached input 公式，仅解释显示口径；尚不能套用用户看到的 desktop 界面。优化收益来自实际内容变化。

收尾只读复核：参考 Codex 仍为 `c22a06c18070c3e33bd2648c7210a00a2a9f6f80`，pin Rust 1.95.0，本机只有 1.98.0，没有对应 target/test 产物；安装的 CLI `0.162.0-alpha.17.2` 无法证明对应该 commit。现有 mock WebSocket 脚本也缺 Python websockets 依赖。没有用不同版本 CLI 替换这项证据，没有下载工具链或启动真实 provider；完整捕获需后续独立构建 pinned Rust test 的 mock transport。

### P1：纠正工具合同和实际能力不一致

- `ask_user_question` 删除错误的顶层 required `question`，让既有合法 questions-only 分支进入真实 handler；删误入的 specialist `agent_id` 字段。非法空问仍由 handler 拒绝，回调/审批行为保留。
- 没有 skill runner 或 cwd 的 managed chain 不再展示 `run_skill_script`；其 exact search 与 deferred 目录 fallback 同步检查对应能力和 host 限制。已绑定 runner 的入口仍可使用，不按任务关键词猜测能力。
- 本批没有扩大为所有 tool_search 精确/关键词搜索的 policy 重构。最终 Spec 复查证实：其它原有 deferred 工具仍可能在受限 host 的 search 中出现，虽然 active table/describe 不提供它们。这是既有发现一致性缺口，不能宣称所有发现路径已完全对齐；实际执行权限没有被绕过。

### P2：模型只看增量 todo，SDK 保持兼容

新增私有纯函数[模型工具投影](../../packages/coding/src/tools/model-tool-definition.ts)，仅处理 `todo_update`：去掉模型 schema 的 `op/items` 及旧 init 前缀，要求 `id`，保留其它 required 约束、扩展字段和原始对象。SA resolver、managed chain/adapter、search/describe 复用同一投影。

原 registry 和 handler 仍支持 SDK/runner 的 legacy init；模型没有旧列表初始化教程。四个 todo descriptions 去掉重复 Fields/When To/例子，保留稳定 id、增量更新、用户语言、owner、状态/恢复、metadata merge/null、evaluator、unknown-id、hook/veto 等合同。没有改 todo store、状态机、完成 hooks 或权限。[TDD 与尺寸证据](p1-p2-implementation-evidence-2026-10-14.md)。

### P3：明确指令归属，按真实能力给 Worker 指导

删除 Worker 里已由工具 schema 承担的字段/JSON 教程、重复 routing 和调用签名、repo 工具长列表与多轮 WHEN/例子；保留简短的选择策略和义务。保留 plan-first 与 trivial 豁免、resume 复用、范围承诺、parallel-first、root 关键路径、写所有权、子树收尾、证据整合、read-first、最终验证和语言要求。

`ManagedRolePromptContext.availableToolNames` 取实际 `chain.worker.tools`，不是“本轮是否暂时展示”或任务分类。空/部分 repo、todo、协作能力有明确短分支，动态 review/Actor capacity/workflow 指引也不重新要求不存在的工具。没有新增用户配置或注入模式矩阵。

独立 `buildRunnerAgentChain → Runner.run` 在没有完整 promptContext 时，最小 fallback 也读取最终 worker.tools；read-only root/child、空集合和部分 todo/message 的真实 Runner 首请求已验证。完整 managed prompt 分支没有因此扩张。[义务映射、接线与测试](worker-prompt-p3-implementation-2026-10-14.md)。

read-first 强度差异、旧 SA plan approval、旧 role authority 文案没有借此重写。P4 低频工具/LSP 按需展示、P5 外部目录预算、P6 cache/control 仍需自己的切片证据，未随此次压缩混入。

## 2. 输入减少多少

### 真实最终 wire：精确 bytes 与项目统一估计

| 同条件请求 | Baseline bytes | Candidate bytes | 减少 | 项目 token 估计：前→后 |
|---|---:|---:|---:|---:|
| OpenAI SA 空目录 | 75,963 | 67,169 | 8,794（11.6%） | 19,022→16,811 |
| OpenAI SA Runtime Host | 90,552 | 81,758 | 8,794（9.7%） | 22,723→20,512 |
| OpenAI AMA 空目录 | 106,242 | 90,291 | 15,951（15.0%） | 26,608→22,601 |
| OpenAI AMA Runtime Host | 114,829 | 98,878 | 15,951（13.9%） | 28,805→24,798 |

四个外部内容场景各自的 delta 一致；Anthropic SA 同样减少 8,794 bytes，AMA 减少 15,922 bytes。SA 减量全部在 tools；AMA system 减少 5,716、conversation 减少 184、tools 减少 OpenAI 10,051 / Anthropic 10,022 bytes。控制字段未变。项目估计不是 API tokenization，不把独立 JSON fragment 的估算强行加成账单。

候选重复捕获 16/16 完整 request normalized hash 相等、原始 bytes 差为 0。规范化只处理确知 fixture root、真实 session scratch ID、filesystem snapshot time；保留其它文本、schema、description 和 controls。原 raw SHA 因动态事实不同仍不相等。完整规则与 processed keys 在[wire 报告](first-turn-wire-inventory-2026-10-14.md)。

纯组件量尺中，五个受影响 ask/todo 工具合计减少 2,212 项目估计 tokens；Worker fragment 6,076→4,880；role stable+context 6,910→5,515。它们不是可直接叠加的完整请求账单。真实 Host 没有可执行 skillScriptRunner，移除该工具的收益只属于没有 runner 的场景。

### 已有 provider 的实际 API input usage

| Route / 对比轴 / case | 前→后 input tokens | 减少 | output 前→后 | 单次延迟 ms 前→后 |
|---|---:|---:|---:|---:|
| zhipu-coding / GLM-5.3-flash / P2 / 计划 | 23,595→21,488 | 2,107 | 197→168 | 6,763→6,470 |
| zhipu-coding / GLM-5.3-flash / P3 / 计划 | 21,129→19,833 | 1,296 | 185→121 | 7,967→6,038 |
| kimi-code / kimi-for-coding / P2 / 计划 | 22,061→20,003 | 2,058 | 298→759 | 6,707→11,259 |
| kimi-code / kimi-for-coding / P3 / 计划 | 19,711→18,406 | 1,305 | 418→417 | 9,066→11,776 |
| zai-coding / GLM-5.3 / 整体 / 计划 | 23,595→19,833 | 3,762（15.9%） | 157→79 | 16,432→19,662 |
| deepseek / deepseek-flash / 整体 / 计划 | 24,380→20,447 | 3,933（16.1%） | 460→424 | 3,232→3,239 |
| kimi-code / kimi-for-coding / 整体 / 编辑恢复 | 22,297→18,641 | 3,656（16.4%） | 94→78 | 3,745→2,425 |

P2 单独只替换四个 todo 工具，system/history/其它工具固定；P3 两臂固定候选工具，只改变 Worker system/context。整体才比较全部 baseline 与 candidate；不要跨批次相加延迟、成本或 input delta。

input 包含 cached input；缓存命中不同会影响估价和延迟，却不能把输入节省解释成只少了非缓存账单。Kimi 的 P2 计划输出多 461 tokens、延迟明显变长，ZAI 的整体样本也更慢。因此当前结论是固定输入更省，未证明完整任务总成本或速度一致改善。

zhipu-coding/GLM-5.3 与 zai-coding/GLM-5.3-flash 只做本地真实 SDK mock-fetch 路由/协议预检，未付费采样；两个 GLM gateway 也不能算独立模型 family。所有 GLM 同臂采用同 reasoning 请求，实际 SDK wire 为 adaptive/low；Kimi 是 always-on low，DeepSeek 为关闭。没有跨模型排名。

## 3. 模型行为：11 组配对的主会话判断

保留有效样本 22 条（11 pairs），每臂每 case 一条，无重复抽样、judge panel、修复循环或自动 fallback。每条真实 provider `singleAttempt`，physical attempt observation 与 usage 均保存；上述有效样本没有截断或 provider error。三个已付费 case 只观察下一响应：简单问答、授权两路只读审查的计划起步、stale edit 的恢复选择。它们不执行生成的工具，不能据此认定两个子任务已完成。

| 比较 | 配对数量 | 揭盲后判断 |
|---|---:|---|
| P2，GLM-flash + Kimi，问答/计划 | 4 | 两组计划都有效且相当；问答各有一个措辞/浅冻结解释的小优势，分别属于 baseline 与 candidate；没有实质退化 |
| P3，同两 route/同两 case | 4 | Kimi 两组相当；GLM-flash 候选问答略直接，基线计划描述略完整；候选计划仍保留三项正确义务 |
| 整体，ZAI GLM-5.3，计划 | 1 | 基线组织稍好；候选有冗余“建立计划”项、把两个审查合成一项、未写可选细节。没有捏造完成或越权写入；轻微差异，不能声称完全等价 |
| 整体，DeepSeek-flash，计划 | 1 | 候选三项实际交付比基线更集中；两臂都多做已知范围侦察、使用英文进度文案。基线 additionally changed_scope(all)，候选 dir/status 也冗余；只支持低置信度的小差异 |
| 整体，Kimi，编辑失败恢复 | 1 | 两臂都先重新读取准确文件，没有盲重试旧锚点、全文件覆盖或伪造成功；相当 |

主会话在不知道 baseline/candidate 映射和 usage 差异时写下 taskValid、preferredArm、value、severity、confidence 与理由，再读取映射。[持久汇总 JSON](first-turn-optimization-evaluation-2026-10-14.json)保存全部揭盲判断、usage、blind evidence hash 与边界；原 text/thinking/toolCalls 只在 OS temp，不写仓库。

最后的小修改变了 agent-chain 的无 promptContext fallback，因此源码 hash 与付费冻结版不同；零网络重新捕获最终版后，四个完整 case input hash **4/4 与付费冻结 candidate 完全相等**。最终文件 `candidate-final-r4-inputs.json` 对象 SHA256 为 `b942bf5bf49a459f04e60c6e42bec7ab04301d53f29eebb3e68b97d71d26321a`；不能把旧 source hash 当最终版源码。新 fallback 独立入口由真实 Runner 确定性测试覆盖，未另做模型采样。

`resume_existing_plan` 已冻结但没有付费采样；本轮只有静态/真实 Runner 的恢复合同验证，没有验证 live compaction 后模型采纳率。没有大型仓库、多轮写入、冲突恢复或长期子 Agent 完成率的统计证据。当前推荐接受合同和重复教学压缩，保留轻微差异与效率风险，不能发布“所有模型智能能力已证明不下降”的保证。

## 4. E2E、生产执行和 live 失败

[HTTP/SSE E2E](../../tests/first-turn-contract.e2e.test.ts)覆盖 OpenAI/Anthropic × SA/AMA 四条真实 SDK 序列化路径，用本地 HTTP 服务返回 read→edit→batch ask→final，并核对文件 groundtruth、问答 callback、投影后的工具和 tool results。它们在 test 环境的低层 coding SDK 运行，证明协议与工具接线，不证明缺失 production mutation host 时可以写文件。

另有一次有限真实 GLM-flash SA smoke：模型正确给出 read 和精确 edit 参数，但生产低层 `@kodax-ai/coding` 未获 trustedTextMutationHost，edit 被拒绝；第三请求也没有完成修改。`result.success=true` 与文件 groundtruth 不一致，该 live 实验明确记为失败。

[逐变量重放](../../tests/first-turn-smoke-replay.test.ts)在候选与 baseline 各验证 production 原配置、去 hook、去 visibility 三者都拒绝；只有 NODE_ENV=test fallback 编辑成功。这排除了 guard、工具隐藏和本次压缩回归。真正 `createKodaXRuntime/session/full-access/native host` 的 production 零网络重放实际修改为加法并保留注释/格式；read/edit 来自记录参数，第三终止文案是脚本指定。候选 5/5、baseline 4/4 通过对应诊断断言。

未来 live driver 已改为真实 Runtime Host，保留最多 3 model calls、2 read/edit tools、路径白名单、2048 output、120s 单次/180s 总超时及 singleAttempt。**修后的实模 Runtime smoke 未重新运行**，不会把重放或脚本修好记成实模成功。[完整根因、baseline 控制与 raw 位置](first-turn-smoke-replay-diagnosis-2026-10-14.md)。

## 5. 预算、失败尝试和证据保全

有限评估冻结上限：generation 自身 32 calls，加单独 smoke 累计最多 35；1.2M tokens、$3 参考上限，输出/时间/attempt 同时限制。当前共享总账 **35 logical calls、768,196 charged tokens、参考 USD 0.050298718、unknownUsageCalls=1**，已经停止一切模型调用。参考记账不是订阅套餐的实际现金账单；未知 usage 保守计预留，没有算成零或重置历史。

必须保留以下失败事实：

1. 初期 Kimi 的 effort=none 被本地拒绝，0 HTTP；改用既有 always-on low。GLM 一条早期 observation 接线不完整，没有用于最终结论。
2. 初期共享 TEMP 中八条生成 raw 随后消失，来源未确定。保留历史记账和 unavailable 标记，八条不进入当前语义/usage 证据。后续在独占 TEMP 的新 revision 重跑，历史消耗仍进入 35 总账；没有把失去原文的结果补写成有效样本。
3. 第一次 smoke 在一轮请求后，被误用的 32-call generation ceiling 本地拦住；旧 usage/raw 保留。统一预算类新增显式上限参数，仅 smoke 可至 35，没有重置已耗调用。Windows 清理守卫的斜杠规范化也只作本地修复。
4. 后一 smoke 三轮因 host 缺口没有完成写入，已按上一节记录；没有追加 paid repair。
5. 最终 Standards 发现缺字段 JSON 预算可能产生 NaN，新增 RED→GREEN 回归并显式校验六字段/整数 call counters；主会话另补持久化 null 不得重置为新账本的 RED→GREEN。只作本地修复。

原始根：`C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-isolated-f6d8495a-400f-42c4-b861-8b8b1b37e1cc/kodax-eval-dumps/first-turn-tokens-v1`。两份完整 JSON 备份在同一独占 TEMP 的 `evidence-backup-a/complete-evidence-tree` 与 `evidence-backup-b/complete-evidence-tree`；全量测试用另一新 TEMP，避免与评测 raw 共用根。API keys 未打印、探测值或写入证据。

DeepSeek 参考预算核对了[第一方价格页](https://api-docs.deepseek.com/quick_start/pricing/)，保存检查时间、来源和费率，采用较高时段价保守记账；不声称观察到账单的时段/折扣。其它 coding-plan 数值是本地参考表估值。

## 6. 最终验证记录

产品 seam 的 RED→GREEN 证据分别见 P1/P2 与 P3 实施报告。全量检查只在产品源码冻结、完整 build 完成后运行，避免 launcher 读取到构建中间态。

| 检查 | 结果 |
|---|---|
| `npm run build` | PASS（最终产品源码；packages/native/bundle/dts） |
| `npm run typecheck` | PASS（src/tests） |
| 新增 first-turn tests/eval/cases 的 `tsc --noEmit` | 独立检查 PASS；纳入 root `tsconfig.test.json` 后普通 `npm run typecheck` 再次 PASS，后续 CI 持续检查 |
| 受影响 P1/P2 定向 suite | 13 files / 250 tests PASS；语言合同另 110 tests PASS |
| P3 Worker/role/真实 Runner root+child 定向 suite | 174 tests PASS |
| 新投影的定向 V8 coverage | statements/branches/functions/lines 均 100%；不是全仓 coverage 声明 |
| wire inventory | baseline/candidate 各 16 cells PASS；candidate 重复 16/16 normalized equality |
| 本地 HTTP/SSE E2E | 四种协议/模式 PASS；test-mode SDK 边界如上 |
| 生产 Runtime 与 host 缺口重放 | candidate 5/5、baseline 4/4 PASS；零网络 |
| routes + eval budget safeguards | 2 files / 14 tests PASS；零真实模型请求 |
| 冻结源码完整 `npm test` | **PASS：1,169 files / 16,624 tests；4 files skipped、89 tests skipped、19 todo；0 failures** |
| 最终 `npm run test:bundle` | **42 tests PASS、0 failures，72.75s**；production SDK 权限、daemon、恢复与退出等 |
| `git diff --check` | PASS；仓库未定义 lint script，没有新增 lint 工具或声称另跑了 lint |

早期一次全量运行与并行产品修改/build 重叠，出现 E2E fixture 假设、语言断言及 daemon build identity 等失败，不能用它宣称最终全通过。四个相关文件之后单独重查 37 tests PASS。

冻结版全量在长独占 TEMP 运行：1,167 files PASS、2 files FAIL、4 skipped；16,519 tests PASS、9 FAIL、184 skipped、19 todo。失败局限于 windows-native-artifacts 的九项和 sandbox-runtime beforeAll，日志明确为 .NET PathTooLong / 深层目录无法创建。相关 native product/test 与基线 SHA 完全相同。单变量控制：长根九 fail；41 字符子根一 fail；原 34 字符 OS TEMP 的 native 完整 18 PASS/2 skipped、sandbox-runtime 95 PASS/40 skipped，未修改源码。最终在原 OS TEMP 完整重跑，**1,169 files / 16,624 tests PASS、0 failures，757.38s**；paid raw 仍在另一个独占子根，不共享默认 dump 路径。日志 `C:/Users/ADMIN/AppData/Local/Temp/kodax-first-turn-final-confirmed-test.log`；先前环境失败日志 `kodax-first-turn-final-full-test.log` 保留，也没有据此修改原生工件代码。默认 Windows/platform 跳过和既有 todo 未改成通过。

## Standards

最终独立 Standards 评审无剩余阻断。私有投影不改原对象/registry，未新增 any、跨层依赖、用户配置或通用框架。预算不完整 JSON 的缺口已用显式六字段校验和回归修复；reasoning 选择已收敛为共享函数。未来 live driver 已使用实际 Runtime Host，并保留 shared ledger、singleAttempt、路径/工具/调用/时间限制。本轴没有将确定性测试或计数推断成模型能力提升；最终全量结果由主任务另确认。

## Spec

产品的问答、skill-script capability、todo 模型投影、root/child/独立 Runner fallback 以及完整 wire hash 复查均已消除此前阻断。一般 deferred discovery 与 host policy 的既有不一致仍列为后续缺口，不泛称所有发现路径一致；`tool-search.ts:92、105` 的一般 exact/keyword 路径，仍未全面落实主计划 §3.1 的“当前 host/role 确实不具备的能力，不进入模型工具表或发现目录”，作为 P4 前置修复。生产 replay 与原 live 失败分别记账，恢复 case 只证明下一步选择，不能宣称完整任务完成或统计不劣。Spec 已核对四份盲包实际 SHA、最终捕获对象 SHA 与四个完整 input hash，均与本文一致，未发现新增阻断。

双轴汇总：Standards 0 剩余 findings/阻断；Spec 0 本次变更新增 findings/阻断，1 项既有一般 discovery 缺口作为非阻断后续。

提交后又以非空固定点 `git diff bd4479d...be23099c` 独立复核，两轴均确认与已审工作树一致，无范围漂移；新增 null 账本门禁与常规 TypeScript 覆盖也已复核。

## 提交与回退

当前分支 `KodaX-next-dev`，产品纠偏和文字/模型接口精简分开提交：

| Commit | 内容 |
|---|---|
| `de3d8ff9` | P1：问答合法分支与无 runner 的 skill-script 能力纠偏 |
| `dcbe2b83` | P2：todo 模型投影、短合同，raw SDK legacy init 保留 |
| `9055a4c1` | P3：Worker 教学去重、真实 capability 指导及独立 fallback |
| `be23099c` | P0 KodaX wire、E2E/生产重放、有限评测/预算与持续类型检查 |

调研和汇总证据另作文档提交。没有 push、PR、发布或后台评测。若以后出现可信行为回退，优先独立回退 P3 或相关 todo 描述/投影，保持 P1 问答纠偏与内部 SDK 合同，不把合法批问重新禁掉；回退后重跑对应确定性 seam，实模新增试验另冻结范围和预算。

## 7. 下一步的边界

本轮没有理由再削减关键常驻执行义务。先接受明确的接口/重复内容收益，保留 ZAI 计划组织、Kimi 输出/延迟、DeepSeek 语言/已知范围重复侦察这些观察。它们不支持引入更大教学段或多套用户模式来追逐一条样本。

剩余 wire 中，tools 仍占大头：OpenAI AMA Runtime Host 68,114 bytes，system 26,086、conversation 4,549。若继续 P4，应逐项验证真实 executable capability、tool_search 激活、child/restore 独立入口、首次选择与运行失败恢复，再考虑低频 repo/LSP bridge；先解决一般发现一致性，不能只隐藏 schema。若增加实模测试，应新预注册有限的真实 Runtime read→edit→final 与 resume/child completion cases，并沿用已有总账历史；本轮没有自动追加或安排后台评测。
