/**
 * StatusBar - Bottom status bar component.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { getTheme } from '../themes/index.js';
import type { StatusBarProps } from '../types.js';

const ITERATION_SYMBOL = '\u{1F504}';
const BAR_FILLED = '\u2588';
const BAR_EMPTY = '\u2592';
const TOKEN_ARROW = '\u2192';

function formatReasoningModeShort(mode: string): string {
  switch (mode) {
    case 'auto': return 'auto';
    case 'balanced': return 'balanced';
    case 'quick': return 'quick';
    case 'deep': return 'deep';
    case 'off': return 'off';
    default: return mode.toLowerCase();
  }
}

function formatReasoningCapabilityShort(capability?: string): string {
  switch (capability) {
    case 'budget': case 'B': return 'B';
    case 'effort': case 'E': return 'E';
    case 'toggle': case 'T': return 'T';
    case 'prompt': case '-': return '-';
    case 'unknown': case '?': return '?';
    default: return capability ?? '';
  }
}

function getReasoningColor(mode: string): 'dim' | 'green' | 'yellow' | 'magenta' | 'cyan' {
  switch (mode) {
    case 'off': return 'dim';
    case 'quick': return 'green';
    case 'balanced': return 'yellow';
    case 'deep': return 'magenta';
    case 'auto':
    default: return 'cyan';
  }
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return String(count);
}

function createMiniProgressBar(percent: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(percent / 10)));
  const empty = 10 - filled;
  return `${BAR_FILLED.repeat(filled)}${BAR_EMPTY.repeat(empty)}`;
}

function getContextColor(
  currentTokens: number,
  contextWindow: number,
  triggerPercent: number,
): 'green' | 'yellow' | 'red' {
  if (contextWindow === 0) {
    return 'green';
  }
  const percent = (currentTokens / contextWindow) * 100;
  const warningThreshold = triggerPercent * (2 / 3);
  if (percent >= triggerPercent) return 'red';
  if (percent >= warningThreshold) return 'yellow';
  return 'green';
}

function formatToolAction(currentTool: string): string {
  const name = currentTool.toLowerCase();
  if (name.includes('read') || name.includes('view') || name.includes('search') || name.includes('list') || name.includes('find') || name.includes('browser') || name.includes('get')) {
    return 'Read';
  }
  if (name.includes('write') || name.includes('replace') || name.includes('edit') || name.includes('modify')) {
    return 'Edit';
  }
  if (name.includes('command') || name.includes('bash') || name.includes('terminal')) {
    return 'Bash';
  }
  if (name.includes('ask') || name.includes('notify') || name.includes('user') || name.includes('question')) {
    return 'Ask';
  }
  if (name.includes('think') || name.includes('reason')) {
    return 'Think';
  }
  return currentTool;
}

function formatBusyStatus({
  currentTool,
  isThinkingActive,
  isCompacting,
}: Pick<
  StatusBarProps,
  'currentTool' | 'isThinkingActive' | 'isCompacting'
>): string | undefined {
  if (isCompacting) {
    return 'Compacting';
  }

  if (currentTool) {
    return formatToolAction(currentTool);
  }

  if (isThinkingActive) {
    return 'Thinking';
  }

  return undefined;
}

export function getStatusBarText({
  sessionId,
  permissionMode,
  parallel = false,
  provider,
  model,
  tokenUsage,
  currentTool,
  thinking,
  isThinkingActive,
  reasoningMode = thinking ? 'auto' : 'off',
  reasoningCapability,
  isCompacting,
  currentIteration,
  maxIter,
  contextUsage,
  showBusyStatus = true,
}: StatusBarProps): string {
  const parts: string[] = [];

  parts.push('KodaX');
  parts.push(permissionMode.toUpperCase());
  parts.push(parallel ? 'parallel' : 'sequential');

  const rModeShort = formatReasoningModeShort(reasoningMode);
  const rCapShort = formatReasoningCapabilityShort(reasoningCapability);
  parts.push(reasoningCapability ? `${rModeShort}/${rCapShort}` : rModeShort);

  if (currentIteration && maxIter) {
    parts.push(`${ITERATION_SYMBOL} ${currentIteration}/${maxIter}`);
  }

  const busyStatus = showBusyStatus
    ? formatBusyStatus({
        currentTool,
        isThinkingActive,
        isCompacting,
      })
    : undefined;
  const toolStr = busyStatus ? busyStatus : '';
  parts.push(`${sessionId}${toolStr ? ` ${toolStr}` : ''}`);
  parts.push(`${provider}/${model}`);

  if (contextUsage && contextUsage.contextWindow !== 0) {
    const percent = Math.round((contextUsage.currentTokens / contextUsage.contextWindow) * 100);
    const currentStr = formatTokenCount(contextUsage.currentTokens);
    const windowStr = formatTokenCount(contextUsage.contextWindow);
    const progressBar = createMiniProgressBar(percent);
    parts.push(`${currentStr}/${windowStr} ${progressBar} ${percent}%`);
  }

  if (tokenUsage) {
    parts.push(`${tokenUsage.input}${TOKEN_ARROW}${tokenUsage.output} (${tokenUsage.total})`);
  }

  return parts.join(' | ');
}

export const StatusBar: React.FC<StatusBarProps> = ({
  sessionId,
  permissionMode,
  parallel = false,
  provider,
  model,
  tokenUsage,
  currentTool,
  thinking,
  isThinkingActive,
  reasoningMode = thinking ? 'auto' : 'off',
  reasoningCapability,
  isCompacting,
  currentIteration,
  maxIter,
  contextUsage,
  showBusyStatus = true,
}) => {
  const theme = useMemo(() => getTheme('dark'), []);

  // 1: KodaX
  // No background, just primary color bold
  const kodaxDisplay = <Text color={theme.colors.primary} bold>KodaX</Text>;

  // 2: Mode (plan -> blue, accept-edits -> green, auto-in-project -> orange)
  const modeColor = useMemo(() => {
    switch (permissionMode.toLowerCase()) {
      case 'plan': return 'blue';
      case 'accept-edits': return 'green';
      case 'auto-in-project': return theme.colors.warning;
      default: return 'magenta';
    }
  }, [permissionMode, theme]);
  const modeDisplay = <Text color={modeColor}>{permissionMode.toUpperCase()}</Text>;

  // 3: Execution mode
  const executionDisplay = (
    <Text color={parallel ? 'green' : 'gray'}>
      {parallel ? 'parallel' : 'sequential'}
    </Text>
  );

  // 4: Reasoning (OFF/AUTO/BALANCED/DEEP)
  const rModeShort = formatReasoningModeShort(reasoningMode);
  const rCapShort = formatReasoningCapabilityShort(reasoningCapability);
  const reasoningCombined = reasoningCapability ? `${rModeShort}/${rCapShort}` : rModeShort;
  const reasoningColor = getReasoningColor(reasoningMode);
  const reasoningDisplay = <Text color={reasoningColor}>{reasoningCombined}</Text>;

  // 5: Iteration (?? 1/200)
  const iterationDisplay = useMemo(() => {
    if (!currentIteration || !maxIter) return null;
    const ratio = currentIteration / maxIter;
    let color = 'green';
    if (ratio >= 0.8) color = 'red';
    else if (ratio >= 0.5) color = 'yellow';
    return <Text color={color}>{ITERATION_SYMBOL} {currentIteration}/{maxIter}</Text>;
  }, [currentIteration, maxIter]);

  // 6: SessionID + Spinner Tool status
  // e.g., "abcd123 <spinner> Bash (12 chars)"
  const sessionToolDisplay = useMemo(() => {
    const busyStatus = showBusyStatus
      ? formatBusyStatus({
          currentTool,
          isThinkingActive,
          isCompacting,
        })
      : undefined;

    return (
      <Box>
        <Text dimColor>{sessionId}</Text>
        {busyStatus && (
          <>
            <Text dimColor> </Text>
            <Text dimColor>{busyStatus}</Text>
          </>
        )}
      </Box>
    );
  }, [sessionId, currentTool, isThinkingActive, isCompacting, showBusyStatus]);

  // 7: Provider/Model
  const providerModelDisplay = <Text color={theme.colors.secondary}>{provider}/{model}</Text>;

  // 8: Context Usage "24.0k/200.0k ?????????? 12%"
  const contextDisplay = useMemo(() => {
    if (!contextUsage) return null;
    const { currentTokens, contextWindow, triggerPercent } = contextUsage;
    if (contextWindow === 0) return null;

    const percent = Math.round((currentTokens / contextWindow) * 100);
    const currentStr = formatTokenCount(currentTokens);
    const windowStr = formatTokenCount(contextWindow);
    const progressBar = createMiniProgressBar(percent);
    const color = getContextColor(currentTokens, contextWindow, triggerPercent);

    return (
      <Text color={color}>
        {currentStr}/{windowStr} {progressBar} {percent}%
      </Text>
    );
  }, [contextUsage]);

  // Optional 9: Token Usage
  const tokenDisplay = useMemo(() => {
    if (!tokenUsage) return null;
    return (
      <Text dimColor>
        {tokenUsage.input}{TOKEN_ARROW}{tokenUsage.output} ({tokenUsage.total})
      </Text>
    );
  }, [tokenUsage]);

  const Separator = () => <Text dimColor> | </Text>;

  return (
    <Box paddingX={1}>
      {/* 1. KodaX */}
      {kodaxDisplay}
      <Separator />

      {/* 2. Permission Mode */}
      {modeDisplay}
      <Separator />

      {/* 3. Execution Mode */}
      {executionDisplay}
      <Separator />

      {/* 4. Reasoning Mode */}
      {reasoningDisplay}

      {/* 5. Iteration */}
      {iterationDisplay && (
        <>
          <Separator />
          {iterationDisplay}
        </>
      )}
      <Separator />

      {/* 6. Session ID + Status */}
      {sessionToolDisplay}
      <Separator />

      {/* 7. Provider/Model */}
      {providerModelDisplay}

      {/* 8. Context Usage */}
      {contextDisplay && (
        <>
          <Separator />
          {contextDisplay}
        </>
      )}

      {/* 9. Token Usage (if present) */}
      {tokenDisplay && (
        <>
          <Separator />
          {tokenDisplay}
        </>
      )}
    </Box>
  );
};

export const SimpleStatusBar: React.FC<{
  permissionMode: string;
  provider: string;
  model: string;
}> = ({ permissionMode, provider, model }) => {
  const theme = useMemo(() => getTheme('dark'), []);

  return (
    <Box>
      <Text color={theme.colors.primary} bold>
        [{permissionMode}]
      </Text>
      <Text dimColor>
        {' '}
        {provider}/{model}
      </Text>
    </Box>
  );
};
