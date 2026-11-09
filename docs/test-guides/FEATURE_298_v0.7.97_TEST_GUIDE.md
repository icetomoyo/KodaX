# v0.7.97 产品入口自动化验收

本指南验证构建后的产品入口。组件、协议和 SDK 单测继续保留，但不替代这里的真实进程与终端操作。

## 2026-11-04 Script 原始 VM 错误的按需诊断

基线 `142fb02f7`；本片仅实现下方历史计划中的错误恢复诊断，未实施类型数据优先呈现。
原 `Error: {name,message,stack,...}` 保持原顺序及内容；仅在结构化 QuickJS
`ReferenceError` 的消息精确为缺少 `require/process/Buffer/module/exports/__dirname/__filename`
且该名称不是已授权工具别名时，附加当前隔离环境、经已披露 tools 进行 I/O，以及
重试前核对 receipts/pendingCalls、已有副作用不会回滚的说明。不读取 guest global
以免执行 getter；不扫描/改写代码，不增加 Node 权限，不自动重放。只有原错误和
完整诊断共同装进原传输预算才追加，预算不足时保留原错误。

零费公开构建 SDK 回放保留原 r10 错误与成功回执，网络请求为零；证据在
`%TEMP%/kodax-script-contract-replay-v1PDN7`，日志为
`kodax-script-error-diagnostic-baseline.log`。新增公共 `runManagedTask` 回归先 RED：
原始异常存在，但无诊断；修复后验证写入一次、异常/堆栈与诊断进入模型及持久历史，
随后可走原生读取而不重复写入。其他回归覆盖普通缺变量、TDZ、Type/SyntaxError、
合法工具/本地别名、typeof、非 Error 拒绝、getter 不重复执行及预算不足。

### 有界错误后单步比较（不是完整任务验收）

先冻结两个真实状态：A `/0.json/rows/2` 已成功读取两个 Host 工具后遇到 require；
B `/1.json/rows/1` 在第一个工具前遇到 require。每状态 baseline/candidate 各一次，
除末条 tool_result 的 error 后附加 **234 UTF-8 bytes** 外，system、tools、messages、
回执和状态逐字一致。使用 `ark-coding/kimi-k2.7-code`、high、每次输出 2,048，
单请求 120s、总截止 300s、最多 4 次操作/物理请求、总 token 阈值 500,000、
每个未结算请求预留 100,000；费用预留 $4，并非实测账单。先跑离线预算自检，
再执行固定四调用，不执行模型生成工具，不重试、不 fallback、不追加样本。

| 固定状态 | 补充诊断的下一响应 | 原错误的下一响应 | 实测 tokens（候选/基线） | 耗时 ms（候选/基线） |
|---|---|---|---|---|
| A：已有成功 Host 读取 | Script 改用工具 I/O，仍错读业务 wrapper，且把 read wrapper 直接 JSON.parse | Script 改用工具 I/O，仍错读业务 wrapper，read 解析 fallback 未使用真实 data.text | 17,456 / 17,393 | 20,529 / 30,283 |
| B：工具前失败 | 两次合法原生 read，属健康探查 | 选择 Script，但错把文本读取当 data.value | 14,267 / 14,349 | 4,579 / 6,756 |

主会话先盲评并落盘，再揭盲：A 轻微倾向基线，但两者都不正确；B 明显倾向候选的
健康探查。两版均未重复 require，故此指标无区分度。候选发出 Script **1/2**、
基线 **2/2**；这不是实际脚本覆盖（生成代码执行数为 0），也不能用较多 Script
调用代表正确性。共 **4/4 完整 usage，63,465 实测 tokens**，无 partial/unknown；
候选共 31,723、基线 31,742；两个状态的输入各多 51 tokens，来自失败后才追加的
诊断，正常成功路径的上下文未变。缓存命中和耗时不同，n=1/arm/state，不能宣称效率
提升或跨模型泛化。单步没有完成任务，不能填写完整任务正确率。

工程结论：原错误上的真实、按需环境诊断可作为小范围可诊断性修复；本样本没有
证明 Script 计算/数据格式问题已解决。保留 native 路径、权限、预算、guardrail 及
所有原始回执，不接受强制 Script、严格字段 Proxy、伪造 require 或全局提示词扩写。
原始错误若已存在，也不等于模型一定能正确恢复。更完整的 Script 质量与效率仍需
其独立验收，不能随本片或 SDK 发包宣布关闭。

原始输入/输出、预注册、driver hash、盲评和揭盲映射在
`%TEMP%/kodax-eval-dumps/space-sdk-script-error-diagnostic-20261104/probe-DeYdJu/`；
驱动为 `%TEMP%/kodax-script-error-diagnostic-one-step.mjs`。下方历史的四请求
63,635 tokens 属另一轮合同原型实验，未合并成本轮样本。

实际构建的 `dist/script-cell.js` → `script-worker.cjs` 另经零网络回归：先确认一次
调用，再触发 require，原错误、metadata/回执均保留；追加文案与上述付费候选逐字
一致，下一 cell 返回 42，没有重放。证据在
`%TEMP%/kodax-script-error-diagnostic-built-cxY26k/evidence.json`。
修复后再用相同驱动回放原日志，EXIT 0、网络 0；证据在
`%TEMP%/kodax-script-contract-replay-FKi1gC/`。前两条真实 Host 读取的参数、正文、
data/sourceContent 及原异常前缀与修复前逐字一致；全部 12 条叶调用在仅归一化
各自临时 fixture 根路径后相等。首次直接比较因不同目录出现在文件工具显示中而
失败，未修改产品或忽略其他字段。`diagnostic-comparison.json` 保留此比较边界；
wrapper/转义等原失败继续保留，不能把回放断言通过当作任务本身通过。

### Standards

独立规范轴评审：0 项 finding；以 AGENTS、CONTRIBUTING 及 12 项 smell 基线审查。

### Spec

独立需求轴评审：0 项 finding；仅实现本轮授权诊断，未越界修改数据呈现、权限或
重放语义。第三位子 Agent 复核模型证据，确认建议只能限于条件式可诊断性改进。

最终工程门禁（Windows，本片冻结候选）：

- `npm run build`、源码及测试 `npm run typecheck` 均 EXIT 0。没有定义 lint 脚本。
  CLI 主体仍为 **5,177,070 bytes**，未放宽原有 5,177,344-byte 预算。
- 完整 Vitest、4 workers、retry=0：**1,414 文件通过、7 跳过；19,532 测试通过、
  87 跳过，0 失败**，耗时 1,311.48s，EXIT 0；无未处理错误。
  新增回归所在的 public SDK 文件 15/15、cell 文件 39/39 均在这次完整集合通过。
- 完整 `npm run test:bundle`：**99+3=102/102**，EXIT 0。
- 5,709 文件的源码/测试/构建身份在完整测试、包测试及收尾后保持
  `53af4024ab54c3f5d6754d4f5e1273965a53d8717384d5c7468a754508e24db0`。
  日志为 `%TEMP%/kodax-script-error-diagnostic-{build,typecheck,full,bundle}.log`，
  完整 JSON 为同前缀 `full.json`。早期 GREEN 预期遗漏原生 tool_call 外层 hook，
  仅修正测试对真实调用链的预期，再独立通过并由完整集合确认；生产权限未改。

以上只验收本地源码与构建。正式发包、已运行 Host 的升级以及 Space 成品接入
没有在本轮执行；跨平台、真实账号、覆盖安装与 Issue 371 保持独立。

## 2026-11-04 Script 真实日志根因与最小合同方案（诊断完成，生产未改）

基线 `f689d0fe1`。三个独立子 Agent 交叉核对 revision 10 的实际 system/tools、
生成调用和执行回执，排除“Host callable 未披露”与“SDK JSON/原文损坏”。环境
限制和统一 wrapper 说明已经下发；问题不能简化为再堆一段提示。已证的执行失败为
Node/CommonJS 假定、将 wrapper 当业务对象、复制 JSON 到 JS 模板时的转义破坏。
合同体积、局部返回型含糊和回执去重影响恢复的显著性仍是待检验假设。

零费用真实 SDK 重放命令为
`node %TEMP%/kodax-script-r10-execution-replay.mjs --expect-task-correct`，按旧严格
oracle 明确 EXIT 1；证据在 `%TEMP%/kodax-script-contract-replay-ePGvF2/` 与
`%TEMP%/kodax-script-contract-execution-red.log`。原 A 最后 cell 在没有付费请求
截断时能从真实 Host 返回值算出正确数字和原文，但额外 source.batch 仍使严格
交付失败。原 B 两 cell 稳定重现 require/JSON.parse 失败；仅将复制字面量的数据
入口换成 tools.read().data.text，原剩余算法即得到正确 groups/notes。它仍未写
成品且多 source.factors，不能称完整任务或真实模型恢复成功。重放没有自动执行
未知副作用，只在独立 OS temporary 目录使用已知只读 fixture 和临时文件。

付费前固定 Layer 2 两个真实状态：B `/rows/0` 的初始环境选择，A `/rows/2` 的
错误后恢复。每状态 fresh baseline/单因素 prototype 各一次，共最多四次 Provider
操作/物理 fetch；只捕获模型下一步，不执行生成工具、不展开 Run。ENV 仅替换
原有两句，明确 QuickJS／非 Node、无 require、I/O 经 tools。RESULT 仅重排 callable
说明并标 Promise<ScriptToolResult>：原 name、description、input_schema 及
sideEffect/planModeAllowed 等其余字段完整保留，原 result_ref 分支不变。结果
合同采用整组呈现改变，不能把差异单归因 Promise 字样。两原型尚未修改生产。

原始全部 system/messages、其他工具与 schema 保持；输入模型 `ark/k27 high`、
每响应 2,048 output tokens、单请求 120 秒、全段 300 秒；singleAttempt，额外
隐藏派发仍计入四次物理上限，不 fallback、不追补样本。未知派发前预留 100,000
token，总停止阈值 500,000，真实结算超额不截断；$4 保守预留并非账单。状态顺序
固定，每状态内 arm 顺序随机，主会话在不读映射与 thinking 的证据包中先盲评再揭盲。ENV 合法
原生选择和 RESULT 合理探查都允许；同步检查误生成 TS、虚构 helper 或其他回退。
一例/arm/状态仅作假设 pilot，不宣称总体智能、采用率或任务效率改善。

原型零网络自检已通过，假 fetch 达四次后第五次拒绝；其他合同/system/messages
结构比较相同。ENV 描述 23,299→23,343 bytes，RESULT 27,286→27,249 bytes；
静态字节不当作实际 token。源 Run 的辅助请求 option 对象未全存，当前冻结的是
完整逻辑状态和两 arm 共用显式参数，不宣称原生 wire/完整 Run 逐字复放。
原型、自检和后续 raw 位于 OS temporary，保留旧失败和原评分，结果另记。

### 单步结果与取舍

四次固定调用已结束，raw 位于
`%TEMP%/kodax-eval-dumps/space-sdk-script-contract-diagnosis-20261104/probe-wBWBuI/`。
`main-blind-review.json` 在读取 arm 映射前锁定，随后揭盲并将逐例结论、raw/输入
hash、指标与限制写入 `main-session-review.json`。四次均完整 usage，合计
**63,635 实报 tokens**，实际请求 4、执行生成工具 0；$4 仍只是保守预留，不是账单。

| 假设 | 盲评／揭盲结果 | 决定 |
|---|---|---|
| 精确环境称谓能减少误用 | 两臂都用了 tools.read/data.text，均无 require；baseline 先健康探查，prototype 过早猜错权重结构及输出层级 | 没有观察到目标收益；单例差异不证明候选导致总体回退，不把改词当修复 |
| 明确返回签名能修正取值 | 两臂都继续读外层 factors/batches/caveat，未用 data.value/sourceContent；均没有新增 TS/helper 误用 | 签名原型未成为有效补救，不直接落生产，不追加试样 |

三个已证失败点应分开：环境假定错误由 QuickJS 正确拒绝；外层 wrapper 错读变成
undefined，又被条件分支吞掉，最终把同一个错误空摘要自比较为“验证通过”；B 的
JSON 被复制到 JS 模板后发生换行/转义破坏。工具合同缺失与传输损坏已被反证。
长合同和去重的显著性影响仍非已证因果；请求/输出上限影响恢复，不能代替这几个
首发错误的根因，也不能用提高上限宣布问题解决。

额外零费用浅 guard 原型仅在隔离重放中包直接工具结果，确实在 A 的 `.factors`
外层读取处报 API 合同错误、保留前两次成功回执，错误摘要未写入；正确 data.value
和原文路径仍能算出正确结果。但是兼容反例已证：当前正常工作的
`r.structuredContent ?? r.data?.value` 在 guard 下变为 throw。这是普通属性读取
语义改变，不能默认为透明修复。它也不解决业务 data 内误猜、require 或复制转义。
因此不默认采用 strict guard、不扁平化业务字段、不模拟 require；原型只作诊断。
证据为 `%TEMP%/kodax-script-contract-replay-9RPYlY/` 及
`%TEMP%/kodax-script-contract-guard-compatibility.log`，网络请求为 0。

### 建议实施的最小两片（尚未实施，效果待验）

1. **已有失败的恢复诊断**：在 `script/worker.ts` 的结构化 VM 错误边界，仅针对
   已确认不可用的运行环境全局增强定位信息；保留原 name/message/stack、失败状态
   和真实回执，提醒工具可能已执行、不可自动重放。不扫描或改写用户代码，不把
   普通局部变量错误猜成 Node 问题，也不再增加一组全局任务提示。
2. **类型数据优先的模型呈现**：在 capability renderer 的可信投影与 model serializer
   之间，让模型保留 guest 实际的 data.value/text 路径，压缩 renderer 自己追加的
   重复展示；保留 producer 原文、summary、metadata、警告、分页/截断和原文回读。
   不反解析 provider 文本，不推断业务 schema。首片只做成功的叶结果、未改写、真实 JSON、
   字符串展示；多模态/error/取消/无 reader 或不匹配等沿原策略。

第二片必须比较**最终整 cell JSON**与真正旧序列化的 UTF-8 bytes，包含 selected、
显式返回及原 value_from_receipt 折叠；不更小就回退，不能抬高 baseline。复用现有
modelContent 元数据路径会给 guest/canonical 增加字段和容量成本，不能承诺逐字节
不变；建议使用模型层短命可信投影（内部 WeakMap，类似已有 Script model 状态），
不把提示写进 result/receipt。只在原结果及内容快照仍匹配时使用；clone、恢复或
缺提示时回退旧策略。它不是会话内数据存储，不增加 Runtime、持久化或恢复协议。

已用同一真实 renderer 做零费表示可行性验证：先断言其完整输出与真实 canonical
content 完全一致，再移除它自己添加的 structured JSON 展示。batch receipt 从
**1,915→1,689 bytes**，同时恢复真实 data.value、保留原文；scale 小值候选为
727→746 bytes，因而不采用。冻结整 cell JSON **2,982→2,756 bytes**。该原型没有把
提示附加到 guest/canonical，不能据此隐藏后续实现的状态/容量成本。证据在
`%TEMP%/kodax-script-typed-presentation-BqpxUI/evidence.json`；这不是新模型效果证明。

后续实现验收应分片：先公共 SDK/QuickJS 零费回放与接口回归，核对异常定位、原
引用/observe/wait、hook 改写/脱敏、metadata 伪造、optional/null/空白/blocks、
分页/显式返回及整 cell 字节回退；原生、guest 内容/数据与 canonical 不变。再对
真正改变的错误后状态做有界单步恢复观察，不重跑完整任务求绿。本轮决定为保留
既有生产行为、实施上述两片前先完成这些边界验证；不能宣称通用智能、效率或
任务正确性已经修复。独立业务约束也不能被“与自己生成的摘要相等”替代。

## 2026-11-04 最终候选真实模型补验（revision 10，已完成）

候选 `e177e0ce98a7e3f38653389382554ffadd31c7bc`。用户要求尝试验证尚缺的真实模型
效果与成本证据。本轮不改生产提示、工具、权限、模型配置或 SDK，只扩展已有有界
smoke driver；Layer 1 机制已验，但不能观察真实模型选择、代码生成与实际 usage。

固定 `ark/k27` / `ark-coding` / `kimi-k2.7-code`、high effort，Layer 3.5 三个条件：
旧 revision 9 显式 Script measurement 的任务、数据、严格原文预期原样保留；新增
NDJSON 乱序修订、停用、负数及 Unicode/空白 notes 的自然任务，分别用 Script 和
Coding 模式运行。后两者正文、文件、预期和原生工具白名单相同。前者只计显式功能
覆盖；后两者只作一个样本的模式/成本观察，零脚本或原生 fallback 如实记录。
Host 输出 schema 在真实授权 describe 路径提供，默认菜单不附加；模型未查询时
记“未观察 schema 消费”，不追加任务或提示来强求使用。逐例检查严格产物、实际
计算值依赖、脚本写入、真实回读、是否在 VM 校验、原文取用和完整历史。

三个条件各执行一次、逐一收束；每例最多 6 Provider 操作/物理 fetch/轮次，含
learning/retry；12 次共享预算计费叶执行、0 child，保留原生产 VM 限制。请求最多
2,048 output tokens、120 秒，任务从起始计 300 秒；完成后最多收集 120 秒，不重置
任务截止。未知 fetch 在派发前预留 100,000 token，结算按真实 usage 替换；每例
500,000 token 停止阈值、合计阈值 1,500,000，最多 18 次请求、$18 保守预留（不是
实测账单）。单次真实结算仍可能超过 token 阈值，必须保留超额且停止后续请求；
后续条件最多分配总阈值的剩余额度，已耗尽则跳过，不能截断 usage 来制造绝对上限。
不关闭生产 learning/stall；partial/unknown 不能当零实际成本，usage 不全不算节省率。

付费前已对预算“整次操作结束才记账”的缺口先 RED（6 次未知 fetch 超过预期 5 次）
再 GREEN，补派发预留、取消原因和完整 Session messages。旧 revision 定义不改，
原 30 秒收集默认保留；只有本轮用 120 秒，避免旧两例 learning 在约 30 秒被收集器
截断的问题。所有原失败/unknown 保留。零网络 self-test 另验严格 scorer、不同模式、
可发现 schema、内层 JSON 与原文计算/写回，以及缺凭据时不请求。最初 self-test 的
新 revision 未接入和 JSON 丢弃 undefined 导致的比较失败保留；修正的是实验接线与
JSON 归一化，未放宽产物 oracle。最终零网络日志为
`%TEMP%/kodax-script-r10-self-test-verified.log`。

付费前冻结 5,709 文件，清单 SHA-256
`8eacdc0a5b0869b2fe1dee0b2b8206864e8c4dad18c16c760b99dd3125783435`；
与已全量验收候选相比只变更本 smoke driver，生产源码和 dist 相同。driver SHA-256
`0b3b7b169d27223b8f36931830dbfbcaeef2455017187c62c4fe49085f3c0fa4`。
独立 Standards/Spec 两轴终审均 0 项未解决 finding。所有日志和原始记录独立保留。

raw、design、完整调用和主会话逐例语义评审落在 OS temporary 的
`kodax-eval-dumps/space-sdk-script-final-candidate-20261104/`。
本轮不是 prompt A/B，不跨模型泛化，不以任务完成或 `.data` 字样代替实际脚本计算；
不以单家族三条件证明总体智能无回退或因果效率提升。失败不改评分、不自动重跑；
由主会话结合任务有效性和原始证据提出发布建议，不预设“全部通过”。

### 实际结果与发布建议

完整 raw 在该目录下 `kodax-script-live-xuiIQR/`；driver 日志为
`%TEMP%/kodax-script-r10-live.log`。`main-session-review.json` 已由当前主会话逐例
审阅代码、执行回执、磁盘文件及原始输入后落盘，包含每例 raw/file SHA-256、输入
未变核对、判分一致性、数据依赖和发布建议；两位独立 agent 交叉核对任务与用量。

| 条件（均 ark/k27 high） | Run / 严格产物 | cell 成功/尝试（非任务成功） | 实际 HTTP | 实报 token | 任务/收集耗时 |
|---|---|---|---|---|---|
| 旧严格任务，显式 Script | 未完成 / 错误空摘要 | 2/4 | 6 | 已知 92,391，另 1 partial | 187,407/187,456 ms |
| 新 NDJSON，自然 Script | 未完成 / 未生成文件 | 0/2 | 6 | 94,828，完整 | 83,660/83,691 ms |
| 同题 NDJSON，原生 Coding | 未完成 / 严格正确 | 0/0 | 6 | 83,833，完整 | 86,048/86,079 ms |

三个条件均达到六操作准入上限，下一操作被拒；没有追加或重复样本。自然样本
实际启动 Script 为 1/1，但两 cell 都失败，不能算成功计算、功能覆盖或总体采用率。
显式条件不计自然采用，也不当作原生效率对照。原生正确产物与未完成 Run 分别报告。

- 显式 Script 的首响应 `max_tokens:2048` 无可用工具调用；首 cell 两次 Host 读取
  成功后误用 require。第二 cell 错把工具 wrapper 当业务对象，写出空 groups、缺少
  snapshot/complete、空 warnings；实际 data.text 回读及 VM 比对均成功，却只证明
  与同一个错误摘要一致。第三 cell 仅展示完整 wrapper，不算业务计算。第四 cell
  代码开始正确访问 data.value/sourceContent，但首叶已被预算取消，不能把生成代码
  当成执行成功；该代码还带额外 source.batch，不能提前承诺其严格产物必正确。
  九个 Script 叶终态为八成功、一取消、零未决；未查询 outputSchema。
- 自然 Script 首 cell 在 require 处失败，零叶调用；原生读取后又把源数据抄进 JS
  字符串，产生换行/转义后的 JSON.parse 失败，不能归因 data.text 损坏。随后原生
  多行 node -e 的回执虽为 Exit:0，但明确提示 Windows cmd 可能未传入脚本体，
  后续读取也确认文件不存在；最终只创建了空 process.js，没有有效计算或交付。
- 原生条件沿共用白名单保留 shell/read/write 等能力，实际通过 Node 读取原文件、计算、写最终 JSON，并
  fs.readFileSync/JSON.parse 回读；末次 shell 回执 Exit:0，从回读对象输出 ID 和
  core=28、edge=29、ops=17，磁盘文件通过完整严格 oracle。SDK read 读的是处理器
  源码，没有独立 SDK read 最终摘要，也没有全 JSON 预期断言或最终 assistant 收尾。
  期间重复写过同一处理器，不能描述为最优执行路径。

合计 **18 次实际 HTTP，17 次完整 usage 为 271,052 tokens，另 1 次 partial**；
实际总 token 为 unknown。预算账 **371,052** 包含 100,000 未知预留，$18 为保守
预留而非账单。该 partial 是显式条件 `/rows/4` 的 report_stall_judgment 副调用，
在 5,002 ms、taskAborted:false 时取消；生产 sidecar 默认 5,000 ms 到时 abort。
不是收集器 120 秒截断或 Provider 失败，partial0 不等于零实际成本。实际 learning
派发为 0；没有漏算或额外重试。三例均已关闭准入、tracked requests 已收束，收集
未超时，未达到 120 秒请求或 300 秒任务截止，结算超额为 0。

主会话结论为 **recommend-iterate，范围是 Script 的真实模型使用可靠性**。任务和
oracle 有效，结果受输出/请求预算及单家族单样本限制，不能证明更多预算仍失败，
也不能作为候选导致智能回退的因果证据。原文和 JSON 字段在真实回执中完整；没有
namespace 路由错误，但尚未观察到成功的 sourceContent→正确交付链或 schema 消费。
显式条件的最后取消 cell 主要在执行 ledger 记录，未验 Space 历史成品 view，不
因此宣布历史一致性通过或认定历史 bug。两种自然模式交付状态不同，不计算成功
等价任务的 token 节省率，也不宣称整体质量、速度或智能无回退。

保留已通过工程验收的 SDK 修复，可作为明确限定的 beta 继续集成验证；不把 Script
宣传为稳定可用或效率提升，不据此推广 latest。下一步先复用冻结失败轨迹做通用
沙箱环境及工具返回合同的最小复现/评审，如需改动先用有界单步探针验证理解和直接
取值；不再追加同类端到端样本求绿、不加任务/模型专属提示、不删除原生能力。
正式发包、运行 Host、Space、跨平台、账号、覆盖安装及 Issue 371 仍分开验收。

## 2026-11-04 Script 返回契约与按需描述（源码修复已验证，未发布）

基线 `37258ec5c`。按本轮重新诊断的结论，将 SDK 返回合同、模型任务正确性及
效率分开验收。旧 revision 8/9 的任务失败、partial/unknown usage 和原始记录保持，
不再用警告前缀样例是否全绿判定整个 Script 执行器。SDK 保证权限、返回值和
原始证据保真可读；消费者负责自己的业务 schema、原文要求及交付前校验。

修复范围固定为两项，不处理 OpenAI 协议、发包或 Space UI：

1. Host Run 工具与显式 mcp_call 的成功结果可提供 `sourceContent`，值为真实
   CapabilityResult.content 的独立原始视图，字符串或内容 blocks；与展示 content
   及结构化 data.value 分开。空串、空白和 block 边界不能靠解析展示文本还原，
   因此新增该可选视图。不解析 caveat、不猜 warnings 字段，也不信任 metadata
   伪造的 sourceContent。只在已有 Script 投影监听方存在时快照；沿原最终内容
   matcher 和错误门禁防止绕过后处理/脱敏。容量失败保留旧结果并诊断；监听和
   持久化异常继续传播。复用原 receipt/read_result/script_read，不新建存储或重放。
2. 标准 MCP 已有按需 mcp_describe/outputSchema，继续复用。仅补 Host 注册的
   可选 outputSchema 穿过公共 descriptor 与 IPC parser，并让既有描述 formatter
   兼容 Host description/server 字段。默认搜索、RunScoped 合同及模型菜单不附加
   大型输出 schema，不自动 describe、不新增查询工具或结果 schema 验证器。

模型侧只在原文可回读、展示中确有完整副本且 UTF-8 字节严格减少时引用重复
sourceContent；无 reader、未展示、空白、小值及显式返回保留。VM/持久层保留
完整 source，计入现有传输/容量限制，可能更早进入原有大结果回读路径。

确定性公共验收：两条工具路径、原文与 JSON 独立、空值/空白/blocks、
producer/guest/hook 修改隔离、scope 拒绝、可选容量回退、分页回读及无重放；
真实公开 managed Run 直接取原文生成交付，消费者写前比对、写后回读校验；
真实独立 Host 注册→Script 按需 describe，验证原始 schema/描述及零业务执行。
本轮问题均可由 Layer 1/零费用 SDK 集成回答，不发送新模型请求，不运行新
LLM eval，也不声称新字段能保证任意模型逐字复制或带来效率提升。

### 本轮实施证据

- 原文投影新增 21 项；连同既有 JSON 与 renderer 回归 55 项通过。模型呈现完整
  文件 57 项通过，包含选择/未选择输出、原文引用回读、完整证据不变及不重放。
  两条缺口均先 RED 再 GREEN：公开 managed Run 原先缺少原文视图；Host IPC
  原先丢弃注册的 outputSchema。保留对应 RED，不用旧成功结果替代。
- 公开 managed Run 经真实 QuickJS 并发读取两项 Host JSON、计算、写文件再读取；
  消费者逐字校验 sourceContent，原先的警告原文和计算结果 41 均保留。这验证
  消费者可实施交付校验，不代表 SDK 新增全局写入拦截或模型逐字复制保证。
- 按需描述单测 24 项通过；独立 Host + Client 的真实 IPC 集成 1 项通过，
  大型 schema/描述默认不进菜单，显式 Script mcp_describe 后完整返回，业务工具
  执行次数为 0。首次 IPC 失败来自子进程使用旧 dist；构建后同一断言通过，
  保留失败日志，不将其描述为源码故障或真实模型请求。
- 实际 npm pack tarball 的干净目录测试 2/2 通过：公开 SDK/Worker 同时取得
  sourceContent 和 JSON 计算结果 42，原始回执完整、Host 只执行一次，原生模式、
  Todo 与缺失 Worker 的原断言保留。该测试未发布包，Provider 为离线确定性响应。

范围覆盖率：原文 producer `capability-result.ts` 行 100%、分支 98.93%；
source/pilot 联合行 91.33%、分支 81.90%；describe 行 95.65%、分支 87.50%。
这是选定文件的 V8 覆盖率，不是整个仓库、全部 pilot 路径或真实模型质量覆盖。
原始结果保存在 `%TEMP%/kodax-source-content-coverage/`、
`%TEMP%/kodax-host-describe-coverage/` 及对应 tests JSON。

完整 build 首次真实失败：CLI 5,178,038 bytes 超过原 5,177,344 门禁。
复用既有 staticText/toolInputSchema，仅将 kodax_manual、skill、lsp_references、
repo_overview、lsp_document_symbols、lsp_workspace_symbols 六项静态 schema
移至同一资源（1,390 JSON bytes），不新增加载机制。全部 78 项构建 SDK 的名称、
说明和输入 schema 序列化字节与基线相同。最终 build 通过，CLI 5,177,070 bytes；
根源码和测试 typecheck 通过。Script API 教学仅增 84 UTF-8 bytes，解释原文视图及
纠正“完整输入合同不必发现”的说法；字节不当作实际 token，也没有任务专用提示。

构建、类型、tarball 与独立 Host 证据分别在
`%TEMP%/kodax-script-return-contract-final-build.log`、
`%TEMP%/kodax-script-return-contract-types.log`、
`%TEMP%/kodax-script-return-contract-tarball.log` 及
`%TEMP%/kodax-host-output-schema-ipc-built.{log,json}`。
Standards/Spec 独立交叉评审均 0 项未解决 finding。

首次完整 Vitest 在 4 workers、retry=0 下独立运行 1,120.03 秒，EXIT 1：
1,411 文件通过、3 失败、7 跳过；19,512 测试通过、3 失败、87 跳过。
日志与 JSON 为 `%TEMP%/kodax-script-return-contract-full.{log,json}`，保留原失败：

- 大 Host 回读已成功、计数 27,645，但旧断言只在末页查告警，实际 warning:false。
  新原文视图改变了 JSON 页边界；改为完整拼接、解析后核对展示及 source 两处告警，
  另校验完整长度、多页、canonical source===body 与展示保留全文。原单次执行、
  success/settled 和 4,096 bytes 限制均保留，生产分页不变。
- MCP SSE 识别明确为 Fetch `bad port`，发生在发 HTTP 前。仅让本地 HTTP 夹具复用
  既有 createFetchHttpFixture，健康路由不进入业务计数，仅 bad-port 原因允许重绑，
  其他失败、原超时和认证/SSE 断言不变，不修改生产 Fetch 策略或系统端口范围。
