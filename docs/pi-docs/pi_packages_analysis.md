# Pi-Mono Packages Analysis

## 1. `@mariozechner/pi-ai` (`packages/ai`)
This package provides a unified LLM API with automatic model discovery and provider configuration. It acts as a wrapper around various major AI providers, allowing the rest of the application to interact with language models through a consistent interface.

### Dependencies
- `@anthropic-ai/sdk`
- `@aws-sdk/client-bedrock-runtime`
- `@google/genai`
- `@mistralai/mistralai`
- `openai`
- `@sinclair/typebox`
- `zod-to-json-schema`
- `ajv`

### Directory Structure & Modules
- `src/index.ts`: Main entry point.
- `src/cli.ts`: Provides a CLI binary (`pi-ai`).
- `src/api-registry.ts`: Likely manages the registry of available AI providers/APIs.
- `src/models.ts` & `src/models.generated.ts`: Definitions and generated lists of supported models.
- `src/types.ts`: TypeScript type definitions for the API.
- `src/stream.ts`: Handles streaming responses from LLMs.
- `src/env-api-keys.ts`: Manages environment variables for API keys.
- **`src/providers/`**: Contains implementations for specific AI providers.
- **`src/providers/`**: Implementations for specific AI providers including:
  - Amazon Bedrock (`amazon-bedrock.ts`)
  - Anthropic (`anthropic.ts`)
  - Google (`google.ts`, `google-vertex.ts`, `google-gemini-cli.ts`, `google-shared.ts`)
  - OpenAI & Azure (`openai-completions.ts`, `openai-responses.ts`, `openai-codex-responses.ts`, `azure-openai-responses.ts`)
  - GitHub Copilot (`github-copilot-headers.ts`)
  - `register-builtins.ts`: Registers these providers to the API registry.
- **`src/utils/`**: Utility functions such as:
  - `event-stream.ts`: SSE stream parsing.
  - `http-proxy.ts`: HTTP proxy support.
  - `oauth/`: OAuth flows.
  - `json-parse.ts`, `validation.ts`, `typebox-helpers.ts`: Data validation and parsing.
  - `overflow.ts`, `sanitize-unicode.ts`.

## 2. `@mariozechner/pi-agent-core` (`packages/agent`)
This package provides a general-purpose agent with transport abstraction, state management, and attachment support. It builds on top of the `pi-ai` package.

### Dependencies
- `@mariozechner/pi-ai`

### Directory Structure & Modules
- `src/index.ts`: Main entry point.
- `src/agent.ts`: Core agent logic.
- `src/agent-loop.ts`: Manages the execution loop (think/act cycle) of the agent.
- `src/proxy.ts`: Proxy mechanisms for agent communication.
- `src/types.ts`: TypeScript type definitions.

## 3. `@mariozechner/pi-coding-agent` (`packages/coding-agent`)
This package provides the main coding agent CLI, featuring a suite of file manipulation and execution tools along with robust session management.

### Dependencies
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-tui`
- Extensively relies on utilities like `glob`, `ignore`, `minimatch`, `marked`, `diff`, and `chalk`.

### Directory Structure & Modules
- `src/cli.ts` & `src/main.ts`: CLI entry points and main execution setup.
- `src/index.ts`: Package export file.
- `src/config.ts`: Configuration loading and management.
- `src/migrations.ts`: For migrating older configurations or sessions.
- **`src/core/`**: Core logic including:
  - `agent-session.ts` & `session-manager.ts`: Handling chat and coding sessions.
  - `model-registry.ts` & `model-resolver.ts`: Resolving and managing AI models.
  - `package-manager.ts`: Interfacing with system package managers.
  - `skills.ts`: Loading and managing specialized agent capabilities (skills).
  - `bash-executor.ts` & `exec.ts`: Shell execution abstractions.
  - **`tools/`**: Built-in agent tools: `bash.ts`, `edit-diff.ts`, `edit.ts`, `find.ts`, `grep.ts`, `ls.ts`, `read.ts`, `write.ts`, `truncate.ts`.
- **`src/modes/`**: Operational modes:
  - `interactive/`: The interactive terminal user interface.
  - `print-mode.ts`: A streamlined, non-interactive mode.
  - `rpc/`: Remote procedure call mode capabilities.
- **`src/utils/`**: Helper functions and utilities.

## 4. `@mariozechner/pi-tui` (`packages/tui`)
This package provides a custom Terminal User Interface library featuring differential rendering. It's designed to build efficient text-based applications, supporting complex layouts and rich text in the CLI.

### Dependencies
- `chalk`: For styling text.
- `marked`: For parsing markdown into terminal-friendly outputs.
- `get-east-asian-width`: For accurate character width calculations in terminals.
- `koffi`: FFI library (likely used for native terminal interactions or clipboard).

### Directory Structure & Modules
- `src/tui.ts`: The core TUI application runner and engine.
- `src/terminal.ts`: Low-level terminal interactions.
- `src/keys.ts` & `src/keybindings.ts`: Extensive terminal key parsing and binding logic.
- `src/input.ts`: Handling complex terminal inputs.
- `src/editor.ts` & `src/editor-component.ts`: A structured terminal text editor component.
- `src/markdown.ts`: Rendering markdown streams directly in the terminal.
- **`src/components/`**: Structural UI components such as:
  - `box.ts`, `image.ts`, `select-list.ts`, `text.ts`, `loader.ts`
- `src/utils.ts`, `src/fuzzy.ts`, `src/kill-ring.ts`, `src/undo-stack.ts`: Utilities for text processing, fuzzy searching, and advanced text editing mechanics.

---
### Summary for Reproduction
To successfully reproduce the `pi` project, follow this architectural progression:
1. **Foundation (`@mariozechner/pi-ai`)**: Implement a unified LLM API wrapper to normalize inputs and outputs across various AI providers globally.
2. **Abstraction (`@mariozechner/pi-agent-core`)**: Build a generic agent execution loop, handling state management and abstraction of the "think/act" cycle.
3. **User Interface (`@mariozechner/pi-tui`)**: Develop a robust terminal UI framework capable of differential rendering, advanced key handling, and rendering custom structured components (like a markdown viewer or code editor).
4. **Integration (`@mariozechner/pi-coding-agent`)**: Integrate the previous packages by building a CLI that instantiates the agent, supplies it with filesystem/terminal execution tools, manages user sessions, and utilizes the TUI for interactive user engagements.
