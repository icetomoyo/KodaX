# Installation

## Quick install (npm)

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
commands, and shortcuts. Interactive setup also checks the optional ASRT sandbox
once. A bare interactive Windows CLI startup checks the installed generation
before the REPL and uses the existing UAC setup boundary to self-heal stale
state; healthy upgrades preserve the sandbox SID and concurrent startups
converge on one setup. A current marker takes the fast path; when migration is
actually required, startup shows live elapsed time while the setup child runs.
Current state is otherwise silent. Print-mode, daemon, SDK, and
ordinary tool execution never activate setup automatically. macOS/Linux report
any required Seatbelt/bubblewrap dependencies. Declining or missing a dependency
does not break ordinary permission handling. Linux shell containment also requires a host policy that permits
unprivileged user namespaces; KodaX diagnoses but does not modify that policy.

## Single binary (no Node.js required)

Download a Bun-compiled single binary for Windows / macOS / Linux × x64 + arm64
from the [GitHub Releases](https://github.com/icetomoyo/KodaX/releases) page.
Drop one file, run anywhere — restricted envs, CI runners, air-gapped boxes.

## Build from source

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build
npm link
```

## Requirements

- **Node.js** >= 20.0.0 (for npm install / source build; not needed for single binary)
- **TypeScript** >= 5.7.0 (root uses 5.9.x; only needed for source build)
- An API key for any supported LLM provider

## Next steps

- [Quickstart](./quickstart.md) — Your first KodaX session
- [Providers & API keys](../configuration/providers.md) — All built-in providers
- [Custom providers](../configuration/custom-providers.md) — Point KodaX at any OpenAI/Anthropic-compatible endpoint
