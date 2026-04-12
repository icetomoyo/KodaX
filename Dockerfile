# syntax=docker/dockerfile:1
# ---------------------------------------------------------
# KodaX — multi-platform Docker image (amd64 + arm64)
#
# Build:
#   docker build -t kodax .
#
# Multi-platform (requires buildx):
#   docker buildx build --platform linux/amd64,linux/arm64 -t kodax .
#
# Run interactive REPL:
#   docker run -it --rm kodax
#
# Run one-shot task:
#   docker run --rm kodax --task "explain this code"
#
# Run ACP server:
#   docker run -d -p 7860:7860 kodax --acp --port 7860
# ---------------------------------------------------------

# ── Stage 1: Build ──────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace structure first (better layer caching)
COPY package.json package-lock.json .npmrc ./
COPY packages/agent/package.json   packages/agent/
COPY packages/ai/package.json      packages/ai/
COPY packages/coding/package.json  packages/coding/
COPY packages/repl/package.json    packages/repl/
COPY packages/skills/package.json  packages/skills/

# Install ALL dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json tsconfig.build.json ./
COPY src/          src/
COPY packages/     packages/

# Build TypeScript
RUN npm run build

# Prune devDependencies after build
RUN npm prune --omit=dev

# ── Stage 2: Runtime ────────────────────────────────────
FROM node:20-alpine AS runtime

# Labels
LABEL maintainer="KodaX Authors"
LABEL org.opencontainers.image.source="https://github.com/icetomoyo/KodaX"
LABEL org.opencontainers.image.description="KodaX - Lightweight Coding Agent"

# Create non-root user
RUN addgroup -S kodax && adduser -S kodax -G kodax

WORKDIR /app

# Copy production artifacts from builder
COPY --from=builder /app/package.json       ./
COPY --from=builder /app/node_modules/      node_modules/
COPY --from=builder /app/dist/              dist/
COPY --from=builder /app/packages/agent/dist/      packages/agent/dist/
COPY --from=builder /app/packages/agent/package.json packages/agent/
COPY --from=builder /app/packages/ai/dist/         packages/ai/dist/
COPY --from=builder /app/packages/ai/package.json  packages/ai/
COPY --from=builder /app/packages/coding/dist/     packages/coding/dist/
COPY --from=builder /app/packages/coding/package.json packages/coding/
COPY --from=builder /app/packages/repl/dist/       packages/repl/dist/
COPY --from=builder /app/packages/repl/package.json packages/repl/
COPY --from=builder /app/packages/skills/dist/     packages/skills/dist/
COPY --from=builder /app/packages/skills/package.json packages/skills/

# Copy config example for reference
COPY config.example.jsonc ./

# Create config directory with correct permissions
RUN mkdir -p /home/kodax/.kodax && chown -R kodax:kodax /home/kodax

# Git is needed for repository operations
RUN apk add --no-cache git

# Switch to non-root user
USER kodax

# Default to interactive REPL; override with --acp for server mode
ENTRYPOINT ["node", "dist/kodax_cli.js"]
