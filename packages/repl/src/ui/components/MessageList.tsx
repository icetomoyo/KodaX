/**
 * MessageList
 *
 * Reference Gemini CLI's message display architecture implementation.
 * Support HistoryItem types: user, assistant, tool_group, thinking, error, event, info, and hint.
 */

import React, { useEffect, useMemo, memo } from "react";
import { Box, Static, Text, useStdout } from "../tui.js";
import { getTheme } from "../themes/index.js";
import { Spinner } from "./LoadingIndicator.js";
import type { Theme } from "../types.js";
import type { ScrollBoxWindow } from "../../tui/components/ScrollBox.js";
import {
  ToolCallStatus,
  type HistoryItem,
  type HistoryItemUser,
  type HistoryItemAssistant,
  type HistoryItemToolGroup,
  type HistoryItemThinking,
  type HistoryItemError,
  type HistoryItemEvent,
  type HistoryItemInfo,
  type HistoryItemHint,
  type HistoryItemSystem,
  type ToolCall,
} from "../types.js";
import type { IterationRecord } from "../contexts/StreamingContext.js";
import {
  buildTranscriptRenderModel,
  resolveTranscriptColor,
  resolveVisibleTranscriptRows,
  type TranscriptRenderModel,
  type TranscriptSection,
  type TranscriptRow,
} from "../utils/transcript-layout.js";
import { sliceTranscriptText } from "../utils/transcript-text-metrics.js";
import {
  collapseToolCalls,
  formatCollapsedToolInlineText,
} from "../utils/tool-display.js";
import type { TranscriptRowSelectionRange } from "../utils/transcript-text-selection.js";
import { truncateUserMessageForDisplay } from "../utils/user-message-display.js";

// === Types ===

export interface MessageListProps {
  /** History item list */
  items: HistoryItem[];
  /** Whether loading */
  isLoading?: boolean;
  /** Maximum display lines before truncation */
  maxLines?: number;
  /** Whether thinking output is currently being shown. */
  isThinking?: boolean;
  /** Character count for the current thinking output. */
  thinkingCharCount?: number;
  /** Thinking content shown during streaming. */
  thinkingContent?: string;
  /** Current streaming response text shown in real time. */
  streamingResponse?: string;
  /** Name of the tool currently being executed. */
  currentTool?: string;
  /** Tool calls in the active response, including completed items from the current live batch. */
  activeToolCalls?: ToolCall[];
  /** Character count for the current tool input preview. */
  toolInputCharCount?: number;
  /** Tool input content preview for display */
  toolInputContent?: string;
  /** Completed iteration history for the active response. */
  iterationHistory?: IterationRecord[];
  /** Sequence number for the active iteration. */
  currentIteration?: number;
  /** Whether context compaction is in progress */
  isCompacting?: boolean;
  /** Managed-task agent mode shown in live transcript state */
  agentMode?: "sa" | "ama";
  /** Managed-task phase shown in live transcript state */
  managedPhase?: "starting" | "routing" | "preflight" | "round" | "worker" | "upgrade" | "completed";
  /** Managed-task harness profile shown in live transcript state */
  managedHarnessProfile?: string;
  /** Managed-task active worker title shown in live transcript state */
  managedWorkerTitle?: string;
  /** Managed-task current round */
  managedRound?: number;
  /** Managed-task maximum rounds */
  managedMaxRounds?: number;
  /** Managed-task global work budget */
  managedGlobalWorkBudget?: number;
  /** Managed-task current work usage */
  managedBudgetUsage?: number;
  /** Whether the run is waiting on budget approval */
  managedBudgetApprovalRequired?: boolean;
  /** Last known live activity label used when the stream is between deltas */
  lastLiveActivityLabel?: string;
  /** Visible viewport rows for transcript slicing */
  viewportRows?: number;
  /** Optional width override for deterministic transcript layout */
  viewportWidth?: number;
  /** Scroll offset from the bottom of the transcript, in rendered rows */
  scrollOffset?: number;
  /** Whether spinner glyphs should animate in rendered rows */
  animateSpinners?: boolean;
  /** Whether to render the transcript as a windowed viewport owned by the app */
  windowed?: boolean;
  /** Whether thinking content should render in verbose form */
  showFullThinking?: boolean;
  /** Whether tool details should render in verbose form */
  showDetailedTools?: boolean;
  /** Whether transcript-only "show all" should disable compact truncation */
  showAllContent?: boolean;
  /** Whether prompt/live progress helper rows should render inside the transcript */
  showLiveProgressRows?: boolean;
  /** Optional selected transcript item id for browse mode affordances */
  selectedItemId?: string;
  /** Optional expanded transcript item ids */
  expandedItemKeys?: ReadonlySet<string>;
  /** Optional transcript metrics callback for owned scroll controllers */
  onMetricsChange?: (metrics: {
    scrollHeight: number;
    viewportHeight: number;
  }) => void;
  /** Optional callback with the currently visible rows */
  onVisibleRowsChange?: (snapshot: {
    rows: TranscriptRow[];
    allRows: TranscriptRow[];
  }) => void;
  /** Optional renderer-owned transcript window */
  rendererWindow?: Pick<
    ScrollBoxWindow,
    "start" | "end" | "scrollHeight" | "viewportHeight" | "scrollTop" | "viewportTop" | "pendingDelta" | "sticky"
  >;
  /** Optional text selection ranges for app-owned transcript selection */
  selectedTextRanges?: ReadonlyMap<string, TranscriptRowSelectionRange>;
  /** Optional prebuilt transcript render model for owned fullscreen paths */
  transcriptModel?: TranscriptRenderModel;
  /** Optional precomputed visible transcript rows */
  visibleRowsOverride?: TranscriptRow[];
}

