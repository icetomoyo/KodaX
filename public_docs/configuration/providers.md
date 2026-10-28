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
| `minimax-coding` | `MINIMAX_CODING_API_KEY` | Yes | `MiniMax-M3.1-Flash` |
| `mimo-coding` | `MIMO_CODING_API_KEY` | Yes | `mimo-v2.6-pro` |
| `mimo` | `MIMO_API_KEY` | Yes | `mimo-v2.6-pro` |
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

## Ark Coding catalog refresh (2026-10-28)

`ark-coding` keeps `glm-5.3` as its default and uses the existing Anthropic
endpoint `https://ark.cn-beijing.volces.com/api/coding` with
`ARK_CODING_API_KEY`. The new Agent Plan `/api/plan` endpoint and its key are
separate. These additions are explicitly listed for Coding Plan in the
[official model configuration](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-claude-code.md#3a775131).

| Model ID (sent verbatim) | Context tokens | Maximum output tokens |
|---|---:|---:|
| `deepseek-v4.1-flash` | 1,024,000 | 384,000 |
| `deepseek-v4.1-flash-economy` | 1,049,000 | 384,000 |
| `glm-5.3-flash` | 1,024,000 | 128,000 |
| `kimi-k3.1-pro` | 1,024,000 | 128,000 |
| `kimi-k3` | 1,024,000 | 128,000 |
| `kimi-k2.8-preview` | 1,024,000 | 1,024,000 |

These are Ark gateway limits, not copied from the direct providers. Context
integers and image input follow the
[Coding OpenCode configuration](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-ai-opencode.md#baa2dc81);
output ceilings follow the
[Coding Plan model table](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-plan-overview.md#51b87c17).
The example's 65,536-token output setting is a client budget, not the model
maximum. Existing `deepseek-v4-pro` and `deepseek-v4-flash` output metadata
also rises from the inherited 32,000-token budget to the documented 384,000.
All six new routes accept image input in KodaX; video/file input is not exposed.

DeepSeek V4.1 uses `thinking.type: adaptive` plus `output_config.effort`:
`low`/`minimal` → low, `medium`/`high`/`xhigh` → high, `max`/`ultra` → max,
`auto` → high, and `off` → disabled thinking. Ark explicitly requires
adaptive thinking for the effort parameter to take effect; direct DeepSeek
and existing V4 routes retain their existing enabled shape. See the
[Ark DeepSeek guide](https://ark.volcengine.com/region:cn-beijing/docs/deepseek-v4-1-flash.md#reasoning-effort).

GLM Flash reuses the existing GLM-5.3 reasoning profile: default max,
medium → high, xhigh → max, and off → enabled low effort. K3.1 reuses the
Kimi Code always-thinking profile with default max and local off rejection.
K3 and K2.8 use adaptive thinking with the native Messages output effort field;
their high/max defaults respectively are upstream-derived metadata rather
than an independently measured Ark compute budget. K3 and K2.8 disabled
thinking requests were accepted live with no thinking blocks. Ark's K3
overview says thinking cannot be disabled, so this observed gateway behavior
does not establish which backing model handled the non-thinking request.

Verification with the restored key on 2026-10-28: credential check passed;
text streaming passed 6/6 new routes; image-request acceptance passed 6/6;
DeepSeek's seven user effort requests passed 7/7; controlled read/tool-result
replay passed on DeepSeek V4.1, GLM Flash and K3.1. These are protocol checks,
not a model-quality or internal-compute comparison. K3.1 rejected forced
tool choice in thinking mode; KodaX now recognizes that error and retries
without forcing a tool while preserving thinking. Both that recovery and
the following tool-result request passed live. Directly disabling K3.1
returned HTTP 400 (temperature validation), so KodaX retains its conservative
local off rejection.

Previous model IDs remain for configuration/history compatibility, not as
an availability guarantee. In particular, the
[official retirement notice](https://ark.volcengine.com/region:cn-beijing/docs/coding-plan-personal-model-deprecation.md#b2c8f1a0)
ends `kimi-k2.7-code` service on 2026-10-28 at 14:00 UTC+8 and schedules
MiniMax M3 retirement for 2026-11-02. Select one of the new routes for new
sessions. No K3.1 Highspeed route is added because Ark has not listed it.
Cost tracking retains nominal subscription placeholders for the new routes;
these values do not represent model-specific AFP deductions.

## MiMo and MiniMax Coding refresh (2026-10-28)

These catalog updates follow the official documents retrieved on 2026-10-28.
No MiMo or MiniMax credential check or model request was made: the supplied
keys are unavailable. Offline tests validate metadata and serialized SDK
requests; live availability and account entitlement remain unverified.

| Provider | Default / selectable new models | Context tokens | Maximum output tokens |
| --- | --- | ---: | ---: |
| `mimo-coding` | `mimo-v2.6-pro` / `mimo-v2.6-flash` | 1,048,576 | 131,072 |
| `mimo` | `mimo-v2.6-pro` / `mimo-v2.6-flash` | 1,048,576 | 131,072 |
| `minimax-coding` | `MiniMax-M3.1-Flash` | 1,000,000 | 524,288 |

MiMo Token Plan explicitly lists both V2.6 models. Its OpenCode configuration
documents their exact context/output limits and image input. Both use the
Anthropic thinking toggle, `thinking.type: enabled | disabled`, without a
documented native effort parameter. KodaX low/medium/high/xhigh/max/auto
enable thinking, while off/none/minimal disable it. No `budget_tokens`,
`reasoning_effort`, or `output_config.effort` is sent. See the
[subscription model list](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/subscription),
[integration limits](https://mimo.mi.com/docs/zh-CN/tokenplan/integration/opencode),
and [Anthropic request schema](https://mimo.mi.com/docs/zh-CN/api/chat/anthropic-api).

The MiMo Coding endpoint remains
`https://token-plan-cn.xiaomimimo.com/anthropic`, using `MIMO_CODING_API_KEY`.
The existing public `mimo` mirror retains
`https://api.xiaomimimo.com/anthropic` and `MIMO_API_KEY`; it receives the same
V2.6 replacement because the old V2.5 names expired globally on 2026-10-21
at 10:00 UTC+8. Saved configs explicitly naming `mimo-v2.5-pro` or `mimo-v2.5`
must select the corresponding V2.6 model; KodaX removes those retired names
from its catalog and does not silently rename requests. See the
[retirement notice](https://mimo.mi.com/docs/zh-CN/updates/deprecate) and
[credential/endpoint separation](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/quick-access).

MiniMax M Plan now documents `MiniMax-M3.1-Flash` for all tiers, including
continuing Token Plan subscribers. The Preview name redirects to the formal
model; KodaX uses its canonical ID. The documented subscription endpoint is
`https://api.minimax.cn/anthropic`, using `MINIMAX_CODING_API_KEY`; this replaces
the previous built-in `.minimaxi.com` address. See the
[M Plan overview](https://platform.minimax.cn/docs/m-plan/intro),
[existing subscriber notice](https://platform.minimax.cn/docs/m-plan/token-plan-notice),
and [tool integration](https://platform.minimax.cn/docs/m-plan/other-tools).

M3.1 Flash supports native `output_config.effort` values
low/medium/high/xhigh/max and `thinking.type: adaptive`. KodaX auto omits
effort so the documented server default max applies; omitted SDK reasoning
uses max, minimal aliases to low, and explicit off/none is rejected locally
before dispatch. Thinking cannot be disabled. The documented output hard
limit is 524,288, with 131,072 recommended; thinking tokens share this output
budget. Model metadata records the hard limit, and callers may lower their
per-request budget. See the [Anthropic compatibility contract](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)
and [message-generation schema](https://platform.minimax.cn/docs/api-reference/text-chat-anthropic).

Images are enabled on the three new Coding model routes. MiniMax and public
MiMo document native video, but SDK video remains unwired. MiMo Token Plan
video entitlement is unverified, so its route is not advertised as video
capable. All historical thinking blocks and signatures remain alongside
tool calls and results in later requests, as required by both Anthropic
compatibility contracts. Historical MiniMax M3/M2.7 selections retain their
previous profiles and budgets; this does not guarantee current M Plan
entitlement. Existing nominal accounting rates remain placeholders, not
published subscription Credit prices or cash rates.

Offline acceptance covers every UI effort (including auto/off), stream and
complete request bodies, both MiMo endpoints, explicit-off rejection before
dispatch, exact capacities, historical MiniMax budgets, image/video gates,
and thinking/signature/tool-result replay. No online success is claimed.

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
