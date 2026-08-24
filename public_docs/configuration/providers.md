# Providers & API Keys

KodaX supports 16 built-in LLM provider aliases. Each reads its API key from a
dedicated environment variable — no key is ever stored in config files.

## Built-in provider aliases

| Alias | Environment variable | Reasoning | Default model |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Yes | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | Yes | `gpt-5.3-codex` |
| `deepseek` | `DEEPSEEK_API_KEY` | Yes | `deepseek-v4-flash` (also `deepseek-v4-pro`; vision `deepseek-v4-flash-vision-exp`) |
| `kimi` | `KIMI_API_KEY` | Yes | `kimi-k2.7-code` |
| `kimi-code` | `KIMI_CODE_API_KEY` | Yes | `k3-256k` |
| `qwen` | `QWEN_API_KEY` | Yes | `qwen3.5-plus` |
| `qwen-token-plan` | `QWEN_TOKEN_API_KEY` | Yes | `qwen3.8-max` |
| `zhipu` | `ZHIPU_API_KEY` | Yes | `glm-5` |
| `zhipu-coding` | `ZHIPU_CODING_API_KEY` | Yes | `glm-5.3` |
| `zai-coding` | `ZAI_CODING_API_KEY` | Yes | `glm-5.3` |
| `minimax-coding` | `MINIMAX_CODING_API_KEY` | Yes | `MiniMax-M3` |
| `mimo-coding` | `MIMO_CODING_API_KEY` | Yes | `mimo-v2.5-pro` |
| `mimo` | `MIMO_API_KEY` | Yes | `mimo-v2.5-pro` |
| `ark-coding` | `ARK_CODING_API_KEY` | Yes | `glm-5.3` |
| `gemini-cli` | `GEMINI_API_KEY` | No | CLI bridge default |
| `codex-cli` | `OPENAI_API_KEY` | No | CLI bridge default |

> Model snapshot date: 2026-08-24. Run `kodax setup --help` for the latest list.

## GLM Coding Plan routes

`zhipu-coding` defaults to `glm-5.3` and keeps `glm-5.2` as an explicit
rollback route. The overseas `zai-coding` alias also defaults to `glm-5.3`
(switched from `glm-5.2` on 2026-08-15). `ark-coding` likewise defaults to
`glm-5.3` (1M context, 128K output cap) and keeps `glm-5.2` (alias
`glm-latest`; a 2026-08-15 live probe confirmed the Ark wire accepts
`glm-5.3` verbatim and currently resolves `glm-latest` / `glm-5.2` requests
to GLM-5.3 upstream as well).

KodaX sends both upstream model IDs verbatim: `glm-5.3` and `glm-5.2`. Do not
append `[1m]`; the context window belongs to local capability metadata, not the
wire model name. GLM-5.3 cannot disable thinking, so `off` / `none` maps to
`low`. Its complete stable-intent mapping is none/minimal/light/low → low,
medium/high → high, and xhigh/max/ultra → max.

## Set an API key

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

After setting the variable, close the current terminal, open a new one, and run
`kodax` again.

## Interactive provider setup

```bash
# Interactive metadata-only provider/model setup (does not collect a key)
kodax setup

# Guided custom OpenAI/Anthropic-compatible provider
kodax setup --custom

# Complete guide; does not change files
kodax setup --help
```

Setup checks these active files and matching `*.example.jsonc` references:

- `~/.kodax/config.json` and `~/.kodax/config.example.jsonc`
- `~/.kodax/integrations/mcp.json`
- `~/.kodax/integrations/extensions.json`
- `~/.kodax/integrations/a2a.json`

The core active file remains strict JSON. The first line of the annotated
`config.example.jsonc` points to all split files and documents every supported
core setting. Setup preserves existing files and stages readable legacy
`config.json#mcpServers` / `config.json#extensions` before creating empty
authoritative split files.

## Set a default provider in config

For CLI defaults, create `~/.kodax/config.json`:

```json
{
  "provider": "zhipu-coding",
  "effort": "auto"
}
```

## Qwen Token Plan

Qwen Token Plan uses a separate credential; `QWEN_API_KEY` does not authenticate
this route:

```bash
export QWEN_TOKEN_API_KEY=your_api_key
kodax --provider qwen-token-plan
```

## See also

- [Custom providers](./custom-providers.md) — Point KodaX at any compatible endpoint
- [Configuration files](./config-files.md) — Full config.json reference
- [Sandbox](./sandbox.md) — Optional OS-level containment
