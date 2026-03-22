export interface HelpBarSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

export const HELP_BAR_SEGMENTS: HelpBarSegment[] = [
  { text: "? toggle help", bold: true },
  { text: "  " },
  { text: "Ctrl+T reasoning" },
  { text: "  " },
  { text: "Ctrl+O mode" },
  { text: "  " },
  { text: "Ctrl+P parallel" },
  { text: "  " },
  { text: "Ctrl+C interrupt" },
  { text: "  " },
  { text: "PgUp review" },
  { text: "  " },
  { text: "/", color: "cyan" },
  { text: " commands" },
  { text: "  " },
  { text: "@", color: "cyan" },
  { text: " files" },
];

export const HELP_BAR_TEXT = HELP_BAR_SEGMENTS.map((segment) => segment.text).join("");
export const HELP_BAR_HORIZONTAL_PADDING = 2;
export const HELP_BAR_SPACER_ROWS = 1;
export const MESSAGE_LIST_VERTICAL_PADDING_ROWS = 2;
