/**
 * Console Capturer - Console output capturer - 控制台输出捕获器
 *
 * Captures console.log output for correct display in Ink render tree - 捕获 console.log 输出，用于在 Ink 渲染树中正确显示
 * Resolves rendering position issues caused by Ink patchConsole (Issue 040, 045) - 解决 Ink patchConsole 导致的渲染位置问题（Issue 040, 045）
 *
 * Extracted from InkREPL.tsx to improve code organization - 从 InkREPL.tsx 提取以改善代码组织
 */

/**
 * Console capturer - 控制台捕获器
 *
 * Temporarily intercepts console.log to collect output - 临时拦截 console.log，收集输出内容
 * Must call stop() after use to restore original console.log - 使用后必须调用 stop() 恢复原始 console.log
 *
 * @example
 * ```typescript
 * const capturer = new ConsoleCapturer();
 * capturer.start();
 *
 * // ... some code calls console.log ...
 * // ... 某些代码调用 console.log ...
 * console.log("Hello", "world");
 *
 * const output = capturer.stop();
 * console.log(output); // ["Hello world"]
 * ```
 */
export class ConsoleCapturer {
  private captured: string[] = [];
  private originalLog: typeof console.log | null = null;

  /**
   * Start capturing console.log - 开始捕获 console.log
   */
  start(): void {
    this.captured = [];
    this.originalLog = console.log;

    console.log = (...args: unknown[]) => {
      const output = args
        .map((arg) => (typeof arg === "string" ? arg : String(arg)))
        .join(" ");
      this.captured.push(output);
    };
  }

  /**
   * Stop capturing and return captured content - 停止捕获并返回捕获的内容
   */
  stop(): string[] {
    if (this.originalLog !== null) {
      console.log = this.originalLog;
      this.originalLog = null;
    }
    return this.captured;
  }

  /**
   * Get captured content without stopping capture - 获取已捕获的内容（不停止捕获）
   */
  getCaptured(): string[] {
    return [...this.captured];
  }

  /**
   * Clear captured content - 清空已捕获的内容
   */
  clear(): void {
    this.captured = [];
  }
}

/**
 * Execute function with capturer - 使用捕获器执行函数
 *
 * @param fn - Function to execute - 要执行的函数
 * @returns Captured output and function return value - 捕获的输出和函数返回值
 */
export async function withCapture<T>(
  fn: () => Promise<T>
): Promise<{ result: T; captured: string[] }> {
  const capturer = new ConsoleCapturer();
  capturer.start();

  try {
    const result = await fn();
    const captured = capturer.stop();
    return { result, captured };
  } finally {
    capturer.stop();
  }
}

/**
 * Execute synchronous function with capturer - 使用捕获器执行同步函数
 */
export function withCaptureSync<T>(fn: () => T): { result: T; captured: string[] } {
  const capturer = new ConsoleCapturer();
  capturer.start();

  try {
    const result = fn();
    const captured = capturer.stop();
    return { result, captured };
  } finally {
    capturer.stop();
  }
}
