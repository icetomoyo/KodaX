# What is KodaX?

**Source-available AI coding agent on every LLM you can reach.**

KodaX is an AI coding agent that works with 16+ LLM providers — including 6
China-native providers — through REPL, CLI, library, and single-binary forms.
It is built on a multi-agent runtime with 50+ built-in tools, branchable
session lineage, and an optional OS-level sandbox.

## Why KodaX

### 🇨🇳 6 China-native LLMs

Zhipu · Kimi · MiniMax · MiMo · Ark · Qwen

First-class adapters with cross-provider prompt-eval calibration on a canonical
5-alias panel — not OpenAI-compat shims.

### 📦 Single-file binary

Bun `--compile` · Win / macOS / Linux · x64 + arm64

No Node required on the target machine. Drop one file, run anywhere —
restricted envs, CI runners, air-gapped boxes.

### 🌳 Branchable session lineage

Fork · rewind · parallel edit

Conversation history is a DAG, not a list. Powers the upcoming KodaX Space
desktop app.

### 🤖 Multi-agent by default

V2 Worker single-loop + result review + async children

`spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`,
multi-instance auto-coordination with content-hash safety net.

### 🧩 Skills + self-construction

Markdown Skills, model-visible NL discovery, explicit slash invocation for
every enabled Skill

5-stage self-modification staircase (scaffold → validate → stage → test →
activate) gated by an 8-invariant admission contract.

### 🛠 50+ built-in tools

File · shell · search · MCP · ACP

Repo intelligence, semantic search, git worktree, web fetch — all addressable
through one clean tool surface.

## How KodaX compares

| Feature | **KodaX** | Claude Code | Aider | Codex CLI | Cursor | Cline |
|---|---|---|---|---|---|---|
| Source license | ⚠️ KAI-FCL, non-commercial | ❌ Source-available | ✅ Apache 2.0 | ✅ Apache 2.0 | ❌ Proprietary | ✅ Apache 2.0 |
| Node-free single binary | ✅ Bun | ❌ Node | ❌ Python | ✅ Rust | ❌ Electron | ❌ Extension |
| Native China providers | ✅ 6 native | ❌ | ⚠ via LiteLLM | ❌ OpenAI-first | ❌ no provider menu | ⚠ Kimi / Qwen / DeepSeek |
| Branchable session lineage | ✅ fork & rewind | ⚠ routines / sessions | ❌ | ❌ | ❌ | ⚠ checkpoints |
| Multi-agent + MCP + 50+ tools | ✅ all three | ✅ all three | ⚠ tools, no MCP | ✅ all three | ⚠ Composer + MCP | ✅ all three |

## Next steps

- [Installation](./installation.md) — Get KodaX running
- [Quickstart](./quickstart.md) — Your first session
- [Providers](../configuration/providers.md) — Configure an LLM provider
