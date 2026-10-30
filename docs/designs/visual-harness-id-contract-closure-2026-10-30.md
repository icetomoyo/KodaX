# 真实观察ID合同：小切片实施与验收

> 后续集成交付见[集成交付记录](visual-harness-id-contract-delivery-2026-10-30.md)。下文保留小切片完成时点；“未重跑全仓/未提交”等描述不代表后续交付状态。

2026-10-30。按用户确认的C1/C2收口范围实施：补清真实ID操作合同，验证公共read→history→inspect链路，更新支持矩阵、成本与双轴记录；不扩能力、不追加付费评估。基准HEAD `4c0cf681a13e2b686f8b2b6bb012dde7c54ec023`；本片仅修改四个源码/测试文件及必要记录，Claude的并行修改独立保留。**操作合同和离线公共链路已补齐；没有新增模型行为收益结论。**

## 改动

- Agent共享`observationId`字段说明：使用已接纳图片或`visual_history`实际返回的精确ID，文件名、路径和view label不是ID。
- Coding操作说明：尚未接纳的本地图片先通过当前Runtime的read取得ID。没有把Coding工具依赖放进独立Agent层。
- 沿用现有公共Runtime来源fixture，加入错误ID→read→history实际结果选ID→inspect→像素核验。测试还保留原路径被覆盖、恢复后原件损坏/缺失的检查。
- 增加已接纳后文件路径/编造简称仍被拒绝的守卫；补正常尺寸JPEG整图原件回取与JPEG像素派生拒绝，保留已有JPEG区域派生及超限拒绝。

没有增加接纳层、别名、参数、任务router、全局方法、视频API或图片淘汰。工具名、可见性、授权、原件/lineage/容量语义不变。原JPEG整图与严格PNG派生的边界不变。

## TDD与验证

测试边界沿用用户已确认的公共Runtime→真实provider序列化，以及Agent公共视觉工具。

1. 修改测试，串联read/history返回的真实ID及原件检查。夹具探索/调试日志与第一次误用过滤器导致全跳过的日志保留，不作为有效RED。
2. 有效RED：只执行coding/OpenAI/native格，运行到最终合同断言，实际请求里的`visual_inspect.observationId.description`缺失，断言失败。此前步骤已经执行；不能据此称原history链条不工作。
3. 最小GREEN：只补两层操作说明，同一格通过。再运行整个相关fixture与工具回归，**2文件、45项通过**。
4. `npm run typecheck`通过，包含src和tests检查。修改前/后两次离线首请求inventory各通过，分别捕获32格。

命令：

```text
node node_modules/vitest/vitest.mjs run src/sdk-runtime.visual-sources.test.ts -t "coding.*openai.*bridge=false" --reporter=dot
node node_modules/vitest/vitest.mjs run src/sdk-runtime.visual-sources.test.ts packages/agent/src/media/visual-tools.test.ts --reporter=dot
node node_modules/vitest/vitest.mjs run tests/first-turn-wire-inventory.test.ts --reporter=dot
npm run typecheck
```

公共fixture使用受控provider响应驱动工具选择，真实执行Runtime/read/history/inspect并经过真实serializer。它证明操作链条和合同可见性，**不证明模型已学会不编造ID、主动选证、正确修订或省token**。不使用伪造usage作为实际成本。

未重跑全仓或重新构建发布包；本片无执行逻辑/API变化。旧全仓日志、临时文件失败、原视频错答、后台截断与旧未知usage均保留，没有改记成通过。

## 更新支持矩阵

