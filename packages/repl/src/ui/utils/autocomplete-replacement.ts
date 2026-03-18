export type AutocompleteReplacementType =
  | "command"
  | "argument"
  | "file"
  | "skill";

export interface AutocompleteReplacementInput {
  text: string;
  type: AutocompleteReplacementType;
}

export interface AutocompleteReplacement {
  start: number;
  end: number;
  replacement: string;
}

export function buildAutocompleteReplacement(
  input: string,
  cursorOffset: number,
  completion: AutocompleteReplacementInput
): AutocompleteReplacement {
  const safeCursorOffset = Math.max(0, Math.min(cursorOffset, input.length));
  const beforeCursor = input.slice(0, safeCursorOffset);

  if (completion.type === "command" || completion.type === "skill") {
    const lastSlashIndex = beforeCursor.lastIndexOf("/");
    return {
      start: lastSlashIndex === -1 ? 0 : lastSlashIndex,
      end: safeCursorOffset,
      replacement: completion.text,
    };
  }

  if (completion.type === "argument") {
    const match = beforeCursor.match(/\S+$/);
    return {
      start: match ? safeCursorOffset - match[0].length : 0,
      end: safeCursorOffset,
      replacement: completion.text,
    };
  }

  const lastAtIndex = beforeCursor.lastIndexOf("@");
  return {
    start: lastAtIndex === -1 ? 0 : lastAtIndex,
    end: safeCursorOffset,
    replacement: completion.text,
  };
}