export interface HistoryItemRendererProps {
  item: HistoryItem;
  theme?: Theme;
  maxLines?: number;
}

// === Helpers ===

/**
 * Format timestamp
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Truncate text to the configured maximum number of lines.
 */
function truncateLines(text: string, maxLines: number): { lines: string[]; hasMore: boolean } {
  const lines = text.split("\n");
  const displayLines = lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;
  return { lines: displayLines, hasMore };
}

/**
 * Get the icon for a tool status.
 */
function getToolStatusIcon(status: ToolCallStatus): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
      return "\u25CB";
    case ToolCallStatus.Validating:
      return "\u25D0";
    case ToolCallStatus.AwaitingApproval:
      return "\u23F8";
    case ToolCallStatus.Executing:
      return "\u25CF";
    case ToolCallStatus.Success:
      return "\u2713";
    case ToolCallStatus.Error:
      return "\u2717";
    case ToolCallStatus.Cancelled:
      return "\u2298";
    default:
      return "?";
  }
}

/**
 * Get the color for a tool status.
 */
function getToolStatusColor(status: ToolCallStatus, theme: Theme): string {
  switch (status) {
    case ToolCallStatus.Scheduled:
    case ToolCallStatus.Validating:
      return theme.colors.dim;
    case ToolCallStatus.AwaitingApproval:
      return theme.colors.accent;
    case ToolCallStatus.Executing:
      return theme.colors.primary;
    case ToolCallStatus.Success:
      return theme.colors.success;
    case ToolCallStatus.Error:
      return theme.colors.error;
    case ToolCallStatus.Cancelled:
      return theme.colors.dim;
    default:
      return theme.colors.text;
  }
}

// === Sub-Components ===

/**
 * User message renderer.
 *
 * Issue 121 Layer 3: hard cap the rendered text so an oversized expansion
 * (stdin pipe, legacy terminal pastes that bypass bracketed-paste) never
 * forces Ink to wrap a giant `<Text>` node on every frame.
 */
const UserItemRenderer: React.FC<{ item: HistoryItemUser; theme: Theme }> = memo(({ item, theme }) => {
  const displayText = useMemo(() => truncateUserMessageForDisplay(item.text), [item.text]);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.colors.primary} bold>
          You
        </Text>
        <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={theme.colors.text}>{displayText}</Text>
      </Box>
    </Box>
  );
});

