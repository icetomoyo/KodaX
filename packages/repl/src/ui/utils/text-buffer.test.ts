import { describe, expect, it } from "vitest";
import { TextBuffer } from "./text-buffer.js";

describe("TextBuffer.replaceRange", () => {
  it("preserves trailing text and places the cursor after the replacement", () => {
    const buffer = new TextBuffer();
    buffer.setText("please /he world");

    buffer.replaceRange(7, 10, "/help");

    expect(buffer.text).toBe("please /help world");
    expect(buffer.getAbsoluteOffset()).toBe(12);
  });

  it("works for mid-line file mention replacements", () => {
    const buffer = new TextBuffer();
    buffer.setText("look @sr today");

    buffer.replaceRange(5, 8, "@src/");

    expect(buffer.text).toBe("look @src/ today");
    expect(buffer.getAbsoluteOffset()).toBe(10);
  });
});
