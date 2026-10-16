# 首轮工具契约精简

2026-10-16 实施结果。参考框架的机制比较见 [Codex 对标](codex-harness-parity.md)。探索过程、候选全文与原始评测证据不进入正式文档；研发笔记位于忽略的 `docs/research/`，raw 与累计账本保存在 OS 临时目录。

## 最终范围

- CLI/REPL 使用 AMA，移除 SA 帮助、补全和切换入口；旧显式 SA 命令返回退役说明。Runtime Product API 未指定时默认 AMA，SDK 显式 SA、在途 Run、queued continuation、child/helper 的直接执行器继续兼容。
- 保留已有 Worker 规划、恢复、派发、终止和验证责任。简单任务原有直接执行、免 Todo 指导继续生效，不新增任务分类器、AMA-lite 或固定多阶段流程。
- 仅精简 `ask_user_question`、`todo_create`、`todo_update` 的重复描述。参数结构和 handler 不变，稳定 id、增量更新、owner、veto、metadata/null、语言及自由文本/批问规则保留。
- 全部 native schema 和完整 `spawn_agent` 契约保留。五项完整 schema 延迟披露和派发说明缩短的试验已撤回；较大候选的降幅不能当作当前结果。
- 按真实 Actor 绑定统一 builtin 协作能力展示，保留 SDK 注入和独立 extension override。修复 bridge→bash 串行调度、重复 provider call id 的执行事实归属、AMA 工具上下文/MCP 交互以及根上下文用量事件。修正过时的权限模式教学。

未删除 `multi_edit` 或其他执行能力来追求工具数量目标；现有编辑批处理、文件锁、权限、取消、压缩和恢复底座保持。内部已退役空链路另经引用/导出审计清理，30 组 Worker 提示字节相同，不计作 token 收益。

## 完整请求测量

同一生产 SDK Runtime/Host/ClientPlane、相同 Windows 夹具，捕获实际 SDK fetch 的序列化 body；OpenAI 与 Anthropic 均保留 58 个 AMA 工具。工具、说明、管理消息、任务和包装全部计入。

| AMA 协议 | 基线 bytes / 估算 tokens | 最终 bytes / 估算 tokens |
|---|---:|---:|
| OpenAI | 91,963 / 23,067 | 88,518 / 22,204 |
| Anthropic | 90,384 / 22,672 | 86,939 / 21,809 |

每个完整请求减少 3,445 bytes、约 863 估算 tokens（约 3.8%）。这是统一 `countTokens` 的请求规模估算，不是 BPE、API usage、Codex 桌面上下文数值或端到端加速结论。零外部请求的可执行测量见 `tests/first-turn-wire-inventory.test.ts`。

参考规模：Codex CLI sol/astra 的完整 Responses 请求约 17,182–17,271，DSH Standard 8,776、PTC 11,145。能力、skills 和协议不同，不能换算为严格效率倍率；KodaX 当前仍比上述 Codex 场景多约 4.5–5k，未达到输入量持平。

## 验证与有限模型评估

执行遵循 `benchmark/EVAL_GUIDELINES.md`：先零网络契约与真实 handler E2E，再固定历史、真实 production 工具字节的盲化配对，由主会话先评审再揭盲；有界 Runtime smoke 只验证执行，不用于 A/B 质量裁决。

- 全量回归记录 16,687 通过、89 跳过；运行期间撤回派发描述候选导致 3 项旧快照断言失败，最终恢复版本的 registry 全文件 37 项重跑通过。最终全部改动相关测试 480 项通过。未将前述全量运行写成零失败。
- 类型检查与完整构建通过，最终构建产物定向回归 22 项通过；实际 CLI 帮助无模式选择，显式 SA 返回退役错误。真实 Runtime E2E 覆盖入口/在途引擎、native/bridge 调度、工具发现后桥接执行、取消/恢复及 MCP；脚本化响应的实际 read→批量 edit→Node test→final 编辑闭环通过。
- tool-search、tool-resolution 和证据 writer 三模块定向覆盖：64 项测试通过，行覆盖 96.63%、分支 94.48%；这是指定模块覆盖，不冒称全仓覆盖。
- v3 两模型四对固定历史样本出现混合效率差异；v4 保留 native schema 后，GLM 仍倾向基线的并行推进。因果未证实，但据此保守撤回 schema 延迟与派发说明缩短。
- 最终 v5 只改三项描述，GLM 广域审查一对盲审为持平：两臂均取得已有审查证据并派发只读 cache 审查，候选多一次 wait，未测得实际总等待成本。此前 Kimi/GLM 的较大候选样本不改标为最终候选结果。
- v5 首次 smoke 的 Windows 证据路径比较错误导致两次已付费响应未能落盘，工具尚未执行；标为 `eval-invalid`，保留全部费用和失败 Runtime 夹具，不能算模型成功或失败。writer 经实际函数离线回归及落盘探针修复后，v6 继承账本和原配对评审，仅使用剩余四次请求。
- `kimi-code/kimi-for-coding` 和 `zai-coding/glm-5.3` 各完成一次两响应的实际 AMA Runtime smoke：执行真实 Node 回环网页夹具测试，随后准确报告退出码 0、1 个测试通过；服务器各收到一次请求，无文件修改、重试或子 Agent。工具可见性限定为 bash，这不证明开放任务质量。

本轮累计 **18 次请求、269,986 tokens、$0.009479795 冻结费率参考成本**，未知 usage 和未结算预留均为 0；该金额不是 coding-plan 订阅账单。12 次配对探针请求、2 次持久化失败、4 次最终 smoke 全部计入，没有重置历史费用。冻结上限为 18 次、600k tokens、$1；每次输出 2,048、120 秒，每 provider 一并发，禁止自动 retry/fallback。

工程建议是保留当前窄改动。当前未观察到最终配对中的任务语义错误，两条受控实测执行闭环通过；不能据此声称广域智能非劣或整体更快。最终 live 编辑 smoke、最终候选 Kimi/计划恢复 A/B、Flash/DeepSeek 等路线未覆盖；本轮不为补齐矩阵继续烧 token。后续若有实际任务回退，先读取保留 raw 定位，再只复验受影响场景。