/**
 * Assistant message renderer.
 */
const AssistantItemRenderer: React.FC<{
  item: HistoryItemAssistant;
  theme: Theme;
  maxLines: number;
}> = memo(({ item, theme, maxLines }) => {
  const displayText = item.compactText ?? item.text;
  const { lines, hasMore } = truncateLines(displayText, maxLines);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.colors.secondary} bold>
          Assistant
        </Text>
        {item.isStreaming && (
          <>
            <Text> </Text>
            <Spinner color={theme.colors.accent} />
          </>
        )}
        <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
      </Box>
      <Box marginLeft={2} flexDirection="column">
        {lines.map((line, index) => (
          <Text key={index} color={theme.colors.text}>
            {line || " "}
          </Text>
        ))}
        {hasMore && (
          <Text dimColor>... ({displayText.split("\n").length - maxLines} more lines)</Text>
        )}
      </Box>
    </Box>
  );
});

/**
 * System message renderer.
 */
const SystemItemRenderer: React.FC<{ item: HistoryItemSystem; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.dim} bold>
        System
      </Text>
      <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor>{item.text}</Text>
    </Box>
  </Box>
));

/**
 * Tool call renderer.
 */
const ToolCallRenderer: React.FC<{ tool: ToolCall; count?: number; theme: Theme }> = memo(({ tool, count = 1, theme }) => {
  const icon = getToolStatusIcon(tool.status);
  const color = getToolStatusColor(tool.status, theme);
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text color={theme.colors.text} bold>
          {formatCollapsedToolInlineText({ tool, count })}
        </Text>
      </Box>
      {tool.error && (
        <Box marginLeft={2}>
          <Text color={theme.colors.error}>{tool.error}</Text>
        </Box>
      )}
    </Box>
  );
});

/**
 * Tool group renderer
 */
const ToolGroupRenderer: React.FC<{ item: HistoryItemToolGroup; theme: Theme }> = memo(({ item, theme }) => {
  const groupedTools = collapseToolCalls(item.tools);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.colors.accent} bold>
          Tools
        </Text>
        <Text dimColor> [{formatTimestamp(item.timestamp)}]</Text>
      </Box>
      {groupedTools.map((group) => (
        <ToolCallRenderer
          key={`${group.tool.id}-${group.count}`}
          tool={group.tool}
          count={group.count}
          theme={theme}
        />
      ))}
    </Box>
  );
});

/**
 * Thinking content renderer
 */
const ThinkingItemRenderer: React.FC<{ item: HistoryItemThinking; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.thinking} italic>
        Thinking
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.thinking} italic>
        {item.compactText ?? item.text}
      </Text>
    </Box>
  </Box>
));

/**
 * Error message renderer.
 */
const ErrorItemRenderer: React.FC<{ item: HistoryItemError; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.error} bold>
        {"\u2717"} Error
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text color={theme.colors.error}>{item.text}</Text>
    </Box>
  </Box>
));

/**
 * Managed/task event renderer.
 */
const EventItemRenderer: React.FC<{ item: HistoryItemEvent; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text color={theme.colors.text}>
      <Text color={theme.colors.accent} bold>{item.icon ?? ">"}</Text>
      <Text> </Text>
      {item.compactText ?? item.text}
    </Text>
  </Box>
));

/**
 * Info message renderer.
 */
const InfoItemRenderer: React.FC<{ item: HistoryItemInfo; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text color={theme.colors.info}>
      <Text bold>{item.icon ?? "\u2139"} </Text>
      {item.compactText ?? item.text}
    </Text>
  </Box>
));

/**
 * Hint message renderer.
 */
const HintItemRenderer: React.FC<{ item: HistoryItemHint; theme: Theme }> = memo(({ item, theme }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.colors.hint} bold>
        {"\u{1F4A1}"} Hint
      </Text>
    </Box>
    <Box marginLeft={2}>
      <Text dimColor>{item.text}</Text>
    </Box>
  </Box>
));

