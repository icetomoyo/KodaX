/**
 * LoadingIndicator - Loading and thinking indicator component - 加载和思考指示器组件
 *
 * Reference Gemini CLI's loading display architecture implementation.
 * Provide multiple loading state visualization methods - 参考 Gemini CLI 的加载显示架构实现，提供多种加载状态可视化方式。
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "../tui.js";
import { getTheme } from "../themes/index.js";
import type { Theme } from "../types.js";
import { formatTokenCount } from "../view-models/status-bar.js";

// === Types ===

export type LoadingIndicatorType = "spinner" | "dots" | "bar" | "simple";

export interface LoadingIndicatorProps {
  /** Main message - 主消息 */
  message?: string;
  /** Sub message - 子消息 */
  subMessage?: string;
  /** Progress (0-100) - 进度 (0-100) */
  progress?: number;
  /** Type - 类型 */
  type?: LoadingIndicatorType;
  /** Compact mode - 紧凑模式 */
  compact?: boolean;
  /** Theme - 主题 */
  theme?: Theme;
}

export interface ThinkingIndicatorProps {
  /** Custom message - 自定义消息 */
  message?: string;
  /** Show spinner - 显示旋转器 */
  showSpinner?: boolean;
  /** Theme - 主题 */
  theme?: Theme;
}

export interface SpinnerProps {
  /** Color - 颜色 */
  color?: string;
  /** Theme - 主题 */
  theme?: Theme;
}

export interface SpinnerStatsTailProps {
  /**
   * Wall-clock timestamp (`Date.now()`) when the active streaming round
   * started. Null when no round is in flight — the tail renders nothing.
   */
  roundStartedAt: number | null;
  /**
   * Character count of the streamed assistant response so far. Used to
   * estimate output tokens via the claudecode chars/4 heuristic (see
   * `c:/Works/claudecode/src/utils/tokens.ts:172-199`). Live during stream
   * — read freshly on every tick (StreamingContext flushes 80ms-batched
   * deltas into `currentResponse`).
   */
  charCount: number;
  /** Theme — optional, falls back to dark theme. */
  theme?: Theme;
}

export interface DotsIndicatorProps {
  /** Label - 标签 */
  label?: string;
  /** Dot count - 点数量 */
  dotCount?: number;
  /** Theme - 主题 */
  theme?: Theme;
}

export interface ProgressIndicatorProps {
  /** Progress (0-100) - 进度 (0-100) */
  progress: number;
  /** Label - 标签 */
  label?: string;
  /** Bar width - 条宽度 */
  width?: number;
  /** Theme - 主题 */
  theme?: Theme;
}

// === Constants ===

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * v0.7.41 — module-level shared 80ms clock for every spinner-related
 * React component (`<Spinner>`, `<SpinnerStatsTail>`, any future
 * spinner-row child that needs to re-render at the spinner cadence).
 *
 * Why shared, not per-component setInterval:
 *
 *   - **Drift / un-sync (primary reason).** KodaX's vendored renderer
 *     runs in LegacyRoot mode by default
 *     (`packages/repl/src/tui/core/engine.js:181`), where React 18 does
 *     NOT auto-batch setState across `setInterval` callbacks. Two
 *     independent 80ms timers, started at different absolute moments
 *     X and Y, tick at X+80n and Y+80n forever. Each fires its own
 *     event-loop task → two separate React commits with different
 *     `tick` values. Even though the cell-level diff renderer
 *     (`packages/repl/src/tui/substrate/ink/cell-renderer.ts:100-117`)
 *     + 33ms `onRender` throttle (`engine.js:147-155`, ~30fps) absorb
 *     the stdout writes, the *React state* between the two commits
 *     is briefly out of sync — glyph might advance to frame 5 while
 *     the stats tail still shows the elapsed-second from frame 4. A
 *     shared timer puts both setStates in the same callback so they
 *     commit at the same absolute moment.
 *
 *   - **claudecode parity.** claudecode uses a single timer for the
 *     whole `SpinnerAnimationRow` (`useAnimationFrame(50)` driving
 *     glyph + verb + elapsed + tokens together).
 *
 *   - **Lifecycle simplicity.** One ref-counted timer has one cleanup
 *     path; N independent setIntervals have N. Past KodaX timer-
 *     coupling bugs (user-cited; predate this slice) are the
 *     institutional signal that asynchronous spinner timers misbehave
 *     in edge cases (StrictMode double-mount, concurrent root mode if
 *     ever enabled, hot-reload during dev).
 *
 * Ref-counting: the underlying `setInterval` is created lazily on the
 * first `subscribe` and torn down when the last listener unsubscribes,
 * so an idle REPL (no spinner mounted) holds no timer at all.
 *
 * StrictMode: React 18 double-invokes effects during dev; each
 * `subscribe` call gets its own listener closure, and the matching
 * cleanup removes exactly that closure from the Set — strict-mode
 * mount→cleanup→mount cycles converge to the right subscriber count.
 */