| 路径/反例 | 本片实际证据 | 保持的范围限制 |
| --- | --- | --- |
| owned Runtime read→history→inspect | Coding/Agent/Script × OpenAI/Anthropic × native/checked bridge，共12格通过；ID来自实际history响应，真实wire含原件派生图 | 是受控离线执行，不是12个模型行为样本 |
| 原路径被覆盖后仍查接纳原件 | 同一公共fixture验证正确区域/多view顺序、像素及持久化；后续损坏/缺失明确提示 | 不扩大为所有SDK/Host的接纳保证 |
| 编造简称、文件路径冒充ID | Runtime错误ID返回拒绝，记录数量保持两条；Agent已接纳后也拒绝路径/简称，不读图、不预留输出 | 不增加自动修正或文件别名 |
| JPEG整图 | 小图保留JPEG原bytes并返回image block | 派生仍不支持JPEG |
| JPEG region/像素、超限原图 | 明确unsupported/display-limit拒绝 | 不静默转码、不改变严格PNG profile |
| 共享输出容量、恢复、取消及其他完整性边界 | 相关既有工具/Runtime守卫继续通过；没有改这些逻辑 | 未新增未覆盖宿主或跨进程行为承诺 |
| 模型自主取证/完整任务质量 | 本片未执行 | 沿用之前mixed结论，原PNG/特定工具不是质量门槛 |

## 成本证据

两次使用现有离线真实SDK请求inventory，对规范化请求做同口径差分。相关生产源码hash在两次捕获中一致，除了本片合同字段；未把原HEAD或旧B0的成本当成当前工作区成本。

绝对量口径补充：inventory原始计数保留了HTTP控制字段，不能直接称模型首轮token。本次问答已用既有`measureModelFields`重新只计system/instructions/messages/input/tools，见[当前首轮统一计数](visual-harness-first-turn-current-costs-2026-10-30.json)。本片前后被排除的控制字段相同，所以以下+120差量保持不变；排除控制字段本身不是产品优化收益。

| 捕获范围 | 格数 | 本片差量 |
| --- | ---: | --- |
| 不装配该Runtime视觉合同的隔离格 | 24 | 完整规范化模型输入hash不变 |
| Runtime Host格，两种协议及现有模式 | 8 | 每请求增加480 UTF-8字节、约120本地估算token |

逐字段比较只出现两处ID字段description、两处Coding操作description变化；规范化system/messages/controls、工具名和数量不变。原始请求的临时目录不同，故不把未规范化整HTTP hash当相等。

**+120是本地估算的固定请求合同增量，不是API usage、账单或完整任务增量。** 本片付费generation为0，新增真实评估token为0；没有产生新的行为或任务成本测量。旧视频B0的263,832、原V的525,756、V＋方法的325,979实际token属于本片之前，不能加120就称新任务实际用量。

完整32格差量、hash及并行文件审计见[成本记录](visual-harness-id-contract-costs-2026-10-30.json)。raw位于OS Temp `kodax-visual-id-closure-rxvmx_5r` 及两个独立首请求capture目录；不提交原始请求、账户信息或调试输出。

## 并行工作与双轴评审

本片只改 `packages/agent/src/media/visual-tools.ts`、相邻工具测试、`packages/coding/src/tools/visual.ts`、`src/sdk-runtime.visual-sources.test.ts`，没有编辑Worker/core prompt、task-engine或`src/sdk-runtime.ts`。

开始时记录了Claude的19个tracked dirty文件hash。结束审计时17个保持一致，两份文档在并行工作期间变化：`agent-under-10k-next-plan.md`与`FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md`；本片没有写这两份文件。相关生产源码和两次capture的源码hash一致，不声称Claude所有文件在期间被冻结。没有暂存或提交共享工作区。

### Standards

独立Standards Agent检查限定四文件diff，并补审支持矩阵、成本与实施更新：**0项发现**。Agent合同与Coding提示分层，无新配置/抽象；测试沿用公共Runtime和真实serializer。评审已核对有效RED、GREEN、45项回归、src/tests类型检查及两次inventory日志；TDD顺序不只由diff推断。

### Spec

独立Spec Agent按C1/C2检查四文件及三份记录：**0项发现**。真实history选ID、不可变字节、误ID不增记录与JPEG边界符合限定切片；24/8格的差量、估算口径及未付费边界与raw一致，未扩大接纳、别名或全局方法。

两轴均已完成源码与文档补审。工程补修通过不等于P7行为收益通过，已知模型错误仍保留。
