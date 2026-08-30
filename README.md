<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img src="assets/logo-light.svg" alt="KodaX" width="640">
  </picture>
</p>

<p align="center">
  <b>Source-available AI coding agent on every LLM you can reach.</b><br>
  Anthropic · OpenAI · DeepSeek · Kimi · Zhipu · MiniMax · MiMo · Ark · Qwen · Gemini · Codex.<br>
  REPL · CLI · library · Node-free single binary.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kodax-ai/kodax"><img alt="npm version" src="https://img.shields.io/npm/v/@kodax-ai/kodax?style=flat-square&color=cb3837"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-KAI--FCL_1.0-orange?style=flat-square"></a>
  <a href="https://github.com/icetomoyo/KodaX/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/icetomoyo/KodaX?style=flat-square&logo=github&color=f1c40f"></a>
  <a href="https://github.com/icetomoyo/KodaX/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/icetomoyo/KodaX/release.yml?style=flat-square&label=release"></a>
  <img alt="providers" src="https://img.shields.io/badge/LLMs-16_aliases_+_custom-2ecc71?style=flat-square">
</p>

<p align="center">
  <a href="#install-in-30-seconds">Install</a> ·
  <a href="#four-ways-to-use-kodax">Usage</a> ·
  <a href="#sdk-usage">SDK</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="docs/FEATURE_LIST.md">Roadmap</a> ·
  <a href="https://github.com/icetomoyo/KodaX/discussions">Discussions</a> ·
  <a href="README_CN.md">中文 README</a>
</p>

<p align="center">
  <img src="kodax-hd.gif" alt="KodaX in action" width="880">
</p>

---

## Install in 30 seconds

```bash
npm i -g @kodax-ai/kodax

# Pick any one you have an API key for (`kodax setup --help` lists all):
export ZHIPU_API_KEY=...        # ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY /
                                # KIMI_API_KEY / KIMI_CODE_API_KEY / QWEN_API_KEY /
                                # QWEN_TOKEN_API_KEY / ZHIPU_CODING_API_KEY /
                                # ZAI_CODING_API_KEY / MINIMAX_CODING_API_KEY /
                                # MIMO_API_KEY / MIMO_CODING_API_KEY / ARK_CODING_API_KEY

kodax
```

That's it. You're in the REPL — ask anything in natural language. On a new
machine, bare interactive `kodax` first checks for supported API-key environment
variables. If none exists, KodaX only prints Windows, macOS, and Linux setup
instructions and exits without creating configuration or collecting a key.
After setting the variable, close the current terminal, open a new one, and run
`kodax` again. If a supported credential exists but no provider is selected,
KodaX opens the provider/model metadata setup. Use `kodax setup` to rerun the
flow, `kodax setup --custom` for a guided custom provider, and
`kodax setup --help` (or REPL `/setup --help`) for paths, provider variables,
commands, and shortcuts. Interactive setup also checks the optional ASRT sandbox once:
Windows requests UAC during activation (an existing v2 account rotation may
require a second confirmation); macOS/Linux report any required
Seatbelt/bubblewrap dependencies. Declining or missing a dependency does not
break ordinary permission handling, and normal startup will not keep reminding
you.

