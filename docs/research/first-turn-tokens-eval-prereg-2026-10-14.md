# 首轮固定输入优化：P0 捕获与有限行为评估预注册 r1 / r2

执行收尾状态：已停止模型调用，累计35 logical calls；可保留且已盲审的22样本/11 pairs，结论与失败尝试完整记录于[实施与评估报告](first-turn-optimization-implementation-2026-10-14.md)。后续章节的阶段状态、原冻结路径和每次调用前修订保留为历史记录；原live SDK smoke失败，真实Runtime生产重放通过，修正后的实模smoke未重跑。

2026-10-14 smoke r4 修订：首次 smoke 模型正确发出 read；共享预算类误沿用 generation 的32次限制，在下一次请求前本地终止，因此该 smoke 不用于模型质量判断。另有 Windows TEMP 斜杠未规范化导致清理校验拒绝，已比较 resolved path。保留旧一次请求及其 usage/raw；新的唯一 smoke 最多3次、最多2个工具调用，只允许固定 sum.js 的 read/edit。共享历史累计32后最多新增3，**总35次/1.2M tokens/$3不变**，generation自身仍32。原 smoke 文件保留，r4用独立文件名；不自动续写或追加试验。此修订在新 smoke 发出前记录。

状态：2026-10-14，预注册已由主会话审核，已明确授权并启动P2 `p2-pilot-r1`（最多8 calls）；P3与后续扩展仍须等待主会话评审/dispatch。本节为执行状态补记，其余预算/cases/分析规则在首次调用前已冻结。

## 比较问题和不能用单测回答的部分

P1 requiredParams、工具可见性和P2各模型出口投影，使用真实入口单测与主会话的HTTP/SSE E2E。P0字节/hash/count也不需要LLM。只有“压缩后模型是否仍识别简单任务豁免、非平凡计划义务、协作范围和恢复责任”进入Layer2。机械记录只解释下一响应，不自行决定ship；主会话盲化评审判断实质价值/回退。

不引用历史F189 DROP来否决当前候选：当前Actor/Worker/tool schema substrate已变化，而且旧机械回退结论后来有评分器纠偏记录。这里重新冻结production输入；不复用旧手写prompt/stub tools。

## 冻结输入及baseline保全

- baseline commit：`bd4479d59cab3d082f07c2d34681fff198d82fa0`，完整tracked源码已由`git archive`解到OS temp的`kodax-first-turn-baseline-bd4479d`。node_modules仅junction复用；业务源码与并行修改隔离。
- 捕获器：[tests/first-turn-inputs.capture.ts](../../tests/first-turn-inputs.capture.ts)。真实`buildSystemPromptSnapshot`、`buildRunnerAgentChain`、`createRolePrompt`，最终经`buildRunnerLlmAdapter(...overrideStream)`捕获system/messages/tools。全量production描述/schema，无手写工具定义。基线Worker59工具；system30629字符/30777bytes，工具JSON71485字符/71691bytes。
- 基线原文：`%TEMP%/kodax-eval-dumps/first-turn-tokens-v1/baseline-r1-inputs.json`，当前文件对象hash `735df1197d1f8c2aaeb9599b522fb76bbbffec0807f760787d51cde9bae11581`。新增sourceHashes后的重捕获应使用新stage保留旧文件；case input hashes是行为比较依据。
- r1修正了最初case“我负责整合/你整合”的歧义，并明确无需侦察来决定范围。旧`baseline-inputs.json`保留仅作诊断，不用于付费。
- 执行前新增sourceHashes后生成`baseline-r2-inputs.json`，对象hash `69dfc1d016852366630b621c7e6d9b190a05ff20f92eb7cda7dea867aa08856f`；所有case input hashes与r1完全一致。冻结candidate hash `f81ee0966752e6921a8ec8f8c3b8c5421753bccf95e86f2213514780ca5a380c`，58个工具。P2执行使用r2。
- workspace/home是固定路径下空目录、非Git；无AGENTS、skills、MCP、可选host、preturn或权限后缀。涉及编辑/续跑的历史是受控合成，不声称是实际compaction执行。
- 这是provider接口边界捕获，**不是最终HTTP请求**。主会话另有真实HTTP/SSE×SA/AMA E2E来验证最终序列化与实际工具执行。

## 两个独立比较轴

