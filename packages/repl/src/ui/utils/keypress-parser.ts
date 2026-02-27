/**
 * KeypressParser - Terminal keypress parser - 终端按键解析器
 *
 * Reference implementation: Gemini CLI keypress.ts - 参考实现: Gemini CLI keypress.ts
 *
 * Resolves Ink useInput Backspace/Delete confusion issue: - 解决 Ink useInput 的 Backspace/Delete 混淆问题：
 * - Ink maps \x7f (ASCII 127) to delete - Ink 将 \x7f (ASCII 127) 映射为 delete
 * - But many terminals (especially Windows) send \x7f for Backspace key - 但很多终端（尤其是 Windows）发送 \x7f 表示 Backspace 键
 * - Real Delete key sends escape sequence \x1b[3~ - 真正的 Delete 键发送转义序列 \x1b[3~
 *
 * This parser's mapping rules (following Gemini CLI): - 本解析器的映射规则（参考 Gemini CLI）：
 * - \b (ASCII 8) → backspace - \b (ASCII 8) → backspace
 * - \x7f (ASCII 127) → backspace (not delete!) - \x7f (ASCII 127) → backspace (不是 delete!)
 * - \x1b[3~ → real delete - \x1b[3~ → 真正的 delete
 */

import type { KeyInfo } from "../types.js";

/**
 * Escape sequence to key name mapping - 转义序列到键名的映射
 */
const ESCAPE_SEQUENCE_MAP: Record<string, Partial<KeyInfo>> = {
  // Arrow keys - 方向键
  "[A": { name: "up" },
  "[B": { name: "down" },
  "[C": { name: "right" },
  "[D": { name: "left" },

  // Shift+arrow keys (some terminals) - Shift+方向键 (某些终端)
  "[1;2A": { name: "up", shift: true },
  "[1;2B": { name: "down", shift: true },
  "[1;2C": { name: "right", shift: true },
  "[1;2D": { name: "left", shift: true },

  // Shift+Enter (CSI u format - modifyOtherKeys) - Shift+Enter (CSI u 格式 - modifyOtherKeys)
  "[13;2u": { name: "return", shift: true },
  "[13;3u": { name: "return", meta: true },  // Alt+Enter
  "[13;5u": { name: "return", ctrl: true },  // Ctrl+Enter

  // Home/End - Home/End
  "[H": { name: "home" },
  "[F": { name: "end" },
  "[1~": { name: "home" },
  "[4~": { name: "end" },
  "[7~": { name: "home" }, // rxvt
  "[8~": { name: "end" }, // rxvt

  // Insert/Delete - Insert/Delete
  "[2~": { name: "insert" },
  "[3~": { name: "delete" }, // 真正的 Delete 键

  // Page Up/Down - Page Up/Down
  "[5~": { name: "pageup" },
  "[6~": { name: "pagedown" },

  // F1-F12 - F1-F12
  "[11~": { name: "f1" },
  "[12~": { name: "f2" },
  "[13~": { name: "f3" },
  "[14~": { name: "f4" },
  "[15~": { name: "f5" },
  "[17~": { name: "f6" },
  "[18~": { name: "f7" },
  "[19~": { name: "f8" },
  "[20~": { name: "f9" },
  "[21~": { name: "f10" },
  "[23~": { name: "f11" },
  "[24~": { name: "f12" },

  // xterm/gnome ESC O letter - xterm/gnome ESC O letter
  OP: { name: "f1" },
  OQ: { name: "f2" },
  OR: { name: "f3" },
  OS: { name: "f4" },
  OA: { name: "up" },
  OB: { name: "down" },
  OC: { name: "right" },
  OD: { name: "left" },
  OH: { name: "home" },
  OF: { name: "end" },
};

/**
 * Regex for escape sequences with modifier keys - 带修饰键的转义序列正则
 * Matches: ESC [ number ; modifier ~ or ESC [ 1 ; modifier letter - 匹配: ESC [ number ; modifier ~ 或 ESC [ 1 ; modifier letter
 */
