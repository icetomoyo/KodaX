/**
 * Components 导出
 */

export { TextInput, SingleLineTextInput } from "./TextInput.js";
export type { TextInputProps } from "./TextInput.js";

export { InputPrompt, SimpleInputPrompt } from "./InputPrompt.js";

export { StatusBar, SimpleStatusBar } from "./StatusBar.js";

export { MessageList, SimpleMessageDisplay, HistoryItemRenderer } from "./MessageList.js";
export type { MessageListProps, HistoryItemRendererProps } from "./MessageList.js";

export { ToolGroup, ToolCallDisplay, ToolStatusBadge, ToolProgressBar } from "./ToolGroup.js";
export type { ToolGroupProps, ToolCallDisplayProps, ToolStatusBadgeProps, ToolProgressBarProps } from "./ToolGroup.js";

export {
  LoadingIndicator,
  ThinkingIndicator,
  Spinner,
  DotsIndicator,
  ProgressIndicator,
} from "./LoadingIndicator.js";
export type {
  LoadingIndicatorProps,
  ThinkingIndicatorProps,
  SpinnerProps,
  DotsIndicatorProps,
  ProgressIndicatorProps,
  LoadingIndicatorType,
} from "./LoadingIndicator.js";

export { SuggestionsDisplay } from "./SuggestionsDisplay.js";
export type { SuggestionsDisplayProps } from "./SuggestionsDisplay.js";

export { PendingInputsIndicator } from "./PendingInputsIndicator.js";
export type { PendingInputsIndicatorProps } from "./PendingInputsIndicator.js";

export { FullscreenTranscriptLayout } from "./FullscreenTranscriptLayout.js";
export type { FullscreenTranscriptLayoutProps } from "./FullscreenTranscriptLayout.js";

export { TranscriptViewport } from "./TranscriptViewport.js";
export type { TranscriptViewportProps } from "./TranscriptViewport.js";

export { PromptComposer } from "./PromptComposer.js";
export type { PromptComposerProps } from "./PromptComposer.js";

export { PromptFooter, PromptFooterLeft, PromptFooterRight } from "./PromptFooter.js";
export type { PromptFooterProps, PromptFooterLeftProps, PromptFooterRightProps } from "./PromptFooter.js";

export { PromptSuggestionsSurface } from "./PromptSuggestionsSurface.js";
export type { PromptSuggestionsSurfaceProps } from "./PromptSuggestionsSurface.js";

export { DialogSurface } from "./DialogSurface.js";
export type {
  DialogSurfaceProps,
  DialogSurfaceConfirmState,
  DialogSurfaceUIRequestState,
  DialogSurfaceHistorySearchState,
  DialogSelectOption,
} from "./DialogSurface.js";

export { BackgroundTaskBar } from "./BackgroundTaskBar.js";
export type { BackgroundTaskBarProps } from "./BackgroundTaskBar.js";

export { MessageSelector } from "./MessageSelector.js";
export type { MessageSelectorProps } from "./MessageSelector.js";

export { MessageActions } from "./MessageActions.js";
export type { MessageActionsProps } from "./MessageActions.js";
