import React from "react";
import { Box } from "../tui.js";
import type { MessageListProps } from "./MessageList.js";
import { MessageList } from "./MessageList.js";

export interface PromptTranscriptSurfaceProps extends Omit<
  MessageListProps,
  | "animateSpinners"
  | "showFullThinking"
  | "showDetailedTools"
  | "showLiveProgressRows"
  | "selectedItemId"
  | "expandedItemKeys"
  | "isThinking"
  | "thinkingCharCount"
  | "thinkingContent"
  | "streamingResponse"
  | "currentTool"
  | "activeToolCalls"
  | "toolInputCharCount"
  | "toolInputContent"
  | "iterationHistory"
  | "currentIteration"
  | "isCompacting"
  | "agentMode"
  | "managedPhase"
  | "managedHarnessProfile"
  | "managedWorkerTitle"
  | "managedRound"
  | "managedMaxRounds"
  | "managedGlobalWorkBudget"
  | "managedBudgetUsage"
  | "managedBudgetApprovalRequired"
  | "lastLiveActivityLabel"
> {
  banner?: React.ReactNode;
}

export const PromptTranscriptSurface: React.FC<PromptTranscriptSurfaceProps> = ({
  banner,
  ...messageListProps
}) => {
  return (
    <Box flexDirection="column">
      {banner}
      <MessageList
        {...messageListProps}
        animateSpinners={false}
        showFullThinking={false}
        showDetailedTools={false}
        showLiveProgressRows={false}
      />
    </Box>
  );
};
