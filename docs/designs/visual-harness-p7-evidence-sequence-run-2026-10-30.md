# P7 顺序验证执行记录

2026-10-30，Asia/Shanghai。**第一阶段尚未改善最终答案：重复原图、补充相关局部图都仍回答 Motor-E/P1；后续独立冻结的像素数值诊断能识别间隔，却仍保留矛盾终点。** 配对revision先按[冻结的停止条件](visual-harness-p7-evidence-sequence-2026-10-30.md)停止；另一个改变证据格式的窄诊断也已停止，累计3次、51,010 token。没有给生产增加行为指导，也没有花费B/D模型调用；本轮不声称P7完成。

## 实际测了什么

沿用R5工程候选C的真实首请求：相同原图、system、完整57工具合同和相同真实错误回答；只改变后续复核中Host提供的一张补充图。对照臂重复1600×1000原图；局部臂补充实际visual_inspect处理器从原图生成的TP6区域（120×100原像素，最近邻放大720×600）。两边使用同一复核文字，可维持或修订旧答，不在文字中指出断口/正确端点；tool_choice=none，只测一次证据利用，不把人工选区当自主能力。

两次均为Kimi Code `kimi-for-coding`，Chat Completions，thinking disabled，2048输出/60秒。官方模型映射与订阅规则重新核对并保存models响应：[模型说明](https://www.kimi.com/code/docs/kimi-code/models.html)、[权益说明](https://www.kimi.com/code/docs/kimi-code/membership.html)。本次执行指令作为新revision授权，冻结26生成/550K token/USD2追加支出停止预算，未复用R5的执行标记或改写旧失败。

脚本随机重标后，主会话先将两个答案的语义判断写入 `evidence.quality-review.blind.json`，之后才读取揭盲和usage。每arm仅1次，不估计稳定成功率；没有外部judge、retry、fallback、repair或child调用。

## 效果与可归因边界

| 条件 | 最终判断 | 对证据的使用 | 本样本结论 |
| --- | --- | --- | --- |
| 重复完整原图，E-A-X | 维持Motor-E/P1，upper连接/lower跨越 | 仍把TP6向上接到顶部横线 | 终点错，分类对不足以完成题目 |
| 相关局部图，E-A-Y | 同样维持Motor-E/P1 | 明确声称补充视图证明TP6竖线与顶部横线相交 | 终点错，且新增了与实际像素相反的证据主张 |

实际正确端点仍是Valve-C/P2。局部原件在x720、y172..179有八个白像素；最近邻放大后间隙清楚。实际HTTP请求已逐图解码核对：两边均保留同SHA原图，局部臂第二张为720×600 PNG、3377bytes、SHA256 `73751bbf57a5c6a345331ade89d8e9f736d999ad721de739d050312be4655ae8`，与离线检查视图一致。没有发现本次补图在发送前丢失或变成重复原图。API接受字节不等于已证明provider内部如何编码图片，更不等于模型理解了它。

两个请求都带入了原模型的错误回答，符合“纠正已有错误”这一诊断问题，但**没有隔离旧答案锚定与视觉理解能力**。本结果不能证明Kimi完全不会利用局部图、不能证明所有模型都无收益，也不能证明最小行为指导无效；同样不能把下一步简单设成“增加工具使用次数”。本轮没有执行新题/独立拓扑或fresh-answer比较；像素文本反馈另做下述单次诊断，不称盲化配对比较。

### 像素数值的独立窄诊断

配对停下后，确认实际crop交付正常，仍无法回答“数值证据是否能被利用”。因此在同一用户授权总预算内创建新的 `numeric-r2b` revision，**不重跑旧臂**：保留原错答/全图/crop，补充现有真实visual_read_pixels处理器对x720、y170..181的RGBA palette、采样轴和indices，不在文本给出正确端点或“应改答”的语义结论。只增加一次Layer2响应；它是不同输入的诊断，不作为盲化配对效果比较。

模型这次正确复述了上下深色线段与中间白色间隔，甚至称线段断开；随后又说沿竖线向上汇入顶部横线，最终仍答Motor-E/P1。记录为**局部数值识别成立、证据整合/最终纠错不成立**。旧答锚定仍只是可能原因；不能据此声称已定位所有失败机制，也不能把该局部识别改写为任务完成。

`numeric-r2` 的首次准备因继承账本包含同名旧cell、已达单响应上限而在HTTP前被守卫拒绝，0次新HTTP/生成。该失败保留；`numeric-r2b` 将继承cell按revision命名空间区分，同时完整继承总calls/tokens/metadata与钱包起点，不重置总预算。新响应也在读usage前保存语义判断。最终总计3次请求全部结算，当前所有revision的ledger均stopped，不再自动追加诊断。

当前建议为 `recommend-iterate`：保留原失败，先厘清该模型/表示在这类断口证据上的理解与改答问题。尚未得到支持把行为指导合入生产的证据。阶段二的最小文字只存在于计划，不是假定有效的新默认。

## 实际成本

| 条件 | API输入 | API输出 | 合计 | HTTP耗时 |
| --- | ---: | ---: | ---: | ---: |
| 重复完整原图 | 17,704 | 212 | 17,916 | 5.886秒 |
| 相关局部图 | 16,186 | 263 | 16,449 | 4.611秒 |
| 局部图加精确像素文本（独立revision） | 16,352 | 293 | 16,645 | 6.246秒 |

原配对 **2次、34,365 token**；数值诊断新增 **1次、16,645 token**。合计 **3次生成、51,010 token**（输入50,242、输出768）；metadata5次（models1、首次额度1、每次生成后额度3），HTTP总计8次。两次已返回的缓存输入15,360/16,136均已含输入内；对照未返回缓存字段，保留null而不是推断0。观察到追加钱包CNY0，订阅分摊/实际美元账单仍未知。

局部臂少1,467 token来自本次不同补充图与输出，双方都错，不能当作框架效率收益。本阶段没有Runtime后台review，也没有重新生成R5前缀；这些是上述三个诊断增量请求的实际usage，不是完整生产任务成本。精确请求hash和口径见[成本证据](visual-harness-p7-evidence-sequence-costs-2026-10-30.json)。

## 后续阶段与离线准备

| 阶段 | 当前状态 | 未证明的部分 |
| --- | --- | --- |
| 一：固定局部证据纠错 | 原图/crop配对均错；独立数值诊断识别间隔但仍错，均已停止 | 自主选择区域、新题泛化、锚定与视觉能力的分离 |
| 二：最小指导自主取证 | 未执行模型比较，未改生产描述 | 指导是否改变有效选区选择、反馈后最终是否更好 |
| 三：修正B/D并比较完整任务 | 继续独立做离线准备；本轮无在线B/D调用 | 完整任务质量、实际全程token增量与日常负担 |

B的Queued筛选/行内容修正已有像素回归。本次真实历史B0与C分别回放一次生产压缩、回取和回答：基线三次read同批合法，三张原图均进入后续serializer；候选history→inspect同样取得三图。这些是scripted provider接线证据，不能写成模型恢复能力通过。

D已补四主响应/四工具的冻结配置，默认仍保留旧三响应/两工具用于历史实验。新增回归从三文件read→真实edit→真实测试→读到测试结果后最终回答；新配置仍保留child/超量生成阻断及完整后台结算。历史基线首次离线edit失败，原因为该工作树缺少Windows原生textTransaction组件，随后使用该基线自己的 `npm run build:native` 构建，不给它补新产品能力。首次失败仍保留；只复验受影响D的第二离线revision中，B0/C均完成四主响应、真实edit与冻结原测试5/5，后台结算完成。这仍是脚本回放，不能以其代替在线行为。

## 原始证据与复现

本轮raw保存在 `C:/Users/ADMIN/AppData/Local/Temp/kodax-eval-dumps/visual-harness/evidence-sequence-r1-z5NNlu/`。阶段一 `driver.mjs`、`execution-freeze.json`、精确prepared/physical请求与响应、逐图交付核对、盲评/揭盲、额度和ledger齐全。`ledger.before-semantic-stop.json`保留原账，当前ledger明确stopped及语义门禁原因；停止不是预算耗尽。

数值诊断的输入/原因/继承预算在 `numeric-r2/plan.json`、零HTTP准备失败在同目录；更正命名空间后的单次生成、driver、请求/响应/hash、先质量后usage与最终总账在 `numeric-r2b/`。原配对的停止账本没有解除或覆盖。

B/D初始离线来源与失败在 `offline-task-freeze.json`、`T-*.offline.*`；D原生组件构建日志为 `baseline-native-build.log`，只复验受影响D的第二离线revision在 `offline-native-r2/`。所有原件/失败/raw保持OS Temp，Git仅记录必要结论和hash；历史R5原件未改。更进一步的模型诊断需要新experiment revision与精确冻结，不自动把余量用于补跑。

## Standards

最终独立复核：成文违反0、smell判断0；已核对三次原始请求hash、API账目、继承总预算、语义停止、OS Temp边界和离线失败保留。数值追补初审发现“两次/三次诊断请求”的记录笔误，已改正；未修改产品代码或常驻提示。

## Spec

最终独立复核：可行动发现0；确认真实前缀、工具字节、crop与usage相符，数值诊断的格式变化/非盲配对范围及累计3次/51,010 token记账准确，三个revision均停止，未把阶段二/三未执行写成通过；B离线回取、D原生构建后的四响应/5项原测试证据齐全，首次D错误保留。Standards 0项、最高无；Spec 0项、最高无。该结论不代表P7价值验收通过。

## 工程验证

TDD已保留请求构造的RED→GREEN、跨arm引用隔离失败→修复、单响应预算阻断、三文件read/四响应路径的失败→通过。最终定向**7文件61项通过**（含旧pilot26项，不与全仓重复相加），typecheck/build通过（CLI约5151kB、14个SDK类型入口）。覆盖范围仅evidence-probe/task-cell/fixtures/transport/workspace五模块：语句91.13%、分支80.76%、函数92.68%、行97.74%；新evidence-probe各项100%。B两arm原始接线与D两arm原生构建后接线均离线通过，0次新模型生成。仓库没有lint脚本。尚未执行的模型行为保持未验证。

本次默认全仓一次运行实际为 **18,128通过、1失败、98跳过、19todo，总18,246**；文件 **1,300通过、1失败、7跳过，总1,308**，退出1，耗时1,837.56秒。失败是 `src/sdk-client.exit.test.ts` 的 `cancels ordinary owned work while an uncooperative compaction stays unknown and recoverable`：line285等待普通Run进入Provider的 `runEntered` poll超时，尚未进入后续compaction断言。本轮未修改该生产路径/测试。原始JSON/log均保留在本轮raw的 `full-tests.*`。

只复验该失败项得到 **1通过、3跳过**（26.61秒），记录为 `isolated-failure.*`；原因未定位，不宣称修复或全仓全绿。R5原有两项以及更早ENOTEMPTY/Feature270/T30的未定位失败原因也未因本轮其它检查通过而关闭。全仓执行发生在所有本轮代码修改冻结后；其后只追补文档与既有数据分析，没有再次修改实现。