1. **P2 todo-tools**：A baseline全部输入；B仅把四个todo工具替换为candidate捕获中同名工具的完整production定义。system、history、其他工具逐字节相同。问答修正/skill-runner过滤不混入这个因果比较。
2. **P3 worker-prompt**：两臂共用candidate工具；A baseline Worker system+context/messages，B candidate Worker system+context/messages。相同case任务/受控历史，无额外生产外教学。

`comparisonInputs`校验每个捕获输入的SHA256及case任务一致，避免后续编辑悄悄污染。`combined`仅为显式可选整体检查，不作为当前两轴pilot默认值。

## Cases及预注册观察

完整任务与history在[benchmark/datasets/first-turn-tokens/cases.ts](../../benchmark/datasets/first-turn-tokens/cases.ts)。

| case | 阶段 | 固定场景与可解释观测 |
|---|---|---|
| trivial_answer | pilot | 两句中文说明const与对象属性可变性。正确回答；实际无todo/子agent/仓库探索/审批调用。文本提到工具名不算误调用 |
| planned_parallel_review | pilot | 两个已确定存在、独立文件的只读审查；用户明确授权两个子agent并要求先计划、最后整合。观察短计划/只读分工、中文标签、无捏造完成；第一响应只建计划是健康行为，不要求同一轮已完成spawn/结果 |
| edit_recovery | followup | 已读文件后edit因别人插入注释而old_string not found。观察重新读取或更小唯一片段编辑，保留别人注释；不盲重试同参数、不全文件write、不捏造成功。读取不算missed edit |
| resume_existing_plan | followup | 合成恢复摘要含已完成todo_1及待做todo_2、尚未本轮读文件。观察复用id、核对当前状态/源码、不重复创建或legacy init，不提前宣称验证完成 |

不执行模型发出的工具。每cell只有一轮/一次物理provider attempt，无自由agent loop、repair、fallback或追加follow-up。若两个臂都只做合理前置侦察且无法区分后续义务，将该指标记为无区分度；先修case并创建新revision，不强行判回退。

## Route及凭据预检

预检使用`getProviderModels`读取本地production descriptors；仅输出credentialPresent布尔。六个route的descriptor与环境凭据均存在，**尚未联网验证可用性**：

- zhipu-coding/glm-5.3-flash（pilot）
- kimi-code/kimi-for-coding（pilot；用户本轮明确重新授权，覆盖历史默认暂停）
- zhipu-coding/glm-5.3、zai-coding/glm-5.3（后续高档/gateway兼容）
- zai-coding/glm-5.3-flash（仅可用性记录；不为同family重复全采样）
- deepseek/deepseek-flash（后续官方token-bill；绝不创造model=`deepseek`）

同provider一个在途请求；不同provider并行。无自动route fallback。现有`runOneShot`没有透传`singleAttempt`，故本driver复用production provider直接调用`stream(..., {singleAttempt:true})`，该选项关闭SDK maxRetries与provider恢复阶梯，并保存physical request observation来发现意外重复。

## 冻结预算和阶段推进

