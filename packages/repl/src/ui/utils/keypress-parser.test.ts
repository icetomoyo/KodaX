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

  it("parses SGR button-motion drag sequences", () => {
    const drag = parseKeypress("\x1b[<32;16;9M");

    expect(drag).toMatchObject({
      name: "mouse",
      mouse: {
        action: "drag",
        button: "left",
        column: 16,
        row: 9,
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

describe("keypress-parser bracketed-paste aggregation (Issue 121)", () => {
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";

  it("aggregates pasted chars into one synthetic event", () => {
    const parser = new KeypressParser();
    const events: { name: string; sequence: string; isPasted?: boolean }[] = [];

    parser.onKeypress((key) => {
      events.push({ name: key.name, sequence: key.sequence, isPasted: key.isPasted });
    });

    // Simulate bracketed paste of "hello world" arriving char-by-char from stdin
    parser.feed(PASTE_START);
    parser.feed("hello world");
    parser.feed(PASTE_END);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "paste",
      sequence: "hello world",
      isPasted: true,
    });
  });

  it("preserves newlines inside a pasted body", () => {
    const parser = new KeypressParser();
    const events: { name: string; sequence: string }[] = [];
    parser.onKeypress((key) => events.push({ name: key.name, sequence: key.sequence }));

    parser.feed(PASTE_START);
    parser.feed("line1\nline2\nline3");
    parser.feed(PASTE_END);

    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe("line1\nline2\nline3");
  });

  it("aggregates a paste body that crosses multiple feed() calls", () => {
    const parser = new KeypressParser();
    const events: { sequence: string }[] = [];
    parser.onKeypress((key) => events.push({ sequence: key.sequence }));

    parser.feed(PASTE_START);
    parser.feed("chunk-1 ");
    parser.feed("chunk-2 ");
    parser.feed("chunk-3");
    parser.feed(PASTE_END);

    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe("chunk-1 chunk-2 chunk-3");
  });

  it("emits nothing on an empty paste (paste_start followed directly by paste_end)", () => {
    const parser = new KeypressParser();
    const events: unknown[] = [];
    parser.onKeypress((key) => events.push(key));

    parser.feed(PASTE_START);
    parser.feed(PASTE_END);

    expect(events).toHaveLength(0);
  });

  it("does not interfere with normal typing outside paste mode", () => {
    const parser = new KeypressParser();
    const events: string[] = [];
    parser.onKeypress((key) => events.push(key.sequence));

    parser.feed("a");
    parser.feed("b");
    parser.feed(PASTE_START);
    parser.feed("paste-body");
    parser.feed(PASTE_END);
    parser.feed("c");

    // "a" "b" are emitted individually (not inside paste). Aggregated paste
    // counts as one event. Then "c" is one more event.
    expect(events).toEqual(["a", "b", "paste-body", "c"]);
  });

  it("aggregated paste exceeds the Layer 1 threshold in a single event", () => {
    const parser = new KeypressParser();
    const events: { sequence: string }[] = [];
    parser.onKeypress((key) => events.push({ sequence: key.sequence }));

    const bigPaste = "x".repeat(5000);

    parser.feed(PASTE_START);
    parser.feed(bigPaste);
    parser.feed(PASTE_END);

    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toHaveLength(5000);
  });
});
