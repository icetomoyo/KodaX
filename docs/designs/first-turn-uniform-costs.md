# 首轮输入统一计数：字符、字节与 token 估算

2026-10-27。状态：**已有输入的离线重算；0 新增真实模型调用**。
本记录修正字符与 token 混用、基础模板与完整请求混用的问题，不评定项目智能强弱。

## 统一方法

所有完整请求行使用同一脚本 [first-turn-uniform-costs.ts](../../tests/first-turn-uniform-costs.ts)：

1. 解析保存的 JSON，只取非空 `system`、`instructions`、`messages`、`input`、`tools`，以同一字段顺序重新 `JSON.stringify`。
2. **不删除任何嵌套内容**：Codex `input.additional_tools`、Code Mode 声明、DSH PTC 的完整内嵌 SDK 均计入。
3. 对同一个紧凑 JSON 字符串报告 JS `length`（UTF-16 code units）、UTF-8 bytes、
   [KodaX countTokens](../../packages/agent/src/tokenizer.ts) 启发式估算，以及 SHA-256。
4. `model`、输出上限、stream、usage 请求选项等 HTTP 控制字段不计入模型文本；每行记录被排除字段。
   DSH 独立扩展日志的服务端处理与计费未知，不能把整个 HTTP 包称为模型上下文。
5. 当前 Codex **基础模板单独列表示例**：统计解码后的原始文本，没有加 JSON 包装。
   其字符和 token 均给出，但不能与完整请求行当作相同范围比较。

这里的 token 不是各 provider 的 BPE tokenizer、API input usage、实扣费用或 Codex UI 上下文百分比。
字符数是 UTF-16 code units，不是 UTF-8 字节或用户感知字形数。表格统一了统计方法，**没有统一能力、模型或运行场景**。

## A. 已保存的完整 Windows 序列化请求

| 项目 / 模式 | 总字符（UTF-16） | 总字节（UTF-8） | 总估算 token | 来源 |
| --- | ---: | ---: | ---: | --- |
| KodaX Agent | 56,720 | 57,242 | **14,376** | 本轮 `LqPHVb` SDK 截获 |
| KodaX Coding | 71,216 | 71,758 | **18,008** | 同上 |
| KodaX Script | 87,486 | 88,022 | **22,073** | 同上 |
| KodaX Agent 重组候选 | 44,728 | 45,208 | **11,362** | 本轮 `ydhgJB` SDK 截获；未启用默认 |
| KodaX Coding 重组候选 | 59,224 | 59,724 | **14,994** | 同上；未启用默认 |
| Codex Sol Direct | 60,639 | 60,675 | **15,174** | 旧 `deede7201` Windows 实抓 |
| Codex Sol Code Mode 混合 | 73,847 | 73,883 | **18,476** | 同上 |
| Codex Sol Code Mode Only | 68,132 | 68,168 | **17,047** | 同上 |

KodaX：源码 HEAD `a349eabb9892f9d62299e95d05b3c5b7f9dd2a98` 加本轮已有工作区，
`kodax-first-turn-wire-LqPHVb/inventory.json` 保存实际源码 hash；完整隔离 Runtime Host、空项目、官方 builtin。
实际 provider SDK 序列化后本地截获，无外部服务；usage 为合成值，不用于费用估算。fixture 路径、session ID、快照时间已归一化。

Codex：`deede7201da27a178c39befa6b4959bb7d451645` 构建的 CLI 和 Code Mode host，
三臂只改变指定模型的 tool_mode，实际请求发往 loopback 并保存。
这是历史完整请求，**不是当前 `970111f6` 的总量**。原文件是以下 Temp 目录中的 `request.json`：
`codex-toolmode-20261024-wyPM0X`（Direct）、`EQyTRH`（混合）、`0ZA2tF`（Only）。
版本和实验方法见[已有 Windows 验收](first-turn-windows-comparison.md)及[模式源码记录](tool-mode-design.md)。

**旧数字为什么每项少了 27？** 先前 KodaX 的 `normalized-model-input.json` 仍含
`max_completion_tokens`、`model`、`stream`、`stream_options`，整对象曾报 14,403 / 18,035 / 22,100。
本次采用与 Codex 相同的模型文本字段选择后为 14,376 / 18,008 / 22,073。
这是统计范围修正，**不是产品又省了 27 token**。后续候选和基线都必须使用本方法。

重组候选 Agent/Coding 各减少 3,014 估算 token，Script 完整输入不变；
其真实模型验证与未启用原因见[完整契约实施验收](restructured-contract-validation.md)。
本表的计数收益不代表完整任务质量、往返或耗时已经非劣。