- OAuth 负向回调只有 30 秒测试超时，旧代码吞掉 redirect fetch 异常；没有记录原端口，
  不能认定首轮同因。测试候选端口和假 AS 复用同一健康夹具，并同时 await 传输响应与
  access_denied 协议错误，今后保留直接失败信号；不调整生产 OAuth 或放大超时。

两条实际 wrapper 的坏端口注入先 RED 后 GREEN；完整相关 4 文件 79/79 通过。
两位评审独立指出新断言不能把健康 fetch 总次数锁定为 3，已改为至少 3，允许夹具
按原契约继续排除真实坏端口，同时保留业务调用一次/准确 callback code+state。
该调整后新增两例再次 2/2 通过，49 项为名称筛选；最终源码/测试 typecheck 通过。
证据为 `%TEMP%/kodax-return-contract-fixtures-{red,green,reviewed}.{log,json}` 与
`%TEMP%/kodax-script-return-contract-types-final.log`。两位评审 finding 已清零。

第二轮前冻结 5,709 文件，SHA-256
`ddd648886d074e3d05724e2e750fe2665224476941356e6767b547982ba3d776`；
与首轮冻结清单相比仅上述 3 个测试文件不同，生产源码和 dist 未变。原清单
`e4747938e512212a2f26afa8c73e276bfe9ab84b19f5824abb29473f88e82140` 与两次
manifest 均保存在 OS temporary。

最终完整 Vitest 沿用 4 workers、retry=0，独立执行 1,106.79 秒、EXIT 0：
**1,414 文件通过、7 跳过；19,517 测试通过、87 条件跳过，0 失败、0 未处理错误**。
本次只增加只读即时失败 reporter，不改测试选择、超时或重试策略。上述三个文件均
通过，原首轮失败记录保持。结果为
`%TEMP%/kodax-script-return-contract-verified-full.{log,json}`。
随后完整 `npm run test:bundle` EXIT 0，原两组 **99+3=102 项通过、0 失败**，
耗时 84,845 + 15,129 ms；日志为
`%TEMP%/kodax-script-return-contract-bundle.log`。全量与打包后再次核对 5,709 文件，
SHA-256 仍为上述 ddd648…，未在验证期间改生产源码或构建。`git diff --check` 通过；
仓库没有 lint 脚本，不虚报 lint 已运行。

| 验收层 | 本轮状态 |
|---|---|
| 源码实现 | 两项通用返回合同修复完成；构建、类型、确定性组合、全量及打包通过，独立双轴评审无未解决项 |
| 正式发包 | 未发布；本地 npm pack 干净目录验收通过，不能据此推断 registry 包已有字段 |
| 实际运行 Host 能力 | 已验证本机 Windows 独立 Host 的新注册/描述路径；Space 在用 Host 未升级或核对，旧 Host 不作能力承诺 |
| Space 成品接入 | 本轮未修改或验收 Space；由其按已安装包与实际执行 Host 接入并验证 |

本轮 **0 次新增真实模型请求**；revision 8/9 的脚本覆盖、严格任务失败、实际 usage
及耗时维持原记录，不将离线 Provider、字段可用或任务样例正确代替新的采用率、
质量或效率结论。跨平台、真实账号、覆盖安装、麒麟自动回退及 Issue 371 继续独立
验收，不随本次源码修复或未来发包自动关闭。

## 2026-11-04 Script 显式执行与模式验收（源码已验证，未发布）

基线 `532243a27`。本轮补齐上一轮的验收缺口，区分“选中 Script 模式”、
“实际执行脚本”和“任务正确完成”，不以采用率代替功能正确性或效率。
不因旧 XML 样本单次 `require` 失败扩展 VM 权限或增加任务、模型专属提示。

先复核旧原始轨迹与实际下发的生产工具合同，再沿公开
`runManagedTask({workMode:'script'})` 补齐确定性组合验收：真实 QuickJS 消费
Host `data.value`、计算、写文件，再从真实 `read.data.text` 回读验证；复用已有
并发、顺序、分页、取消和历史测试，不新增第二套执行器。

真实模型预注册 revision 8：同一固定结构化数据任务、同一 `ark/k27` 路由与
受支持的 high effort，固定三个条件：显式要求 Script 取数/计算/保存/回读的
功能覆盖；自然任务的 Script 模式；相同自然任务的 Coding 原生模式。前一条件
不计自主采用率，后两条件只作单样本成本观察，不据此声称因果效率提升或整体
智能无回退。实际 Script JSON 计算须由主会话追踪执行代码和输入到交付物的
依赖链；不能从 `.data` 字样、DTO 可用、mode 或任务完成推断。

Layer 1 的功能、评分和预算自检全部先完成且不联网。Layer 3.5 的理由是确定性
响应无法观察真实模型生成及实际调用/token/耗时。最多三个条件，每个最多六轮、
六个 Provider 操作和六次实际 HTTP（含 learning/retry）、十二次共享预算计费的
叶执行、零 child；沿用生产 cell 六十四次尝试及独立截止/内存/传输限制。
每响应最多 2,048 output tokens、请求 120 秒、任务 300 秒，每条件 500,000
token 计账，总计最多十八次 HTTP/操作、1,500,000 token 计账，$18 保守预留
（非实测账单）。未知 usage 沿用至少 100,000 token 的保守占位，实际值另记
unknown。同 Provider 单在途，逐条件 drain/关闭准入/收束后再运行下一条件。
失败、原生 fallback 和零脚本保留，不追加条件或重跑求成功。

所有条件保持相同原生能力、权限和工具预算；仅按模式及显式覆盖需求改变条件。
工具数据、任务、字面量预期、停止规则及构建身份在付费请求前落到 OS temporary
design，原始输入/输出、完整回执和主会话语义评审同处留存。记录四层交付状态，
本轮不发包、不升级部署 Host，也不代替 Space、跨平台或 Issue 371 验收。

旧 XML 轨迹已按生产字节复核：实际 `script_exec` 合同包含
`No process, filesystem, network or imports`，没有 Node 可用声明。隔离环境正确在
首个叶调用前拒绝 `require('fs')`；后续 Windows 原生命令补救未完成。没有因果证据
表明增加提示能修好该单例，因此本轮保留现有教学和权限。长合同的显著性仍是未证
假设，不据此增加生产 token。

零费用公开构建 SDK 复放：第一个 cell 原样执行失败代码，failed 且零叶调用；同 Run
第二个 cell 仅将 `fs` 读写替换为现有工具与文本 data，XML/log 解析逻辑不变，
`read/read/write` 三叶成功，结果精确为 `u1/Tea & Coffee/9` 与 `u3/蓝灯/3`。
两 cell 与实际参数、结果完整持久保存，没有自动重放。运行耗时 2.63 秒、网络零次，
四次离线 Provider 响应含 learning，不能计作真实模型覆盖或原失败模型恢复成功。
完整证据为 `%TEMP%/kodax-script-environment-recovery-oEDHX8/evidence.json`，
临时执行器为 `%TEMP%/kodax-script-environment-recovery-probe.mjs`。

### revision 8 实测与新缺口

原文及主会话逐例语义评审保存在
`%TEMP%/kodax-eval-dumps/space-sdk-script-mode-acceptance-20261104/kodax-script-live-Brxwok/`。
运行前 5,701 文件清单 SHA-256 为
`d47d64006b5f6d512588cb983b139cda0833498e25320f49a4c08639fbb072e1`；
本轮早期重新 build 后，生产源码与 dist 仍与 `532243a27` 逐项相等。
冻结后的三个条件保持原样，没有在运行中加入新的修正或追补任务。

| 条件 | Run/严格交付物 | Script cell 成功/尝试 | HTTP | 实报 token | 任务/收集耗时 |
|---|---|---|---|---|---|
| 显式 Script，ark/k27 high | 未完成/未交付 | 0/4 | 6 | 99,762 | 74,810/74,839 ms |
| 自然 Script，ark/k27 high | 完成/正确 | 2/3 | 6 | 107,760 | 62,182/62,539 ms |
| 原生 Coding，ark/k27 high | 准入请求失败/未交付 | 0/0 | 3，含修复及 learning | 已知 9,122，另一次 unknown | 37,245/61,587 ms |

合计十五次实际 HTTP/操作，十四次有完整 usage，已知 **216,644 tokens**；一次
拒绝请求无 usage，实际总量是 unknown。预算计账 316,644（含 100,000 占位），
不能冒称实际 token；$15 是预留而非实测账单。所有请求已收束，无额外模型评审。

显式条件的四个 cell 都在 async helper 内 await 工具，但外层仅调用 helper，未
await/return 其 Promise；补 yield 后仍失败。worker 正确拒绝且保留 pending/unknown，
不能自动接管脱离 body 的 Promise 或重放。公共 code 合同和错误诊断缺少外层
生命周期的清晰说明，后续仅补通用说明，不加入函数名、领域或 Provider 示例。

自然条件确实在 QuickJS 中计算出正确结果，但先返回两份 Host DTO，随后把全部
记录与倍率重新写成代码字面量。一个 cell 又误用 `require` 失败，后一个成功计算，
最终通过原生 bridge 写入和回读。它证明脚本算术，**不证明直接消费 Host
`data.value` 或脚本内完成写入回读**；不能从任务正确推断组合效率。

原生条件的首请求在任何 assistant 工具调用前就收到 400 `function name is invalid`；
菜单包含带点的 Host 工具名。后续修复响应和 learning 不是任务继续完成。
这是协议工具名兼容缺口，不能隐藏原生工具或改业务身份来绕过，也不能据此宣称
Script 胜过原生。实际 Ark 走 Anthropic-compatible Messages；相似 OpenAI formatter
的零费用 RED 不是 Ark 已修的证据。原生效率对照目前无效。

工程建议为 `recommend-iterate`：保留原命名/数据修复与安全语义，补清生命周期
并处理实际协议边界，再仅对输入确实变化的最小集合重新预注册。历史失败保持，
本轮不扩展无关解析器、模型专属提示或新运行时。

### 通用生命周期修正与 revision 9 预注册

生产 code 字段说明与未等待调用的错误诊断各增加 66 UTF-8 bytes，明确 body
结束前须 await/return async helper 调用；不含函数名、任务或模型示例。调度、
并发、权限和未知副作用处理不变，yield 不会接管未挂接 Promise。域外 QuickJS
验证未挂接 helper 仍拒绝，返回 Promise 接管及外层 await 正常，各最多执行一次；
失败可能已有回执或 unknown，仍须核对证据，不能直接重放。
生命周期与公开模型合同先 RED 后 GREEN，两个文件整测 72/72；记录为
`%TEMP%/kodax-script-helper-{lifetime,contract}-{red,green}.json` 及
`%TEMP%/kodax-script-helper-final.json`。这些是确定性证据，不计真实模型覆盖。

revision 9 仅补验两个实际输入变化的条件：显式 Script 的公共生命周期说明变化，
及原生 Coding 的实际 Anthropic 协议工具名兼容修复；不重跑自然 Script。
复用 revision 8 的数据、schema、严格预期、业务正文与 `ark/k27 high`。显式测试
前缀进一步要求从工具返回值直接在脚本中计算、保存和回读，不把源记录抄成生成
代码；不提供字段或代码答案，不强制 selected_output，也不改生产采用策略。
这是独立的功能覆盖要求，不计自然采用率；两条件不作效率对照或提示词优劣比较。

先完成零网络合同/功能/预算/互斥入口自检与新构建；付费前保存全部精确条件、
源数据、预期和 SDK/Worker 摘要。每条件沿用六轮、六次操作/HTTP（含 learning/
retry）、十二次计费叶执行、零 child、2,048 output tokens、120 秒请求及 300 秒
任务限额。新段最多 **十二次 HTTP、1,000,000 token 计账、$12 保守预留**，
与 revision 8 已用十五次合计最多二十七次；旧 usage unknown 保持 unknown，
不转移旧预算、不覆写旧失败。串行逐条件收束；不因失败或无脚本再追加样本。

实际 Anthropic-compatible 修复只在协议边界生成可读合法别名，保留 canonical
工具名与真实参数、许可检查、ordered blocks/deltas 和 signed/opaque 历史。
`kdx_` 保留前缀的合法原名也编码；普通合法名不 hash、不改 schema/description，
无改名时沿用原引用。生效的 forced 别名不能冒充 canonical 名，原本忽略 forced
及空工具的策略保持。实际 provider 的 stream/complete、历史工具增删、前缀碰撞、
Unicode/长名、未知名及 forced 先 RED 后 GREEN，最终相关十一文件 **171 项通过**，
含十五个新回归。独立 mapper 的 V8 行/语句/函数均 100%，分支 97.05%，仅覆盖
该文件，不代表整个 Anthropic 入口或全仓。记录为
`%TEMP%/kodax-anthropic-wire-names-final.{log,json}` 及同名 `-coverage` 目录。
公开 native managed Run 另验真实序列化/SSE parser/Host 原身份与原参数/许可允许
和拒绝/canonical，**2/2 通过**，零真实网络。夹具调试的 effort/SSE/省略字段断言
错误未当作产品 RED；原问题依据是 revision 8 真实 400 和 provider seam 的失败。

源码修订后的构建曾两次真实失败：CLI **5,177,991** 及 **5,177,797 bytes** 均超过
原 **5,177,344** 门禁。沿既有 staticText/toolInputSchema 移动六个纯 schema：
followup_task、update_goal、exit_plan_mode、insert_after_anchor、validate_tool、
lsp_hover，合计 2,173 JSON bytes；复用已有资源、一次加载和初始化解析。
独立 AST 值/递归键顺序校验及构建后全部 **78** 项原生 name/description/schema
逐字节对比均相等，不删除工具或更改 schema。最终完整 build 通过，CLI
**5,177,109 bytes**；根源码/测试类型检查及零网络 driver self-test 通过。
两次失败日志为 `%TEMP%/kodax-script-followup-{build,final-build}.log`，最终构建
为 `%TEMP%/kodax-script-followup-release-build.log`，未放宽门禁。

### revision 9 实际结果与完成边界

付费前冻结 5,706 文件，SHA-256
`29c95fcb593396d58651d12a8596332bcd2092dcfed2263606979521e1e64c6a`。
原始输入/输出、完整执行与主会话语义评审在
`%TEMP%/kodax-eval-dumps/space-sdk-script-lifecycle-acceptance-20261104/kodax-script-live-bSSrzt/`。

| 条件 | Run/严格交付物 | 实际 Script cell 成功/尝试 | Script leaf 成功/尝试 | HTTP | 已知完整 usage tokens | 任务/收集耗时 |
|---|---|---|---|---|---|---|
| 显式 Script，ark/k27 high | 完成/警告原文不合格 | 2/3 | 10/10 | 6，含 learning 1 | 72,598，另 2 partial | 80,494/110,540 ms |
| 原生 Coding，ark/k27 high | 完成/警告原文不合格 | 0/0 | 0/0 | 5，含 learning 1 | 55,862，另 1 partial | 50,919/80,926 ms |

Script 三个 cell 都正确等待/返回外层 helper，未再出现未等待失败；这不是单例
因果改善证明。首 cell 在两次受权读取后误用 require 失败；第二个使用错误的嵌套
路径，写出空 groups；第三个直接使用新取得的 Host `data.value.batches` 与倍率，
完成 flatten/filter/group/scale，得到 east 45、north 54、south 51，保存并通过
Script read 的 `data.text` 返回磁盘内容。代码没有抄入源记录字面量。主会话将
最后回读文本解析为 JSON，确认与实际交付物内容相等；代码返回回读内容，未在 VM 内断言两者
相等。因此这次确实覆盖了 **真实模型直接 JSON 计算及脚本写入/回读**，不等于
整体任务正确或最少上下文。没有 selected_output 要求或原生工具删减。

严格交付物失败的原因是模型用 regex 抽取 caveat 正文，删除了 `Batch caveat:` /
`Scale caveat:` 前缀。SDK 原始回执和模型收到的正文都保留完整前缀，不是 SDK
隐藏警告；数值、排序、计数和 complete:false 正确。原生条件也完成相同正确数值，
但同样省掉警告前缀。两例均保留 taskCorrect:false，不放宽评分或加领域修复提示。
原生真实 gateway 接受新菜单、返回别名，SDK 按两个原名及原 batch 参数各执行
一次，再用 native write/read 完成交付，确认并未删除原生能力来提高脚本覆盖。

新段十一请求中八次完整 usage，共 **128,460 已知 tokens**；三次取消仅有零值
partial usage，不能解释为零实际成本，实际总 token 仍 unknown。计账 428,460
含三次 100,000 占位，$11 为预留而非账单。与 revision 8 合计 **26 次 HTTP**，
22 次完整 usage 合计 **345,104**、3 partial、1 unknown，实际总量未知；计账
745,104，低于累计 27 HTTP 的预注册上限。付费请求到此停止，不追加样本。
任务与收集耗时分别列明，后者包含 learning/drain；不同前缀与不完整 usage 不构成
效率对照，不声称提升、整体智能无回退或所有模型都能正确使用 Script。

工程建议继续 `recommend-iterate`：本轮 SDK 公共生命周期与已验协议缺口已修，
直接 JSON 脚本执行证据已补齐；完整任务的警告原文遵循仍未通过。保留通用修复，
不为这两例改生产解法或继续补样本求通过。修复限定 Anthropic-compatible 路径；
OpenAI Chat 的同类原名透传限制已有零费用证据，仍须独立处理，不能宣称全部
Provider 原生通道已支持任意工具名。正式发包、部署 Host、Space 成品及既有独立
平台验收继续分开。

### 本轮最终回归与交付状态

最终默认 Vitest 全量在固定 4 workers、retry=0 下独立执行，没有与付费样本或其他
重测试并行，**1,098.12 秒、EXIT 0**：**1,411 文件通过、7 跳过；19,476 测试
通过、0 失败、87 跳过**。JSON 报告 `success:true`，没有删除、过滤或重试失败。
记录为 `%TEMP%/kodax-script-followup-final-full.{log,json}`。
随后原样执行完整 `npm run test:bundle`，两组 **99 + 3 = 102 项通过、0 失败**，
耗时 87,548.615 + 15,052.427 ms，记录为
`%TEMP%/kodax-script-followup-final-bundle.log`。包含干净目录实际 tarball、worker
缺失的明确失败、打包 Anthropic 历史和独立 Host 场景，不代表 npm 已正式发包。

全量和打包后再次校验 5,706 文件清单，仍与付费前
`29c95fcb593396d58651d12a8596332bcd2092dcfed2263606979521e1e64c6a`
完全一致。独立 Standards、Spec 各 **0 项未解决 finding**；两份新集成测试由非
作者独立复核，主会话原始语义评审和 usage 也经交叉核对。独立 AST 确认六项
schema 值和递归键序不变，357 项既有静态资源值原样保留。仓库没有 lint script，
未把类型、格式或 diff 检查称作 lint。

| 验收层 | 本轮状态 |
|---|---|
| 源码实现 | 通用生命周期说明及已验 Anthropic 原生通道修复、构建/类型/全量/打包通过；真实 JSON 计算链已覆盖，严格模型任务和其他协议限制如上单列 |
| 正式发包 | 未发布，仍为本地源码修订；未改 beta.1 版本、npm tag 或稳定 latest |
| 实际运行 Host | 本地 SDK/Worker/受权 Host 与独立 Host 回归已验；未升级部署 Host，付费工具 fixture 不替代 reverse-bridge/lease 或外部服务验收 |
| Space 成品接入 | 本轮未验；跨平台、麒麟、真实账号、覆盖安装与 Issue 371 均不据此关闭 |

## 2026-11-04 Script 调用与程序数据后续（未发布）

