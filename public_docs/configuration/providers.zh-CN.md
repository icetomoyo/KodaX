# 提供商与 API Key

KodaX 支持 16 个内置 LLM 提供商别名。每个提供商从专用环境变量读取 API Key——Key 不存储在配置文件中。

## 内置提供商别名

| 别名 | 环境变量 | 推理 | 默认模型 |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | 是 | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | 是 | `gpt-5.3-codex` |
| `deepseek` | `DEEPSEEK_API_KEY` | 是 | `deepseek-flash`（Anthropic 兼容；也支持旧版纯文本 `deepseek-v4-pro`） |
| `kimi` | `KIMI_API_KEY` | 是 | `kimi-k2.7-code` |
| `kimi-code` | `KIMI_CODE_API_KEY` | 是 | `k3-256k` |
| `qwen` | `QWEN_API_KEY` | 是 | `qwen3.5-plus` |
| `qwen-token-plan` | `QWEN_TOKEN_API_KEY` | 是 | `qwen3.8-max` |
| `zhipu` | `ZHIPU_API_KEY` | 是 | `glm-5` |
| `zhipu-coding` | `ZHIPU_CODING_API_KEY` | 是 | `glm-5.3` |
| `zai-coding` | `ZAI_CODING_API_KEY` | 是 | `glm-5.3` |
| `minimax-coding` | `MINIMAX_CODING_API_KEY` | 是 | `MiniMax-M3.1-Flash` |
| `mimo-coding` | `MIMO_CODING_API_KEY` | 是 | `mimo-v2.6-pro` |
| `mimo` | `MIMO_API_KEY` | 是 | `mimo-v2.6-pro` |
| `ark-coding` | `ARK_CODING_API_KEY` | 是 | `glm-5.3` |
| `gemini-cli` | `GEMINI_API_KEY` | 否 | CLI 桥接默认值 |
| `codex-cli` | `OPENAI_API_KEY` | 否 | CLI 桥接默认值 |

> 模型快照日期：2026-08-26。运行 `kodax setup --help` 获取最新列表。

## Kimi K3.1 路由

`kimi-code` 使用 `KIMI_CODE_API_KEY` 提供 `k3.1-pro` 和 `k3.1-pro-highspeed`；公开 `kimi` 使用单独的 `KIMI_API_KEY` 提供 `kimi-k3.1-pro` 和 `kimi-k3.1-pro-highspeed`。使用 `--model` 或 `/model` 选择具体模型 ID；现有提供商默认值保持 `k3-256k` 和 `kimi-k2.7-code`。

K3.1 始终开启思考：支持的强度为 `low`、`high` 和 `max`，默认为 `max`。KodaX 将 `medium` 映射到 `high`，将 `xhigh`/`ultra` 映射到 `max`，将 `minimal`/`minimum`/`light` 映射到 `low`；显式 `none`/`off` 在发送请求前被拒绝。切换到较旧模型时请开启新会话。最大上下文为 1,048,576 tokens。KodaX 对公开 K3.1 默认请求最多 131,072 输出 tokens，除非显式覆盖。

## GLM Coding Plan 路由

`zhipu-coding` 默认使用 `glm-5.3`，保留 `glm-5.2` 作为显式回退路由。海外 `zai-coding` 别名同样默认 `glm-5.3`（2026-08-15 起）。`ark-coding` 同样默认 `glm-5.3`（1M 上下文，128K 输出上限）并保留 `glm-5.2`。

`glm-5.3-flash`（2026-08-26 发布）在 `zhipu`、`zhipu-coding` 和 `zai-coding` 上可用。它是第一个原生多模态 GLM——图像输入开箱即用（通过 `@路径` 或剪贴板粘贴）；拥有 1M 上下文窗口，无法关闭思考（与 `glm-5.3` 相同的强度映射），定价为 GLM-5.3 的十分之一。

KodaX 逐字发送两个上游模型 ID：`glm-5.3` 和 `glm-5.2`。不要附加 `[1m]`；上下文窗口属于本地能力元数据，不属于 wire 模型名称。GLM-5.3 无法关闭思考，`off`/`none` 映射到 `low`。

## Ark Coding 目录（2026-10-28 更新）

`ark-coding` 保持 `glm-5.3` 为默认，使用现有 Anthropic 端点 `https://ark.cn-beijing.volces.com/api/coding` 和 `ARK_CODING_API_KEY`。

| 模型 ID（逐字发送） | 上下文 tokens | 最大输出 tokens |
|---|---:|---:|
| `deepseek-v4.1-flash` | 1,024,000 | 384,000 |
| `deepseek-v4.1-flash-economy` | 1,049,000 | 384,000 |
| `glm-5.3-flash` | 1,024,000 | 128,000 |
| `kimi-k3.1-pro` | 1,024,000 | 128,000 |
| `kimi-k3` | 1,024,000 | 128,000 |
| `kimi-k2.8-preview` | 1,024,000 | 1,024,000 |

以上 6 条路由均支持图像输入。DeepSeek V4.1 使用 `thinking.type: adaptive` 加 `output_config.effort`：`low`/`minimal` → low，`medium`/`high`/`xhigh` → high，`max`/`ultra` → max，`auto` → high，`off` → 关闭思考。

## MiMo 与 MiniMax Coding 更新（2026-10-28）

| 提供商 | 默认 / 可选新模型 | 上下文 tokens | 最大输出 tokens |
|---|---|---:|---:|
| `mimo-coding` | `mimo-v2.6-pro` / `mimo-v2.6-flash` | 1,048,576 | 131,072 |
| `mimo` | `mimo-v2.6-pro` / `mimo-v2.6-flash` | 1,048,576 | 131,072 |
| `minimax-coding` | `MiniMax-M3.1-Flash` | 1,000,000 | 524,288 |

旧的 MiMo V2.5 名称已于 2026-10-21 10:00（UTC+8）全局退役；保存的配置中显式指定 `mimo-v2.5-pro` 或 `mimo-v2.5` 的，需要选择对应的 V2.6 模型。

MiniMax M3.1 Flash 支持原生 `output_config.effort`，思考无法关闭。KodaX `auto` 省略 effort，让服务器应用默认值 max；`off`/`none` 在派发前被本地拒绝。

## 设置 API Key

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

设置变量后，关闭当前终端，重新打开，再运行 `kodax`。

## 交互式提供商配置

```bash
# 仅元数据的交互式提供商/模型配置（不收集 Key）
kodax setup

# 引导式添加自定义 OpenAI/Anthropic 兼容提供商
kodax setup --custom

# 完整帮助；不修改文件
kodax setup --help
```

## 在配置中设置默认提供商

```json
{
  "provider": "zhipu-coding",
  "effort": "auto"
}
```

## Qwen Token Plan

Qwen Token Plan 使用独立凭据；`QWEN_API_KEY` 不适用于此路由：

```bash
export QWEN_TOKEN_API_KEY=your_api_key
kodax --provider qwen-token-plan
```

## 另见

- [自定义提供商](./custom-providers.zh-CN.md) — 接入任意兼容端点
- [配置文件](./config-files.zh-CN.md) — 完整 config.json 参考
- [沙箱](./sandbox.zh-CN.md) — 可选 OS 级隔离
