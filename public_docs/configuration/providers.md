# Providers & API Keys

KodaX supports 16 built-in LLM provider aliases. Each reads its API key from a
dedicated environment variable — no key is ever stored in config files.

The unreleased compatibility fix explicitly disables inherited
`ANTHROPIC_AUTH_TOKEN` for Anthropic-compatible gateways, including custom
compatible providers. CLI and SDK requests use that provider's configured key
without adding an unrelated Anthropic Bearer token. The native `anthropic`
provider's authentication behavior is unchanged.

## Built-in provider aliases

| Alias | Environment variable | Reasoning | Default model |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Yes | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | Yes | `gpt-5.3-codex` |
| `deepseek` | `DEEPSEEK_API_KEY` | Yes | `deepseek-flash` (Anthropic-compat; also legacy text-only `deepseek-v4-pro`) |
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

> Model snapshot date: 2026-08-26. Run `kodax setup --help` for the latest list.

## Kimi K3.1 routes

`kimi-code` offers `k3.1-pro` and `k3.1-pro-highspeed` using
`KIMI_CODE_API_KEY`. Public `kimi` offers `kimi-k3.1-pro` and
`kimi-k3.1-pro-highspeed` using the separate `KIMI_API_KEY`.
Select the exact model ID with `--model` or `/model`; the existing provider
defaults remain `k3-256k` and `kimi-k2.7-code`.

K3.1 always thinks: supported efforts are `low`, `high`, and `max`, with
`max` as the default. KodaX maps `medium` to `high`, `xhigh`/`ultra` to
`max`, and `minimal`/`minimum`/`light` to `low`; explicit `none`/`off` is
rejected before sending a request. Start a new session when switching from
older models. The maximum context is 1,048,576 tokens; Kimi Code access to
1M context and Highspeed depends on the membership plan. KodaX retains its
32,000-token per-turn subscription output cap and requests up to 131,072
output tokens on public K3.1, unless explicitly overridden.

The subscription uses native Anthropic Messages with `thinking: {type:
"enabled"}` and `output_config.effort`, matching the
[official Kimi client](https://github.com/MoonshotAI/kimi-code/blob/7ccac2b45b8a3481c76f771bb99c043b562de2c5/packages/agent-core-v2/src/human/llm-kimi/trait.ts#L165-L178).
Public Chat Completions uses top-level `reasoning_effort` without a `thinking`
object. Neither route uses legacy nested `thinking.effort`.
Thinking blocks/signatures and public
`reasoning_content` survive tool-result replay. See the official
[Kimi Code model guide](https://www.kimi.com/code/docs/kimi-code/models.html),
[public model parameters](https://platform.kimi.com/docs/api/models-overview),
the [Messages effort schema](https://platform.kimi.com/docs/api/messages),
and [public K3.1 quickstart](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart).

Verification on 2026-10-24: both subscription models passed real streaming
requests, and Pro passed thinking/tool-result replay. The public authenticated
model list returned both K3.1 IDs, but generation requests returned HTTP 429
because the existing public account had insufficient balance. Public
generation and tool replay remain unverified; their offline request contracts
pass. Only Kimi credentials were used for live checks.

An additional seven-level check on 2026-10-24 captured actual `kimi-code`
provider requests and used the same neutral effort question for every level.
Each enabled level completed one physical request with thinking and text;
`off` was rejected locally with zero HTTP requests. A direct subscription
request disabling thinking also returned HTTP 400. The final matrix used
separate session cache keys and a 2,048-token cap:

| User level | Sent `output_config.effort` | Model's reported level |
|---|---|---|
| `low` | `low` | `low` |
| `medium` (`/effort med`) | `high` | `low` |
| `high` | `high` | `low` |
| `xhigh` | `max` | `max` |
| `max` | `max` | `max` |
| `auto` | `max` | `max` |
| `off` | No dispatch | Explicit unsupported-effort error |

Request mapping and HTTP compatibility passed for all seven levels. Model
self-reports agreed with the expected level in 4/6 enabled final samples;
the two high-mapped samples reported low. This is a diagnostic discrepancy,
not proof that the backend downgraded computation: the
[first-party verifier](https://github.com/MoonshotAI/Kimi-Vendor-Verifier/blob/66092cf444c97356c0e11c5078c67116390615d9/tests/k3_features/test_thinking_effort.py#L153-L165)
also skips its strict three-level self-report/length test, and its
[protocol caveat](https://github.com/MoonshotAI/Kimi-Vendor-Verifier/blob/66092cf444c97356c0e11c5078c67116390615d9/tests/k3_features/test_thinking_effort.py#L211-L215)
notes that a parameter can take effect without being shown in the model's
prompt. KodaX continues to forward `high` exactly as documented.

Native subscription Responses rejected an invalid effort with HTTP 400 and
accepted low/high/max, but returned `reasoning: null`; its high self-report
was also low. Official beta Messages and native Chat controls did not resolve
the discrepancy. Messages accepted invalid effort values even with explicit
thinking and the official beta header, so HTTP 200 alone does not establish
effort enforcement. Actual server-side high computation remains unconfirmed;
no latency or reasoning-length claim is made.

To repeat the opt-in checks, set `KODAX_INTEGRATION_TEST=1` and only the desired
Kimi key(s), then run:

```sh
npm run test:integration -- packages/llm/src/providers/kimi-wire.integration.test.ts -t K3.1
```

## GLM Coding Plan routes

`zhipu-coding` defaults to `glm-5.3` and keeps `glm-5.2` as an explicit
rollback route. The overseas `zai-coding` alias also defaults to `glm-5.3`
(switched from `glm-5.2` on 2026-08-15). `ark-coding` likewise defaults to
`glm-5.3` (1M context, 128K output cap) and keeps `glm-5.2` (alias
`glm-latest`; a 2026-08-15 live probe confirmed the Ark wire accepts
`glm-5.3` verbatim and currently resolves `glm-latest` / `glm-5.2` requests
to GLM-5.3 upstream as well).

`glm-5.3-flash` (published 2026-08-26) is available on `zhipu`, `zhipu-coding`,
and `zai-coding`. It is the first natively multimodal GLM — image input works
out of the box (`@path` an image or paste from clipboard); native video input
exists upstream but is not wired in KodaX yet. It has a 1M context window,
cannot disable thinking (same effort mapping as `glm-5.3`), and is priced at
1/10 of GLM-5.3 ($0.15 input / $0.50 output per million tokens, $0.03 cached
input). On the GLM Coding Plan it comes with 3x plan quota.

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