源码基线 `49da64f24`，对应本轮真实模型暴露的命名空间与数据格式问题。
这是前次交付后的新修订，前次 revision 4/5 raw、失败、成本和通过记录保持原样。
API 契约见 [SDK 迁移说明](../SDK_MIGRATION.md#2026-11-04-script-调用路径与程序数据未发布)。

智能与泛化约束：从共同工具契约和受信结果生产者修复问题，调用路径适用于所有
当前受权名称；数据来自选窗阶段，不按扩展名解析、不剥离展示字符串。生产教学仅
描述 API，任务指令中不提供 Script 解法；原生入口、权限、预算与 fallback 保留。
新增调用路径与数据字段的静态/传输/持久化成本分别测量，不能从采用率倒推效率。

确定性验收使用真实 QuickJS cell、真实 read/dispatcher 与公开 managed Run：通用
裸名及命名表、关键字/内建/控制/原型冲突、带点/连字符/Unicode 名称；JSON、CSV、
TSV、普通文本、BOM、空行与 CRLF 规范化窗口；真实页尾预算、Unicode 长行续片及
EOF 与整源完整性的区别；错误/图片/未知 Host 输出、后处理改写、权限、取消与
read-before-edit。完整原始回执保留，模型仅省重复派生正文，主动返回的值不省掉。

### revision 6 有界真实样本预注册

机制问题先由 Layer 1 回归回答。真实模型的自主选择、执行覆盖与完整任务正确性
不能由确定性测试或单次下一响应替代，因此单独运行至多三例 Layer 3.5 smoke；
不做 prompt A/B、总体智能或效率提升比较。任务、文件内容、预期结果与停止规则
在付费请求前冻结并存入 OS temporary dump，system/tools/history 使用生产字节。

固定任务为 CSV（引号、Unicode、嵌入换行）转摘要、XML/日志过滤计算、含点和连字符
的受权 Host 工具组合。固定路由为 zhipu/glm52、ark/k27、zhipu/glm52，均显式采用
受支持的 high effort。第三例使用公开 `runManagedTask({extensionRuntime})` 的可信
embedder seam，不声称覆盖 daemon reverse-bridge 或 lease 协议。Host 原有 opaque
输出与警告保留，不伪造新数据投影。三例的成功判据只取实际交付物，不要求 Script。

每例至多 6 轮、6 个 Provider 操作和 6 次实际 HTTP（含 learning/retry）、12 次受共享
工作预算计费的叶执行，零 child；Script 每 cell 沿用最多 64 次尝试，尝试/拒绝另记，
不把拒绝视为已计费执行。每响应 2,048 output tokens，单请求 120 秒、任务 300 秒；每例 500,000
token 计账，总计 18 HTTP/1,500,000 token 计账，以每次 $1、最多 $18 预留。
这不是实测账单；未知 usage 以 100,000 token 保守占位，实际 token 仍记 unknown。
同 Provider 单在途，不同 Provider 可并行，第三例须在第一例 learning/drain、关闭
准入并收束全部请求后开始。不根据零 Script、失败或错解追加 requested 任务或重跑。

分开记录实际 cell/leaf 尝试和成功、任务正确性、原生 fallback、全部请求及完整/
partial/unknown usage、任务与收集耗时。`workMode:script` 只证明工具面可用；源码中
出现 `.data` 字样不证明实际消费，需主会话结合执行代码、回执与输出依赖审查。
原始输出、输入 hash 与主会话语义评审写入 `os.tmpdir()/kodax-eval-dumps/...`，
不调用 judge。无脚本与失败保留，不将不同任务/模型的样本解释为横向胜负。

最终源码、构建产物与真实运行结果见下列实际记录；正式包及 Space 成品继续独立验收。

### revision 6 实际结果与后续边界

原始记录位于
`%TEMP%/kodax-eval-dumps/space-sdk-script-namespace-data-20261104/kodax-script-live-F9E92m/`，
包含固定 design、完整输入/响应、canonical records 及主会话逐例语义评审。
对应 5,696 个源码/测试/构建文件清单 SHA-256 为
`bbaea050f67ba7864cb440e9b7d61db86466c37b4f57d472a00854fddf6d57b8`。
该中间候选完整 dist 留在 `%TEMP%/kodax-script-rev6-artifacts-eAPg0o/`，
SDK entry SHA-256 已与运行前 design 一致性核对；它不是正式发包。

| 自然任务 | Run/严格产物 | 实际 Script cell 成功/尝试 | Script leaf 成功/尝试 | HTTP/操作 | 实报 token | 任务/收集耗时 |
|---|---|---|---|---|---|---|
| CSV，zhipu/glm52 | 完成/正确 | 3/3 | 4/4 | 6/6，含 learning 1 | 83,835 | 71,196/80,688 ms |
| XML/日志，ark/k27 | 未完成/未交付 | 0/1 | 0/0 | 6/6 | 90,663 | 61,924/80,702 ms |
| Host，zhipu/glm52 | 完成/不满足逐字警告要求 | 3/3 | 5/5 | 5/5，含 learning 1 | 76,136 | 51,931/61,338 ms |

总计 **17 次 HTTP、17 个操作、250,634 实报 token**，usage 无 partial/unknown；
无 `selected_output:true` 请求。裸名兼容的确定性回归通过，但这些模型代码实际使用
括号调用，不能将其记为真实裸名覆盖。三例均启动 Script，不代表三例都正确完成。

主会话逐条读 raw：CSV 的解析器实际读取 `r.data.text`，处理 BOM、引号和嵌入换行，
计算后写文件并再次解析磁盘回读；这是真实程序取数与计算。首次 Native bridge 参数
错误独立保留，不计成 Script 错误。XML 例在隔离 VM 使用 `require`，于叶调用前
正确拒绝；之后原生多行 `node -e` 没有生成文件，已有 Windows cmd 提示完整返回，
模型未在六请求上限内修复。不能把它解释为文本 data 或受权工具名称错误。

Host 的带点/连字符调用与只读并发成功；数据、总分及 `complete:false` 正确。
模型将结果重构为字面量，删除了两条警告的 `Source caveat:` / `Detail caveat:` 前缀，
违反原任务的逐字要求。原 SDK 回执和模型上下文都保留这些前缀，不能归因为 SDK
隐藏警告，也不在样本后放宽 scorer。Host 文件回读实际使用了 `data.text`，但此前
Host 结构化值没有在 VM 中直接参与计算。

工程建议为 `recommend-iterate`：保留通用调用与文本数据契约，模型完整任务效果
继续单列。保持隔离 VM 的权限边界与原生能力，不为单例错误加入 Node、命令改写
或模型/任务专属提示。三个不同任务、两个模型、单候选不能证明整体智能或效率变化。

### JSON 程序数据的独立依据与 revision 7 预注册

代码追踪确认：Host 与显式 `mcp_call` 已返回公共 `structuredContent`，共同经过
`renderCapabilityToolResult` 时只保留展示形式，VM 丢失其程序类型。这是独立的
通用组合缺口；进程内公共 pilot 的 `geometry.sample-grid` 返回嵌套数组、布尔值、
null 和警告，执行求和应为 17，旧结果因 `data.value` 缺失失败，单次调用且警告完整。
该 RED 不使用上面的 issue 领域或 warning 字段，不能声称能修复模型改写警告。

本轮以受信 producer 透传 JSON DTO，保留所有显示、警告和原文；不解析展示文本，
不实现领域解析器。先验对象/数组/标量/null、absence、无效 JSON、原位修改、权限、
取消、原文和大结果分页等 Layer 1 回归，普通 native 无监听时不新增遍历或复制。

Layer 1 与新构建冻结后，revision 7 仅观察实际输入已改变的同一 Host 自然任务：
直接复用 revision 6 的 task、fixture、expected、路由 high 及 scorer。观察新 JSON
data 是否真正用于 VM 内计算，不能因数据可用或 `.data` 字样判断消费，也不以
warning 严格成功作为补样本理由。CSV/Ark 不重跑，无 requested 任务、不追加样本。

新预算独立为一例、6 轮/操作/HTTP（含 learning/retry）、500,000 token 计账、
$6 预留，其他期限、每 cell 限额、计费执行及未知 usage 规则沿用。连同旧 17 次
HTTP，累计至多 **23 次**；不是扩大旧 revision 6 的 18 次上限。不同源码的结果、
失败与成本各自保留，不合成同候选成功率或 A/B 提升。

### revision 7 实际结果与交付限制

原文位于
`%TEMP%/kodax-eval-dumps/space-sdk-script-structured-data-20261104/kodax-script-live-uDTCD1/`。
新冻结清单 5,697 文件，SHA-256
`497380500661c68c08a7b5a599e7b2a5d0656feadbcfc81d64cb2171f5c07505`。
主会话已核对 task/fixture/expected 与 revision 6 Host 完全相同，没有加 Script 要求。

该例 Run 完成、严格交付物正确：**3/3 cell、5/5 leaf，5 次 HTTP/操作，74,808
实报 token**（含 learning 1），无 partial/unknown；任务/收集耗时为
**54,658/63,428 ms**。模型自主在三个 cell 设置 selected_output；未知 Host 正文和
警告仍完整保留，最终文件的警告前缀逐字正确。显式返回完整 DTO 和 readback 也是
模型选择，不能从设置该标志证明已返回最少上下文。

新的 JSON 数据确实随 list/detail DTO 进入 VM 并带回结果，但执行代码只返回这些
DTO；第三个 cell 仍将模型上下文中的值重构为字面量，没有用 `data.value` 完成
JSON 计算。文件回读条件实际消费 `data.text`。因此 **JSON 可用性已验证，真实模型
的 VM 内 JSON 计算尚未验证**；独立 geometry 与 SDK 零费用集成计算不能代替此结论。

本轮合计 **22 次 HTTP/操作、325,442 实报 token**，低于累计 23 次上限，付费请求
到此停止。旧 Ark 未完成与 Host 警告改写仍保留。新旧 Host 各一次、不同源码和模型
输出选择，不构成 A/B；不从单次 token 或耗时差宣称提升，也不合并最终候选正确率。

工程上交付通用调用、文本及 JSON 数据契约；真实模型建议维持 `recommend-iterate`。
保持显式选择与原生能力，默认采用策略不因本轮样本改变。后续若要评价智能或效率，
需另立问题与预算，使用可解释的受控样本，不对失败现象追加任务/模型专属提示。

### 源码泛化与性能门禁

独立评审还用真实公共 seam 复现并修复了两个域外回退：深层合法 JSON 在可选快照
阶段 RangeError，原本会使成功工具变失败；现明确诊断并保留原始结果、无 data，
监听/持久化异常仍传播。128/1000 层完整 DTO 的实际 VM 往返通过，1600 层安全降级。
数组子类的自定义 toJSON 会让显示 `[100,200]` 与原对象 `[1,2]` 不同；现在该类值
不获 JSON 投影，原生显示继续可读。没有新深度配置、定制 codec 或额外 Runtime。

本轮 JSON 构建曾因 CLI **5,178,820 bytes > 5,177,344 bytes** 真实失败，记录为
`%TEMP%/kodax-script-json-build.log`，没有放宽门禁。沿既有 toolInputSchema/staticText
方式再移动 8 项纯静态 schema（共 2,692 JSON bytes），复用同一资源、一次加载与
初始化解析；独立 AST 核对值和递归键顺序均相等。最终 build 通过，CLI
**5,176,705 bytes**；全 78 个原生名称、描述、schema 及 JSON 键顺序与 `49da64f24`
精确相等。包依赖、原生工具、权限与参数语义不因压缩体积而删除。

现有静态文本中仅 Script 教学一个值改变：**1,250 → 1,940 bytes（+690）**，内容
为通用调用及 data API。实际 Host 样本的 30 条调用合同另增加 **916 bytes** 机器
生成路径；这都是静态字节，不当成 token。完整 Script entry 为 27,267 bytes，实际
请求已计入上表 usage。JSON 重复值仅在引用严格减少 UTF-8 字节时省，小值保留；
文本选定输出继续隐藏正文，完整 receipt/VM 的额外数据副本照常计入容量。

构建后零费用自测沿真实 SDK/Worker/Host/Session 路径从 JSON value 计算得到 8，
canonical receipt 含完整数据和警告；global fetch 硬拒、网络为 0。它验证打包连接，
不计真实模型覆盖。

### 最终验证记录

`npm run build`、根源码/测试类型检查通过；`test:bundle` 的完整文件集合串行执行，
两组 **99 + 3 = 102 项全通过**，耗时 317,054 + 15,344 ms，没有删除测试。
这些测试使用本地构建，不能当作 npm 已发包证明。

V8 覆盖率仅限定 `tools/read.ts`、`tools/capability-result.ts`、`script/pilot.ts` 与
`script/model.ts` 四个模块；相关 15 文件、289 测试全通过，耗时 56.26 秒。
行 **93.92%（402/428）**、分支 **90.52%（430/475）**、语句 **92.27%**、
函数 **94.80%**，各模块行覆盖率分别为 90.47%、100%、96.55%、96.93%。
Worker 内 QuickJS 的执行不计入此 V8 范围，由真实 cell 的名称、权限、取消及数据
往返测试另验；这不是全仓覆盖率。日志与 JSON summary 位于 OS temporary。

首次默认全量（4 workers、retry=0）在 1,215.14 秒结束：**1,405 文件通过、
1 文件失败、7 文件跳过；19,442 测试通过、1 失败、87 跳过**。
唯一失败是旧 `first-turn-script-retrieval.test.ts` 的 web_search 拒绝后恢复，
收到 `[true,true]` 而非 `[true,false]`，原断言没有记录恢复调用的错误正文。
完全不改文件单独重跑为 22/22；随后仅补 status/error、gate 次数、请求与完整
receipt 的断言上下文，并要求 completed，原拒绝、恢复、参数与预算判据不变，
再次 22/22，覆盖率运行中也通过。**首次失败根因仍未知，不能从隔离通过归因环境。**
原全量日志/JSON 保留为 `%TEMP%/kodax-script-final-full.{log,json}`，不覆盖失败。

第二次全量重新冻结 5,697 文件，SHA-256
`69ec401694eb0c29ee8540885cb3331d2068f82bb0e6c57b39d33390954f3477`。
与 revision 7 的清单差异仅是上述检索测试诊断；生产源码和 dist 完全相同。
该全量独立执行，不与构建、bundle、覆盖率或付费样本重叠，1,371.74 秒结束：
**1,404 文件通过、2 失败、7 跳过；19,439 测试通过、4 失败、87 跳过**。
检索原失败文件本轮 22/22，文本、JSON 和命名回归也通过。新失败分别为：

- `first-turn-script-repo.test.ts` 的 symbol_context 取消用例，实际错误是
  afterEach 删除临时目录 `EBUSY`，不是取消、正文、调用次数或预算断言失败。
  没有按此前猜测改 `Freshness` 归一化，也没有证明具体持锁者；仅沿用仓库既有
  `rm({maxRetries:10,retryDelay:100})`，保留路径校验、worker shutdown、最终抛错与
  全部原断言。该文件随后 **51/51 通过，124.29 秒**。
- `tools/web-fetch.test.ts` 三项 HTTP 夹具失败。首例明确分配到
  `http://127.0.0.1:6667`；Node Fetch 在发 HTTP 前拒绝该端口。本机 TCP 动态范围
  为 1024–15000，确实覆盖 Fetch 禁用端口。测试夹具按已有 REPL 验收方式增加
  独立健康检查与 bad-port 重绑；不修改生产 Fetch 策略或操作系统端口范围。
  这不反推首次无正文的 web_search 失败也是同因。

原记录保留为 `%TEMP%/kodax-script-verification-full.{log,json}`。最后的夹具复验与
冻结后全量另记，不能将两次有失败的全量改称全绿。

HTTP 夹具以真实公共 Fetch 健康路由选择监听端口，健康请求不进入原业务 handler。
仅明确 `cause.message === 'bad port'` 可重绑，最多 8 个候选；拒绝端口在选出新端口
前保持占用，防止 Windows 立即复用。非 bad-port、503 与超时不重试；失败 listener
最终关闭，清理错误仍传播，不能返回而遗留已选 listener。6 项 helper 回归与原
web-fetch/检索文件合计 **3 文件、34 测试通过**，业务请求数及全部原判据保留。
两轴独立复核均 0 未解决 finding，随后根 `npm run typecheck` 再次通过。

第三轮全量前冻结 **5,699 文件**，SHA-256
`98b2d272023ddddd422156d3599c1d021e95f69239a08265e0edb51c4d3c0afe`。
与 revision 7 相比只新增两个 HTTP 夹具文件、修改 web-fetch/Repo/检索三个测试
文件；生产源码和 dist 逐项保持一致，不为夹具修订重跑付费样本。
全量仍采用 4 workers、retry=0，独立执行，**1,416.87 秒**结束：
**1,406 文件通过、1 失败、7 跳过；19,448 测试通过、1 失败、87 跳过**。
本轮 Repo 51 项、检索 22 项、web-fetch 6 项、HTTP 夹具 6 项及全部新增 Script
回归通过。唯一失败是 `sdk-profile-contract.e2e.test.ts` 的 persona-only/none 冷恢复，
在旧 Host kill 并等待 exit 后，replacement Host 启动 `sdk-contract-host.fixture.ts`
时无法取得同一 daemon.lock；不是 profile 结果断言，也不是 HTTP bad-port。
原错误缺少 owner 快照，不能从此记录直接断言 PID 复用或 CAS 占用。
记录保留为 `%TEMP%/kodax-script-completion-full.{log,json}`。

独立代码核对发现该 fixture 发布锁时省略了生产已有的进程出生身份，并忽略
gone-owner 的 CAS 删除返回值。缺少出生身份的旧锁在 PID 可达时必须保守保持，
不能以降低生产锁安全性解决。夹具补齐身份与分支诊断的真实进程回归另记；
不修改稳定分页、取消、profile 权限或 Prompt，也不把推测写成已证故障原因。

夹具随后补齐生产 `readRuntimeOwnerProcessStartIdentity` 与 `kind:'daemon'`，明确
gone 后检查原 CAS 返回值，失败立即拒绝并输出安全 owner 摘要，不读 token。
独立真实进程先 RED 再 GREEN：启动旧 Host、杀死并等待退出，将其旧锁 PID 改为
已知活的父 PID、保留旧 birth 模拟复用；旧 fixture 因未发布 birth 拒绝替代 Host，
新 fixture 能区分代际。另验证活独立 Host、无 birth 的活 legacy PID 不能被回收，
协调锁占用时 CAS=false 仍拒绝且原锁不变。**4/4 通过，suite 13.420 秒**。
RED、CAS RED、首次 GREEN 与最终 GREEN JSON 分别保存在 OS temporary 的
`kodax-sdk-contract-host-fixture-{red,red-cas,green-pid-reuse,green-all}.json`。
这是共性夹具缺口的独立证据，仍不证明第三轮原失败就是 PID 复用。

profile 文件三处同类 Provider 监听复用上述安全 HTTP 夹具，保持原 handler、
`/v1` 路径、请求计数与所有权限断言；不将它解释为锁故障的修复依据。原 profile
文件 **13/13 通过，145.77 秒**，记录为
`%TEMP%/kodax-script-profile-fixture-verification.{log,json}`。
最终根源码/测试类型检查通过，两条独立评审轴各 0 未解决 finding。

最后验收冻结 **5,700 文件**，SHA-256
`feeded4610b4619737e7b7cb0b73873b17933fb7e2e084b108ff372654b0b6d9`。
与 revision 7 的差异仅为 3 个新增夹具/测试与 5 个修改的测试文件；生产源码和
dist 逐项一致。第四轮默认全量保持 4 workers、retry=0，附只读即时错误输出器，
不改变测试执行或 SDK 行为，独立执行 **1,476.83 秒，EXIT 0**：
**1,408 文件通过、7 跳过；19,453 测试通过、0 失败、87 跳过**。
报告 `success:true`，没有启用重试、删除用例或过滤旧失败。原 profile 13 项、Repo
51 项、检索/HTTP 夹具、新增 owner 4 项及所有 Script 回归均在此全量内通过。
日志/JSON 为 `%TEMP%/kodax-script-final-acceptance-full.{log,json}`。
完成后再次检查 5,700 文件清单与上述 SHA-256 完全一致；未发现仍运行的本轮
SDK Host fixture 匹配进程。此前三轮失败仍保留，首次检索和第三轮锁失败的确切
根因限制不因最后全绿而删除。仓库无 lint script，未将类型或 diff 检查冒称 lint。

独立评审分别收束为 Standards 0 未解决 finding、Spec 0 未解决 finding；
数据/数组/深度边界、schema 值和键顺序，以及 raw 到文档的结论均经交叉核对。

| 验收层 | 本轮状态 |
|---|---|
| 源码实现 | 通用命名与数据契约、构建/类型、确定性、打包及最终默认全量通过；模型效果与未验范围单列 |
| 正式发包 | 未发布；未改版本及 npm tag |
| 实际运行 Host | 本地构建 SDK/Worker/受权 Host 路径和自然模型样本已验；部署 Host 未升级验收，模型样本不覆盖 reverse-bridge/lease 协议 |
| Space 成品接入 | 本轮未验；跨平台、真实账号、覆盖安装与 Issue 371 继续单列 |

## 2026-11-03 beta.1 后续正确性与 Script/Workflow（实施中）

来源为本轮 Space SDK 修订需求及 Workflow 自动收尾追补，基线 `e733e51f`。
正式契约见 [SDK 迁移说明](../SDK_MIGRATION.md#2026-11-03-beta1-后续修复未发布)。
本节测试存在或单独通过，均不能替代正式包、正在运行的 Host 或 Space 成品验收。

基线包审计：本轮从 npm registry 读取 `0.7.97-beta.1` 的真实 tarball
（11,992,301 bytes），计算 SHA-512 与 registry dist.integrity 一致；包内核对到
promotion 非 historyDirty 刷新、pending 连接/撤回回执缺口、无可信 requiredWorkMode
字段，以及 Script 全串行、builtin 限定和完整结果全回传的实现。
这说明相关限制也存在于已发 beta.1，不表示所有用户每次都触发；历史首读的实际
因果与新修复由下述真实进程回归另证。`beta=0.7.97-beta.1`、`latest=0.7.96`
无需纠正。审计来源为 [npm 版本 metadata](https://registry.npmjs.org/@kodax-ai%2fkodax/0.7.97-beta.1)，
原件位于 `%TEMP%/kodax-beta1-audit-6af8d4734ca3487eb75624b195cb9b5a/`。

固定公共验收边界：Product sessions/inputs/workflows/catalog 与生产 Script 模型工具。
保持工作模式、权限、SA/AMA 互相独立；不以增加模型往返、删除原生能力或放宽
锁/所有权检查满足表面通过率。

- `src/sdk-client.promotion.test.ts`：独立 Host、已有/新增/第二客户端观察者、
  metadataRevision、正文、原 ID 与 stale cursor。已有 CAS、丢响应、附件测试继续保留。
- `tests/sdk-input-recovery.e2e.test.ts`：Main 实际崩溃而 Host 存活、同身份重绑、
  全文/附件/顺序、持久幂等撤回、丢成功响应、Host 崩溃与旧格式恢复。
- `packages/repl/src/interactive/storage.owned-read.test.ts`：held 实际写入期间，
  conversation boundary/cache 等待读取者自己的写入；另一个存储实例保持拒绝。
  topology 死 owner 冷读回收，live/unknown owner 保留。
- `tests/sdk-history-first-read.e2e.test.ts`：独立 Host、双客户端、observe 后首读、
  分页与第二代 Host；实际子进程持锁退出后立即读取，不老化 mtime。
  它不证明 Issue 371 所有历史延迟已消除。
- `tests/sdk-repo-intelligence.e2e.test.ts`：实际 Host 的 inspect/prewarm、双客户端
  一致状态、off 保持惰性、Provider 请求为零。底层 project-status/runtime-prewarm
  测试验证执行与预热共用缓存及降级事实。
- `tests/sdk-workflow-final.e2e.test.ts` 及 workflow cleanup 回归：完成/失败/取消、
  断连、冷重启后的最终 Session 结果及原文；只有资源已停、完整证据已持久、精确
  owner 且无引用的临时资源可回收。unknown/其他客户端/项目文件/保存定义受保护。
- 生产 `first-turn-script-*` 回归：实际 cell 与 leaf 调用、独立并发/写屏障、
  Host/MCP 目标授权、原生桥接、选择输出及原文、yield/wait/取消/历史一致性。
- `src/sandbox-runtime.posix-readiness.test.ts`：已有 Linux Node 指引/解释器分支；
  Windows 上的模拟与平台跳过不代表麒麟实机通过。

测试期间若重建/编辑 production 字节，launcher/build 身份保护可能拒绝启动；
必须冻结源码并完成构建后重新运行，不能放宽该保护或把这类失败计为通过。

### 有界真实模型样本预注册

`tests/space-sdk-script-smoke.eval.mjs` 是单独显式运行的 Layer 3.5 smoke，
不进入普通测试，不用于 prompt A/B 胜负或总体效率结论。先完成全部离线机制回归。
样本为 zhipu/glm52 与 ark/k27 各一个临时 JSON 聚合任务，不要求必须使用 Script；
每例最多 6 次实际 Provider 请求、12 次叶调用、每响应 2,048 output tokens、
120 秒请求期限及 300 秒任务期限。
同 Provider 单在途，不同 Provider 并行，不自动补跑失败样本或切换账号/route。
零付费请求时将设计修订为 revision 4：若两自然例都没有 `cell.started`，且至少一例
任务正确，才顺序追加一例由已成功 Provider 完成的明确 Script 请求，独立标记
`selection:requested`，不进入自然采用比例。自然组的 learning/drain/关闭准入先结束，
同 Provider 不重叠。若自然组已有真实 cell，或两例任务都失败，则不追加。
最多三例、总调用 18、总 token 计账限额 1,500,000；逐请求后核算、达到即取消，
未知 usage 仅作保守预算占位。估计 $1–9，以每次请求 $1 预留、最多 $18；
预留不当作实际账单或节省额。两自然任务的原文及评分不变，追加不是重跑或 A/B。

每例分别保留 output 文件正确性、实际 Script cell/leaf 覆盖、全部 Provider 请求
（含后台 learning）、逐请求原始输出与 usage、耗时；usage 缺失为 unknown。
零脚本、失败、超时均保留，不根据选择 Script 模式或模型声明推断执行覆盖。
运行前 design 与运行后 raw 写入 `os.tmpdir()/kodax-eval-dumps/...`；
主会话读取原始轨迹后判断任务有效性/限制，不追加 judge 模型。

付费前的独立复核修正了评测本身：保留实际 Provider 的完整 descriptor、reasoning/
schema/cache 能力；物理 fetch 在派发前限额；后台请求关闭准入并等待收束后才冻结计数。
原生 bash 继续允许，child 为零，其他非任务工具受 smoke 夹具限制。
本 driver 直接调用 SDK，不安装 REPL AutoMode bootstrap；默认 learning/stall 保存
并复用受控 Provider 实例。可绕过预算的显式 stall 外路由在任何请求前拒绝，且不输出
环境变量值。真实 Provider 描述与正常工具权限不被该夹具修改。
请求 usage、物理 attempt usage/partial/unknown 分开，保守预算占位不算实际 token。
`cell.started` 仅算尝试，另记 cell 完成与 leaf 成功/失败。修订发生在零付费请求时，
不根据样本输出倒改评分器，也不能据此报告正常生产环境的普遍采用率。

### 交叉评审及性能门禁

两轴独立评审后修复的遗漏包括：冷队列中普通输入与 Agent 约束输入不能因新连接
共用 lease 而合批；Workflow 合法 void 结果不能误作缺失原文；刚退出的真实 owner
拓扑锁不能等待 30 秒年龄门槛；大工具结果须允许 cell 内分页组合；空 text/store
与重复 yield 不能形成无界持久化队列。相应用例先 RED 再 GREEN，存活/未知锁、
未知副作用与真实并发失效规则保留。Workflow 另有真实进程在终态发布瞬间退出，
验证 pending 清理收据先于终态持久登记，重启仅续清理且不重复执行。

本轮 Script 最终教学文字 1,250 bytes（基线 738，增加 512），不含 leaf 的控制
工具契约 3,002 bytes（基线 1,132，增加 1,870）；这是静态字节，不能当 usage。
正常调用无新增模型评审，普通未改写调用不增加 prepared 落盘，独立 Run 不加全局锁。

第一次完整构建真实失败：CLI 5,068 KiB 超过原 5,056 KiB 门禁，未提高预算。
后续把 14 个纯静态 input_schema 放进已有 static-text.json，沿现有读取/打包路径，
只在定义初始化各解析一次，不新增 I/O、依赖或执行器。全部 78 个工具名称、描述与
输入 schema 精确相等；独立 AST 对比 14 个基线 schema 的 JSON 值和键顺序也相同。
第一候选 build 通过，CLI 5,175,432 bytes，小于原 5,177,344 bytes 上限。

第一候选的 Standards 与 Spec 当时各报 0 项未解决 finding；schema 侧载增量也由
两轴分别复核通过。后续反例又发现以下两项，旧结论不作为最终关闭依据。
Host/MCP metadata 同名输出标记
被渲染为正文，不能伪造可信选择输出投影；零模型探针确认正文警告仍完整。

继续审视清理边界时，真实独立 Host、双客户端复现：B 以 A Workflow 的干净临时
worktree 创建 Session 并运行只读工具；A Stop 后树被删，B 仍处于 running。
这是实际 P1，并非仅靠目录所有者就能保护其他客户端。永久 active/idle 两例先 RED，
在第一次收尾及冷恢复后检查原文、其他任务和项目完整性。
修复为 Host 项目/执行目录准入时一次 canonical realpath（覆盖 junction/symlink），
在每个 worktree 的同一 cleanup 锁内重验身份并持久项目 pin；从此作为用户项目引用，
不因 Session 空闲、删除或 Host 重启而自动回收。正常叶调用不增加路径检查，
不加全局锁、不扫描全部历史；真正无引用临时树继续回收。
运行开始先保存专属 host-owner.json，允许运行中另一客户端安全采用；普通同形状
目录缺少 Host owner 证据时保持普通项目行为，错误/缺失的已知 Host 项目拒绝采用。

另一项 P2：Git branch 删除失败被旧 catch 吞掉，新增 receipt 却记 completed，
树消失后无法冷重试。修复把精确 branch、原 OID 及 tree 路径在移树前落入本 run
的私有 pending；失败明确诊断，冷恢复继续同一意图；变更 OID 或被其他 worktree
使用的分支保留。没有新增 Workflow 管理 API、全局 prune 或业务执行重放。

第一候选的完整源码扫描为处理上述发现主动中止，不记通过；其构建产物门禁已完成，
但不覆盖后续保护修复。最终须重新构建并冻结，不能混用旧 dist 或旧通过计数。

新增保护后的第一次真实 Host 组为 15 通过、1 失败；唯一失败是 terminal-crash
夹具在树消失后立即要求 pending 为空。此前三例 project 专项也在同一观察窗口先
报 pending 尚在；原文、活跃任务与冷恢复的保护断言已满足。夹具改在原 10 秒期限内
等待 `cleanup.json.completed === true`，再检查 pending，而不是扩大期限或改变生产
完成语义；partial、terminal-crash 和 project 三例共用这个实际完成边界。

新保护再次触发 CLI 预算（5,060 KiB > 5,056 KiB）；继续沿原资源方式移动另一组
14 个纯 schema，总计 28 个，不提高门禁。最终构建 CLI 为 **5,175,938 bytes**，
全部 78 个模型工具契约继续精确相等；新增 owner/pin/branch retry 不增加模型调用。
最终两轴分别复核所有保护及精确空目录清理，Standards 0、Spec 0 未解决 finding。

本地工具审批曾拒绝删除两处早期测试夹具目录，仅返回 `blocked by policy`，未绕过：
`%TEMP%/kodax-workflow-final-8mnOXz` 和 `%TEMP%/kodax-workflow-final-ARdTI3`。
它们已保留，不能把手动测试环境收尾记为已完成。

后续完整扫描及真实样本见下文；源码、正式包、实际 Host、Space 四层分别报告。

### 2026-11-04 完整扫描后的修正

第一轮完整扫描实际为 1,398 文件通过、5 文件失败、7 文件跳过；19,327 项通过、
21 项失败、87 条件跳过（1,133.26 秒）。同候选的完整构建产物门禁为 102/102。
原始记录为 `%TEMP%/kodax-space-sdk-accepted-full.{log,json}` 与
`kodax-space-sdk-accepted-bundle.log`，不把这轮记为源码全绿。

21 项失败逐类定位：16 个旧取消用例在 `onToolExecutionStart` 准入通知就取消，
新增的持久 canonical 参数边界使取消能在真正 handler 前生效；改在真实 handler
已启动时取消，再保留完整收据、一次执行、后续叶不执行的断言。反向新增准入通知
取消时 handler 零次的回归，生产取消行为未放宽。三个小传输测试仍预期 failure，
现按新 reference/paging 契约验原文前后页、同游标重读和无重放。一个历史 projector
测试显式还原旧无 bridge 教学；当前真实 adapter 另验共享 Worker system、可发现
native bridge 与新增控制工具。另一个 dispatcher fake 缺新 Repo 方法，仅补齐 fake，
没有把新方法加入忽略清单。Script 13 文件 215 项、server 完整文件 80 项通过，
两轴独立增量复核无剩余 finding。

额外零模型探针还确认 fresh PID 已复用、旧启动身份不同时会被 30 秒年龄门槛阻挡。
冷读 known-owner 路径现提前核对已有启动身份，并将精确旧 PID/身份事实贯穿
coordinator、choosing 和 ticket 回收；unknown、live、legacy、空身份仍保留。
多个旧票据只核对一次旧 owner，普通 writer 没有新增 fresh OS 身份查询。
lock/owned-read 46 项、agent typecheck 通过；独立复核确认错误传播和互斥语义保留。

后续候选完整 build/typecheck 已通过，CLI **5,176,314 bytes**，继续低于原
5,177,344 bytes 门禁；全部 78 工具契约再次精确相等。
冻结清单为 5,694 个源码/测试/构建文件，SHA-256
`60730c026b81b6975025326113d43a683c34e2a50bb2f3aa3028d2f7599e6047`。
完整源码、构建产物和有界模型结果另记下面，之前通过计数不替代新候选。

### 2026-11-04 前候选完整门禁与真实样本

空启动身份修复后的前候选构建、typecheck、diff-check 通过；源码全套为
1,403 文件通过、7 跳过，19,358 项通过、87 跳过、0 失败（1,093.74 秒），
构建产物门禁为 102/102。实际独立 Host 覆盖 Workflow 9、输入恢复 6、模式准入 5、
模式恢复 3、冷历史首读 1、Script Stop 后首读 1、Repo 1；这些是该次全套内的文件，
不另加到总数。原始记录为 `%TEMP%/kodax-space-sdk-closure-*`。
该候选 CLI 5,176,320 bytes，5,694 文件冻结清单 SHA-256 为
`c395c46b61b7b939e4542a79fc0f81319bdf5571045f802a831c51e8adf102fd`。
7 个风险模块的 V8 专项覆盖：行 88.94%、语句 84.32%、函数 92.68%、分支 78.85%，
11 文件 181 项通过；不是整个仓库覆盖率，也未声称分支达 80%。

此前 `runtime-conversation-page-cold-open.bench.ts --samples=3` 因旧私有 Runtime
构造接口已移除而失败，未产生可用性能数据。没有改评分器或据此关闭 Issue 371。

revision 4 的两个真实自然选择样本原文保留在
`%TEMP%/kodax-eval-dumps/space-sdk-script-20261103/kodax-script-live-QDp4Yt/`：

| 样本 | 任务结果 | 实际 Script | Provider 操作/物理 HTTP | 实报 token | 任务/收集耗时 |
|---|---|---|---|---|---|
| zhipu/glm52 | 正确 `{red:5,blue:3}` | cell 尝试 4、完成成功 2；leaf 5/5 成功 | 6/6（含 learning 1） | 75,538 | 31,077/39,226 ms |
| ark/k27 | main 配置无效，未到模型 | cell/leaf 均 0 | 2/1（仅 learning 发 HTTP） | 1,976 | 1,053/39,239 ms |

主会话逐条读取 raw：GLM 第一个 cell 用未限定 `read`，第二个 cell 读到全文，
第三个 cell 重新读文件时拿到 `[Read Cache]` 提示且解析失败，第四个 cell 写入正确
结果并回读。其解析 footer 也有模型代码错误，不能把所有失败归因 SDK。
没有 `selected_output:true` 请求，不用任务成功代替该能力的真实模型覆盖。
Ark main 本地拒绝不支持的 effort `none`，没有 primary HTTP，判为 `eval-invalid`；
后台 learning 的真实请求与 token 仍计入成本。总计 8 个 Provider 操作、7 次 HTTP、
77,514 实报 token，无 partial/unknown usage；没有可用的跨模型采用率或效率结论。

Script 重读的故障是机制缺口：native 缓存只代表“模型已见正文”，不能供 guest 取数。
后续最小修复仅分离 Script lookup/record，保留 mutation 对原生缓存的失效和独立的
read-before-edit 内容哈希；不改提示强迫采用、不删原生能力、不追加模型评审。
上面的前候选全绿不覆盖此增量，最终候选须重新构建和验证。

revision 5 在请求前预注册：只补跑配置无效的 Ark 原任务，显式使用该模型支持的
`effort:high`，不重跑已有效的 GLM、不追加 conditional case。最多一例、6 次操作及
HTTP（含 learning）、500,000 token 计账、$6 预留；合计物理上限 7+6=13 仍低于
原总上限 18。所有未知 usage 处理、并发、停止与原始证据规则不变。
命令为 `node tests/space-sdk-script-smoke.eval.mjs --repair-ark-config`；
`--self-test` 不发网络请求；历史 revision 4 仅能显式重放，不自动执行。
此补样本同时处于缓存修复后的源码，不能将差异解读为 A/B 提升。

revision 5 原文为
`%TEMP%/kodax-eval-dumps/space-sdk-script-20261103/kodax-script-live-OqTHg6/`。
Ark 的最终文件正确，6 次 Provider 操作/6 次 HTTP、83,471 实报 token，任务/收集耗时
29,215/29,648 ms，usage 无 partial/unknown。实际 cell 尝试 2、成功 0；leaf 尝试 1、
成功 1；没有 selected_output 请求。第一个 cell 未限定 `read` 而失败，第二个 cell
用 `tools.read` 取到全文，却直接对带行号/页尾的结果做 JSON.parse 而失败；之后三次
原生 shell 读取、聚合写入和校验完成任务。第六次请求是最终答复，learning 没有额外
发出请求；关闭准入并 drain 后冻结计数。不是“成功完成 Script 聚合”的证据。

三份记录共 14 个操作、13 次 HTTP、160,985 实报 token；原无效 Ark main 仍保留，
不可将其剔除成本，亦不可将跨修订的两个正确结果当同候选成功率。主会话评审 JSON
保存在各 dump 目录，不调用 judge。工程建议为 `recommend-iterate`：源码机制可以
交付并保持显式 Script 入口，但当前样本暴露命名空间及格式化数据消费摩擦；模型采用、
成功脚本覆盖、选择输出覆盖和效率继续独立推进，不提高默认 Script 优先级或强制采用。
这些样本并非性能隔离基准，耗时包含本机并行验证负载，不作跨修订速度比较。

缓存修复后的第一次完整扫描记录于 `%TEMP%/kodax-space-sdk-finalized-full.{log,json}`：
1,403 文件通过、1 失败、7 跳过；19,362 项通过、1 失败、87 跳过，1,117.97 秒。
唯一失败为既有 `src/sdk-client.crash.test.ts` 第三例，第 243 行在原 60 秒期限内
等待 Provider 请求数为 2，实际始终为 0；不能归因为提前响应 SSE、辅助调用抢计数或
Script 数据缓存。独立完整文件一次 3/3 通过（39.69 秒），不覆盖该失败。
本轮新增独立 Host 场景、5 项 Script 缓存回归均通过；完整构建产物仍是 102/102。
后续只增强失败诊断，保留原断言、期限与权限，并停止其他验证负载后复验完整扫描；
不修改生产代码去追求表面通过，也不提前将这一轮记为全绿。

### 最终源码验收（2026-11-04，未发布）

最后增量只给上述崩溃用例增加失败诊断：成功路径没有新 RPC，两条原 60 秒 poll、
全部断言和权限保留。失败后各限 2 秒读取 Run/Input，并附 bootstrap 尾部及原 cause；
计时器会清理，诊断错误显式保存。增强后隔离完整文件一次 3/3、测试 typecheck 通过，
不据此解释此前失败。生产代码和 dist 自最后构建起未改。

停止其他验证负载后，以同样 `--maxWorkers=4 --retry=0` 单独运行完整默认源码套件：
**1,404 文件通过、7 跳过；19,363 项通过、87 跳过、0 失败、0 TODO**，1,075.35 秒。
原始记录为 `%TEMP%/kodax-space-sdk-isolated-full.{log,json}`。
其中原崩溃文件 3/3 通过（21,939 ms）；此前 `providerRequests=0` 的根因仍未确定，
这轮只证明未复现，不归因为负载或声称已修复该历史问题。

冻结清单共 5,695 个源码/测试/构建文件，SHA-256
`c906260b84858ee9d37646c6c91f4fcae406fbbd68acdb7f5a9f0a29b5d85fec`。
完整 build 与源码/测试 typecheck 通过；仓库没有 lint script，未声称执行 lint。
构建产物门禁按原脚本全部文件执行，两组 **99+3=102/102**，
日志 `%TEMP%/kodax-space-sdk-finalized-bundle.log`；只将第一组并发限制为 1，未删场景。
CLI **5,176,533 bytes** 低于原 **5,177,344 bytes** 上限，未放宽门禁。
全部 78 个原生工具的名称、描述和 input_schema 与基线精确相等。

包含新 pilot 在内的 8 个风险模块 V8 专项覆盖，12 文件 161 项通过：
**行 88.30%、语句 83.54%、函数 90.13%、分支 78.50%**。
记录为 `%TEMP%/kodax-space-sdk-finalized-coverage/coverage-summary.json`；
它不是全仓覆盖率，也不把未达 80% 的分支指标改称达标。

#### Standards

各切片及最后缓存、失败诊断增量经独立规范轴复核，当前 0 项未解决 finding。
最后增量仅在失败后执行有界只读诊断，保留 cause、清理 timer，不重试或隐藏失败；
没有新增生产 I/O、配置、跨层依赖或密钥输出。

#### Spec

各切片及最后缓存、诊断、文档增量经独立需求轴复核，当前 0 项未解决 finding。
Guest 数据读取与模型去重分离，原文、权限及内容哈希安全保留；旧失败、无效模型配置
和所有真实请求成本继续保留。源码、发包、Host、Space 及脚本效率分别判定。

两轴分别汇总：Standards 0 项，Spec 0 项。真实模型工程建议仍为
`recommend-iterate`，不因源码回归通过改写为效率提升或智能无回退。

| 层次 | 本轮状态 |
|---|---|
| 源码实现 | C1–C4、R1、Workflow 同 Host 收尾及 Script S1–S3 机制已实现并通过上述检查；模型效果单列 |
| 正式发包 | 已发布 beta.1 的审计保留；本轮新产物已通过本地构建门禁，尚未发布新 npm 包或改变 dist-tag |
| 实际运行 Host | 本机 Windows 独立 Host、双客户端、断连/崩溃/丢响应/并发回归通过；Space 部署中的 Host 尚待升级与能力核对 |
| Space 成品接入 | 本轮未修改 Space 代码或 SDK pin，未作成品验收；按 SDK 迁移中的交付顺序继续 |

Linux Node 指引沿用 beta.1 现有实现；Windows 上既有 readiness 文件 4 通过、1 平台跳过
不能替代 Linux/麒麟实机。跨平台、真实账号、覆盖安装及 Issue 371 性能保持独立验收；
此前性能 probe 失败、两处手动临时目录清理被拒及本次未复现的崩溃测试均不隐去。

## 2026-11-02 Space 接缝补齐（alpha.12 之后，未发布）

能力与接手顺序见 [SDK 迁移](../SDK_MIGRATION.md) 与 [Space 接缝](../SPACE_SDK_SEAMS.md)。
源码基线 `f24a922c1`；本节不改写已发布 alpha.12 的历史结果。所有新增模型响应为 loopback
夹具，不使用真实 Key，也不代表线上模型质量、云/OAuth 账户或 Space 成品已验收。

- `src/sdk-client.default-skill.test.ts`：公开 Product + 独立 Host，默认方法、persona、
  原问题、动态上下文、显式覆盖一轮及下一轮恢复；缺失默认方法在模型调用前拒绝。
- `src/sdk-client.execution-binding.test.ts`：实际消费时读取最后提交的专家，草稿不生效；
  排队显式方法卸载保留原问题；普通同权限 follow-up 留在当前 Run；后续拒绝只阻断该输入。
- `src/sdk-client.binding-recovery.test.ts`：保存 checkpoint 后启动真实独立 Host，原业务/
  persona/已展开方法、等价重排快照、新凭证、撤销拒绝、工具上限收紧；旧 alpha.12 队列
  重绑后缺失显式方法拒绝，原问题可撤回。该用例验证持久恢复边界，未伪称真实进程崩溃。
- `src/sdk-client.promotion.test.ts`：真实 Host 的 CAS、busy、双客户端竞争、丢失成功响应
  后查询/重试、冷重启、派生会话身份及 canonical/nativeHistory/附件/lineage/统计保真。
- `packages/coding/src/skill-invocation-policy.test.ts`：已完成准入 hooks 只执行一次，保存其
  附加上下文；恢复拒绝仅 frontmatter 放宽权限或方法来源/策略变更，不重放 hooks。
- `src/session-input-queue.test.ts`、`src/runtime-daemon/{protocol,client,reverse-bridge}.test.ts`：
  失败输入持久保留与原 principal 重绑，旧 Host 拒绝新 intent，错误帧有界返回，跨 principal、
  撤销/断连/替换与迟到反向结果失效。
- `tests/bundled-space-host.test.mjs`：实际 dist SDK + 独立 bundled CLI Host，默认方法与
  业务解析、同 Session promotion、冷重启操作查询；纳入现有 `test:bundle`。
- `tests/release-sidecars.test.mjs`：真实 tar/Windows zip 清单包含新 schema 数据；完整数据
  从 TypeScript 同源构建，原 CLI 预算 5,177,344 bytes 不放宽，CI 矩阵与触发条件不变。

本机初次全量扫描与其他重型验证并行，`sdk-client.startup.test.ts` 的 MCP 进入等待超过
15 秒；停止该扫描后完整文件与 Host 组重跑 167 项通过。该失败保留，不记为全量通过。
最终冻结全套与 CI 结果见本节末“最终验收”；旧失败记录继续保留，不能把分批计数相加冒充单次全绿。

追加配置原子性范围（Space `ca8d2313` 正式 alpha.12 反馈）：公开 Provider CRUD、Runtime
config/catalog、setup 与旧 permission 保存均做部分磁盘写失败注入，先 RED 复现截断/
丢弃旧字段，再 GREEN 证明失败保留原字节；坏 JSON/坏 Provider 集合/不可读原件明确拒绝，
诊断不带原文。`tests/bundled-space-host.test.mjs` 增加真实独立进程停在部分写入阶段、
杀掉 writer、并发 Provider 改名与无关设置更新；未加锁 reader 必须只见完整已提交值，
旧凭证 binding/CAS 不因改名获得新权限。该测试进入原有 bundle 门禁，不新增 CI job。

第二候选 `3e87509f0` 的 CI `41392027227` 为 15 个 job 成功、Windows source(system)
一个失败、publish 跳过。唯一失败是 1005 轮 Run 保留测试超过原 150 秒上限；本机分段探针
100 轮约 5.5–7.3 秒，总约 61 秒，通过 1000 条淘汰点无突变。此证据未证明远端超时原因；
探针已移除，未提高超时或降低 1005 轮覆盖。第二次本机全套 fast 3462/53 skip、unit
13198/5 skip、contract 1034 通过后，system 期间开始了新增配置修复，旧 dist 与源码混用，
该次 system 已停止，不能称为冻结全套通过。后续最终候选另行记录。

配置候选 `1a4b5f7f3` 的 CI `41397617918` 在 Windows build 和 packaged Electron 两个
job 的新增并发配置测试命中真实 `EPERM` rename。原文件仍完整，提交却失败；不能当作
测试噪声重跑。后续补丁只在 Windows EPERM 下沿原 staged 文件/锁做 200 ms 累计预算
重试；4 个公共 writer 回归先 RED（3 失败）再 GREEN，覆盖瞬态、永久拒绝、oversleep
与错误变化。没有放宽客户端有限锁忙重试、删目标或重放业务修改。该候选本机 bundle
102/102、实际 tarball 旧 Host 切换 3/3；源码全套 fast 期间为处理上述真实缺口主动停止，
不记全绿。此前基线 f24 的同机 1005 轮保留测试 61.6 秒、当前路径 61.2 秒，均通过；
单次对照未见线性回退，但不是远端超时原因的证明。该候选旧 Windows source 日志还确认
保留用例 130.15 秒通过；取消投影用例失败，但取消发生在全组详细栈输出之前，未保留其
断言失败位置。原 fake abort 立即 resolve、随后 get 却要求仍是 unknown 的竞态假设，已用
基线等 executor 先完成的合法调度确定 RED；新测试显式 gate 中间态，再 release 验证终态，
不据此宣称已证明旧 CI 唯一根因，也不改生产取消语义。

候选 `1627bc612` 的 CI `41399204135` 已通过新增并发配置测试，但 packaged Electron 的
真实 scoped Host 死亡恢复失败；bootstrap 明确记录 `daemon.json` 的 EPERM 重试 200 ms
耗尽。独立 Windows reader 以无 DELETE 共享的真实句柄，在首次 rename 标记后持有
500 ms：`state.windows-publication.test.ts` 的配置和 Host 状态两个公开写入用例均 RED。
后续只将这两个异常路径的累计重试调度预算改为 1 秒，两项 GREEN；永久拒绝、oversleep、
错误变化和无竞争零等待断言继续通过。未提高 Host 启动或测试超时，未删目标或重放业务。
该真实子进程用例进入 SYSTEM 和原 Windows 自动发现，不增加 CI job。
本机该候选 fast 3462/53 skip、unit 13217/5 skip 通过，随后为上述修复停止 contract，
不记为单次冻结全套通过。最终新候选另记。

首个冻结候选 `36d83f05e` 的 CI `41390222335` 暴露 npm `files` 白名单漏掉 schema
数据，以及临时 Session 删除后调用 `runs.await` 的真实竞争。前者以 actual npm pack
清单测试 RED→GREEN 修复；后者以公开接口等原临时 Session 确已删除后再 await，稳定
RED→GREEN。仅当前 owner 的 temporary Run 复用既有缓存准入，未放宽持久/外来 Run 访问。
同一候选本机 fast 为 3,458 通过、53 跳过、4 失败；未继续执行后续 tiers，不能记为全绿。
其中两个 one-shot 失败属于上述真实竞争；队列第三 Run 的调度等待改用其真实身份和
completed 结果再检查三次请求；crash 夹具改为先核验原进程身份退出，并保留 bootstrap
失败诊断。后两项单独重跑原已通过，未将新夹具写法宣称为首次失败唯一原因的复现证明。

### 最终验收：2026-11-02（未发布）

本段保留 Space 补审前的功能基线记录；后续修正见下一节。

功能候选为 Root `KodaX@b385395c9f8686aee182a4c6a38b4f3008421d32`，已推送
`origin/KodaX`。设计子仓仍为 `7927f835744643b418d463b10a2e1c1c4bdd12e8`，
Space `codex/sdk-alpha12-preparation@ca8d2313` 及其产物未改。没有打标签或 npm 发布；
已发布 alpha.12 标签仍指向本轮起点 `f24a922c1`，不能按版本字符串假定包含后续能力。

- 源码/测试类型检查、完整 build 均 EXIT 0；本仓没有独立 lint script。
- 单次 `npm run test:full`（Windows / Node 22）EXIT 0：fast 3462/53 skip，unit
  13217/5 skip，contract 1034/0 skip，system 1539/29 skip；合计 **19252 通过、
  87 条件跳过、0 失败、0 TODO**，1391 个文件通过、7 个文件跳过。该次是在最终
  构建冻结后从头完成，区别于上面中止或混合源码/dist 的历史尝试。
- 前后 7431 个源码/测试/构建文件 SHA-256 一致：
  `450bad435fb4a668940e054b8c709e112545f400da2d03cc2df80c0998d36475`。
  指纹排除文档；仅本节验收记录在完成后更新。完整日志 `%TEMP%/kodax-space-final-full.log`，
  类型/构建分别为 `kodax-space-held-type.log`、`kodax-space-held-build.log`。
  故障注入日志和测试进程的 beforeExit MaxListeners 警告原样保留，未通过提高监听器上限隐藏。
- [最终完整 CI 41401900534](https://github.com/icetomoyo/KodaX/actions/runs/41401900534)
  精确验证上述功能 SHA：16 个验证/构建任务成功，publish 按手动分支运行规则跳过。
  Node 20/22、Linux/macOS/Windows、两个 Windows source tier、真实终端、原生并发/
  权限、Electron、完整 bundle、实际通用 npm 安装与旧 Host 迁移均通过。总时长
  25m59s；CI job/并行度/矩阵/触发条件没有修改。CI 摘要 `%TEMP%/kodax-space-final-ci.json`。
- 最终本机构建专项 `node --test tests/bundled-cli-host-recovery.test.mjs tests/bundled-space-host.test.mjs`
  为 5/5，包含 print/scoped 真杀 Host 后原 Run 恢复和配置独立进程故障/并发。
  最新完整 bundle 与实际 npm tarball 的历史切换在上述 CI 成功候选上验证；本机较早
  `1a4b5f7f3` 的 102/102 bundle 和 3/3 tarball 记录保留为该候选历史结果，不冒充新候选结果。
- Windows CI 的真实占用用例 2/2（824/819 ms）；SDK Runtime 完整文件 342/342，
  取消投影 582 ms，1005 轮保留 118.205 秒。没有提高原 150 秒保留门槛。
- CLI 5157845 bytes，低于原 5177344 门槛，也小于正式 alpha.12 的 5174615 bytes。
  较早源码保留链路同机单次对照约 61.6/61.2 秒；`1a4b5f7f3` 的本机 bundle 性能记录为
  512 混合历史启动约 2.2 秒、220 退出树约 3.1 秒；最终 CI 重复通过同一恢复预算门禁。
  首屏采样在 `1a4b5f7f3` 完成，正式 alpha.12 与该候选各 5 次抽样中位数
  2.652/2.888 秒，范围 2.541–3.020/2.667–3.097 秒；小样本范围重叠，保留约 0.24 秒
  差异，不据此宣称完全无性能变化或因果提升。原始测量位于
  `%TEMP%/kodax-space-perf-ZziYud/first-ready-results.json`。

Standards 轴：最终功能及配置/Windows/取消夹具增量复审，硬违反 0、坏味道判断 0。
Spec 轴：默认 Skill、消费时业务绑定、原绑定恢复、同 Session promotion 与配置提交合同
无剩余发现。真实云/OAuth 服务、模型质量及 Space 成品接入仍由其对应发布/产品门禁验收；
离线 loopback 和进程组合通过不能替代这些验证。

### Space 独立补审修正：2026-11-02

Space 在 Root `34bc0528e` 独立复现 2 项 P2 和 1 项 P3；本机重放同一真实 Host 复现
脚本，也得到 binding steer 的 conflict、静态授权对照成功，以及 redirect 显式方法卸载
后默认回落。这是上轮漏测分支，上面 `b385395c9` 的全绿结果不覆盖其正确性。

- `sdk-client.binding-controls.test.ts` 对 steer、redirect 分别先 RED 再修复：同授权 steer
  实际到达原 AMA Run，重复提交不二次解析；业务/profile/凭据/tools 改变、异主、错误
  target、解析中撤销仍拒绝。Main 每次从真实 Host 读取 profile，没有用固定字符串伪造 key。
  redirect 的具名方法卸载后只保留原输入/admissionError，不产生默认请求；恢复方法可执行。
- `sdk-client.binding-recovery.test.ts` 参数化旧 after_turn/redirect 记录：旧 redirect 的
  `skill:true/explicitSkill:null` 先 RED，修复后在冷 Host、新凭据和收紧工具上限下仍保留
  原业务与原问题，缺失方法阻断。`session-input-queue.test.ts` 固定 absent/null/name 三态的
  JSON 恢复兼容；只修正 `skill` 注释，不改字段名或旧 checkpoint 格式。
- `tests/bundled-space-host.test.mjs` 把同授权 steer 和卸载显式 redirect 加入原发布包门禁，
  使用实际 dist SDK/独立 Host，与既有默认方法、promotion、冷重启保真一起验证，不加 CI job。
- 修复中相关回归首次出现一个旧错误文案断言失败；已保留旧授权/异主错误的优先级，
  没有通过修改旧断言或放宽授权来转绿。异步测试的初版等待制造了串行准入阻塞，已改为
  可确定观察的 binding 撤销，不能把该测试等待当成已复现的产品完成/取消回归。

原复现脚本的最后一段等待“错误地执行默认方法”；修复后这段等待自然超时，不能记为
产品失败或脚本全绿。OS 临时副本仅把观察条件改为正确的 `admissionError`，不改变操作链：
steer accepted，redirect 显式名已保存，方法卸载后 queued/not-started、请求仍为 1；
Host/HTTP/临时目录清理均确认。原始 RED 和期望修正版日志分别为
`%TEMP%/kodax-space-review-original-red.log`、`kodax-space-review-expected-results.log`。
本轮最终构建与 source/test 类型检查通过；相关 10 文件 72 项通过，实际 dist 发布包门禁
3 项通过。Standards（硬违反/坏味道）和 Spec 最终复审均无剩余项。

功能修正 `KodaX@00bfe7ed12407eda722a6bc4b15ace106e413dc5` 已推送，精确 SHA 的
[完整 CI 41415454375](https://github.com/icetomoyo/KodaX/actions/runs/41415454375)
16 个任务成功、发布按预期跳过，无失败。覆盖 Node 20/22、Windows source 两层、
Windows 原生并发/Electron、五平台归档和统一 npm 包的安装后 SDK 门禁。CI 日志确认
新增 binding-controls 和双变体 binding-recovery 在 Node 20/22 均实际执行通过。
最终代码/测试/构建产物指纹核对一致（7432 文件，SHA-256
`e186f169272b80fbd4d0b880d6751401bc448e87e86ab7544f371548bee0e092`）；后续仅补验收文档。

未修改 CI job、体积预算或发布行为；CLI 为 5,158,202 字节，仍低于原预算 5,177,344，
bootstrap 4,066 字节。CI 总墙钟 25 分 30 秒，各分组对照上轮有快有慢（Node 20/Windows portable 更慢，
Node 22/system/Electron 更快），该单次运行不能替代稳定性能基准；两组相关真实 Host
回归文件在 Node 20 各约 13 秒、Node 22 各约 10 秒。未改变启动入口、模型策略或提示词。
没有打标签、发布 npm 或修改 Space/设计子仓；Space 需升级包含本次修正的新 SDK 后再
完成产品验收。已有 alpha.12 tag 仍指向 `f24a922c117e0ece5d26224a133a69973b313ab6`。

### 普通 redirect 的补审修正：2026-11-02

Space 在 `d1ff86e4e` 再次复现一项 P2：活跃 AMA 先排普通 after_turn，再排普通 redirect，
默认方法和业务 revision 始终不变；第二个输入被延迟到独立 Run 时写成
`skill:true/explicitSkill:null`，上一补丁把它误认成历史显式 Skill，错误阻断。因此上一节
`00bfe7ed1` 的 CI 全绿不能作为本分支已覆盖的证据。
漏测点是前序 after_turn 启动的另一个 AMA Run 会再次消费后续队列，并把普通 redirect
转为独立边界；原目标 Run 已被停止不能排除这条后续路径。

本机原样重放 Space `plain-redirect-constant-default.mjs` 得到相同错误、请求数停在 2；
公共 SDK 的最小场景和旧 null 普通队列冷恢复均先 RED（分别约 5 秒），不是仅静态推理。
新增内部持久 `plainRunBoundary:true` 由 Host 在转边界时产生，持久失败不改内存；
JSON/checkpoint 恢复保留该来源，只允许 `skill:true/explicitSkill:null` 的组合。
旧 null 无引用记录可按普通输入恢复；有引用的旧 null、旧 absent 和具名显式输入继续
校验唯一方法，卸载或歧义拒绝默认回落。无新的 Client 输入参数或 Main 迁移职责。

相关真实 Host 用例覆盖默认不变、未知 slash、排队期间已提交默认方法变更；冷恢复
覆盖旧显式、歧义引用、已报错旧普通和带标记新普通。冷恢复夹具原先只测试拒绝，
未给下一轮设置 provider；新正向消费先在原 Run 完成后通过公开 settings 配置 fixture，
不能在 recovering Run 活跃时修改设置，也不能放宽生产守卫来适配夹具。
原发布包门禁同时保留 steer、显式方法卸载拒绝、普通 redirect、promotion 和冷重启保真；
未增加 CI job 或放宽超时/预算。

Space 原脚本的观察条件等待错误出现；OS 临时副本只改观察/断言，不改操作链，修复后
得到 submitted、独立 Run 完成、3 次请求、默认方法与原问题保留，Host/HTTP/临时目录
清理均确认。原 RED 日志 `%TEMP%/kodax-plain-redirect-original-red.log`，正确期望日志
`%TEMP%/kodax-plain-redirect-expected-results.log`。最终构建和 source/test 类型检查通过，
相关 10 文件 83 项通过，实际 dist 发布包门禁 3 项通过；双轴最终复审无剩余项。复审发现
generation checkpoint 的 `skill:"true"` 可能通过宽松 truthy 检查，新增测试先 RED 后改为
严格布尔校验，未放宽旧合法数据路径。本段为功能候选送审状态，最终 CI 在下文单列，
不能沿用前一提交结果。
暂无 tag/npm 发布，Space/设计子仓不改。

首次本轮 CI [41433864935](https://github.com/icetomoyo/KodaX/actions/runs/41433864935)
在 `cd151cb1d` 暴露一个已有 Windows 限时恢复门禁在并行环境下预算耗尽，疑似资源争抢：普通 redirect 的 dist 场景
通过，但并行包测试中的 default→coder profile 刷新在端到端 10 秒预算末尾超时。
保留的 `windows-sdk-startup-41433864935` artifact 显示旧 Host 正常停止，新 daemon 已在
11:14:18.568 UTC ready，没有卡住初始化；观察者的预算还包含旧 Host 检查、退出和新
进程冷启动，最后未在期限内确认连接，不能只凭该记录认定产品恢复死锁或忽略失败。

仅将这项 profile 刷新测试原样移至 `bundled-shared-profile-recovery.test.mjs`，与已有
`bundled-startup-recovery.test.mjs` 用 `--test-concurrency=1` 顺序运行；30 秒 idle 退出测试
仍在原并行组，其他包测试、CI job 与生产启动代码不变。10 秒刷新预算、阶段/能力断言、
失败日志捕获及精确 owner 清理不放宽，也不把整个包回归串行化。独立 Windows CPU
争抢与原生并发门禁继续保留。该 trace 本身尚不能排除性能原因，需新完整 CI 与独立
压力验证。新串行组本机 3 项通过（约 18 秒），当时完整新 CI 待验证，最终结果见收尾段。
同步修正压力 runner 的文件引用，并强制 TAP 输出包含目标用例的实际成功记录；旧引用
在 Node 上可能只输出文件级成功，0 个目标用例仍 exit 0。旧引用负对照已确认是假绿，
新 runner 以同样旧路径负对照时明确失败；正确路径 3 worker × 3 轮共 9 个真实用例通过。
发布说明及 Issue 222/371 的回归命令一并同步，不靠 exit 0 宣称压力门禁已执行。

本机完整包回归另出现一次 CLI 恢复夹具的 `EBUSY`：清理忽略 daemon stop 返回结果，
在仍有 governed background work 的 Host 退出前删除其临时目录。保留证据显示 Host 后来
正常 orphan exit；夹具现先等待 CLI 退出，再显式停止已核验的私有 owner 并确认完整退出，
最后删除自己的临时目录。生产 shutdown/background 策略不改，恢复正文断言不放宽。
收尾本机 `npm run test:bundle` 为并行 99 项加串行 3 项，共 102 通过、0 失败/跳过/TODO；
压力真实 9 次通过、空匹配负对照明确拒绝。此次测试组织/清理修正的双轴复审无剩余项，
SDK 功能源码自 `cd151cb1d` 后未变。首跑 CI 最终 15 个任务通过、1 个失败、发布跳过，
其失败保留如上，后续完整 CI 已在新提交上重新验证。

最终候选 `KodaX@962a41600d5676460e35866be908ec22b32c301b` 已推送，精确 SHA 的
[完整 CI 41438153424](https://github.com/icetomoyo/KodaX/actions/runs/41438153424)
16 个任务成功、发布按预期跳过，无失败。Node 20/22 日志确认 binding-controls 5 项、
binding-recovery 5 项、队列 22 项均实际执行；Windows Electron 日志确认独立压力组
3 worker × 3 轮共 9 个目标 case 成功，另一次为串行组，未发生空匹配假绿。
覆盖 Windows source 两层、真实终端流式历史、原生并发/Electron、五平台归档及统一
npm 包安装后 SDK 门禁。Standards 与 Spec 最终复审均无剩余项。

最终本机代码/测试/产物指纹在验收文档补录前后核对一致：7433 文件、SHA-256
`daaa6429ea0047adce11a283e59074d026374d6582d4359154a59a7d6515fab6`。
后续仅补验收文档，CI 归属上述候选。CLI 为 5,158,633 字节，低于原预算 5,177,344；
bootstrap 4,066 字节，生产启动预算、模型参数与提示词模板未改。CI 墙钟 26 分 33 秒，仅为本次运行
记录，不把单次 CI 耗时当作稳定性能基准；独立压力门禁保留原 15/10 秒限制并实际通过。
SDK 尚未发布，alpha.12 tag 仍为 `f24a922c117e0ece5d26224a133a69973b313ab6`，设计子仓
仍为 `7927f835744643b418d463b10a2e1c1c4bdd12e8`；Space 未改，需新 SDK 后再做产品验收。

## 2026-10-30 Partner 通用 Agent 契约修复（未发布）

下节保留修复前失败证据。本轮统一契约为：Partner persona 不增加只读上限；Session 选择
Agent 工作面，显式策略/工具列表/授权、SA Solo、审批与沙箱仍取交集。纯 profile 不制造
白名单。可信 Main 的异步 `services.createExecutionProfile` 读取实际 Host 目录，传递完整
策略元数据快照；Host version 2 在发现与目标调用复核。新增/变更工具需新授权，恢复须新绑定。

| 原缺口 | 修复验收边界 |
| --- | --- |
| MCP 别名恢复根拒绝工具 | 根 lease 视图先取交集，mcp_search/describe/call 再校验目标；schema 隐藏、目录不出现、实际 handler 不进入 |
| Actor runtime 参数反序 | scoped lease 优先，base registry ownership/pinning 保留；跨进程允许的 native lease 实际返回 |
| 白名单副本误判撤销 | scope 是原始注册 lease 的视图，invoke 校验原身份；拒绝项的已知 capability ID 及撤销后的调用仍拒绝 |
| 元数据谓词降为名字 | 快照保留 name/sideEffect/planModeAllowed；readonly→mutates-fs 同名替换不能复用旧授权 |
| Main 看不到 Host 工具 | 查询 Session Host 实际注册目录；Main 未注册的 Host-only readonly 扩展可见且实际执行 |
| profileId 名字隐式门禁 | research-persona/research-partner 差分均准入；无 profile 的 Partner 可实际 write |
| effective 范围重复推导 | 从实际装配/物理请求记录 executable/model scopes；缺 runner 的 Skill script 不出现；hydrate 后 activeTools 生效；重启可读 |

新增 `tests/sdk-profile-contract.e2e.test.ts` 验证独立进程、真实反向 lease 桥、Host-only 扩展、
显式受限派生子任务、独立 Actor 允许/拒绝调用、元数据 reload 后旧授权拒绝/新授权放行和重连/重启快照。已有
`tests/sdk-client-contract.e2e.test.ts` 保留 Skill、连接器、真实 Artifact 生成、专家验证要求和研究工具的实际 HTTP 调用、
拒绝工具的 tool_call 绕过尝试、Coder SA/AMA × 三种模式和 Actor 原 Turn checkpoint 恢复。
`src/sdk-profile-contract.test.ts` 锁定 lease 视图/撤销、元数据变化、opaque identity 和 hydrate 范围。
`src/sdk-contract-regressions.test.ts` 保留此前六项回归并通过实际 Provider 请求检查 scope。

2026-10-30 较早阶段的固定构建记录（先于独立 Windows gate 与 2026-10-31 恢复修复，
不代表当前最终验收；此处未提供可与新候选匹配的完整内容指纹）：`npm run build`、
`npm run typecheck` 通过；当时跨进程/协议/MCP
5 个文件 98/98 通过，bundle 54/54 通过。收尾的动态 import 尝试曾改变打包初始化顺序，
被产物回归检出并撤回；最终 MCP 过滤为无运行时依赖的纯叶模块，复用已装配工具范围、
显式 exclusions/策略和 Host 注册名冲突门禁。无静态 registry 回边。

该阶段 Standards/Spec 审查均无剩余阻断；hydrate 后范围遗漏已修复并锁定。

该阶段其他定向验证：跨进程及此前六项回归 13 项通过（其中独立 Host 用例 3 项）；新增
profile/协议定向组 78 项通过；模式/profile 组 34 项通过；最终构建与源码/测试类型检查
通过；构建后的 bundle 54/54 通过。研究用例另复测 2 项通过，包含真实 web_search /
web_fetch 请求到本地 HTTP 夹具、实际 PPTX 文件与 Skill 内容。

全仓首跑覆盖 1298 个文件：18013 passed、38 failed、98 skipped、19 todo。该次运行与
修复/构建重叠，包含旧构建门禁、旧 effectiveConfig 实现与授权服务夹具的失败，不能记作
单次全绿。14 个失败文件之后均完成复测：CLI/Runtime 363 项先 362 通过，唯一旧构建门禁
项另复测通过；沙箱/队列 105 通过、40 跳过；goal/Shell 6 通过；退出 4、任务报告 3、
旧 Run 2、Runtime 恢复 24、授权适配 25 项通过（组间有重叠，不相加）。新契约相关失败
由上面的 profile、跨进程和模式回归覆盖并通过。没有将这份混合构建的首跑包装为最终全量全绿。

这些是 Windows 离线 loopback/协议/文件效果回归；没有检查真实 Space 部署，也不宣称真实
搜索、连接器服务或专家模型的质量。原生 Artifact 的内部 write 继续服从调用方显式限制。

## 2026-10-30 Partner/Agent 后续审计（修复前历史）

审计基线为 `f6a010462` 加当前未提交的 SDK 六项修复；本节没有改变运行逻辑或授权。
以下结果限制下节历史通过记录的外推范围。历史 18045 项通过不覆盖这些新场景。
未检查实际 KodaX Space 源码、配置或部署，不能断言其默认策略和 Artifact 接入路线。

结论：在同样的 workMode、agentMode、Host 能力与显式授权下，Partner persona
不应隐式成为只读权限配置。当前普通 Agent 的 bash/write/edit/spawn_agent 不因
Agent workMode 被排除；SA 另有 Solo 子 Agent 排除项。无禁写策略的 Partner 在独立
Host 上已通过公开 `runs.startTool(write)` 写出文件并读回校验。这个正向事实不代表
应该忽略任何调用方已经明确设置的 deny、审批或沙箱边界。

| 发现 | 证据与影响 | 状态 |
| --- | --- | --- |
| 根 profile 上限未覆盖 MCP 目标 | 独立 Host 的模型 schema 隐藏 `audit_denied`，`mcp_search` 仍返回其 capability ID，`mcp_call` 实际进入 Main handler。根绑定未收窄 lease，MCP 调用没有复核目标工具的 profile 策略。 | 已跨进程复现；优先修复 |
| 独立 Actor 的合并参数反序 | `server.ts` 的 Actor 调用 `mergeExtensionRuntimeContracts(base, scoped)`，而函数将首参视为 Host lease。模型看得到允许的 lease 工具，调用却被路由到 base provider，实际报 `Capability provider "mcp" does not implement execute()`。根 Run 使用相反且正确的顺序。 | 已跨进程复现；既有统一契约遗漏 |
| Actor 白名单副本触发错误撤销判断 | `reverse-bridge.ts` 的 `allowedTools` 创建 lease 对象副本；调用时用对象引用与注册记录比较。白名单内工具被误报 `Host tool lease was revoked.`。这与上一项是独立缺陷，只修路由仍会失败。 | 已用真实 bridge 定向复现；既有遗漏 |
| 策略快照丢失工具元数据身份 | `createExecutionProfile` 将 Main 进程的元数据谓词降为工具名称数组。探针中同名工具从 readonly 替换为 mutates-fs 后，Host 名称校验仍放行，而原始 readonly 谓词应拒绝。 | 已复现语义损失；未证明实际 Space 正在发生该替换 |
| Host-only 工具缺少完整的授权候选目录 | helper 只读取 Main registry 与手动提供的 lease descriptors。Host 独有/后加载的 readonly 扩展满足原始谓词，仍因不在名称快照而隐藏。保守拒绝本身合理，但无法声称原策略与通用 Agent 能力等价。 | 已复现；契约支持范围缺口 |
| opaque profileId 仍影响准入 | 同样 `surface: code`、Agent 模式和显式 tool 调用，`research-persona` 完成，改成 `research-partner` 即被要求可信 profile/ceiling。核心仍按名字分词识别 Partner；新门槛延续了原先的身份耦合。 | 已差分复现；应与 persona/授权契约分离 |
| effective toolScope 仍不等于实际工具范围 | 无 Skill-script runner 的 managed Agent，实际 worker schema 排除 `run_skill_script`，启动观测却包含它。activeTools 修复只覆盖了其中一个过滤条件。 | 已定向复现；观测实现仍重复推导 |

根因定位：`src/runtime-daemon/server.ts` 的 `bindTrustedRunInput`、
`actorToolRuntimeFactory`、`mergeExtensionRuntimeContracts`；
`src/runtime-daemon/reverse-bridge.ts` 的 `createHostToolRuntime`、`invokeHostTool`；
`packages/coding/src/tools/mcp-call.ts`；`src/execution-profile.ts`；
`src/sdk-runtime.ts` 的 Partner identity admission；`packages/coding/src/task-engine.ts`
的 `computeVisibleToolScope`。本轮没有将局部探针或设计建议当成已修复结果。

诊断运行：本地 7 个探针中 1 个基线通过，6 个预期契约断言失败；独立 Host 探针
确认 schema、MCP discovery 和实际 handler 的矛盾，以及 Actor 的可见/调用矛盾。
后者另验证 Partner 允许的 write 确实执行。循环用 loopback Provider 和无外部副作用
的 lease handler，不访问实际连接器服务。最后两次诊断日志分别保留于
`%TEMP%/kodax-sdk-profile-local-audit.log` 和
`%TEMP%/kodax-sdk-profile-cross-process-audit.log`；临时探针保存在同机临时目录，
未加入正常通过测试集合。先前构造探针时的语法/夹具错误不计为 SDK 缺陷。

需要补齐的契约与验收：

- persona/验证要求、workMode、SA/AMA、授权上限分别表达；不按产品名字隐式限权。
- 策略针对 Host 实际加载的工具及其元数据求值或校验，并明确快照/reload/恢复边界。
- native、tool_call、mcp_call、Script 与子任务执行检查同一个目标能力；目录过滤不能替代调用授权。
- 独立 Actor 的声明、父任务派生 Actor 的权限继承分别验收；允许的 lease 工具要实际调用。
- Partner 无额外 deny 的正向能力和显式受限策略的负向能力都测，继续保留 Coder SA/AMA × 三种 workMode、专用子 Agent、checkpoint 恢复回归。
- effective 配置应消费实际装配结果；确认模式之外还需区分可发现工具、可执行工具与待授权操作。

仍需进一步验收而未在本轮证明：实际 Space 迁移、native Artifact adapter 与 lease
路线的等价性、Skill 动态上下文/脚本/显式 fork 的授权依赖、真实专家验证质量。
workMode 的专用子 Agent 例外是已有设计，不能把子 Agent 正常保留 Coding 声明
误判为根工具桥接绕过；但子任务仍须受各自适用的显式授权约束。

## 2026-10-30 SDK 组合与配置边界

本轮为 alpha.11 后未发布修复，契约见 [迁移指南](../SDK_MIGRATION.md#2026-10-30-sdk-组合契约修复未发布)
及 [配置生效边界](../CLIENT_CONTRACT.md#配置生效边界)。六项审计回归分别覆盖：

| 原缺陷 | 修复与验证 |
| --- | --- |
| 数量 token 字段被脱敏成字符串 | maxOutputTokens 的 read/effective/实际 Provider 请求均保持数字 |
| Host 收口后 Partner 无受支持的执行入口 | 原 surface/profileId 准入；Main 快照保留 profile/验证/策略/lease；显式限制继续生效；后续七项修复取消 persona 的额外准入要求 |
| effective toolScope 忽略 activeTools | 扩展 activeTools 只留 read 时，观测范围与实际执行范围一致 |
| Actor 恢复意图在 daemon proxy 丢失 | resumeCheckpoint 与空 objective 透传；旧能力明确拒绝；杀进程后续跑原 Turn |
| Script＋SA 错走 Coding 底层入口 | 使用 managed Script runner 并保留 SA 的子 Agent 排除项 |
| 计划权限/effort 视图与真实请求不一致 | held 请求期间改 permissionMode 或 planModeEffort，下一物理请求实际采用 high |

`tests/sdk-client-contract.e2e.test.ts` 的 Host 通过 `node --import tsx`
在独立进程创建，从公开 Client 走实际 socket/反向 lease 桥和 loopback HTTP Provider。
Partner 同时检查模型 schema、tool_search 的 function schema 和实际 tool_call：
repo_overview/bash/write/edit/spawn_agent 被拒绝，未生成禁止文件或子 Actor。
允许的 Skill 实际加载；连接器与专家工具经过夹具 lease handler；Artifact handler 调用
真实 SDK runtime 生成 PPTX 并检查 ZIP 文件签名。profile 指令和验证要求保留。
Coder 的 SA/AMA × Agent/Coding/Script 六组均实际请求完成；两个 Script 路由还实际
调用 script_exec → tools.read 并检查 completed 回执和文件内容。独立专家 Actor 保留
lsp_definition。另一用例等待 Actor 和 Run checkpoint 均持久化后杀 Host，重建
Host、重获 scoped credential，并用 followup 继续同一个 Turn，未创建新 Turn。
Provider/连接器/专家结果为离线夹具，不宣称真实搜索或模型验证质量。

配置回归还覆盖：保存值先后1234/2345进入新 Run；活跃 Run 两次物理请求仍1234，
下个 Run 才2345；清除值不复活启动投影；外部环境8888优先且不会被误删；旧 Host
没有 application 时保持未知。测试资源退出、启动和轮询有界。

```text
npm run build
npm run typecheck
npx vitest run src/execution-config.test.ts src/execution-profile.test.ts src/sdk-contract-regressions.test.ts tests/sdk-client-contract.e2e.test.ts --maxWorkers=2
npm run test:bundle
npm run test:full
```

以下为独立 Windows gate 和 2026-10-31 恢复修复前的 SDK 六项修复历史记录，
不作为当前源码验收；5128KiB 为当时本地中间预算，当前预算见 ADR。

当时 Windows 定向15项通过；新增两个 helper 定向覆盖的行/函数均100%、分支91.11%，完整发布构建
及无 Node 环境的 Product 类型消费者门禁通过。构建产物54项全部通过，包含真实
tarball Script、Skill、MCP全文、任务报告、崩溃/退出/共享Host与恢复；构建固定后
运行，未在测试中途重建。CLI5123KiB，尺寸上限从5120KiB调整至5128KiB，新增
契约代码使用该余量；冷入口和依赖隔离门禁保留。全层回归结算：

| 层 | 文件 | 通过 | 其他 |
| --- | --- | --- | --- |
| fast | 313通过、6跳过 | 3072 | 52跳过 |
| unit | 772通过 | 12477 | 4跳过 |
| contract | 117通过 | 977 | 19 todo |
| system | 87通过 | 1519 | 42跳过 |

`npm run test:full` EXIT 0：共1289个通过文件（6个跳过），18045项通过，98项跳过、
19项既有todo，无失败。新增配置边界文件及进一步加严的跨进程 Script/拒绝断言另行
定向复验通过；最后的测试类型检查同样EXIT 0。日志保留在本机
`%TEMP%/kodax-sdk-contract-full.log`、`%TEMP%/kodax-sdk-contract-bundle.log`，
helper覆盖摘要为 `%TEMP%/kodax-sdk-contract-coverage/coverage-summary.json`。

未发布 npm、升级 Space 或完成其他 OS/真实模型验收。

Standards 轴最终剩余0项；Spec 轴补正示例的稳定inputId与queued分支后，最终剩余0项。
首轮全层执行与源码/构建编辑交错，曾暴露旧断言、配置schema缺项及构建身份变化；
修正后以固定生产源码和构建产物重新执行，不将该首轮描述为全绿。

## 2026-10-28 任务报告去重复审补充

针对下节首轮提交 `d244ddfa` 的后续复审，先用公开 restoreSessionViewItems 复现
同文独立 event/info 丢失（2 项应保留，实际仅 1 项）。入口不再按正文全局删除；
旧展示须通过 inputId（含 inputIds 别名）关联同一任务消息、来源 Turn 无已知冲突，
且正文等于完整封装或规范报告正文，才可认定为镜像。来源不足、同 Turn 但无消息
身份、消息身份不同、Turn 冲突的记录均保留；不将子任务 runId 当成 Host Run 身份。
不能确证的旧封装允许作为中性展示留下，不能为消除视觉重复而删除未知事实。

定向回归还先后 RED 捕获两条相邻路径：历史对齐把同文 event 合入任务报告并借用
其时间，以及确证身份的正文镜像仍重复。任务报告不再参与普通文本对齐；确证镜像
同时支持完整 wire 和规范报告正文，仍保留身份前提。未增加接口、配置或历史分页。

最终源码/测试类型检查、workspace/bundle 构建、14 个 SDK 声明入口和 Node-free
Product 类型消费者检查通过。相邻回归 25 文件 / 327 项（2 workers、retry=0）全部
通过；JSON 为 `%TEMP%/kodax-task-notice-regression-results.json`。其中定向 3 文件 /
60 项的 restore-history.ts 覆盖率为语句 94.69%、分支 83.64%、函数 98.07%、行
96.56%，不是全仓覆盖率。构建后 `node --test tests/bundled-task-results.test.mjs`
1/1 通过：真实独立 daemon、IPC 和两次启动中，同文独立通知及无身份展示均保留，
完整封装和正文镜像均去重，四份报告身份/状态/顺序及全文哈希保持一致。

后续独立双轴复审：Standards 0 项；Spec 最初发现正文镜像遗漏，补回归并修复后
最终 0 项。该结论仅覆盖本修复，不替代完整发布矩阵；未发布 npm 或更新 Space。

## 2026-10-28 Product 任务报告

本轮在 `0d723c6e` 后修复任务报告投影；属于 alpha.10 发布后的源码修改，不据此
声称新 npm 包或 Space 已交付。复用现有 `_taskResult/_taskResults`，新增共享的报告
读取投影，未改变 canonical 消息、执行状态机、权限策略或历史分页接口。

Product `ClientViewItem.taskResult` 提供 source、已知的 taskId/runId/title/artifactRefs、
completed/failed/cancelled/unknown 和 `reportFormat: 'markdown'`；正文由 item.text
及原有全文读取方法交付。各报告是中性 event，不将子任务失败转换成主 Run 的
Provider 错误。跨显示面 item ID 仍不可互换，任务字段保留逻辑身份。旧 Actor 的
mailbox 投递 id 不冒充 Turn ID；缺状态不从完成标签或 `failed:` 文本推测。

```text
npx vitest run packages/agent/src/session-lineage/task-results.test.ts src/session-view.task-results.test.ts src/sdk-client.task-results.test.ts packages/repl/src/session/public-api.test.ts --maxWorkers=2 --retry=0
```

最初的单项回归确实 RED：输出仍是 XML，缺少任务元数据。扩展测试另捕获历史
超大项读取返回封装、显示身份依赖时间，以及旧投递 ID 被错误当成任务 ID；这些
均修复后复验。多任务、相同正文的不同任务、两个 metadata 字段的重复引用、旧
UI 封装快照、显式失败/取消、未知旧状态和普通用户 XML 文本均独立覆盖。

独立需求复审再捕获并补回归：混合新旧通知时旧报告丢失、旧 interrupted 终态未
映射取消，以及通知仍按 XML 锚定造成次序变化。另用真实队列测试确认模型侧的
预算封装可能重排，显示仍以结构化 metadata 顺序为准；缩写后的无封装文本不
额外制造未知任务。配对也拒绝明确的 source/runId/taskId 冲突，避免吞掉另一份
同名任务报告；缺失字段仅在无已知冲突时兼容。以上已分别 RED → GREEN。

真实 Product Client/IPC 用例通过受信任 MessageQueue 注入确定性的任务结果，使用
实际 AMA Run、规范历史、Host socket、公开 Client、重连与 Host 重启；Provider
仅由离线固定响应替代，不是付费模型评测或真实子任务业务质量验收。单条和三条
报告顺序一致、view ID 恢复稳定，历史与实时元数据一致，主 Run 始终 completed
且无 failureDetail。报告包含 Markdown、代码、文字实体及大于 128 KiB 的 Unicode
正文，经 readItem/readHistoryEntry 的完整重组 SHA256 相等。旧历史也经过 IPC。

共享报告读取模块的最终定向 V8 覆盖：语句/行/函数 100%，分支 92.17%。原有 CLI
展示所有权保持，未因 Product 的新投影而额外展示子任务全文。没有来源的独立
UI-only 文本不能提供可靠任务事实；保持中性，不猜测旧任务成功。

最终源码及测试类型检查、workspace/bundle 构建、14 个 SDK 声明入口和 Node-free
Product 类型消费检查均通过。相邻回归 28 文件 / 333 项（2 workers、retry=0）
全部通过，无跳过或未处理错误；JSON 为 `%TEMP%/kodax-task-report-final-results.json`。
完整 bundle 门禁 51/51，包括构建后公开 SDK 与真实独立 daemon 的 IPC、旧历史、
四份报告及 Host 重启，两个读取面的全文哈希一致。该新用例已加入 test:bundle。
最终独立 Standards / Spec 复审均无剩余 finding；不以这些定向结果替代完整发布矩阵，
也不宣称 Space 已消费新字段或已发布 npm。

## 2026-10-27 本地 Skill 失败分类

基线 `6d101b59` 的真实独立 daemon 回归先 RED：Main 已通过自己的可信路径准备
`draft-response`，daemon 未注册该来源；Provider HTTP 请求数为 0，Run 却返回
`provider / transport / provider_error`。新增本地 Skill 错误事实后，Runtime 结果、
事件、状态、诊断、重启读取及 IPC 保留同一分类；产品 `/client` 的 await 适配器
漏传 failureDetail 亦经真实链路 RED 后修复。Skill 重载和 enforceAtRuntime 保留。

稳定码为 skill_not_found、skill_not_registered、skill_registry_unavailable、
skill_policy_restore_failed，分类为 local_execution，阶段为 skill_load / skill_policy。
安全提示仅含安全技能名和固定原因，不回传路径或原始 IO 报错，不带 Provider HTTP
事实。扫描失败与未找到分开：保留既有 DiscoveryResult.errors 的非 ENOENT 错误，
通过可选 discoveryIncomplete 留存不完整发现；已发现技能仍可用，来源修复后重新
发现可清除该事实。真实来源不是目录、策略文件在发现后损坏、Runtime 绑定包装层
的 wildcard/显式名单均有回归，相关新增断言先 RED 后 GREEN。

`tests/sdk-skill-failure.test.ts` 在 system tier 启动独立 Host（验证 PID 不同）：
未注册时请求数 0，可信注册后同一调用完成；重连及 Product Client 仍保留错误；
真实 HTTP 401、429 和连接中断继续分类为鉴权、限流和网络错误，Provider 错误体
故意包含 skill_not_found 字样，不能据此误判本地错误。测试仅使用本机 HTTP fixture，
无付费模型请求；Host、Windows Job 和 HTTP 服务均收尾。

第一轮 Provider 回归因沿用生产限流恢复等待达到 120 秒测试预算；保留失败记录，
fixture 改用既有 timeouts.llm.maxRetryDelaySec=0.01 后完整通过（21.55 秒测试时间）。
不修改生产重试默认值。成文规范与需求双轴复核的发现均已修复，最终各 0 项。
最终重建后的相邻门通过：16 文件、544/544 passed、0 skipped，两 worker、retry=0，
耗时 246.61 秒。其中 Runtime 文件完整执行 336 项，包含普通提问与权限边界；
独立 daemon 完整用例在该门内再次通过。构建包门 EXIT 0，46/46 passed、0 skipped。
源码/测试类型检查、package/bundle 构建、14 入口 DTS 与无 Node ambient types 的真实
Product Client 消费 fixture 均通过。核对 2783 个源码/配置与 3748 个构建文件的
SHA-256，与门开始前冻结快照完全一致。此次未重跑全仓门，不将下节历史完整门
结果算作本增量验证。本记录不代表 Space 接入或新版本发布。

```powershell
npx vitest run tests/sdk-skill-failure.test.ts --retry=0
npm run typecheck
npm run build:packages
npm run build:bundle
npm run build:dts
npm run test:bundle
```

## 2026-10-27 SDK 一致性与提交前验证

核对源码连接器、Host 启动透传、17 个公开 SDK 子路径、生成声明以及无 Node
ambient types 的真实 `/client` 消费者。消费 fixture 覆盖 initializing/phase、
ClientHostStartupPhase、`userInputTimeoutMs: 0`、退出 recovery.state/nextAction 和
独立的历史 cleanup.state。类型检查和 14 个 SDK 入口声明构建通过。
README/中文 README、SDK 迁移、Client/Space 接缝、HLD/DD、内置手册、发布准备和
设计子模块同步；alpha.10 明确为开发/发布准备，不将提交推送冒称标签或实际发布。

本轮完整门首轮 16955 passed / 1 failed / 90 skipped / 19 todo，无 worker 异常。
唯一失败为 SDK 问答回归在等第一条 pending 时触发 expect.poll 默认 1 秒预算
（`sdk-client.interactions.test.ts` 原第 363 行），尚未收到请求即断言失败。
该用例两次 IPC 等待与相邻用例对齐为 15 秒，总测试预算 45 秒；原因、Host-only
timeout、旧 ID 拒绝、新请求保留和正常 Run 完成断言均保留。不修改生产提问期限。
同时补齐内置手册清单漏写的 `/client`，该增量与问答文件复验 66/66。
Standards 最终复审 0 项；Spec 的一项设计文字歧义已澄清，最终 0 项。
首轮日志保留；最终冻结门结果见下。

原四 worker 复验为 16954 passed / 2 failed：问答文件已全部通过；退出回归在
Provider entered 的默认 1 秒等待失败，已仅对齐为 15 秒；终态缓存保留用例则
在 Windows 临时 Session 文件的 atomic rename 处抛出 EPERM，并非测试超时。
持久化生产代码及其重试/安全策略未改；该 1005 次 Run 的保留用例独立复验通过，
退出文件 4/4 通过。考虑本机 I/O 争用，最终完整门采用 `--maxWorkers=2 --retry=0`，
保持同一 1193 文件集合，不用跳过或自动重试掩盖上述失败；两轮记录均保留。

最终冻结完整门通过：1193 文件中 1189 passed / 4 skipped；测试为
16956 passed / 90 skipped / 19 todo，0 failed，JSON success=true。
配置为两 worker、`retry=0`，耗时 1465.95 秒；Runtime 文件完整执行 332 项，
包括 1005 次 Run 的缓存保留用例。没有为本轮新跳过用例，亦无真实模型请求。
此前四 worker 的 Windows EPERM 记录保留，不能据本机复验宣告跨平台验收完成。

最终构建包门 EXIT 0，46/46 passed、0 skipped，包含实际 SDK 初始化阶段和
Windows 退出/重启回归。真实无 Node ambient types 的 `/client` fixture 再次编译
通过，主仓库与设计子模块 diff check 通过。核验 2782 个源码/配置文件及 3745 个
构建文件的 SHA-256，与完整门开始前快照完全一致；验证后只补写本文验收记录。
源码/测试类型检查、package/bundle/DTS 构建与离线 eval 已通过，未付费调用模型。

## 2026-10-27 Host 内部初始化进度

`ClientStartupProgress` 新增 `{ stage: 'initializing', phase }`，复用现有 callback、
CLI 动画与 elapsed time。固定阶段为 modules、extensions、runtime、recovery、mcp、
sessions、a2a、listener，分别对应真实模块/扩展加载、Runtime 装配、旧子进程及任务
恢复、MCP 预热、会话资源恢复、Agent 连接和 Client 入口初始化。快速阶段可能合并；
不为展示增加停顿，不将这些观察当作百分比或 Ready。

新 Host 仅在有进度观察者时向既有 bootstrap.log 写少量固定阶段记录。父进程
复用原就绪轮询，每次最多读取尾部 4 KiB，并匹配本次启动 UUID 和 Host PID；
不新增 RPC、健康探测、定时器或运行时文件，不改 owner 状态。无 observer 时保留 undefined
穿过 SDK 包装层，不生成启动 ID，也不读写进度记录。重复阶段去重，坏记录忽略；
读取失败只诊断一次并停用该次日志观察，不影响原有就绪、超时、停止或清理。

TDD：新文案映射、启动轮询透传、实际 SDK 启动、受控慢 MCP 和旧构建包的
进度断言分别先 RED。慢 MCP 用例确认服务仍在 initialize 时显示 mcp，而不是
extensions，且不能提前报告 ready；明确 release 后才继续启动并完整关闭测试 Host。
无 observer 和读取失败、旧 ID/错误 PID/无效或半条记录、重复阶段、永不返回的
观察回调都有定向覆盖。Windows 目录零长读取未触发预期错误，故障注入改为
跨平台的非法路径；没有为该夹具修改生产读取行为。

源码初轮相邻门 187 passed / 3 failed：仅旧 owner-exit 通知数组不认识新增阶段。
保留原顺序、旧 PID 已退出、新 owner 就绪等断言，同时验证 initializing；最终
12 文件 190 passed / 1 平台限定 skipped。类型检查、包、bundle 与 14 入口 DTS
构建通过；Standards/Spec 独立复审各 0 项。

重建后构建包门 EXIT 0，46/46 通过、0 跳过；实际 packaged SDK 收到初始化阶段，
仍在认证/能力检查后才收到 ready；无观察者的非交互 CLI 不产生阶段记录。实际
Host 退出、重启和 Windows Job 相关构建包回归均通过。源慢 MCP 用例还验证解除
阻塞后启动 Promise 成功并最终报告 ready，不只验证中途显示。

```powershell
npx vitest run src/sdk-client.startup.test.ts src/runtime-daemon/process.test.ts src/sdk-runtime-daemon-upgrade.test.ts src/runtime-daemon/process.owner-exit.test.ts src/sdk-runtime.launcher.test.ts src/sdk-client.mcp-elicit.test.ts src/sdk-client.command-mcp-elicit.test.ts src/sdk-client.interactions.test.ts src/kodax_cli.sandbox-startup.test.ts src/cli-startup-progress.test.ts src/kodax_bootstrap.test.ts src/integration-hot-reload.test.ts --retry=0
npm run typecheck
npm run build:packages
npm run build:bundle
npm run build:dts
npm run test:bundle
```

以下完整门和前次补漏结果保留各自历史范围，不作为本次进度增量的完整门结果。
本次验证不发送真实模型请求，不停止用户默认 Host；未发布 npm 或改动 Space UI。

## 2026-10-27 MCP SDK 桥接首次 UI 异常补漏

此前只测了直接 MCP reverse 入口，漏掉 SDK 的 `raceElicitAbort`：异步 UI 回调
失败被改成字符串 `"cancel"`，确认框和 URL 授权将它当作未选中 Approve，
错误地回复 `decline`。本次仅让该 Promise 的拒绝分支保留原异常，由已有 MCP
外层统一转换为协议 `cancel`；不新增状态或结果类型，用户明确拒绝仍为 `decline`。

新增 `src/sdk-client.mcp-elicit.test.ts` 两项回归，经过真实 SDK Run、共享 stdio
MCP 服务与 UI 回调，修复前稳定复现 `elicit:decline:`，期望为 `elicit:cancel:`。
修复后确认框和 URL 均返回 `cancel`；同一 Session 的后续明确 Decline 仍为
`decline`，每个回调只执行一次，Run 正常完成，pending 请求清空。该文件 3/3；
相邻 9 文件共 156 项通过，等待期限/超时/迟到回调定向 9/9（其余 323 项按名称
过滤未运行），源码与测试类型检查通过。Standards/Spec 本轮增量复审各 0 项。

```powershell
npx vitest run src/sdk-client.mcp-elicit.test.ts src/sdk-client.command-mcp-elicit.test.ts src/sdk-client.interactions.test.ts src/sdk-runtime.interactions.test.ts src/runtime-daemon/client.test.ts src/one-shot-questions.test.ts src/one-shot-permissions.test.ts packages/coding/src/capabilities/providers/mcp-reverse.test.ts packages/coding/src/tools/ask-user-question.test.ts --retry=0
npx vitest run src/sdk-runtime.test.ts -t 'returns unanswered when a late|ignores a superseded prompt failure|keeps AskUser unbounded|settles ordinary questions' --retry=0
npm run typecheck
npm run build:bundle
npm run build:dts
npm run test:bundle
```

bundle 与 14 个 SDK 入口 DTS 已重建。下节 16949 项的完整门记录对应本次补漏
之前的冻结版本，不作为本增量的完整门结果。Space 仍需升级依赖并消费
`recovery.state`；本 SDK 修复不等于 Space Renderer 已完成接入验收。

重建后的 `npm run test:bundle` EXIT 0，46/46 通过（含实际 Windows 退出/重启
两项），无跳过。与上轮完整门冻结源码比较，仅 SDK Runtime 的上述拒绝分支和
本次真实桥接测试文件变化；未改动退出恢复、权限审批或等待期限实现。

## 2026-10-27 整体评审后的相邻回归修复

修复范围：未回答的 MCP 空表单/URL 返回 cancel；旧任务提示不代选 Resume/Restart、
保留旧检查点；首次 UI 回调错误作为工具错误交给模型，回答/超时/Stop 已结算后的
迟到错误不改写结果；客户端 Stop 只标记 expectedRunId，不对整个 Session 留下屏障；
生成恢复快照保留 maxConcurrentThreadsPerSession。权限审批和默认无限等待保持独立。
复审追加：部分交付的 Session Stop 固定边界也约束生成恢复。Host 复用已有持久
Stop 记录，仅阻止其中列出的 Run，以及属于该 Run 的 Actor/child 恢复；后续 Run
不受旧边界影响，Stop 修复/查询入口不增加限制，不新建客户端 Session 状态机。
同一 Stop 请求在重启后重试时，通过已有 runs.abort 路径核验 owner；只有已验证
死 owner 的有效检查点允许接管并停止，活跃或无法确认的 owner 继续拒绝。
`ensureKodaXClient({ userInputTimeoutMs })` 将已有启动策略透传给新 Host，0 表示
无限等待；已有 Host 的策略不变，不增加 config.json 设置。

新增真实 MCP、检查点文件、SDK 工具结果、重连与启动器类型用例先 RED 后修复。
classic 两项旧 cancel 断言同步为 skip；容量恢复测试保留一次工具/一次恢复请求
断言，等待明确 blocked 状态并在 finally 中 abort、唤醒和等待 pending，避免污染
下一用例。此前 16921 passed / 4 failed 的完整门记录保留在本地评审产物中，
不将本轮定向通过回写为此前全绿。

```powershell
npx vitest run packages/coding/src/capabilities/providers/mcp-reverse.test.ts packages/coding/src/checkpoint.test.ts src/runtime-generation-recovery.test.ts src/recovering-runtime-client.test.ts src/recovering-runtime-launcher.test.ts src/sdk-client.interactions.test.ts packages/repl/src/interactive/classic-plane-interactions.test.ts packages/coding/src/agent-runtime/run-substrate.capacity-accounting.test.ts
npx vitest run src/sdk-runtime.test.ts -t 'returns unanswered when a late|ignores a superseded prompt failure'
npm run typecheck
npm run build:packages
npm run build:bundle
npm run build:dts
npm test -- --retry=0
npm run test:bundle
```

AskUser eval 改用生产工具定义并新增无 required 标记的用例；新增 continuation-memory
版本化用例使用生产提示与真实 helper，默认不调用模型。两份 eval 的离线入口以
各自 `KODAX_*_PROBE=off` 运行；不将离线通过称为模型质量验收。本轮不自动跑付费
eval、tag、Release 或 npm 发布。最终门禁结果在完成后追加。

本轮完整门首轮为 16945 passed / 2 failed：失败仅在未改动的 MCP transport
夹具，详细原因均为 Node Fetch 的 `bad port`（随机端口落入 Fetch 禁用集合），
不是环境变量展开失败；单文件复验 25/25。新增确定性 bad-port 注入先 RED，再让
夹具启动前检测并仅对此错误重新绑定端口，其他网络故障照常失败；不修改生产
transport 或增加业务重试。原完整门日志保留，最终冻结门另行记录。

第二轮冻结门为 16911 passed、0 项断言失败，但存在一个 worker 意外退出，
进程退出码为 1；MCP reverse 文件的 38 项未被收集，不能记为全绿，即使 JSON
报告的 success 为 true。该文件独立复验 38/38；本机 Application/System 日志
未发现对应崩溃记录。保持源码和构建不变，再以原四 worker、retry=0 完整复验，
临时父进程诊断仅记录 worker 的退出码，不注入测试子进程或修改依赖。

最终冻结复验 EXIT 0：1189 文件通过、4 跳过；16949 项通过、90 跳过、19 todo，
0 失败、0 unhandled error，MCP reverse 38 项全部收集并通过。上一轮 worker 退出
未复现，原因仍未确定；保留失败日志，不将其描述为已修复的产品缺陷。源码/测试
类型检查、workspace 包、bundle 和 14 个 SDK 入口 DTS 构建均通过。冻结前后的
2781 个源码/配置文件、3745 个构建文件及 HEAD 哈希一致。

Standards/Spec 独立复审最终均为 0 项待处理问题。额外真实 Runtime 探针验证：
活 owner 拒绝旧 Stop 修复、Host 退出后旧 Run 不被自动恢复、原 Stop 请求可确认
关闭两项固定成员、替换 expectedRunId 被拒绝，后续新 Run 可恢复；旧 Run 的
Provider 调用为 0，后续新 Run 恰好调用 1 次。

最终 `npm run test:bundle` EXIT 0，46/46 通过、0 跳过，包括实际 Windows Host
退出、重复连接与重启恢复。构建包验收后的源码/构建哈希再核对一致。以上为
本机 SDK/Host 验证，不替代 Space Renderer 接入 `recovery` 后的人工验收，
也不声称完成跨平台覆盖率或付费模型质量验收。

## 2026-10-26 one-shot 普通问题结算回归

`a92a9577` 改为普通问题正常 unanswered 后，相邻 one-shot 的三项旧断言仍要求
`cancel` 字样；实跑为 3 failed / 1 passed。one-shot 也仍发送旧 cancel，导致模型
只看到 `skipped`，丢失非交互环境无法回答的原因。按既定“只有 Stop 中断 Run”
语义修复：发送 `{ kind: 'skip', reason: 'non_interactive' }`，由 Host 结算并将
`unanswered/non_interactive` 正常工具结果交给模型。用户主动跳过为 `skipped`，
Host 期限到达为 `timeout`；客户端不能将 skip 伪造为 timeout。

回归边界：真实 Host/IPC 的单选、多问、输入和 MCP form；pending view 先于接收
回执时也只处理本次 Run，其他 Run 的问题仍 pending，默认值不自动提交，Run
成功完成且非 interrupted。MCP 仍为协议 cancel；非交互权限仍明确拒绝且不执行
工具。另核验嵌入式回调、Runtime facade 原样保留原因，迟到回复不能作用于新问题。

```powershell
npx vitest run src/one-shot-questions.test.ts src/one-shot-permissions.test.ts src/one-shot-task.test.ts src/sdk-client.interactions.test.ts src/sdk-runtime.interactions.test.ts src/runtime-daemon/client.test.ts packages/coding/src/tools/ask-user-question.test.ts
npx vitest run src/sdk-runtime.test.ts -t 'settles ordinary questions|keeps AskUser unbounded|returns unanswered when a late'
npm run test:fast
npm run build:packages
npm run typecheck
```

新增 one-shot 明确原因/正常成功断言先 RED（4 项），修复后 4/4。首次相邻集
116 passed / 2 failed；两处新断言将 IPC 参数错误码写成了内部的 invalid_input，
按既有传输契约修正为 invalid_params，Client 交互与 Runtime facade 复验 72/72。
最终 fast 门 EXIT 0：242 文件通过、4 跳过；2404 项通过、44 跳过，0 失败。
嵌入式默认无限等待、三种未回答原因与迟到结算定向 7/7（其余 319 项因名称
过滤未运行）；workspace 包、bundle 和 14 个 SDK 入口 DTS 构建，以及源码/测试
类型检查通过。本轮不替代发布全门、覆盖率测量或 Space GUI 人工验收。

## 2026-10-26 客户端退出恢复收敛

契约见 [客户端退出与恢复](../SPACE_SDK_SEAMS.md#客户端退出与恢复)。背景样本为
Space `0.1.47-alpha.2` / SDK alpha.6，并在 SDK alpha.9 继续出现；本工作树为
`0.7.97-alpha.10`，不据此声称这些源码变更已经发布。

| 回归场景 | 必须观察到的结果 |
| --- | --- |
| 原 Host 已退出、客户端 Memory/执行仍 unknown | 精确进程/Job 与匹配成功 outcome 验证后 recovery.ready；原 cleanup、issues 和执行引用保留 |
| 多次重启 / 旧 outcome 超过普通 32 条窗口 | 不靠重试次数放行；仍能用保留的精确证据重核验，不改写原回执 |
| outcome 迟到 | 缺证据时 blocked；真实 outcome 到达后 ready |
| 客户端或 Host 清理确认迟到，同毫秒 updatedAt | 采用同一 owner 最新确认；Stop 回写不能覆盖 Host cleanup 确认 |
| 读取中 owner generation 改变 | blocked / inspect_failure，不把旧证明用到新进程 |
| 原进程或 Job supervisor 真实存活 | pending/blocked，不能启动替换 Host |
| 资源释放失败 / 缺精确身份 / outcome 内容属另一 Host | blocked，给出 retry_verification 或 inspect_failure |
| 替换 Host 上重提旧退出 | 原回执不变、新任务继续运行、旧请求不建立新 fence、不 cleanup/stop 新 Host |
| 已安全恢复的历史回执 | listPendingExits 不再阻塞；readExit / 离线查询仍保留完整历史 |

定向命令：

```powershell
npx vitest run src/sdk-client.exit.test.ts src/sdk-client.exit-recovery.test.ts src/runtime-daemon/client-lifecycle.test.ts src/runtime-daemon/state.test.ts src/runtime-daemon/shutdown-verifier.test.ts src/sdk-client.host-authorization.test.ts
npm run build:packages
npm run typecheck
npm run build:bundle
npm run build:dts
node --test tests/bundled-product-exit.test.mjs
```

新增用例先 RED 后修复。Windows 本机已通过真实 IPC 替换 Host 活动任务与重复连接
检查；bundle 用例真实启动/退出独立 Host，并核验 Windows Job/supervisor。该用例
在实际退出成功后注入旧客户端丢失的 unknown 确认，保留真实 owner/outcome，
连续两轮重新启动并重提旧退出，验证原 unknown 未被伪造成成功、新 Host 不受影响。
源级离线用例另覆盖真实存活 PID、失败/缺失证明、40 次 outcome 写入后的证据保留。
未在 Space Renderer 内手动验收；非 Windows 平台未在本机执行。

最终定向回归：12 个文件、212 项测试全部通过（含 Host、owner 状态、Windows
身份、orphan-exit、process cleanup、Client 授权与 SDK 自知识回归）。完整包构建、
类型检查、bundle 与 14 个入口的 DTS 构建通过；上面的两个 bundled-product-exit
用例最终构建后再次运行，2/2 通过。没有发布 npm 包或修改 Space 代码。

## 2026-10-15 启动与最近消息排序回归

测试边界：规范存储 Actor 投影、共享 Host 所有权与退出、SDK/Client 列表、裸 `-r` 发现及真实 ConPTY 首次可输入。所有性能样本禁止提交模型请求，使用专用 Home，不停止用户默认 Host。

```powershell
npx vitest run packages/repl/src/interactive/storage.actor-read.test.ts packages/repl/src/interactive/storage.owned-read.test.ts packages/repl/src/session/session-recency.test.ts packages/repl/src/cli-resume.test.ts packages/repl/src/session/resume-index.test.ts
npx vitest run packages/agent/src/runtime/managed-child-processes.scope.test.ts packages/agent/src/runtime/managed-child-processes.cache.test.ts packages/agent/src/runtime/managed-child-processes.run.test.ts packages/agent/src/runtime/process-tree.identity-batch.test.ts
npx vitest run src/sdk-runtime.host-owner.test.ts src/sdk-runtime.actors.test.ts src/sdk-client.session-recency.test.ts src/runtime-daemon/process.owner-exit.test.ts src/kodax_cli.interactive-exit.test.ts
npx vitest run src/sdk-runtime.preflight-projection.test.ts src/sdk-runtime.shell-home.test.ts src/sdk-runtime.mcp-home.test.ts packages/agent/src/capabilities/mcp/transport-home.test.ts
npm run typecheck
npm run build
```

必须保留：其他项目的活跃 Actor 仍阻止停机；长首行、未知 schema、损坏与并发替换不返回 false idle；本 Owner 写队列、取消和期限仍生效。历史恢复仅在取得存储所有权后执行并绑定 Host 配置目录；Client 退出不扫描历史，自己的活进程仍需回收，未知树证据仍保留。身份批次内复用，下一轮刷新，PID 复用不误杀。

忙时预检沿用已认领且验证过 admission 的现场 Actor，不因普通内容写队列或旧 flat 临时文件而失效；未认领 Actor 仍严格读取。真实目录成员变化、迁移锁/journal 不得变成空清单；旧 flat 的顶层 `archived/` 与项目内归档均不参与活跃枚举。全量回归首次检出的忙时读锁问题及复核检出的旧 flat 归档问题均有对应修正和失败后通过的用例。

排序场景：旧会话新增真实消息置顶；标题/设置/Actor 保存、合成消息和压缩不置顶；压缩复制与 Fork 保留来源时间。全量保存、prepared append、索引命中/删除重建、旧记录及 SDK 快慢路径一致；相同时间稳定排序；筛选先于 limit，`before` 仍过滤创建时间。新游标锚点删除或移动后可继续；实时分页中的新增活动通过首页刷新发现。

### 本次启动耗时对比

2026-10-15，Windows ConPTY + xterm，110×35，等待实际出现可输入提示后发送 `/exit`。优化前后使用独立安装副本、相同的 759 条历史子进程记录及恢复会话夹具；沙箱已就绪，无模型请求。每种场景各一次配对样本，包含相同的只记录阶段/OS 调用耗时的内存探针，不代表统计分位数或首次安装沙箱的耗时。

| 场景 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 无运行中 Host，输入命令到 TUI 可输入 | 27.493 s | 17.614 s |
| 已有同构建 Host，再次启动 | 8.344 s | 0.772 s |
| `-r`，选择会话到 TUI 可输入 | 8.181 s | 0.621 s |
| 同版本、同来源构建内容改变，正常切换 Host | 27.405 s | 11.699 s |

刷新样本只在私有安装的 `dist/provider-capabilities.json` 末尾追加合法空白以改变构建身份，覆盖重建后的切换路径；不声称在计时期间执行了编译。所有 CLI 样本正常退出，候选 Host 最后通过 `daemon stop --home <专用 Home> --json` 返回 `stopped: true`。基线最后的停机返回 `cleanup_unverified`，进程已退出，不能将其记为已验证清理成功。

阶段证据：再次启动原本约 6.77 s 的客户端全局清理已消除；候选只处理自己的精确登记，约 1–3 ms。冷启动仍保留 Host 的一次历史恢复（最终样本 9.87 s），构建身份首次读取两侧约 1.30–1.36 s。正常切换等待旧 Owner 退出由约 7.31 s 降至 0.89 s；此处仍验证真实退出及清理结果。沙箱就绪检查两侧均约 28–40 ms，配置准备约 1–4 ms，恢复会话的 Host 读取约 2–10 ms，未观察到这些阶段的新回归。大历史会话的预检读取边界另由 Actor 投影和超过 50 条会话的严格全量回归验证，不能用本夹具的预检耗时代替大库测量。

本机证据目录：`%TEMP%/kodax-startup-comparison-Gtwl6A`，包含 `run.mjs`、`probe.cjs`、`comparison-state.json`、`final-candidate.json`、`comparison-results.json`、各场景 `*-result.json`、阶段 `*.jsonl` 与原始 `*.ansi`。表中候选采用最终重建后的 `after-final-*` 样本；较早候选测得冷启动 15.263 s、再次启动 0.827 s、选中后 0.586 s、切换 10.831 s，保留为额外样本，不据此选取最低值。真实用户默认 Host 未停止或重启。

### 回归结果与证据边界

类型检查、完整构建、SDK 声明自包含检查通过。冻结 2,884 个源码、测试和构建文件后运行默认全量：1,178 个文件，16,618 passed、10 failed、89 skipped、19 todo，耗时 1,202.85 s；结束时所有冻结哈希一致。首轮失败逐项处理如下：

- Shell 恢复的 5 项旧调用参数断言现在明确检查 Host `configHome`，MCP 清理的 3 项旧 mock 改为保留真实作用域导出；相关两文件完整复验 12/12 通过，原清理结果与持久化顺序断言保留。
- 既有 Issue 368 索引使用非标准状态导致统计失败，索引规范为 `Resolved`，详情及版本仍明确源码已修复、SDK 待发布；tracker 4/4 通过。
- 1,005 轮 Run 存储用例遇到一次 Windows `EPERM` 原子重命名失败；生产重命名处理未变，原用例独立复验 56.384 s 通过。保留首轮失败证据，不将其写成已根治文件系统失败。

以上共 17 项定向复验通过，覆盖首轮全部 10 个失败；不是第二份“全量零失败”日志。构建产物验收 42/42 通过，测试适配后的类型检查通过。证据为同目录 `regression-frozen.{log,json}`、`frozen-check.json`、`test-adaptation.log`、`retention-check.log`、`bundle.log`、`typecheck.log` 和 `final-build.log`。

完整真实 ConPTY 验收通过 50/50（owned Ink 30、classic 20），覆盖启动、新建草稿、首次提交、设置、排队、停止、退出与持久会话恢复等；结果与屏幕证据为 `%TEMP%/kodax-repl-acceptance-k88a6C/results.json` 及同目录文件，入口输出为本轮证据目录的 `pty-final.log`。首次执行的旧驱动因错误期待未提交会话进入历史而失败，修正的是驱动对草稿契约的适配，生产行为未改。

打包 Electron 42.5.0 验收通过（`electron.log`）：实际 Windows 沙箱执行 20 次工具查询、4 个 Session 并发、环境隔离、连接/断开、Host 关闭与重新启动。新增 `session-recency.ts` 单独测得行/函数覆盖率 100%、语句 95.83%、分支 89.36%，4 项测试通过；证据为 `coverage.log` 和 `recency-coverage/coverage-summary.json`，不代表全仓覆盖率。最后核对 2,884 个冻结文件，只有两个 mock/断言测试文件及 PTY 驱动发生已复验的适配，生产源码和构建均未改变（`final-freeze-check.json`）；`git diff --check` 通过。

Standards：硬规范违反 0，仍需处理的坏味道 0。Spec：剩余需求/契约问题 0。两轴独立只读复核，未修改用户默认 Host。

### 性能成本与功能回归边界

目前证据未发现本次改动引入新的性能或功能退化；这不等于所有平台、磁盘条件和历史规模都已证明零回归。提交前核对以下成本与权威边界：

- 预检仍枚举全部 admitted、未归档会话，成本随会话数量及元数据大小增长；未认领 Actor 的元数据每批最多 48 个并发读取，不物化正文和 lineage。已经认领的 Actor 使用经过 admission 验证的现场控制器，避免持久化写锁使忙时预检失效。损坏、迁移中或无法证明稳定的记录仍拒绝控制读取，不能误报空闲。
- 全量保存原本需要处理完整 lineage，最近消息事实的持久字段、主文件元数据与写后缓存分别计算来源时间投影，使用临时映射，成本随各自处理的完整或精简 lineage 长度线性增长；prepared append 只处理本次新增 entries 和既有时间，不因该字段重新扫描全部历史。会话列表仍为元数据读取及排序，不为补旧时间遍历所有正文；旧索引按现有维护入口升级，裸 `-r` 不重建索引。
- 历史清理由取得独占所有权的共享 Host 执行一次，客户端连接与退出不重复扫描其他 Owner；精确登记、私有 Home、Job/supervisor、真实退出和持久化清理结果的验证保留。未知清理记录不会为了速度被当成已成功回收。
- Windows 身份批次只共享本次 OS 观察；仅自身不可变启动身份可缓存，外部 PID 下一批重新读取。工具执行增加的 Home 作用域不新增 OS 子进程或全局扫描，也不改变进程全局 Agent Home。
- `lastMessageAt` 是统一展示事实，设置、标题、Actor 保存和压缩不制造新活动。新增字段可缺省，旧数据有可靠消息时间才补充；`before` 继续按创建时间过滤，分页保持明确的实时边界语义。

本轮已覆盖 1,005 轮 Run 存储、真实双终端和打包 Electron；没有做全部非启动路径的吞吐量 A/B、大库生产预检延迟分位数或 macOS/Linux 实机对比。Windows 全量中的一次 `EPERM` 已独立复验通过但没有根因修复结论，保留原始证据。后续若出现新的性能或功能问题，应使用同一场景的源码/构建身份和阶段记录定位，不通过缩小预检覆盖、清除未知登记或放宽 Owner 验证规避。

## 2026-09-14 主线融合复核

复核保留唯一 Host/Client 权威，不以旧内部接口删除判断能力缺失。补充以下人工场景，均使用专用测试 HOME 和已有共享 Host：

1. 一个窗口等待问题，第二个客户端回答该问题。classic 窗口应撤掉旧输入；Host 下一问题可立即作答。关闭观察后输入旧答案不得发出 Host 答复。
2. 忙时排入 `说明 @"带空格的图片.png"`，重新挂接同一 Session 后按 ↑ 取回，修改正文再提交。图片引用应可见、仅一份，后续模型请求仍有该图片附件。
3. 在 Host 接受输入期间取消。界面应等待真实 Run 结果；不能把 Stop 接受或 cleanup unknown 显示为已完成取消。
4. one-shot 使用临时模型参数恢复已有 Session，在运行期间由另一客户端改变模型。one-shot 结束不能覆盖新选择；设置恢复冲突需明确报告。
5. ACP 进程与既有 Host 的 repo-intelligence 环境值不同。ACP 发起 prompt 后，Host Session 的模式/trace 开关应采用 ACP 调用配置。

上述公开接缝已有自动回归；真实终端操作通过与否应单独记录，不能以单测成绩代替。

### 2026-09-14 自动回归与边界

复核时当前分支 `0841fb51` 已包含主线 `7b5b1b9e`，无需再次合并。
本轮修复了输入接受期间取消未等待真实结算、classic 失效问题占用输入、
队列图片取回/重交丢失媒体类型（含无后缀图片和 Windows 大小写）、one-shot
恢复设置覆盖另一 Client、ACP repo-intelligence 参数未到达 Host，以及清除
Session Auto 审查覆盖后未回到 profile 的消费者缺口。
`sessions.getSettingsVersioned` / `updateSettingsVersioned` 复用 Host revision/CAS，
没有增加第二设置权威；另一 Client 修改后恢复冲突保留现状，未改写的临时旗标
可能继续保留，不承诺逐 Run 设置隔离。

代码冻结后的历史结果：完整构建与源码/测试类型检查通过；真实构建 PTY
Ink 21 + classic 14，共 35/35；13 文件定向回归 423/423；新增可执行行
150/159（94.34%，非全仓覆盖率）；完整 Vitest 1,086 文件通过、1 跳过，
15,799 用例通过、77 跳过、21 todo。初轮与修改并行、含旧模块缓存/RED 用例的
运行和主动停止的两轮不计为最终快照。Spec 发现的无后缀媒体类型与大小写 P2
经公开 queue 回归修复，最终 Standards/Spec 均无剩余发现。

该次没有真实模型或其他 OS 验收；ACP trace 开关传递不等于新增完整诊断事件面，
浏览器 transport 也未实现。A2A 离线期间 Run 已完成后读取结果、classic 同 ID
正文缩短等当时未独立复现的范围，不由本次成绩证明已解决。入口存在不证明
所有配置、授权 UI 或 Learning 消费者均完成迁移；后续状态以当前契约和问题记录为准。

## Historical integration evidence

以下为原融合记录的定稿事实与限制，迁移不代表重新执行测试或发布新版本。

### 2026-10-02 integration

主线 `cad8b658797976ce22a4bd70c60d2251d537e542` 合入统一 Client 分支
`a63feede5f4b2bac8a62ddfa687d9b515d8c2021`；最终生产源码/双轴复审候选为
`f1bb8eb87b7f367c56a799847b77224baab90a0e`。保留单一 Host、瞬态中断证据、
outputId + opaque callId 身份、离窗全文回源、deferred cleanup unknown 和 v10
缓存边界；未回接 REPL runner 或持久 Runtime event journal/replay。
主线 Issues 340–344 保持身份，worktree 同号项迁为 348–352，345–347 不变。

| 历史门禁 | 结果 |
| --- | --- |
| 最终构建与源码/测试类型检查 | 通过；14 个自包含 SDK 声明入口，纯 Client 不需 Node ambient types |
| 冻结源码后 Fast | 218 文件通过、1 跳过；2,202 项通过、32 跳过 |
| Unit 全量序列 | 740 文件；12,017 项通过、3 跳过 |
| Contract 全量序列 | 117 文件；960 项通过、21 todo |
| System 全量及 daemon 复验 | 全量 74 文件通过；daemon 最终 25/25，合计覆盖 75 文件、1,341 项通过、42 跳过 |
| 最终构建产物 / 真实 PTY | 九个 bundle 文件 39/39；Ink 30 + classic 20，共 50/50；大历史浏览通过 |
| 恢复模块专项覆盖 | statements 97.4%、branches 89.44%、functions 97.82%、lines 99.33%；仅新证据派生/渲染模块 |
| Standards / Spec | 同一最终源码候选均为 0 剩余发现 |

原全量 System 有三项 `launcherBuild` 失败：daemon 测试进程加载的旧源码与
复审修复后磁盘指纹不同。冻结源码、最终重建后整份 daemon 文件 25/25 复验，
不把原 `npm run test:full` 退出码写为成功。真实 IPC 覆盖 SA/AMA 流式中断、
detach、Host 重启与下一轮恢复，未重跑 Provider/工具；复用
`reused:tool:suffix` 的不同 output 在额外 160 条 canonical 消息、移除工具
checkpoint 后仍可各自补读全文。owner-kill fixture 先结清无关 Session 写入，
未用删除遗留锁或放宽超时规避失败。

该次未执行付费模型 eval，也未替代 Linux/macOS 或跨平台人工验收。未成功
checkpoint 的 token 不在恢复保证内；主线未解决问题保留原状态。设计子模块
当时固定点为 `22f1c3561d24b225f057edebb25f6325e362b8e8`，保留双亲融合历史。

### 2026-10-07 stable mainline integration

开发起点 `f9b0fb586aa9bc8af8ffa67160d2c9ec952779b9` 吸收正式主线
`c2c8fdc41f4e0b50fa1c2d0b24142586f155777c` 的 `v0.7.96` 发布记录，
共同祖先为 `cad8b658`。包基线同步 `0.7.96`；FEATURE_298 已实施状态及
单 Host/Client 契约保留，不复活旧 API。用户未选择文本工具 OS 沙箱迁移，
继续沿用 ADR-066；没有新增迁移实施票、重置既有 tag 或宣告 v0.7.97 发布。
设计子模块融合 `7be826fcab188720745e9a5c9374ec5c78997b56` 保留双方历史。

最终历史结果：typecheck、完整构建/纯 Client 编译通过；七文件受影响测试
69 项；冻结产物、修正只读夹具后的 Fast 为 218 文件通过、1 跳过，2,203 项
通过、32 跳过（414.86 秒）；九个 bundle 文件 39/39。包含夹具修正的固定
tree `b0c02b71d1e518d9a2a4ff3972cd2f0876f81037` Standards/Spec 均为 0 发现。

首轮 Fast 有两个构建指纹保护失败；停止重建后专项 3/3 通过。第二轮仍有一个
Session 只读 `data_changed` 失败，不能由窄循环通过抹去；原现场锁未捕获，
不能断言根因。夹具仅按公开契约在原整体期限内重试
`data_changed/resync_required` 的只读 Run/Session 查询，其他错误立即失败；
不删除锁、不重交输入、不修改生产锁/重试，并等待 Provider 正文包含 `tool-ran`
后才触发崩溃。保留 interrupted/unknown、工具一次、Provider 不重跑及完整观察
断言；随后另行完成上面的最终 Fast。日志为
`%TEMP%/kodax-stable-merge-{fast-corrected,bundle,focused}-2026-10-07.log`
及对应崩溃专项日志。该次是主线融合，正式发布及跨平台人工验收另行跟踪。

## Windows 终端验收

入口：`tests/repl-pty-acceptance.mjs`。

链路：node-pty 的 Windows ConPTY → 发布入口 `scripts/kodax-bin.cjs` → 构建后的 CLI → 独立 Host → 本地 HTTP SSE Provider。xterm 解析终端实际输出；测试通过键盘输入操作产品，通过公开 Client 接口核对 Host 事实，并核对 Provider 实际收到的正文。

准备并运行（仓库根目录，PowerShell）：

```powershell
npm run build
npm install --prefix "$env:TEMP/kodax-acceptance-tools" --no-audit --no-fund node-pty@1.1.0 @xterm/headless@5.5.0 @xterm/addon-unicode11@0.9.0
npm run test:repl-pty:built
```

可用 `npm run test:repl-pty:built -- ink` 或 `-- classic` 单独运行。Ink 路径明确使用当前 owned 渲染器；`KODAX_FORCE_INK=1` 选择的是旧 legacy 渲染器，不属于这一通过结论。若工具安装在其他位置，以 `KODAX_ACCEPTANCE_TOOLS` 指向包含 `package.json` 和 `node_modules` 的目录；这是验收驱动的位置，不是产品配置。

每次运行创建独立临时 Home、配置、项目和 Provider，只使用本地测试凭据。退出时停止本次创建的 Host；测试证据保留在启动输出的 `Artifacts:` 目录：

- `results.json`：每项结果及失败原因。
- `*-*.txt`：终端屏幕文本；`*-*.ansi`：原始终端输出。
- `*-requests.json`：本地 Provider 收到的请求，用来核对原文与历史。
- `*-host.json`：公开 Client 读取的视图、Run 和事件，区分正常停止与运行失败。

两种终端均验证新会话启动、流式输入/输出、设置往返、完整长输入、提问、停止后继续输入、新建隔离、退出和历史续接。Ink 额外验证忙时排队撤回编辑、搜索旧消息及冻结浏览。Ink 长输入使用 bracketed paste；classic 使用原有反斜杠续行。新建会话沿用各入口原有交互：Ink 确认后创建，classic 直接创建。具体通过项以当次 `results.json` 为准；失败不能以旧测试通过数豁免。

2026-10-15 驱动同步草稿契约：启动及 `/new` 从真实终端所显示的 Session ID 经公开 `read/observe` 确认目标，classic 使用 `/status` 获取完整 ID；未提交会话必须仍不在历史列表中。首次真实输入后才验证持久化与旧会话保留，不为迎合旧断言恢复空历史记录，也不增加虚假的预热输入。

2026-09-09 起，Ink 同一入口额外检查以下回归：

- 普通输入和完成回答各显示一次，完成后的连续采样不出现回答重影；状态栏显示夹具的 `60/65.5k`、`50→10 (60)` 和 `1/7`。
- AMA 模式下，一条 query 只显示一次、Provider 也只收到一份；临时 worker 提示不混入历史，上一轮回答保持在下一轮提问之前。
- 实际执行 `echo ACCEPT_TOOL_RESULT`，折叠工具项显示命令摘要，Host 记录成功状态及真实工具输出。
- 生成超过 8192 字符的回复时输入草稿，按 Ctrl+O → Ctrl+E 展开历史，冻结尾部仍在；q 返回后草稿保留。再次进入 transcript，按 `/` 搜索预览窗口之外的早期正文，Enter 跳转，q 返回后草稿仍在。

接口再扫描后，同一场景还在 Ctrl+O 后让 Host 追加独有标记，再选择当前项并按 `v` 展开、`G` 移到底部，断言冻结内容没有混入后来的标记。完整历史展开与单项展开必须同时遵守冻结边界；`c/i` 复用该读取实现，本驱动不读取或改写用户剪贴板来断言复制内容。

真实旧会话残留修复后，另加 240×64 长 AMA 输出（Tab 与中文长行），执行展开/收起、开头/末尾跳转及搜索/取消，逐行检查页脚没有混入正文，然后缩回 110×32。xterm 必须启用 Unicode 11，让 emoji 列宽与产品一致。此场景在旧代码下会出现正文标记错位，不以字符串存在替代页脚行检查。Tab 等控制字符只在显示 cell 转为空格；历史和全文复制保留原始字符。

这里 Ctrl+E 表示展开/折叠完整历史，`/` 表示打开 transcript 搜索。分页期间模型继续追加、旧会话来源歧义和取消读取另有契约/显示函数回归；不把这些单测计为额外真实终端用例。

普通聊天的流式翻页回归：构建后运行 `node tests/repl-pty-acceptance.mjs --streaming-scroll-only ink`。驱动在私有 Home 保存 90 轮规范问答，持续追加本地模型输出，同时用鼠标滚轮跨越最近显示窗口和多个历史页。必须能到达第一条 query，停手后阅读位置保持不动，中间页顶部不闪现会话 banner，Provider 只收到一次当前输入。此用例不调用真实模型，也不改写用户会话。

旧显示 checkpoint 的恢复/提交回归：构建后运行 `node tests/repl-pty-acceptance.mjs --checkpoint-resume-only ink`。私有会话包含一轮 55 次已保存工具交互及旧 checkpoint，恢复后回滚到原 query，再用 bracketed paste 提交相同文字。模型响应受控暂停期间，上一轮末尾必须仍可见，Host 视图保留 2–150 个唯一展示项，而非只剩新 query；Provider 仅收到一次新输入。脚本不读取或写入系统剪贴板。对应 SDK 用例还验证没有重新执行旧工具，历史原文和完整补读不依赖显示窗口的 query 边界。

SDK 另由 `src/sdk-client.observe-history.test.ts` 验证：末尾工具尚无结果时，首次准备与复用缓存都能读到原始 query；相同文本的不同 inputId 保持独立，复用 callId 的不同 assistantOutputId 保持独立，工具时间在 observe/readHistory 两个面保持一致。真正的版本变化仍须返回 `resync_required`（`src/sdk-client.history.test.ts`）。Ctrl+E 的 `collapse` 只证明细节已展开；完整读取失败时仍保留冻结窗口并报告失败，不代表早期记录已删除。

## 打包 Electron 与沙箱验收

入口：`scripts/test-electron-daemon-smoke.mjs`。配置已有 Electron 和 electron-builder 后执行：

```powershell
$env:KODAX_ELECTRON_DIST = '<electron 包>/dist'
$env:KODAX_ELECTRON_BUILDER_CLI = '<electron-builder 包>/out/cli/cli.js'
npm run test:electron-daemon:built
```

要求本机 Windows restricted-user sandbox 已就绪。验收不会隐式执行全局 sandbox setup 或修复 ACL；前置条件不足时明确失败。不要将真实用户目录传给 `KODAX_ELECTRON_SMOKE_HOME`，因为现有脚本把该参数视为可清理的验收专用目录。

测试实际打包并启动 Electron，检查 20 次工具查询、4 个 Session 并发、Windows 沙箱实际执行、环境隔离、连接/断开、关闭 Host 和重新启动。它运行 Electron 主进程但不创建 BrowserWindow，因此不覆盖视觉界面点击。

## 结果与边界

确定性 Provider 让输入与交互断言可重复，不代表真实商业模型的任务质量验收。本指南也不替代 macOS/Linux 实机、剪贴板/输入法、视觉 GUI 和主观终端手感检查。

多客户端设置反向同步已通过真实 Ink/classic 验收，包括清除覆盖与 Host 默认值变化。仍有一项已知缺口：强制 legacy 渲染器的搜索结果跳转可能无法显示屏幕外的历史消息。详见 [Known Issues](../KNOWN_ISSUES.md)。因此本指南的通过结果不代表整个 v0.7.97 无条件验收通过。

## 开发代码更新后验证旧会话

REPL 和 Host 是两个进程；界面的包版本不能证明后台进程已加载本次修复。启动器现在比较运行中 Host 与本次启动实际代码的构建身份：同版本、同入口、不同字节且旧 Host 空闲时，正常关闭旧进程、确认退出后启动新构建。`npm run dev`、`daemon start`、SDK ensure 和默认 ACP 共用这一规则；被动 connect 不更新进程。

没有构建身份的历史 Host 需要一次明确的正常迁移。在任务结束后退出旧 REPL，从本 worktree 停止、启动 Host，再恢复会话：

```powershell
npm run dev -- daemon stop
npm run dev -- daemon start
npm run dev -- -r 20260909_075806_ed59a28bf46b46
```

这些命令不使用 force。若 Host 报忙，先结束或由用户停止对应任务后重试，不强停。跨安装来源、较新版本或安装正在变化时，按具体诊断处理；不循环重启，不降级。已加载旧 SDK 的长寿命调用进程需要重开。

恢复验证要检查后一轮 query 位于前一轮最后输出和后一轮首段输出之间，而不只查找正文是否存在。历史中已保存的重复输入不自动清理；测试副本可以隔离重放，但不得重写用户原会话来让验收通过。

## 构建更新与统一产品接口自动验收

接口说明见 [CLIENT_CONTRACT.md](../CLIENT_CONTRACT.md)。执行完整 `npm run build` 后运行 `node tests/host-build-acceptance.mjs`。脚本在临时安装副本中使用真正的独立 Host 和公开 SDK，覆盖同版本字节更新、相同内容复用、被动连接、真实观察者阻止更新、空闲后重试、旧调用进程拒绝更新，以及 `daemon start` 一致性。

脚本通过删除/复制隔离 dist 和添加合法 JavaScript 注释模拟 clean/build 的文件替换效果，验证旧 PID 真实退出及 Session 保留；不声称在副本中再次运行了编译器。它不会修改用户安装、用户会话或调用商业模型。

ACP 的共享 Host、文本/工具、Session MCP、权限、取消、并发请求和提交竞态由 `src/acp_server.daemon.test.ts`、`src/acp_server.admission.test.ts` 与投影测试覆盖。发布声明通过真实 `/client` 消费者在 `types: []`、`skipLibCheck: false` 下检查，不能靠注入 Node 全局类型掩盖产品契约泄漏。

## Host 执行归属与统一业务入口回归

这组验收对应 [Host 执行边界](../ADR.md#host-execution-boundary) 和 [产品接口说明](../CLIENT_CONTRACT.md)。使用临时项目、独立 Host 与可计数离线 Provider；不重写用户的旧 Session，不把方法存在或类型通过当作实际执行通过。

| 验收入口 | 必须核对的行为 |
| --- | --- |
| `src/sdk-invocations.test.ts`、`src/sdk-runtime.skill-lifecycle.test.ts` | Skill 的输入保存和 Run 准入先于动态工具执行；忙时及保存失败零执行；准备中 stop/close 传播取消并等待退出；同 inputId 不重新执行；Plan 不执行动态命令。 |
| `src/sdk-client.domains.test.ts` | 两个 ProductClient 实际调用 compact、Memory、Learning、注册命令、review 和 agents lean；核对 Provider 请求、落盘正文、领域版本及客户端通知作用域。手动草稿可编辑且不执行 hook、不继承可信调用元数据；无输出命令不伪造 user 或模型轮次。 |
| `src/sdk-client.steer.test.ts` | steer 图片等附件进入实际模型消息和保存的输入；同 ID 换附件产生 conflict，沿用已有媒体能力校验。 |
| `src/session-view.tool-results.test.ts` | 结构化工具失败、成功正文含错误字样、取消和非文本结果在实时与恢复后保持一致，不靠新正文格式猜状态。 |
| `src/sdk-client.observe.test.ts`、`src/runtime-daemon/client.resubscribe.test.ts` | Host 读取失败和传输断连均可观察；先交付恢复后的完整 view 再通知 live；恢复观察不重新提交输入或工具调用。 |
| `src/sdk-client.history.test.ts`、`src/session-view.test.ts` | 当前设置预算与实际执行预算分开；父/worker 及不同 contextId 不混用；搜索命中通过同一全文 reader 打开，快照失效明确失败。 |
| `src/sdk-client.test.ts` | 缺少统一产品契约的旧 Host 在被动连接时明确拒绝；不借连接错误关闭或替换其进程。 |

上述文件可用 `node node_modules/vitest/vitest.mjs run <文件...> --maxWorkers=1` 定向执行。之后运行完整构建、类型检查、完整离线测试与前述 PTY 验收；每次报告应分别给出定向与完整测试结果，不能把不同快照的通过数相加冒充最终门禁。

终端还须核对：注册命令启动后只跟随已返回的 Run，不再次提交同一正文；`disableModelInvocation` 不阻止用户显式执行注册命令；`/review` 无改动时仅显示结果，有改动时使用同一 Host 的项目内容。SDK 的 `commands.readPrompt` 是明确的草稿读取，不据此增加 CLI 开关或改变旧命令行为。已有忙时命令限制、输入草稿、冻结 transcript 和返回编辑器行为均须保留。

Bash/sandbox 的回归继续使用 `src/sandbox-runtime.test.ts`、`packages/coding/src/tools/bash.test.ts` 和 `packages/coding/src/skill-invocation-policy.test.ts`。本轮接口迁移不能引入新的 shell 执行路径、沙箱失败后自动本机执行、批准后修改整个 Session 权限，或无法确认执行状态时自动重跑。原生平台前置条件导致的跳过必须单独报告。

## 长会话显示预算耗尽与工具分组

短回答、单条长文本及展开后的全文读取不能替代这个验收。必须让多个工具结果的有界预览合计超过 131,072 个 UTF-16 码元，并在普通 live 界面重绘后检查早期内容。

```bash
node tests/repl-pty-acceptance.mjs ink --source --long-history-only
```

该入口使用与 `npm run dev` 相同的 production-env、tsx 和源码 bootstrap，在独立临时 HOME/项目和离线 Provider 上启动。夹具先生成早期 query、Thinking、正式回答及两个 Bash 调用，再产生多批真实 read 结果填满预算。核对普通界面上的早期 query 整行、Thinking/回答正文、Bash 参数仍可见，相邻工具按批次显示；不要先用 Ctrl+O 展开全文来掩盖普通显示的空白。另检查原文 reader 仍可读取、总预览不超限。

`src/session-view.preview.test.ts` 覆盖正文、参数双字段和完整 150 项窗口；`client-plane.test.ts` 与 transcript 布局/滚动测试覆盖单项原身份、相邻合并、非首项搜索定位、展开和复制。分组只能改变展示，不能把多个 Host item 合成无法分别读取的新业务身份。

## 队列在下一次模型沟通时交付

```bash
node tests/repl-pty-acceptance.mjs ink --source --queue-boundary-only
```

该场景暂时切换为 AMA 并在结束后恢复原设置。离线 Provider 暂停第一次请求，真实终端输入普通 follow-up，确认 Host 和终端都显示排队；随后让第一次请求返回工具调用。在第二次模型请求尚未结束时，检查其中已且仅已包含一次 follow-up，原 Run 仍在运行，Host 队列和终端排队行已清除，普通界面还须显示 query 完整正文行。不能先让整个任务结束，再把新 Run 收到文字当作通过。完整 PTY 套件另以 SA 注册命令验证原 Run 内续答和双 Esc 停止。

SDK 对应 `src/sdk-client.queue-boundary.test.ts`，须覆盖 SA 与 AMA：消费前 withdraw 返回完整原文和附件，撤回项不进入模型；重新排队使用新 inputId；消费后的 read 指向执行 Run，withdraw 明确 conflict，canonical 输入不重复。Skill 位于队首时仍需走 Host 的可信准备，不让后续普通输入越过；stop/failed 保留尚未交付的队列。此验收不改变 Esc、↑、权限或 sandbox 的既有语义。

## 启动碰撞与终态后的稳定读取

`src/sdk-runtime.launcher.test.ts` 在真实 IPC 层固定制造四轮临时 launcher 同时连接旧 Host，再检查两个调用连接同一个新 owner、旧进程正常退出、原 Session 保留。`src/sdk-runtime-daemon-upgrade.test.ts` 检查同一个启动期限内退避、取消后释放连接、永久忙碌时不 shutdown，以及期限耗尽后不跳过退出确认。不得通过忽略名称为 launcher 的连接来通过测试。

`src/sdk-client.derive.test.ts` 在 Host 显示 checkpoint 内持有真实 Session 写锁，直接调用会话、lineage、设置、auto stats、fork/recover 接口。请求应等待自身 checkpoint；保存失败必须传递，外部写锁仍明确拒绝。不要在目标调用前额外 readHistory 来预热或同步，也不要增加固定 sleep。Run 终态与显示保存是不同边界，所有出口应在 Host 内复用已有等待机制。


## FEATURE_299 融合后的消费者验收

完整 PTY 增加 `host-diagnostics-and-manual-shell`：客户端不加载扩展，`/mcp` 和 `/extensions` 必须显示 Host 诊断；`!echo` 必须产生 Host 的 bash 工具结果、一次原 query、零模型请求。主线已要求 effectful extension 命令具有工具 Run，所以无输出命令改为核对真实 Run 完成、一次输入、零模型调用，不能继续断言不存在 Run。只读帮助仍不能执行 handler。

| 自动测试 | 真实验证范围 |
| --- | --- |
| `src/sdk-client.repl-activity.test.ts` | 真实 Host/IPC、ProductClient、CLI plane 与 Ink/classic 渲染入口；替换终端 streams 和执行器事件夹具，核对 Todo、child、AMA 工作条、workflow、完整摘要、附着忙 Run 排队与停止、两端 cost。该测试不是原生 PTY。 |
| `src/sdk-client.domains.test.ts` | 实际离线 Provider 与共享 Host；扩展 command scope、受检工具、两 Session 隔离、原输入身份、同 Run 模型接续、只读帮助及诊断命令。 |
| `src/sdk-client.interactions.test.ts` | 实际 IPC；显式工具身份、完整长计划、首答、拒绝/取消/Stop；不把直接赋予组件 props 当作协议验证。 |
| `src/one-shot-permissions.test.ts` | 无交互 CLI 及时拒绝自己 Run 的权限，处理 view 早于接收回复；其他 Run 不被误拒，不修改全局模式。 |
| `src/one-shot-questions.test.ts` | 真实 IPC 单选、多选、自由输入及共享 stdio MCP 表单及时取消；固定 view 先于接收回复，不代填默认值，其他 Session 仍待答，观察器正常关闭。 |
| `packages/coding/src/agent-runtime/input-identity.test.ts` | SA/AMA 首次 Provider 请求复用已接受 query，保持 tool call/result 顺序；不同 inputId 的同文输入仍是新输入。 |
| `packages/repl/src/ui/client-plane.stop-control.test.ts` | Stop 请求失败可按同身份重试；自然终态及迟到 ACK 不丢失确认，旧 Run 不确认新目标。 |
| `src/sdk-client.integration-diagnostics.test.ts` | 无本地 runtime 的扩展/MCP 命令；lazy 查询不唤醒；真实初始化暂停时，另一客户端 reload 必须等待目录读取结束。 |
| `src/sdk-client.command-mcp-elicit.test.ts` | command 受检工具与 SA 模型接续两条路径，真实共享 MCP 表单必须归属本 Session，另一 Session 无交互，双客户端可以正常批准。 |
| `tests/repl-legacy-search-acceptance.mjs` | 强制 legacy 渲染器的真实 Windows PTY：长历史搜索编辑区可见、Enter 目标在屏内、Ctrl+E、草稿恢复、退出。 |

扩展接续还须在 handler 暂停期间真实 reload，再检查当轮 Provider 使用旧贡献、下一个 Run 使用新贡献；SA 与 AMA 都要覆盖。MCP 初始化被 dispose 时应保留关闭原因，不能启动备用握手进程。对应 domains、MCP runtime 与 extension runtime 测试均保留，不以静态接线检查替代。

还需运行 FEATURE_299 回归指南的原生边界与真实 Shell 清理测试。`npm run build` 包含不安装 Node 类型的 ProductClient 使用者编译检查，防止诊断字段泄漏 Host 执行类型；不得添加 Node 类型依赖来掩盖失败。


## T38–T42 消费者归口补齐

```bash
npx vitest run src/sdk-client.catalog.test.ts src/sdk-client.repl-activity.test.ts src/sdk-client.capabilities.test.ts src/sdk-session-commands.test.ts src/sdk-goal-binding.test.ts
node tests/repl-pty-acceptance.mjs --consumer-only
```

consumer-only 在真实 Ink/classic 终端验证 Host probe/forget、模型与设置命令、fallback/log 控制、按项目列会话、加载目标会话不覆盖设置、rewind 后历史可见、Host tree，以及已有 Host 下明确 `-r <id>` 和 repo-intelligence 启动参数。启动只提交显式参数；未显式指定的 permission/thinking 等字段保持 Host 默认，不强行写成客户端默认。

`src/sdk-client.repl-activity.test.ts` 给客户端注入禁止 load/list/save 的 storage，实际 Host 仍使用 canonical 存储；从两个真实 REPL 入口验证 startup/load/status/tree label/select/rewind/fork/recover、目标设置保留，并验证 Ink 设置写入失败后仍可 load。恢复命令保留原有确认及 Continue 行为。`src/sdk-client.catalog.test.ts` 另验证保存前失败、保存后报错、实际 Session 应用失败分别如实呈现，以及真实 Workflow fallback 与 verifier/stall sidecar 日志开关。

裸 `-r` 继续从 bootstrap 公开入口验收：空目录、旧布局和缺索引时读取不创建目录、迁移文件或写索引；超过 1000 个候选仍能选旧会话；选中后已删除/归档应由 Host 拒绝，不能误建新会话。普通 Host 列表只在索引缺失或无效时维护，热索引路径不重复扫描 canonical 正文。保留旧 worktree 路径映射与 Esc 输入所有权测试。

人工补验：Host 与客户端 home/profile 分开时，Host 独有模型仍可选择；从工作区 A 加载 B 后，相对附件按 B 的实际路径解析；旧会话迟到更新不得覆盖新页。既有冻结浏览、展开、复制、外部编辑器和独立 REPL 入口继续按前文回归，不能用本节自动化替代跨平台及视觉验收。

长历史预算夹具显式在 Host 设置 full-access，仅授权夹具中的受控本地工具，避免默认权限批准阻塞显示验收；既有正文、工具参数、分组和预算断言不变。失败清理覆盖待批准/等待子 Agent/恢复中的 Run。

## T43–T47 体验承接回归

使用隔离 profile；优先从真实 Product Client → IPC Host 和生产 Ink/classic 入口观察行为。T43 的 `src/sdk-client.interactions.test.ts` 验证无配置新会话、无模式旧会话、清除 override 及显式 accept-edits/plan 的 AskUser 直接出现 question，同时原始 Session/config 仍未写入默认。底层 SDK 未声明权限仍须走原 permission broker。原生终端验收中的 question 场景显式清除 profile/Session 权限覆盖后再发起请求，不能用 full-access 绕过这个回归。

观察可用性须分别验证：首次失败、已成功后的短暂 interrupted、明确 closed；失败后原始长稿及附件引用可恢复，读设置与 Stop 继续可用；同会话重新订阅不吞或重复正文/问题，迟到的旧会话回调不污染新会话。提交结果未知不得自动重发输入。普通输入、显式工具、注册命令及 workflow 的新执行入口均须覆盖就绪检查。

会话信息仅依据 Host 元数据：classic /load 显示目标工作区、消息数及切换提示，/sessions 显示工作区标注；目标设置、实际执行 cwd 和 raw Session 文件不因显示而改变。

effort 必须区分拒绝事实与随后发送的参数；sentEffort 不表示模型强度已验证，不写回用户默认。SA/AMA 与双端消费者都需验证。流式活动按请求身份归属，覆盖 thinking 完整长度、同名交错工具、缺 ID、child 隔离、迟到事件和 replace/stop/reset。保留 80ms 合并、长历史预算、空闲 API 上下文真值和共享进程快照测试，不能用扩大预算或逐 delta RPC 换取通过。

本轮不新增 Memory 写入、不恢复退役 Scout、不改 classic 工具全文约定，不将名称/计数反馈冒充逐字 JSON 预览。人工跨平台与终端操作手感仍按前文验收。

新增定向自动化入口：

```bash
npx vitest run src/sdk-client.interactions.test.ts src/sdk-client.repl-observation.test.ts src/sdk-client.repl-activity.test.ts src/sdk-client.capabilities.test.ts src/sdk-client.streaming.test.ts src/session-view.streaming.test.ts src/session-view.reasoning.test.ts
```

`sdk-client.streaming` 使用本地 HTTP SSE 夹具、真实 Provider parser 和 IPC Host，分别暂停 thinking 与工具参数片段，证明两阶段确实可观察；不是对真实模型能力的验证。局部 streaming 用例还覆盖 A/B/A 同名工具分开累计、缺调用 ID 不计数、旧请求同 callId 的迟到工具启动、取消和 reset。classic 在连续流式活动期间按请求/阶段/调用去重提示，计数为首次看到的快照；活动消失后清空去重状态，重新进入可以再次提示。Ink 计数实时更新，冻结浏览不跟随更新。

夹具同步也属于验收可信度：等待实际 Provider 请求进入后才断开或排队，不把默认 1 秒轮询当作产品性能承诺；fallback 统计应区分当前 child 请求与沿用历史的后台摘要；自然完成后清理临时目录前，等待已有 Memory review drain，并取消、等待测试自身额外创建的 Run。HTTP PTY 夹具先做健康检查，仅 Fetch 明确拒绝端口时重选，其他错误继续失败。不要通过跳过断言、增加生产重试或扩大历史预算消除这些夹具故障。

MCP 冷启动/全局重载和私有会话资源隔离分别验收，保留真实工具调用；setup、测试体和 teardown 分别受现有 30 秒限制。不能把拆分后的组合墙钟时间描述为仍有单个 30 秒上限。setup 部分失败也要释放本次已创建的资源，Provider 回调只捕获本次 fixture，避免误清理或污染下一例。

本轮原生 Windows PTY：主矩阵 43/43、consumer 14/14、长历史 7/7，退出码均 0。完整测试的首轮失败、定位及最终复验另见 v0.7.97 设计块的本轮证据；不将定向测试或带重试运行描述成一次无重试全量通过。检查全量结果时同时读取退出码、失败列表和未处理错误；JSON 的测试成功字段不能单独证明运行器无错。

最终快照 `c94d73ab` 的完整默认测试集合使用 `--maxWorkers=1 --retry=0 --reporter=dot --reporter=json`：16140 测试通过、零测试失败，但仍有一次 Vitest `onTaskUpdate` 未处理超时，退出码为 1，**全量验收尚未通过**。类型检查、构建和 PTY 通过不能替代这个失败门禁。下一步先定位报告通道的具体任务与处理延迟，不以忽略错误、扩大时限或重复无定位的整套运行结案。

## T48–T52 UI 暴露面复核回归

```bash
npx vitest run src/session-view.children.test.ts src/session-view.sidecar.test.ts src/sdk-client.repl-activity.test.ts packages/repl/src/interactive/classic-plane-display.test.ts packages/repl/src/ui/client-plane.stop-control.test.ts packages/repl/src/ui/utils/restore-history.test.ts
npx vitest run src/sdk-client.observe.test.ts packages/repl/src/ui/InkREPL.managed-transcript.test.ts src/sdk-client.repl-observation.test.ts
node tests/repl-pty-acceptance.mjs --exposure-only
```

原生 `--exposure-only` 运行双端：开启 light/trace 后真正执行引擎，检查 routing 摘要同时进入 SessionView 和终端；关闭 trace 后下一次请求不产生新摘要。第二个 Product Client 在同一 Session 提交 held Run，终端显示后按 Ctrl+C，Host 必须确认 interrupted，且下一次键盘输入恰好执行一次。classic 的 Stop 日志不能使输入提示符消失；不能通过清理时取消 Run 让断言假通过。

受控引擎事件→真实 IPC Host→生产双 REPL 的用例验证 RepoIntel、Verifier 三种分类、classic 压缩开始提示与外部 Run Stop 接线；这不是实际模型/Verifier 发射链路的 E2E。局部视图测试覆盖两个 child/parent 交错的 progress/result/retry/recovery/rate-limit，去重按 child 与物理请求区分，child 临时进度不写入父历史，换 Run 不接受旧活动。Verifier 的 verdict 和 delivery 是两维：budget-exhausted 仍可能携带真实 verdict；新快照保留两维，旧 icon 只精确解码已知值，未知分类中性显示，不推断默认 revise。观察同一 item 仅分类变化时，Ink 与 classic 缓存必须更新，已恢复的首帧不重复打印，移出窗口后清理去重状态。

classic 复用 compacting 快照，同 Run 同阶段只提示一次、结束或换 Run 可再次提示，同会话重挂接保留 differ。不承诺两个快照间瞬间完成的阶段一定显示。跨会话 Stop、断线重连、已接受输入不重交、草稿与问题框隔离继续运行原有观察/控制回归。以上新增测试不能替代主矩阵、消费者矩阵、长历史预算、类型检查和完整套件。

2026-09-20 本轮定向 7 文件 72 项、类型检查与完整构建通过；原生主矩阵 47/47、consumer 14/14、长历史 7/7，退出码均 0。主矩阵在最终 classic 同 ID 分类缓存修补前执行，该修补由最终定向用例覆盖；最终构建后执行 consumer 与长历史矩阵。consumer 清理阶段仍有 node-pty AttachConsole 辅助进程警告，不隐去该环境噪声，也不将其描述为断言失败。完整默认套件的最终门禁结果另见设计块，不以这些定向通过替代。

追加隔离 profile 的 classic 双 Client 跨会话检查：S1 外部 held Run 启动，切至 S2 按 Ctrl+C 不停止 S1，重新 `/load S1` 后 Ctrl+C 确认 interrupted/confirmed，目标输入及 Provider 请求各一次。该探针同时复现独立残留：冷启动 Session 的首条消息仅来自外部 Client 时，`/new` 仍按本地空 `context.messages` 误报 already empty；先完成本端一轮后才可继续上述切换检查。不能把后续 Stop 隔离通过当作 `/new` 已通过；待补 Host 判空消费接线与双端回归。

完整套件首轮另发现 Verifier 实时条目与 Host 重启恢复的 icon 形状不一致；修复须保留原兼容字段，同时保留新增两维事实，不能放宽原完整相等断言。三种分类往返相等先 RED 3 项、修复后 GREEN；独立 Ink 保存也必须保留两维，未知旧分类再次保存仍不得猜成 revise。收尾定向 9 文件 124 项通过。运行 daemon smoke 前必须先完成构建；运行中重写源码或安装产物会按设计触发 earlier-build 保护。本轮首轮确有此验证安排错误，3 个 daemon 失败不能描述为产品超时，也不能据此移除保护。首轮完整结果为 16144 passed / 6 failed、零未处理错误，最终复验另记于设计块。

最终修正后的构建、源码及测试类型检查均 EXIT 0；在其完成后单独跑默认完整集合，沿用 Windows 4 worker、`--retry=0`，dot/JSON 与 Temp 报告耗时诊断：1112 文件通过、1 跳过；16150 项通过、0 失败、77 跳过、21 todo，EXIT 0，未处理错误 0。收尾两轴复审均无剩余 finding。测试清理未确认的警告仍单独记录，不能把通过的行为断言说成进程树已完整验证；一次未复现 RPC timeout 也不能证明历史运行器故障已根治。当前版本的门禁结果以本段及设计块最终记录为准，前文 c94d73ab 是上一轮历史结果。

最终完整套件后再跑原生 `--exposure-only`，双端 8/8、EXIT 0。限定检查本轮 11 个清理警告目录的 17 条 unresolved 记录，目标 PID 当前均不存在；未证明完整后代树已清理，保留原始记录，不删除目录或终止其他进程。

## T53–T56 输出所有权回归

```bash
npx vitest run src/sdk-client.output-ownership.test.ts src/session-view.output-ownership.test.ts src/session-view.output-notice.test.ts packages/coding/src/task-engine/_internal/managed-task/llm-adapter-output.test.ts
npx vitest run packages/repl/src/ui/client-plane.test.ts packages/repl/src/interactive/classic-plane-display.test.ts src/acp-client-view.test.ts packages/repl/src/ui/utils/message-utils.test.ts packages/repl/src/ui/utils/restore-history.test.ts
```

第一组使用真实 HTTP Provider、SA/AMA 执行器、Host、IPC Client、Session 存储和生产显示适配器；HTTP fixture 只替代模型，不替代运行时。观察流式阶段、正式提交和 Host 重启，要求同一输出身份持续、正文只出现一次、重启不调用模型。真实 `finish_reason=length` 验证 SA 下一消息与 AMA adapter 内续写的不同边界。Sidecar 的独立验证请求不得计作第二份主回答。

正文用例包含普通代码围栏、首尾空白、标记的每个可能切分、续写请求间分割标记及中断时尚未发出的普通尾巴。主回答与续写/拒答提示分别计数，不允许提示拼进正式正文。多 thinking/text 块必须保留全部内容且不凭空添加分隔符。

Host 验证 canonical 先保存、display checkpoint 后到、取消 partial 的保存恢复、窗口外已提交内容、压缩归档的 outputId 保留，以及不同身份的相同文字均存在。新身份数据不得成为旧文本匹配算法的候选。显示正文提交后不能由旧 draft 覆盖；`readItem` 与当前正文权威一致。

消费者检查整个帧序列：重复快照/重挂接不重印，同一项修订明确显示，不同项同文分别保留。长正文普通追加不全文重读；有界前缀修订与 draft→committed 交接校验完整内容。冻结展开在分页之间发生 revision/state 改变必须明确失败，尤其不能把重启后的 committed revision 0 当成旧 draft revision 0。已展开旧全文仍维持冻结浏览行为。

不修改用户的原始 Session，不承诺旧无来源身份记录可无损修复，也不把尚未 checkpoint 的每个 token 承诺为崩溃可恢复。最终构建、全量门禁和独立评审结果在本次执行完成后追加，前面 T48–T52 的历史结果不替代本轮验证。

原生 PTY 首轮曾在 AMA held reply 暴露普通标识符末尾 A 被暂存的问题；最终 marker 检查只在合法单词边界暂存词类前缀，并保留 fence/bracket 规则。真实 adapter 必须在 Provider 尚未结束时完整发出 `BEGIN_ACCEPT_HOLD_AMA`，且非法候选不能挡住后面的合法 marker。修复后主矩阵 47/47、EXIT 0；首轮失败不能删除。guardrail 修订提交后冻结的长项移出窗口仍须完整展开，committed revision 固定 0，旧 draft 的同 revision 不能跨阶段误读。

本轮全量首轮 EXIT 1（25 项失败、3 个未处理错误）；16 个失败文件串行复验为 240 通过、1 失败、2 个未处理错误。剩余 stale-stop 测试用明确 marker 释放代替固定 10 秒时序假设，保留原超时与身份断言；最终与 filter 定向 13 项通过。`onTaskUpdate` 运行器超时仍须采集诊断，不能忽略或凭重跑通过宣称已根治。完整日志为 `%TEMP%/kodax-output-full.log`、`kodax-output-failures-isolated.log`，本轮最终结果另行追加。

第二次完整集合为 16209 通过、4 失败、1 个未处理 RPC 超时，EXIT 1。Memory review 的共享用户 home 扫描通过阶段计时确认：给该请求设置独立 `context.configHome`，等待 review 启动从 14.707s 降到 150ms，保留原断言与超时，完整 fixture 文件 7/7 通过。两项真实 IPC 历史读取冲突继续查写入边界；A2A ready 等待虽单独复验通过，不能据此宣称根因已修。完整日志及 JSON：`%TEMP%/kodax-output-full-final.log`、`kodax-output-full-final-results.json`。

补充 `npx vitest run src/sdk-client.history.test.ts --maxWorkers=1 --retry=0`：真实 Host 的 terminal display checkpoint 持锁时，page／entry 读取应等待其结束；释放后新页返回完整正文、旧 entry 仍返回 `resync_required`。两个缓存入口复用现有预算内 flush，保持外部并发写入检查；两项先 RED 后 GREEN，完整文件 7/7。这证明已修复可确定复现的自身 checkpoint 竞态，不能反推没有 writer 标识的旧全量日志。增量双轴评审均 0 finding。

追加真实队列保存前 gate：观察端先读旧历史，保存放行后输入行与其 afterInputId 输出应在原 3 秒限内同时出现，不需要额外输入或查询刺激。`src/sdk-client.queue-boundary.test.ts` 10/10；第三轮完整集合仍有 8 项失败及 2 个未处理错误，EXIT 1，失败与 fixture/RPC 定位记录见设计块，不能覆盖历史失败。worktree 假进程边界隔离后 37/37，RPC 5/5 返回；hook 23/23、ACP/alias 8/8。完整门禁须读取最终退出码、失败与未处理错误计数。

最终源码构建与类型检查均 EXIT 0；其后原生 `--long-history-only` 与 `--queue-boundary-only` 分别 7/7、EXIT 0。独立完整运行默认 4 worker、retry 0：1117 文件通过、1 跳过；16217 项通过、0 失败、77 跳过、21 todo，EXIT 0，未处理错误 0，源码哈希无变化。日志/JSON：`%TEMP%/kodax-output-final-gate.log`、`kodax-output-final-gate-results.json`。两轴评审无剩余 finding；清理未确认警告仍保留，真实 GUI 人工验收与覆盖率未在本轮测量。此前主 PTY 47/47、consumer 14/14，不与本轮最后两项重复累计为独立用例总数。

## SDK 契约补缺回归（2026-10-07）

基于主分支 `aaaf3c51` 与现有 Product Client v1，补齐 Workflow 摘要事实、排队 Skill 识别及授权的 Session 归属；不新增 RPC、能力版本或配置项。

```bash
npx vitest run src/sdk-client.workflow.test.ts src/sdk-client.queue.test.ts src/sdk-client.queue-boundary.test.ts src/sdk-client.permissions.test.ts src/session-input-queue.test.ts --maxWorkers=1 --retry=0
npm run build
npm run typecheck
```

- Workflow：经真实双 Client/IPC 在暂停、恢复及终态比较列表与详情的 `displayName`、`updatedAt`；跨 RPC 在稳定时间窗比较。模拟旧 Host 缺少摘要字段时使用已有详情读取；详情缺失必须失败，不能合成时间。
- Skill：正文中间的已注册引用在 idle、after_turn、redirect 下应用同样的 model、参数及动态上下文；入队时 hook 未运行，消费时读取更新后的动态上下文。Skill 前后的未知 slash 文本不计入多 Skill 冲突，也不截断参数；路径、URL 和未知名称留在普通批次。两个已知引用须拒绝且不入队、不停止原 Run。既有队列边界夹具显式创建真实注册 Skill。
- 授权：两个 Session 创建同标签授权，新连接仅依公开的 `sessionId` 区分，按原有 ID/revision 撤销一个，另一个保留，陈旧 revision 仍被拒绝。

三处原始缺漏均先复现 RED。评审另发现未知 slash 截断参数，新增 `$ARGUMENTS` 断言先失败再修正。定向首轮 26/27；剩余断言混入后台 Memory review 请求，按已有夹具模式分流该请求后队列文件 8/8，其他四文件 19/19。较早一次并行类型检查期间队列保存观察超时，随后串行边界文件通过；不把复验描述为首轮全绿。构建与类型检查均 EXIT 0，双轴静态评审无剩余 finding。

本轮不运行付费模型 eval，也未测量覆盖率或重复原生 PTY/GUI 验收。完整默认集合的结果在运行结束后追加，历史门禁不替代本轮结果。

最终完整默认集合（默认 4 worker、retry 0）EXIT 0：1150 文件通过、1 跳过；16526 项通过、0 失败、77 跳过、21 todo；未处理错误 0。构建后测试期间未修改生产源码；日志与 JSON 为 `%TEMP%/kodax-sdk-contract-full.log` 和 `kodax-sdk-contract-full-results.json`。子进程清理未确认等既有警告保留，不等同于失败门禁；上述覆盖率和人工验收限制仍然适用。

## 2026-10-11 Result verification replacement

Regression scope: no completion-sidecar request, notification, scorecard or batch criterion pass; current image bytes reach the provider after repair; extension Stop and child/mailbox waiting survive; work-budget extension runs at ordinary execution boundaries. Host Goal tools on SA and AMA use atomic lineage mutation, preserve concurrent transcript/UI state, and propagate write failures/cancellation; parallel create claims are serialized. Legacy sidecar history still restores through Host, Ink and classic consumers. Stall detection and Auto permission review keep their own controls.

Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:bundle` with build completed and production files frozen before Host tests. New-module coverage uses session-binding and runner-stop-hook tests; assertions about model quality require a separate controlled eval. This change does not establish a measured quality improvement or validate every external renderer.

2026-10-12 validation: typecheck/build passed; bundle checks 41/41; Windows native suites and N-API smoke passed; actual Ink/classic PTY matrix 50/50. An actual npm tarball audit checked 74 bundles, confirmed the built-in visual-review skill, and found no retired verifier runtime. New session-binding/Stop modules: statements 96.15%, branches 100%, functions 90%, lines 94.59%.

The bundle check caught a 32K managed-compaction regression caused by expanded constant guidance (required 32,838 versus available 32,768). Shorter constant guidance with detailed steps in the skill restored the unchanged capacity test: RED → GREEN. Final full-suite verification after this repair passed 16,499 tests in 1,152 files, with 77 skips and 19 todo, zero failures and no unhandled errors. Source and build were frozen throughout; logs are `%TEMP%/kodax-result-review-final-frozen.log` and `kodax-result-review-final-frozen-results.json`. Final Standards and Spec reviews each reported zero remaining findings.

The final current-prompt pilot observed one evidence-seeking response: `read` the PNG, without issuing a visual verdict. The frozen conservative token budget stopped the other three cells; this is no quality comparison. Raw data and structured main-session review: `%TEMP%/kodax-eval-dumps/result-review/1791735672929-e5835a965439`. Existing cleanup warnings retained 17 records in 11 test directories; the recorded PIDs were absent when checked, which does not prove complete descendant-tree cleanup. Cross-platform manual verification remains outside this Windows run.

## 2026-10-12 Real visual E2E smoke

Used the built SDK's real Session → managed AMA Run → production tools → `kimi-code/k3-256k` transport, with actual model responses. Three grouped cases, no children; frozen limits: 60 physical requests including auxiliary requests and invalid pilots, 26 requests/24 rounds/70 tools/10 minutes per positive Run, 8M conservative token reservations. Runs were sequential, but native Learning/Stall requests initially overlapped the primary stream: a scheduling-protocol deviation, so these are functional observations, not a compliant provider-concurrency or quality benchmark. The final missing-tools phase gated all provider streams to one in flight. No baseline/candidate quality comparison. Each render embeds a fresh pixels-only random code; request image SHA256 and the model's reported code must both match. Completion, paths and renderer exits do not establish visual success.

| Scope | Actual evidence and result |
|---|---|
| PNG, PPTX, PDF, XLSX | Read all five original images; repaired covered titles/data and the missing-month total; rerendered and read five fresh images. Exported PPTX/XLSX were imported before rendering; PDF's two pages were decoded by Poppler. Total changed from 30 to 60. All ten wire hashes/codes matched. |
| HTML interaction | Chromium captured 360/1000px after an actual click. Agent repaired overlap, mobile overflow and +2 instead of +1; fresh screenshots and interaction records showed +1 and no overflow. All four hashes/codes matched. |
| GIF and WebM | Decoded all four GIF frames and WebM at 0.2/0.7/1.2/1.7s. With caption Y365, agent found the missing/cropped middle-stage caption, changed Y to 320, rerendered and reread eight fresh frames. All sixteen hashes/codes matched. Caption checks passed; faint WebM encoding residue remains, so overall video quality is not certified. |
| Missing evidence phase | The real `context.toolVisibilityPolicy` first exposed skill/grep: six physical requests contained zero images, with source/signature checks separated from unverified visual requirements. Final skill-only phase serialized primary and auxiliary streams: three physical requests, maximum one in flight, zero images, all seven files explicitly unverified. |

Two production gaps were fixed with RED → GREEN regressions: provider snapshot capability profiles were not forwarded to live instances (24 tests now pass); split SDK skill discovery searched nonexistent `dist/chunks/builtin` instead of packaged `dist/builtin` (new bundle test discovers and loads visual-review). The static repair Run preceded the discovery fix and explicitly reported the missing skill; subsequent HTML/media/negative Runs actually loaded it.

Retained diagnostics: the first output guard rejected an auxiliary call; that interrupted sample is invalid. The first negative setup did not remove actual image delivery, so it is invalid as a missing-image-input test. The first temporal Run read all current frames but overstated clipping in WebM at Y350; its raw and the unsupported finding remain recorded. Only changed inputs were replayed. Extra fixture renders with no model observation are not scored. These results do not establish perfect visual judgment, Office-native fidelity, cross-provider/platform coverage, complete video continuity or audio verification.

Raw requests/responses, immutable renders, experiment revisions, hash/code audits and structured main-session assessment: `%TEMP%/kodax-eval-dumps/result-review-e2e/13451d22bc464c13b7a0abbe3211f721`. Total: 59 physical requests; 30/30 inspected before/after codes match independently hashed native request images. No further model calls. Production files/build remained frozen during regression checks; final gate results follow.

Final gates: typecheck/build passed; complete default suite (Windows 4 workers, retry 0) passed 16,515 tests in 1,152 files, with 77 skips/19 todo, EXIT 0 and no unhandled errors. All 81 recorded source/build hashes matched at full-suite end. Review then isolated the new bundle test from user/project/plugin skills; only that test changed afterward. Bundle 42/42 and Windows native/N-API checks passed, EXIT 0; both review axes have zero remaining findings. Existing child-cleanup-unverified warnings (11 in the full log) remain retained; no complete descendant-tree cleanup claim. Logs: `%TEMP%/kodax-visual-e2e-{typecheck,full,bundle,native}.log`; full JSON: `%TEMP%/kodax-visual-e2e-full-results.json`.

## 2026-10-12 Native Office and autonomous non-Office PPT review

The earlier application probe missed installed 32-bit Office. Real PowerPoint/Excel 16.0 now opened the generated files read-only: two native slide PNGs plus an Excel-exported PDF decoded to PNG. KodaX found covered headings/data and total 30, repaired the layout/formula, rerendered through Office, and reread three new native images showing visible headings/data and total 60. All six before/after image hashes and pixels-only codes matched actual provider requests.

The second case supplied no screenshots or rendering command. A project-discovered optional `pptx-preview` skill and installed artifact-tool renderer were available; PowerPoint/Excel/LibreOffice/COM were excluded from this route. KodaX discovered the skill/package scripts, imported the actual final PPTX and read two slide images, repaired both covered titles, rebuilt the PPTX, and rendered/read two fresh images. All four hashes/codes matched. The npm script entry failed identically outside KodaX; the agent independently used the same renderer via direct Node execution and completed the task. No production shell change was made.

**Capability boundary:** PowerPoint is optional. Autonomous PPT review requires an available final-PPTX renderer/format skill and image-capable model; KodaX currently does not bundle a full PPTX renderer. An environment can provide a headless renderer such as [LibreOffice](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html), or a format-tool/MCP integration. Neither source inspection nor an approximate HTML reconstruction certifies the final PPTX. With no usable renderer/image delivery, the correct result remains unverified. The non-Office route was tested with Office excluded on this Windows host, not on a physically Office-uninstalled machine.

Two bounded cases, 22 physical requests including auxiliaries, max one provider stream in flight; 80 production source/build hashes unchanged from the prior gate. Raw, immutable native/non-Office renders, preflight failure, npm diagnostic and structured main-session assessment: `%TEMP%/kodax-eval-dumps/result-review-office/89632d90a0c1498791c4a345466c980c`. No runtime source or dependency change, so prior regression gates were not repeated. This closes the inspected static Office/PPT workflow; animations, other Office versions and the earlier video residue are not covered by this extension. Native model output also contains an unsupported incidental claim about invisible bottom images; the nonce badges are visibly present, and that claim remains in raw evidence.

## 2026-10-29 Unified Host SDK cutover (unreleased)

Baseline: `466b874d`, after `v0.7.97-alpha.11`. The accepted H01–H05 slices are in
[the feature design](../features/v0.7.97.md#2026-10-29-统一-host-sdk-收口未发布).
Public root and `/runtime` exports now provide shared Host connections; isolated
core tests use the non-published `tests/runtime-fixture.ts`. Tests of public
construction, launch/bootstrap, declaration compatibility and installed artifacts
continue to use the public entry. No version bump or publication is included.

The policy transition writes `mode: host` atomically under profile and canonical
Session-root coordination. Its current wire projection remains `daemon`, without
internal migration fields. Repeated startup is idempotent. Alive, unknown or corrupt
inline owners, ambiguous descriptors and storage fences block migration; a failed
publication preserves the old policy, while a failure after publication never
rolls back. Original requested profiles must also be fenced when startup reuses a
Host under another profile. New-owner `execPolicy`/`autoReview` bootstrap remains
supported, and attach cannot overwrite those policies.

Historical owner evidence pins exact Git objects and hashes all executed sources:
`v0.7.96` (`c2c8fdc41f4e0b50fa1c2d0b24142586f155777c`) and alpha.11
(`0f3930e95e0286fd360826cf14f6f5c0d63d0fa5`). These are actual historical readers and
rollback writers, not simulated versions. Their scope is the ownership protocol;
a separate real published-package test covers a running historical Host. The
installed candidate test uses an actual `npm pack` artifact and its declarations,
with declared external dependencies supplied from the local install. It checks
retired imports/calls, a distinct owner PID, bootstrap cleanup, detach semantics,
concurrent first launch, cross-profile reuse and refusal by old rollback writers
after exact Host exit. It does not prove compatibility with arbitrary old private
writers that never recorded a shared owner fence.

During implementation, RED tests exposed the old public embedded/default entry,
public inline helpers, and the in-process external-agent daemon. A later strict
management-schema test caught an internal `unified` field leaking into the wire;
the projection now contains only the existing policy DTO. Independent Spec review
then reproduced a missed requested-profile migration when profile B reused Host A;
the actual tarball test failed with `inline !== host` before the repair. The first
complete bundle run returned EXIT 1 (51/54): three Memory-review fixtures still
constructed embedded owners. Their recovery now starts a replacement shared Host,
retaining cancellation, pending state, request-count and unique-receipt assertions;
the targeted three tests then passed. These intermediate failures remain part of
the evidence and do not count as the final gate.

Validation on 2026-10-30 (Windows; final source build):

- `npm run build` and both source/test `npm run typecheck` checks: EXIT 0.
- `npm run test:host-cutover`: 3/3, EXIT 0, including both historical readers,
  two independent first-launch processes and requested-profile B → live Host A →
  exact shutdown → old B rollback rejection. Actual candidate npm tarball SHA256:
  `5a04d1461af3f560550321f847f6497473f2ba4d08defdb82d92332d2ab0a2c4`.
- `npm run test:bundle`: 54/54, EXIT 0. `bundled-artifacts`: 3/3, EXIT 0, using the
  installed Chrome. These include current-build crash/cleanup, review shutdown,
  restart/history/tool-original, task-report and work-mode regressions.
- All 28 `runtime-daemon` test files: 470 passed, one platform-specific skip.
  `state.ts` coverage: statements 86.01%, branches 80.77%, functions 97.33%,
  lines 89.59%. This is module coverage, not an unmeasured repository-wide claim.
- `npm run test:host-upgrade`: 1/1, EXIT 0 with `KODAX_ALPHA11_TARBALL` set to the
  actual published alpha.11 archive. The test checks the fixed SHA512 before
  extraction. Provision it explicitly with `npm pack @kodax-ai/kodax@0.7.97-alpha.11
  --ignore-scripts --pack-destination <temp>`; no implicit download or skip occurs.
  Linux npm-release and Windows CI jobs provision that exact package and run the
  gate. Non-bundled dependencies reuse the installed test environment.

The historical Host test launches unmodified alpha.11 code, completes a real local
shell append and holds the next fixture-provider response, then replaces code at
that same installation path. A fresh SDK refuses busy upgrade and preserves the
old PID/runtimeId. After the old Run completes, idle upgrade changes the Host and
build fingerprint while retaining origin, activeMessages, Session title, workMode
and completed Run status. Primary requests remain 2 → 2 and the marker contains
one append. A separate background Memory review is identified by its actual tool
contract, not counted as a replayed user Run. This is not a byte-for-byte comparison
of every persisted file, and it does not cover an old stopped Run or active
checkpoint/unknown-effect recovery across versions; current-build tests for those
contracts remain separate evidence.

Standards review also found a missing cancellation boundary in the new historical
test. Its request wait now has a 30-second deadline and test cancellation signal;
`finally` and `t.after` share idempotent cleanup that waits for Run termination.
Temporary fault variants exercised both request-deadline failure and actual
node:test cancellation: each closed the exact Host successfully and exited. The
tracked successful test retains its original 180-second total timeout. Both review
axes report zero remaining findings after the fixes and actual-package evidence.

Source/build logs are `%TEMP%/kodax-host-cutover-final-{build,typecheck}.log`;
package evidence is `kodax-host-cutover-final-package.log`. Full bundle and browser
logs are `kodax-cutover-bundle-final-20261030-000242.log` and
`kodax-cutover-artifacts-final-20261030-000438.log`. Historical process evidence is
`%TEMP%/kodax-historical-host-upgrade-r34Bip/evidence.json`; state coverage is in
`%TEMP%/kodax-state-coverage-5d05fabb8d1a4a7b9d1703dc3f77827d/`.

The initial full default run was interrupted after the reviewed production repair
and a Memory-review test failure; it is not a passing final gate. Its log is
`%TEMP%/kodax-host-cutover-full.log`. Final default-suite results follow separately.
Cross-platform jobs are wired but not executed locally, and no npm/GitHub release,
live-provider quality eval, or external consumer upgrade is claimed.

The Memory-review failure was reproduced at its original one-second polling
assertion, then traced with a temporary test-only probe: after releasing the
reviewer, durable background work remained pending until 635ms and requestStop
arrived at 715ms even in the passing low-load case. Reviewer return is not durable
settlement. The test now uses its existing bounded `awaitEvent` helper to await
actual requestStop, while retaining the no-stop-during-review, un-aborted signal
and exactly-once assertions. All probes were removed; the complete file passed
13/13. Production code and build were unchanged.

The next shared-checkout full run completed with 19 failures, 17,993 passes,
97 skips and 19 todo cases. Ten failures exposed old test seams: ACP fixture
ownership setup, the CLI's renamed internal constructor mock, the child-process
core constructor, the live legacy-owner refusal message and a missing mocked
owner-preparation dependency in pure upgrade orchestration. These fixtures were
repaired with their behavior assertions retained, and the affected files passed
individually. The other nine failures belonged to sandbox tests another task
added while this run was in progress. This was not a frozen passing candidate.
The original log/JSON are `%TEMP%/kodax-host-cutover-final-full.{log,json}`.

Final validation therefore uses an isolated checkout of `466b874d` with only this
Host-cutover patch. The other task's sandbox/A2A files and its two overlapping SDK
guide hunks are excluded and preserved in the original checkout. Fresh isolated
build/typecheck passed. A first isolated bundle run returned 52/54: npm packed
paths outside the package through test-environment dependency junctions, and an
existing Product-exit test observed `readExit: ready` followed by a fresh
`listPendingExits: daemon_active` assessment. Copying the bundled dependencies
locally fixed the package layout without product changes (Script release 2/2).

The Product-exit assertion also failed in an independent repeat. Both queries
use the same existing fresh process-identity verification; unknown identity
continues to block recovery. The exact OS cause was not established, and no PID
reuse claim is made. The test now retries for at most 20 seconds only when the
same old request/runtime/client/owner and unchanged cleanup facts report
`blocked / daemon_active / retry_verification`. Other evidence fails immediately.
The empty-list, replacement-Host usability, old-request idempotence and unchanged
durable-receipt assertions remain. Temporary probes were removed. Independent
review found no remaining issue in this change or the late fixture repairs.

The two failing Product-exit runs also exposed a test-cleanup defect: `finally`
disconnected and removed storage immediately after requesting shutdown, without
waiting for actual process exit. Their two exact test Host/supervisor trees were
identified by PID, creation time, command and temporary home, then cleaned up.
The fixture now waits for verified exit before removing its directory; if exit
cannot be verified, the failure stays visible and the directory is retained.
This changes test cleanup only, not production shutdown or recovery semantics.
A temporary fault-injection copy then threw immediately after replacement Host
creation. It exited 1 with the intentional error still visible, verified cleanup
first, and an independent process check confirmed both exact Host/supervisor PIDs
were gone and the temporary home was removed. The probe was deleted; its log is
`%TEMP%/kodax-exit-cleanup-injection-20261030-010103.log`.

The isolated full suite also exposed an existing snapshot-test wall-clock
assumption. An independent exact-case run returned the required `read_cancelled`
but took 113ms against the test's 100ms threshold. The production read-budget and
snapshot implementation was unchanged from the baseline. The test now blocks
actual `.entries` I/O with an explicit gate: the 20ms caller timeout and a signal
abort must reject with their exact codes before the gate is released. After
release, both Sessions must return their original content. A five-second test
observation guard fails and releases the gates in `finally` if cancellation
regresses. The exact case passed; independent review found no remaining finding.
The full-file confirmation is recorded with the final validation below.

The two historical live-provider eval scripts remain explicitly historical:
their in-process provider/budget instrumentation cannot control a separate Host.
They were not mechanically converted to daemon mode or run as paid live evals.

Isolated final-candidate evidence (2026-10-30, Windows):

- Full default suite, retries disabled and four workers: 1,283 files passed,
  six skipped, one failed; 17,996 cases passed, 97 skipped, 19 todo, one failed.
  Duration: 1,490.91 seconds. The sole failure was the snapshot test's 100ms
  wall-clock threshold (124ms in the full run; the separate cancellation repro
  was 113ms). No production failure was observed. This is the actual full-run
  result, not a claim that the original full invocation exited zero.
- The production source and built-runtime identities were verified unchanged
  across that run: source fingerprint
  `286206bea6fcdcb0b4d85782596ac6f5ca75d41f273c187ca88866a22f8d2d0e`,
  built fingerprint
  `23ddfeb0c44eab6e7a9a2568c3f469e1e2a5013477fe65319131e36ee8723943`.
- Isolated actual-package cutover: 3/3, EXIT 0; tarball SHA256
  `1e0d45e7b4d91a0d6e7567493d949cdf33f19d3d7eb7498652a4203206b61826`.
- Isolated published-alpha.11 in-place Host upgrade: 1/1, EXIT 0; evidence at
  `%TEMP%/kodax-historical-host-upgrade-scpdbH/evidence.json`.

The isolated full log/JSON are `%TEMP%/kodax-host-isolated-full.{log,json}`;
package and historical process logs are `kodax-host-isolated-package.log` and
`kodax-host-isolated-historical.log`. Test-only repairs do not change the runtime
fingerprints above. Their final file/bundle confirmation follows below.

Final confirmation after the test-only repairs:

- `src/sdk-runtime.test.ts`: the complete file passed 337/337 with retries
  disabled (216.98 seconds, EXIT 0), including the deterministic budget/cancel
  case. Log/JSON: `%TEMP%/kodax-host-isolated-runtime-final.{log,json}`. The other
  full-suite files were not rerun after this test-only correction; their
  production code and tests remained unchanged.
- Source and test `npm run typecheck`: EXIT 0 after all fixture edits; log
  `%TEMP%/kodax-host-isolated-typecheck-final.log`. The isolated full build had
  already passed before production was frozen (`kodax-host-isolated-build.log`).
  No repository lint script is defined.
- Complete `npm run test:bundle`: 54/54, EXIT 0, 83.26 seconds; log
  `%TEMP%/kodax-isolated-bundle-final-20261030-011458.log`.
- Chrome artifact acceptance: 3/3, EXIT 0, 21.74 seconds; log
  `%TEMP%/kodax-isolated-artifacts-final-20261030-011632.log`. A subsequent process
  inventory found no remaining test Hosts from these runs.
- Standards and Spec reviews have no remaining findings; the final fixture
  changes also received independent read-only review. The original checkout's
  unrelated changes were verified unchanged and excluded from this commit.

H01–H05 implementation and local verification are complete. This does not mark
the package published, cross-platform CI executed, external clients migrated,
or the explicitly unverified cross-version recovery scenarios accepted.

## 2026-10-31 final layered source acceptance

The final source baseline is `d36d8f0d`, following the unified Host cutover,
A2A/POSIX fixes, Windows Job gate, SDK composition/configuration work and review
repairs. Root recovery preserves original tool/metadata ceilings and persona/
verification across successive Host restarts. The Host view owner also drains
admitted view/item reads before disposal; a real-storage regression first proved
that omitted reads could recreate a deleted index.

The first frozen invocation failed two cases (18,076 passed). Its record remains
explicit in the [frozen gate](ISSUE_159_v0.7.69_REGRESSION_GUIDE.md#2026-10-31-frozen-gate-and-follow-up),
along with deterministic lifecycle and HTTP-fixture RED/GREEN evidence. No timeout
or permission assertion was relaxed. The historical timeout's precise trigger was
not retained; the independently proven summary/transport fixture mismatch was
corrected and future waits retain their last Run state and round.

After rebuilding and freezing again, complete source/test type checks and the
full default suite passed: 1,294 files and 18,085 tests, zero failures, 98 skipped
and 19 existing todo. Sources, tests and built artifacts retained the same
6,914-file content identity before/after, and cleanup warnings were zero.
The frozen gate records commands, fingerprint and retained artifact paths.
Earlier 54/55 bundle and 18,045/18,064 full-suite records above describe their
own historical candidates; they are not combined into this full-run result.

The same final build also passed bundle 55/55, historical owner cutover 3/3 and
real alpha.11 in-place Host upgrade 1/1. The 6,914-file fingerprint stayed unchanged
through all gates. Native Linux/macOS and Node 20 execution, live-model quality,
publication and deployed Space acceptance remain outside this Windows/Node 22 run.


## 2026-11-08 Space SDK repair acceptance (unreleased)

Implementation requirements from Space's beta.3 feedback and the approved repair
plan: restore legacy AGENTS-only loading while retaining tagged prompt sources
and typed skip diagnostics; separate complete turn targets from message positions;
validate derivation under the write lock; preserve Retry's turn-start meaning;
close reason unions and unify stale recovery; add bidirectional ordinary paging
and mutually exclusive position options; document revision domains; carry read
cancellation/deadlines to Host work, reuse validated bounded history state without
Provider requests; expose typed SDK/Host capability checks and launcher requirements.

Upgrade acceptance must cover a new Product SDK calling ensure against both an
older Host version and changed bytes at the same version/installation. Optional
history contracts must not become unconditional basic-startup gates. Passive
connect must leave the Host alive; busy/newer/unproven owners retain the original
safety fences. Reconnection must retain requirements and principal; mutations are
never silently replayed or retargeted.

Regression seams:

- `agents-loader.test.ts`: legacy editor list excludes both rules directories;
  tagged prompt ordering, byte-for-byte no-rule formatting, skip codes and cache
  behavior. Existing child/profile/prompt tests cover model-visible instructions.
- `sdk-client.history-turn.test.ts`: real daemon, hidden tool results, rejection
  of raw tool-use boundary, cross-Session target, Retry before the genuine input,
  stale source/head and confirmed Rewind, public read cancellation, no extra
  Provider call during resolution.
- `sdk-runtime.history-location.test.ts`: ordinary older/newer round trip,
  centered byte-bounded windows, stale/cross-Session references, unchanged-source
  projection reuse and invalidation after an external storage write.
- `sdk-runtime-daemon-upgrade.test.ts`, `sdk-client.test.ts`: real public SDK
  startup requirements, older/same-version-changed idle Host self-healing,
  optional-feature startup, passive/active/competing owner and deadline fences.
- `tests/fixtures/product-client-types/consumer.ts`: shipped declarations accept
  turn targets/read options and reject raw message turn boundaries and mixed
  cursor/around modes.

Source/full-suite, declaration/bundle and installed Host checks are separate
layers. No model-quality benchmark or deployed Space/Electron acceptance is
inferred from these offline regressions. Full bounded turn indexing for cold
very large histories is not promised by this patch.

### Local verification evidence, 2026-11-08

- TDD failures were observed before fixes for legacy editor rule contamination,
  unsafe message-boundary Fork, ordinary forward pagination, public read abort,
  missing diagnostic codes, exact legacy loader/wire shape, single-turn pairing
  cancellation, and carrying earlier unmatched calls into a later-turn fork.
- The final complete build and source/test typechecks passed. The CLI remains
  below the existing 5 MiB minus 49 KiB startup fence; no size budget was raised.
  Declaration bundling validates all 14 SDK entries and the Node-free Product
  Client consumer, including turn and cursor/around compile-time misuse cases.
- `node --test tests/bundled-history-contracts.test.mjs`: 1 passed against the
  fixed built SDK and real independent Host. Covered coding export provenance,
  new capability requirements, ordinary forward navigation, unsafe Fork refusal,
  complete tool results, Retry-before-turn and public read cancellation.
- `KODAX_BETA2_TARBALL=<integrity-pinned public beta.2 tarball> node --test
  tests/bundled-historical-host-upgrade.test.mjs`: 1 passed. Real older installed
  bytes retained busy work and Session data, then upgraded in place and reattached.
  The script verifies the public archive's fixed SHA-512 before installation.
- Initial broad testing overlapped a bundle rebuild and was stopped after
  workflow/input-recovery/binding-controls failures. That attempt is not accepted
  evidence; the final broad run uses frozen installed bytes. The isolated steer
  binding regression subsequently passed. Raw command logs remain in OS temporary
  storage; no generated artifacts or raw experiment output are committed.

- Focused V8 coverage: 98 tests passed across five files; instruction loaders,
  shared capability module and history-turn reader reported 94.33% lines,
  87.12% statements, 80.36% branches and 100% functions (aggregate). This is a
  targeted report, not a whole-repository coverage claim.
- Independent code-review axes completed: Standards reported no actionable
  violations; Spec's read-budget, pre-send capability-gate and public-export
  findings were corrected and rechecked with no remaining findings. The final
  pairing scanner yields within large single-message tool block arrays and
  checks the budget before returning ready; conversation-revision hashing is
  budgeted and reused for an unchanged proven source.
- Read-only comparison with the local Space startup assertions confirmed the
  existing required SDK capability values remain compatible. Space's deployed
  application build has not been changed or certified by this SDK patch.

- The first frozen fast-tier run exposed an overstrict check against a valid
  legacy user-message prefix (3,588 passed, 55 skipped, 1 failed). Untagged safe
  prefixes and missing-entry null results were restored while tagged targets
  remain turn-strict. The original regression was kept unchanged and passed.
- The next fast tier passed 369 files / 3,589 tests (55 conditional skips). Its
  unit tier exposed the incomplete-parent null contract (13,532 passed, five
  conditional skips, one failed). Source CAS remains first; existing complete
  parent-path validation now precedes the new content/turn check. Existing tests
  stayed unchanged. The affected storage and public SDK suites passed 34 tests.
- A forced persistent-cache miss additionally exercises ordinary snapshot
  older/newer round trips. A dedicated failing test caught the fallback cursor
  omission, then passed after correcting the conversation-only projection.
  Raw audit transcript projection keeps its original shape.
- Final fixed-byte package verification reran both built-history and actual
  beta.2 upgrade tests successfully (2/2), and source/test typechecks passed.
  The new bundled history regression is included in the existing test:bundle
  release gate. Final full-tier results are recorded below after completion.

### Final frozen-source full gate

`npm run test:full` completed successfully against the final fixed source and
built artifacts (Windows, Node 22.23.1), with no intervening runtime rebuild:

| Tier | Passed files | Passed tests | Conditional skipped tests |
| --- | ---: | ---: | ---: |
| fast | 369 | 3,589 | 55 |
| unit | 846 | 13,533 | 5 |
| contract | 120 | 1,037 | 0 |
| system | 101 | 1,609 | 29 |
| Total | 1,436 | 19,768 | 89 |

There were zero failures. Expected fault-injection/background warnings and CRLF
fixture warnings remain in the raw log; this is not a warning-free claim. Build,
source/test typechecks, 14-entry declaration packaging and the two final
built-package tests also passed. The full source gate includes prompt/child
execution contracts; no provider-backed intelligence benchmark or deployed
Space acceptance was run. The bounded warm-source reuse and unchanged prompt
formatting/provider-call assertions support the performance/behavior scope
claimed above, not a new model-quality score. No push, tag or npm publication
was performed for this unreleased patch.
