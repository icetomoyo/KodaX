/**
 * TextBuffer - Text buffer management class - 文本缓冲区管理类
 *
 * Reference implementation: Gemini CLI text-buffer.ts - 参考实现: Gemini CLI text-buffer.ts
 * Supports multi-line text editing, cursor navigation, and Unicode-safe operations - 支持多行文本编辑，光标导航，Unicode 安全操作
 */

import {
  getCodePointLength,
  getVisualWidth,
  splitByCodePoints,
  isWideChar,
} from "./textUtils.js";

export interface CursorPosition {
  row: number; // Logical row number (0-based) - 逻辑行号 (0-based)
  col: number; // Column position (code point index) - 列位置 (code point index)
}

export interface VisualCursor {
  row: number; // Screen row number - 屏幕行号
  col: number; // Visual column position (considering wide characters) - 视觉列位置（考虑宽字符）
}

export interface TextBufferOptions {
  maxHistory?: number;
}

/**
 * Slice string by code point index - 根据 code point 索引截取字符串
 */
function sliceByCodePoints(str: string, start: number, end?: number): string {
  const points = splitByCodePoints(str);
  return points.slice(start, end).join("");
}

export class TextBuffer {
  private _text: string = "";
  private _lines: string[] = [""];
  private _cursor: CursorPosition = { row: 0, col: 0 };
  private _rememberedCol: number = 0; // Remembered column position during vertical movement - 上下移动时记住的列位置

  // History (for undo) - 历史记录 (用于撤销)
  private _history: string[] = [];
  private _historyIndex: number = -1;
  private _maxHistory: number;

  constructor(options: TextBufferOptions = {}) {
    this._maxHistory = options.maxHistory ?? 100;
  }

  // === Getters ===

  get text(): string {
    return this._text;
  }

  get lines(): string[] {
    return [...this._lines];
  }

  get cursor(): CursorPosition {
    return { ...this._cursor };
  }

  get lineCount(): number {
    return this._lines.length;
  }

  get currentLine(): string {
    return this._lines[this._cursor.row] ?? "";
  }

  get isEmpty(): boolean {
    return this._text.length === 0;
  }

  // === Visual Cursor - 视觉光标 ===

  /**
   * Get visual width of current line - 获取当前行的视觉宽度
   */
  get currentLineVisualWidth(): number {
    return getVisualWidth(this.currentLine);
  }

  /**
   * Get visual position of cursor (considering wide characters) - 获取光标的视觉位置（考虑宽字符）
   */
  get visualCursor(): VisualCursor {
    const line = this._lines[this._cursor.row] ?? "";
    const textBeforeCursor = sliceByCodePoints(line, 0, this._cursor.col);
    return {
      row: this._cursor.row,
      col: getVisualWidth(textBeforeCursor),
    };
  }

  /**
   * Get visual width of character at cursor position on current line - 获取当前行在光标位置的字符视觉宽度
   */
  getCharWidthAtCursor(): number {
    const line = this._lines[this._cursor.row] ?? "";
    const chars = splitByCodePoints(line);
    const char = chars[this._cursor.col];
    return char ? (isWideChar(char) ? 2 : 1) : 0;
  }

  /**
   * Convert visual column position to logical column position - 将视觉列位置转换为逻辑列位置
   */
  visualColToLogicalCol(visualCol: number): number {
    const line = this._lines[this._cursor.row] ?? "";
    const chars = splitByCodePoints(line);

    let currentVisualWidth = 0;
    for (let i = 0; i < chars.length; i++) {
      const charWidth = isWideChar(chars[i]!) ? 2 : 1;
      if (currentVisualWidth + charWidth > visualCol) {
        return i;
      }
      currentVisualWidth += charWidth;
    }
    return chars.length;
  }

  /**
   * Move to visual column position - 移动到视觉列位置
   */
  moveToVisualCol(visualCol: number): void {
    this._cursor.col = this.visualColToLogicalCol(visualCol);
    this._rememberedCol = this._cursor.col;
  }

  // === Text Operations - 文本操作 ===

  /**
   * Set entire text content - 设置整个文本内容
   */
  setText(text: string): void {
    this._saveHistory();
    this._text = text;
    this._lines = text.split("\n");
    if (this._lines.length === 0) {
      this._lines = [""];
    }
    this._clampCursor();
  }

