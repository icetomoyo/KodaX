import { describe, expect, it } from "vitest";
import { KeypressParser, parseKeypress } from "./keypress-parser.js";

describe("keypress-parser mouse wheel", () => {
  it("parses SGR mouse wheel up sequences", () => {
    const key = parseKeypress("\x1b[<64;42;10M");

    expect(key.name).toBe("wheelup");
  });

  it("parses SGR mouse wheel down sequences", () => {
    const key = parseKeypress("\x1b[<65;42;10M");

    expect(key.name).toBe("wheeldown");
  });

  it("extracts wheel sequences from the streaming parser", () => {
    const parser = new KeypressParser();
    const events: string[] = [];

    parser.onKeypress((key) => {
      events.push(key.name);
    });

    parser.feed("\x1b[<64;42;10M");
    parser.feed("\x1b[<65;42;10M");

    expect(events).toEqual(["wheelup", "wheeldown"]);
  });
});