const MODIFIED_KEY_RE = /^\x1b\[([0-9]+);?([0-9]+)?([~A-Za-z])?/;

/**
 * Parse modifier key bitmask - 解析修饰键位掩码
 * modifier: 1=shift, 2=alt, 4=ctrl, 8=meta - modifier: 1=shift, 2=alt, 4=ctrl, 8=meta
 */
function parseModifier(modifier: number): { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean } {
  return {
    shift: (modifier & 1) !== 0,
    alt: (modifier & 2) !== 0,
    ctrl: (modifier & 4) !== 0,
    meta: (modifier & 8) !== 0,
  };
}

/**
 * Parse single keypress sequence - 解析单个按键序列
 *
 * @param sequence - Raw input sequence - 原始输入序列
 * @returns Parsed KeyInfo object - 解析后的 KeyInfo 对象
 */
export function parseKeypress(sequence: string): KeyInfo {
  const key: KeyInfo = {
    name: "",
    sequence,
    ctrl: false,
    meta: false,
    shift: false,
    insertable: false,
  };

  if (!sequence || sequence.length === 0) {
    return key;
  }

  // 1. Enter (CR) - 1. 回车 (CR)
  if (sequence === "\r") {
    key.name = "return";
    return key;
  }

  // 2. Line feed (LF) - Ctrl+J or terminal-sent newline - 2. 换行 (LF) - Ctrl+J 或终端发送的换行
  // Reference Gemini CLI: Ctrl+J is used to insert newline - 参考 Gemini CLI: Ctrl+J 用于插入换行
  if (sequence === "\n") {
    key.name = "newline";  // Use "newline" to distinguish from "return" - 使用 "newline" 区分于 "return"
    return key;
  }

  // 3. Tab - 3. Tab
  if (sequence === "\t") {
    key.name = "tab";
    return key;
  }

  // 4. Backspace (critical fix!) - 4. Backspace (关键修复!)
  // Both \b (ASCII 8) and \x7f (ASCII 127) should be recognized as backspace - \b (ASCII 8) 或 \x7f (ASCII 127) 都应识别为 backspace
  // This is the key to solving Windows terminal issues - 这是解决 Windows 终端问题的关键
  if (sequence === "\b" || sequence === "\x7f") {
    key.name = "backspace";
    return key;
  }

  // Alt+Backspace - Alt+Backspace
  if (sequence === "\x1b\b" || sequence === "\x1b\x7f") {
    key.name = "backspace";
    key.meta = true;
    return key;
  }

  // Shift+Enter / Alt+Enter (some terminals send \x1b\r or \x1b\n) - Shift+Enter / Alt+Enter (某些终端发送 \x1b\r 或 \x1b\n)
  if (sequence === "\x1b\r" || sequence === "\x1b\n") {
    key.name = sequence === "\x1b\r" ? "return" : "enter";
    key.shift = true; // Mark as Shift+Enter - 标记为 Shift+Enter
    return key;
  }

  // 5. Escape - 5. Escape
  if (sequence === "\x1b" || sequence === "\x1b\x1b") {
    key.name = "escape";
    key.meta = sequence.length === 2;
    return key;
  }

  // 6. Space - 6. Space
  if (sequence === " " || sequence === "\x1b ") {
    key.name = "space";
    key.meta = sequence.length === 2;
    key.insertable = !key.meta; // Regular space is insertable - 普通空格可插入
    return key;
  }

  // 7. Ctrl+letter (ASCII 1-26) - 7. Ctrl+字母 (ASCII 1-26)
  if (sequence.length === 1 && sequence.charCodeAt(0) <= 26) {
    key.name = String.fromCharCode(sequence.charCodeAt(0) + 96); // 1->a, 2->b, etc.
    key.ctrl = true;
    return key;
  }

  // 8. Digits (0-9) - insertable - 8. 数字 (0-9) - 可插入
  if (sequence.length === 1 && sequence >= "0" && sequence <= "9") {
    key.name = sequence;
    key.insertable = true;
    return key;
  }

  // 9. Lowercase letters - insertable - 9. 小写字母 - 可插入
  if (sequence.length === 1 && sequence >= "a" && sequence <= "z") {
    key.name = sequence;
    key.insertable = true;
    return key;
  }

  // 10. Uppercase letters (Shift+letter) - insertable - 10. 大写字母 (Shift+字母) - 可插入
  if (sequence.length === 1 && sequence >= "A" && sequence <= "Z") {
    key.name = sequence.toLowerCase();
    key.shift = true;
    key.insertable = true;
    return key;
  }

  // 11. Printable characters - insertable - 11. 可打印字符 - 可插入
  if (sequence.length === 1 && sequence.charCodeAt(0) >= 32) {
    key.name = sequence;
    key.insertable = true;
    return key;
  }

  // 12. Escape sequences (starting with ESC) - 12. 转义序列 (以 ESC 开头)
  if (sequence.startsWith("\x1b")) {
    const afterEsc = sequence.slice(1);

    // Alt+single character - insertable (except for modifier keys) - Alt+单字符 - 可插入（除了修饰键）
    if (afterEsc.length === 1) {
      key.meta = true;
      if (afterEsc >= "a" && afterEsc <= "z") {
        key.name = afterEsc;
        key.insertable = true;
      } else if (afterEsc >= "A" && afterEsc <= "Z") {
        key.name = afterEsc.toLowerCase();
        key.shift = true;
        key.insertable = true;
      } else if (afterEsc.charCodeAt(0) >= 32) {
        key.name = afterEsc;
        key.insertable = true;
      }
      return key;
    }

    // Check for modified sequences - 检查带修饰键的序列
    const modifiedMatch = sequence.match(MODIFIED_KEY_RE);
    if (modifiedMatch) {
      const [, codeNum, modifierStr, suffix] = modifiedMatch;
      const effectiveSuffix = suffix || "~";

      // First try direct lookup with afterEsc (for CSI u format like [13;2u) - 首先尝试直接用 afterEsc 查找（用于 CSI u 格式如 [13;2u）
      const directCode = afterEsc;
      const directMapped = ESCAPE_SEQUENCE_MAP[directCode];
      if (directMapped) {
        Object.assign(key, directMapped);
        return key;
      }

      // Then try simplified format lookup (for [1;2A arrow key format) - 然后尝试用简化格式查找（用于 [1;2A 等方向键格式）
      const code = "[" + codeNum + effectiveSuffix + "]";
      const baseKey = ESCAPE_SEQUENCE_MAP[code];
      if (baseKey && baseKey.name) {
        key.name = baseKey.name;

        // Parse modifier keys - 解析修饰键
        if (modifierStr) {
          const modifier = parseInt(modifierStr, 10) - 1;
          const mods = parseModifier(modifier);
          Object.assign(key, mods);
        }
        return key;
      }
    }

    // Look up regular escape sequences - 查找普通转义序列
    const escCode = afterEsc;
    const mapped = ESCAPE_SEQUENCE_MAP[escCode];
    if (mapped) {
      Object.assign(key, mapped);
      return key;
    }

    // Double ESC (Alt key in some terminals) - 双 ESC (某些终端的 Alt 键)
    if (sequence.startsWith("\x1b\x1b")) {
      key.meta = true;
      const subSequence = "\x1b" + sequence.slice(2);
      const subKey = parseKeypress(subSequence);
      key.name = subKey.name;
      return key;
    }
  }

  return key;
}

/**
 * Keypress parser class - 按键解析器类
 *
 * Used for processing terminal input streams, correctly parsing multi-byte escape sequences - 用于处理终端输入流，正确解析多字节转义序列
 *
 * Reference Gemini CLI's emitKeys implementation: - 参考 Gemini CLI 的 emitKeys 实现：
 * - Does not wait for more data, processes immediately - 不等待更多数据，立即处理
 * - Uses external timeout mechanism to handle incomplete ESC sequences - 通过外部超时机制处理不完整的 ESC 序列
 */
export class KeypressParser {
  private buffer: string = "";
  private listeners: Array<(key: KeyInfo) => void> = [];
  /** Whether in timeout flush mode (handling incomplete ESC sequences) - 是否处于超时刷新模式（处理不完整的 ESC 序列） */
  private flushing = false;

  /**
   * Add keypress listener - 添加按键监听器
   */
  onKeypress(listener: (key: KeyInfo) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Process input data - 处理输入数据
   *
   * @param data - Raw input data (can be Buffer or string) - 原始输入数据（可以是 Buffer 或 string）
   * @param flush - Whether in timeout flush mode (handling incomplete ESC sequences) - 是否为超时刷新模式（处理不完整的 ESC 序列）
   */
  feed(data: Buffer | string, flush = false): void {
    const input = typeof data === "string" ? data : data.toString("utf8");
    this.buffer += input;
    this.flushing = flush;
    this.processBuffer();
  }

  /**
   * Process data in buffer - 处理缓冲区中的数据
   */
  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const result = this.extractNextSequence();
      if (!result) {
        // In flush mode, send directly if there's still data - 在刷新模式下，如果还有数据，直接发送
        if (this.flushing && this.buffer.length > 0) {
          const sequence = this.buffer;
          this.buffer = "";
          const key = parseKeypress(sequence);
          this.emit(key);
        }
        break;
      }

      const { sequence, remaining } = result;
      this.buffer = remaining;

      const key = parseKeypress(sequence);
      this.emit(key);
    }
  }

  /**
   * Extract next complete keypress sequence from buffer - 从缓冲区提取下一个完整的按键序列
   *
   * Key improvement (following Gemini CLI): - 关键改进（参考 Gemini CLI）：
   * - Does not wait for more data, immediately processes known complete sequences - 不等待更多数据，立即处理已知的完整序列
   * - For incomplete ESC sequences, relies on external timeout mechanism calling feed("", true) to flush - 对于不完整的 ESC 序列，依赖外部超时机制调用 feed("", true) 刷新
   */
  private extractNextSequence(): { sequence: string; remaining: string } | null {
    if (this.buffer.length === 0) {
      return null;
    }

    const firstChar = this.buffer[0];

    // Non-ESC character - single byte, return immediately - 非 ESC 字符 - 单字节，立即返回
    if (firstChar !== "\x1b") {
      return {
        sequence: this.buffer[0]!,
        remaining: this.buffer.slice(1),
      };
    }

    // Escape sequence starting with ESC - ESC 开头的转义序列
    if (this.buffer.length === 1) {
      // Only ESC
      if (this.flushing) {
        // Timeout flush mode: send ESC immediately - 超时刷新模式：立即发送 ESC
        return {
          sequence: this.buffer,
          remaining: "",
        };
      }
      // Non-flush mode: wait for timeout or more data - 非刷新模式：等待超时或更多数据
      return null;
    }

    const secondChar = this.buffer[1];

    // ESC + single character (Alt combination) - return immediately - ESC + 单字符 (Alt 组合) - 立即返回
    if (secondChar !== "[" && secondChar !== "O") {
      return {
        sequence: this.buffer.slice(0, 2),
        remaining: this.buffer.slice(2),
      };
    }

    // Escape sequence starting with ESC [ or ESC O - ESC [ 或 ESC O 开头的转义序列
    // Find sequence end position - 查找序列结束位置
    let endPos = 2;
    while (endPos < this.buffer.length) {
      const ch = this.buffer[endPos];
      if (!ch) break;

      // Digits and semicolon continue sequence - 数字和分号继续序列
      if ((ch >= "0" && ch <= "9") || ch === ";") {
        endPos++;
        continue;
      }

      // Letter or ~ ends sequence - 字母或 ~ 结束序列
      if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "~") {
        endPos++;
        break;
      }

      // Other characters end sequence - 其他字符结束
      break;
    }

    // Check if complete escape sequence was found - 检查是否找到完整的转义序列
    const lastChar = this.buffer[endPos - 1];
    const isComplete = lastChar && (
      (lastChar >= "A" && lastChar <= "Z") ||
      (lastChar >= "a" && lastChar <= "z") ||
      lastChar === "~"
    );

    if (isComplete) {
      // Complete escape sequence, return immediately - 完整的转义序列，立即返回
      return {
        sequence: this.buffer.slice(0, endPos),
        remaining: this.buffer.slice(endPos),
      };
    }

    // Incomplete escape sequence - 不完整的转义序列
    if (this.flushing) {
      // Timeout flush mode: return current buffer - 超时刷新模式：返回当前缓冲区
      return {
        sequence: this.buffer.slice(0, endPos),
        remaining: this.buffer.slice(endPos),
      };
    }

    // Non-flush mode: wait for more data or timeout - 非刷新模式：等待更多数据或超时
    return null;
  }

  /**
   * Emit keypress event to all listeners - 发送按键事件给所有监听器
   */
  private emit(key: KeyInfo): void {
    for (const listener of this.listeners) {
      listener(key);
    }
  }

  /**
   * Clear buffer - 清空缓冲区
   */
  clear(): void {
    this.buffer = "";
  }
}

/**
 * Check if is a function key (non-character input) - 检查是否是功能键（非字符输入）
 */
export function isFunctionKey(key: KeyInfo): boolean {
  const functionKeys = [
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "insert",
    "delete",
    "pageup",
    "pagedown",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
    "tab",
    "return",
    "enter",
    "backspace",
    "escape",
  ];
  return functionKeys.includes(key.name);
}

/**
 * Check if is a printable character - 检查是否是可打印字符
 */
export function isPrintable(key: KeyInfo): boolean {
  if (key.ctrl || key.meta) {
    return false;
  }
  if (isFunctionKey(key)) {
    return false;
  }
  return key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32;
}

/**
 * Get display name of key - 获取按键的显示名称
 */
export function getKeyDisplayName(key: KeyInfo): string {
  const parts: string[] = [];

  if (key.ctrl) parts.push("Ctrl");
  if (key.meta) parts.push("Alt");
  if (key.shift) parts.push("Shift");

  if (key.name) {
    parts.push(key.name.toUpperCase());
  } else if (key.sequence) {
    parts.push(key.sequence);
  }

  return parts.join("+");
}
