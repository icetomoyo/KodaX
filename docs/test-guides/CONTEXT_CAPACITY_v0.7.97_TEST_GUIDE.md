# 小上下文大文档验收与真实模型 pilot 冻结

日期：2026-11-06。关联：[容量可靠性方案](../designs/context-capacity-reliability-plan-2026-11-06.md)、[Eval Guidelines](../../benchmark/EVAL_GUIDELINES.md)。

## 离线集成验收

入口：`tests/small-context-document-recovery.test.ts`。运行：

```powershell
node node_modules/vitest/vitest.mjs run tests/small-context-document-recovery.test.ts --reporter=dot
```

矩阵为 8 / 16 / 32 / 64 / 96 Ki-token 模拟窗口，每个窗口分别返回完整摘要和明确 `max_tokens` 截断摘要。临时文档包含 2,000 行具名例外与可继续页码，不读取用户文档。

测试经过真实 Runner、原生 `read`、最终 tool-result batch guardrail、文件持久化、managed compaction hook、实际 `compact` 和摘要请求构造。主生成使用真实 `buildRunnerLlmAdapter` 的受控 stream seam；该适配器负责每次成功响应后的请求估算与快照重建。摘要提供者也是离线受控实现，无网络和付费调用。

固定调用图：并行读取三个文档页 → 注入一次 Provider 上下文拒绝 → 历史恢复并提交 → 用真实 read 读取已保存页的续读提示 → 确认提示出现在下一次模型输入 → 根据提示读取原文下一页 → 完成。断言已完成工具不重复执行、保存内容与实际 read 返回逐字相同、精确用户约束仍可见、截断摘要从未成为检查点。

本测试证明受控运行链路的工程行为，不证明模型理解或自主选择读取范围的能力。固定 system/schema 特意较小；8K/16K 通过不代表生产任意完整工具菜单均能容纳。Provider 计数、摘要正文和下一步工具选择均受控，不能作为真实模型准确率或吞吐量报告。PDF/OCR 使用 Extensions 独立测试，不由本矩阵代替。

## 真实模型 pilot：拟定，未执行

状态：**未执行，不计为通过**。当前阶段不启动付费调用。以下是 `small-context-document-pilot-r1` 的预算与协议冻结；实际模型 ID、价格核验、精确 fixture 字节/hash 与生产提示快照在执行前补齐 manifest，任何变更均建立新 revision，不能边跑边扩样本。

Layer 1 无法回答：摘要是否保存跨章节例外、纠正后的事实优先级、出处和未读范围，以及模型是否正确利用分页提示。pilot 只回答这些语义问题；容量分类、持久化和请求次数等工程行为由离线测试先验收。

| 项目 | 冻结值 |
| --- | --- |
| 模型 | 用户实际使用的最多 2 个模型；选定具有 ≤100K 窗口且固定请求可容纳的配置，逐个执行 |
| fixture | 2 个：中英混合技术文档；含相互冲突条款与后续纠正的长文档 |
| arms / 重复 | 修复前、修复后各 1 次；相同文档字节、生产 tool descriptions 和主任务 |
| 每 cell 调用图 | G1 阅读页 A；S1 压缩；G2 注入页 B 与纠正；S2 压缩；G3 注入页 C 后回答；禁止自由工具循环 |
| maxCallsPerCell / maxRoundsPerCell | 5 次 Provider 请求，其中 3 次主生成、2 次摘要；共 5 个预定义步骤，超过普通 3 轮的原因是必须分别观察两次压缩前后的证据传递 |
| maxProviderCalls | 40：2 模型 × 2 fixture × 2 arms × 5；所有 transport retry / repair / fallback 也计入，无额外复核模型 |
| maxOutputTokensPerCall | 2,048，包括可计入该上限的 reasoning；由请求参数强制，不靠文字要求 |
| 输入上限 | 每次完整 envelope ≤12,000 估算 tokens，且仍须满足所选模型的输入 + 输出 + 安全边际；否则不发送 |
| maxTotalTokens | 600,000，输入/缓存输入/输出/reasoning 不重叠核算；每次调用前预留最坏预算，之后用 usage 对账 |
| maxExternalSpendUsd | US$5；执行前按所选模型当时价格核验最坏成本，超过即缩小新 revision 或停止，不能自动加预算 |
| timeoutMs / 并发 | 每次 90,000 ms；每 provider 同时 1 请求；超时保留为失败，不自动重试 |
| 工具执行 | 模型提出的调用只记录；由固定 harness 注入预定页面，不能扩大阅读/执行范围 |

先运行 1 个模型 × 1 个 fixture × 2 arms，共最多 10 请求验证实验是否可区分；这 10 次计入总上限。实验无效、预算不足、输出截断或前一阶段无可用摘要时，终止该 cell 并保留原因，不伪造中间结果、不追加补救调用。任何硬上限到达即停止。

fixture 在 A/B/C 三处预置精确可引用事实，并包含一个跨章节例外、一处后续纠正和一段明确未读的章节。分别观测引用是否可追溯、例外是否保存、纠正是否覆盖旧事实、未读部分是否被误称已读、已完成动作是否被要求重复。正则/JSON 只记录机械表现；主会话盲化读取配对原文、摘要和回答，逐项给出保留/遗漏/错误增强/证据不足及理由，不能用总命中率代替判断。

原始请求/响应、usage、超时和预算账本保存在 OS 临时目录下的独立 revision 目录，记录绝对路径与 hash，不提交 raw。报告必须区分 `eval-design`、`provider-noise`、工程故障、模型语义遗漏与 `inconclusive`，给出任务有效性、收益/回退、建议及下一步最小成本。历史源码比较或本次离线通过均不能填充真实模型结果栏。
