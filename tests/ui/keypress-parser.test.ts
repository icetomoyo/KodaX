/**
 * KeypressParser Tests
 *
 * Tests for the terminal keypress parser including CRLF handling for Windows paste.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseKeypress,
  KeypressParser,
  isFunctionKey,
  isPrintable,
  getKeyDisplayName,
} from "@kodax/repl";

describe("parseKeypress", () => {
  describe("CRLF handling (Issue 075)", () => {
    it("should parse CRLF (\\r\\n) as newline", () => {
      const key = parseKeypress("\r\n");
      expect(key.name).toBe("newline");
      expect(key.sequence).toBe("\r\n");
      expect(key.ctrl).toBe(false);
      expect(key.meta).toBe(false);
    });

    it("should parse single CR (\\r) as return", () => {
      const key = parseKeypress("\r");
      expect(key.name).toBe("return");
      expect(key.sequence).toBe("\r");
    });

    it("should parse single LF (\\n) as newline", () => {
      const key = parseKeypress("\n");
      expect(key.name).toBe("newline");
      expect(key.sequence).toBe("\n");
    });
  });

  describe("basic keys", () => {
    it("should parse Tab", () => {
      const key = parseKeypress("\t");
      expect(key.name).toBe("tab");
    });

    it("should parse Backspace (\\b)", () => {
      const key = parseKeypress("\b");
      expect(key.name).toBe("backspace");
    });

    it("should parse Backspace (\\x7f)", () => {
      const key = parseKeypress("\x7f");
      expect(key.name).toBe("backspace");
    });

    it("should parse Escape", () => {
      const key = parseKeypress("\x1b");
      expect(key.name).toBe("escape");
    });
  });

  describe("arrow keys", () => {
    it("should parse up arrow", () => {
      const key = parseKeypress("\x1b[A");
      expect(key.name).toBe("up");
    });

    it("should parse down arrow", () => {
      const key = parseKeypress("\x1b[B");
      expect(key.name).toBe("down");
    });

    it("should parse right arrow", () => {
      const key = parseKeypress("\x1b[C");
      expect(key.name).toBe("right");
    });

    it("should parse left arrow", () => {
      const key = parseKeypress("\x1b[D");
      expect(key.name).toBe("left");
    });
  });

  describe("printable characters", () => {
    it("should parse lowercase letters as insertable", () => {
      const key = parseKeypress("a");
      expect(key.name).toBe("a");
      expect(key.insertable).toBe(true);
    });

    it("should parse uppercase letters as insertable with shift", () => {
      const key = parseKeypress("A");
      expect(key.name).toBe("a");
      expect(key.shift).toBe(true);
      expect(key.insertable).toBe(true);
    });

    it("should parse digits as insertable", () => {
      const key = parseKeypress("5");
      expect(key.name).toBe("5");
      expect(key.insertable).toBe(true);
    });

    it("should parse space as insertable", () => {
      const key = parseKeypress(" ");
      expect(key.name).toBe("space");
      expect(key.insertable).toBe(true);
    });
  });

  describe("Ctrl combinations", () => {
    it("should parse Ctrl+A", () => {
      const key = parseKeypress("\x01");
      expect(key.name).toBe("a");
      expect(key.ctrl).toBe(true);
    });

    it("should parse Ctrl+C", () => {
      const key = parseKeypress("\x03");
      expect(key.name).toBe("c");
      expect(key.ctrl).toBe(true);
    });
  });
});

describe("KeypressParser class", () => {
  let parser: KeypressParser;
  let receivedKeys: ReturnType<typeof parseKeypress>[];

  beforeEach(() => {
    parser = new KeypressParser();
    receivedKeys = [];
    parser.onKeypress((key) => {
      receivedKeys.push(key);
    });
  });

  describe("CRLF handling (Issue 075)", () => {
    it("should extract CRLF as single sequence", () => {
      parser.feed("Hello\r\nWorld");
      expect(receivedKeys).toHaveLength(11); // H,e,l,l,o,CRLF,W,o,r,l,d
      expect(receivedKeys[5]!.name).toBe("newline");
      expect(receivedKeys[5]!.sequence).toBe("\r\n");
    });

    it("should handle multiple CRLF sequences", () => {
      parser.feed("Line1\r\nLine2\r\nLine3");
      const newlineKeys = receivedKeys.filter((k) => k.name === "newline");
      expect(newlineKeys).toHaveLength(2);
    });

    it("should handle CRLF at buffer start", () => {
      parser.feed("\r\n");
      expect(receivedKeys).toHaveLength(1);
      expect(receivedKeys[0]!.name).toBe("newline");
      expect(receivedKeys[0]!.sequence).toBe("\r\n");
    });

    it("should handle CRLF at buffer end", () => {
      parser.feed("text\r\n");
      expect(receivedKeys).toHaveLength(5); // t,e,x,t,CRLF
      expect(receivedKeys[4]!.name).toBe("newline");
    });

    it("should handle CRLF split across feed() calls", () => {
      // Simulate \r and \n arriving in separate chunks (Windows terminal paste)
      // 模拟 \r 和 \n 在分开的数据块中到达（Windows 终端粘贴）
      parser.feed("Line1\r");
      // At this point, \r is waiting for potential \n
      expect(receivedKeys).toHaveLength(5); // L,i,n,e,1 (no CR yet)
      parser.feed("\nLine2");
      // Now CRLF should be processed together
      expect(receivedKeys).toHaveLength(11); // L,i,n,e,1,CRLF,L,i,n,e,2
      expect(receivedKeys[5]!.name).toBe("newline");
      expect(receivedKeys[5]!.sequence).toBe("\r\n");
    });

    it("should handle lone CR with flush (Enter key press)", () => {
      // Simulate Enter key press: \r followed by timeout flush
      // 模拟 Enter 键按下：\r 后跟超时刷新
      parser.feed("\r");
      // \r is waiting for potential \n
      expect(receivedKeys).toHaveLength(0);
      // Flush triggers timeout processing
      parser.feed("", true);
      // Now \r should be processed as "return"
      expect(receivedKeys).toHaveLength(1);
      expect(receivedKeys[0]!.name).toBe("return");
      expect(receivedKeys[0]!.sequence).toBe("\r");
    });
  });

  describe("normal processing", () => {
    it("should process single characters", () => {
      parser.feed("abc");
      expect(receivedKeys).toHaveLength(3);
      expect(receivedKeys.map((k) => k.name)).toEqual(["a", "b", "c"]);
    });

    it("should process escape sequences", () => {
      parser.feed("\x1b[A"); // Up arrow
      expect(receivedKeys).toHaveLength(1);
      expect(receivedKeys[0]!.name).toBe("up");
    });
  });
});

describe("isFunctionKey", () => {
  it("should identify arrow keys as function keys", () => {
    expect(isFunctionKey({ name: "up", sequence: "" } as any)).toBe(true);
    expect(isFunctionKey({ name: "down", sequence: "" } as any)).toBe(true);
  });

  it("should identify return as function key", () => {
    expect(isFunctionKey({ name: "return", sequence: "" } as any)).toBe(true);
  });

  it("should not identify regular letters as function keys", () => {
    expect(isFunctionKey({ name: "a", sequence: "a" } as any)).toBe(false);
  });
});

describe("isPrintable", () => {
  it("should identify regular characters as printable", () => {
    const key = { name: "a", sequence: "a", ctrl: false, meta: false } as any;
    expect(isPrintable(key)).toBe(true);
  });

  it("should not identify ctrl combinations as printable", () => {
    const key = { name: "a", sequence: "\x01", ctrl: true, meta: false } as any;
    expect(isPrintable(key)).toBe(false);
  });
});

describe("getKeyDisplayName", () => {
  it("should format simple key", () => {
    const key = { name: "a", sequence: "a", ctrl: false, meta: false, shift: false } as any;
    expect(getKeyDisplayName(key)).toBe("A");
  });

  it("should format ctrl key", () => {
    const key = { name: "c", sequence: "\x03", ctrl: true, meta: false, shift: false } as any;
    expect(getKeyDisplayName(key)).toBe("Ctrl+C");
  });

  it("should format shift key", () => {
    const key = { name: "a", sequence: "A", ctrl: false, meta: false, shift: true } as any;
    expect(getKeyDisplayName(key)).toBe("Shift+A");
  });
});