- P2 pilot：2 cases × 2 arms × 2 routes × 1 = **8 calls**。先主会话盲审任务有效性。
- P3 pilot：同样至多 **8 calls**，单独轴，先确认P2数据可解释且候选冻结。
- 后续最多 **16 calls**，按主会话审核安排zai/glm53、zhipu/glm53、ds/flash和编辑/恢复case，不为用满预算而增加样本。两个GLM gateway不算独立family证据。
- 单独Layer3.5 SDK SA smoke由主会话执行：1个temp toyfile任务，read→edit→final，生产工具只允许read/edit，nochild，maxIter3/**3 calls**；只验证当前候选链路与文件groundtruth，不参与A/B。
- 全部合计最多 **35 calls、1.2M input+output tokens、$3参考成本上限**；本generation driver自身最多32calls，smoke的3calls/usage/成本必须由主会话并入同一总账。不能另开一个$3预算。
- 每cell1call/1round，单call输出上限2048、timeout120s；固定reasoning `{enabled:false,effort:'none'}`。记录实际stopReason；max_tokens截断为证据缺口，不能静默补问/续写。
- 预计baseline每call约26K输入，32generation约0.83M输入+至多65,536输出，低于总限；实际usage优先，缺失usage不得按0计算。
- dispatch前按序列化UTF-8字节+4096协议裕量+输出上限做保守预留，结束后以usage释放差额；缺失usage或error保留预留、停止待评审。该字节预留是保守估计，不是数学证明tokenizer上界。并发预留同步，账本顺序持久化；任一预算到限不再dispatch。
- coding-plan记录请求/token配额及本地rate表的参考估值；**不声称订阅边际现金支出已知**。官方DeepSeek执行前必须核对第一方实时价格、存source/checkedAt/rate并按最坏缓存未命中价预留；driver未提供该证据文件即拒绝官方route。
- 本地参考费率只用于预估：pilot成本主要是订阅配额，不把“$3上限”误称价格报价。外部invoice不可观察时明确cash unknown。

## 盲化、raw与停止条件

每pair随机Arm A/B映射，raw含原始text/thinking/toolCalls、stopReason、usage、route、延迟、物理attempt事实和机械观察。原文及映射写入`%TEMP%/kodax-eval-dumps/first-turn-tokens-v1/<batch-id>/`；`blind-evidence.json`不含baseline/candidate标签，映射另存`unblind-mapping.json`。

主会话先不读映射，逐case记录task validity、preferredArm/tie、value none/minor/material、regressionSeverity、confidence及reason，再揭盲。回退归因使用eval-design/provider-noise/prompt-regression/inconclusive。不得机械PASS率自动ship，不额外judge panel。

任何case-invalid、截断、provider错误、usage缺失或意外重复attempt先看现有raw；不隐藏重试。发生硬错误时停止新dispatch，已在途请求结算后保存数据，不提前释放batch lock。重新解释scorer无需重烧generation。最终建议只能是recommend-ship/iterate/revert/eval-invalid之一，并报告局限。

## 复跑方式

零付费预检：

```powershell
node node_modules/vite-node/vite-node.mjs --config vitest.config.ts tests/first-turn-tokens.eval.ts
node node_modules/vitest/vitest.mjs run tests/first-turn-eval-support.test.ts --config vitest.config.ts
```

候选冻结（输出路径不允许覆盖既有stage）：

```powershell
$env:KODAX_FIRST_TURN_STAGE='candidate'
node node_modules/vite-node/vite-node.mjs --config vitest.config.ts tests/first-turn-inputs.capture.ts
```

仅收到主会话执行消息后，设置`KODAX_FIRST_TURN_EVAL_RUN=1`和唯一`KODAX_FIRST_TURN_BATCH_ID`；默认axis todo-tools、phase pilot、routes zhipu/glm53flash,kimi。P3显式axis worker-prompt。捕获路径用`KODAX_FIRST_TURN_BASELINE_INPUT`/`KODAX_FIRST_TURN_CANDIDATE_INPUT`冻结，官方价格证据用`KODAX_FIRST_TURN_VERIFIED_PRICE`。每次batch最多两个route、两个case、两臂，不自动扩展。

实现：[driver](../../tests/first-turn-tokens.eval.ts)、[预算/轴隔离](../../tests/first-turn-eval-support.ts)、[单测](../../tests/first-turn-eval-support.test.ts)。单测已5/5通过（包括无效cost不能冲穿预算）；候选已冻结并启动获批P2 pilot。

## r2 修订（首次 r2 dispatch 前冻结）

r1在两个logical cells后自动停止：Kimi本地capability validation拒绝explicit effort none（没有usage）；同一时刻已在途的Zhipu trivial Arm A成功，usage23527+42=23569。这是harness配置错误，不能评价prompt。原始r1保留；unknown-usage预留不退，账本当时chargedTokens133306、参考chargedUsd0.004119215，不能解释为真实现金消费。

主会话审核后，r2只调整provider层配置/观察，不改case或工具prompt：

- Kimi固定`{enabled:true,effort:'low'}`；其profile声明always-on，不能承诺关闭thinking或精确控制实际推理强度。
- GLM保持`{enabled:false,effort:'none'}`。**真实SDK离线mock捕获显示四条GLM路线实际wire为thinking adaptive + output_config low，并非disabled**。保留该生产序列化行为，r1 Zhipu有效raw和r2相同配置等价。
- DeepSeek none在offline mock表现为disabled/none；后续token-bill仍需官方price证据。
- `runWithProviderRequestObserver`内增加`observeProviderOperation(provider,'utility',...)`，建立fetch事实依赖的context。r1成功样本的observer空属于记录缺口，不证明没有请求；r2离线SDK mock已证明每route只发1个mock physical attempt。
- [route preflight tests](../../tests/first-turn-route-preflight.test.ts)覆盖六条route，连同预算/隔离测试11/11通过，全部fake credential + mock fetch，零外部调用。
- `KODAX_FIRST_TURN_REUSE_EVIDENCE`读取r1盲包；只有route/provider/model/inputHash、请求reasoning完全一致且成功含usage的row才能复用。保存来源path/rowHash，重贴新盲臂标签；没有新provider调用。主会话及executor均不读取揭盲映射来判断语义。
- r2计划8个有效cell，其中1个Zhipu旧row复用、最多7个新调用。Kimi本地拒绝row不复用。budget继续累计而不重置。主会话已授权该7cell补齐；之后停止，等盲审决定下一批。

## r2 执行记录与证据可用性

执行进程正常退出，stdout 报告 `generated-awaiting-main-session-blind-review`，累计账本为 calls 9、chargedTokens 286544、chargedUsd 0.01340403、unknownUsageCalls 1、reservedTokens 0。calls 包括 r1 的 Kimi 本地拒绝保守记账；chargedUsd 是订阅参考价与未知 usage 预留，不是确认的外部现金费用。本次没有主动重试或新增评判调用。

随后读取证据时，Node 与 PowerShell 均发现 `%TEMP%/kodax-eval-dumps/first-turn-tokens-v1` 整目录已不存在；其父目录当前创建时间为 2026-10-14 13:17:31，仅有另一实验的目录。删除来源尚未确认。本 harness 没有递归删除 dump 的代码。除非找到原始副本，r2 **不能据成功退出判定行为质量，现有证据不可供盲审**，也不能从不存在的 ledger 重新开始零预算。已通知主会话暂停后续付费；没有自动重跑。

捕获脚本补齐 `buildSystemPromptSnapshot` 必填 provider 后曾另存 baseline-r3（未覆盖旧文件）：其对象 hash 为 `a11f2d976c616a4fb91cc3e0fad7da20b0dfd9281a3ec3a11da3fb9567ccdbb2`；所有 managed case inputHash 与 baseline-r2 相同，SA hash 发生变化。当前 P2 只使用 managed case，provider 参数补齐不改变其输入。原冻结源 archive 仍可用；重新构建输入不等于恢复付费 raw。

## r3 修订（新增 dispatch 前冻结）

主会话确认无 raw 副本。历史 8 次物理 generation 加 1 次本地拒绝记为 **evidence-unavailable**；保留预算，不评价品质。依照“raw 损坏时补跑最小受影响集合”授权最小重生成，不能把这次例外当隐藏重试。旧映射不可恢复，不推测旧 A/B 标签。

所有后续进程显式设置 `TEMP` 与 `TMP` 为原 OS 临时目录下的独立目录：

`C:\Users\ADMIN\AppData\Local\Temp\kodax-first-turn-isolated-f6d8495a-400f-42c4-b861-8b8b1b37e1cc`

其 `os.tmpdir()/kodax-eval-dumps/first-turn-tokens-v1` 保存 baseline、candidate、raw、评审和同一 ledger。SDK smoke 必须共用上述进程变量及 ledger。不会清理原 dump 根、隔离目录或整个 Temp；不再并发运行清理共享 dump 的全仓测试。只有与本 harness 直接相关的零网络测试可独立执行。

历史 ledger 从 r2 stdout 恢复为 `calls=9, chargedTokens=286544, chargedUsd=0.01340403, unknownUsageCalls=1, reservedTokens=0, reservedUsd=0`，来源和缺证据状态另存 `historical-evidence-unavailable.json`。driver 对缺失 ledger 直接报错，禁止默认为零。参考成本、订阅配额、已确认物理请求及本地拒绝继续分别解释。

新分配替代原剩余 panel：

| 阶段 | 路线及案例 | 新调用上限 |
|---|---|---:|
| P2 tools | zhipu/glm53flash、kimi × trivial_answer、planned_parallel_review × 两臂 | 8 |
| P3 prompt | 同上；只在首批盲审和最终候选接线确认后运行 | 8 |
| 泛化 | zai/glm53、ds/flash × planned_parallel_review × 两臂 | 4 |
| 编辑恢复 | kimi × edit_recovery × 两臂 | 2 |
| 独立 SDK smoke | 主会话现有真实 SA read→edit→final，最多三次 | 3 |

合计历史 9 + 新 25 = 34，仍低于总 35；generation driver 累计最多 31，低于其 32。总 token 上限 1.2M、参考费用上限 $3 不变；后续两行泛化/恢复只在主会话指定比较轴并批准后 dispatch。未安排 zhipu/glm53、zai/glm53flash 重复采样或 resume_existing_plan 新生成；这些覆盖缺口必须在报告中保留。

冻结源保护：baseline 使用原 `git archive bd4479d59cab3d082f07c2d34681fff198d82fa0`，只同步实验 capture/cases，产品源不动。`KODAX_FIRST_TURN_FIXTURE_ROOT` 固定为空的原 `.../Temp/kodax-first-turn-controlled-fixture`，让随机 raw 存储目录不进入模型可见 workspace 字节。重新捕获的 baseline-r3 对象 hash **完全等于**丢失前记录 `a11f2d976c616a4fb91cc3e0fad7da20b0dfd9281a3ec3a11da3fb9567ccdbb2`。candidate 等待产品 agent 停写后再冻结 sourceHashes；完整工具能力的 P3 修正应不改变现有 full 场景语义，具体字节以重新捕获为准。禁止把重建 inputs 当作恢复旧 raw。

driver 与六路线离线 mock preflight 共用 `firstTurnReasoningFor`，避免验证/执行参数漂移；相关 11 项测试通过。允许通过 `KODAX_FIRST_TURN_CASES` 从既定 phase 选择一或两个已冻结 case，以执行上表后续最小集合。每个批次仍需要明确执行消息、唯一 batch id、同 provider 单在途、无 fallback、全在途结算后才释放锁。

最终 candidate-r3 对象 hash：`ebbd6bdadfec2776d939f6149953feeb59a5db3fef144a15c51e373d80e3b176`。58 个 tools 序列化 hash 为 `36444518c3257538509d8f61392510a40ae90d153f8f1ad82815d52e03f8d58d`（61559 chars / 61669 bytes），与前次记录尺寸相同；实际 adapter 捕获 system 为 25074 chars / 25162 bytes，低于旧候选记录的 25312 / 25400，messages 也缩短。不能因 full role fixture 尺寸不变就宣称所有 case 输入相同。**当前获批 P2 只在精确 baseline 输入中替换四个 todo tools，system/messages 始终取 baseline，因此不受这项候选 prompt/context 差额影响。** P3 再由主会话核对该差额后授权。

首批 r3 无旧 raw 复用，执行前主会话明确授权新的八调用。每个 batch 的 preflight、原始 rows、blind bundle、映射在主 dump 之外再镜像两份至同一隔离 TEMP 下 `evidence-backup-a/<batch-id>` 与 `evidence-backup-b/<batch-id>`；冻结 inputs 也另行复制至这两个备份目录的 `frozen-inputs`。任一备份写入失败则停止新 dispatch，恢复已有数据不重烧 generation。备份均不进工作树。

`p2-pilot-r3` 已完成：8 rows、8 observed physical starts、0 error、0 missing usage，新 usage 合计 175750 tokens。累计 ledger 为 calls 17、chargedTokens 462294、chargedUsd 0.02220931、unknownUsageCalls 1（含原有丢失证据和本地拒绝保守记账）。主盲包及两份备份 SHA256 同为 `3146f5da954b5378a8325954ded353749549a37dce8629cf52ff2cd5e7895522`。Executor 仅检查数量、usage、观察事实和备份哈希，没有读取输出文本或映射、没有语义判定；盲包已交主会话，后续调用仍暂停待审。Kimi r1 本地拒绝属于 harness 配置失误；GLM 的真实 adaptive/low wire 行为仍保留在 r2 修订说明中。

主会话已将 P2 盲审落盘后揭盲，报告四组配对没有实质行为回退；Kimi 简答清晰度为 minor 变异，不能稳定归因，计划组输出 token 与延迟变高属于效率回退，须和输入 token 节省一起报告。此为主会话评审反馈，executor 没有额外评判或生成。

主会话核对 P3 capture 的 238-char system 差额来自实际 capability assembly（workflow policy unavailable）；采用真实 adapter 字节作为本轮候选，不将 `full/undefined` 纯 builder 量尺视为整个输入同源证明。授权新批 `p3-pilot-r3`：同两条路线、同两个 pilot case、每臂一次，共八次。两臂共用 `candidate-r3.tools`，比较 baseline-r3 的 system/context 与 candidate-r3 的 system/context，用户任务和 canned history 保持冻结。预计累计 calls 25；结束即暂停，后续六次尚未授权执行。

`p3-pilot-r3` 已完成：8 rows、8 observed physical starts、0 error、0 missing usage，新 usage 159278 tokens；累计 calls 25、chargedTokens 621572、chargedUsd 0.0313769、unknownUsageCalls 1。主盲包和两份备份 SHA256 均为 `20db904d3591c85c0331f691a9b0f1d94175ef456b546a49078ea9fbc554ec12`，本批预算 checkpoint 也各存一份。四个冻结 case 的 task 和 canned priorMessages 逐项相同；system/context 是该轴的处理变量。只完成生成及元数据核对，已经交主会话盲审，未自行追加后续六次调用。

主会话已对 P3 盲审落盘后揭盲，反馈四组配对无实质回退；API 输入每组分别少 1305（Kimi）或 1296（GLM）tokens，Kimi 延迟略高、GLM 较低，不能宣称统一加速。授权后续顺序批次，均采用 **combined** 轴（完整 baseline 对完整候选）：

- `combined-generalization-r3`：zai/glm53 与 ds/flash，只选 planned_parallel_review，两臂共四次。
- 上一批没有 hard error、missing usage 或截断后，`combined-edit-recovery-r3`：kimi，只选 edit_recovery，两臂共两次；若有异常先停止并交主会话判断。

DeepSeek 使用主会话核实的 `deepseek-verified-price.json`（同一隔离 TEMP）：官方 USD 每百万 input 0.30、output 1.20、cache read 0.006，以 peak 保守记账；source 为 `https://api-docs.deepseek.com/quick_start/pricing/`、checkedAt 2026-10-14。没有额外 judge、fallback 或自动重试。两批结束累计 calls 31；主会话 SDK smoke 余最多三次，总量最多 34。所有原文、映射、usage、评审、账本 checkpoint 继续两份同临时根备份。

上述两批已顺序完成，均无 error、missing usage 或 cutoff，physical starts 与批准调用数一致；executor 未读取语义或映射：

| batch | rows/physical starts | 新 usage tokens | 三份盲包共同 SHA256 |
|---|---:|---:|---|
| combined-generalization-r3 | 4/4 | 89375 | `3496a77c4db455353f91935add6952389b8b1cc8afdd4e179ca72aa5ef54988d` |
| combined-edit-recovery-r3 | 2/2 | 41110 | `da284a67f880f15b4f7820abcfc2b9a21ea71900cd1b751ca313bc6dbaebe8c7` |

Generation 结束累计 ledger：calls **31**、chargedTokens **752057**、chargedUsd **0.048062278**、unknownUsageCalls **1**、reservedTokens **0**（reservedUsd 仅约 6e-18 浮点尾差）。其中可审阅新 generation 为 22 次、465513 tokens；历史 8 次物理 generation raw 丢失及 1 次本地拒绝仍占账，不补造行为结论。已向主会话交付两个盲包并停发；独立 smoke 尚由主会话执行，不能把当前数字当包含 smoke 的最终总计。账本 checkpoint 与原始 rows/mapping/usage 都有两份备份；主会话完成最终盲审后，评审文件也需同步两份。

主会话后续 smoke 完成后的最终累计 ledger 为 **35 calls / 768196 charged tokens / USD 0.050298718 参考记账 / unknownUsageCalls 1**，已达调用硬上限，全部模型调用停止。`live-sdk-smoke-r4` 的结果是文件未修改，即使 result.success 为 true 也不能判通过。零模型重放已定位为低层 harness 入口没有 provision 生产 text mutation host；baseline 同样失败，真实 Runtime/native host 在 production 环境可执行已捕获的 read/edit 参数。完整证据及限制见 [根因说明](first-turn-smoke-replay-diagnosis-2026-10-14.md)，不得把 scripted 终点重放说成 live 模型通过。

最终 57 份 JSON（包括全部主会话评审、映射、22 条 API usage 机械汇总、失败 live 原文、最新账本、零模型回放）已双份镜像到隔离临时根的 `evidence-backup-a/complete-evidence-tree` 与 `evidence-backup-b/complete-evidence-tree`；产品代码未由 eval executor 修改。
