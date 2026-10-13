# 自动视觉审查：GLM / DeepSeek 实测与接线缺口

日期：2026-10-13（Asia/Shanghai）。KodaX 代码基线 `27d08788`。本轮只新增评测脚本和记录，未修改生产提示词、默认配置或用户 Host。此前的 Kimi PPT smoke 明确点名了视觉审查、技能和工具，不能用来证明普通任务自动触发。

## 实验与判定范围

- Layer 1 已验证内置视觉技能发现（1 个测试通过）、普通 Agent/AMA 共用执行指导、实际 Artifact schema 与解码边界。
- Layer 1 无法回答特定真实模型会不会主动取图；按 EVAL_GUIDELINES 使用 Layer 3.5 smoke，两个模型，每轮每模型一个普通 PPT 修改任务。不是提示词 A/B，也不推导可靠性百分比。
- 真实路由：`zai-coding/glm-5.3-flash`（与检查到的默认模型相同）和 `deepseek/deepseek-flash`。每 provider 最多一个请求在途，没有第三个裁判模型。
- Windows、同一独立测试 Host 的两个 Session、AMA、full-access。Artifact adapter 显式启用，Chromium 使用独立缓存、headless 模式，无 PowerPoint/LibreOffice/COM。
- 固定用户输入：`把当前 deck.pptx 的标题改为“Quarterly revenue review”，另存为 final.pptx，供会议展示，保留收入表和其他内容。完成后告诉我交付文件路径。`
- 输入不含 slash、视觉检查、技能名或工具名。真实 PPT 的标题被后绘制的深色矩形覆盖；图片、表格保留。工具说明和系统提示使用生产字节。
- 逐项区分：主动渲染、当前 PNG 的 SHA256 与模型请求图片一致、具体视觉发现、修复后复查、最终交付。工具 `ready`、Run 结束和输出文件存在都不作为质量通过。
- 原始 request body（无认证头）、模型响应、工具调用、调用计数、源文件和 PNG 保存在 OS temp；当前主会话检查像素并保存 `main-session-review.json`，其中包含 raw hash、判定、归因和限制。

## 实际结果

| 模型 | 普通请求主动渲染 | 实际 PNG 进入模型请求 | 正确指出标题遮挡 | 完整修复、复查、交付 |
| --- | --- | --- | --- | --- |
| GLM-5.3-Flash | 已观察到 | 已验证匹配 SHA256 | revision 2 已观察到 | 未证明；最终复验遇到 provider terminated/timeout 后触发测试截止 |
| DeepSeek Flash | 已观察到 | 已验证匹配 SHA256 | revisions 2、3 已观察到 | 未证明；最终复验达到每 cell 10 次请求上限 |

两者曾在未被用户点名时加载 `artifact-review`。GLM 在编辑后打开并渲染 `final.pptx`，指出源文件和修改文件 PNG 相同、标题被横幅盖住。DeepSeek 在原件和修改件取图，还创建并渲染了用于判断文本绘制与图层顺序的探针。主会话看到的实际页面与遮挡判断一致。最后一轮 GLM 已取得图片，但尚未形成完成审查的交付结论便遭遇传输故障；不能把先前正确观察提升成该轮完成验收。

因此结论是 **能够自动触发，不需要 slash；完整闭环不能宣称已全部通过**。这些结果也不证明所有格式、任务或每次模型采样都会完成质量审查。

## 保留的诊断轮次

| Revision / OS temp 目录 | 本轮实际请求 | 有效证据与失败归因 |
| --- | --- | --- |
| 1 / `kodax-artifact-auto-e2e-1cu2up` | 14 | 两个进程内 Runtime 的扩展注册生命周期互相影响；关闭其一后另一出现缺少执行作用域。事件回调也没有作为 AMA 的测试权限拦截生效。不能归因于模型不会审查；保留实际取图事实。 |
| 2 / `kodax-artifact-auto-e2e-juzwDb` | 11 | 改为同一 Host、在可信 extension `tool:before` 执行 fixture 限制，作用域错误消失。两者自主取图并指出缺陷；2048 初始输出预算触发正常 64000 升级，测试的 32768 wire 上限将其截断。 |
| 3 / `kodax-artifact-auto-e2e-apjfWR` | 16 | 初始输出预算 8192、允许现有 64000 升级。DeepSeek 达到调用上限；GLM 三次正常响应后有 terminated、request timeout，最终被 300 秒测试截止停止。 |

总计 41 次实际生成请求，包含诊断失败轮次；没有把中止样本隐藏为通过。每轮 `experiment.json` 冻结调用、轮次、输出、工具、token/spend 预留与截止，并累计前轮预算。最终的 token/spend **保守预留**为 6,171,182 / USD 26.142904，不是实际用量或扣费声明。每 cell 上限 10 次请求、50 次工具事件、300 秒，没有额外 child/workflow。原始证据目录均在 `C:/Users/ADMIN/AppData/Local/Temp/`。

非受管 shell 在 revisions 2、3 中刻意禁止，因此这次没有覆盖普通 CLI 通过脚本修改 OOXML、重排图层等修复替代路线。源 PPT 和交付候选仍保留。渲染/检测证据有效，完整交付结果受这些实验限制影响。没有继续追加样本来追求绿色结果。