> **No-Node target machines:** download a Bun-compiled single binary for Windows / macOS / Linux × x64 + arm64 from the [GitHub Releases](https://github.com/icetomoyo/KodaX/releases) page. See [docs/release.md](docs/release.md) for the build pipeline.

---

## Four ways to use KodaX

| Form | Command / Import | When to use it |
|---|---|---|
| **REPL** | `kodax` | Interactive multi-turn coding session with streaming UI, permissions, slash commands |
| **CLI** | `kodax -p "your task"` | One-shot scripted task, CI runs, batch processing |
| **Library** | `import { runKodaX } from '@kodax-ai/kodax'` | Embed in your own tool / agent / web service |
| **Single binary** | `./kodax` | Distribute to machines that don't have Node installed |

---

## Why KodaX

<table>
  <tr>
    <td width="33%" align="center" valign="top">
      <h3>🇨🇳 6 China-native LLMs</h3>
      <sub>Zhipu · Kimi · MiniMax · MiMo · Ark · Qwen</sub>
      <br><br>
      First-class adapters with cross-provider <a href="benchmark/EVAL_GUIDELINES.md">prompt-eval calibration</a> on a canonical 5-alias panel — not OpenAI-compat shims.
    </td>
    <td width="33%" align="center" valign="top">
      <h3>📦 Single-file binary</h3>
      <sub>Bun --compile · Win / macOS / Linux · x64 + arm64</sub>
      <br><br>
      No Node required on the target machine. Drop one file, run anywhere — restricted envs, CI runners, air-gapped boxes.
    </td>
    <td width="33%" align="center" valign="top">
      <h3>🌳 Branchable session lineage</h3>
      <sub>Fork · rewind · parallel edit</sub>
      <br><br>
      Conversation history is a DAG, not a list. Powers the upcoming <b>KodaX Space</b> desktop app.
    </td>
  </tr>
  <tr>
    <td align="center" valign="top">
      <h3>🤖 Multi-agent by default</h3>
      <sub>V2 Worker single-loop + Sidecar Verifier + async children</sub>
      <br><br>
      <code>spawn_agent</code>, <code>send_message</code>, <code>followup_task</code>, <code>interrupt_agent</code>, multi-instance auto-coordination with content-hash safety net.
    </td>
    <td align="center" valign="top">
      <h3>🧩 Skills + self-construction</h3>
      <sub>Markdown Skills, model-visible NL discovery, explicit slash invocation</sub>
      <br><br>
      5-stage self-modification staircase (scaffold → validate → stage → test → activate) gated by an 8-invariant admission contract.
    </td>
    <td align="center" valign="top">
      <h3>🛠 50+ built-in tools</h3>
      <sub>File · shell · search · MCP · ACP</sub>
      <br><br>
      Repo intelligence, semantic search, git worktree, web fetch — all addressable through one clean tool surface.
    </td>
  </tr>
</table>

## How KodaX compares

| Feature | **KodaX** | Claude Code | Aider | Codex CLI | Cursor | Cline |
|---|---|---|---|---|---|---|
| Source license | ⚠️ KAI-FCL, non-commercial | ❌ Source-available | ✅ Apache&nbsp;2.0 | ✅ Apache&nbsp;2.0 | ❌ Proprietary | ✅ Apache&nbsp;2.0 |
| Node-free single binary | ✅ Bun | ❌ Node | ❌ Python | ✅ Rust | ❌ Electron | ❌ Extension |
| Native China providers<br><sub>(Zhipu · Kimi · MiniMax · MiMo · Ark · Qwen)</sub> | ✅ 6 native | ❌ | ⚠ via LiteLLM | ❌ OpenAI-first | ❌ no provider menu | ⚠ Kimi / Qwen / DeepSeek |
| Branchable session lineage | ✅ fork & rewind | ⚠ routines / sessions | ❌ | ❌ | ❌ | ⚠ checkpoints |
| Multi-agent + MCP + 50+ tools | ✅ all three | ✅ all three | ⚠ tools, no MCP | ✅ all three | ⚠ Composer + MCP | ✅ all three |

<sub>Data verified May 2026 against public docs ([Claude Code](https://github.com/anthropics/claude-code) · [Aider](https://aider.chat/docs/llms.html) · [Codex CLI](https://github.com/openai/codex) · [Cursor](https://cursor.com) · [Cline](https://github.com/cline/cline)). ⚠ = partial / requires extra setup / not first-class. Corrections welcome via PR.</sub>

## Detailed Setup

> The `npm i -g @kodax-ai/kodax` one-liner above is the fastest path. This section is for building from source, configuring custom providers, or using KodaX as a library.

### 1. Build the CLI from source

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build
npm link
```

### 2. Configure a provider

KodaX reads API keys from environment variables. For built-in providers, the fastest path is:

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
authoritative split files. It tells you the exact environment-variable name to
set and exits so you can restart the terminal. Existing active files are
validated first; an invalid file is reported without creating or overwriting
configuration. For a custom provider, setup asks for an `apiKeyEnv` name such
as `MY_LLM_API_KEY`, not the API key itself. `config.json` stores that name
only; after setup, set the environment variable with exactly that name to the
provider's actual API key. KodaX does not set the OS environment variable for
you. You can also configure it directly:

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

### 2.1 Activate the optional sandbox

`kodax setup` and first-run setup check sandbox readiness. You can inspect or
activate it explicitly:

```bash
kodax sandbox doctor
kodax sandbox setup
```

- Windows uses a restricted sandbox account and network policy. A normal
  terminal is sufficient; approve the activation UAC confirmation(s).
- macOS uses Seatbelt/`sandbox-exec` and requires ripgrep
  (`brew install ripgrep`).
- Linux uses bubblewrap and requires `bubblewrap`, `socat`, and `ripgrep`
  (install them with your distro's `apt`, `dnf`, or `pacman`). The host kernel
  and security policy must also permit unprivileged user namespaces; KodaX
  reports a failed backend launch and does not change system policy itself.

KodaX never runs `sudo` or a package manager automatically. Edits and
Auto[LLM] try the sandbox first. A command that completes there is silently
authorized; a proven pre-start denial or unavailable backend reaches the
profile-specific host boundary. A command that may have started is never
replayed. In the REPL, `/sandbox` refreshes readiness
and diagnostics without activating the backend or requesting elevation.
Per-command sandbox routing remains internal and is not shown in normal command
history. SDK embedders can use the same capability independently through
`@kodax-ai/kodax/sandbox`; see the
[SDK sandbox guide](public_docs/sdk/embedder-guide.md#30-standalone-sandbox-sdk-v0778).

Sandboxed shell commands inherit the host environment, including ordinary
development credentials, and retain external network access. A fixed internal
deny set removes KodaX/Electron execution-control variables. Writes remain
bounded to the workspace and system temporary directory; broad host reads,
including Agent Home and global Git configuration, are available.

For Qwen Token Plan, select `qwen-token-plan` and use its separate credential;
`QWEN_API_KEY` does not authenticate this route:

```bash
export QWEN_TOKEN_API_KEY=your_api_key
kodax --provider qwen-token-plan
```

For CLI defaults, create `~/.kodax/config.json`:

```json
{
  "provider": "zhipu-coding",
  "effort": "auto"
}
```

If you need a custom base URL or an OpenAI/Anthropic-compatible endpoint, define a custom provider in the same config file:

```json
{
  "provider": "my-openai-compatible",
  "customProviders": [
    {
      "name": "my-openai-compatible",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
      "model": "my-model",
      "userAgentMode": "compat",
      "reasoning": {
        "efforts": ["off", "low", "medium", "high", "max"],
        "default": "high"
      }
    }
  ]
}
```

Here, `"apiKeyEnv": "MY_LLM_API_KEY"` is a reference to an environment-variable
name, not an API key value. Put the custom provider's actual API key in the
`MY_LLM_API_KEY` environment variable, then close the current terminal and open
a new one before running `kodax`.

`userAgentMode` defaults to `"compat"`, which sends `KodaX` instead of the official SDK User-Agent. Switch it to `"sdk"` only when your gateway expects the upstream SDK header.
For custom reasoning models, `reasoning: { efforts, default }` is the preferred v0.7.57 shape; use `"reasoning": "none"` for models without thinking capability. SDK hosts should render effort pickers from `reasoningProfile.supportedEfforts` / `defaultEffort` rather than assuming a fixed five-option ladder.

#### OpenAI-compatible reasoning providers

Some OpenAI-compatible reasoning models require KodaX to replay the previous assistant turn's `reasoning_content` on later requests. DeepSeek V4 thinking mode is the known load-bearing case. Built-in DeepSeek already opts in; custom providers must say so explicitly:

```json
{
  "customProviders": [
    {
      "name": "my-deepseek-v4",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_DEEPSEEK_API_KEY",
      "model": "deepseek-v4-flash",
      "maxOutputTokensField": "max_tokens",
      "reasoningPreset": "deepseek-v4-flash-openai",
      "replayReasoningContent": true
    }
  ]
}
```

DeepSeek Chat Completions uses `max_tokens`; OpenAI proper defaults to
`max_completion_tokens`. Keep `replayReasoningContent` unset or `false` for
OpenAI proper and gateways that reject unknown assistant-message fields. If one
gateway routes mixed models, prefer per-model overrides for both fields:

```json
{
  "models": [
    {
      "id": "deepseek-v4-flash",
      "maxOutputTokensField": "max_tokens",
      "reasoningPreset": "deepseek-v4-flash-openai",
      "replayReasoningContent": true
    },
    { "id": "gpt-5", "replayReasoningContent": false }
  ]
}
```

If a custom endpoint is confirmed to support cache-affinity routing, set
`"promptCacheAffinity": true`. Anthropic-compatible requests then receive the
opaque logical-context key as `metadata.user_id`; OpenAI-compatible requests
receive `prompt_cache_key`. The default is `false` because some strict
compatible gateways reject unknown request fields. Do not enable it solely
because an endpoint claims protocol compatibility.

Sidecar verifier judge calls use provider-level forced tool choice when supported. If a compatible endpoint rejects the `tool_choice` parameter, KodaX retries that verifier request once without forced tool choice and still fails open rather than blocking the main Worker.

#### Opting a custom provider into image / vision input (FEATURE_134 v0.7.40)

If your custom provider's underlying model supports image input (vision), set `"imageInput": true` so KodaX's image routing and the provider-policy gate both let image artifacts through. This is the typical shape for self-hosted multimodal models served by vLLM or SGLang behind an OpenAI-compatible endpoint (Qwen-VL-style models):

```json
{
  "customProviders": [
    {
      "name": "my-vllm",
      "protocol": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "MY_VLLM_API_KEY",
      "model": "Qwen/Qwen3.8-27B-Instruct",
      "imageInput": true
    }
  ]
}
```

`imageInput: true` forces `capabilityProfile.multimodalSupport: "image-input"` on every KodaX surface (provider instance, capability queries, policy gates), overriding an explicit `"none"`. The advanced alternative — a hand-written `capabilityProfile` block with `"multimodalSupport": "image-input"` — works too; see [Custom Providers](public_docs/configuration/custom-providers.md). Leave it unset for text-only models and image artifacts are rejected with `MODEL_INPUT_UNSUPPORTED` before the request is sent.

Built-in vision-capable aliases (Anthropic, OpenAI, compatible aliases such as Kimi, Qwen, Zhipu, MiniMax, MiMo, Ark, plus Gemini-CLI via the CLI's `@<path>` file-include syntax) already ship with image input enabled. DeepSeek V4's default models (`deepseek-v4-flash` / `deepseek-v4-pro`) and Codex-CLI are text-only — on the built-in `deepseek` alias only `deepseek-v4-flash-vision-exp` takes images; custom providers need to opt in when their underlying model supports image input.

The serializer layer (`packages/llm/src/providers/anthropic.ts:1431` for Anthropic-compat, `openai.ts:1496` for OpenAI-compat) forwards image blocks automatically through base-class inheritance — OpenAI-compatible endpoints receive standard `image_url` blocks. The flag only gates whether KodaX's policy layer pre-rejects multimodal requests — the model-level vision contract remains your upstream provider's responsibility. If the model is actually text-only, you'll see the real upstream API error instead of a KodaX-side rejection.

### 3. Start in REPL or run a one-shot task

```bash
# Interactive REPL
kodax

# Then ask naturally inside the REPL
Read package.json and summarize the architecture
/mode
/help

# One-shot CLI usage
kodax "Review this repository and summarize the architecture"
kodax --session review "Find the riskiest parts of src/"
kodax --session review "Give me concrete fix suggestions"
```

### 4. Use it as a library

Library usage still expects API keys from environment variables. If you want custom provider names or base URLs in code, register them explicitly:

```typescript
import { registerCustomProviders, runKodaX } from '@kodax-ai/kodax';

registerCustomProviders([
  {
    name: 'my-openai-compatible',
    protocol: 'openai',
    baseUrl: 'https://example.com/v1',
    apiKeyEnv: 'MY_LLM_API_KEY',
    model: 'my-model',
    userAgentMode: 'compat',
  },
]);

const result = await runKodaX(
  {
    provider: 'my-openai-compatible',
    effort: 'auto',
  },
  'Explain this codebase'
);
```

> **Embedding KodaX inside another app?** (KodaX Space, IDE extensions, custom CLIs)
> See [public_docs/sdk/embedder-guide.md](public_docs/sdk/embedder-guide.md) for the runtime-mutation
> surface (`startKodaX` + `RunningSession`), MCP popout manager API (`McpManager`),
> Skill `` !`cmd` `` host hook, and per-app data dir namespacing (`getAppDataDir`).

## Runtime SDK and daemon

SDK hosts can use `@kodax-ai/kodax/runtime` in three forms: inline embedded for
lowest latency, Worker-hosted embedded for private state plus hard V8 disposal,
or a local daemon shared by REPL, Space, IDE adapters, and custom SDK clients.
All three expose the same `KodaXRuntime` services.

```ts
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';

const isolated = await createKodaXRuntime({
  mode: 'embedded',
  isolation: 'worker',
  requirements: { hardDispose: true },
});
```

### Structured Runtime failures

Since v0.7.96, when Runtime has a structured failure fact, failed/cancelled runs
and unknown settlement states project the same credential-safe `failureDetail`
through failure or settlement events, `handle.result` / `runs.await()`,
`runs.get()` / `runs.list()`, and `sessions.diagnostics()`. Branch on the stable
KodaX `providerErrorCode`; use `safeMessage` for display, and treat
`upstreamErrorCode`, `requestId`, `httpStatus`, and `retryAfterMs` as optional
support metadata.

```ts
const session = await isolated.sessions.create({ title: 'Repository summary' });
const handle = await isolated.runs.start({
  sessionId: session.id,
  input: { type: 'text', text: 'Summarize this repo.' },
});
const result = await handle.result;

if (result.failureDetail) {
  const { providerErrorCode, safeMessage, requestId } = result.failureDetail;
  showFailure(safeMessage, { providerErrorCode, requestId });
}
```

`safeMessage` is a bounded KodaX-owned template, not copied upstream text. The
Runtime never copies credentials, prompts, request/response bodies, raw header
collections, URLs, full local paths, stacks, or raw `Error` objects into
`failureDetail`; only the documented allowlisted metadata may be extracted.
See [Structured Runtime failures](public_docs/sdk/embedder-guide.md#structured-credential-safe-runtime-failures)
for the field contract, taxonomy, migration guidance, and security boundary.

Inline is private and lowest-overhead; Worker is private and hard-disposable;
daemon is process-isolated and shared. `runtime.close()` closes private
inline/Worker ownership, but only detaches one daemon client. Contradictory
isolation options fail instead of silently selecting a weaker mode. Worker
isolation is a V8 fault boundary, not a security sandbox.

Because a daemon is intentionally persistent, tests that auto-start one must
also run `kodax daemon stop --home <dir> --profile <name>` (or send authenticated
`runtime.shutdown`) before deleting their temporary home. A remaining Node
process is not safe to kill by name alone; verify its command line and owner.

```bash
kodax daemon start
kodax daemon stop --profile default
kodax --runtime-mode daemon
kodax -p "Review this repository" --runtime-mode daemon
```

All CLI task forms now use the same Runtime path: interactive REPL, positional
prompts, slash-command prompts, and `kodax -p`. Select the persistent default in
`~/.kodax/config.json`:

```json
{
  "runtimeMode": "daemon"
}
```

Resolution order is explicit CLI/SDK option > environment variable >
`config.json` > built-in default (`embedded`). `KODAX_RUNTIME_MODE=daemon` is a
temporary environment override. The same rule applies to other paired settings,
for example `provider` ↔ `KODAX_PROVIDER` and `effort` ↔ `KODAX_EFFORT`.
JSON names stay camelCase while environment names use `KODAX_UPPER_SNAKE_CASE`.

By default, daemon state, config, and runtime session storage use the exact
resolved `KODAX_HOME` (normally `<OS user home>/.kodax`), so CLI and SDK clients
converge on the same local daemon even when `KODAX_HOME` is an arbitrary custom
directory. The high-level `createKodaXRuntime({ mode: 'daemon' })` API starts or
reuses that daemon unless you pass an explicit endpoint/transport or
`autoStartDaemon: false`. An explicit `--home <dir>` or `homeDir` selects the
isolated `<dir>/.kodax` namespace for tests, CI, or project-local experiments.

**v0.7.71 packaged Electron patch:** packaged/asar Electron hosts can use daemon
auto-start without relaunching the GUI. `ELECTRON_RUN_AS_NODE` is limited to a
bootstrap-only child exec boundary and removed before daemon or ordinary user
child code loads. The default-enabled Electron `RunAsNode` fuse is required;
hosts that disable it must start the daemon through ordinary Node/KodaX CLI and
connect in attach-only mode. For SDK calls, `homeDir` is the CLI-style base
directory that owns `.kodax`, not the `.kodax` path itself. Electron embedders
must also follow the [native artifact unpacking contract](public_docs/sdk/embedder-guide.md#packaged-electron-native-artifact-layout).

**v0.7.75 Windows GUI stabilization candidate:** Runtime Worker-reachable
non-interactive subprocesses request hidden Windows consoles across memory/Git,
provider CLI/ACP, LSP, clipboard, worktree, review, extension-command,
checkpoint, and sandbox paths. Explicit editor, terminal, and PTY behavior is
unchanged. The SDK bundle includes a static child-process audit and a packaged
Electron 20-query console-visibility regression. Product-level packaged KodaX
Space verification remains useful but does not gate SDK packaging or
publication.

The same candidate distinguishes optional post-completion offers from
clarification required to finish the current request, emits budget-approval
state only for eligible Sidecar revisions, and preserves structured blocked
reasons across embedded and daemon Runtime boundaries.

**v0.7.76 Kimi Code catalog refresh:** `kimi-code` now defaults to the official
`k3-256k` Model ID and sends it unchanged. `kimi-for-coding` remains selectable
for K2.7 Code, alongside `kimi-for-coding-highspeed` and the 1M `k3` tier. K3
supports `low` / `high` / `max` reasoning with `high` as default; the 256K
route supports image input but not video input.

**v0.7.77 release:** AMA now chooses and composes six named
problem-solving patterns through the existing Actor control plane instead of
using a fixed topology or hidden Workflow. Optional strategy metadata becomes
a bounded, fact-only `PatternTrace`; the existing Sidecar remains the only
terminal-answer quality judge. Governed memory can also react sparsely after a
tool failure, verification failure, or committed compaction and place at most
three prompt-safe, low-authority evidence items before the next Action-LLM
request. The default path adds no selector model call; SDK hosts may opt into
`memoryRecallRunner` in process. Public `kimi` also gains the 1M `kimi-k3`
route while retaining K2.7 Code as its default. See the
[v0.7.77 design](docs/features/v0.7.77.md) and
[release checklist](docs/release.md#v0777-release-ready-candidate-verification).
The frozen F274/F275 paid evaluation completed with `recommend-ship` from the
final F274 Layer 2/Layer 3 reviews and the F275 pilot review, followed by a
joint `SHIP` decision for the deterministic contracts. Semantic memory
selection remains experimental and host opt-in; no task-quality, token, or
latency improvement is claimed.

**v0.7.78 evidence-gated learning, setup, and permission/sandbox release:**
Background learning is Memory-first. Only repeated independently verified
evidence, or an explicit preserve-as-Skill request with verified terminal
evidence, can admit a low-risk declarative Skill to a bounded immutable
project canary; three exact-revision uses and independently verified success
are required before automatic project trust. Every revision remains visible
and reversible in `/learn`. Protected/formal Skills, global promotion, and
Extension authoring remain explicit user actions.

First-run setup now creates and validates the split core/MCP/Extensions/A2A
files and annotated templates without overwriting existing configuration or
collecting secrets. That release introduced the earlier pre-classification
permission route. FEATURE_297 supersedes it with sandbox-first execution:
sandbox completion is silent; only a proven pre-start boundary reaches Edits
or Auto[LLM], and reviewer infrastructure failure blocks with a safer-route
message after one retry. Workspace containment now permits broad host reads,
including Agent Home, credential locations, and global Git configuration,
while retaining workspace/system-TMP-only writes and external network. See the
[v0.7.96 design](docs/features/v0.7.96.md#feature_297-codex-aligned-permission-profiles-sandbox-escalation-and-exec-policy),
[ADR-069](docs/ADR.md#adr-069-sandbox-success-is-authority-while-host-escalation-is-a-separate-policy-boundary),
and the [SDK permission guide](public_docs/sdk/embedder-guide.md#24-runtime-owned-permission-routing-and-plan-bridges-v0796).

The release closure also preserves intent across adjacent surfaces: static
Skill instructions load in Edit/Plan without granting later side effects,
dynamic Skill commands require an explicit host-controlled executor, root AMA
handles explicit remember/correct/forget requests immediately through the
governed `memory_intent` control plane while exceptional or inferred changes
remain reviewable, Workflow Actor waits remain
unbounded unless the workflow sets a deadline. Runtime Auto capability v5 and
shared Session settings v2 advertise the same sandbox-first four-profile
contract across embedded, Worker, and daemon hosts. Actor ownership additionally
uses Runtime identity rather than PID alone,
so PID reuse cannot pin a crashed owner. The resume Session picker also renders
timestamps in the host's local timezone.

**v0.7.79 release:** Configured outbound A2A Agents can persist two
independent, default-deny network permissions: private-address access and
non-loopback plaintext HTTP. The embedded Worker and shared daemon reconcile
and execute the same authorized configuration. Runtime embedders also gain one
authoritative Session status, bounded read-only diagnostics, byte-preserving
Session export, strict transcript observation, a provenance-checked ordinary
conversation projection, and bounded streaming-event coalescing with
capability-gated idle daemon upgrade. Standalone child-process, Session lineage,
shell cleanup, packaged sidecar, and parallel admission paths receive the
corresponding release hardening.

OpenAI-compatible custom providers can now choose `max_tokens` or
`max_completion_tokens` per provider or model. DeepSeek V4 Flash and Pro use
separate reasoning profiles and are advertised as text-only. See the
[v0.7.79 design](docs/features/v0.7.79.md) and
[release checklist](docs/release.md#v0779-release-preparation).
FEATURE_280 was explicitly rescheduled to v0.7.81 (then to v0.7.86 on
2026-08-04) and is not represented as shipped by this release.
Issue 256 was explicitly rescheduled to v0.7.84 and is likewise not represented
as shipped by this release.

**v0.7.80 hardening release:** The CLI honors `worker.configuredA2A` in
`~/.kodax/config.json`: the embedded Runtime becomes Worker-hosted and loads
the configured A2A plane inside the Worker owner, so configured outbound
Agents appear as `external:<name>` in `list_dispatchable_agents` and can be
dispatched with `spawn_agent`. The mode rejects configured MCP servers or
Extensions (they cannot cross the Worker boundary); use the default inline
Runtime to retain those capabilities. Worker-hosted embedded CLI sessions also
reduce run options to the JSON-safe wire DTO exactly like daemon mode instead of
crashing with `RuntimeTransportBoundaryError`. Auto permission analysis no
longer treats ordinary search scopes and tool metadata as unresolved, and a
`max_tokens`-truncated classifier retry uses a 1024-token budget (Issue 275).
Managed AMA turns now bound one uninterrupted tool loop by a 500-iteration
panic fuse that resets on every idle-yield resume — a runaway-loop breaker,
never a cumulative task budget — and a fused Runner fails with a structured
`RunnerIterationLimitError` carrying the recovery transcript. Managed-run
repetition loops are closed; parallel review and delegation guidance are
restored and tightened. FEATURE_278/279/282/283/285 were explicitly
rescheduled to v0.7.85, so v0.7.80 remains a debug/patch slot and no incomplete
feature is represented as shipped. See the
[v0.7.80 release checklist](docs/release.md#v0780-release-preparation).

**v0.7.81 Runtime interrupt integrity release:** Active-Run inputs submitted
with `delivery: 'interrupt'` now receive one canonical physical Session entry
before KodaX reports them as delivered. Every delivered item exposes its
`entryId` in both `runtime.runs.get(...).interruptInputs` and the durable
`run.input.delivered` event, including after compaction, replay, or Runtime
restart. A multi-input safe-boundary drain keeps each prompt as a separate user
message and maps it to its own entry. Runtime-owned persistence or provenance
failure fails the delivery closed rather than emitting an unverifiable event.
FEATURE_287 remains planned for v0.7.93; this is a non-Feature patch. See the
[v0.7.81 release checklist](docs/release.md#v0781-release-preparation).

**v0.7.82 Runtime causality release:** Daemon capability discovery now composes
live, complete MCP and Host Tool snapshots only for unfiltered search; an
explicit server filter selects that source alone, while legacy providers report
honest incomplete/unknown discovery. An observed Stop cooperatively fences
later retries, continuations, guardrails, tools, and Run-admitted Actor work;
trusted Abort remains terminal causality before credential redaction without
overriding a real completion or independent failure. Input submission resolves
the admitted authoritative Run before reading mutable Session history, so
active interrupt and after-turn admission do not produce a transient
`data_changed` rejection. FEATURE_287 remains planned for v0.7.93; this is a
non-Feature patch. See the [v0.7.82 release checklist](docs/release.md#v0782-release-preparation).

**v0.7.83 Windows daemon containment release:** Windows daemon startup creates
the daemon suspended, assigns it to a kill-on-close Job Object before resuming
user code, and keeps an out-of-Job supervisor until the Job is empty. The SDK
exports `waitForRuntimeDaemonShutdown()` and capability
`daemonShutdownVerification:1`; CLI stop waits for both daemon and supervisor
exit. Legacy uncontained daemons are not reported as verified and are not
silently upgraded in place. The Worker owner-lease portion of Issue 256 remains
scheduled for v0.7.85, and FEATURE_287 remains planned for v0.7.93. See the
[v0.7.83 release checklist](docs/release.md#v0783-release-preparation).

**v0.7.84 Actor settlement recovery release:** Agent progress persistence is
now bounded to one in-flight write plus one latest replacement, so terminal
settlement cannot wait behind an unbounded progress backlog. A same-owner Stop
can reconcile a late Actor snapshot after a durability timeout, durably quiesce
remaining children, and retry the repair. Promise success/failure facts remain
authoritative over fallback callbacks after repair; stale durable unknown state
cannot rewind a local terminal Run or duplicate cancellation effects. No-op
quiescence avoids an unnecessary Session rewrite. See the
[v0.7.84 release checklist](docs/release.md#v0784-release-preparation).

**v0.7.85 release:** this release ships the F289/F290 Memory review and
lesson/verdict pipeline, F291 Session-scoped Runtime Event Journals, and F292
conversation-first Memory management with the additive experimental SDK
management facade. It also includes Actor settlement convergence, Agent Home
and learned-root guardrails, terminal startup replay avoidance, idle
repo-intelligence Worker retirement, Windows sandbox/ACL hardening, and the
matching regression guides. These include intentional runtime and system-code
changes. Issue 256's remaining Worker owner-lease boundary is still open and
is scheduled for v0.7.86; this release does not claim descendant-closure proof
for that unresolved portion. See the [v0.7.85 release checklist](docs/release.md#v0785-release-preparation).

**v0.7.86 hardening release:** this patch release adds atomic recovery for
abandoned inline Runtime owners, process-start identity checks for Runtime and
learning locks, and Windows sandbox lifecycle attestation. Sandbox ACL owner
markers are durable and serialized across Runtime profiles; stop waits for
termination proof before ACL recovery, preserves combined cleanup failures, and
fences later filesystem effects instead of replaying a command whose process
tree was not proven drained. POSIX workspace sessions initialize fresh
`KODAX_HOME` policy roots before admission, settle workspace-local warm-up
within the Shell abort/deadline, and retire invalid sessions after lease-cleanup failure while
applying the same fail-closed replacement rule. Windows
workspace Shell calls also preserve the case-insensitive `PATH`/`Path` contract,
derive bounded PATH/executable read grants, and carry quoted `cmd.exe` arguments
through the broker without re-parsing. Commands with the same canonical
workspace, Agent Home, filesystem, toolchain, and network policy can share one
Windows sandbox policy group across KodaX processes. The filesystem-effect
coordinator now waits through its 30-second stale-owner proof window during a
legitimate process handoff, without extending the one-second fail-closed
boundary for conflicting effect categories. An incompatible policy or
pre-start sandbox infrastructure failure returns the already-authorized command
to normal permission execution; a command that started or may have started is
never replayed. Runtime sandbox capability v3 fences upgrades from older daemon
policy revisions. Issue
256's remaining Worker owner-lease boundary
stays open and was scheduled for v0.7.87. See the
[v0.7.86 release checklist](docs/release.md#v0786-release-preparation).

**v0.7.88 release:** this release contains the Actor settlement convergence v2
durability contract, bounded startup/resume work, the guarded classifier reason
diagnostic, and the REPL fix that dismisses stale learning-recovery notices
after the first submitted query. These are intentional Runtime, Agent, LLM,
and REPL system-code changes. `zhipu-coding`, `zai-coding`, and `ark-coding`
default to `glm-5.3` while retaining `glm-5.2` as an explicit route; Ark keeps
the `glm-latest` alias. Coding Plan model IDs are sent verbatim without a
synthetic context suffix, and GLM-5.3 `off` / `none` intent is lowered to
`low`. See the [v0.7.88 release checklist](docs/release.md#v0788-release-preparation).

**v0.7.89 release:** this release ships Issue 293's topology-transparent managed
context projection and v4 conversation page cache, FEATURE_293's bounded
zero-service web search fallback (DuckDuckGo HTML → Bing RSS → Bing HTML), and
FEATURE_294's run-scoped Host Tools. Host tools appear in the leased run's model
surface and capability catalog, dispatch registry-first, revoke fail-closed, and
never enter the global registry or unrelated CLI runs. The web-search custom
endpoint remains isolated, and no shell/sandbox system code changed in this
release. See the [v0.7.89 release checklist](docs/release.md#v0789-release-preparation).

**v0.7.90 release:** this stabilization release keeps the v0.7.89 contracts
while fixing workspace-session timeout retirement and daemon Error diagnostics,
direct clone-predecessor lineage/archive-marker topology, and provider-valid
schemas for run-scoped tools. These are intentional Runtime/sandbox, Agent,
Coding runtime, and REPL persistence system-code fixes; the fail-closed safety
boundaries remain unchanged. See the
[v0.7.90 release checklist](docs/release.md#v0790-release-preparation).

**v0.7.91 release:** this maintenance release adds the SDK-owned
`runtimeExitSettlement:1` capability and `settleKodaXRuntimeExit()` transaction.
Hosts can persist exact Runtime ownership before a complete exit, resume after a
crash, and repair only verified Windows process/Job/ACL residue; same-boot POSIX
recovery remains fail-closed. Provider retries, fallback, and continuation now
share a logical output-segment projection (`responseId` plus
`providerRequestId`), and standalone Bun binaries bundle lazy Anthropic/OpenAI
SDK dependency graphs. These are intentional Runtime, LLM, Coding runtime, and
SDK system-code changes; shell and sandbox fail-closed boundaries remain
unchanged. See the [v0.7.91 release checklist](docs/release.md#v0791-release-preparation)
and [SDK Embedder Guide](public_docs/sdk/embedder-guide.md). The same release
also bounds AskUser/permission lifecycles with owner AbortSignals and validates
default answers, exposes `handleRuntimePermissionRequest()` for SDK-owned
permission UI, and recovers stale prepared Session tails through an
authoritative merge. Background persistence failures are surfaced as
diagnostics rather than hidden.

**v0.7.96-alpha.3 release:** Provider credentials are lazy, scoped,
revocable capabilities (ADR-068). The v2 credential broker keeps Provider
secrets in the OS keychain and resolves them per wire call for one closed
purpose (primary, fallback, classifier, sidecar, compaction, agent, workflow,
utility) inside revocable leases; manual compaction runs keychain-only
through a stable `session.compact` operation, native/constructed child Agents
derive the intersection of the live parent authorization and their own
capabilities, and detached Workflows receive closable derived leases.
Shared-daemon native, constructed, and workflow Agent turns now require an
explicit scoped binding and fail closed without one; External Agents stay on
their independent `credentialRef` plane, and a v2 client fails closed against
an older daemon. Agent authority wire records are closed and reject unknown
fields (host extension data belongs in `metadata`). Daemons advertising
`daemonClientInventory:1` expose bounded, display-only connected-client
diagnostics. See the
[v0.7.96-alpha.3 release checklist](docs/release.md#v0796-alpha3-release-preparation).

**v0.7.96-alpha.2 release (Windows hotfix):** restored the Windows
boot-identity PowerShell resolution helper that the FEATURE_295 cleanup
deleted while its last caller stayed. On v0.7.96-alpha.1 every Windows exit
settlement crashed with `windowsAclPowerShellExecutable is not defined` and
left sandbox cleanup `unverified`; the restored helper plus a win32 regression
test close Issue 325. v0.7.96-alpha.1 is broken on Windows — upgrade to
v0.7.96-alpha.2. See the
[v0.7.96-alpha.2 release checklist](docs/release.md#v0796-alpha2-release-preparation).

**v0.7.96-alpha.1 release:** controlled
text tools and shell containment are separate authorities on every desktop
platform. `write`, `edit`, `multi_edit`,
`insert_after_anchor`, and `undo` run in the trusted KodaX Runtime with final
path/identity policy checks, a cross-Runtime per-file kernel lock, revision
CAS, metadata-preserving flushed atomic replacement, and a protected native
state root. They do not enter ASRT, a workspace
session, shell runner, setup, cleanup, owner, reset, or poison state, and are
not described as OS-token-sandboxed. The root and `/coding` direct SDK entries
(`runKodaX`, `startKodaX`, `runManagedTask`, `createKodaXTaskRunner`, `createDefaultCodingAgent`,
`KodaXClient`, and its `Client` alias) bind the same native text
authority by default and read newly registered linked-worktree roots at
transaction time. Windows shell commands keep ASRT only for network/account
services and use the KodaX native restricted-token runner with
a nonce-bound per-policy private desktop, creation-time Job containment, and framed stdio. Native shell commands from
different policies, Sessions, and Runtime processes do not share a
command-lifetime filesystem-effect lease. Commands in one Runtime with the
same network policy and sandbox-account generation share one ASRT network
broker while retaining independent policy tokens and Jobs. Unlike policies do
not share authority; Issue 308 tracks ASRT 0.0.65's remaining fixed-port
capacity limit across distinct policies and Runtime processes. Arbitrary shell writes remain normal
OS races; only controlled text tools participate in KodaX CAS. Target stdin EOF
does not close the native control stream. Authenticated directional pipes keep
control and events independent; timeout/cancel validates a nonce-bound runner
Job-drain record before returning the original stop reason.
Windows trusted replacement automatically converts an obsolete sandbox-owned
file to trusted-host ownership and preserves the ordered effective ACE policy.
The filesystem may canonicalize DACL protection/inheritance control at the
atomic namespace commit; stale inherited authority is not copied from an old
parent. The
shell may read workspace-local `.kodax/runtime` like other host state, but
cannot write it even when the surrounding workspace is writable.
Each shared broker owns a verified native liveness controller whose named pipe
is created with a protected Host/SYSTEM-only DACL and multiple pending
instances. Restricted targets cannot connect or exhaust it; controller or
broker loss closes the channel and drains every attached command Job.
Native request/terminal state is kept in a no-reparse, host/SYSTEM-only control
directory; both SDK policy validation and the native host reject overlapping
allow roots and deny roots at/below it before target launch. Doctor only
verifies. After proving the sandbox account idle, explicit setup can retire an
expired dead-PID request or a dead-owner terminal record that already proves
Job drainage before repairing host-owned state. Live, unexpired, malformed,
unknown, and deny-recovery records remain fail-closed.
If Unix cannot prove directory durability after the atomic commit, the tool
returns `text_mutation_commit_uncertain` with the complete pre/post receipt and
requires a reread instead of a blind retry. Existing-file edits retain their
Undo backup; a commit-uncertain Undo is rebound to the observed post-commit
revision so a later CAS-checked Undo can resolve it. See
[ADR-066](docs/ADR.md#adr-066-trusted-text-transactions-and-a-native-windows-shell-sandbox-are-separate-authorities).
This incompatible authority split is fenced by `sandboxRuntime:6`, so a new
client never silently reuses a daemon that still implements the v0.7.95 graph.
Existing Windows installations run `kodax sandbox setup` once: the cutover
waits for old sandbox processes to exit, removes only exact legacy KodaX
sensitive-root guards with the previous group SID, recreates the dedicated account with
a new SID, and records
setup generation 4 with the native protocol/SID generation. Missing migration
state blocks native shell admission, not trusted text tools. Ordinary command
admission never repeats that legacy cleanup or revokes shared ACL state; each
Runtime command retains an independent request, token, control channel, and Job.
On Windows, the embedded release manifest pins text/shell protocols and hashes
plus the ASRT release version and hash. Verified executables are staged in a
content-addressed protected LocalAppData store independent of `KODAX_HOME`;
ASRT is checked before materialization and again before broker startup. Text
remains Host/SYSTEM-only, the dedicated sandbox group SID receives read/execute
on the shell artifact, and local Users receive read/execute on ASRT; neither
sandbox trustee nor local Users receives write/delete authority.
A package-store hardlink is accepted only in bundled builds, through a
handle-bound bounded read whose complete bytes match the embedded release
digest; development manifests and sources remain single-link. The executable
used by the broker is still a separate, protected single-link file. Allow-root
authorization changes only exact canonical roots and never rewrites their
private ancestor DACLs.
Linux and macOS use the same trusted-text authority with native no-follow/
`flock`/CAS/atomic commit, while shell commands remain per-command ASRT
bubblewrap/Seatbelt invocations with no KodaX workspace-session owner.
Issue 307 tracks the narrower ASRT-owned runner pre-main creation window that
also remains in current Codex; final command targets are still placed in their
Job at process creation, and trusted text tools never enter that boundary.
Issue 309 records the other Codex-compatible Windows residual: stable root
capabilities do not override an explicit ambient loader-compatibility ACE,
whether left by an earlier sandbox command or already present on an external or
host-owned descendant. This release also replaces the local tool-result
capacity hard gate with capacity-debt admission and a bounded recovery
ladder (ADR-067), classifies local capacity terminals as
`failureKind: "context_capacity"` with structured `contextTokens`, and
exposes one credential-safe `failureDetail` across failure events, Run
result/status, and Session diagnostics. It advertises Windows
`sandboxRuntime:6`; `runtimeExitSettlement:2` and `crashOutcomeModel:2` are
unchanged. See the
[v0.7.96-alpha.1 release checklist](docs/release.md#v0796-alpha1-release-preparation).

**v0.7.95 release:** stale learning locks with zero-byte,
malformed, or truncated owner records self-recover after an unchanged
bytes/stat check. Same-boot Windows `unconfirmed-owner` cleanup retries until
the sandbox-user SID is proven idle, without requiring marker deletion.
Windows sandbox cleanup keeps every ACL-mutating helper and command owner in a
recoverable machine-global Job and retries process drain, ACL reset, and
effect-fence release in the background; Runtime shutdown verifies exact daemon
and supervisor process generations. Text cleanup retains its execution
attestation and retries transient workspace cleanup, policy reset, and
effect-lease release automatically.
Canonical history stores the exact explicit-Skill query, multiple Skill
references are rejected, and failed/malformed `PreToolUse` hooks deny the tool.
Terminal persistence uncertainty publishes `unknown` or invalidates live
Session observers for resnapshot. A status-lock cleanup failure after a
committed terminal is reconciled only when the reread status exactly matches
the local proposal, then publishes one terminal event; different authority
still wins. The coding runtime finalizes its authoritative result before
emitting the public completion signal, so A2A cannot publish an empty
successful answer (Issue 302). This release advertises Windows
`sandboxRuntime:5` and `runtimeExitSettlement:2`. See the
[v0.7.95 release checklist](docs/release.md#v0795-release-preparation).

**v0.7.95 dynamic-worktree correction:** KodaX-created linked
worktrees join the exact Session shell/text sandbox policy before their paths
are returned, persist across later Runs, and are revalidated against the same
Git common directory. Removal revokes the root; unrelated siblings remain
fenced. A real submodule Session root proves that identity through its bounded
`.git/modules/...` `core.worktree` backlink; candidates still require ordinary
linked-worktree backlinks. For an older Session without the registry field, a retained successful
`worktree_create` result is migrated once only after the same Git relationship
passes validation. If that exact evidence is unavailable, stop the background
process and remove/recreate the worktree through KodaX once. Do not delete
ProgramData coordination files for this migration.

**v0.7.94 release:** Runtime text tools may overlap a compatible live Bash
lease because snapshot and commit run through the same ASRT workspace policy.
Hard-linked workspace targets are rejected. Windows sandboxed git trusts
authorized repo roots only and never emits `safe.directory=*` (Issue 300).
Linked-worktree and submodule relationship files are read through strict byte
bounds before that git trust is granted. Sandboxed text-helper stdin failures
stay on the operation Promise. Scheduled daemon shutdown reports failed
cleanup instead of a safe stop.
A missing workspace directory omits the concurrent text sandbox at Run start.
Runtime advertises `conversationHistory:2`. Explicit Skill invocation
(`/<name>`, `/skill:<name>`) remains available for every enabled Skill;
`disable-model-invocation` only blocks the model tool path. Invalid
`allowed-tools` entries and malformed hook JSON are diagnosed; `PostToolUse`
still runs if an embedder result observer throws. Every Run
finalization and sandbox/managed-child termination rejection is observed. If
neither terminal record can be persisted, the Run resolves `unknown` with
`run_settlement_not_persisted` and keeps the Session fenced.
Daemon connection loss exposes a typed code, `connectionId`, and `reconnectable` fact. Once a
host receives a `runId`, it must retain it and, after reconnecting, call
`runs.get(runId)` then `runs.await(runId)` on the replacement Runtime. It must
never replay `runs.start()` for that admitted Run. Capability versions
`sandboxRuntime:4` and `crashOutcomeModel:2` are unchanged. Issue 256 remains
open. See the
[v0.7.94 release checklist](docs/release.md#v0794-release-preparation)
and [SDK Embedder Guide](public_docs/sdk/embedder-guide.md#query-authoritative-session-and-run-lifecycle).

**v0.7.93 release:** Runtime exit settlement no longer spends the 170-second
Windows orderly-exit window after a durable `failed` shutdown outcome, can
recover previous-boot shared ACL markers after a verified boot change, and
keeps managed Stop interrupted when an Anthropic or OpenAI abort wrapper
does not carry the `APIUserAbortError` runtime name. Capability versions are
unchanged. Issue 256 remains open. See the
[v0.7.93 release checklist](docs/release.md#v0793-release-preparation)
and [SDK Embedder Guide](public_docs/sdk/embedder-guide.md).

**v0.7.92 release:** the filesystem-effect coordinator now gives each
queue attempt an exact token and heartbeat. It can reclaim a stale same-daemon
ticket only when that token no longer owns the coordinator lock, and durable
release evidence lets a later caller retire the matching settled effect owner.
An exact active lock, unknown process-tree outcome, or uncommitted command still
fails closed. Managed terminal ordering now commits the canonical Session
before completion and moves repo-intelligence/task-file projection outside the
active Run. The returned `KodaXResult.managedTask` is the terminal core snapshot;
maintenance may augment the later on-disk projection. Ordinary-permission
fallback continues to use the same effect fence. Resumed TUI history is rebuilt
from canonical Session messages first; a sparse `uiHistory` cache can overlay
display metadata but cannot hide ordinary conversation. Presentation-only
synthetic completion events stay host-owned when a non-empty CLI `uiHistory`
exists. Hosts must negotiate
`sandboxRuntime:4` and `crashOutcomeModel:2`. See the
[v0.7.92 release checklist](docs/release.md#v0792-release-preparation)
and [SDK Embedder Guide](public_docs/sdk/embedder-guide.md).

**v0.7.87 GLM provider release:** `zhipu-coding` defaults to `glm-5.3` and
retains `glm-5.2` as an explicit rollback route. `zai-coding` retained both
models but defaulted to `glm-5.2` until the overseas Coding Plan rollout
changed in v0.7.88. Coding Plan model IDs are sent verbatim without a context
suffix. GLM-5.3 is an always-thinking model, so an `off` / `none` intent is
lowered to `low` instead of sending an unsupported disabled-thinking request.
Issue 256's remaining Worker owner-lease boundary remained open after v0.7.87;
the release assigned no replacement target. See the
[v0.7.87 release checklist](docs/release.md#v0787-release-preparation).

The v0.7.77 release also adds an opt-in, host-configurable Shell Execution Contract.
Runtime Session settings or an individual Run can select `pwsh`, Windows
PowerShell, `cmd`, `bash`, `zsh`, or an explicit Git Bash executable; KodaX
resolves the shell environment in the effective project cwd and then executes
the command through that same interpreter. Resolved environments are isolated
by contract and cwd, expire after a bounded TTL, and can be explicitly
refreshed. The resolved host environment is inherited by profile/setup and
command targets; fixed KodaX/Electron execution-control variables are removed
before execution.
When `shellExecution` is absent, the established interpreter path is unchanged. See
[SDK Embedder Guide section 28](public_docs/sdk/embedder-guide.md#28-host-configurable-shell-execution-contract-v0777)
and the [Issue 214 regression guide](docs/test-guides/ISSUE_214_v0.7.77_REGRESSION_GUIDE.md).

Kimi Code requests also receive a stable, opaque prompt-cache affinity key
derived from the logical Runtime context. It is reused across Runs, retries,
fallback, resume, and compaction; recursive child Agents receive distinct keys
based on their canonical Agent path rather than their temporary transcript
Session. Public Kimi and official OpenAI use the corresponding
`prompt_cache_key` field, while other compatible gateways remain opt-in because
some reject unknown request fields. This improves routing stability but cannot
override Provider TTL or cache sharding. See the
[Issue 215 regression guide](docs/test-guides/ISSUE_215_v0.7.77_REGRESSION_GUIDE.md).
Codex CLI cache reads/writes and Gemini CLI cache reads now flow through the
CLI bridge and Runtime diagnostics without estimation. A reported `0` remains
distinct from an unreported field; see the
[Issue 216 regression guide](docs/test-guides/ISSUE_216_v0.7.77_REGRESSION_GUIDE.md).
The bridge also starts the first native CLI turn fresh, resumes only a native
session ID reported by that CLI, creates fresh ACP sessions for stateless
calls, recreates a closed pseudo transport, and validates the process exit even
after a terminal CLI event. User cancellation stays quiet, while hard/idle
timeout aborts remain failures eligible for Runtime recovery, and a CLI that
reports success but never exits is terminated at its configured deadline; see the
[Issue 217 regression guide](docs/test-guides/ISSUE_217_v0.7.77_REGRESSION_GUIDE.md).

One daemon owns many sessions. Different sessions may run concurrently; starts
within the same session are queued so that only one run is active for that
session. Multiple `kodax` processes can attach to the same daemon and open or
observe the same session. FEATURE_269 adds atomic snapshot-plus-stream joining,
durable idempotent mutations, revision-safe settings and grants, transport-safe
AskUser/permission responses, run-scoped credential and Host Tool bridges, and
one daemon/inline Coder owner fence. In-flight external effects are never
blindly replayed after a crash; clients receive explicit interrupted/unknown
terminal facts and resync when `runtimeId` changes.

Space and IDE hosts should require these capabilities through the Runtime SDK.
Partner remains on its private inline Runtime and must use a distinct product
data/session root. A missing daemon capability is an error, not permission to
silently fall back to inline Coder.

Live assistant output is owned by the Runtime segment projection. Provider
requests identify one logical reply (`responseId`), one physical request
(`providerRequestId`), and whether the new segment appends or replaces the
active request. Hosts requiring `liveOutputSegments:1` receive the same
effective draft after streaming and reconnect while raw journals retain the
complete audit trail. They must not replay provider recovery checkpoints or
deduplicate text heuristically.

For the full host-integration contract, including inline/Worker/daemon selection,
multi-client permission handling, config/catalog/MCP admin APIs, artifacts,
context diagnostics, and daemon protocol schemas, see
[public_docs/sdk/embedder-guide.md §17](public_docs/sdk/embedder-guide.md#17-runtime-sdk-worker-isolation-and-local-daemon-feature_253-feature_257).

The Space/IDE shared-daemon contract is documented in
[SDK Embedder Guide section 23](public_docs/sdk/embedder-guide.md#23-shared-coder-daemon-for-space-and-ide-hosts-feature_269-v0769).

**Current Runtime permission contract (v0.7.96):** Auto Mode is owned by the
Runtime session, not by a UI hook. Edits and Auto try the sandbox first;
sandbox completion is final, while only a proven pre-start host boundary reaches
Exec Policy and the Edits user decision or Auto[LLM] reviewer. Auto review has
fixed 90/180-second attempt bounds and never falls back to Rules, Edits, or an
automatic user prompt. Full Access skips sandbox and review but retains
administrator policy and critical-effect denial. Runtime permission prompts
offer opaque, exact
allow-once/session/persistent grant suggestions; persistent grants are
daemon-owned and revisioned. Host plan exit is exposed only when the host
supplies an approval callback. See the [Runtime permission integration guide](public_docs/sdk/embedder-guide.md#24-runtime-owned-permission-routing-and-plan-bridges-v0796).

## Repo Intelligence

KodaX ships with built-in repo intelligence (`repo_overview`, `module_context`, `symbol_context`, `process_context`, `impact_estimate`, and related tools) that helps the coding agent understand large codebases without ad-hoc grep/glob exploration.

Use `/repo-intel status` in the REPL to inspect the active engine. The former standalone `repointel` host skill has been removed; repo intelligence is built into KodaX and requires no external installation.

```bash
# Pick a runtime mode (auto | full | light | off)
kodax --repo-intelligence full --repo-intelligence-trace
```

## Architecture

KodaX uses a **monorepo architecture** with npm workspaces. Source layout currently has 4 workspace packages; published as a single bundled npm package `@kodax-ai/kodax` with 12 SDK subpath exports (`/agent`, `/llm`, `/coding`, `/media`, `/repl`, `/skills`, `/mcp`, `/session`, `/runtime`, `/sandbox`, `/a2a`, `/experimental-memory`; ADR-024 + ADR-032 + ADR-038, with ADR-036 consolidation):

```
KodaX/
├── packages/                # 4 workspace packages (FEATURE_194 v0.7.43)
│   ├── llm/                 # @kodax-ai/llm - LLM abstraction (16 built-in provider aliases)
│   │   └── providers/       # Anthropic, OpenAI, DeepSeek, Kimi, MiMo, MiniMax, Zhipu, Ark, …
│   │
│   ├── agent/               # @kodax-ai/agent - Generic Agent framework
│   │   ├── actors/          # Runtime-owned Actor tree, scheduler, mailbox, events
│   │   ├── session-lineage/ # branchable session tree (inline v0.7.43)
│   │   ├── capabilities/
│   │   │   ├── mcp/         # MCP integration (inline v0.7.43)
│   │   │   └── skills/      # Skills standard implementation + builtin (inline v0.7.43)
│   │   └── tracing/         # tracing / observability (inline v0.7.43)
│   │
│   ├── coding/              # @kodax-ai/coding - Coding Agent (tools + prompts)
│   │   ├── tools/           # 50+ tools: read, write, edit, bash, glob, grep, undo,
│   │   │                    #   spawn_agent, send_message, followup_task, wait_agent,
│   │   │                    #   ask_user_question, repo-intelligence, …
│   │   └── repo-intelligence/ # incl. protocol.ts (inline v0.7.43)
│   │
│   └── repl/                # @kodax-ai/repl - Interactive terminal UI (Ink TUI)
│
├── src/                     # CLI entry + SDK subpath entries
│   ├── kodax_cli.ts         # Main CLI entry point (bin: `kodax`)
│   └── sdk-*.ts             # SDK subpath re-exports → @kodax-ai/kodax/{agent,llm,coding,media,repl,skills,mcp,session,runtime,sandbox,a2a,experimental-memory}
│
└── package.json             # Publish-shaped exports; publish ships the CI-built tarball (release.mjs), local --pack-only keeps private:true
```

### Package Dependencies

```
                    ┌──────────────────┐
                    │  kodax (root)    │
                    │  CLI Entry       │
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
       ┌──────────────┐              ┌────────────────┐
       │@kodax-ai/repl│              │@kodax-ai/coding│
       │  UI Layer    │              │ Tools+Prompts  │
       └──────┬───────┘              └──────┬─────────┘
              │                             │
              │              ┌──────────────┴──────────────┐
              │              │                             │
              ▼              ▼                             ▼
       ┌──────────────┐ ┌──────────────────────────┐ ┌──────────────┐
       │@kodax-ai/    │ │@kodax-ai/agent           │ │@kodax-ai/llm │
       │coding (via   │ │Runner + fan-out +        │ │LLM Abstract  │
       │above)        │ │idle-yield + session-     │ │(16 aliases)  │
       │              │ │lineage + skills + mcp +  │ │              │
       │              │ │tracing (FEATURE_194)     │ │              │
       └──────────────┘ └──────────────────────────┘ └──────────────┘
```

### Package Overview

Source-side workspace package names (`@kodax-ai/*`). npm consumers install the single bundled `@kodax-ai/kodax` package and import from SDK subpaths — see [Source-side vs npm-published surface](#source-side-vs-npm-published-surface) and [SDK Usage](#sdk-usage) below.

| Workspace package | Purpose | Key Dependencies |
|---------|---------|------------------|
| `@kodax-ai/llm` | LLM abstraction (16 built-in provider aliases + custom registration) | @anthropic-ai/sdk, openai |
| `@kodax-ai/agent` | Generic Agent framework — Runner, fan-out, idle-yield, media/input artifacts, session-lineage, capabilities (mcp + skills), tracing (ADR-036 v0.7.43 consolidation; subpaths: `/media`, `/session-lineage`, `/capabilities/mcp`, `/capabilities/skills`, `/tracing`) | @kodax-ai/llm, fflate, jimp, yaml |
| `@kodax-ai/coding` | Coding Agent — 50+ tools (incl. canonical Actor collaboration tools) + role prompts + auto-continue + repo-intelligence protocol | @kodax-ai/llm, @kodax-ai/agent |
| `@kodax-ai/repl` | Complete interactive terminal UI (Ink/React, permission modes, commands, streaming) | @kodax-ai/coding, ink, react |

### Source-side vs npm-published surface

KodaX has two layers that consumers should understand separately:

- **Source-side**: 4 workspace packages above (what developers see when reading the repo).
- **npm-published**: a single bundled package `@kodax-ai/kodax` with 12 SDK subpaths (what SDK consumers `import` from). The subpaths are split into two roles:
  - **Full-package subpaths** (`/agent`, `/llm`, `/coding`, `/repl`) — each one maps 1:1 to a source workspace and exposes its complete public API.
  - **Integration and narrow subpaths** (`/media`, `/skills`, `/mcp`, `/session`, `/runtime`, `/sandbox`, `/a2a`, `/experimental-memory`) — focused host surfaces. `/a2a` composes the neutral F258 plane with the Runtime facade; it does not add A2A wire types to `/agent`.

| Source package | npm subpath | Type | What you get | Example consumer |
|---|---|---|---|---|
| `packages/llm`    | `@kodax-ai/kodax/llm`     | Full package | 16-alias LLM abstraction (108 exports) | Standalone LLM clients |
| `packages/agent`  | `@kodax-ai/kodax/agent`   | Full package | Runner / fan-out / external-agent plane / session-lineage / capabilities / tracing (331 exports) | Custom agent frameworks |
| `packages/agent`  | `@kodax-ai/kodax/skills`  | **Narrow subset** | Skills system only — `SkillRegistry` / `loadFullSkill` / `expandSkillForLLM` / ... (26 exports = pre-v0.7.43 `@kodax-ai/skills` complete API) | Skill loaders, IDE plugins |
| `packages/agent`  | `@kodax-ai/kodax/mcp`     | **Narrow subset** | MCP only — `McpCapabilityProvider` / `createMcpTransport` / `searchMcpCatalog` / ... (23 exports) | MCP server hosts |
| `packages/agent`  | `@kodax-ai/kodax/media`   | **Narrow subset** | Structured image/file/video input-artifact helpers (22 exports) | Desktop hosts and multimodal clients |
| `packages/agent`  | `@kodax-ai/kodax/experimental-memory` | **Experimental subset** | Thin F228-backed `MemoryAgent` / `MemorySession` lifecycle plus additive `MemoryManagementAgent` list/remember/forget | SDK hosts explicitly evaluating FEATURE_260 / FEATURE_292 |
| `packages/coding` | `@kodax-ai/kodax/coding`  | Full package | Coding agent + 50+ tools + repo-intelligence (505 exports) | Build a Claude Code-shape product |
| `packages/repl`   | `@kodax-ai/kodax/repl`    | Full package | Ink TUI + permission modes + commands (217 exports) | Terminal-UI consumers |
| `packages/repl`   | `@kodax-ai/kodax/session` | **Narrow subset** | Session management only — `listSessions` / `loadFullTranscript` / `appendClientNotice` / `forkSession` / `compactSession` / `watchSessions` / ... (17 exports) | IDE plugins and desktop hosts reading session history |
| `src`             | `@kodax-ai/kodax/runtime` | Host API | Embedded/Worker/daemon runtime facade, sessions/runs/events/permissions/catalog/MCP/artifacts/diagnostics/external agents, daemon protocol schema (10 exports) | SDK hosts, Space/IDE clients, daemon clients |
| `src`             | `@kodax-ai/kodax/sandbox` | Host API | Explicit ASRT capability/doctor/setup and host-owned contained command execution; unavailability never means silent ordinary execution | SDK hosts that need standalone process containment |
| `src`             | `@kodax-ai/kodax/a2a` | Integration edge | A2A 1.0 Agent Card discovery, JSON-RPC/SSE F258 executor, safe fetch policy, and authenticated Runtime-backed Agent server | Agent orchestrators and KodaX hosts |

**Rule of thumb**: if you need Runner / Agent / fan-out, import from `/agent`. If you only need skills or mcp APIs, import from `/skills` or `/mcp` to get a smaller bundle. The narrow subsets are subsets of the full packages — they do **not** expose extra symbols.

**Dynamic Workflows (FEATURE_217, v0.7.49)**: the domain-neutral workflow runtime is part of `/agent` — `import { createWorkflowRuntime, runWorkflow, WorkflowAbortError, WorkflowLimitError } from '@kodax-ai/kodax/agent'`. The coding-side integration (agent backend + built-in workflows + saved-workflow discovery/generation: `createCodingWorkflowBackend`, `runWorkflowFromOptions`, `parallelInvestigation`, `discoverSavedWorkflows`, `generateWorkflowFromOptions`, …) is part of `/coding`. FEATURE_217 is the v0.7.49 home for the full Dynamic Workflow product loop: `/workflow create <request>` generates restricted scripts, `/workflow save <runId> <name>` stores `.workflow.json` rerunnable workflows, generated/saved scripts coordinate agents through `WorkflowApi`, run lifecycle state stays observable, opt-in `isolation:"worktree"` routes selected children to parent-managed worktrees, and all file/shell effects still pass through agent tools and the existing permission gates. There is **no** separate `@kodax-ai/kodax/agent/workflow` root-package subpath; source-package consumers of `@kodax-ai/agent` can still use that package's `./workflow` subpath.

**Workflow Process Surface (FEATURE_229, v0.7.50)**: workflow progress is now a reusable Agent-layer process contract rather than private REPL text. SDK hosts can subscribe to `WorkflowProcessEvent`/poll `WorkflowProcessSnapshot`, use `createWorkflowRunManager` and `createWorkflowLifecycleController` for stop/pause/resume/result/artifact/delete/prune/identity/preflight controls, and receive ANSI-free provenance fields (`source`, `sourceRunId`, `sourceWorkflowName`, `savedWorkflowName`, `revisionOf`) plus `resultSummary`. `/coding` owns the coding workflow backend and run graph, `/repl` renders the same snapshots, and the terminal UI is not the hidden source of truth. `KodaXEvents` callbacks also take an optional metadata arg (`KodaXToolEventMeta` / `KodaXActivityEventMeta` / `KodaXWorkflowEventMeta`) so a host can attribute every child-agent tool/thinking/progress event to its workflow run and child id without a second event protocol, and generated/saved workflow scripts pass `validateRestrictedWorkflowSource` (compile + source-policy check) plus a generator repair/smoke loop before they run. See [docs/ADR.md ADR-040](docs/ADR.md) for the layering rationale.

**Host Reads Persisted History (FEATURE_230 + FEATURE_234, v0.7.51; v0.7.63 hardening)**: additive closures for hosts that read persisted state. **Durable tool transcript replay** — a resumed session now replays the tool cards the assistant used instead of degrading to text-only. `messages` / `lineage` stay canonical; `SessionData.uiHistory` becomes a bounded, sanitized, terminal-only replay cache. The SDK transcript contract is explicit: `loadSession()` = active model context, `loadFullTranscript()` = append-order host scrollback with typed entries (`message` / `compaction` / `branch_summary` / `rewind_marker` / `client_notice` / `task_result`) plus clone provenance (`logicalId` / `sourceEntryId`), `uiHistory` = optional replay cache, and tool cards can always be reconstructed from canonical messages. Hosts can persist local slash output with `appendClientNotice()` without entering model context, and workflow/child completions expose structured `taskResults[]` instead of requiring `<task-completed>` parsing. `rewind_marker` is an audit entry for host scrollback only and is excluded from model-context messages. **Workflow run host attribution** — `WorkflowProcessTrackerOptions` / `WorkflowProcessSnapshot` gain a host-owned opaque `hostMetadata?: Record<string, string>` that the SDK stores, persists to `run.json`, and echoes back (including after a restart) without interpreting it, so a host can map a run to the session/surface that launched it with zero side table. Unstamped/legacy runs honestly echo `hostMetadata === undefined`. See [docs/features/v0.7.51.md](docs/features/v0.7.51.md).

**Inline Workflow Authoring (FEATURE_246, v0.7.58; F270 update in v0.7.72)**: the Worker can author and run a workflow inline via the model-callable `run_workflow` tool when Workflow intent is explicit. It scouts the codebase first, bakes concrete findings into child prompts, and runs the script through the sandbox, static-validation, and postcondition-verification pipeline. F270 retires AMAW and complexity-driven activation; AMA keeps explicit `/workflow`, named/SDK, and natural-language Workflow requests. Workflow child Agents now run on the unified Actor control plane. See [docs/features/v0.7.58.md](docs/features/v0.7.58.md), [docs/features/v0.7.72.md](docs/features/v0.7.72.md), and ADR-044/046/047/048/049/055.

**Historical Workflow Activation Tiers (FEATURE_248 + FEATURE_249, v0.7.59; superseded by F270 in v0.7.72)**: v0.7.59 introduced AMAW and explicit-request AMA behavior. F270 retires AMAW and its complexity-driven directive. SA remains solo; AMA is the single adaptive multi-Agent mode and activates Workflow only from explicit Workflow intent. See [docs/features/v0.7.59.md](docs/features/v0.7.59.md) and [docs/features/v0.7.72.md](docs/features/v0.7.72.md).

**Progressive Disclosure on the Managed Tool Path (FEATURE_250, v0.7.60; current policy corrected in v0.7.74)**: the deferred-tool mechanism applies to the managed AMA path as well as SA. The current deferred set contains exactly 11 tools: six repo-intelligence tools, four web/code discovery tools, and `run_workflow`. Their `input_schema` remains directly callable while `tool_search` provides the full description on demand. The five fixed `mcp_*` facades and the `get_goal` / `create_goal` / `update_goal` lifecycle tools stay resident with their complete contracts. The v0.7.74 goal correction adds only about 109 estimated schema tokens versus the former hints (`get_goal` is actually 12 tokens smaller when resident), removes a discovery round trip, and changes no tool schema, handler, permission, goal state, or compaction-protection behavior. See [docs/features/v0.7.60.md](docs/features/v0.7.60.md) and [docs/features/v0.7.74.md](docs/features/v0.7.74.md#feature_250-v0774-correction-resident-goal-lifecycle-tools).

**Context-Efficient Tool Results + Workflow Quality Preflight (FEATURE_251 + FEATURE_252, v0.7.61; corrected 2026-07-14)**: local tools collect complete output and apply only contract-equivalent normalization that is strictly shorter; command-specific lossy Bash filters are off by default, and compound Bash uses no semantic adapter. One owner evaluates the complete parallel-result batch against the final provider request: it solves the largest final input `Pmax` for which `Pmax + output reserve + max(2048, 3% of Pmax) <= context window`, then admits only the remaining physical capacity. Results stay verbatim whenever they fit; only real overflow persists the complete value and emits `KODAX_RESULT_INCOMPLETE`. History keeps the same physical-capacity safety rule: no default lossy microcompaction below capacity, summary-first at pressure, and typed failure without silent deletion when a recoverable request cannot be formed. FEATURE_272 supersedes FEATURE_251 only for the default major-compaction trigger. FEATURE_252's deterministic pre-start workflow contract lint is unchanged. See [docs/features/v0.7.61.md](docs/features/v0.7.61.md) and [docs/ADR.md ADR-050](docs/ADR.md).

**Reliable Always-On Context Compaction (FEATURE_272, v0.7.74)**: automatic major compaction cannot be disabled. Its percentage trigger defaults to 75% and clamps to 15-90%; optional `triggerTokens` is inactive when omitted/zero, otherwise the smaller percentage, absolute, and physical-capacity threshold wins. The protected raw tail is 20% of that effective trigger. One transaction summarizes the complete eligible prefix, preserves every genuine user request through an exact ledger, and emits success only after a physically valid token reduction and awaited durable commit. Before raw bodies are evicted, the Session owner durably flushes their exact lineage; stable entry IDs merge the sidecar and slim Session without duplicates. Root and persistent child Agents can recover omitted user/assistant/tool details through bounded `session_history_search` → `session_history_read`, with children isolated to hidden worker Sessions and never granted root-history access. SDK/Runtime clients use revision-bound `transcriptSearch`, pages, and lossless chunks. Hidden reasoning, system instructions, and synthetic checkpoints are excluded from model search. See [the feature design](docs/features/v0.7.74.md), [SDK guide §25](public_docs/sdk/embedder-guide.md#25-always-on-context-compaction-and-bounded-transcript-recovery-v0774), and [ADR-057](docs/ADR.md#adr-057-large-compaction-is-an-always-on-context-scoped-full-coverage-transaction).

**Mailbox-Driven Agent Coordination (FEATURE_273, v0.7.74)**: `wait_agent` is now a true model-facing mailbox yield with one bounded `timeout_ms`, not an Actor progress/event reader. It wakes for scoped Agent messages or completions, root user input, interruption, or timeout; progress remains available to UI/SDK snapshot, replay, and long-poll consumers without resampling the parent model. The tool returns only a wake acknowledgement, while authenticated Agent evidence and structured task metadata enter the next safe model boundary once. Unacknowledged root completions survive a hard restart, same-process Runtime rebuilds deduplicate by child turn ID, and acknowledged or legacy historical completions are not replayed. Use `list_agents` for tree state and `agent_output` for a targeted known result. See [the feature design](docs/features/v0.7.74.md#feature_273-mailbox-driven-agent-wait-and-telemetrycontrol-separation), [SDK guide §26](public_docs/sdk/embedder-guide.md#26-agent-mailbox-control-versus-sdk-event-telemetry-v0774), and [ADR-058](docs/ADR.md#adr-058-model-agent-wait-is-mailbox-control-not-event-telemetry).

**Active-Run Interrupt Input (v0.7.74)**: embedded Runtime and the shared daemon advertise `interruptInput:1`. `runtime.runs.submitInput()` queues an immutable, ordered input for the current active Actor Run; all inputs admitted before one safe Runner boundary are delivered FIFO as separate user messages in the next LLM request, without creating continuation Runs. Queued/delivered state is visible in typed Run snapshots/events, delivery is acknowledged against the exact consumed IDs, and terminal cleanup prevents undelivered input from leaking into later Runs.

**External Agent SDK Plane (FEATURE_258, v0.7.67)**: `/agent` exports the protocol-neutral executor, registration, policy, credential-broker, artifact-policy, catalog, and durable task contracts. `/runtime` exposes the installed plane through `admin.agentRegistrations`, `agents`, and `agentTasks`, with the same DTO service methods over embedded and daemon clients. Executor factories are host functions: install them in an inline owner or while creating a new in-process daemon owner; they cannot be injected through an existing daemon connection or across a Runtime Worker boundary. Plane shutdown is terminal: pending waits and all later service calls reject. Restricted Workflow scripts preserve validated `phase` and external `target` routing. See the [complete owner/consumer recipes and safety contract](public_docs/sdk/embedder-guide.md#18-external-agent-executor-plane-feature_258-v0767).

**Cost-Disciplined Workflow SDK (FEATURE_259, v0.7.67)**: SDK callers configure run-scoped `modelTiers` and `workflow.maxConcurrency`, while workflow authors express semantic `fast` / `balanced` / `deep` intent. Terminal workflow events expose resolved tier/source/fallback/usage/duration facts, and each durable `run.json` contains an `efficiencyReport` with token coverage, role/tier starts, packet-read topology, review waves, and quality-gate outcomes. See the [routing and telemetry contract](public_docs/sdk/embedder-guide.md#20-cost-disciplined-workflow-routing-and-telemetry-feature_259-v0767).

**Paged Session Listing (FEATURE_261, v0.7.67)**: both `/session` `listSessions()` and `runtime.sessions.list()` accept an exact `surface` filter and opaque continuation `cursor`; each returned summary carries the cursor for the next page. Filtering happens before the page limit, so a host does not need to over-fetch mixed surfaces. See the [pagination recipes](public_docs/sdk/embedder-guide.md#19-session-surface-filtering-and-cursor-pagination-feature_261-v0767).

**Experimental Memory Agent SDK (FEATURE_260 + FEATURE_292)**: `/experimental-memory` exposes the source-compatible `MemoryAgent`/`MemorySession` lifecycle plus the additive `MemoryManagementAgent` facade when `createMemoryAgent()` receives a `MemoryManagementController`. That facade provides governed `list()`, `remember()`, and `forget()` through the same plane used by the conversation-first product surface. Passive recall is zero-wait; `query()` is read-only and deliberate; recalled content stays low-authority, and safety/scope gates remain deterministic. See the [direct session and boundary guide](public_docs/sdk/embedder-guide.md#21-experimental-governed-memory--experimental-memory-feature_260--feature_275--feature_292-v0768v0785).

**Bidirectional A2A 1.0 (FEATURE_267, v0.7.69)**: `/a2a` discovers allowed Agent Cards and installs a JSON-RPC/SSE executor through the existing F258 plane. Configured outbound Agents are also registered automatically as `external:<name>` in embedded CLI and user-daemon Runtimes, so the main Agent can orchestrate them without host code. One `a2a.json` may hold many outbound registrations and at most one inbound server, which publishes either the Runtime default or one validated `~/.kodax/agents/*.md` Agent behind an authenticated Runtime facade. The built-in listener is loopback-only and will not return a port blocked by Fetch-compatible clients; public deployment uses `handle()` behind host-owned TLS and authorization. A2A 0.3, gRPC, HTTP+JSON, push notifications, and automatic public exposure are not advertised. See the [client/server recipes and security boundaries](public_docs/sdk/embedder-guide.md#22-bidirectional-a2a-10--a2a-feature_267-v0769).

**A2A interoperability and authentication hardening** keeps a discovered
interface on the trusted Agent Card origin and sends credentials only when one
complete Card/Skill security requirement is satisfiable. The no-code client
supports HTTP Bearer compatibility and OAuth 2.0 Client Credentials; for OAuth,
an external Authorization Server issues short-lived access tokens and KodaX
caches them only in memory. Inbound `a2a serve` can validate RFC 9068 JWT access
tokens from an external issuer/JWKS, but never signs or issues production
tokens itself. It resolves its provider from CLI, then environment, config, and
the built-in default; a Markdown Agent can pin its own provider. Input
continuation resumes the original Runtime run, task history and retention are
bounded with stable cursor pagination, and authenticated SSE is correlated
before falling back to polling after an early normal EOF. Only direct remote
artifacts, broker-staged outputs, and outputs from a successfully admitted
Skill script can be published; ordinary workspace writes and local paths stay
private.

This authentication and per-Agent activation hardening is a post-release
closure of the v0.7.69 F267/F268 design and ships in the v0.7.71 patch; it is
not a claim that older v0.7.69 binaries contained the
later OAuth profiles.

**v0.7.70 MCP discovery hardening** uses exact capability IDs and revisioned
cursors while admitting results against real physical capacity. Compact CJK
queries are segmented, and a cross-language lexical zero match either returns a
lossless bounded grouped inventory or one concise retry in the catalog language.
Partial provider failure remains explicit rather than disappearing into an
apparently complete result.

The complete built-in path is available without writing TypeScript:

```bash
# Call another A2A Agent
kodax a2a add research https://agent.example/.well-known/agent-card.json --effect read
kodax a2a test research
kodax a2a call research "Summarize this topic"

# Explicitly authorize a private plaintext endpoint (prefer HTTPS when available)
kodax a2a add intranet http://10.20.30.40/.well-known/agent-card.json \
  --allow-private --allow-insecure-http --effect read

# Stage an OAuth-protected Agent, then hot-activate/deactivate it
export RESEARCH_A2A_CLIENT_SECRET='provisioned-by-your-authorization-server'
# PowerShell: $env:RESEARCH_A2A_CLIENT_SECRET='provisioned-by-your-authorization-server'
# PowerShell: run the command on one line or replace each trailing \ with a backtick.
kodax a2a add reviewer https://reviewer.example/.well-known/agent-card.json \
  --disabled --effect read --oauth-scheme enterprise-oauth \
  --oauth-issuer https://identity.example/ \
  --oauth-token-url https://identity.example/oauth/token \
  --oauth-client-id kodax-reviewer \
  --oauth-client-secret-env RESEARCH_A2A_CLIENT_SECRET \
  --oauth-scope a2a.invoke --oauth-resource https://reviewer.example/
kodax a2a enable reviewer
kodax a2a disable reviewer       # blocks new dispatch; does not cancel in-flight tasks

# Expose the Runtime default Agent, or pass a name from ~/.kodax/agents/*.md
export KODAX_A2A_TOKEN='replace-with-a-long-random-token'
# PowerShell: $env:KODAX_A2A_TOKEN='replace-with-a-long-random-token'
kodax a2a expose                 # or: kodax a2a expose document-agent
kodax a2a serve                  # loopback http://127.0.0.1:8765
```

MCP, A2A, and Extension declarations live in one user file per domain under
`~/.kodax/integrations/`. Use `kodax config paths`,
`kodax config template <core|mcp|a2a|extensions>`,
`kodax integrations migrate --apply`, and the `kodax mcp`, `kodax a2a`, or
`kodax extensions` commands to manage them. Migration imports only legacy
`config.json#mcpServers` and `config.json#extensions`; A2A has no legacy source.
It never overwrites an existing destination. The first MCP/Extension mutation
can stage legacy entries. Remove legacy keys only with
`--apply --cleanup-legacy`, after reviewing destination files and
literal-secret warnings. Running
CLI/daemon hosts retain the
last valid revision, atomically replace the complete MCP provider, reconcile
Extensions per entry, and hot-register outbound A2A Agents. Each A2A entry has
a desired `enabled` switch; `kodax a2a list` shows configuration, while the
owning Runtime is authoritative for live applied registrations. Disabled
entries are not fetched during automatic reconciliation and, after the owning
Runtime applies the revision, cannot accept new dispatch. The mutation command
itself is not cross-process acknowledgement. `a2a add --disabled` still checks
the Card by default unless `--no-test` is supplied, while `a2a test` performs
discovery/security planning without requesting an OAuth token. The fixed
`KODAX_A2A_TOKEN` example is an operator-provisioned compatibility credential;
KodaX does not generate or issue it. Disabled entries remain available for
later re-enable. Private-address access and non-loopback plaintext HTTP are
independent, persisted, default-deny permissions (`--allow-private` and
`--allow-insecure-http`); exact loopback HTTP remains available without either.
OAuth token endpoints retain their stricter HTTPS-or-exact-loopback rule.
Worker-hosted SDK Runtimes can load this same configured plane inside the Worker
owner with `worker: { configuredA2A: true }`. The CLI honors the same opt-in
from `~/.kodax/config.json` (`"worker": { "configuredA2A": true }`) by creating
a Worker-hosted embedded Runtime that loads the configured A2A plane. `a2a serve` loads
its configured MCP/Extension capability surface before listening and pins that
execution authority; it hot-reloads publication, authentication, and limits.

A2A configuration migration and retained task ownership are separate. If a
v0.7.70 task store must remain addressable after the realm-aware upgrade, stop
the A2A server, run `kodax a2a migrate-tasks` to inspect the exact-owner plan,
then apply it with `--apply --confirm-server-stopped`. OAuth migration also
requires the known historical `--subject`; normal serving never guesses or
dual-reads a legacy owner key.

Agent, Skill, Extension-tool authority, workspace, tool-policy, or task-store
changes require an explicit server restart. Managed
A2A contexts default to `~/kodax_a2a_server_workspace/<runtime-profile>/contexts/`.
Exact Skill scripts require the opt-in isolated policy and a passing
`kodax sandbox doctor` (`kodax sandbox setup` performs the explicit Windows
provisioning or v2 account-SID cutover).

---

## Features

- **Modular Architecture** - Use as CLI, as a library, or as a Node-free single binary
- **16 Built-in Provider Aliases** - Anthropic, OpenAI, DeepSeek, Kimi, Kimi Code, Qwen, Qwen Token Plan, Zhipu, Zhipu Coding, Zai Coding, MiniMax Coding, MiMo Coding, MiMo, Ark Coding, Gemini CLI, Codex CLI - plus user-defined OpenAI/Anthropic-compatible providers
- **Dynamic Workflows + SDK Process Surface** - Generate/reuse capability-routed workflows, observe live progress through `WorkflowProcessSnapshot`, and control workflow lifecycle from SDK hosts without parsing REPL output
- **V2 Worker single-loop + Sidecar Verifier (default)** - Single-agent main loop with an out-of-band Sidecar Verifier as Stop-hook (claudecode-shape; FEATURE_184 v0.7.42, ADR-030). Verifier returns accept/revise/blocked verdict on Worker text-only termination. The pre-v0.7.43 V1 chain is retired, `emit_handoff` is deleted, accept-verdict UI silently passes through, and content-aware gating skips trivial-chat sidecar calls. Adaptive child steering uses the canonical Actor collaboration tools with idle-yield waiting; specialist routing uses `spawn_agent(agent_id=...)`.
- **Reasoning Effort** - Effort-first control (`off/auto/low/medium/high` plus model-supported extras) across providers
- **Streaming Output** - Real-time response display
- **Session Management** - JSONL format with branchable session lineage tree
- **Skills System** - Natural language triggering, extensible, role-projected in AMA
- **Repo Intelligence** - Built-in full/light repository intelligence with native KodaX auto-injection lane
- **Rich Tool Surface** - 50+ built-in tools across file ops, shell, search, repo intelligence, MCP capabilities, git worktree, and agent control
- **Permission Control** - 4 profiles with sandbox-first routing and Exec Policy
- **Standalone Binary** - `bun --compile` releases for Win/macOS/Linux x64+arm64, no Node.js required on target machines
- **Cross-Platform** - Windows/macOS/Linux
- **TypeScript Native** - Full type safety and IDE support

---

## Installation

### As CLI Tool

```bash
# Clone repository
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# Install dependencies (includes workspace packages)
npm install

# Build the monorepo
npm run build

# Link globally (development mode)
npm link

# Now you can use 'kodax' anywhere
kodax "your task"
```

### As Standalone Binary (no Node required on target)

KodaX can be packaged into a single executable + a small `builtin/` sidecar directory using `bun --compile`. The target machine does **not** need Node.js or any other runtime.

Supported targets: `win-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`. Win7 / pre-glibc-2.27 distros / LoongArch are not supported.

**Build locally**:

```bash
# Install Bun once on your build machine
npm i -g bun                  # or scoop/brew/curl install — see docs/release.md

npm run build:binary          # Current host platform (fastest)
npm run build:binary:all      # All five targets in sequence
node scripts/build-binary.mjs --target=linux-arm64   # Specific target
```

Output lives under `dist/binary/<target>/`:

```
dist/binary/linux-x64/
├── kodax                          # ~60 MB Bun-compiled executable
├── builtin/                       # Sidecar built-in skills
├── provider-capabilities.json
├── semantic-worker.js             # Repo-intelligence Worker
├── runtime-worker.js              # SDK Runtime Worker
└── constructed-handler-worker.js  # Constructed-tool Worker
```

Smoke-test: `dist/binary/<host>/kodax --version`.

**Automated release**: pushing a `v*` git tag triggers `.github/workflows/release.yml`, which builds all five targets on native runners, runs smoke tests, and publishes a GitHub Release with archives + SHA256SUMS. Use the `workflow_dispatch` button in the Actions UI to test the pipeline without tagging.

See [docs/release.md](docs/release.md) for full details on build flags, archive layout, troubleshooting, and the build-time `KODAX_BUNDLED` / `KODAX_VERSION` defines.

### As Library

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runKodaX } from '@kodax-ai/kodax';

process.env.ZHIPU_API_KEY = process.env.ZHIPU_API_KEY ?? 'your_api_key';

const result = await runKodaX({
  provider: 'zhipu-coding',
  effort: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
    onComplete: () => console.log('\nDone!'),
  },
}, 'your task');

console.log(result.lastText);
```

#### SDK Subpath Imports (v0.7.39+)

For smaller surface and tree-shake-friendly imports, the SDK is also exposed via subpath exports — pick only the package(s) you need:

```typescript
import { Runner } from '@kodax-ai/kodax/agent';                // agent runtime
import { getProvider } from '@kodax-ai/kodax/llm';              // LLM abstraction (16 aliases)
import { runKodaX } from '@kodax-ai/kodax/coding';              // coding tools + prompts
import { createImageArtifactFromPath } from '@kodax-ai/kodax/media'; // input artifacts
import { SkillRegistry } from '@kodax-ai/kodax/skills';         // zero-dep skill loader
import { loadConfig } from '@kodax-ai/kodax/repl';              // REPL config / session helpers
import { createMcpManager } from '@kodax-ai/kodax/mcp';         // MCP popout manager (v0.7.42)
import { listSessions } from '@kodax-ai/kodax/session';         // session history helpers
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';   // embedded/daemon runtime API
import { runKodaXSandboxed } from '@kodax-ai/kodax/sandbox';    // standalone ASRT containment
import { createKodaXA2AServer } from '@kodax-ai/kodax/a2a';    // A2A 1.0 client/server edge
import { createMemoryAgent } from '@kodax-ai/kodax/experimental-memory'; // opt-in memory SDK
```

All 13 SDK entries (root + 12 subpaths) share internal code via ESM chunk splitting — importing from `/agent` does not pull in `/repl`'s Ink + React surface.

For the complete host-facing contract — including embedded/Worker/daemon ownership,
external-agent registration and task control, session cursor pagination, workflow
model-tier routing, and efficiency telemetry — see the
[SDK Embedder Integration Guide](public_docs/sdk/embedder-guide.md).

> **ESM-only.** The SDK is published as ES Modules. In a CommonJS context (Electron main process, legacy Webpack CJS bundles, `require()`-based code) you must use `await import(...)` instead of `require()`. See [public_docs/sdk/embedder-guide.md §5](public_docs/sdk/embedder-guide.md#5-consuming-from-a-commonjs-context-electron-main-cjs-bundles) for the canonical recipe + the technical reason most subpaths cannot ship a dual ESM/CJS build.

For CLI users, provider defaults live in `~/.kodax/config.json`. For library users, API keys are still read from environment variables; if you need custom base URLs or provider aliases, use `registerCustomProviders()` as shown above.

---

## Usage

### REPL Quickstart

Running `kodax` with no prompt starts the interactive REPL.

```bash
kodax
```

Inside the REPL you can type normal requests or slash commands:

```text
Read package.json and summarize the architecture
/model
/mode
/help
```

### CLI Quickstart

```bash
# Set API key
export ZHIPU_API_KEY=your_api_key

# Basic usage
kodax "Help me create a TypeScript project"

# Choose a provider explicitly
kodax --provider openai --model gpt-5.4 "Create a REST API"

# Use higher reasoning effort
kodax --effort high "Review this architecture"
```

### Session Workflows

Use a session when you want memory across turns. Without a session, each CLI call is independent.

```bash
# No memory: two separate calls
kodax "Read src/auth.ts"
kodax "Summarize it"

# With memory: same session
kodax --session my-project "Read package.json"
kodax --session my-project "Summarize it"
kodax --session my-project "How should I fix the first issue?"

# Session management
kodax -r                    # Search, page, and select a non-empty session
kodax -r <session-id>       # Resume a known session directly
kodax -r "Review runtime"   # Resume a unique exact title; duplicates open the picker
kodax --session list        # List up to 50 non-empty sessions
kodax --session cleanup-acp # Preview strictly matched empty ACP-test pollution
```

Bare `-r` opens an interactive picker with incremental search, arrow/PageUp/PageDown
navigation, Tab completion, full selected-session ID display, and Enter-to-resume.
An explicit value checks the complete session ID first, then an exact
case-insensitive title; duplicate titles open a narrowed picker instead of
silently choosing one. The picker loads before the full CLI, so session listing
remains responsive. After selection it hands terminal input to the resumed
REPL; Esc releases the picker's stdin ownership and immediately returns to the
invoking shell. Session replay preserves each recorded message/event timestamp.

Cleanup is preview-only unless
`--apply-session-cleanup` is also provided; matching sessions are archived rather
than permanently deleted.

### Session Patterns

```bash
# ❌ No memory: two independent calls
kodax "Read src/auth.ts"           # Agent reads and responds
kodax "Summarize it"               # Agent doesn't know what to summarize

# ✅ With memory: same session
kodax --session auth-review "Read src/auth.ts"
kodax --session auth-review "Summarize it"        # Agent knows to summarize auth.ts
kodax --session auth-review "How to fix first issue"  # Agent has context
```

### Workflow Examples

```bash
# Code review (multi-turn conversation)
kodax --session review "Review src/ directory"
kodax --session review "Focus on security issues"
kodax --session review "Give me fix suggestions"

# Project development (continuous session)
kodax --session todo-app "Create a Todo application"
kodax --session todo-app "Add delete functionality"
kodax --session todo-app "Write tests"
```

### CLI Reference

```text
kodax                    Start the interactive REPL
-h, --help [topic]   Show help or topic help
-p, --print <text>   Run a single task and exit
-c, --continue       Continue the most recent non-empty conversation in this directory
-r, --resume [value] Resume by ID/exact title, or open the searchable picker
-m, --provider       Provider to use
--model <name>       Override the model
--reasoning <mode>   off | auto | quick | balanced | deep
-t, --thinking       Compatibility alias for --reasoning auto
-s, --session <op>   Session ID or legacy session operation
-j, --parallel       Enable parallel tool execution
--max-iter <n>       Max iterations
```

### Permission Control

KodaX provides 4 permission profiles:

| Mode | Description | Tools Need Confirmation |
|------|-------------|------------------------|
| `plan` | Read-only planning mode | All modification tools blocked |
| `accept-edits` | Sandbox-first edits; user decides an exact host boundary | Host-boundary operations |
| `auto` | Sandbox-first execution; LLM reviews an exact host boundary | No automatic prompt; denied calls return a safer-route reason |
| `full-access` | Direct host execution without sandbox or Auto review | Explicit Exec Policy `prompt` only |

```bash
# In REPL, use /mode command
/mode plan          # Switch to plan mode (read-only)
/mode accept-edits  # Switch to accept-edits mode
/mode auto             # Switch to Runtime-owned Auto Mode
/mode full-access      # Direct host execution, still subject to Exec Policy
/auto                  # Alias for auto

# Check current mode
/mode
```

**Features:**
- In `accept-edits` mode, choosing "always" can persist safe Bash allow-patterns
- Plan mode includes system prompt context for LLM awareness
- Sandboxed broad reads, including Agent Home and credential locations, finish
  silently; only a proven pre-start host boundary reaches Auto[LLM]/approval
  review
- Pattern-based permission: Allow specific Bash commands (e.g., `Bash(npm install)`)
- Unified diff display for write/edit operations
- Edits and Auto first attempt the OS sandbox. Sandbox completion is final;
  only proven pre-start refusal/unavailability reaches Exec Policy and then the
  user or Auto reviewer. Target-started/uncertain calls are never replayed.
- Shift-Tab cycles `Plan -> Edits -> Auto[LLM] -> Full Access`; Shift+Enter
  inserts a newline. Legacy `auto-in-project` and Auto[RULES] state normalize
  to Auto[LLM] and are never persisted again.
- Full Access skips sandbox and reviewer, but administrator forbids and the
  narrow critical-effect fallback remain enforced. Use
  `kodax execpolicy check -- <command>` to inspect host policy without running it.
- Runtime-backed prompts can offer exact `allow once`, `allow this session`,
  and `always allow` choices. Return the Runtime-issued opaque suggestion;
  never derive or widen a permission rule from the displayed command or path.
  Persistent grants are daemon-owned, revisioned, and can be listed/revoked
  through `runtime.permissions` by an authorized SDK host. Dynamic shell
  commands deliberately receive no persistent-grant suggestion.

`kodax -c` skips zero-message ACP/bootstrap placeholders even when they are
newer than the last real conversation. The same newest non-empty rule applies
to Ink, classic, one-shot CLI, and coding-runtime auto-resume; an explicit
session ID always wins. Interactive resume also restores the saved workspace
runtime before relative shell commands or the next model turn.

### CLI Help Topics

Get detailed help for specific topics:

```bash
# Basic help
kodax -h
kodax --help

# Detailed topic help
kodax -h sessions      # Session management details
kodax -h init          # Long-running project initialization
kodax -h project       # Project mode / harness workflow
kodax -h auto          # Auto-continue mode
kodax -h provider      # LLM provider configuration
kodax -h thinking      # Thinking/reasoning effort and compatibility modes
kodax -h team          # Multi-agent parallel execution
kodax -h print         # Print configuration
```

### Environment Variables

KodaX recognizes a number of environment variables for tuning runtime behavior. The most commonly used ones are listed below; for the full list, search the repo for `process.env.KODAX_`.

#### `KODAX_MAX_OUTPUT_TOKENS`

Overrides the per-turn `max_tokens` value sent to **every** provider (Anthropic, OpenAI, Zhipu, Kimi, MiniMax, Qwen, DeepSeek, MiMo, Gemini, Codex, …). Set to a positive integer; unset or non-numeric values are ignored. This is an **explicit user intent**: when set, it wins over the provider's model descriptor cap, over the provider config default, and over the global `KODAX_MAX_TOKENS` fallback. RST defense is handled at the provider config layer (`streamMaxDurationMs` watchdog + non-streaming fallback in `packages/llm/src/providers/registry.ts`), so this variable is purely an output-budget knob.

```bash
# Allow up to 48K output tokens per turn (use a higher cap when generating long files)
export KODAX_MAX_OUTPUT_TOKENS=48000
kodax "generate the full implementation"

# Unset to restore default behavior
unset KODAX_MAX_OUTPUT_TOKENS
```

Precedence used by every provider's `getEffectiveMaxOutputTokens()` (see `packages/llm/src/providers/base.ts`):

1. One-shot per-request override (agent-loop escalation / context-overflow recovery — internal)
2. **`KODAX_MAX_OUTPUT_TOKENS`** (this variable, explicit user intent)
3. Active model descriptor's `maxOutputTokens` (FEATURE_098 per-model cap)
4. Provider config default
5. Global `KODAX_MAX_TOKENS` fallback

Related variables: `KODAX_MAX_TOKENS` (global fallback when no provider/model cap applies), `KODAX_ESCALATED_MAX_OUTPUT_TOKENS` (escalation budget used by the agent loop when a turn returns `stop_reason: max_tokens`).

> **Retired in v0.7.42**: `KODAX_RST_PRONE_PROVIDERS` and `KODAX_WRITE_TURN_MAX_TOKENS` (the v0.7.28 P2b write-turn cap mechanism) are no longer recognized. The 2026-04 bench measured RST as time-based (zhipu-coding 308s server kill window), not payload-size-based, so the cap was retired in favor of the per-provider `streamMaxDurationMs` watchdog + non-streaming fallback chain (configured in `registry.ts`). Existing env exports become silent no-ops; remove them from shell profiles when convenient.

#### Sidecar verifier diagnostics

Use these when diagnosing Worker text-only completion stalls or custom provider verifier behavior:

```bash
export KODAX_VERIFIER_LOG=1
export KODAX_VERIFIER_PROVIDER=anthropic
export KODAX_VERIFIER_MODEL=claude-haiku-4-5-20251001
```

- `KODAX_VERIFIER_LOG=1` shows verifier gate/elapsed/trace information and is equivalent to `"verifierLog": true` in `~/.kodax/config.json`.
- `KODAX_VERIFIER_PROVIDER` + `KODAX_VERIFIER_MODEL` route the verifier to a separate provider/model instead of inheriting the main Worker model. Set both together.
- `KODAX_VERIFIER_ALWAYS=1` forces the verifier to fire on every text-only completion for debugging/regression sweeps.

SDK/headless hosts can observe actionable Sidecar Verifier messages via
`KodaXEvents.onSidecarMessage`; JSONL output emits the same payload as
`sidecar.message`. Only `revise` and `blocked` verdicts are surfaced; `accept`
stays silent.

## Advanced Library Usage

#### Simple Mode (runKodaX)

```typescript
import { runKodaX, KodaXEvents } from '@kodax-ai/kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text) => console.log(`Thinking delta: ${text.length} chars`),
  onToolResult: (result) => console.log(`Tool ${result.name}: ${result.content.slice(0, 100)}`),
  onSidecarMessage: (event) => console.log(`[sidecar:${event.verdict}] ${event.content}`),
  onComplete: () => console.log('\nDone!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  effort: 'auto',
  events,
}, 'What is 1+1?');

console.log(result.lastText);
```

#### Continuous Session (KodaXClient)

```typescript
import { KodaXClient } from '@kodax-ai/kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  effort: 'auto',
  events: {
    onTextDelta: (t) => process.stdout.write(t),
  },
});

// First message
await client.send('Read package.json');

// Continue same session
await client.send('Summarize it');

console.log(client.getSessionId());
```

#### Custom Session Storage

```typescript
import { runKodaX, KodaXSessionStorage, KodaXMessage } from '@kodax-ai/kodax';

class MyDatabaseStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }) {
    // Save to your database
  }
  async load(id: string) {
    // Load from your database
    return null;
  }
}

await runKodaX({
  provider: 'zhipu-coding',
  session: {
    id: 'my-session-123',
    storage: new MyDatabaseStorage(),
  },
  events: { ... },
}, 'task');
```

### Library Modes Comparison

| Feature | runKodaX | KodaXClient |
|---------|----------|-------------|
| **Message Memory** | ❌ No | ✅ Yes |
| **Call Style** | Function | Class instance |
| **Context** | Independent each time | Accumulates |
| **Use Case** | Single tasks, batch processing | Interactive dialogue, multi-step tasks |

---

## SDK Usage

KodaX ships as a single npm package `@kodax-ai/kodax` with 12 SDK subpath exports (ADR-024 v0.7.39 + ADR-032 v0.7.42 + ADR-038 v0.7.49 + v0.7.56 `/media` + v0.7.64 `/runtime` + v0.7.68 `/experimental-memory` + v0.7.69 `/a2a` + v0.7.78 `/sandbox`). Each subpath is tree-shake-friendly so consumers pull only what they need:

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runKodaX } from '@kodax-ai/kodax';                       // root: CLI helpers + runKodaX
import { Runner, runFanOut } from '@kodax-ai/kodax/agent';        // generic Agent framework
import { getProvider } from '@kodax-ai/kodax/llm';                // 16-alias LLM abstraction
import { KODAX_TOOLS } from '@kodax-ai/kodax/coding';             // tools + prompts + agent loop
import { createImageArtifactFromPath } from '@kodax-ai/kodax/media'; // input artifact helpers
import { runInkInteractiveMode } from '@kodax-ai/kodax/repl';     // Ink TUI entrypoint
import { SkillRegistry } from '@kodax-ai/kodax/skills';           // zero-dep skill loader
import { createMcpManager } from '@kodax-ai/kodax/mcp';           // MCP popout manager (v0.7.42)
import { listSessions } from '@kodax-ai/kodax/session';           // session history helpers
import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';     // embedded/daemon runtime API
import { runKodaXSandboxed } from '@kodax-ai/kodax/sandbox';      // explicit standalone containment
import { createKodaXA2AServer } from '@kodax-ai/kodax/a2a';      // A2A 1.0 client/server edge
import { createMemoryAgent } from '@kodax-ai/kodax/experimental-memory'; // opt-in experimental memory SDK
```

> The SDK is **ESM-only**. CommonJS consumers (Electron main / Webpack CJS / `require()` callers) must use `await import('@kodax-ai/kodax/...')` — see [public_docs/sdk/embedder-guide.md §5](public_docs/sdk/embedder-guide.md#5-consuming-from-a-commonjs-context-electron-main-cjs-bundles).

### `@kodax-ai/kodax/llm` — LLM Abstraction

16 built-in provider aliases (Anthropic, OpenAI, DeepSeek, Kimi, Kimi-Code, Qwen, Qwen-Token-Plan, Zhipu, Zhipu-Coding, Zai-Coding, MiniMax-Coding, MiMo, MiMo-Coding, Ark-Coding, Gemini-CLI, Codex-CLI) + custom provider registration.

```typescript
import { getProvider, KodaXBaseProvider } from '@kodax-ai/kodax/llm';

const provider = getProvider('anthropic');
const stream = await provider.streamCompletion(
  [{ role: 'user', content: 'Hello!' }],
  { onTextDelta: (text) => process.stdout.write(text) }
);

for await (const result of stream) {
  if (result.type === 'text') { /* … */ }
  else if (result.type === 'tool_use') { /* … */ }
}
```

**Key Features**: unified provider interface · streaming · reasoning effort (`off/auto/low/medium/high` plus model-supported extras) · per-provider retry + error handling · zero business-logic dependencies.

### `@kodax-ai/kodax/agent` — Agent Framework (standalone-consumable)

ADR-021 standalone-consumable: `@kodax-ai/agent` has **zero inbound `@kodax-ai/coding` dependency** — you can wire any tool surface on top of it.

```typescript
import {
  Runner,
  runFanOut,
  runWithIdleYield,
  createAgentActorController,
  generateSessionId,
  estimateTokens,
  DefaultSummaryCompaction,
} from '@kodax-ai/kodax/agent';

// Bounded-concurrency fan-out with abort + structured progress events (v0.7.39 FEATURE_120)
const result = await runFanOut({
  bundles: [{ id: 'a', task: 'audit-foo' }, { id: 'b', task: 'audit-bar' }],
  maxParallel: 4,
  run: async (bundle) => doWork(bundle),
});

// Runtime-owned Actor identity tree (inject an executor before starting Turns)
const actors = await createAgentActorController();
const tree = actors.list('/root');

// Pluggable compaction policy (FEATURE_081)
const policy = new DefaultSummaryCompaction({ thresholdRatio: 0.8, keepRecent: 10 });
```

`DefaultSummaryCompaction` is a standalone agent-layer primitive for custom
loops. It does not replace or disable KodaX's always-on coding-runtime policy
described under FEATURE_272 above.

**Key Features**: `Runner` + per-step lifecycle · `runFanOut` (bounded-concurrency + abort + progress events) · `runWithIdleYield` (chat-while-waiting) · `AgentActorController` / `AgentTurnScheduler` · session-id generation · provider-neutral O(n) token estimation · `CompactionPolicy` interface.

### `@kodax-ai/kodax/skills` — Skills System

Markdown-based skill files with natural-language triggers, explicit slash invocation, and variable resolution.

```typescript
import {
  SkillRegistry,
  type SkillContext,
} from '@kodax-ai/kodax/skills';

const registry = new SkillRegistry(process.cwd(), {
  projectPaths: ['/path/to/skills'],
});
await registry.discover();

const context: SkillContext = { workingDirectory: process.cwd() };
const modelCatalog = registry.getSystemPromptSnippet(); // Excludes model-disabled Skills.
const result = await registry.invoke('code-review', 'src/', context);
```

Every enabled Skill is explicitly user-invocable with `/<name>` or `/skill:<name>`, including when the token appears in the middle of a query; the remaining text is passed as Skill arguments. `disable-model-invocation: true` only removes the Skill from the model-visible catalog and blocks the model's `skill` tool path. It does not block explicit user or SDK `SkillRegistry.invoke()` calls. The legacy `user-invocable` field is retained for parsing compatibility but is not an execution permission.

Explicit invocation is expanded by the host and injected once as structured
`skillInvocation` context. Workflow and child Agents inherit that active Skill.
A slash reference authored only inside a model-generated child objective is a
new model invocation, so it must pass through the governed `skill` tool and
cannot elevate a `disable-model-invocation` Skill.

**Key Features**: markdown-based skill files · natural-language triggering for model-visible Skills · explicit slash invocation for every enabled Skill · variable resolution · built-in skills included.

### `@kodax-ai/kodax/coding` — Coding Agent

Complete coding agent: 50+ tools (`read`/`write`/`edit`/`bash`/`grep`/`glob` plus `spawn_agent`/`send_message`/`followup_task`/`wait_agent`/`interrupt_agent`/`list_agents`/`agent_output`) + Worker role prompt + Sidecar Verifier (out-of-band Stop-hook) + agent loop + auto-continue + session management.

```typescript
import { runKodaX, KodaXClient, KODAX_TOOLS } from '@kodax-ai/kodax/coding';

// Single-task helper
const result = await runKodaX({
  provider: 'zhipu-coding',
  effort: 'auto',
  events: { onTextDelta: (text) => process.stdout.write(text) },
}, 'Read package.json and explain the dependencies');

// Continuous session
const client = new KodaXClient({
  provider: 'anthropic',
  effort: 'auto',
  events: { /* … */ },
});
await client.send('Create a new file');
await client.send('Add a function to it'); // Has context from previous message
```

**Key Features**: 50+ built-in tools (see [Tools](#tools)) · V2 Worker single-loop + Sidecar Verifier (FEATURE_184 v0.7.42 / V1 chain fully retired by FEATURE_193 v0.7.43) · Runtime-owned Actor collaboration and safe-boundary steering (FEATURE_270, v0.7.72) · idle-yield waiting · specialist routing via `spawn_agent(agent_id=...)` · auto-continue · session lineage.

### `@kodax-ai/kodax/repl` — Interactive Terminal UI

Ink/React-based interactive REPL. Permission modes, command system, themed streaming display.

```typescript
import { runInkInteractiveMode } from '@kodax-ai/kodax/repl';

// Usually used via the `kodax` bin command; can be embedded:
// - Interactive terminal UI (Ink components)
// - Permission control (plan/accept-edits/auto/full-access profiles)
// - Command system (/help, /mode, /clear, /status, …)
// - Skills integration
// - Theme support
await runInkInteractiveMode({ provider: 'zhipu-coding', effort: 'auto' });
```

**Key Features**: Ink-based React components · 4 permission profiles · built-in commands · real-time streaming display · context-usage indicator.

### Package Dependency Graph (workspace internal)

```
@kodax-ai/llm    (zero business-logic deps)
    ↓
@kodax-ai/agent  (depends @kodax-ai/llm; ADR-021 standalone-consumable;
                  inlines session-lineage + capabilities/{mcp,skills} +
                  tracing per ADR-036 v0.7.43)
    ↓
@kodax-ai/coding (depends llm + agent; inlines repo-intelligence/protocol per ADR-036)
    ↓
@kodax-ai/repl   (depends coding + ink + react)
```

**Subpath Recommendations**:

| Use Case | Subpath | Why |
|----------|---------|-----|
| Only need LLM abstraction | `@kodax-ai/kodax/llm` | Minimal deps; 16 built-in aliases |
| Building custom agent | `@kodax-ai/kodax/agent` | Runner + fan-out + idle-yield + session-lineage + capabilities |
| Coding tasks | `@kodax-ai/kodax/coding` | Complete coding agent + tools |
| Terminal app | `@kodax-ai/kodax/repl` | Full interactive experience |
| Runtime host / daemon client | `@kodax-ai/kodax/runtime` | Sessions, runs, events, permissions, catalog, MCP, artifacts, diagnostics |
| Experimental governed memory | `@kodax-ai/kodax/experimental-memory` | Governed `MemoryAgent` list/remember/forget and scoped `MemorySession` recall/outcome contracts |

---

| Provider | Environment Variable | Reasoning Support | Default Model |
|----------|----------------------|-------------------|---------------|
| anthropic | `ANTHROPIC_API_KEY` | Native | claude-sonnet-4-6 (`claude-opus-4-6` / `claude-haiku-4-5` via `/model`) |
| openai | `OPENAI_API_KEY` | Native | gpt-5.3-codex (`gpt-5.4` / `gpt-5.3-codex-spark` via `/model`) |
| kimi | `KIMI_API_KEY` | Native | kimi-k2.7-code (262,144-token context; `kimi-k3` 1M / `kimi-k2.7-code-highspeed` / `kimi-k2.6` / `kimi-k2.5` via `/model`) |
| kimi-code | `KIMI_CODE_API_KEY` | Native | k3-256k (Moderato+, 256K, direct upstream ID; `k3` 1M / `kimi-for-coding` K2.7 Code / `kimi-for-coding-highspeed` via `/model`) |
| qwen | `QWEN_API_KEY` | Native | qwen3.5-plus |
| qwen-token-plan | `QWEN_TOKEN_API_KEY` | Native | qwen3.8-max (Anthropic-compat; legacy `qwen3.8-max-preview` plus `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-flash` / `glm-5.2` / `deepseek-v4-pro` via `/model`; all 1M context; image input on both Qwen 3.8 IDs / 3.7 Plus / 3.6 Flash) |
| zhipu | `ZHIPU_API_KEY` | Native | glm-5 (`glm-5.3` / `glm-5.2` 1M ctx, plus `glm-5.1` / `glm-5-turbo` via `/model`; GLM-5.3 is pre-registered while the public API remains marked upcoming) |
| zhipu-coding | `ZHIPU_CODING_API_KEY` | Native | glm-5.3 (1M ctx, 128K output; `glm-5.2` rollback plus `glm-5-turbo` / `glm-4.7` via `/model`; raw upstream IDs) |
| zai-coding | `ZAI_CODING_API_KEY` | Native | glm-5.3 (`glm-5.2` rollback; raw upstream IDs; switched from glm-5.2 default on 2026-08-15) |
| minimax-coding | `MINIMAX_CODING_API_KEY` | Native | MiniMax-M3 (Frontier Coding, native multimodal + 1M ctx; legacy `MiniMax-M2.7` / `MiniMax-M2.7-highspeed` remain selectable via `/model`) |
| mimo | `MIMO_API_KEY` | Native | mimo-v2.5-pro (Xiaomi MiMo pay-per-token, Anthropic-compat) |
| mimo-coding | `MIMO_CODING_API_KEY` | Native | mimo-v2.5-pro (Xiaomi Token Plan, Anthropic-compat) |
| ark-coding | `ARK_CODING_API_KEY` | Native | glm-5.3 (Volcengine Ark Coding Plan — GLM-5.3 (1M ctx, 128K out) · GLM-5.2 (alias: `glm-latest`) · Kimi K2.7 Code / K2.6 · MiniMax M3 / M2.7 · DeepSeek V4 Pro / V4 Flash · Doubao Seed 2.0 Code / Pro / Lite · Doubao Seed Code) |
| deepseek | `DEEPSEEK_API_KEY` | Native | deepseek-v4-flash (`deepseek-v4-pro` plus vision model `deepseek-v4-flash-vision-exp` with image input, via `/model`) |
| gemini-cli | Provider CLI authentication (no KodaX API-key variable) | Prompt-only / CLI bridge | (via gemini CLI) |
| codex-cli | Provider CLI authentication (no KodaX API-key variable) | Prompt-only / CLI bridge | (via codex CLI) |

> **Custom providers**: any OpenAI- or Anthropic-compatible endpoint can be added via `customProviders[]` in `~/.kodax/config.json` (CLI) or `registerCustomProviders()` (library). See the [Quick Start](#2-configure-a-provider) for the configuration shape.

### Examples

```bash
# Use Zhipu Coding
kodax --provider zhipu-coding --thinking "Help me optimize this code"

# Use OpenAI
export OPENAI_API_KEY=your_key
kodax --provider openai "Create a REST API"

# Resume last session
kodax --session resume

# List all sessions
kodax --session list

# Parallel tool execution
kodax --parallel "Read package.json and tsconfig.json"

# Adaptive multi-agent (AMA) mode — V2 Worker single-loop with Actor collaboration
kodax --agent-mode ama "Analyze code structure, check test coverage, find bugs"
```

---

## Tools

KodaX ships 50+ built-in tools, grouped below. They are registered as a single flat tool surface to the LLM; the categories here are just for navigation.

### File operations
| Tool | Description |
|------|-------------|
| `read` | Read file contents (supports offset/limit) |
| `write` | Write a new file or fully rewrite an existing one |
| `edit` | Exact string replacement (supports `replace_all`) |
| `multi_edit` | Atomic batch of independent edits to one file |
| `insert_after_anchor` | Insert content after a unique anchor without rewriting the file |
| `undo` | Revert the last file modification |

### Shell & search
| Tool | Description |
|------|-------------|
| `bash` | Execute a shell command (supports `run_in_background`; complete capture with recoverable capacity fallback) |
| `glob` | Find files by pattern |
| `grep` | Regex content search (context lines, multiline, file-type filter, pagination) |
| `code_search` | Lower-noise code search (extension-provider aware) |
| `semantic_lookup` | Symbol/module/process-aware search backed by repo intelligence |
| `web_search` | Discovery-oriented web search with trust + freshness signals |
| `web_fetch` | Fetch a specific URL with provenance hints |

### Repo Intelligence (working tools)
| Tool | Description |
|------|-------------|
| `repo_overview` | Summarize structure, key areas, entry hints, intelligence snapshot |
| `changed_scope` | Which files/areas/categories the current diff touches |
| `changed_diff` | Paged diff slice for a single file |
| `changed_diff_bundle` | Paged diff slices for multiple files in one call |
| `module_context` | Module capsule (deps, entries, symbols, tests, docs) |
| `symbol_context` | Definition + probable callers/callees + alternatives |
| `process_context` | Approximate static execution capsule for an entry |
| `impact_estimate` | Blast radius for a symbol/path/module |

### MCP capabilities (when MCP servers are configured)
| Tool | Description |
|------|-------------|
| `mcp_search` / `mcp_describe` / `mcp_call` | Discover and invoke MCP tools through the shared capability runtime |
| `mcp_read_resource` / `mcp_get_prompt` | Read MCP resources and prompts |

### Git worktree
| Tool | Description |
|------|-------------|
| `worktree_create` | Create a new worktree on an isolated branch for safe agent work |
| `worktree_remove` | Remove a worktree (with safety checks) |

### Agent control & UX
| Tool | Description |
|------|-------------|
| `spawn_agent` | Create a named child Actor and start its first Turn under inherited capabilities, session capacity, and root work budget. |
| `send_message` | Commit bounded information to an Actor mailbox without starting a new Turn. |
| `followup_task` | Join a running Actor at a safe boundary or atomically start a new Turn for an idle Actor. |
| `wait_agent` | Yield on scoped mailbox/user/interruption/timeout activity; returns a wake acknowledgement and never uses Actor progress as a model wake source. |
| `interrupt_agent` | Request interruption of an active Turn while preserving Actor identity. |
| `list_agents` | Inspect the caller-visible Actor subtree and Turn states. |
| `agent_output` | Read bounded durable output for an authorized Actor/Turn. |
| `ask_user_question` | Single/multi-select or free-text prompt back to the user |
| `exit_plan_mode` | Present a finalized plan only when the active REPL/host supplied an approval callback |
| `run_workflow` | Author and run a deterministic Workflow protocol in AMA only when Workflow intent is explicit; complexity alone never activates it. Child Agents share the Actor control plane. Async / idle-yield. (FEATURE_246; FEATURE_270 v0.7.72) |
| `emit_managed_protocol` | Internal managed-task protocol side-channel for role payloads (verdict). V2 Worker single-loop + Sidecar Verifier is the default since v0.7.42 (FEATURE_184); V1 chain retired in v0.7.43 (FEATURE_193). |

---

## Skills System

KodaX includes a built-in Skills system. Model-visible Skills can be triggered
by natural language; every enabled Skill can be invoked explicitly:

```bash
# Natural language triggering (no explicit /skill needed)
kodax "帮我审查代码"           # Triggers code-review skill
kodax "创建一个新的 KodaX Skill" # Triggers skill-creator

# Explicit skill commands (arguments may follow the token)
kodax /code-review src/
kodax /tdd packages/repl/src/
kodax /git-workflow commit
kodax "please use /skill:code-review src/"
```

Set `disable-model-invocation: true` for a Skill that must only be loaded after an explicit slash invocation. This keeps it out of natural-language model discovery without disabling `/<name>` or `/skill:<name>`.

Built-in skills include:
- **code-review** - Code review and quality analysis
- **tdd** - Test-driven development workflow
- **git-workflow** - Git commit and workflow automation

Skills are stored in `~/.kodax/skills/` and can be extended with custom skills.
F263 background learning is Memory-first: a single correction does not create
a Skill. Repeated independently verified evidence can create a low-risk,
immutable project-scoped testing revision for at most three exact-revision
uses. Promotion requires independently verified success. Use `/learn` to
inspect, disable, rollback, trust, or reject learned revisions. Protected or
formal Skills, user-global promotion, and Extension authoring remain explicit
user actions.

### Promote a learned Skill to the user catalog

Automatic canary activation and user-catalog promotion are different:

- independently verified canary success changes `testing` to
  `active_learned` inside the project-scoped Learned Area;
- `/learn promote` is an explicit ownership transfer that copies one exact
  reviewed `ready` or `active_learned` revision into the formal user Skill
  catalog and changes its lifecycle to `promoted_user`.

Inspect the revision first, then promote it by name, slug, or exact capability
ID:

```text
/learn show normalize-release-notes
/learn promote normalize-release-notes --scope user
```

`--scope user` is the only supported scope and may be omitted. Invalid scopes,
unknown options, duplicate scope options, and extra operands fail without
changing the catalog. Promotion writes to the configured KodaX user Skill
directory—normally `~/.kodax/skills/<slug>/SKILL.md`—and never overwrites
different formal Skill content.

Use `/learn promote --help`, `/learn help promote`, or
`/help learn promote` for the dedicated command reference. In the Ink Learning
Center, open `/learn`, select an `active_learned` Skill, and choose
**Promote to user catalog**.

---

## Commands (CLI)

Commands are `/xxx` shortcuts in CLI:

```bash
kodax /review src/auth.ts
kodax /test
```

Commands are stored in `~/.kodax/commands/`:
- `.md` files → Prompt commands (content used as prompt)
- `.ts/.js` files → Programmable commands

---

## API Exports

```typescript
// Main functions
export { runKodaX, KodaXClient };

// Types
export type {
  KodaXEvents, KodaXOptions, KodaXResult,
  KodaXMessage, KodaXContentBlock,
  KodaXSessionStorage, KodaXToolDefinition
};

// Tools
export { KODAX_TOOLS, KODAX_TOOL_REQUIRED_PARAMS, executeTool };

// Providers
export { getProvider, KODAX_PROVIDERS, KodaXBaseProvider };

// Utilities
export {
  estimateTokens,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal
};
```

---

## Development

```bash
# Development mode (using tsx)
npm run dev "your task"

# Build
npm run build

# Optional: only build workspace packages
npm run build:packages

# Build standalone binary (current platform / all platforms)
npm run build:binary
npm run build:binary:all

# Run tests
npm test

# Eval-driven development tests (provider matrices, identity round-trip, etc.)
npm run test:eval

# Clean
npm run clean
```

### Repo Intelligence cache directories

KodaX uses one repo-intelligence cache root with separate built-in engine profiles:

- `.agent/repo-intelligence/`
  - Full-engine repo-intelligence artifacts and existing task-engine snapshots.
- `.agent/repo-intelligence/light/`
  - Light-mode heuristic index artifacts.

They are intentionally separated so:

- full and light profiles can be rebuilt independently.
- light-mode confidence/capability state cannot be mistaken for full-engine state.
- future cache migrations can delete one profile without corrupting the other.

`.agent/repo-intelligence/` is local generated state and should not be committed.

---

## Code Style

### Comment Guidelines

KodaX uses an **English-first** comment style with selective Chinese brief notes for complex logic.

| Situation | Style | Example |
|-----------|-------|---------|
| Import/Export | English only | `// Import dependencies` |
| Simple constants | English only | `// Max retry count` |
| Simple logic | English only | `// Return if null` |
| **Business rules** | English + Chinese | `// Skip tool_result - 跳过工具结果块` |
| **Platform compatibility** | English + Chinese | `// Windows path handling - Windows 路径处理` |
| **Performance optimization** | English + Chinese | `// Debounce to prevent flicker - 防抖避免闪烁` |

---

## Documentation

- [README_CN.md](README_CN.md) - Chinese Documentation
- [public_docs/sdk/embedder-guide.md](public_docs/sdk/embedder-guide.md) - SDK hosting, shared Runtime daemon, Auto Mode, v0.7.74 compaction/history recovery, Agent telemetry, and active-run input contracts
- [docs/release.md](docs/release.md) - Standalone binary build & release pipeline
- [docs/PRD.md](docs/PRD.md) - Product Requirements
- [docs/ADR.md](docs/ADR.md) - Architecture Decisions
- [docs/HLD.md](docs/HLD.md) - High-Level Design
- [docs/DD.md](docs/DD.md) - Detailed Design
- [docs/FEATURE_LIST.md](docs/FEATURE_LIST.md) - Feature Tracking
- [docs/test-guides/](docs/test-guides/) - Feature-specific test guides
- [CHANGELOG.md](CHANGELOG.md) - Version History (v0.7.0+; [archive](docs/CHANGELOG_ARCHIVE.md) for older)

---

## License

[KodaX-AI Fair Core License (KAI-FCL) 1.0](LICENSE) - Copyright 2026 [icetomoyo](mailto:icetomoyo@gmail.com).

KAI-FCL is source-available / fair-core, not OSI open source. Commercial,
enterprise, managed deployment, paid service, or customer redistribution use
requires KodaX-AI authorization and a valid entitlement where required.

Official KodaX 0.7.70 and later distributions use KAI-FCL or accompanying
KodaX-AI customer terms. Historical tags, archives, binaries, npm packages, or
other copies already distributed with Apache-2.0 notices remain Apache-2.0 for
those specific copies.
