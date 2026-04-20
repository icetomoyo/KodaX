import type { TranscriptKeyboardAction } from "./transcript-key-actions.js";

export interface ExecuteTranscriptKeyboardActionOptions {
  action: TranscriptKeyboardAction;
  hasTranscript: boolean;
  isTranscriptMode: boolean;
  pageScrollDelta: number;
  disarmHistorySearchSelection: () => void;
  scrollTranscriptBy: (delta: number) => void;
  closeHistorySearchSurface: () => void;
  backspaceHistorySearchQuery: () => void;
  stepHistorySearchSelection: (direction: "next" | "prev") => void;
  submitHistorySearchSelection: () => void;
  appendHistorySearchQuery: (text: string) => void;
  openHistorySearchSurface: () => void;
  clearTranscriptSelectionFocus: () => void;
  exitTranscriptModeSurface: () => void;
  toggleTranscriptShowAll: () => void;
  scrollTranscriptHome: () => void;
  scrollTranscriptToBottom: () => void;
  cycleTranscriptSelection: (direction: "prev" | "next") => void;
  copySelectedTranscriptText: () => void;
  copySelectedTranscriptItem: () => void;
  copySelectedTranscriptToolInput: () => void;
  toggleSelectedTranscriptDetail: () => void;
  navigateSearchMatch: (direction: "next" | "prev") => void;
  /**
   * FEATURE_058: invoked when the user presses the transcript-mode
   * scrollback-dump shortcut. Implementations exit alternate-screen,
   * write the serialized transcript to the terminal's native scrollback,
   * and re-enter the fullscreen surface.
   */
  dumpTranscriptToScrollback: () => void;
}

export function executeTranscriptKeyboardAction(
  options: ExecuteTranscriptKeyboardActionOptions,
): boolean {
  switch (options.action.kind) {
    case "none":
      return false;
    case "scroll-page-up":
      if (!options.hasTranscript) {
        return true;
      }
      options.disarmHistorySearchSelection();
      options.scrollTranscriptBy(options.pageScrollDelta);
      return true;
    case "close-history-search":
      options.closeHistorySearchSurface();
      return true;
    case "history-search-backspace":
      options.backspaceHistorySearchQuery();
      return true;
    case "history-search-step":
      options.stepHistorySearchSelection(options.action.direction);
      return true;
    case "history-search-submit":
      options.submitHistorySearchSelection();
      return true;
    case "history-search-append":
      options.appendHistorySearchQuery(options.action.text);
      return true;
    case "open-history-search":
      options.openHistorySearchSurface();
      return true;
    case "clear-selection-focus":
      options.clearTranscriptSelectionFocus();
      return true;
    case "exit-transcript":
      options.exitTranscriptModeSurface();
      return true;
    case "toggle-show-all":
      options.toggleTranscriptShowAll();
      return true;
    case "scroll-home":
    case "jump-oldest":
      options.disarmHistorySearchSelection();
      options.scrollTranscriptHome();
      return true;
    case "scroll-page-down":
      options.disarmHistorySearchSelection();
      options.scrollTranscriptBy(-options.pageScrollDelta);
      return true;
    case "scroll-end":
      if (options.isTranscriptMode) {
        options.exitTranscriptModeSurface();
        return true;
      }
      options.scrollTranscriptToBottom();
      return true;
    case "scroll-line-down":
      options.disarmHistorySearchSelection();
      options.scrollTranscriptBy(-1);
      return true;
    case "scroll-line-up":
      options.disarmHistorySearchSelection();
      options.scrollTranscriptBy(1);
      return true;
    case "jump-latest":
      options.scrollTranscriptToBottom();
      return true;
    case "cycle-selection":
      options.cycleTranscriptSelection(options.action.direction);
      return true;
    case "copy-selection":
      options.copySelectedTranscriptText();
      return true;
    case "copy-item":
      options.copySelectedTranscriptItem();
      return true;
    case "copy-tool-input":
      options.copySelectedTranscriptToolInput();
      return true;
    case "toggle-detail":
      options.toggleSelectedTranscriptDetail();
      return true;
    case "search-match-nav":
      options.navigateSearchMatch(options.action.direction);
      return true;
    case "dump-to-scrollback":
      options.dumpTranscriptToScrollback();
      return true;
    default:
      return false;
  }
}