  /**
   * Insert text at cursor position - 在光标位置插入文本
   */
  insert(text: string, options?: { paste?: boolean }): void {
    this._saveHistory();

    // If it's a paste operation, insert all content directly - 如果是粘贴操作，直接插入所有内容
    if (options?.paste) {
      this._insertText(text);
      return;
    }

    // Regular input, handle newlines - 普通输入，处理换行
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        this._insertNewline();
      }
      this._insertText(lines[i]);
    }
  }

  /**
   * Insert text on current line - 在当前行插入文本
   */
  private _insertText(text: string): void {
    const line = this._lines[this._cursor.row];
    const before = sliceByCodePoints(line, 0, this._cursor.col);
    const after = sliceByCodePoints(line, this._cursor.col);

    this._lines[this._cursor.row] = before + text + after;
    this._cursor.col += getCodePointLength(text);
    this._rememberedCol = this._cursor.col;
    this._updateText();
  }

  /**
   * Insert newline character - 插入换行符
   */
  newline(): void {
    this._saveHistory();
    this._insertNewline();
  }

  private _insertNewline(): void {
    const line = this._lines[this._cursor.row];
    const before = sliceByCodePoints(line, 0, this._cursor.col);
    const after = sliceByCodePoints(line, this._cursor.col);

    this._lines[this._cursor.row] = before;
    this._lines.splice(this._cursor.row + 1, 0, after);

    this._cursor.row++;
    this._cursor.col = 0;
    this._rememberedCol = 0;
    this._updateText();
  }

  /**
   * Delete character before cursor - 删除光标前的字符
   */
  backspace(): void {
    if (this._cursor.col > 0) {
      // Delete character before cursor on current line - 删除当前行光标前的字符
      this._saveHistory();
      const line = this._lines[this._cursor.row];
      const col = this._cursor.col - 1;
      const before = sliceByCodePoints(line, 0, col);
      const after = sliceByCodePoints(line, this._cursor.col);

      this._lines[this._cursor.row] = before + after;
      this._cursor.col = col;
      this._rememberedCol = this._cursor.col;
      this._updateText();
    } else if (this._cursor.row > 0) {
      // Merge with previous line - 合并到上一行
      this._saveHistory();
      const currentLine = this._lines[this._cursor.row];
      const prevLine = this._lines[this._cursor.row - 1];

      this._cursor.col = getCodePointLength(prevLine);
      this._lines[this._cursor.row - 1] = prevLine + currentLine;
      this._lines.splice(this._cursor.row, 1);
      this._cursor.row--;
      this._rememberedCol = this._cursor.col;
      this._updateText();
    }
  }

  /**
   * Delete character after cursor - 删除光标后的字符
   */
  delete(): void {
    const line = this._lines[this._cursor.row];
    if (this._cursor.col < getCodePointLength(line)) {
      // Delete character after cursor on current line - 删除当前行光标后的字符
      this._saveHistory();
      const before = sliceByCodePoints(line, 0, this._cursor.col);
      const after = sliceByCodePoints(line, this._cursor.col + 1);

      this._lines[this._cursor.row] = before + after;
      this._updateText();
    } else if (this._cursor.row < this._lines.length - 1) {
      // Merge with next line - 合并下一行
      this._saveHistory();
      const nextLine = this._lines[this._cursor.row + 1];

      this._lines[this._cursor.row] = line + nextLine;
      this._lines.splice(this._cursor.row + 1, 1);
      this._updateText();
    }
  }

  // === Cursor Movement - 光标移动 ===

  /**
   * Move cursor - 移动光标
   */
  move(direction: "up" | "down" | "left" | "right" | "home" | "end"): void {
    switch (direction) {
      case "up":
        this._moveUp();
        break;
      case "down":
        this._moveDown();
        break;
      case "left":
        this._moveLeft();
        break;
      case "right":
        this._moveRight();
        break;
      case "home":
        this._moveHome();
        break;
      case "end":
        this._moveEnd();
        break;
    }
  }

  private _moveUp(): void {
    if (this._cursor.row > 0) {
      this._cursor.row--;
      this._clampColumn();
    }
  }

  private _moveDown(): void {
    if (this._cursor.row < this._lines.length - 1) {
      this._cursor.row++;
      this._clampColumn();
    }
  }

  private _moveLeft(): void {
    if (this._cursor.col > 0) {
      this._cursor.col--;
      this._rememberedCol = this._cursor.col;
    } else if (this._cursor.row > 0) {
      // Move to end of previous line - 移动到上一行末尾
      this._cursor.row--;
      this._cursor.col = getCodePointLength(this._lines[this._cursor.row]);
      this._rememberedCol = this._cursor.col;
    }
  }

  private _moveRight(): void {
    const line = this._lines[this._cursor.row];
    if (this._cursor.col < getCodePointLength(line)) {
      this._cursor.col++;
      this._rememberedCol = this._cursor.col;
    } else if (this._cursor.row < this._lines.length - 1) {
      // Move to start of next line - 移动到下一行开头
      this._cursor.row++;
      this._cursor.col = 0;
      this._rememberedCol = 0;
    }
  }

  private _moveHome(): void {
    this._cursor.col = 0;
    this._rememberedCol = 0;
  }

  private _moveEnd(): void {
    this._cursor.col = getCodePointLength(this._lines[this._cursor.row]);
    this._rememberedCol = this._cursor.col;
  }

  /**
   * Clamp column position within current line range using rememberedCol - 限制列位置在当前行范围内，使用 rememberedCol
   */
  private _clampColumn(): void {
    const line = this._lines[this._cursor.row];
    const maxCol = getCodePointLength(line);
    // Use remembered column position, but not beyond current line - 使用记住的列位置，但不超出当前行
    this._cursor.col = Math.min(this._rememberedCol, maxCol);
  }

  /**
   * Clamp cursor to valid range - 限制光标在有效范围内
   */
  private _clampCursor(): void {
    this._cursor.row = Math.max(0, Math.min(this._cursor.row, this._lines.length - 1));
    this._cursor.col = Math.max(
      0,
      Math.min(this._cursor.col, getCodePointLength(this._lines[this._cursor.row]))
    );
    this._rememberedCol = this._cursor.col;
  }

  // === Line Operations - 行操作 ===

  /**
   * Delete content from cursor to end of line (Ctrl+K) - 删除光标到行尾的内容 (Ctrl+K)
   */
  killLineRight(): void {
    const line = this._lines[this._cursor.row];
    if (this._cursor.col < getCodePointLength(line)) {
      this._saveHistory();
      this._lines[this._cursor.row] = sliceByCodePoints(line, 0, this._cursor.col);
      this._updateText();
    }
  }

  /**
   * Delete content from line start to cursor (Ctrl+U) - 删除行首到光标的内容 (Ctrl+U)
   */
  killLineLeft(): void {
    if (this._cursor.col > 0) {
      this._saveHistory();
      const line = this._lines[this._cursor.row];
      this._lines[this._cursor.row] = sliceByCodePoints(line, this._cursor.col);
      this._cursor.col = 0;
      this._rememberedCol = 0;
      this._updateText();
    }
  }

  /**
   * Delete word before cursor (Ctrl+W) - 删除光标前的一个词 (Ctrl+W)
   */
  deleteWordLeft(): void {
    if (this._cursor.col === 0) {
      return;
    }

    this._saveHistory();
    const line = this._lines[this._cursor.row];

    // Find start position of word - 找到词的开始位置
    let wordStart = this._cursor.col - 1;
    const chars = splitByCodePoints(line);

    // Skip whitespace - 跳过空格
    while (wordStart > 0 && /\s/.test(chars[wordStart] ?? "")) {
      wordStart--;
    }
    // Find word boundary - 找到词边界
    while (wordStart > 0 && !/\s/.test(chars[wordStart - 1] ?? "")) {
      wordStart--;
    }

    const before = sliceByCodePoints(line, 0, wordStart);
    const after = sliceByCodePoints(line, this._cursor.col);

    this._lines[this._cursor.row] = before + after;
    this._cursor.col = wordStart;
    this._rememberedCol = this._cursor.col;
    this._updateText();
  }

  // === History - 历史记录 ===

  private _saveHistory(): void {
    // Delete history after current position - 删除当前位置之后的历史
    this._history = this._history.slice(0, this._historyIndex + 1);
    // Add new state - 添加新状态
    this._history.push(this._text);
    // Limit history size - 限制历史大小
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }
    this._historyIndex = this._history.length - 1;
  }

  /**
   * Undo - 撤销
   */
  undo(): boolean {
    if (this._historyIndex > 0) {
      this._historyIndex--;
      this._text = this._history[this._historyIndex] ?? "";
      this._lines = this._text.split("\n");
      if (this._lines.length === 0) {
        this._lines = [""];
      }
      this._clampCursor();
      return true;
    }
    return false;
  }

  /**
   * Redo - 重做
   */
  redo(): boolean {
    if (this._historyIndex < this._history.length - 1) {
      this._historyIndex++;
      this._text = this._history[this._historyIndex] ?? "";
      this._lines = this._text.split("\n");
      if (this._lines.length === 0) {
        this._lines = [""];
      }
      this._clampCursor();
      return true;
    }
    return false;
  }

  // === Utility Methods - 工具方法 ===

  private _updateText(): void {
    this._text = this._lines.join("\n");
  }

  /**
   * Clear buffer - 清空缓冲区
   */
  clear(): void {
    this._saveHistory();
    this._text = "";
    this._lines = [""];
    this._cursor = { row: 0, col: 0 };
    this._rememberedCol = 0;
  }

  /**
   * Get absolute position of cursor in text - 获取光标在文本中的绝对位置
   */
  getAbsoluteOffset(): number {
    let offset = 0;
    for (let i = 0; i < this._cursor.row; i++) {
      offset += (this._lines[i]?.length ?? 0) + 1; // +1 for newline
    }
    // Calculate byte position corresponding to code point position on current line - 计算当前行的 code point 位置对应的字节位置
    const line = this._lines[this._cursor.row] ?? "";
    offset += sliceByCodePoints(line, 0, this._cursor.col).length;
    return offset;
  }

  /**
   * Check if current line ends with backslash - 检查当前行是否以反斜杠结尾
   */
  isLineContinuation(): boolean {
    const line = this._lines[this._cursor.row];
    return line.endsWith("\\");
  }
}
