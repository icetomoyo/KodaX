import { DEFAULT_SHORTCUTS } from "../shortcuts/defaultShortcuts.js";
import { getShortcutsRegistry } from "../shortcuts/ShortcutsRegistry.js";
import type { ShortcutActionId } from "../shortcuts/types.js";

export interface HelpBarSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

const HELP_BAR_PINNED_SHORTCUTS: Array<{
  id: ShortcutActionId;
  label: string;
  bold?: boolean;
}> = [
  { id: "showHelp", label: "toggle help", bold: true },
  { id: "toggleThinking", label: "reasoning" },
  { id: "toggleTranscriptVerbosity", label: "verbosity" },
  { id: "togglePermissionMode", label: "mode" },
  { id: "toggleAgentMode", label: "AMA/SA" },
  { id: "toggleParallelMode", label: "parallel" },
  { id: "interrupt", label: "interrupt" },
];

function resolveShortcutBindingLabel(id: ShortcutActionId): string | undefined {
  const registry = getShortcutsRegistry();
  const registered = registry.getAllShortcuts().find((shortcut) => shortcut.definition.id === id);
  if (registered?.effectiveBindings?.length) {
    return registry.formatBindings(registered.effectiveBindings);
  }

  const fallback = DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === id);
  if (fallback?.defaultBindings?.length) {
    return registry.formatBindings(fallback.defaultBindings);
  }

  return undefined;
}

export function buildHelpBarSegments(): HelpBarSegment[] {
  const shortcutSegments = HELP_BAR_PINNED_SHORTCUTS.flatMap((shortcut, index) => {
    const binding = resolveShortcutBindingLabel(shortcut.id) ?? shortcut.id;
    const segments: HelpBarSegment[] = [
      { text: `${binding} ${shortcut.label}`, bold: shortcut.bold },
    ];
    if (index < HELP_BAR_PINNED_SHORTCUTS.length - 1) {
      segments.push({ text: "  " });
    }
    return segments;
  });

  return [
    ...shortcutSegments,
    { text: "  " },
    { text: "PgUp history" },
    { text: "  " },
    { text: "Round=outer Iter=worker" },
    { text: "  " },
    { text: "/", color: "cyan" },
    { text: " commands" },
    { text: "  " },
    { text: "@", color: "cyan" },
    { text: " files" },
  ];
}

export function buildHelpBarText(): string {
  return buildHelpBarSegments().map((segment) => segment.text).join("");
}

export const HELP_BAR_HORIZONTAL_PADDING = 2;
export const HELP_BAR_SPACER_ROWS = 1;
export const HELP_MENU_CHROME_ROWS = 4;
export const MESSAGE_LIST_VERTICAL_PADDING_ROWS = 2;