const SPINNER_TICK_INTERVAL_MS = 80;

const sharedSpinnerListeners = new Set<() => void>();
let sharedSpinnerTimer: ReturnType<typeof setInterval> | null = null;

function dispatchSharedSpinnerTick(): void {
  // Snapshot to a local array so a listener calling unsubscribe during
  // dispatch (e.g. a parent unmounting a child mid-tick) doesn't mutate
  // the Set while we iterate.
  const snapshot = Array.from(sharedSpinnerListeners);
  for (const listener of snapshot) {
    listener();
  }
}

function subscribeToSharedSpinnerClock(listener: () => void): () => void {
  sharedSpinnerListeners.add(listener);
  if (sharedSpinnerTimer === null) {
    sharedSpinnerTimer = setInterval(dispatchSharedSpinnerTick, SPINNER_TICK_INTERVAL_MS);
  }
  return () => {
    sharedSpinnerListeners.delete(listener);
    if (sharedSpinnerListeners.size === 0 && sharedSpinnerTimer !== null) {
      clearInterval(sharedSpinnerTimer);
      sharedSpinnerTimer = null;
    }
  };
}

/**
 * Returns a monotonically-incrementing tick counter that advances every
 * `SPINNER_TICK_INTERVAL_MS` on a SINGLE shared `setInterval`. All
 * consumers receive their tick from the same dispatch callback, so each
 * tick's setStates commit at the same absolute moment — the cell-level
 * diff renderer + 33fps `onRender` throttle then collapse them into one
 * stdout write.
 *
 * When `active === false` the hook subscribes nothing (no work) and
 * returns a stable 0 — used by `<SpinnerStatsTail>` to short-circuit
 * when there is no active round.
 */
export function useSharedSpinnerTick(active: boolean = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    return subscribeToSharedSpinnerClock(() => {
      // Natural increment — JS number stays precise to 2^53, i.e.
      // ~22M years at 12.5 Hz. Consumers mod by their own period
      // (e.g. `tick % SPINNER_FRAMES.length` for glyph rotation),
      // so no boundary jump like a fixed-width mask would produce.
      setTick((n) => n + 1);
    });
  }, [active]);
  return tick;
}

// === Test-only exports (NOT public API) ===

/** v0.7.41 — exported for SharedSpinnerClock.test.ts only. */
export function _peekSharedSpinnerListenerCount(): number {
  return sharedSpinnerListeners.size;
}

/** v0.7.41 — exported for SharedSpinnerClock.test.ts only. */
export function _peekSharedSpinnerTimerActive(): boolean {
  return sharedSpinnerTimer !== null;
}

// === Components ===

/**
 * Spinner — braille-glyph rotation tied to the shared 80ms tick. Used
 * standalone (e.g. assistant header) and inside `TranscriptRowRenderer`'s
 * loading-indicator row. All instances cycle in lockstep.
 */