// === Main Components ===

/**
 * History item renderer
 * Dispatch to corresponding renderer based on type
 */
export const HistoryItemRenderer: React.FC<HistoryItemRendererProps> = memo(({
  item,
  theme: themeProp,
  maxLines = 1000, // Increased from 20 to avoid truncation (Issue 046)
}) => {
  const fallbackTheme = useMemo(() => getTheme("dark"), []);
  const theme = themeProp ?? fallbackTheme;

  switch (item.type) {
    case "user":
      return <UserItemRenderer item={item} theme={theme} />;
    case "assistant":
      return <AssistantItemRenderer item={item} theme={theme} maxLines={maxLines} />;
    case "system":
      return <SystemItemRenderer item={item} theme={theme} />;
    case "tool_group":
      return <ToolGroupRenderer item={item} theme={theme} />;
    case "thinking":
      return <ThinkingItemRenderer item={item} theme={theme} />;
    case "error":
      return <ErrorItemRenderer item={item} theme={theme} />;
    case "event":
      return <EventItemRenderer item={item} theme={theme} />;
    case "info":
      return <InfoItemRenderer item={item} theme={theme} />;
    case "hint":
      return <HintItemRenderer item={item} theme={theme} />;
    default:
      return (
        <Box>
          <Text dimColor>Unknown item type</Text>
        </Box>
      );
  }
});

/**
 * MessageList
 */
const TranscriptRowRenderer: React.FC<{
  row: TranscriptRow;
  theme: Theme;
  animateSpinners?: boolean;
  selectedItem?: boolean;
  selectionRange?: TranscriptRowSelectionRange;
}> = memo(({ row, theme, animateSpinners = true, selectedItem = false, selectionRange }) => {
  const color = resolveTranscriptColor(theme, row.color);
  const normalizedText = row.text === " " ? "" : row.text;
  const baseText = normalizedText || " ";
  const selectedText = selectionRange && normalizedText
    ? sliceTranscriptText(normalizedText, selectionRange.start, selectionRange.end)
    : "";
  const beforeSelection = selectionRange && normalizedText
    ? sliceTranscriptText(normalizedText, 0, selectionRange.start)
    : normalizedText;
  const afterSelection = selectionRange && normalizedText
    ? sliceTranscriptText(normalizedText, selectionRange.end)
    : "";
  const accentWholeRow = selectedItem && !selectionRange;
  const dimColor = !accentWholeRow && row.color === "dim";
  const commonTextProps = {
    bold: row.bold || accentWholeRow,
    italic: row.italic,
    dimColor,
  } as const;

  return (
    <Box marginLeft={row.indent ?? 0}>
      {row.spinner && animateSpinners && (
        <>
          <Spinner color={theme.colors.accent} theme={theme} />
          <Text> </Text>
        </>
      )}
      <Text
        color={accentWholeRow ? theme.colors.accent : color}
        {...commonTextProps}
      >
        {selectionRange && normalizedText ? (
          <>
            {beforeSelection ? (
              <Text
                color={accentWholeRow ? theme.colors.accent : color}
                {...commonTextProps}
              >
                {beforeSelection}
              </Text>
            ) : null}
            <Text
              backgroundColor={theme.colors.accent}
              color={theme.colors.background}
              bold
              italic={row.italic}
            >
              {selectedText}
            </Text>
            {afterSelection ? (
              <Text
                color={accentWholeRow ? theme.colors.accent : color}
                {...commonTextProps}
              >
                {afterSelection}
              </Text>
            ) : null}
          </>
        ) : (
          baseText
        )}
      </Text>
    </Box>
  );
});

const StaticTranscriptItemRenderer: React.FC<{
  section: TranscriptSection;
  theme: Theme;
  animateSpinners?: boolean;
}> = memo(({ section, theme, animateSpinners = true }) => {
  return (
    <Box flexDirection="column">
      {section.rows.map((row) => (
        <TranscriptRowRenderer
          key={row.key}
          row={row}
          theme={theme}
          animateSpinners={animateSpinners}
        />
      ))}
    </Box>
  );
});

