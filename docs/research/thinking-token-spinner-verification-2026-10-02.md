# Thinking spinner 的 token 估算与验收

2026-10-02；FEATURE_298 / v0.7.97；基线 `a1649430`。

用户要求 Thinking spinner 使用 tokens。截图中的 Z.AI 流式协议只在最后一块
提供 usage，不能用它实时显示独立 Thinking token 数，见
[官方流式文档](https://docs.z.ai/guides/capabilities/streaming)。当前 Provider
`onThinkingDelta` 只传文本，最终 usage 的统计保持原样。

Host 复用 agent `countTokens`，通过 `activity.streaming.estimatedTokenCount`
发布当前请求的可见 Thinking 文本估算量。计算沿用 80ms 视图合并，在显示截断
之前使用完整文本；不逐 chunk 向上取整、不累加 child 输出，替换请求重新计数。
估算器按 UTF-8 字节和 UTF-16 码元加权：普通 ASCII 约 4 字符/token、常见汉字
约 1 字符/token，并保留已有密集编码数据保护。它不是 BPE 精确计数或计费 usage。

Ink 显示 `Thinking (~… tokens)`；classic 仍只输出进入阶段时的估算快照。
纯 Client 不调用 tokenizer，不从 chars 换算 tokens。旧 Host 缺少可选估算字段时
只显示 Thinking；工具参数接收仍以 chars 显示。

公共 Session.observe 的多语言、emoji、child 隔离、replacement 和 stream-end
回归已执行 RED→GREEN；真实 Product Client IPC→Ink/classic 显示回归及 classic
渲染器回归也执行 RED→GREEN。

- 最终构建和源码/测试 typecheck：PASS，纯 Client 声明无需 Node ambient types。
- 完整 `test:fast` 中 217 文件/2,202 项通过；唯一失败为已有 streaming 测试的
  精确对象预期未包含新字段。补充固定预期 2 后该文件整体 2/2 通过；合计覆盖
  218 文件、2,203 项通过，原有 1 文件/32 项跳过。原全套命令的退出码为 1，
  此处记录全套与受影响文件复验的组合结果。
- classic display unit：25/25 通过；公共 SessionView 和实际 Product IPC 显示
  专项：28/28 通过。上述用例与完整快速测试有重叠，不累加为独立总数。
- 构建后真实 PTY 验收：50 场景通过（Ink 30、classic 20）。

## Standards

PASS。候选 `a9e00c421d2bd62192cff0853a2251e1e4bee3de` 的 8 文件逐 hunk
复审无成文规范违反或可行动 smell；估算复用既有能力并由 Host 发布，各端消费
可选约数，包边界保持。未增加配置、缓存层或异常吞噬路径。
最终候选 `4407b1546c25586223f02db158233c7a098ce179` 只补充上述既有断言，
增量复审 PASS；生产源码相同，固定期望没有调用实现函数自证。

Standards：finding 0；最高严重度：无。

## Spec

PASS。同一候选满足用户 tokens 要求及 FEATURE_298 的 Host 事实归口；按当前
请求完整 Thinking 文本估算，Ink/classic 显式显示 `~tokens`，不替换 Provider
usage。工具输入字符单位、请求身份、replacement 与 child 隔离保留。
最终候选 `4407b1546c25586223f02db158233c7a098ce179` 增量复审 PASS，
该断言补充符合用户要求，前次结论保持有效。

Spec：finding 0；最高严重度：无。