export const Spinner: React.FC<SpinnerProps> = ({ color, theme: themeProp }) => {
  // getTheme("dark") returns a module-level singleton — reference-stable
  // across renders, so no memoization needed. Plain `??` keeps any
  // future hook calls below this line in deterministic order, which
  // `themeProp ?? useMemo(...)` did not.
  const theme = themeProp ?? getTheme("dark");
  const tick = useSharedSpinnerTick(true);
  const frame = tick % SPINNER_FRAMES.length;
  const spinnerColor = color ?? theme.colors.accent;

  return (
    <Text color={spinnerColor}>{SPINNER_FRAMES[frame]}</Text>
  );
};

/**
 * Token estimation heuristic — characters / 4 — matches claudecode
 * `c:/Works/claudecode/src/utils/tokens.ts:172-199`. Not pulled from
 * provider `usage.output_tokens` because that only lands at message-end;
 * char-count is available every 80ms via the streaming flush, so the
 * spinner-tail can show live progress.
 */
export function estimateOutputTokens(charCount: number): number {
  if (charCount <= 0) return 0;
  return Math.round(charCount / 4);
}

/**
 * Format milliseconds as a compact elapsed-duration string with
 * magnitude-aware rollover. Stat-tail wants a glanceable number that
 * stays readable as a query runs from a few seconds through long
 * multi-step AMA sessions.
 *
 *   < 60s         → `Ns`        (e.g. `45s`)
 *   < 60m         → `MmSs`      (e.g. `1m12s`)
 *   ≥ 60m         → `HhMmSs`    (e.g. `1h2m3s`)
 *
 * Sub-second clamps to `0s` so very-short rounds don't show distracting
 * jitter. Negative input (clock skew defence) clamps to `0s` too.
 */
