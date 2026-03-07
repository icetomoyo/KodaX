# Contributing to KodaX

Thank you for your interest in contributing to KodaX!

## Development Environment Setup

### Prerequisites

- **Node.js** >= 18.0.0
- **npm** or **yarn**
- **TypeScript** 5.7+

### Installation

```bash
# Clone the repository
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# Install dependencies
npm install

# Build the project
npm run build

# Link for global CLI access
npm link
```

## Available Scripts

<!-- AUTO-GENERATED -->
| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run build:packages` | Build all workspace packages |
| `npm run dev` | Run development mode with tsx |
| `npm run dev:cli` | Run CLI in development mode with tsx |
| `npm start` | Run the compiled CLI |
| `npm test` | Run test suite with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run clean` | Remove dist/ directory |
| `npm run clean:packages` | Clean all workspace packages |
<!-- /AUTO-GENERATED -->

## Testing

KodaX uses **Vitest** for testing with a minimum coverage requirement of 80%.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npm test tests/kodax_core.test.ts

# Run tests with coverage
npm test -- --coverage
```

### Writing Tests

- Follow the TDD methodology: write tests first (RED), implement (GREEN), refactor
- Place test files in `tests/` directory
- Use descriptive test names
- Aim for 80%+ coverage

## Code Style

- **TypeScript** strict mode enabled
- **Functional, immutable patterns** preferred
- **Small files**: 200-400 lines typical, 800 max
- **Small functions**: < 50 lines preferred
- **No deep nesting**: Maximum 4 levels

## Project Structure

KodaX uses a **monorepo architecture** with npm workspaces:

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax/ai - Independent LLM abstraction layer
│   │   └── providers/       # 7 LLM providers (Anthropic, OpenAI, etc.)
│   │
│   ├── agent/               # @kodax/agent - Generic Agent framework
│   │   └── session/         # Session management, message handling
│   │
│   ├── skills/              # @kodax/skills - Skills standard implementation
│   │   └── builtin/         # Built-in skills (code-review, tdd, git-workflow)
│   │
│   ├── coding/              # @kodax/coding - Coding Agent (tools + prompts)
│   │   └── tools/           # 8 tools: read, write, edit, bash, glob, grep, undo, diff
│   │
│   └── repl/                # @kodax/repl - Interactive terminal UI
│       ├── ui/              # Ink/React components, themes
│       └── interactive/     # Commands, REPL logic
│
├── src/
│   └── kodax_cli.ts         # Main CLI entry point
│
└── package.json             # Root workspace config
```

## Pull Request Workflow

1. Create a feature branch from `main`
2. Write tests first (TDD)
3. Implement the feature
4. Ensure all tests pass
5. Submit PR with clear description

## Commit Message Format

```
<type>: <description>

[optional body]
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`
