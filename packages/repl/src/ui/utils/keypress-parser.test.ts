import { describe, expect, it } from "vitest";
import { KeypressParser, parseKeypress } from "./keypress-parser.js";

describe("keypress-parser mouse wheel", () => {
  it("parses SGR mouse wheel up sequences", () => {
    const key = parseKeypress("\x1b[<64;42;10M");

    expect(key.name).toBe("wheelup");
    expect(key.mouse).toEqual({
      action: "wheel",
      button: "wheelup",
      column: 42,
      row: 10,
    });
  });

  it("parses SGR mouse wheel down sequences", () => {
    const key = parseKeypress("\x1b[<65;42;10M");

    expect(key.name).toBe("wheeldown");
    expect(key.mouse).toEqual({
      action: "wheel",
      button: "wheeldown",
      column: 42,
      row: 10,
    });
  });

  it("parses SGR mouse press and release with coordinates", () => {
    const press = parseKeypress("\x1b[<0;12;7M");
    const release = parseKeypress("\x1b[<0;12;7m");

    expect(press).toMatchObject({
      name: "mouse",
      mouse: {
        action: "press",
        button: "left",
        column: 12,
        row: 7,
      },
    });
    expect(release).toMatchObject({
      name: "mouse",
      mouse: {
        action: "release",
        button: "left",
        column: 12,
        row: 7,
      },
    });
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