export const MessageList: React.FC<MessageListProps> = ({
  items,
  isLoading = false,
  maxLines = 1000,
  isThinking = false,
  thinkingCharCount = 0,
  thinkingContent = "",
  streamingResponse = "",
  currentTool,
  activeToolCalls,
  toolInputCharCount = 0,
  toolInputContent = "",
  iterationHistory = [],
  currentIteration = 1,
  isCompacting = false,
  agentMode,
  managedPhase,
  managedHarnessProfile,
  managedWorkerTitle,
  managedRound,
  managedMaxRounds,
  managedGlobalWorkBudget,
  managedBudgetUsage,
  managedBudgetApprovalRequired,
  lastLiveActivityLabel,
  viewportRows,
  viewportWidth,
  scrollOffset = 0,
  animateSpinners = true,
  windowed = false,
  showFullThinking = false,
  showDetailedTools = false,
  showAllContent = false,
  showLiveProgressRows = true,
  selectedItemId,
  expandedItemKeys,
  onMetricsChange,
  onVisibleRowsChange,
  rendererWindow,
  selectedTextRanges,
  transcriptModel,
  visibleRowsOverride,
}) => {
  const theme = useMemo(() => getTheme("dark"), []);
  const { stdout } = useStdout();
  const terminalWidth = viewportWidth ?? stdout?.columns ?? 80;

  const effectiveTranscriptModel = useMemo(
    () => transcriptModel ?? buildTranscriptRenderModel({
      items,
      viewportWidth: terminalWidth,
      isLoading,
      maxLines,
      isThinking,
      thinkingCharCount,
      thinkingContent,
      streamingResponse,
      currentTool,
      activeToolCalls,
      toolInputCharCount,
      toolInputContent,
      iterationHistory,
      currentIteration,
      isCompacting,
      managedAgentMode: agentMode,
      managedPhase,
      managedHarnessProfile,
      managedWorkerTitle,
      managedRound,
      managedMaxRounds,
      managedGlobalWorkBudget,
      managedBudgetUsage,
      managedBudgetApprovalRequired,
      lastLiveActivityLabel,
      windowed,
      showFullThinking,
      showDetailedTools,
      showAllContent,
      showLiveProgressRows,
      expandedItemKeys,
    }),
    [
      transcriptModel,
      items,
      terminalWidth,
      isLoading,
      maxLines,
      isThinking,
      thinkingCharCount,
      thinkingContent,
      streamingResponse,
      currentTool,
      activeToolCalls,
      toolInputCharCount,
      toolInputContent,
      iterationHistory,
      currentIteration,
      isCompacting,
      agentMode,
      managedPhase,
      managedHarnessProfile,
      managedWorkerTitle,
      managedRound,
      managedMaxRounds,
      managedGlobalWorkBudget,
      managedBudgetUsage,
      managedBudgetApprovalRequired,
      lastLiveActivityLabel,
      windowed,
      showFullThinking,
      showDetailedTools,
      showAllContent,
      showLiveProgressRows,
      expandedItemKeys,
    ],
  );
  const staticSections = effectiveTranscriptModel.staticSections;
  const transcriptRows = effectiveTranscriptModel.rows;
  const previewRows = effectiveTranscriptModel.previewRows;
  const allTranscriptRows = useMemo(
    () => [...transcriptRows, ...previewRows],
    [previewRows, transcriptRows],
  );
  // A prebuilt transcriptModel may supply rows even when items is empty (e.g. banners).
  const hasRenderableTranscriptContent = allTranscriptRows.length > 0;
  const showEmptyState = !hasRenderableTranscriptContent && items.length === 0 && !isLoading;
  const windowedRowSource = useMemo(
    () => (windowed || rendererWindow || visibleRowsOverride ? allTranscriptRows : transcriptRows),
    [allTranscriptRows, rendererWindow, transcriptRows, visibleRowsOverride, windowed],
  );

  const visibleRows = useMemo(
    () => {
      if (visibleRowsOverride) {
        return visibleRowsOverride;
      }
      return resolveVisibleTranscriptRows(windowedRowSource, {
        viewportTop: rendererWindow
          ? Math.max(0, rendererWindow.viewportTop)
          : undefined,
        viewportHeight: rendererWindow
          ? Math.max(0, rendererWindow.viewportHeight)
          : undefined,
        start: undefined,
        end: undefined,
        viewportRows,
        scrollOffset,
        windowed,
      });
    },
    [
      rendererWindow,
      scrollOffset,
      viewportRows,
      visibleRowsOverride,
      windowed,
      windowedRowSource,
    ]
  );
  const renderedRows = useMemo(
    () => (visibleRowsOverride || windowed || rendererWindow ? visibleRows : allTranscriptRows),
    [allTranscriptRows, rendererWindow, visibleRows, visibleRowsOverride, windowed],
  );
  const allRenderedRows = useMemo(
    () => allTranscriptRows,
    [allTranscriptRows],
  );
  const effectiveViewportRows = rendererWindow
    ? Math.max(0, rendererWindow.viewportHeight)
    : viewportRows;

  useEffect(() => {
    onMetricsChange?.({
      scrollHeight: allTranscriptRows.length,
      viewportHeight: rendererWindow
        ? Math.max(0, rendererWindow.viewportHeight)
        : (effectiveViewportRows ?? allTranscriptRows.length),
    });
  }, [allTranscriptRows.length, effectiveViewportRows, onMetricsChange, rendererWindow]);

  useEffect(() => {
    onVisibleRowsChange?.({
      rows: renderedRows,
      allRows: allRenderedRows,
    });
  }, [allRenderedRows, onVisibleRowsChange, renderedRows]);

  if (showEmptyState) {
    return (
      <Box paddingY={1}>
        <Text dimColor>No messages yet. Start typing to begin.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {!windowed && staticSections.length > 0 && (
        <Static items={staticSections}>
          {(section) => (
            <StaticTranscriptItemRenderer
              key={section.key}
              section={section}
              theme={theme}
              animateSpinners={animateSpinners}
            />
          )}
        </Static>
      )}
      {renderedRows.map((row) => (
        <TranscriptRowRenderer
          key={row.key}
          row={row}
          theme={theme}
          animateSpinners={animateSpinners}
          selectedItem={selectedItemId ? row.key.startsWith(`${selectedItemId}-`) : false}
          selectionRange={selectedTextRanges?.get(row.key)}
        />
      ))}
    </Box>
  );
};

// === Legacy Exports (for backward compatibility) ===

import type { LegacyMessageListProps, Message } from "../types.js";

/**
 * @deprecated Use MessageList with items prop instead
 */
export const LegacyMessageList: React.FC<LegacyMessageListProps> = ({ messages, isLoading }) => {
  // Convert legacy Message to HistoryItem
  const items: HistoryItem[] = messages.map((msg: Message) => {
    const base = {
      id: msg.id,
      timestamp: msg.timestamp,
    };

    switch (msg.role) {
      case "user":
        return { ...base, type: "user" as const, text: msg.content };
      case "assistant":
        return { ...base, type: "assistant" as const, text: msg.content };
      case "system":
        return { ...base, type: "system" as const, text: msg.content };
      default:
        return { ...base, type: "info" as const, text: msg.content };
    }
  });

  return <MessageList items={items} isLoading={isLoading} />;
};

/**
 * Simplified message display.
 */
export const SimpleMessageDisplay: React.FC<{
  role: "user" | "assistant" | "system";
  content: string;
}> = ({ role, content }) => {
  const theme = useMemo(() => getTheme("dark"), []);

  const color = {
    user: theme.colors.primary,
    assistant: theme.colors.secondary,
    system: theme.colors.dim,
  }[role];

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {role === "user" ? ">" : role === "assistant" ? "<" : "#"}
      </Text>
      <Text>{content}</Text>
    </Box>
  );
};

