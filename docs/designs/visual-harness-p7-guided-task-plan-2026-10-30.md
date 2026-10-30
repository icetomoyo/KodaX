# P7 第二阶段与修正后B/D：执行冻结

2026-10-30，Asia/Shanghai。用户明确要求：第一阶段失败后继续验证最小行为指导，再运行修正后的B/D。该指令覆盖旧的语义停止条件；**指导效果不好、题目答错或无效工具提案都不自动阻止后续B/D。** 仅实际预算、provider/记账故障或不可用的执行环境停止生成。旧R5及第一阶段3次/51,010 token的失败原件、判断和停止账本保留。

## 同一累计预算

Kimi Code `KIMI_CODE_API_KEY`、`kimi-for-coding`、官方Chat Completions，thinking disabled；2048输出/60秒，同provider串行。累计上限仍为 **26次生成、550,000 input+output token、USD2追加钱包停止观测、64次metadata**，**包含前阶段已用3次、51,010 token、5次metadata**；旧cell按revision限定身份，累计计数和钱包起点完整继承。1CNY保守计作USD1，观测可延迟，实际账单及订阅分摊未知。无重试/fallback/repair/child/外部judge。

本轮最多新增23次：指导诊断3次；B/D各2arm、每arm最多5次，共20次。旧数据重评和本地SDK序列化mock不计外部生成。缺usage/HTTP失败/达到上限即时保留并停止，不伪装零成本。

## 最小指导候选

只在生产 `visual_inspect` 描述前增加：

> Before answering a visual question, identify the evidence needed to settle it. Inspect unclear details or historical views; use exact pixel measurements when a visual impression is insufficient. Check the result against your assumption and revise contradictions before concluding. Skip calls when existing evidence suffices.

schema、system、其余工具合同和处理器不改。不加全局系统段、强制看图步骤、视觉路由、第二个模型或新产品配置。保留明确足够时跳过调用。精确生产定义/源码补丁与请求冻结；候选采用方向在效果/成本结果之后判断。

## 第二阶段：主动选择、真实反馈、最终修正分别判定

Layer3的固定最多3响应：R1同原始A问题/完整图→模型选择证据；R2返回真实结果→允许一次补充取证或最终回答；R3返回补充真实结果→记录最终回答或未完成。每次至多2个只读提案，与冻结原始A任务文字一致，实际执行 `visual_history/visual_inspect/visual_read_pixels/read` 及同目标portable bridge；其余提案返回明确的冻结范围错误，不调用模型或变更工作区。普通参数错误由生产parser/handler返回，不用裁判代填坐标/答案。

初始请求复用R5候选C的实际生产请求（57个完整工具合同、原图、system），只替换当前生产 `visual_inspect` 描述；用独立校验拒绝schema或其它合同漂移。未注入旧错答、Host选区、像素读数或正确终点。对同一冻结原图通过真实owner固定bytes，恢复其公开观察ID到相同hash；这是受控只读来源绑定，不冒称新的Runtime长期历史测试。实际选区由模型决定。

每轮核心工具执行后，通过生产OpenAI provider的公开stream接口在封闭mock HTTP中生成SDK反馈消息，再把真实tool/image/text块追加到冻结前缀；mock只做本地序列化，**不调用第二个模型**。逐图hash/坐标/数值与后续物理请求一并保留。工具提案、执行成功、相关区域、像素解释、最终端点/依据一致性分别记录；不能以调用工具代替纠错成功。

未变更的工具版C基线复用R5实际A首答（Motor-E/P1、无工具），不重烧同一输入；新样本n=1，不作稳定成功率/严格因果提升外推。本题已用于调试，不称held-out。主会话先评答案及轨迹理由，再打开成本；语义已暴露时明确不称完整盲比。

## B/D：真实Runtime任务，先质量后全程账目

基线B0为`1826cc228f299995fe5b22e608c7fbd90c3dc9ee`；候选为已接受C生产代码加上述一段指导，精确补丁hash冻结。B0原生textTransaction已由该版本自己构建，不能再把组件缺失当能力回退。

- B使用已修正Queued筛选/可见行的三张原图，before/after与旧R5相同，仅latest一致性修正。固定历史导入→一次真实生产压缩→新问题→回取→回答→默认后台review；主响应3次，最多5次总生成。没有模型热身，不外推建立长历史的总成本。
- D保留相同三文件与五项原测试；四主响应容纳读取→修改→实际测试→读反馈并总结，另最多一次默认review，共5次。每响应最多4工具，允许正常三文件读取批次。Host复验冻结原测试，保留全部新增/删除/测试改动，区分模型提出测试与实际看到结果。
- 两边相同输入bytes、任务、初始Memory、权限、公共路径和预算，独立重置，预注册随机arm顺序。原始工具和portable bridge走各版本真实handler/SDK；没有新辅助判断模型。工具10秒、B6分钟/D5分钟；所有默认后台工作结算后才关闭观察器。
- 原完整离线B0/C四格已证明三read与四响应路径。指导只改描述，新增候选实际运行前仍核对post-contract字节；如果旧源码/依赖变化，先恢复预检，不花在线请求掩盖兼容问题。

本部分为2case的小规模Layer3.5任务smoke，比较实际答案/补丁与成本，不单独归因prompt或宣称总体智能提升。主会话先读随机重标答案、差异、冻结原测试和理由，保存语义判断，再揭盲/读取usage。图像数/尺寸、原始/缓存输入、输出、辅助调用、错误尝试、用户完成/全部结算时间分列。未完成对不算同质量成本。

## 验证与交付

沿已约定的生产合同、实际工具/SDK反馈、Runtime输入/结算接缝验证。新反馈连接按TDD保留冻结schema/原请求隔离、工具发生身份和真实图片/像素文本传输反例；文案不做同义反复式测试。定向测试、typecheck/build及双轴评审后保存结果/成本/支持矩阵和本地提交。保留全仓既有失败；不因一个case失败停止用户已授权的后续阶段，也不自动扩大样本或切模型。