## 当前默认 CLI 与测试环境的差异

检查默认用户目录 `C:/Users/ADMIN/.kodax`：`extensions/` 只有 `read_pdf`，递归未找到 `registerArtifactTools` / `@kodax-ai/artifacts`；`extensions.json` 不存在。被检查的项目扩展目录也不存在。这是配置检查，未读取用户会话或修改实际 Host。

随后用户报告其 KodaX Space 能正常自动触发。该观察来自用户，不是本测试对 Space 的单独验收；Space 可能由其可信 Host 提供所需工具，不能把上述本机默认 CLI 目录检查推广为 Space 或所有安装缺能力。

[Host bootstrap](../../src/host-integrations.ts) 只发现/加载配置的扩展；[Artifact adapter](../../packages/artifacts/src/kodax.ts) 的技能和 `artifact_*` 由 `registerArtifactTools` 注册。构建 workspace 及 npm link 本身没有启用这个 adapter。因此“测试里有工具时模型会自动检查”不能等同于“普通安装的 CLI 已默认拥有这套文件渲染管线”。已有其它渲染工具可能提供替代能力，但本轮未将其算作 Artifact SDK 接线。

## 确认的参数契约缺口

GLM 的 `artifact_capture` 调用使用 static 区域并附带 `state`、`sequence`、`target`。生产工具 schema 在同一个 locator 的 `properties` 中广告了所有四种定位字段，没有分支或禁止组合；公共解码器却只允许 static 的 `kind`、`region`，返回 `Unknown artifact field.`。同一请求的 schema/decoder 差异已用 Node 的真实 adapter 和 SDK 解码器复现，无模型调用。

此外 `readEvidence.source/raster`、`capture.expectedSource` 只广告为普通 object；创建元素的颜色没有说明无 `#` 的六位十六进制格式。DeepSeek 在探针创建时给出 CSS 风格颜色而被 worker 拒绝。这些不是缺少视觉触发，而是 LLM 面向的参数契约和诊断不完整，增加了修复成本。[工具定义](../../packages/artifacts/src/kodax.ts)、[统一解码](../../packages/artifacts/src/contract.ts)

## 与指定参考源码的对比

外部仓库只读：Codex `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`，ZCode `aac4755666d09fdcd70272fcf063c077a639015f`。ZCode 本地 freshness 检查通过；两仓库未修改。

| 参考 | 已确认机制 | 对 KodaX 的含义 |
| --- | --- | --- |
| Codex | 技能描述匹配时必须使用；`view_image` 返回真实图像输入。Goal continuation 逐需求检查权威证据，而不是把绿色检查当成完成证明。 | 自动调用可由主 Agent 负责；先保证技能/工具可见、图片真正入模、交付审查范围完整。Goal 专用审计不等于所有普通任务有同一硬门禁。 |
| ZCode | 当前文档插件定义 `defaultEnabled: true`，分发包含格式技能和 visual-judge；PPT 技能匹配任何 PPT 主输入/输出，并列内容、代码、视觉及交付 QA。视觉 judge 是只读分工。 | 默认能力接线比仅存在可选 SDK 完整；领域流程和参数指导能减少 Agent 自行摸索。插件文字里的“gate”不构成已证明的每次保存 Runtime 强制检查。 |
| KodaX | 普通 Agent/AMA 已共用视觉执行指导，启用 adapter 后这两个模型已主动取图、发现问题；SDK/Host 图片链路真实。 | 当前优先缺口是默认产品能力曝光、工具 schema 与 SDK 契约一致性，以及自然任务闭环证据；不需要重新引入文本 Sidecar。 |

源码：[Codex 技能规则](C:/Works/PubProj/codex/codex-rs/ext/skills/src/catalog_prompt.rs:8)、[真实图片](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/view_image.rs:188)、[Goal 完成审计](C:/Works/PubProj/codex/codex-rs/ext/goal/templates/goals/continuation.md:35)、[ZCode 默认插件](C:/Works/PubProj/ZCode/apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:207)、[PPT QA](C:/Works/PubProj/ZCode/apps/zcode-cli/packages/presentations-plugin/skills/pptx/SKILL.md:152)、[只读 judge](C:/Works/PubProj/ZCode/apps/zcode-cli/packages/presentations-plugin/agents/visual-judge.md:9)。

## 下一步建议（尚未实施）

1. 在现有 Host 的扩展生命周期中解决轻量 adapter 的默认/按需曝光，保留独立 SDK、受管执行和 SDK 客户端同一入口。渲染模块、浏览器检测/安装只在实际任务需要时发生；不把“已安装”或用户输入 slash 当成每次质量检查的前置动作。
2. 工具 JSON schema 表达与公共类型/解码器相同的 kind 分支、嵌套 source/raster、颜色约束；错误给出字段与期望格式。先做确定性契约回归，再用最小模型样本复核。
3. 保持主 Agent 的交付前审查和修复后新证据；补充自然任务、真实默认配置的基线与明确 unverified/失败范围。针对已发现的 probe 过多和修复能力缺口改进领域指导，避免泛化成另一套 reviewer 服务、终态 owner 或自动额外模型调用。

本轮工程建议为 `recommend-iterate`：自动触发已有正向证据，不能据此发布“默认 CLI 完整视觉验收已验证”的宽泛声明。
