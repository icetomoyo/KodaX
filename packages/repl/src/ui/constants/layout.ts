import { DEFAULT_SHORTCUTS } from "../shortcuts/defaultShortcuts.js";
import { getShortcutsRegistry } from "../shortcuts/ShortcutsRegistry.js";
import type {
  ShortcutActionId,
  ShortcutCategory,
  ShortcutDefinition,
} from "../shortcuts/types.js";

export interface HelpBarSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

export interface HelpMenuItem {
  id: string;
  label: string;
}

export interface HelpMenuSection {
  id: string;
  title: string;
  items: HelpMenuItem[];
}

const HELP_BAR_PINNED_SHORTCUTS: Array<{
  id: ShortcutActionId;
  label: string;
  bold?: boolean;
}> = [
  { id: "showHelp", label: "toggle help", bold: true },
  { id: "toggleThinking", label: "reasoning" },
  { id: "toggleTranscriptMode", label: "transcript" },
  { id: "togglePermissionMode", label: "mode" },
  { id: "toggleAgentMode", label: "AMA/SA" },
  { id: "interrupt", label: "interrupt" },
];

const HELP_MENU_CATEGORY_ORDER: ShortcutCategory[] = [
  "global",
  "mode",
  "navigation",
  "editing",
];

const HELP_MENU_SHORTCUT_IDS_BY_CATEGORY: Record<ShortcutCategory, ShortcutActionId[]> = {
  global: ["showHelp", "interrupt"],
  mode: [
    "toggleThinking",
    "toggleTranscriptMode",
    "togglePermissionMode",
    "toggleAgentMode",
  ],
  navigation: [
    "openTranscriptSearch",
    "historyUp",
    "historyDown",
    "moveToStart",
    "moveToEnd",
  ],
  editing: [
    "acceptCompletion",
    "cancelInput",
    "newline",
    "killLineRight",
    "killLineLeft",
    "deleteWordLeft",
  ],
};

const HELP_MENU_CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  global: "Global",
  mode: "Modes",
  navigation: "Navigation",
  editing: "Editing",
};

const TRANSCRIPT_HELP_SECTION: HelpMenuSection = {
  id: "transcript",
  title: "Transcript",
  items: [
    { id: "mode", label: "Ctrl+O transcript mode" },
    { id: "search", label: "Ctrl+F search transcript" },
    { id: "browse", label: "PgUp/PgDn/j/k scroll" },
    { id: "match", label: "n/N next match" },
    { id: "latest", label: "End back to live" },
    { id: "exit", label: "q or Esc back to live" },
  ],
};

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

function buildMenuItemLabel(definition: ShortcutDefinition): string {
  const binding = resolveShortcutBindingLabel(definition.id) ?? definition.id;
  return `${binding} ${definition.name}`;
}

function resolveShortcutDefinition(id: ShortcutActionId): ShortcutDefinition | undefined {
  const registry = getShortcutsRegistry();
  const registered = registry.getAllShortcuts().find((shortcut) => shortcut.definition.id === id);
  return registered?.definition ?? DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === id);
}

export function buildHelpMenuSections(): HelpMenuSection[] {
  const shortcutSections = HELP_MENU_CATEGORY_ORDER.map((category) => {
    const items = HELP_MENU_SHORTCUT_IDS_BY_CATEGORY[category]
      .map((id) => resolveShortcutDefinition(id))
      .filter((definition): definition is ShortcutDefinition => Boolean(definition))
      .map((definition) => ({
        id: definition.id,
        label: buildMenuItemLabel(definition),
      }));

    return {
      id: category,
      title: HELP_MENU_CATEGORY_LABELS[category],
      items,
    } satisfies HelpMenuSection;
  }).filter((section) => section.items.length > 0);

  return [...shortcutSections, TRANSCRIPT_HELP_SECTION];
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
    { text: "Ctrl+O transcript" },
    { text: "  " },
    { text: "Ctrl+W/K/U edit" },
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
  const shortcutStrip = buildHelpBarSegments().map((segment) => segment.text).join("");
  const sectionStrip = buildHelpMenuSections()
    .map((section) => `${section.title}: ${section.items.map((item) => item.label).join(" | ")}`)
    .join("  ");
  return `${shortcutStrip}  ${sectionStrip}`.trim();
}

export const HELP_BAR_HORIZONTAL_PADDING = 2;
export const HELP_BAR_SPACER_ROWS = 1;
export const HELP_MENU_CHROME_ROWS = 4;
export const MESSAGE_LIST_VERTICAL_PADDING_ROWS = 2;