## B. 当前本地源码的完整模型字段投影

| 项目 / 配置 | 总字符（UTF-16） | 总字节（UTF-8） | 总估算 token | 平台与限制 |
| --- | ---: | ---: | ---: | --- |
| DSH Standard | 37,873 | 37,955 | **9,499** | tracked Bash 快照映射 |
| DSH PTC | 45,184 | 45,262 | **11,326** | 同上，完整 SDK 已计入 |
| DSH Minimal / Bash | 1,874 | 1,896 | **477** | 缩小能力集合 |
| DSH Minimal / Pwsh | 1,819 | 1,841 | **463** | 源码 shell 替换投影，非 Windows 实抓 |
| Pi 默认四工具 | 5,623 | 5,645 | **1,414** | 源码 renderer/schema 投影 |
| Pi + Todo/subagent/questionnaire | 9,094 | 9,116 | **2,282** | 指定官方示例扩展、plan inactive |

DSH revision `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。
来源为 `snapshots/web/fresh-round-trip` 的 system/schema/session 快照，经
`packages/llm/llm-deepseek/src/serialize.ts` 的生产字段映射，保存为
`dsh-cost-source-22ddee-76ffea41793149248300c289bc5a4c60/*-model.json`。
这些不是当前版本新抓 HTTP；cwd 占位符和 Bash 场景与 A 表不同。Minimal 不具有完整 AMA 工作面，不能作等能力目标。

Pi revision `136b87e8a7f5a3e5186de0289523ba327dc592fc`。
系统来自生产 renderer，工具描述/schema 来自源码表达式，使用 TypeBox 等价基础构造器与合成 OpenAI 包装；
未实际安装扩展或执行 provider adapter。固定 Windows 风格 cwd，工具为 Bash；无个人/项目指令、Skills 或 MCP。
输入分别为 Temp `pi-source-cost-20261025/projection.json`、
`pi-extensions-cost-20261025/questionnaireIdle.json`。
这不是“全部插件”的总量，也不是成熟 AMA 等价证明。方法详见[Pi 工作面复核](pi-agent-surface-review.md)。

## C. 当前 Codex 的基础模板：同单位，单独范围

| 模板原文 | 字符（UTF-16） | 字节（UTF-8） | 同方法估算 token |
| --- | ---: | ---: | ---: |
| gpt-6.1-sol | **21,769** | 21,779 | **5,446** |
| gpt-5.6-terra | **17,730** | 17,766 | **4,446** |

来源：当前 `970111f6cb62cc02fe36a82ea7d71b37a2889c97` 的
`C:/Works/PubProj/codex/codex-rs/models-manager/models.json`，
按 slug 选择 `model_messages.instructions_template`。
这是运行时模板渲染/替换之前的原文；尚未加工具、权限、环境、Skills、项目规则等。

因此 **21,769 字符在统一启发式下约为 5,446 token，不是 21,769 token**。
不能拿它与 KodaX 完整 14,376 token 算倍数，也不能用历史 Codex Only 的 17,047 代替当前版本总量。
当前 Codex 完整请求仍需对应版本的构建与抓包，本记录没有补造这个缺项。

## 重算与验证

本次显式 manifest 和报告存于 OS Temp `kodax-uniform-costs-20261027-fO5vTS`。
报告 SHA-256：`8998af64428406c041358fd11b46d6f75c9585dd70f082a45720e1faa719fd73`。
报告保存各输入原文件 hash、模型字段 hash、来源、平台、包含/排除字段以及计数器源码 hash。
临时文件可能被系统清理；上面表格和限定条件是持久化结论，不依赖研究草稿才能理解。

重算已有原文件，不启动模型或重新抓包：

```powershell
npx tsx tests/first-turn-uniform-costs.ts "$env:TEMP/kodax-uniform-costs-20261027-fO5vTS/manifest.json" "$env:TEMP/uniform-costs-recount.json"
```

输出文件必须尚不存在；不会覆盖旧证据。自建 manifest 为数组，每项包括
`id/input/scope/sourceRevision/origin/platform/notes`；完整请求 `scope=complete-model-fields`，
catalog 模板 `scope=base-template` 并指定 `modelSlug`。脚本只读明确指定文件，不扫描会话或凭据。

新增 3 项离线回归 RED→GREEN：嵌套 AdditionalTools 不能漏算、HTTP 控制字段/格式化空白不污染计数、
UTF-16/UTF-8 和基础模板范围区分；`npx tsc -p tsconfig.test.json --noEmit` 通过。
本轮无生产修改、无模型调用，也不由这些成本数据推断智能或任务往返。