export function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours === 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${hours}h${minutes}m${seconds}s`;
}

/**
 * SpinnerStatsTail — appends "(Ns · ↓ T tokens)" after the spinner-row
 * loading text. v0.7.41, claudecode parity (single shared tick driving
 * glyph + stats together — see
 * `c:/Works/claudecode/src/components/Spinner/SpinnerAnimationRow.tsx:80-214`
 * `useAnimationFrame(50)`).
 *
 * Shares the module-level 80ms clock with `<Spinner>` via
 * `useSharedSpinnerTick(active)`. When `roundStartedAt === null` the
 * hook short-circuits (no subscription, no work) and the component
 * renders nothing. Otherwise glyph rotation and stats display update
 * in the same React batch → one Ink reconcile + one stdout write per
 * tick across the whole spinner row.
 *
 * `charCount` is read from props (refreshed by StreamingContext.notify
 * each 80ms flush); elapsed = `Date.now() - roundStartedAt`, recomputed
 * each tick so it keeps advancing even during silent thinking phases
 * when no text deltas arrive.
 */
export const SpinnerStatsTail: React.FC<SpinnerStatsTailProps> = ({
  roundStartedAt,
  charCount,
  theme: themeProp,
}) => {
  // Plain `??` (no useMemo) — getTheme returns a stable singleton, and
  // unconditional default-resolution keeps hook-call order deterministic.
  const theme = themeProp ?? getTheme("dark");
  useSharedSpinnerTick(roundStartedAt !== null);

  if (roundStartedAt === null) return null;

  const statsText = buildSpinnerStatsText(Date.now() - roundStartedAt, charCount);
  return (
    <Text color={theme.colors.dim} wrap="truncate">
      {statsText}
    </Text>
  );
};

/**
 * Pure formatter for the stats-tail string. Exported for unit testing
 * — `<SpinnerStatsTail>` itself is a self-ticking component which is
 * awkward to test in pure-JS environments.
 */
export function buildSpinnerStatsText(elapsedMs: number, charCount: number): string {
  const elapsed = formatElapsedDuration(elapsedMs);
  const tokens = estimateOutputTokens(charCount);
  return tokens > 0
    ? ` (${elapsed} · ↓ ${formatTokenCount(tokens)} tokens)`
    : ` (${elapsed})`;
}

/**
 * Dots indicator component - 点指示器组件
 */
export const DotsIndicator: React.FC<DotsIndicatorProps> = ({
  label,
  dotCount = 3,
  theme: themeProp,
}) => {
  const theme = themeProp ?? getTheme("dark");
  const [dotPosition, setDotPosition] = useState(1);

  useEffect(() => {
    const timer = setInterval(() => {
      setDotPosition((p) => (p % dotCount) + 1);
    }, 300);

    return () => clearInterval(timer);
  }, [dotCount]);

  const dots = ".".repeat(dotPosition);

  return (
    <Box>
      {label && <Text color={theme.colors.text}>{label}</Text>}
      <Text color={theme.colors.accent}>{dots}</Text>
    </Box>
  );
};

/**
 * Progress indicator component - 进度指示器组件
 */
export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  progress,
  label,
  width = 20,
  theme: themeProp,
}) => {
  const theme = themeProp ?? getTheme("dark");

  // Clamp progress to 0-100
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const filledWidth = Math.round((clampedProgress / 100) * width);
  const emptyWidth = width - filledWidth;

  const filled = "█".repeat(filledWidth);
  const empty = "░".repeat(emptyWidth);

  return (
    <Box flexDirection="column">
      {label && (
        <Box marginBottom={1}>
          <Text color={theme.colors.text}>{label}</Text>
        </Box>
      )}
      <Box>
        <Text color={theme.colors.primary}>{filled}</Text>
        <Text dimColor>{empty}</Text>
        <Text> {clampedProgress}%</Text>
      </Box>
    </Box>
  );
};

/**
 * Thinking indicator component - 思考指示器组件
 */
export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({
  message,
  showSpinner = false,
  theme: themeProp,
}) => {
  const theme = themeProp ?? getTheme("dark");
  const displayMessage = message ?? "Thinking";

  return (
    <Box>
      {showSpinner && (
        <Box marginRight={1}>
          <Spinner theme={theme} />
        </Box>
      )}
      <Text color={theme.colors.accent}>{displayMessage}…</Text>
    </Box>
  );
};

/**
 * Loading indicator component - 加载指示器组件
 */
export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  message,
  subMessage,
  progress,
  type = "spinner",
  compact = false,
  theme: themeProp,
}) => {
  const theme = themeProp ?? getTheme("dark");
  const displayMessage = message ?? "Loading";

  // Compact mode - 紧凑模式
  if (compact) {
    return (
      <Box>
        <Spinner theme={theme} />
        <Text color={theme.colors.text}> {displayMessage}…</Text>
      </Box>
    );
  }

  // Progress bar mode - 进度条模式
  if (type === "bar" && progress !== undefined) {
    return (
      <Box flexDirection="column">
        <ProgressIndicator progress={progress} label={displayMessage} theme={theme} />
        {subMessage && (
          <Box marginTop={1}>
            <Text dimColor>{subMessage}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Dot animation mode - 点动画模式
  if (type === "dots") {
    return (
      <Box flexDirection="column">
        <DotsIndicator label={displayMessage} theme={theme} />
        {subMessage && (
          <Box marginTop={1}>
            <Text dimColor>{subMessage}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Simple mode - 简单模式
  if (type === "simple") {
    return (
      <Box flexDirection="column">
        <Text color={theme.colors.accent}>{displayMessage}…</Text>
        {subMessage && (
          <Box marginTop={1}>
            <Text dimColor>{subMessage}</Text>
          </Box>
        )}
        {progress !== undefined && (
          <Box marginTop={1}>
            <Text dimColor>{progress}%</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Default spinner mode - 默认旋转器模式
  return (
    <Box flexDirection="column">
      <Box>
        <Spinner theme={theme} />
        <Text color={theme.colors.text}> {displayMessage}…</Text>
        {progress !== undefined && (
          <Text dimColor> ({progress}%)</Text>
        )}
      </Box>
      {subMessage && (
        <Box marginTop={1}>
          <Text dimColor>{subMessage}</Text>
        </Box>
      )}
    </Box>
  );
};

// === Exports ===

export default LoadingIndicator;
